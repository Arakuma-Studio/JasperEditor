// ffmpeg decodes a media range to small RGB frames (≤ 256 px wide); for each frame the subject is
//   1. the faces, when the roto face model (MediaPipe BlazeFace) is installed: every 3rd frame goes through the
//      jasper-roto child, the centre is the area × score weighted mean of the detected faces (held between samples);
//   2. otherwise (and on frames without faces) a saliency centroid: the residual motion after the dominant (camera)
//      shift is removed — what moves on its own —, centre-surround contrast of luma and chroma (Itti-style, box
//      blurs) and a skin-tone likelihood (YCbCr box of Chai & Ngan), with a weak centre bias; the subject is the
//      weighted centroid of the top 15 % of the map.
// Output per frame: x, y (0..1 of the display) and a confidence. Smoothing and keyframing are the project's
// (`gaps/auto-reframe.ts`), so the same analysis serves every Motion Tracking preset.
import { createHash } from 'node:crypto';
import type { EngineJob } from '@jasper/api';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { RotoService } from '../roto/service.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';
import { readFrames } from '../tracking/decode.ts';

export type ReframeRequest = {
	projectId?: string;
	mediaKey: string;
	startFrame: number;
	frameCount: number;
	/** Use faces when the face model is installed (default true). */
	faces?: boolean;
};

export type ReframeResult = {
	start: number;
	frameDuration: number;
	/** x, y, confidence per frame. */
	points: number[];
	source: 'faces' | 'saliency' | 'mixed';
	frames: number;
	facesFound: number;
	note?: string;
};

type Input = {
	request: ReframeRequest;
	file: string;
	display: { width: number; height: number };
	fps: { num: number; den: number };
};

const W_MAX = 256;
const FACE_EVERY = 3;

function sizeFor(display: { width: number; height: number }) {
	const k = Math.min(1, W_MAX / display.width);
	let w = Math.max(16, Math.round(display.width * k));
	let h = Math.max(16, Math.round(display.height * k));
	w += w % 2;
	h += h % 2;
	return { width: w, height: h };
}

/** Box blur of a plane (separable, radius r, clamped edges). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
	const tmp = new Float32Array(w * h);
	const out = new Float32Array(w * h);
	const n = 2 * r + 1;
	for (let y = 0; y < h; y++) {
		let s = 0;
		for (let i = -r; i <= r; i++) s += src[y * w + Math.min(w - 1, Math.max(0, i))]!;
		for (let x = 0; x < w; x++) {
			tmp[y * w + x] = s / n;
			s += src[y * w + Math.min(w - 1, x + r + 1)]! - src[y * w + Math.max(0, x - r)]!;
		}
	}
	for (let x = 0; x < w; x++) {
		let s = 0;
		for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, i)) * w + x]!;
		for (let y = 0; y < h; y++) {
			out[y * w + x] = s / n;
			s += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
		}
	}
	return out;
}

/** Dominant integer shift of `cur` against `prev` (luma, ±R px, sparse SAD), i.e. the camera's move. */
function dominantShift(prev: Float32Array, cur: Float32Array, w: number, h: number, R = 8): [number, number] {
	let best = Number.POSITIVE_INFINITY;
	let bx = 0;
	let by = 0;
	for (let dy = -R; dy <= R; dy++)
		for (let dx = -R; dx <= R; dx++) {
			let s = 0;
			let n = 0;
			for (let y = R; y < h - R; y += 2)
				for (let x = R; x < w - R; x += 2) {
					s += Math.abs(cur[(y + dy) * w + x + dx]! - prev[y * w + x]!);
					n++;
				}
			const e = s / Math.max(1, n) + 1e-4 * (Math.abs(dx) + Math.abs(dy));
			if (e < best) {
				best = e;
				bx = dx;
				by = dy;
			}
		}
	return [bx, by];
}

/** Saliency map of one RGB frame (and the previous luma for motion). */
function saliency(
	rgb: Uint8Array,
	w: number,
	h: number,
	prevLuma: Float32Array | null,
): { map: Float32Array; luma: Float32Array } {
	const n = w * h;
	const L = new Float32Array(n);
	const Cb = new Float32Array(n);
	const Cr = new Float32Array(n);
	const skin = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const r = rgb[3 * i]!;
		const g = rgb[3 * i + 1]!;
		const b = rgb[3 * i + 2]!;
		const y = 0.299 * r + 0.587 * g + 0.114 * b;
		const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
		const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
		L[i] = y / 255;
		Cb[i] = cb / 255;
		Cr[i] = cr / 255;
		skin[i] = cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173 && y > 40 ? 1 : 0;
	}
	const r1 = Math.max(1, Math.round(w / 64));
	const r2 = Math.max(3, Math.round(w / 10));
	const cs = new Float32Array(n);
	for (const P of [L, Cb, Cr]) {
		const a = boxBlur(P, w, h, r1);
		const b = boxBlur(P, w, h, r2);
		for (let i = 0; i < n; i++) cs[i]! += Math.abs(a[i]! - b[i]!);
	}
	const motion = new Float32Array(n);
	if (prevLuma) {
		const [sx, sy] = dominantShift(prevLuma, L, w, h);
		const lb = boxBlur(L, w, h, 1);
		const pb = boxBlur(prevLuma, w, h, 1);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const px = Math.min(w - 1, Math.max(0, x - sx));
				const py = Math.min(h - 1, Math.max(0, y - sy));
				motion[y * w + x] = Math.abs(lb[y * w + x]! - pb[py * w + px]!);
			}
	}
	const norm = (a: Float32Array) => {
		let m = 0;
		for (const v of a) m = Math.max(m, v);
		if (m > 1e-6) for (let i = 0; i < a.length; i++) a[i]! /= m;
		return a;
	};
	norm(cs);
	norm(motion);
	const skinB = boxBlur(skin, w, h, r1);
	const map = new Float32Array(n);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const dx = (x + 0.5) / w - 0.5;
			const dy = (y + 0.5) / h - 0.5;
			const bias = 0.75 + 0.25 * Math.exp(-(dx * dx + dy * dy) / (2 * 0.3 * 0.3));
			map[i] = (0.6 * cs[i]! + 1.4 * motion[i]! + 0.5 * skinB[i]!) * bias;
		}
	return { map: boxBlur(map, w, h, r1), luma: L };
}

/** Weighted centroid of the top `share` of a map, and how concentrated it is (confidence). */
export function topCentroid(map: Float32Array, w: number, h: number, share = 0.15): [number, number, number] {
	const sorted = Float32Array.from(map).sort();
	const thr = sorted[Math.floor(sorted.length * (1 - share))] ?? 0;
	let sx = 0;
	let sy = 0;
	let sw = 0;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const v = map[y * w + x]! - thr;
			if (v <= 0) continue;
			sx += v * (x + 0.5);
			sy += v * (y + 0.5);
			sw += v;
		}
	if (sw <= 1e-9) return [0.5, 0.5, 0];
	const cx = sx / sw;
	const cy = sy / sw;
	// Spread of the mass around the centroid (small spread = a clear subject).
	let sp = 0;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const v = map[y * w + x]! - thr;
			if (v > 0) sp += v * Math.hypot((x + 0.5 - cx) / w, (y + 0.5 - cy) / h);
		}
	const conf = Math.max(0.05, Math.min(1, 1 - sp / sw / 0.35));
	return [cx / w, cy / h, conf];
}

export class ReframeService {
	constructor(
		private readonly core: CoreServices,
		private readonly roto: () => RotoService | undefined,
	) {}

	registerRunner(): void {
		this.core.queue.registerRunner('reframe', (ctx) => this.run(ctx));
	}

	/** The job input of a request (the media's file, display size and rate); 404 / 400 for unusable media. */
	private async inputOf(r: ReframeRequest): Promise<Input> {
		const rec = this.core.registry.get(r.mediaKey);
		if (!rec) throw new HttpError(404, 'ASSET_NOT_FOUND', `Unknown media key ${r.mediaKey}`);
		const file = await this.core.registry.resolvePath(r.mediaKey);
		if (!file) throw new HttpError(404, 'ASSET_NOT_FOUND', 'The media file is offline');
		const vs = rec.probe.streams.find((s) => s.type === 'video');
		if (vs?.type !== 'video') throw new HttpError(400, 'VALIDATION_FAILED', 'The media has no video stream');
		const fps = { num: vs.frameRate.num, den: vs.frameRate.den };
		if (!(fps.num > 0 && fps.den > 0))
			throw new HttpError(400, 'VALIDATION_FAILED', 'The video has no frame rate');
		const display = rec.display ?? { width: vs.width, height: vs.height };
		return { request: r, file, display, fps };
	}

	async submit(r: ReframeRequest): Promise<EngineJob> {
		const input = await this.inputOf(r);
		return this.core.queue.submit({
			kind: 'reframe',
			title: `Auto Reframe: analyse ${r.frameCount} frames`,
			priority: 'user',
			cpuSlots: 1,
			minSlots: 1,
			...(r.projectId ? { projectId: r.projectId } : {}),
			dedupeKey: `reframe:${createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 32)}`,
			input,
			stage: 'Analyzing',
		});
	}

	/**
	 * The same analysis inside another job (spec 15 EA-021: a punch-in's subject), on that job's signal and slots: a job
	 * never waits for a queue slot of its own.
	 */
	async analyze(
		r: ReframeRequest,
		ctx: Pick<JobContext, 'signal' | 'trackChild'> & { progress?: JobContext['progress'] },
	): Promise<ReframeResult> {
		const input = await this.inputOf(r);
		return this.run({
			input,
			signal: ctx.signal,
			trackChild: ctx.trackChild,
			progress: ctx.progress ?? (() => undefined),
		} as unknown as JobContext);
	}

	private async run(ctx: JobContext): Promise<ReframeResult> {
		const { request: r, file, display, fps } = ctx.input as Input;
		const size = sizeFor(display);
		const seek = r.startFrame > 0 ? ['-ss', (((r.startFrame - 0.5) * fps.den) / fps.num).toFixed(6)] : [];
		const child = this.core.ffmpeg.spawnRaw(
			[
				...seek,
				'-i',
				file,
				...['-map', '0:v:0', '-an', '-sn', '-dn'],
				...['-vf', `scale=${size.width}:${size.height}:flags=area,format=rgb24`, '-fps_mode', 'passthrough'],
				...['-frames:v', String(r.frameCount), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
			],
			{ signal: ctx.signal, onSpawn: (c) => ctx.trackChild(c) },
		);
		const roto = r.faces === false ? undefined : this.roto();
		// Faces are looked for on every FACE_EVERY-th frame (and at most ~600 of them): only those frames are kept.
		const every = Math.max(FACE_EVERY, Math.ceil(r.frameCount / 600));
		const faceFrames = new Map<number, Uint8Array>();
		let count = 0;
		const sal: [number, number, number][] = [];
		let prev: Float32Array | null = null;
		try {
			for await (const buf of readFrames(child, size.width * size.height * 3, ctx.signal)) {
				const f = new Uint8Array(buf);
				if (roto && count % every === 0) faceFrames.set(count, f);
				count++;
				const s = saliency(f, size.width, size.height, prev);
				prev = s.luma;
				sal.push(topCentroid(s.map, size.width, size.height));
				ctx.progress(Math.min(0.8, (0.8 * count) / r.frameCount), {
					stage: `Analyzing ${count}/${r.frameCount}`,
				});
			}
		} catch (e) {
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Auto Reframe cancelled');
			throw e;
		}
		if (!count) throw new JobError('REFRAME_FAILED', 'No frame could be decoded', false);
		// The first frame has no motion cue: take the second frame's subject when it is clearer.
		if (sal.length > 1 && sal[1]![2] > sal[0]![2]) sal[0] = sal[1]!;
		let faces: ({ x: number; y: number; conf: number } | null)[] = [];
		let note: string | undefined;
		if (roto) {
			const idx = [...faceFrames.keys()];
			ctx.progress(0.85, { stage: 'Finding faces' });
			const res = await roto
				.detectFaces(
					idx.map((i) => ({ rgb: faceFrames.get(i)!, width: size.width, height: size.height })),
					ctx.signal,
				)
				.catch((e: Error) => ({ unavailable: e.message }) as const);
			if ('faces' in res) {
				const sampled = res.faces.map((list) => {
					let sx = 0;
					let sy = 0;
					let sw = 0;
					for (const b of list) {
						const w = b.w * b.h * b.score;
						sx += w * (b.x + b.w / 2);
						sy += w * (b.y + b.h * 0.45);
						sw += w;
					}
					return sw > 0
						? { x: sx / sw, y: sy / sw, conf: Math.min(1, 0.6 + Math.max(...list.map((b) => b.score)) * 0.4) }
						: null;
				});
				faces = sal.map((_, i) => {
					const k = Math.floor(i / every);
					const a = sampled[k] ?? null;
					const b = sampled[k + 1] ?? null;
					if (a && b) {
						const t = (i - k * every) / every;
						return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, conf: Math.min(a.conf, b.conf) };
					}
					return a ?? b;
				});
			} else note = String(res.unavailable);
		} else if (r.faces !== false) note = 'FACE_MODEL_NOT_INSTALLED';
		const points: number[] = [];
		let found = 0;
		sal.forEach((_, i) => {
			const f = faces[i];
			if (f) {
				found++;
				points.push(Math.round(f.x * 1e4) / 1e4, Math.round(f.y * 1e4) / 1e4, Math.round(f.conf * 1e3) / 1e3);
			} else {
				const s = sal[i]!;
				points.push(Math.round(s[0] * 1e4) / 1e4, Math.round(s[1] * 1e4) / 1e4, Math.round(s[2] * 1e3) / 1e3);
			}
		});
		const frameDuration = fps.den / fps.num;
		return {
			start: r.startFrame * frameDuration,
			frameDuration,
			points,
			source: found === 0 ? 'saliency' : found === count ? 'faces' : 'mixed',
			frames: count,
			facesFound: found,
			...(note ? { note } : {}),
		};
	}
}
