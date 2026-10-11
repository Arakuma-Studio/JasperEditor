// Tracking jobs (S09:TRK-010…014, ARCHITECTURE §19.5): request validation, the `track` job runner (ffmpeg decode →
// worker-thread trackers → TrackResult in media px), live `tracking.progress` events and capability reporting.
import { createHash } from 'node:crypto';
import {
	type EngineJob,
	type M2Features,
	TRACKING_PROGRESS_EVENT,
	type TrackProgress,
	type TrackRequest,
	type TrackResult,
} from '@jasper/api';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { MediaRecord } from '../media/registry.ts';
import type { SpawnOptions } from '../tools/process.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';
import { type DecodeSpec, decodeSpan, readFrames, spawnDecoder } from './decode.ts';
import * as G from './geometry.ts';
import type { MaskConfig } from './mask.ts';
import type { FrameResult, PlanarConfig } from './planar.ts';
import type { PointConfig } from './point.ts';
import {
	acquireWorker,
	openCvPath,
	releaseWorker,
	shutdownWorkers,
	type TrackerConfig,
	type TrackingWorker,
} from './worker.ts';

const PLANAR_METHOD = 'klt-homography@1';
const POINT_METHOD = 'template@1';
/** wp masks: frame-to-frame KLT + robust model fit of the pixels inside a mask outline. */
const MASK_METHOD = 'mask-klt@1';
/** Frames at or below this go to the interactive lane (S09:TRK-010). */
const INTERACTIVE_MAX_FRAMES = 300;
const EVENT_INTERVAL_MS = 100;
const IN_FLIGHT = 3;
const CHUNK_BYTES = 128 * 1024 * 1024;
const DEFAULT_PATCH = 31;
const DEFAULT_SEARCH = 64;

export type TrackJobInput = {
	request: TrackRequest;
	file: string;
	/** Display (rotation applied) size of the media. */
	display: { width: number; height: number };
	fps: { num: number; den: number };
	/** Approximate number of frames (from the duration), null when unknown. */
	frameCount: number | null;
};

/** Source frames a request produces samples for: [start, end). */
function trackSpan(r: Pick<TrackRequest, 'reference' | 'range' | 'direction'>): {
	start: number;
	end: number;
} {
	const ref = r.reference.frame;
	if (r.direction === 'forward') return { start: ref, end: r.range.endFrame };
	if (r.direction === 'backward') return { start: r.range.startFrame, end: ref + 1 };
	return { start: r.range.startFrame, end: r.range.endFrame };
}

function mediaFacts(rec: MediaRecord): Omit<TrackJobInput, 'request' | 'file'> | null {
	const vs = rec.probe.streams.find((s) => s.type === 'video');
	if (vs?.type !== 'video') return null;
	const display = rec.display ?? { width: vs.width, height: vs.height };
	const fps = { num: vs.frameRate.num, den: vs.frameRate.den };
	const frameCount =
		rec.durationSec && fps.num > 0 ? Math.max(1, Math.round((rec.durationSec * fps.num) / fps.den)) : null;
	return { display, fps, frameCount };
}

/** Semantic checks beyond the schema; returns an error message or null. */
function validateTrackRequest(
	r: TrackRequest,
	facts: { display: { width: number; height: number }; frameCount: number | null },
): string | null {
	const { startFrame, endFrame } = r.range;
	const ref = r.reference.frame;
	if (endFrame <= startFrame) return 'range.endFrame must be greater than range.startFrame';
	if (ref < startFrame || ref >= endFrame) return 'The range must contain the reference frame';
	if (facts.frameCount !== null && ref >= facts.frameCount)
		return `The reference frame ${ref} is beyond the end of the media (${facts.frameCount} frames)`;
	const { width, height } = facts.display;
	const inFrame = (x: number, y: number, slack: number) =>
		Number.isFinite(x) &&
		Number.isFinite(y) &&
		x >= -slack &&
		y >= -slack &&
		x <= width + slack &&
		y <= height + slack;
	if (r.kind === 'mask') {
		const p = r.reference.polygon;
		if (!p) return 'A mask track needs reference.polygon (the mask outline in media px)';
		const slack = Math.max(width, height);
		if (!p.every(([x, y]) => inFrame(x, y, slack))) return 'reference.polygon is out of range';
		const xs = p.map((q) => q[0]);
		const ys = p.map((q) => q[1]);
		if (Math.max(...xs) < 0 || Math.min(...xs) > width || Math.max(...ys) < 0 || Math.min(...ys) > height)
			return 'The mask is outside the picture';
		return null;
	}
	if (r.kind === 'planar') {
		const c = r.reference.corners;
		if (!c) return 'A planar tracker needs reference.corners (TL, TR, BR, BL in media px)';
		// Corners may lie outside the picture (a screen cut by the frame edge), within reason.
		const slack = Math.max(width, height);
		if (!c.every(([x, y]) => inFrame(x, y, slack))) return 'reference.corners are out of range';
		if (!G.quadIsConvex(c.flat())) return 'reference.corners must form a convex quad (TL, TR, BR, BL)';
	} else {
		const p = r.reference.point;
		if (!p) return 'A point tracker needs reference.point (media px)';
		if (!inFrame(p[0], p[1], 0)) return 'reference.point is outside the picture';
	}
	return null;
}

export class TrackingService {
	private readonly workers = new Set<TrackingWorker>();

	constructor(private readonly core: CoreServices) {}

	/** `features.tracking` (ARCHITECTURE §19.7). */
	capability(warpStage: boolean): NonNullable<M2Features['tracking']> {
		const engine = 'opencv.js 4.12';
		try {
			openCvPath();
		} catch {
			return {
				status: 'unavailable',
				engine,
				reason: 'OpenCV.js (@techstark/opencv-js) is not installed',
				warpStage,
			};
		}
		if (!this.core.ffmpeg.bins.ffmpeg)
			return { status: 'unavailable', engine, reason: 'ffmpeg was not found', warpStage };
		return { status: 'ready', engine, warpStage };
	}

	/** Validates a request and queues the `track` job. Throws HttpError (404/400). */
	async submit(r: TrackRequest): Promise<EngineJob> {
		const rec = this.core.registry.get(r.mediaKey);
		if (!rec) throw new HttpError(404, 'ASSET_NOT_FOUND', `Unknown media key ${r.mediaKey}`);
		const file = await this.core.registry.resolvePath(r.mediaKey);
		if (!file) throw new HttpError(404, 'ASSET_NOT_FOUND', 'The media file is offline');
		const facts = mediaFacts(rec);
		if (!facts) throw new HttpError(400, 'VALIDATION_FAILED', 'The media has no video stream');
		const problem = validateTrackRequest(r, facts);
		if (problem) throw new HttpError(400, 'VALIDATION_FAILED', problem);
		const span = trackSpan(r);
		const frames = span.end - span.start;
		const input: TrackJobInput = { request: r, file, ...facts };
		return this.core.queue.submit({
			kind: 'track',
			title: `Track ${r.kind === 'planar' ? 'planar surface' : r.kind === 'mask' ? 'mask' : 'point'} (${frames} frames)`,
			priority: frames <= INTERACTIVE_MAX_FRAMES ? 'interactive' : 'user',
			cpuSlots: 2,
			minSlots: 1,
			...(r.projectId ? { projectId: r.projectId } : {}),
			dedupeKey: `track:${createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 32)}`,
			input,
			stage: 'Waiting',
		});
	}

	shutdown(): void {
		for (const w of this.workers) w.terminate();
		this.workers.clear();
		shutdownWorkers();
	}

	readonly runner = async (ctx: JobContext): Promise<TrackResult> => {
		const input = ctx.input as TrackJobInput;
		const r = input.request;
		const planar = r.kind === 'planar';
		const mask = r.kind === 'mask';
		const stride = planar ? 8 : mask ? 9 : 2;
		const size = G.trackingSize(input.display.width, input.display.height, r.quality);
		const scale = size.width !== input.display.width || size.height !== input.display.height;
		const span = trackSpan(r);
		const total = span.end - span.start;
		const ref = r.reference.frame;
		const cfg = trackerConfig(r, size);
		const data = new Float64Array(total * stride);
		const conf = new Float64Array(total);
		const have = new Uint8Array(total);
		const lostFlag = new Uint8Array(total);
		let done = 0;
		let lastEvent = 0;
		let pendingEvent: TrackProgress | null = null;
		let t0 = 0;
		const publish = (p: TrackProgress) =>
			this.core.broadcaster.publish(TRACKING_PROGRESS_EVENT, p, r.projectId ?? ctx.job.projectId);
		const onResult = (frame: number, res: FrameResult) => {
			const i = frame - span.start;
			if (i < 0 || i >= total || have[i]) return;
			if (!t0) t0 = performance.now();
			have[i] = 1;
			// wp masks: a homography in tracking px → media px: S⁻¹·H·S (S = media → tracking scale).
			const values = mask
				? homographyToMediaPx(res.values, size.sx, size.sy)
				: G.toMediaPx(res.values, size.sx, size.sy).map(round3);
			data.set(values, i * stride);
			conf[i] = res.lost ? 0 : round3(Math.max(0, Math.min(1, res.confidence)));
			lostFlag[i] = res.lost ? 1 : 0;
			done++;
			ctx.progress(done / total, { stage: `Tracking ${done}/${total}` });
			pendingEvent = {
				jobId: ctx.job.id,
				...(r.trackerId ? { trackerId: r.trackerId } : {}),
				mediaKey: r.mediaKey,
				frame,
				data: values,
				confidence: conf[i]!,
				done,
				total,
			};
			const now = Date.now();
			if (now - lastEvent >= EVENT_INTERVAL_MS || done === total) {
				lastEvent = now;
				publish(pendingEvent);
				pendingEvent = null;
			}
		};

		const decodeBase = {
			file: input.file,
			fps: input.fps,
			width: size.width,
			height: size.height,
			scale,
		} satisfies Omit<DecodeSpec, 'start' | 'count'>;
		const frameBytes = size.width * size.height;
		const signal = ctx.signal;
		const spawnOpts: SpawnOptions = { signal, onSpawn: (c) => ctx.trackChild(c) };
		const used: TrackingWorker[] = [];
		const takeWorker = () => {
			const w = acquireWorker();
			used.push(w);
			this.workers.add(w);
			return w;
		};

		const feed = (w: TrackingWorker, frame: number, buf: Uint8Array, reference: boolean) => {
			const ab = buf.buffer as ArrayBuffer;
			const p = w
				.result({ type: reference ? 'reference' : 'frame', frame, buf: ab }, [ab])
				.then((res) => onResult(frame, res));
			p.catch(() => undefined);
			return p;
		};

		/**
		 * A pass runs on one or more workers. With several, frames are dealt round-robin after the reference: each
		 * worker tracks every n-th frame from the reference on its own (prediction, anchors), so they need no shared
		 * state; lost frames are re-filled in pass order afterwards.
		 */
		const makeLane = async (workers: TrackingWorker[]) => {
			await Promise.all(workers.map((w) => w.ready));
			await Promise.all(workers.map((w) => w.call({ type: 'init', cfg })));
			const inflight: Promise<void>[] = [];
			let seq = 0;
			return {
				async push(frame: number, buf: Uint8Array) {
					if (seq === 0) {
						for (let i = 1; i < workers.length; i++)
							inflight.push(feed(workers[i]!, frame, buf.slice(), true));
						inflight.push(feed(workers[0]!, frame, buf, true));
					} else inflight.push(feed(workers[(seq - 1) % workers.length]!, frame, buf, false));
					seq++;
					while (inflight.length >= IN_FLIGHT * workers.length) await inflight.shift();
				},
				async drain() {
					await Promise.all(inflight.splice(0));
				},
			};
		};

		const forwardPass = async (workers: TrackingWorker[]) => {
			const lane = await makeLane(workers);
			const child = spawnDecoder(
				this.core.ffmpeg,
				{ ...decodeBase, start: ref, count: span.end - ref },
				spawnOpts,
			);
			let frame = ref;
			for await (const buf of readFrames(child, frameBytes, signal)) await lane.push(frame++, buf);
			await lane.drain();
			if (frame === ref) throw noReferenceFrame(ref);
		};

		const backwardPass = async (workers: TrackingWorker[]) => {
			const lane = await makeLane(workers);
			const K = Math.max(8, Math.min(90, Math.floor(CHUNK_BYTES / frameBytes)));
			const chunk = (hi: number): Promise<{ lo: number; frames: Uint8Array[] }> => {
				const lo = Math.max(span.start, hi - K);
				const p = decodeSpan(this.core.ffmpeg, { ...decodeBase, start: lo, count: hi - lo }, spawnOpts).then(
					(frames) => ({ lo, frames }),
				);
				p.catch(() => undefined);
				return p;
			};
			let hi = ref + 1;
			let next: Promise<{ lo: number; frames: Uint8Array[] }> | null = chunk(hi);
			let first = true;
			while (next) {
				const got: { lo: number; frames: Uint8Array[] } = await next;
				const { lo, frames } = got;
				next = lo > span.start ? chunk(lo) : null;
				if (first && frames.length < hi - lo) throw noReferenceFrame(ref);
				first = false;
				for (let i = frames.length - 1; i >= 0; i--) await lane.push(lo + i, frames[i]!);
				hi = lo;
			}
			await lane.drain();
		};

		let aborted: (e: Error) => void = () => undefined;
		const abortPromise = new Promise<never>((_, reject) => {
			aborted = reject;
		});
		abortPromise.catch(() => undefined);
		const onAbort = () => {
			for (const w of used) w.terminate();
			aborted(new JobError('JOB_CANCELLED', 'Tracking cancelled'));
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener('abort', onAbort, { once: true });

		const fwd = r.direction !== 'backward';
		const bwd = r.direction !== 'forward' && (r.direction === 'backward' || ref > span.start);
		let ok = false;
		try {
			ctx.progress(0, { stage: 'Starting tracker' });
			// Two CPU slots: both directions in parallel (one worker each), or one direction on two workers.
			const slots = Math.max(1, ctx.slots);
			let work: Promise<void>;
			if (fwd && bwd && slots >= 2)
				work = Promise.all([forwardPass([takeWorker()]), backwardPass([takeWorker()])]).then(() => undefined);
			else {
				// The mask tracker works frame to frame (no reference anchors): one worker per pass.
				const ws = Array.from({ length: mask ? 1 : Math.min(2, slots) }, () => takeWorker());
				work = (async () => {
					if (fwd) await forwardPass(ws);
					if (bwd) await backwardPass(ws);
				})();
			}
			await Promise.race([work, abortPromise]);
			ok = true;
		} catch (e) {
			if (signal.aborted) throw new JobError('JOB_CANCELLED', 'Tracking cancelled');
			if (e instanceof JobError) throw e;
			const code = (e as { code?: string }).code;
			if (code === 'TOOL_FAILED' || code === 'BINARY_MISSING') throw e;
			throw new JobError('TRACK_FAILED', (e as Error).message ?? String(e), false);
		} finally {
			signal.removeEventListener('abort', onAbort);
			for (const w of used) {
				this.workers.delete(w);
				if (ok) void releaseWorker(w);
				else w.terminate();
			}
		}

		// Lost frames repeat the last good values in pass order (away from the reference); frames the file did not
		// have (a range past its end) too, with confidence 0.
		const refIdx = ref - span.start;
		const hold = (i: number, from: number) => {
			if (!have[i] || lostFlag[i]) {
				data.set(data.subarray(from * stride, (from + 1) * stride), i * stride);
				conf[i] = 0;
				lostFlag[i] = 1;
			}
		};
		for (let i = refIdx + 1; i < total; i++) hold(i, i - 1);
		for (let i = refIdx - 1; i >= 0; i--) hold(i, i + 1);
		const lost: number[] = [];
		for (let i = 0; i < total; i++) if (lostFlag[i]) lost.push(span.start + i);
		if (pendingEvent) publish(pendingEvent);
		const secs = t0 ? (performance.now() - t0) / 1000 : 0;
		ctx.log(`tracked ${done}/${total} frames at ${size.width}x${size.height} in ${secs.toFixed(2)} s`);
		return {
			startFrame: span.start,
			fps: input.fps,
			stride,
			data: Array.from(data),
			confidence: Array.from(conf),
			method: planar ? PLANAR_METHOD : mask ? MASK_METHOD : POINT_METHOD,
			lost,
			...(r.trackerId ? { trackerId: r.trackerId } : {}),
			...(secs > 0 && done > 1 ? { framesPerSec: Math.round(((done - 1) / secs) * 10) / 10 } : {}),
		};
	};
}

/**
 * Row-major homography in tracking px → media px. `toTrackingPx` is the pixel-centre map x_t = (x_m + ½)/sx − ½, an
 * affine A; so H_m = A⁻¹ · H_t · A, normalised to h₈ = 1.
 */
function homographyToMediaPx(h: number[], sx: number, sy: number): number[] {
	const A = [1 / sx, 0, 0.5 / sx - 0.5, 0, 1 / sy, 0.5 / sy - 0.5, 0, 0, 1];
	const Ainv = [sx, 0, 0.5 * sx - 0.5, 0, sy, 0.5 * sy - 0.5, 0, 0, 1];
	const m = G.hNormalize(G.hMul(G.hMul(Ainv, h), A));
	return m.map((v) => Math.round(v * 1e9) / 1e9);
}

function round3(v: number): number {
	return Math.round(v * 1000) / 1000;
}

function noReferenceFrame(ref: number): JobError {
	return new JobError(
		'VALIDATION_FAILED',
		`The reference frame ${ref} is beyond the end of the media`,
		false,
	);
}

/** Worker tracker configuration for a request at a tracking size (geometry in tracking px). */
function trackerConfig(
	r: TrackRequest,
	size: { width: number; height: number; sx: number; sy: number },
): TrackerConfig {
	if (r.kind === 'mask') {
		const cfg: MaskConfig = {
			kind: 'mask',
			width: size.width,
			height: size.height,
			polygon: G.toTrackingPx(r.reference.polygon!.flat(), size.sx, size.sy),
			method: r.options?.maskMethod ?? 'position-scale-rotation',
			maxFeatures: 500,
			qualityLevel: 0.005,
			minDistance: 12,
			winSize: 15,
			maxLevel: 3,
			fbMax: 0.75,
			threshold: 1.5,
		};
		return cfg;
	}
	if (r.kind === 'planar') {
		const cfg: PlanarConfig = {
			kind: 'planar',
			width: size.width,
			height: size.height,
			corners: G.toTrackingPx(r.reference.corners!.flat(), size.sx, size.sy),
			features: r.options?.features ?? 'inside',
			refineEdges: r.options?.refineEdges === true,
			ecc: r.quality === 'best',
			maxFeatures: 400,
			qualityLevel: 0.01,
			minDistance: 6,
			winSize: 21,
			maxLevel: 3,
			fbMax: 1,
			ransacThreshold: 2,
			minSurvival: 0.3,
		};
		return cfg;
	}
	const [px, py] = G.toTrackingPx([...r.reference.point!], size.sx, size.sy) as [number, number];
	const cfg: PointConfig = {
		kind: 'point',
		width: size.width,
		height: size.height,
		point: [px, py],
		patch: Math.max(7, Math.round((r.reference.patch ?? DEFAULT_PATCH) / size.sx)) | 1,
		search: Math.max(4, Math.round((r.reference.search ?? DEFAULT_SEARCH) / size.sx)),
		minScore: 0.5,
	};
	return cfg;
}
