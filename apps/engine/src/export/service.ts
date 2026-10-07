// Export and still jobs (ARCHITECTURE §9.5, S04 §10–§13): plan → native filtergraph (ffmpeg) or Remotion
// `renderMedia`; outputs in `<appdir>/renders/<jobId>/`; frame-count verification (FRAME_COUNT_MISMATCH);
// progress mapping (S04:RN-030); `export.finished` event. Motion-graphic masters come from a provider that
// WP-2G registers (`registerMgMasterProvider`).
import type { ChildProcess } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import type { Writable } from 'node:stream';
import type { EngineJob, ExportSettings, ExportStartRequest, StillRequest } from '@jasper/api';
import {
	buildRenderSnapshot,
	type MediaHandle,
	mediaDecodeHints,
	type RenderVisualClip,
} from '@jasper/project';
import type { UrlSigner } from '../auth/signed-url.ts';
import type { CacheService } from '../cache/service.ts';
import type { Broadcaster } from '../events/broadcaster.ts';
import type { FontCatalogService } from '../fonts/catalog.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { MediaRegistry } from '../media/registry.ts';
import { appendEncoderArgs, planRemotionExport } from '../remotion/export-plan.ts';
import type { RemotionService } from '../remotion/service.ts';
import { audioEncodeArgs, type EncoderService, videoEncodeArgs } from '../tools/encoders.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { exists, randomId } from '../tools/fs.ts';
import { terminateTree } from '../tools/process.ts';
import { BT709_FRAME_TAGS, buildNativeGraph, SWS_FLAGS } from './native.ts';
import {
	layerOverride,
	type NativeExtension,
	NativeExtensionRegistry,
	type PreparedExtensions,
	prepareExtensions,
	prepareNestedExtensions,
} from './native-ext.ts';
import {
	isAnimeTemplate,
	mediaKeyOf,
	type PlanCapabilities,
	PlanError,
	type PlannedExport,
	planExport,
} from './planner.ts';
import { streamLayer } from './stream/run.ts';
import { createSyntheticExtension } from './synthetic.ts';

/**
 * A native extension's `prepare` failed (S11:LBK-023): an `auto` export or still falls back to the Remotion path
 * when that path is eligible; a forced `native` one fails with the cause.
 */
class NativePrepareError extends Error {
	constructor(readonly failure: unknown) {
		super((failure as Error)?.message ?? String(failure));
		this.name = 'NativePrepareError';
	}
}

/** edit-structure: what the Remotion-path extensions prepared for nested sequences, per top-level preparation. */
const NESTED_REMOTION = new WeakMap<ReadonlyMap<string, unknown>, Map<string, PreparedExtensions>>();

/** Remotion concurrency of an export with `slots` CPU slots (S04:RR-004; bakes follow it, S11:LBK-022). */
function remotionConcurrency(slots: number): number {
	return Math.max(1, Math.min(slots, Math.floor(availableParallelism() / 2)));
}

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

const JOB_ID_RE = /^job_[0-9a-f]{16}$/;

/** Same retention as the job journal (S04:JB-030: 7 days): older jobs cannot be retried anyway. */
const REQUEST_RETENTION_MS = 7 * 24 * 3600 * 1000;

type ExportServiceDeps = {
	rendersDir: string;
	ff: Ffmpeg;
	/** Encoder selection (D-13); absent = libx264 (legacy/tests). */
	encoders?: EncoderService;
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
	/** M2 native extensions (ARCHITECTURE §19.6). */
	readonly nativeExtensions = new NativeExtensionRegistry();
	/**
	 * M3 (wp-m3-cachegc): the cache registry. Exports and stills pin every cache file they read for the job's
	 * lifetime and record them as used by their project (`export:<projectId>:<sequenceId>`, CA-012/CA-016).
	 */
	cache: CacheService | null = null;

	constructor(private readonly deps: ExportServiceDeps) {
		// edit-structure: Bars and Tone / counting leader pictures and tones (always available: ffmpeg only).
		this.nativeExtensions.register(createSyntheticExtension({ ffmpeg: deps.ff }));
	}

	/** M2 hook: colour (LUT), motion-graphics pre-renders, warp stage… keep features on the native path. */
	registerNativeExtension(ext: NativeExtension): () => void {
		return this.nativeExtensions.register(ext);
	}

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
			this.planDeps(caps),
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
			stage:
				planned.plan.path === 'remotion'
					? 'Queued (Remotion)'
					: planned.plan.path === 'hybrid'
						? 'Queued (native + baked graphics)'
						: 'Queued (native)',
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

	// ------------------------------------------------------------------ cache (M3, wp-m3-cachegc)

	/** `NativePrepareContext.pin` of a job: holds the cache entry of `path` until the job ends. */
	private pinFor(ctx: JobContext): ((path: string) => Promise<boolean>) | undefined {
		const cache = this.cache;
		return cache ? (path) => cache.acquireForJob(ctx.job.id, path) : undefined;
	}

	/** Pins what the composite reads from the cache: every layer override and fframes master. */
	private async pinInputs(
		ctx: JobContext,
		planned: PlannedExport,
		exts: readonly NativeExtension[],
		prepared: ReadonlyMap<string, unknown>,
		masters: ReadonlyMap<string, string> = new Map(),
	): Promise<void> {
		if (!this.cache) return;
		const paths = new Set(masters.values());
		for (const clip of planned.snapshot.videoTracks.flatMap((t) => t.clips)) {
			const o = layerOverride(exts, prepared, clip);
			if (o) paths.add(o.path);
		}
		for (const p of paths) await this.cache.acquireForJob(ctx.job.id, p);
	}

	/** Records the cache entries this job used as its project's ref set for the sequence (survives restarts). */
	private commitRefs(ctx: JobContext, planned: PlannedExport, what: 'export' | 'still'): void {
		const pid = planned.document.projectId;
		if (!this.cache || !pid) return;
		this.cache.commitHolderRefs(`job:${ctx.job.id}`, `${what}:${pid}:${planned.sequenceId}`, pid);
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
		// Anime templates (S11:ATP-008) are Remotion graphics: baked by the layer-bake extension, not by fframes.
		// edit-structure: motion graphics inside nested sequences are drawn in the nested frame.
		const clips: { clip: RenderVisualClip; snap: PlannedExport['snapshot'] }[] = [];
		const collect = (snap: PlannedExport['snapshot']) => {
			for (const c of snap.videoTracks.flatMap((t) => t.clips)) {
				if (c.kind === 'motion-graphic' && !isAnimeTemplate(c)) clips.push({ clip: c, snap });
				if ('nest' in c.source) collect(c.source.nest.snapshot);
			}
		};
		collect(planned.snapshot);
		if (clips.length === 0) return masters;
		if (!this.mgProvider) return null;
		for (const { clip, snap } of clips) {
			if (masters.has(clip.clipId)) continue;
			ctx.progress(0, { stage: 'Rendering motion graphics' });
			const p = await this.mgProvider({
				clip,
				fps: snap.settings.fps,
				sequence: { width: snap.settings.width, height: snap.settings.height },
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
		const exts = this.nativeExtensions.all();
		let prepared: Map<string, unknown>;
		let nested: Map<string, PreparedExtensions>;
		try {
			const pctx = {
				signal: ctx.signal,
				stage: (text: string) => ctx.progress(0, { stage: text }),
				scratchDir: () => ctx.scratchDir(),
				log: (text: string) => ctx.log(text),
				jobId: ctx.job.id,
				...(planned.document.projectId ? { projectId: planned.document.projectId } : {}),
				purpose: 'native' as const,
				concurrency: remotionConcurrency(ctx.slots),
				...(this.pinFor(ctx) ? { pin: this.pinFor(ctx) } : {}),
			};
			prepared = await prepareExtensions(exts, planned, pctx);
			// edit-structure: nested sequences are drawn in the same graph; their layers get their own preparations.
			nested = await prepareNestedExtensions(exts, planned, pctx);
		} catch (e) {
			if (ctx.signal.aborted) throw e;
			throw new NativePrepareError(e);
		}
		await this.pinInputs(ctx, planned, exts, prepared, masters);
		const pinNested = async (pl: PlannedExport, parent: string): Promise<void> => {
			for (const c of pl.snapshot.videoTracks.flatMap((t) => t.clips)) {
				if (!('nest' in c.source)) continue;
				const path = parent ? `${parent}>${c.clipId}` : c.clipId;
				const sub = { ...pl, snapshot: c.source.nest.snapshot, range: c.source.nest.snapshot.range };
				await this.pinInputs(ctx, sub, exts, nested.get(path) ?? new Map());
				await pinNested(sub, path);
			}
		};
		await pinNested(planned, '');
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
			extensions: { list: exts, prepared },
			nested,
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
		// Sub-pixel layers stream into the composite's pipes while it runs (stream/run.ts). A failed stream stops the
		// composite and is the reported error.
		const streamAbort = new AbortController();
		const onJobAbort = () => streamAbort.abort();
		ctx.signal.addEventListener('abort', onJobAbort, { once: true });
		const producers: Promise<void>[] = [];
		let streamError: Error | null = null;
		const workers = Math.max(2, Math.floor(Math.max(1, ctx.slots) / Math.max(1, graph.streams.length)));
		const runStreams = (child: ChildProcess) => {
			for (const s of graph.streams) {
				const sink = child.stdio[s.fd] as Writable;
				producers.push(
					streamLayer(this.deps.ff, s.plan, sink, {
						workers,
						signal: streamAbort.signal,
						onSpawn: ctx.trackChild,
					}).catch((e: Error) => {
						if (streamAbort.signal.aborted) return;
						streamError ??= e;
						void terminateTree(child, 500);
					}),
				);
			}
		};
		try {
			await this.deps.ff.run(args, {
				signal: ctx.signal,
				...(graph.streams.length > 0 ? { pipes: graph.streams.length } : {}),
				onSpawn: (child) => {
					ctx.trackChild(child);
					if (graph.streams.length > 0) runStreams(child);
				},
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
		} catch (e) {
			streamAbort.abort();
			await Promise.all(producers);
			throw streamError ?? e;
		} finally {
			ctx.signal.removeEventListener('abort', onJobAbort);
		}
		// The composite succeeded (and the frame count is checked below): a stream it stopped reading ends here.
		streamAbort.abort();
		await Promise.all(producers);
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

	/** Encodes Remotion's ProRes/PCM intermediate with the selected encoder (D-13). */
	private async encodeIntermediate(
		planned: PlannedExport,
		input: string,
		output: string,
		frames: number,
		ctx: JobContext,
		from: number,
		stage: string,
	): Promise<void> {
		const o = planned.output;
		const choice = o.encoder!;
		const enc = videoEncodeArgs(choice, {
			crf: o.crf,
			speed: o.speed,
			width: o.width,
			height: o.height,
			fps: o.fps,
			...(o.bitrateKbps ? { bitrateKbps: o.bitrateKbps } : {}),
			...(o.proresProfile ? { proresProfile: o.proresProfile } : {}),
		});
		const vf = [
			`scale=out_color_matrix=bt709:out_range=tv:${SWS_FLAGS}`,
			'setsar=1',
			BT709_FRAME_TAGS,
			...enc.filters,
		];
		const args = [
			...enc.pre,
			'-i',
			input,
			'-map',
			'0:v:0',
			'-map',
			'0:a:0?',
			'-vf',
			vf.join(','),
			...enc.video,
			'-colorspace',
			'bt709',
			'-color_primaries',
			'bt709',
			'-color_trc',
			'bt709',
			'-color_range',
			'tv',
			'-frames:v',
			String(frames),
			...audioEncodeArgs(choice.audioEncoder, o.audioBitrateKbps),
			'-ar',
			'48000',
			'-ac',
			String(o.audioChannels),
			'-threads',
			String(Math.max(1, ctx.slots)),
			...(choice.container !== 'webm' ? ['-movflags', '+faststart'] : []),
			'-f',
			choice.container,
			output,
		];
		ctx.log(`ffmpeg ${args.join(' ')}`);
		const total = o.durationSec;
		await this.deps.ff.run(args, {
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			onProgress: (p) => {
				if (total <= 0) return;
				const done = Math.min(total, p.outTimeUs / 1e6);
				ctx.progress(from + (done / total) * (0.98 - from), { stage: `${stage} · Encoding` });
			},
		});
	}

	/** M2 (§19.6): runs `prepare` of the extensions that serve the Remotion path too. */
	private async prepareForRemotion(planned: PlannedExport, ctx: JobContext): Promise<Map<string, unknown>> {
		const exts = this.nativeExtensions.all().filter((e) => e.prepareForRemotion);
		if (exts.length === 0) return new Map();
		const pctx = {
			signal: ctx.signal,
			stage: (text: string) => ctx.progress(0, { stage: text }),
			scratchDir: () => ctx.scratchDir(),
			log: (text: string) => ctx.log(text),
			jobId: ctx.job.id,
			...(planned.document.projectId ? { projectId: planned.document.projectId } : {}),
			purpose: 'remotion' as const,
			concurrency: remotionConcurrency(ctx.slots),
			...(this.pinFor(ctx) ? { pin: this.pinFor(ctx) } : {}),
		};
		const prepared = await prepareExtensions(exts, planned, pctx);
		await this.pinInputs(ctx, planned, exts, prepared);
		// edit-structure: nested sequences' layers (graded DOM layers inside nests…) are prepared too.
		NESTED_REMOTION.set(prepared, await prepareNestedExtensions(exts, planned, pctx));
		return prepared;
	}

	/**
	 * S11:LBK-023: after a native preparation step failed, re-plans an `auto` export/still on the Remotion path.
	 * Returns null when that is not allowed (forced `native`, cancelled, Remotion not eligible): the caller then
	 * fails with the original error.
	 */
	private async fallbackToRemotion(
		e: unknown,
		input: Parameters<typeof planExport>[0],
		ctx: JobContext,
		warnings: { code: string; message: string }[],
	): Promise<PlannedExport | null> {
		if (!(e instanceof NativePrepareError) || ctx.signal.aborted || input.settings.engine === 'native')
			return null;
		let planned: PlannedExport;
		try {
			planned = await planExport(
				{ ...input, settings: { ...input.settings, engine: 'remotion' } },
				this.planDeps(await this.deps.capabilities()),
			);
		} catch {
			return null;
		}
		const message = `The native path could not be prepared (${e.message.slice(0, 300)}); rendered with Remotion instead`;
		warnings.push({ code: 'NATIVE_FALLBACK', message });
		ctx.log(`warning NATIVE_FALLBACK: ${message}`);
		ctx.progress(0, { stage: 'Falling back to Remotion' });
		return planned;
	}

	private planDeps(caps: PlanCapabilities): Parameters<typeof planExport>[1] {
		return {
			registry: this.deps.registry,
			fonts: this.deps.fonts,
			capabilities: caps,
			extensions: this.nativeExtensions.all(),
			...(this.deps.encoders
				? {
						selectEncoder: (r) => this.deps.encoders!.select(r),
						lgplOnly: this.deps.encoders.inventory.lgplOnly,
					}
				: {}),
		};
	}

	/** The cause of a native preparation failure (what a forced native export fails with). */
	private unwrap(e: unknown): unknown {
		return e instanceof NativePrepareError ? e.failure : e;
	}

	/** Snapshot with signed absolute media and font URLs for the headless browser (S04:RR-003, MS-003). */
	private remotionProps(
		planned: PlannedExport,
		prepared: ReadonlyMap<string, unknown> = new Map(),
	): Record<string, unknown> {
		const origin = this.deps.origin();
		const sign = (path: string) => this.deps.signer.signUrl(origin, path);
		let doc = buildRenderSnapshot(planned.document, planned.sequenceId, {
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
					...mediaDecodeHints(r.probe),
				};
			},
			resolveFont: (font, weight, italic) => {
				const f = this.deps.fonts.resolve(font.family, weight, italic);
				return f ? sign(f.url) : null;
			},
		});
		const nested = NESTED_REMOTION.get(prepared);
		const adapt = (d: typeof doc, prep: ReadonlyMap<string, unknown>, path: string): typeof doc => {
			for (const ext of this.nativeExtensions.all()) {
				if (ext.prepareForRemotion && ext.adaptRemotionDoc)
					d = ext.adaptRemotionDoc(d, prep.get(ext.id), { signUrl: sign });
			}
			if (!nested || nested.size === 0) return d;
			// edit-structure: adapt the nested snapshots of nest clips with what was prepared for them.
			return {
				...d,
				videoTracks: d.videoTracks.map((t) => ({
					...t,
					clips: t.clips.map((c) => {
						if (!('nest' in c.source)) return c;
						const p = path ? `${path}>${c.clipId}` : c.clipId;
						const sub = adapt(c.source.nest.snapshot, nested.get(p) ?? new Map(), p);
						return { ...c, source: { nest: { ...c.source.nest, snapshot: sub } } };
					}),
				})),
			};
		};
		doc = adapt(doc, prepared, '');
		return {
			doc,
			options: { isPreview: false, useProxies: false, transparentBackground: false },
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
		const encoder = planned.output.encoder;
		const output = join(dir, `output.${encoder?.container ?? 'mp4'}`);
		ctx.addPartial(dir);
		let frames = 0;
		let remotionOutput: 'direct' | 'intermediate' | undefined;
		let path = planned.plan.path;
		let masters = new Map<string, string>();
		const warnings: { code: string; message: string }[] = [];
		if (path === 'native' || path === 'hybrid') {
			const m = await this.collectMgMasters(planned, ctx);
			if (m === null) {
				if (req.settings.engine === 'native') {
					throw new JobError('PATH_NOT_ELIGIBLE', 'Motion-graphic masters are unavailable (fframes)', false);
				}
				path = 'remotion';
			} else masters = m;
		}
		if (path === 'native' || path === 'hybrid') {
			try {
				frames = await this.runNative(planned, masters, output, ctx);
			} catch (e) {
				// S11:LBK-023: a failed preparation (bake, warp, pre-render…) of an `auto` export → Remotion path.
				const replanned = await this.fallbackToRemotion(
					e,
					{
						envelope: req.envelope,
						sequenceId: req.sequenceId,
						settings: { ...req.settings, sequenceId: req.sequenceId },
					},
					ctx,
					warnings,
				);
				if (!replanned) throw this.unwrap(e);
				planned = replanned;
				path = 'remotion';
			}
		}
		if (path === 'remotion') {
			const seqW = planned.snapshot.settings.width;
			// D-13 (wp-lgpl): Remotion renders a ProRes intermediate that our ffmpeg encodes with the selected
			// encoder, or encodes VP9/Opus itself; only a dev setup with GPL builds on both sides lets Remotion
			// encode H.264 (see remotion/export-plan.ts).
			const rp = planRemotionExport({
				encoder,
				remotion: this.deps.remotion.ffmpegInfo,
				lgplOnly: this.deps.encoders?.inventory.lgplOnly ?? false,
				crf: planned.output.crf,
				speed: planned.output.speed,
				fps: planned.output.fps,
			});
			if (rp.mode === 'unavailable') throw new JobError(rp.code, rp.reason, false);
			ctx.log(`remotion export: ${rp.mode} (${rp.reason})`);
			remotionOutput = rp.mode;
			const render = rp.phases[0]!;
			const target =
				rp.mode === 'direct' ? output : join(await ctx.scratchDir(), 'remotion-intermediate.mov');
			const prepared = await this.prepareForRemotion(planned, ctx);
			ctx.progress(0, { stage: `${render.label} · Preparing bundle` });
			const res = await this.deps.remotion.renderMedia({
				inputProps: this.remotionProps(planned, prepared),
				output: target,
				signal: ctx.signal,
				concurrency: remotionConcurrency(ctx.slots),
				crf: rp.mode === 'direct' ? rp.crf : planned.output.crf,
				x264Preset: planned.output.x264Preset,
				audioBitrateKbps: planned.output.audioBitrateKbps,
				...(rp.mode === 'intermediate' ? { intermediate: true } : {}),
				...(rp.mode === 'direct' && rp.codec === 'vp9'
					? {
							vp9: {
								crf: rp.crf,
								colorSpace: rp.colorSpace,
								ffmpegOverride: appendEncoderArgs('libvpx-vp9', rp.extraVideoArgs),
							},
						}
					: {}),
				...(planned.output.width !== seqW ? { scale: planned.output.width / seqW } : {}),
				onProgress: (p) =>
					ctx.progress(p.progress * render.weight, { stage: `${render.label} · ${p.stage}` }),
			});
			if (rp.mode === 'intermediate') {
				await this.encodeIntermediate(
					planned,
					target,
					output,
					res.frames,
					ctx,
					render.weight,
					rp.phases[1]!.label,
				);
			}
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
			finalPath = await copyNoOverwrite(
				output,
				withExtension(req.settings.destination.path, extname(output)),
			);
		}
		const result = {
			downloadUrl,
			byteSize,
			...(encoder ? { encoder: encoder.encoder, container: encoder.container } : {}),
			durationSec: planned.output.durationSec,
			frames,
			path: finalPath,
			renderPath: path,
			...(remotionOutput ? { remotionOutput } : {}),
			...(warnings.length ? { warnings } : {}),
			planId: planned.plan.planId,
		};
		this.commitRefs(ctx, planned, 'export');
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
		const input: Parameters<typeof planExport>[0] = {
			envelope: req.envelope,
			sequenceId: req.sequenceId,
			settings,
			rangeOverride: { start: req.frame, end: req.frame + 1 },
			still: true,
		};
		try {
			planned = await planExport(input, {
				registry: this.deps.registry,
				fonts: this.deps.fonts,
				capabilities: await this.deps.capabilities(),
				extensions: this.nativeExtensions.all(),
			});
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
		const warnings: { code: string; message: string }[] = [];
		if (path === 'native' || path === 'hybrid') {
			const m = await this.collectMgMasters(planned, ctx);
			if (m === null) path = 'remotion';
			else masters = m;
		}
		if (path === 'native' || path === 'hybrid') {
			// S11:LBK-025: stills and MCP `render_frame` take the export's path — one baked frame per DOM layer
			// (or its cached master / still) — and fall back to Remotion like `auto` exports (LBK-023).
			try {
				await this.runNative(planned, masters, output, ctx, true);
			} catch (e) {
				const replanned = await this.fallbackToRemotion(e, input, ctx, warnings);
				if (!replanned) throw this.unwrap(e);
				planned = replanned;
				path = 'remotion';
			}
		}
		if (path === 'remotion') {
			const prepared = await this.prepareForRemotion(planned, ctx);
			await this.deps.remotion.renderStill({
				inputProps: this.remotionProps(planned, prepared),
				output,
				frame: 0,
				...(req.width && req.width !== seqW ? { scale: req.width / seqW } : {}),
				signal: ctx.signal,
			});
		}
		this.commitRefs(ctx, planned, 'still');
		await rm((ctx.input as { request: string }).request, { force: true });
		return {
			url: `/renders/${ctx.job.id}/output`,
			renderPath: path,
			...(warnings.length ? { warnings } : {}),
		};
	}
}

function sequenceName(p: PlannedExport): string {
	for (const item of Object.values(p.document.items)) {
		if (item.kind === 'sequence' && item.sequenceId === p.sequenceId) return item.name;
	}
	return p.document.name;
}

/** `dest` with the extension of the file actually written (a WebM fallback never lands in `x.mp4`). */
function withExtension(dest: string, ext: string): string {
	const cur = extname(dest);
	if (cur.toLowerCase() === ext.toLowerCase()) return dest;
	return /^\.(mp4|webm|mov|m4v|mkv)$/i.test(cur) ? dest.slice(0, -cur.length) + ext : dest + ext;
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
