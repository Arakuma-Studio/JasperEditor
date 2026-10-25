// Super-resolution upscale step (S07:PST-030…034): ONNX Runtime (onnxruntime-node, MIT) with the CPU execution
// provider (CUDA when `device: 'cuda'` and available). Frames are split into 256×256 input tiles with 16 px
// overlap, run in small batches and blended with feathered weights (memory bound for any input size, no
// seams). After the model: optional resize to `size` (bicubic, antialiased) and optional `mix` with a Lanczos
// upscale of the input (hybrid).
import type { ProcessStep } from '@jasper/project';
import {
	cudaProviderLibraryPresent,
	loadOrt as loadSharedOrt,
	type Ort,
	probeOrtProviders,
	type OrtSession as Session,
} from '../../tools/ort.ts';
import { resampleRgb } from './resample.ts';
import type { FrameStep, RgbFrame, StepContext } from './types.ts';

/** Loads onnxruntime-node lazily (native binding; not needed by the other steps). */
function loadOrt(): Ort {
	return loadSharedOrt();
}

/**
 * Execution providers this runtime can really use (for `jasper-proc --version`, the remote probe and
 * capabilities): `cpu` when ONNX Runtime loads; `cuda` only when a session with the CUDA provider can be created
 * (onnxruntime-node lists CUDA as a backend even without the CUDA provider libraries / a GPU). Spec 16 SG-008:
 * the same probe as speech-to-text (`tools/ort.ts` `probeOrtProviders`).
 */
export async function ortProviders(): Promise<string[]> {
	let ort: Ort;
	try {
		ort = loadOrt();
	} catch {
		return [];
	}
	const { tinySrModel } = await import('./tiny-onnx.ts');
	const probe = await probeOrtProviders(
		ort,
		['cuda'],
		tinySrModel(),
		() => ({ input: new ort.Tensor('float32', new Float32Array(48), [1, 3, 4, 4]) }),
		(id) =>
			id === 'cuda' && !cudaProviderLibraryPresent() ? 'the CUDA provider library is not installed' : null,
	);
	return probe.filter((p) => p.available).map((p) => p.id);
}

const TILE = 256;
/**
 * Frames up to this many input pixels run as ONE tile (no overlap work, fewer runs): on the CPU this is
 * 25–35 % faster for 848×480 with SPAN (1.6–1.9 vs 2.1–2.8 s/frame on the loaded test host). Larger frames use
 * 256 px tiles (memory bound for any size, S07:PST-033).
 */
const WHOLE_FRAME_MAX_PIXELS = 1_100_000;
const OVERLAP = 16;
const BATCH = 4;

type Tile = { x: number; y: number };

/** Tile origins along one axis: stride TILE-OVERLAP, the last tile clamped to the end. */
function tileStarts(size: number, tile: number, overlap: number): number[] {
	if (size <= tile) return [0];
	const out: number[] = [];
	const stride = tile - overlap;
	for (let p = 0; ; p += stride) {
		if (p + tile >= size) {
			out.push(size - tile);
			break;
		}
		out.push(p);
	}
	return out;
}

/**
 * 1-D feather weight of output sample `i` (0..len-1) of a tile: linear ramps over the overlap (scaled) at the
 * sides that have a neighbour, 1 elsewhere. Never 0, so normalised blending is always defined.
 */
function featherWeight(i: number, len: number, ramp: number, hasBefore: boolean, hasAfter: boolean): number {
	let w = 1;
	if (hasBefore && i < ramp) w = Math.min(w, (i + 0.5) / ramp);
	if (hasAfter && len - 1 - i < ramp) w = Math.min(w, (len - 1 - i + 0.5) / ramp);
	return w;
}

type SrModel = {
	/** Runs the model on a batch: input NCHW float32 [0,1]; returns NCHW float32 at `scale`×. */
	run(input: Float32Array, n: number, h: number, w: number): Promise<Float32Array>;
	scale: number;
	provider: string;
	release(): Promise<void>;
};

async function openOnnxModel(
	path: string,
	opts: { threads: number; device: 'cpu' | 'cuda'; scale: number },
): Promise<SrModel> {
	const ort = loadOrt();
	let session: Session | null = null;
	let provider = 'cpu';
	if (opts.device === 'cuda') {
		try {
			session = await ort.InferenceSession.create(path, {
				executionProviders: ['cuda', 'cpu'],
				graphOptimizationLevel: 'all',
			});
			provider = 'cuda';
		} catch {
			session = null;
		}
	}
	if (!session) {
		session = await ort.InferenceSession.create(path, {
			executionProviders: ['cpu'],
			graphOptimizationLevel: 'all',
			intraOpNumThreads: Math.max(1, opts.threads),
			interOpNumThreads: 1,
		});
	}
	const s = session;
	const inName = s.inputNames[0];
	const outName = s.outputNames[0];
	return {
		scale: opts.scale,
		provider,
		async run(input, n, h, w) {
			const t = new ort.Tensor('float32', input, [n, 3, h, w]);
			const res = await s.run({ [inName]: t });
			const out = res[outName];
			const dims = out.dims;
			if (dims[2] !== h * opts.scale || dims[3] !== w * opts.scale)
				throw new Error(`model output ${dims.join('x')} is not ${opts.scale}× of ${h}x${w}`);
			return out.data as Float32Array;
		},
		release: () => s.release(),
	};
}

/**
 * Upscales one float RGB frame (interleaved, [0,1]) with the model, tiled. Returns interleaved float RGB at
 * `scale`× the input size.
 */
async function upscaleTiled(
	model: SrModel,
	src: Float32Array,
	width: number,
	height: number,
	opts: { tile?: number; batch?: number } = {},
): Promise<Float32Array> {
	const tile = opts.tile ?? TILE;
	const overlap = OVERLAP;
	const batch = opts.batch ?? BATCH;
	const s = model.scale;
	const ow = width * s;
	const oh = height * s;
	const acc = new Float32Array(ow * oh * 3);
	const wsum = new Float32Array(ow * oh);
	const tw = Math.min(tile, width);
	const th = Math.min(tile, height);
	const plane = tw * th;
	const xs = tileStarts(width, tile, overlap);
	const ys = tileStarts(height, tile, overlap);
	const tiles: Tile[] = [];
	for (const y of ys) for (const x of xs) tiles.push({ x, y });
	const ramp = overlap * s;
	// Precomputed 1-D weights per tile column/row index.
	const wx = xs.map((_, i) => {
		const a = new Float32Array(tw * s);
		for (let k = 0; k < a.length; k++) a[k] = featherWeight(k, a.length, ramp, i > 0, i < xs.length - 1);
		return a;
	});
	const wy = ys.map((_, i) => {
		const a = new Float32Array(th * s);
		for (let k = 0; k < a.length; k++) a[k] = featherWeight(k, a.length, ramp, i > 0, i < ys.length - 1);
		return a;
	});
	for (let b0 = 0; b0 < tiles.length; b0 += batch) {
		const group = tiles.slice(b0, b0 + batch);
		const input = new Float32Array(group.length * 3 * plane);
		group.forEach((t, n) => {
			const base = n * 3 * plane;
			for (let y = 0; y < th; y++) {
				let p = ((t.y + y) * width + t.x) * 3;
				const row = y * tw;
				for (let x = 0; x < tw; x++, p += 3) {
					input[base + row + x] = src[p];
					input[base + plane + row + x] = src[p + 1];
					input[base + 2 * plane + row + x] = src[p + 2];
				}
			}
		});
		const out = await model.run(input, group.length, th, tw);
		const otw = tw * s;
		const oth = th * s;
		const oplane = otw * oth;
		group.forEach((t, n) => {
			const base = n * 3 * oplane;
			const wxa = wx[xs.indexOf(t.x)];
			const wya = wy[ys.indexOf(t.y)];
			for (let y = 0; y < oth; y++) {
				const oy = t.y * s + y;
				const wyy = wya[y];
				let q = oy * ow + t.x * s;
				const row = y * otw;
				for (let x = 0; x < otw; x++, q++) {
					const w = wyy * wxa[x];
					const i = row + x;
					const p = q * 3;
					acc[p] += w * out[base + i];
					acc[p + 1] += w * out[base + oplane + i];
					acc[p + 2] += w * out[base + 2 * oplane + i];
					wsum[q] += w;
				}
			}
		});
	}
	for (let q = 0, p = 0; q < wsum.length; q++, p += 3) {
		const inv = 1 / wsum[q];
		acc[p] *= inv;
		acc[p + 1] *= inv;
		acc[p + 2] *= inv;
	}
	return acc;
}

function u16ToFloat(data: Uint16Array): Float32Array {
	const out = new Float32Array(data.length);
	const k = 1 / 65535;
	for (let i = 0; i < data.length; i++) out[i] = data[i] * k;
	return out;
}

function floatToU16(data: Float32Array): Uint16Array {
	const out = new Uint16Array(data.length);
	for (let i = 0; i < data.length; i++) {
		const v = data[i] * 65535 + 0.5;
		out[i] = v <= 0 ? 0 : v >= 65535 ? 65535 : v;
	}
	return out;
}

function outputSize(
	step: Extract<ProcessStep, { op: 'upscale' }>,
	width: number,
	height: number,
): { width: number; height: number } {
	if (step.size) return { width: step.size.width, height: step.size.height };
	return { width: width * step.scale, height: height * step.scale };
}

export function createUpscaleStep(step: Extract<ProcessStep, { op: 'upscale' }>): FrameStep {
	let model: SrModel | null = null;
	let ctxRef: StepContext | null = null;
	let size = { width: 0, height: 0 };
	let seconds = 0;
	let frames = 0;
	const mix = step.mix ?? 1;
	return {
		name: `upscale(${step.model})`,
		async open(ctx) {
			ctxRef = ctx;
			if (!model) {
				const m = ctx.models[step.model];
				if (!m) {
					const e = new Error(`model ${step.model} is not installed`) as Error & { code: string };
					e.code = 'MODEL_NOT_INSTALLED';
					throw e;
				}
				model = await openOnnxModel(m.path, {
					threads: ctx.threads,
					device: ctx.device,
					scale: m.scale ?? step.scale,
				});
				ctx.info('model', { id: step.model, sha256: m.sha256, provider: model.provider });
				if (ctx.device === 'cuda' && model.provider !== 'cuda')
					ctx.note('upscale: CUDA unavailable, ONNX Runtime ran on the CPU');
			}
			if (model.scale !== step.scale) {
				// A 4× model asked for 2× (or the reverse): the resize below brings it to the requested size.
				ctx.note(`upscale: model scale ${model.scale}× resized to ${step.scale}×`);
			}
			size = outputSize(step, ctx.width, ctx.height);
			ctx.info('outputSize', size);
			return size;
		},
		async push(frame: RgbFrame) {
			if (!model || !ctxRef) throw new Error('upscale step not opened');
			const t0 = performance.now();
			const src = u16ToFloat(frame.data);
			const whole = frame.width * frame.height <= WHOLE_FRAME_MAX_PIXELS;
			let out = await upscaleTiled(
				model,
				src,
				frame.width,
				frame.height,
				whole ? { tile: Math.max(frame.width, frame.height), batch: 1 } : {},
			);
			const mw = frame.width * model.scale;
			const mh = frame.height * model.scale;
			if (mw !== size.width || mh !== size.height)
				out = resampleRgb(out, mw, mh, size.width, size.height, 'bicubic');
			if (mix < 1) {
				const base = resampleRgb(src, frame.width, frame.height, size.width, size.height, 'lanczos');
				// The Lanczos reference is clamped first (its ringing overshoots), as in the trailer's sr.py.
				for (let i = 0; i < out.length; i++) {
					const b = base[i] < 0 ? 0 : base[i] > 1 ? 1 : base[i];
					const a = out[i] < 0 ? 0 : out[i] > 1 ? 1 : out[i];
					out[i] = mix * a + (1 - mix) * b;
				}
			}
			seconds += (performance.now() - t0) / 1000;
			frames++;
			return [{ index: frame.index, width: size.width, height: size.height, data: floatToU16(out) }];
		},
		async end() {
			ctxRef?.info('secondsPerFrame', frames ? Math.round((seconds / frames) * 1000) / 1000 : null);
			return [];
		},
		async close() {
			if (model) await model.release();
		},
	};
}
