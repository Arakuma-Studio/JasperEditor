// Roto / object mattes on the engine (parity workstream `roto`): `roto` jobs run the `jasper-roto` child process
// (Roto Brush segmentation + propagation, or face tracking; heavy work never runs in the engine process) on one media,
// publish the computed frames as a matte set of the store (store.ts) and return the `RotoResult` the client commits
// with `roto.setResult`. Live `roto.progress` events carry each finished frame. Models come from the processing
// catalogue's `vision` list (installed by its `model-download` job). A cancelled or failed job leaves no partial
// files: the worker's temporary files are removed and no set is published (finished frames stay in the reuse pool).
import { spawn } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
	type EngineJob,
	type M2Features,
	ROTO_PROGRESS_EVENT,
	type RotoProgress,
	type RotoSegmentRequest,
	type RotoSegmentResult,
} from '@jasper/api';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { MediaRecord } from '../media/registry.ts';
import type { ProcessingService } from '../processing/service.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';
import { matteSize } from './core/image.ts';
import { rotoCommand } from './entry.ts';
import type { VisionModelStore } from './models.ts';
import { hashKey, RotoStore } from './store.ts';
import { MATTE_MAX_SIDE, type RotoJobOutput, type RotoJobSpec } from './worker/run.ts';

type RotoJobInput = {
	request: RotoSegmentRequest;
	setKey: string;
	file: string;
	display: { width: number; height: number };
	rate: { num: number; den: number };
	still: boolean;
	frameCount: number | null;
};

/** Frames at or below this go to the interactive lane. */
const INTERACTIVE_MAX_FRAMES = 30;

function mediaFacts(rec: MediaRecord) {
	const vs = rec.probe.streams.find((s) => s.type === 'video');
	if (vs?.type !== 'video') return null;
	const display = rec.display ?? { width: vs.width, height: vs.height };
	const still = rec.kind === 'image';
	const rate = { num: vs.frameRate.num || 30, den: vs.frameRate.den || 1 };
	const frameCount = still
		? 1
		: rec.durationSec && rate.num > 0
			? Math.max(1, Math.round((rec.durationSec * rate.num) / rate.den))
			: null;
	return { display, rate, still, frameCount };
}

export class RotoService {
	readonly store: RotoStore;
	private ortOk: boolean | null = null;
	/** Set keys of running jobs (their sets are busy for the cache). */
	private readonly running = new Map<string, string>();

	constructor(
		private readonly core: CoreServices,
		private readonly processing: ProcessingService,
		private readonly env: Record<string, string | undefined> = process.env,
	) {
		this.store = new RotoStore(join(core.config.paths.cacheDir, 'roto'));
	}

	get models(): VisionModelStore {
		return this.processing.visionModels;
	}

	registerRunners(): void {
		this.core.queue.registerRunner('roto', (ctx) => this.run(ctx));
		this.core.cache.registerAdapter('roto', {
			busy: (key) => (key === 'pool' ? this.running.size > 0 : [...this.running.values()].includes(key)),
			remove: async (key, remove) => {
				const ok = await remove();
				this.store.forget(key === 'pool' ? undefined : key);
				return ok;
			},
		});
	}

	private ortAvailable(): boolean {
		if (this.ortOk === null) {
			try {
				createRequire(import.meta.url).resolve('onnxruntime-node');
				this.ortOk = true;
			} catch {
				this.ortOk = false;
			}
		}
		return this.ortOk;
	}

	async features(): Promise<NonNullable<M2Features['roto']>> {
		const reasons: string[] = [];
		if (!this.core.ffmpeg.bins.ffmpeg) reasons.push('ffmpeg was not found');
		const seg = this.models.defaultFor('segmentation');
		const face = this.models.defaultFor('face');
		return {
			status: reasons.length ? 'unavailable' : 'ready',
			...(reasons.length ? { reason: reasons.join('; ') } : {}),
			segmentationModel: !!seg && this.ortAvailable() && (await this.models.installed(seg)),
			faceModel: !!face && this.ortAvailable() && (await this.models.installed(face)),
		};
	}

	/** The installed model directory of a vision model, or null. */
	private async modelDir(id: string): Promise<string | null> {
		const e = this.models.entry(id);
		if (!e || !(await this.models.installed(e))) return null;
		return (await this.models.resolve(id)).dir;
	}

	/** Validates a request and queues the `roto` job (HttpError 404/400/409). */
	async submit(req: RotoSegmentRequest, origin: EngineJob['origin'] = { type: 'user' }): Promise<EngineJob> {
		const rec = this.core.registry.get(req.mediaKey);
		if (!rec) throw new HttpError(404, 'ASSET_NOT_FOUND', `Unknown media key ${req.mediaKey}`);
		const file = await this.core.registry.resolvePath(req.mediaKey);
		if (!file) throw new HttpError(404, 'ASSET_NOT_FOUND', 'The media file is offline');
		const facts = mediaFacts(rec);
		if (!facts) throw new HttpError(400, 'VALIDATION_FAILED', 'The media has no picture');
		const r = req.roto;
		if (r.span[1] < r.span[0]) throw new HttpError(400, 'VALIDATION_FAILED', 'span must be [first, last]');
		if (facts.frameCount !== null && r.span[0] > facts.frameCount - 1)
			throw new HttpError(400, 'VALIDATION_FAILED', `The span starts after the media's last frame`);
		if (r.kind === 'brush') {
			if (r.base === null)
				throw new HttpError(400, 'VALIDATION_FAILED', 'Nothing is selected yet: add a stroke, points or a box');
			if (r.base < r.span[0] || r.base > r.span[1])
				throw new HttpError(400, 'VALIDATION_FAILED', 'The base frame must lie in the span');
		}
		if (req.direction === 'frame' && req.frame === undefined)
			throw new HttpError(400, 'VALIDATION_FAILED', 'direction "frame" needs frame');
		let modelUsed: string | null = null;
		if (r.kind === 'faces') {
			const face = this.models.defaultFor('face');
			if (!face || !(await this.models.installed(face)))
				throw new HttpError(
					409,
					'FACE_MODEL_NOT_INSTALLED',
					'Face tracking needs the MediaPipe Face Landmarker model: install it in Preferences ▸ Roto & Face Tracking (or install_roto_model)',
				);
			modelUsed = face.id;
		} else if (r.settings.engine === 'model') {
			const e = this.models.entry(r.settings.model);
			if (e && (await this.models.installed(e))) modelUsed = e.id;
		}
		const size = matteSize(facts.display.width, facts.display.height, MATTE_MAX_SIDE);
		const setKey = hashKey('roto-set@1', req.mediaKey, r, modelUsed, size);
		const frames =
			req.direction === 'frame'
				? 1
				: r.kind === 'faces'
					? r.span[1] - r.span[0] + 1
					: req.direction === 'forward'
						? r.span[1] - (r.base ?? r.span[0]) + 1
						: req.direction === 'backward'
							? (r.base ?? r.span[0]) - r.span[0] + 1
							: r.span[1] - r.span[0] + 1;
		const input: RotoJobInput = { request: req, setKey, file, ...facts };
		return this.core.queue.submit({
			kind: 'roto',
			title: `${r.kind === 'faces' ? 'Track faces' : req.direction === 'frame' ? 'Roto Brush' : 'Propagate roto'} – ${rec.originalName} (${frames} frame${frames === 1 ? '' : 's'})`,
			priority: frames <= INTERACTIVE_MAX_FRAMES ? 'interactive' : 'user',
			cpuSlots: 4,
			minSlots: 1,
			origin,
			assetId: req.mediaKey,
			...(req.projectId ? { projectId: req.projectId } : {}),
			dedupeKey: `roto:${setKey}:${req.direction}:${req.frame ?? ''}`,
			input,
			stage: 'Queued',
		});
	}

	private async run(ctx: JobContext): Promise<RotoSegmentResult> {
		const input = ctx.input as RotoJobInput;
		const req = input.request;
		const r = req.roto;
		const ffmpeg = this.core.ffmpeg.bins.ffmpeg;
		if (!ffmpeg) throw new JobError('BINARY_MISSING', 'ffmpeg was not found', false);
		const samDir =
			r.kind === 'brush' && r.settings.engine === 'model' ? await this.modelDir(r.settings.model) : null;
		const face = this.models.defaultFor('face');
		const faceDir = r.kind === 'faces' && face ? await this.modelDir(face.id) : null;
		if (r.kind === 'faces' && !faceDir)
			throw new JobError('FACE_MODEL_NOT_INSTALLED', 'The face tracking model is not installed', false);
		const spec: RotoJobSpec = {
			store: this.store.root,
			jobId: ctx.job.id,
			ffmpeg,
			file: input.file,
			mediaKey: req.mediaKey,
			display: input.display,
			rate: input.rate,
			still: input.still,
			frameCount: input.frameCount,
			roto: {
				kind: r.kind,
				base: r.base,
				span: [r.span[0], r.span[1]],
				strokes: r.strokes.map((s) => ({ ...s, points: s.points.map((p) => [p[0], p[1]] as [number, number]) })),
				boxes: (r.boxes ?? []).map((b) => ({ frame: b.frame, rect: [...b.rect] as [number, number, number, number] })),
				settings: { ...r.settings },
			},
			direction: req.direction,
			...(req.frame !== undefined ? { frame: req.frame } : {}),
			samDir,
			faceDir,
			threads: Math.max(1, ctx.slots),
		};
		this.running.set(ctx.job.id, input.setKey);
		const t0 = performance.now();
		try {
			const out = await this.runWorker(ctx, spec, req);
			const frames: string[] = [];
			for (let f = out.start; f <= out.end; f++) frames.push(out.frames[f]!);
			ctx.progress(1, { stage: 'Publishing the mattes' });
			await this.store.writeSet({
				v: 1,
				key: input.setKey,
				width: out.width,
				height: out.height,
				start: out.start,
				end: out.end,
				frames,
				mediaKey: req.mediaKey,
				createdAt: new Date().toISOString(),
			});
			const secs = (performance.now() - t0) / 1000;
			const area: number[] = [];
			for (let f = out.start; f <= out.end; f++) area.push(out.area[f] ?? -1);
			// Areas of reused frames come from their mattes.
			for (let i = 0; i < area.length; i++)
				if (area[i]! < 0) area[i] = await this.areaOfFile(this.store.setFramePath(input.setKey, out.start + i));
			ctx.log(
				`roto ${req.roto.kind}: ${out.computed} computed, ${out.reused} reused, ${out.modelFrames} with the model, ${secs.toFixed(1)} s`,
			);
			return {
				key: input.setKey,
				start: out.start,
				end: out.end,
				width: out.width,
				height: out.height,
				inputs: req.inputs,
				model: out.model,
				...(req.rotoId ? { rotoId: req.rotoId } : {}),
				computed: out.computed,
				reused: out.reused,
				modelFrames: out.modelFrames,
				area,
				...(out.faces ? { faces: out.faces } : {}),
				...(out.computed > 0 && secs > 0 ? { framesPerSec: Math.round((out.computed / secs) * 100) / 100 } : {}),
			};
		} finally {
			this.running.delete(ctx.job.id);
		}
	}

	private async areaOfFile(path: string): Promise<number> {
		const { decodeGreyPng } = await import('./core/codec.ts');
		try {
			const { data } = decodeGreyPng(await readFile(path));
			let s = 0;
			for (let i = 0; i < data.length; i++) s += data[i]!;
			return Math.round((s / (255 * Math.max(1, data.length))) * 1e6) / 1e6;
		} catch {
			return 0;
		}
	}

	/** Removes the temporary files a worker process left in the pool (killed mid-write). */
	private async sweepTemp(pid: number | undefined): Promise<void> {
		if (!pid) return;
		for (const sub of ['seg', 'png']) {
			const dir = join(this.store.root, 'pool', sub);
			for (const name of await readdir(dir).catch(() => [] as string[]))
				if (name.endsWith('.tmp') && name.includes(`.${pid}.`)) await rm(join(dir, name), { force: true });
		}
	}

	private async runWorker(ctx: JobContext, spec: RotoJobSpec, req: RotoSegmentRequest): Promise<RotoJobOutput> {
		const scratch = await ctx.scratchDir();
		const specPath = join(scratch, 'roto-spec.json');
		const outPath = join(scratch, 'roto-out.json');
		await writeFile(specPath, JSON.stringify(spec));
		const cmd = rotoCommand(this.env);
		const child = spawn(cmd.command, [...cmd.args, specPath, outPath], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, OMP_NUM_THREADS: String(spec.threads ?? 1) },
		});
		ctx.trackChild(child);
		let stderr = '';
		let failure: string | null = null;
		let buf = '';
		let lastEvent = 0;
		child.stdout.on('data', (c: Buffer) => {
			buf += c.toString();
			let nl = buf.indexOf('\n');
			while (nl >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				nl = buf.indexOf('\n');
				if (!line) continue;
				try {
					const ev = JSON.parse(line) as {
						type: string;
						fraction?: number;
						stage?: string;
						message?: string;
						frame?: number;
						area?: number;
						done?: number;
						total?: number;
					};
					if (ev.type === 'progress' && typeof ev.fraction === 'number')
						ctx.progress(ev.fraction * 0.98, { stage: ev.stage ?? 'Segmenting' });
					else if (ev.type === 'frame' && typeof ev.frame === 'number') {
						const now = Date.now();
						if (now - lastEvent >= 100 || ev.done === ev.total) {
							lastEvent = now;
							const p: RotoProgress = {
								jobId: ctx.job.id,
								...(req.rotoId ? { rotoId: req.rotoId } : {}),
								mediaKey: req.mediaKey,
								frame: ev.frame,
								done: ev.done ?? 0,
								total: ev.total ?? 0,
								area: Math.min(1, Math.max(0, ev.area ?? 0)),
							};
							this.core.broadcaster.publish(ROTO_PROGRESS_EVENT, p, req.projectId ?? ctx.job.projectId);
						}
					} else if (ev.type === 'error') failure = ev.message ?? 'failed';
				} catch {
					ctx.log(line);
				}
			}
		});
		child.stderr.on('data', (c: Buffer) => {
			const t = c.toString();
			if (stderr.length < 8000) stderr += t;
			ctx.log(t.trimEnd());
		});
		const code = await new Promise<number | null>((resolve, reject) => {
			child.on('error', reject);
			child.on('close', (c) => resolve(c));
		});
		if (code !== 0) await this.sweepTemp(child.pid);
		if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		if (code !== 0)
			throw new JobError(
				'ROTO_FAILED',
				failure ?? (stderr.trim().split('\n').pop() || `jasper-roto exited with ${code}`),
				false,
			);
		return JSON.parse(await readFile(outPath, 'utf8')) as RotoJobOutput;
	}
}
