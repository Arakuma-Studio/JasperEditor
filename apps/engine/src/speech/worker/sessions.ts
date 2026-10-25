// ONNX Runtime sessions of a Whisper model part on a chosen execution provider (spec 16 SG-002…SG-004).
//
// - Creation: the part's provider first (with the CPU provider behind it for unsupported nodes); when that fails
//   (no CUDA libraries, no adapter…) the session is created again on the CPU and the reason is recorded (SG-003).
// - fp16 exports (SG-020 `whisper-large-v3-turbo-fp16`) take and return float16 tensors; the rest of the worker
//   works in float32, so feeds and outputs are converted here (by the session's input/output metadata).
// - WebGPU device-resident decoding (SG-004): with `preferredOutputLocation: 'gpu-buffer'` the key/value cache
//   stays on the GPU between steps. onnxruntime-node 1.30.0 keeps such outputs bound to the session, which breaks
//   its next call with other fetches, so the cached steps (fixed fetches) run on a second session of the same
//   model and the first one only does the uncached passes. Stale cache tensors are disposed by the caller.
import { type Ort, type OrtSession, type OrtTensor, type ProviderId, providerOption, shortReason } from '../../tools/ort.ts';

export type SessionFallback = { from: ProviderId; reason: string };

/** What the Whisper code calls: `run` with feeds and fetches (one or two sessions underneath). */
export type PartSession = {
	readonly provider: ProviderId;
	readonly fallback: SessionFallback | null;
	/** Cached-step outputs live on the GPU (the caller disposes replaced cache tensors). */
	readonly deviceResident: boolean;
	run(feeds: Record<string, OrtTensor>, fetches?: string[]): Promise<Record<string, OrtTensor>>;
	release(): Promise<void>;
};

export type PartOptions = {
	provider: ProviderId;
	threads: number;
	/** Decoder on WebGPU with the cache kept on the GPU (greedy only: beam search gathers rows on the CPU). */
	deviceResident?: boolean;
	/** Names of the outputs that stay on the GPU in device-resident mode. */
	residentOutputs?: (name: string) => boolean;
	/**
	 * Device-resident mode: the session that runs passes without cache fetches (language detection, alignment) —
	 * a third set of fetches on the GPU sessions would hit the binding bug, so these go to the CPU decoder.
	 */
	plain?: PartSession;
};

function sessionOptions(provider: ProviderId, threads: number, location?: Record<string, string>) {
	return {
		executionProviders: provider === 'cpu' ? ['cpu'] : [providerOption(provider), 'cpu'],
		graphOptimizationLevel: 'all',
		intraOpNumThreads: Math.max(1, threads),
		interOpNumThreads: 1,
		logSeverityLevel: 3,
		...(location ? { preferredOutputLocation: location } : {}),
	} as unknown as import('onnxruntime-node').InferenceSession.SessionOptions;
}

// float16 ↔ float32 (IEEE 754 half, round to nearest even)
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function toHalf(v: number): number {
	f32[0] = v;
	const x = u32[0];
	const sign = (x >>> 16) & 0x8000;
	const e8 = (x >>> 23) & 0xff;
	let mant = x & 0x7fffff;
	if (e8 === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
	const exp = e8 - 127 + 15;
	if (exp >= 31) return sign | 0x7c00;
	if (exp <= 0) {
		if (exp < -10) return sign;
		mant |= 0x800000;
		const shift = 14 - exp;
		const half = mant >> shift;
		const rem = mant & ((1 << shift) - 1);
		const mid = 1 << (shift - 1);
		return sign | (rem > mid || (rem === mid && half & 1) ? half + 1 : half);
	}
	const h = sign | (exp << 10) | (mant >> 13);
	const rem = mant & 0x1fff;
	return rem > 0x1000 || (rem === 0x1000 && h & 1) ? h + 1 : h;
}
const halfTable = new Float32Array(65536);
for (let h = 0; h < 65536; h++) {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const m = h & 0x3ff;
	halfTable[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? Number.NaN : s * Number.POSITIVE_INFINITY) : s * (1 + m / 1024) * 2 ** (e - 15);
}
export function fromHalf(h: number): number {
	return halfTable[h & 0xffff];
}

type Meta = { name: string; type?: string };
function halfNames(meta: unknown): Set<string> {
	const list = Array.isArray(meta) ? (meta as Meta[]) : [];
	return new Set(list.filter((m) => m && m.type === 'float16').map((m) => m.name));
}

/** Wraps a session so float32 feeds become float16 where the model wants them, and float16 outputs float32. */
function withHalf(ort: Pick<Ort, 'Tensor'>, s: OrtSession): OrtSession['run'] {
	const inHalf = halfNames((s as unknown as { inputMetadata?: unknown }).inputMetadata);
	const run = s.run.bind(s) as (f: Record<string, OrtTensor>, o?: unknown) => Promise<Record<string, OrtTensor>>;
	if (!inHalf.size) return run as OrtSession['run'];
	return (async (feeds: Record<string, OrtTensor>, fetches?: unknown) => {
		const f2: Record<string, OrtTensor> = {};
		for (const [k, v] of Object.entries(feeds)) {
			if (inHalf.has(k) && v.type === 'float32' && v.location !== 'gpu-buffer') {
				const src = v.data as Float32Array;
				const dst = new Uint16Array(src.length);
				for (let i = 0; i < src.length; i++) dst[i] = toHalf(src[i]);
				f2[k] = new ort.Tensor('float16', dst, v.dims as number[]);
			} else f2[k] = v;
		}
		const out = await run(f2, fetches);
		for (const [k, v] of Object.entries(out))
			if (v.type === 'float16' && v.location !== 'gpu-buffer') {
				const src = v.data as Uint16Array;
				const dst = new Float32Array(src.length);
				for (let i = 0; i < src.length; i++) dst[i] = halfTable[src[i]];
				out[k] = new ort.Tensor('float32', dst, v.dims as number[]);
			}
		return out;
	}) as OrtSession['run'];
}

async function createOn(
	ort: Pick<Ort, 'InferenceSession'>,
	path: string,
	provider: ProviderId,
	threads: number,
	location?: Record<string, string>,
): Promise<OrtSession> {
	return ort.InferenceSession.create(path, sessionOptions(provider, threads, location));
}

/**
 * A model part on `opts.provider`, falling back to the CPU when the GPU session cannot be created (the reason is
 * kept in `fallback`). A CPU failure throws (a broken model or file).
 */
export async function createPartSession(
	ort: Pick<Ort, 'InferenceSession' | 'Tensor'>,
	path: string,
	opts: PartOptions,
): Promise<PartSession> {
	if (opts.provider !== 'cpu') {
		try {
			return await createGpu(ort, path, opts);
		} catch (e) {
			const s = await createOn(ort, path, 'cpu', opts.threads);
			return wrap(ort, s, null, 'cpu', { from: opts.provider, reason: shortReason(e) }, false);
		}
	}
	const s = await createOn(ort, path, 'cpu', opts.threads);
	return wrap(ort, s, null, 'cpu', null, false);
}

async function createGpu(
	ort: Pick<Ort, 'InferenceSession' | 'Tensor'>,
	path: string,
	opts: PartOptions,
): Promise<PartSession> {
	if (!opts.deviceResident || opts.provider !== 'webgpu') {
		const s = await createOn(ort, path, opts.provider, opts.threads);
		return wrap(ort, s, null, opts.provider, null, false);
	}
	// probe the output names, then the two device-resident sessions (SG-004)
	const probe = await createOn(ort, path, opts.provider, opts.threads);
	const names = [...probe.outputNames];
	await probe.release();
	const resident = opts.residentOutputs ?? ((n: string) => n.startsWith('present.'));
	const location: Record<string, string> = {};
	for (const n of names) location[n] = resident(n) ? 'gpu-buffer' : 'cpu';
	const full = await createOn(ort, path, opts.provider, opts.threads, location);
	let steps: OrtSession;
	try {
		steps = await createOn(ort, path, opts.provider, opts.threads, location);
	} catch (e) {
		await full.release();
		throw e;
	}
	return wrap(ort, full, steps, opts.provider, null, true, opts.plain ?? null);
}

function wrap(
	ort: Pick<Ort, 'Tensor'>,
	main: OrtSession,
	steps: OrtSession | null,
	provider: ProviderId,
	fallback: SessionFallback | null,
	deviceResident: boolean,
	plain: PartSession | null = null,
): PartSession {
	const runMain = withHalf(ort, main);
	const runSteps = steps ? withHalf(ort, steps) : null;
	return {
		provider,
		fallback,
		deviceResident,
		run(feeds, fetches) {
			// cached decoder steps (use_cache_branch = true) go to the second session in device-resident mode
			const flag = feeds.use_cache_branch?.data as ArrayLike<unknown> | undefined;
			const cachedStep = !!runSteps && !!flag && Number(flag[0]) === 1;
			if (deviceResident && !cachedStep && plain && !(fetches ?? []).some((f) => f.startsWith('present.')))
				return plain.run(feeds, fetches);
			const fn = cachedStep ? (runSteps as OrtSession['run']) : runMain;
			return (fetches ? fn(feeds, fetches) : fn(feeds)) as Promise<Record<string, OrtTensor>>;
		},
		async release() {
			await main.release();
			if (steps) await steps.release();
		},
	};
}
