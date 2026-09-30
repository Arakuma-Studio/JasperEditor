// Export and still jobs (ARCHITECTURE §9.5, S04 §10–§13): plan → native filtergraph (ffmpeg) or Remotion
// `renderMedia`; outputs in `<appdir>/renders/<jobId>/`; frame-count verification (FRAME_COUNT_MISMATCH);
// progress mapping (S04:RN-030); `export.finished` event. Motion-graphic masters come from a provider that
// WP-2G registers (`registerMgMasterProvider`).
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import type { EngineJob, ExportSettings, ExportStartRequest, StillRequest } from '@jasper/api';
import { buildRenderSnapshot, type MediaHandle, type RenderVisualClip } from '@jasper/project';
import type { UrlSigner } from '../auth/signed-url.ts';
import type { Broadcaster } from '../events/broadcaster.ts';
import type { FontCatalogService } from '../fonts/catalog.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { MediaRegistry } from '../media/registry.ts';
import type { RemotionService } from '../remotion/service.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { exists, randomId } from '../tools/fs.ts';
import { buildNativeGraph } from './native.ts';
import { mediaKeyOf, type PlanCapabilities, PlanError, type PlannedExport, planExport } from './planner.ts';

export type MgMasterRequest = {
	clip: RenderVisualClip;
	fps: { num: number; den: number };
	sequence: { width: number; height: number };
	projectId?: string;
	/** The export/still job that needs the master (its mg-render job is shown as a child). */
	parentId?: string;
	signal: AbortSignal;
};
/**
 * Returns the path of a cached (or freshly rendered) straight-alpha ProRes 4444 master whose frame 0 is the
 * clip's first frame and whose size is the clip canvas, or null when fframes cannot render it.
 */
export type MgMasterProvider = (req: MgMasterRequest) => Promise<string | null>;

type StoredRequest =
	| { kind: 'export'; request: ExportStartRequest }
	| { kind: 'still'; request: StillRequest };

export const JOB_ID_RE = /^job_[0-9a-f]{16}$/;

/** Same retention as the job journal (S04:JB-030: 7 days): older jobs cannot be retried anyway. */
export const REQUEST_RETENTION_MS = 7 * 24 * 3600 * 1000;

export type ExportServiceDeps = {
	rendersDir: string;
	ff: Ffmpeg;
	queue: JobQueue;
	registry: MediaRegistry;
	fonts: FontCatalogService;
	remotion: RemotionService;
	broadcaster: Broadcaster;
	signer: UrlSigner;
	/** Engine origin for signed absolute URLs, e.g. `http://127.0.0.1:47900`. */
	origin(): string;
	/** Local/dev mode: exports may be copied to a client-chosen path (S04:SC-002). */
	localMode: boolean;
	capabilities(): Promise<PlanCapabilities>;
};

export class ExportService {
	private mgProvider: MgMasterProvider | null = null;

	constructor(private readonly deps: ExportServiceDeps) {}

	/** WP-2G hook: motion-graphic masters for the native path. */
	registerMgMasterProvider(fn: MgMasterProvider | null): void {
		this.mgProvider = fn;
	}

	get hasMgMasterProvider(): boolean {
		return this.mgProvider !== null;
	}

	registerRunners(): void {
		this.deps.queue.registerRunner('export', (ctx) =>
			this.withRequestCleanup(ctx, () => this.runExport(ctx)),
		);
		this.deps.queue.registerRunner('still', (ctx) => this.withRequestCleanup(ctx, () => this.runStill(ctx)));
	}

	/**
	 * Stored requests are removed when the job succeeds (runners) or fails for good (here). Retryable failures
	 * and cancellations keep theirs: `POST /api/jobs/:id/retry` re-runs the same input. `sweepRequests()`
	 * removes those once they are older than the job journal's retention.
	 */
	private async withRequestCleanup(ctx: JobContext, run: () => Promise<unknown>): Promise<unknown> {
		try {
			return await run();
		} catch (e) {
			const file = (ctx.input as { request?: unknown } | undefined)?.request;
			const final = e instanceof JobError && e.retryable === false && !ctx.signal.aborted;
			if (final && typeof file === 'string') await rm(file, { force: true }).catch(() => {});
			throw e;
		}
	}

	/** Removes stored render requests older than `maxAgeMs` (default: the 7-day job journal retention). */
	async sweepRequests(maxAgeMs = REQUEST_RETENTION_MS, now = Date.now()): Promise<number> {
		const dir = join(this.deps.rendersDir, '.requests');
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return 0;
		}
		let removed = 0;
		for (const name of names) {
			if (!name.endsWith('.json')) continue;
			const file = join(dir, name);
			try {
				if (now - (await stat(file)).mtimeMs > maxAgeMs) {
					await rm(file, { force: true });
					removed++;
				}
			} catch {
				// raced with a runner removing it
			}
		}
		return removed;
	}

	async plan(req: {
		envelope: { revision: number; document: unknown };
		sequenceId: string;
		settings: ExportSettings;
	}): Promise<PlannedExport> {
		const caps = await this.deps.capabilities();
		return planExport(
			{
				envelope: req.envelope,
				sequenceId: req.sequenceId,
				settings: { ...req.settings, sequenceId: req.sequenceId },
			},
			{ registry: this.deps.registry, fonts: this.deps.fonts, capabilities: caps },
		);
	}

	private async storeRequest(r: StoredRequest): Promise<string> {
		const dir = join(this.deps.rendersDir, '.requests');
		await mkdir(dir, { recursive: true });
		const file = join(dir, `${randomId('req', 8)}.json`);
		await writeFile(file, JSON.stringify(r));
		return file;
	}

	/** `POST /api/exports`: validates by planning first (PATH_NOT_ELIGIBLE surfaces synchronously). */
	async start(req: ExportStartRequest, origin: EngineJob['origin'] = { type: 'user' }): Promise<EngineJob> {
		const dest = req.settings.destination;
		if (dest?.type === 'path') {
			// Writing to an arbitrary path is a local/desktop feature, like path registration (S04:SC-002).
			if (!this.deps.localMode) {
				throw new PlanError('LOCAL_MODE_ONLY', 403, 'Export to a path is only available in local mode');
			}
			if (!isAbsolute(dest.path) || basename(dest.path) === '' || dest.path.endsWith(sep)) {
				throw new PlanError('VALIDATION_FAILED', 400, 'The export destination must be an absolute file path');
			}
		}
		const planned = await this.plan(req);
		const file = await this.storeRequest({ kind: 'export', request: req });
		const cores = this.deps.queue.totalSlots;
		const seqName = sequenceName(planned);
		return this.deps.queue.submit({
			kind: 'export',
			title: `Export – ${seqName}`,
			priority: 'user',
			cpuSlots: cores,
			minSlots: Math.ceil(cores / 2),
			origin,
			projectId: planned.document.projectId,
			stage: planned.plan.path === 'native' ? 'Queued (native)' : 'Queued (Remotion)',
			input: { request: file },
		});
	}

	/** `POST /api/stills`. */
	async still(req: StillRequest, origin: EngineJob['origin'] = { type: 'user' }): Promise<EngineJob> {
		const file = await this.storeRequest({ kind: 'still', request: req });
		const doc = req.envelope.document as { projectId?: string };
		return this.deps.queue.submit({
			kind: 'still',
			title: `Frame ${req.frame}`,
			priority: 'interactive',
			cpuSlots: 2,
			minSlots: 1,
			origin,
			...(typeof doc.projectId === 'string' ? { projectId: doc.projectId } : {}),
			input: { request: file },
		});
	}

	/** Output file of a finished render job (`/renders/:jobId/output`). */
	async outputFile(jobId: string): Promise<string | null> {
		if (!JOB_ID_RE.test(jobId)) return null;
		// A running render writes output.* in place: never serve a partial file.
		const job = this.deps.queue.get(jobId);
		if (job && job.state !== 'succeeded') return null;
		const dir = join(this.deps.rendersDir, jobId);
		try {
			const f = (await readdir(dir)).find((n) => n.startsWith('output.'));
			return f ? join(dir, f) : null;
		} catch {
			return null;
		}
	}

	// ------------------------------------------------------------------ runners

	private async loadRequest(ctx: JobContext): Promise<StoredRequest> {
		const file = (ctx.input as { request?: string })?.request;
		if (!file) throw new JobError('BAD_REQUEST', 'Missing render request', false);
		try {
			return JSON.parse(await readFile(file, 'utf8')) as StoredRequest;
		} catch {
			throw new JobError('BAD_REQUEST', 'The render request is no longer available', false);
		}
	}

	private async outDir(ctx: JobContext): Promise<string> {
		const dir = join(this.deps.rendersDir, ctx.job.id);
		await mkdir(dir, { recursive: true });
		return dir;
	}

	private async collectMgMasters(
		planned: PlannedExport,
		ctx: JobContext,
	): Promise<Map<string, string> | null> {
		const masters = new Map<string, string>();
		const clips = planned.snapshot.videoTracks
			.flatMap((t) => t.clips)
			.filter((c) => c.kind === 'motion-graphic');
		if (clips.length === 0) return masters;
		if (!this.mgProvider) return null;
		for (const clip of clips) {
			ctx.progress(0, { stage: 'Rendering motion graphics' });
			const p = await this.mgProvider({
				clip,
				fps: planned.snapshot.settings.fps,
				sequence: { width: planned.snapshot.settings.width, height: planned.snapshot.settings.height },
				projectId: planned.document.projectId,
				parentId: ctx.job.id,
				signal: ctx.signal,
			});
			if (!p || !(await exists(p))) return null;
			masters.set(clip.clipId, p);
		}
		return masters;
	}

	private async runNative(
		planned: PlannedExport,
		masters: Map<string, string>,
		output: string,
		ctx: JobContext,
		still = false,
	): Promise<number> {
		const graph = buildNativeGraph({
			snapshot: planned.snapshot,
			output: planned.output,
			outputFile: output,
			sources: {
				media: (id) => planned.media[id] ?? null,
				mgMaster: (id) => masters.get(id) ?? null,
			},
			threads: ctx.slots,
			still,
			...(still ? {} : { videoEncoder: await this.deps.ff.h264Encoder() }),
		});
		let args = graph.args;
		if (graph.filter.length > 60_000) {
			const script = join(await ctx.scratchDir(), 'graph.txt');
			await writeFile(script, graph.filter);
			const i = args.indexOf('-filter_complex');
			args = [...args.slice(0, i), '-filter_complex_script', script, ...args.slice(i + 2)];
		}
		ctx.log(`ffmpeg ${args.join(' ')}`);
		const total = graph.durationSec;
		const started = Date.now();
		await this.deps.ff.run(args, {
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			onProgress: (p) => {
				if (still || total <= 0) return;
				const done = Math.min(total, p.outTimeUs / 1e6);
				const elapsed = (Date.now() - started) / 1000;
				const speed = p.speed ?? (elapsed > 0 ? done / elapsed : undefined);
				ctx.progress((done / total) * 0.98, {
					stage: 'Encoding (native)',
					...(speed ? { speed, etaSec: (total - done) / speed } : {}),
				});
			},
		});
		if (still) return 1;
		const count = await this.deps.ff.countVideoFrames(output, { signal: ctx.signal });
		if (count !== graph.outputFrames) {
			throw new JobError(
				'FRAME_COUNT_MISMATCH',
				`Expected ${graph.outputFrames} frames, the output has ${count}`,
				true,
				{
					expected: graph.outputFrames,
					actual: count,
				},
			);
		}
		return count;
	}

	/** Snapshot with signed absolute media and font URLs for the headless browser (S04:RR-003, MS-003). */
	private remotionProps(planned: PlannedExport): Record<string, unknown> {
		const origin = this.deps.origin();
		const sign = (path: string) => this.deps.signer.signUrl(origin, path);
		const doc = buildRenderSnapshot(planned.document, planned.sequenceId, {
			range: planned.range,
			resolveMedia: (asset): MediaHandle | null => {
				const local = planned.media[asset.id];
				const key = mediaKeyOf(asset);
				if (!local || !key) return null;
				const r = local.record;
				return {
					url: sign(`/media/${encodeURIComponent(key)}`),
					proxyUrl: null,
					kind: asset.kind,
					width: r.display?.width ?? null,
					height: r.display?.height ?? null,
					durationFlicks: r.probe.durationFlicks,
					hasAudio: r.hasAudio,
					rotation: r.probe.rotationDegrees,
				};
			},
			resolveFont: (font, weight, italic) => {
				const f = this.deps.fonts.resolve(font.family, weight, italic);
				return f ? sign(f.url) : null;
			},
		});
		return {
			doc,
			options: { isPreview: false, useProxies: false, transparentBackground: false, showOffline: true },
		};
	}

	private async runExport(ctx: JobContext): Promise<unknown> {
		const stored = await this.loadRequest(ctx);
		if (stored.kind !== 'export') throw new JobError('BAD_REQUEST', 'Not an export request', false);
		const req = stored.request;
		ctx.progress(0, { stage: 'Planning' });
		let planned: PlannedExport;
		try {
			planned = await this.plan(req);
		} catch (e) {
			if (e instanceof PlanError) throw new JobError(e.code, e.message, false, e.detail);
			throw e;
		}
		const dir = await this.outDir(ctx);
		const output = join(dir, 'output.mp4');
		ctx.addPartial(dir);
		let frames: number;
		let path = planned.plan.path;
		let masters = new Map<string, string>();
		if (path === 'native') {
			const m = await this.collectMgMasters(planned, ctx);
			if (m === null) {
				if (req.settings.engine === 'native') {
					throw new JobError('PATH_NOT_ELIGIBLE', 'Motion-graphic masters are unavailable (fframes)', false);
				}
				path = 'remotion';
			} else masters = m;
		}
		if (path === 'native') {
			frames = await this.runNative(planned, masters, output, ctx);
		} else {
			const cores = availableParallelism();
			const seqW = planned.snapshot.settings.width;
			ctx.progress(0, { stage: 'Preparing Remotion bundle' });
			const res = await this.deps.remotion.renderMedia({
				inputProps: this.remotionProps(planned),
				output,
				signal: ctx.signal,
				concurrency: Math.max(1, Math.min(ctx.slots, Math.floor(cores / 2))),
				crf: planned.output.crf,
				x264Preset: planned.output.x264Preset,
				...(planned.output.width !== seqW ? { scale: planned.output.width / seqW } : {}),
				onProgress: (p) => ctx.progress(p.progress * 0.98, { stage: `${p.stage} (Remotion)` }),
			});
			const count = await this.deps.ff.countVideoFrames(output, { signal: ctx.signal });
			if (count !== res.frames) {
				throw new JobError(
					'FRAME_COUNT_MISMATCH',
					`Expected ${res.frames} frames, the output has ${count}`,
					true,
				);
			}
			frames = count;
		}
		const byteSize = (await stat(output)).size;
		const downloadUrl = `/renders/${ctx.job.id}/output`;
		let finalPath: string | undefined;
		if (req.settings.destination?.type === 'path') {
			finalPath = await copyNoOverwrite(output, req.settings.destination.path);
		}
		const result = {
			downloadUrl,
			byteSize,
			durationSec: planned.output.durationSec,
			frames,
			path: finalPath,
			renderPath: path,
			planId: planned.plan.planId,
		};
		this.deps.broadcaster.publish(
			'export.finished',
			{
				jobId: ctx.job.id,
				downloadUrl,
				byteSize,
				durationSec: planned.output.durationSec,
				...(finalPath ? { outputPath: finalPath } : {}),
			},
			planned.document.projectId,
		);
		await rm((ctx.input as { request: string }).request, { force: true });
		return result;
	}

	private async runStill(ctx: JobContext): Promise<unknown> {
		const stored = await this.loadRequest(ctx);
		if (stored.kind !== 'still') throw new JobError('BAD_REQUEST', 'Not a still request', false);
		const req = stored.request;
		const settings: ExportSettings = {
			sequenceId: req.sequenceId,
			range: { type: 'entire' },
			container: 'mp4',
			engine: 'auto',
			destination: { type: 'download' },
		};
		let planned: PlannedExport;
		try {
			planned = await planExport(
				{
					envelope: req.envelope,
					sequenceId: req.sequenceId,
					settings,
					rangeOverride: { start: req.frame, end: req.frame + 1 },
				},
				{
					registry: this.deps.registry,
					fonts: this.deps.fonts,
					capabilities: await this.deps.capabilities(),
				},
			);
		} catch (e) {
			if (e instanceof PlanError) throw new JobError(e.code, e.message, false, e.detail);
			throw e;
		}
		const seqW = planned.snapshot.settings.width;
		const seqH = planned.snapshot.settings.height;
		if (req.width && req.width !== seqW) {
			planned.output.width = req.width;
			planned.output.height = Math.max(2, Math.round((req.width * seqH) / seqW / 2) * 2);
			planned.output.scaling = 'stretch';
		}
		const dir = await this.outDir(ctx);
		const output = join(dir, 'output.png');
		ctx.addPartial(dir);
		let path = planned.plan.path;
		let masters = new Map<string, string>();
		if (path === 'native') {
			const m = await this.collectMgMasters(planned, ctx);
			if (m === null) path = 'remotion';
			else masters = m;
		}
		if (path === 'native') {
			await this.runNative(planned, masters, output, ctx, true);
		} else {
			await this.deps.remotion.renderStill({
				inputProps: this.remotionProps(planned),
				output,
				frame: 0,
				...(req.width && req.width !== seqW ? { scale: req.width / seqW } : {}),
				signal: ctx.signal,
			});
		}
		await rm((ctx.input as { request: string }).request, { force: true });
		return { url: `/renders/${ctx.job.id}/output`, renderPath: path };
	}
}

function sequenceName(p: PlannedExport): string {
	for (const item of Object.values(p.document.items)) {
		if (item.kind === 'sequence' && item.sequenceId === p.sequenceId) return item.name;
	}
	return p.document.name;
}

/** Copies to `dest`, appending " (2)", " (3)"… instead of overwriting (S04:EX-007). */
async function copyNoOverwrite(src: string, dest: string): Promise<string> {
	await mkdir(dirname(dest), { recursive: true });
	const ext = extname(dest);
	const stem = basename(dest, ext);
	let candidate = dest;
	for (let i = 2; await exists(candidate); i++) candidate = join(dirname(dest), `${stem} (${i})${ext}`);
	await copyFile(src, candidate);
	return candidate;
}
