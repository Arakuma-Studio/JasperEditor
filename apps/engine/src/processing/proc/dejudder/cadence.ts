// Frame-cadence analysis (S07:PST-011), a port of the trailer project's `grade/tools/cadence.py`.
//
// Per frame pair: dense Farnebäck flow on a grey proxy ≤ 424 px wide, motion = 75th percentile of the flow
// magnitude. Steps are normalised by their 3-tap moving mean, pairs count as moving when that mean exceeds
// 0.35 px (at a 424 px proxy; scaled with the proxy width), and the relative steps are folded by the index of
// the pair's SECOND frame mod 3. `shortPhase = p` means: the step INTO frame n is the short one when
// `n % 3 == p` (n = `firstFrameIndex` + the frame's index in the analysed input).
import { decodeFrames } from '../ffio.ts';
import type { DecodeSpec } from '../types.ts';
import type { CvPool } from './pool.ts';

/** Proxy width of the reference analyser; the moving threshold and the 1080p scaling refer to it. */
export const ANALYSIS_MAX_WIDTH = 424;
/** Moving-pair threshold on the local mean step, px at a 424 px wide proxy. */
const MOVING_PX_AT_424 = 0.35;

export type CadenceResult = {
	/** Absolute index of the first analysed frame (phase reference). */
	firstFrameIndex: number;
	/** `null` when nothing moved enough to fold the steps. */
	shortPhase: number | null;
	/** Median relative short step / mean of the two others (0.5 for an ideal 50→30 decimation; NaN if none). */
	shortToLongRatio: number;
	/** Share of fully moving aligned triples whose smallest step lies in `shortPhase` (NaN when no triple). */
	consistency: number;
	/** Mean motion of the moving pairs, px/frame scaled to a 1920 px wide frame. */
	meanMotionPx1080p: number;
	/** movingPairs / pairs. */
	movingShare: number;
	/** Median relative step per phase (index = frame index mod 3); NaN when a phase has no moving pair. */
	relStepByPhase: [number, number, number];
	pairs: number;
	movingPairs: number;
	triples: number;
};

export type CadenceOptions = {
	/** Absolute index of the first frame of the analysed input (default 0). */
	firstFrameIndex?: number;
	/** Width of the grey proxy the motion values were measured on (default 424). */
	proxyWidth?: number;
};

const mod3 = (n: number) => ((n % 3) + 3) % 3;

function median(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	const s = [...values].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(values: number[]): number {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN;
}

/** `np.convolve(motion, ones(3)/3, 'same')`: 3-tap moving mean with zero padding. */
function localMean(motion: readonly number[]): number[] {
	const n = motion.length;
	return motion.map((v, i) => ((i > 0 ? motion[i - 1] : 0) + v + (i < n - 1 ? motion[i + 1] : 0)) / 3);
}

/** Per pair: relative step (motion / local mean) and whether the pair moves (PST-011). */
function relativeSteps(
	motion: readonly number[],
	opts: CadenceOptions = {},
): { rel: number[]; valid: boolean[]; local: number[] } {
	const threshold = MOVING_PX_AT_424 * ((opts.proxyWidth ?? ANALYSIS_MAX_WIDTH) / ANALYSIS_MAX_WIDTH);
	const local = localMean(motion);
	const rel = motion.map((m, i) => m / Math.max(local[i], 1e-6));
	const valid = local.map((l) => l > threshold);
	if (valid.length) {
		valid[0] = false;
		valid[valid.length - 1] = false;
	}
	return { rel, valid, local };
}

/**
 * Cadence of a sequence of per-pair motion values (`motion[i]` = motion from input frame i to i+1).
 * Pure; mirrors cadence.py `analyse`.
 */
export function analyseMotion(motion: readonly number[], opts: CadenceOptions = {}): CadenceResult {
	const first = opts.firstFrameIndex ?? 0;
	const proxyWidth = opts.proxyWidth ?? ANALYSIS_MAX_WIDTH;
	const { rel, valid } = relativeSteps(motion, opts);
	const idx = motion.map((_, i) => first + i + 1);
	const by = [0, 1, 2].map((p) => median(rel.filter((_, i) => valid[i] && mod3(idx[i]) === p))) as [
		number,
		number,
		number,
	];
	const anyValid = valid.some(Boolean);
	let short: number | null = null;
	if (anyValid) {
		for (let p = 0; p < 3; p++) {
			if (Number.isNaN(by[p])) continue;
			if (short === null || by[p] < by[short]) short = p;
		}
	}
	let hits = 0;
	let triples = 0;
	for (let i = 0; i + 2 < motion.length; i++) {
		if (!(valid[i] && valid[i + 1] && valid[i + 2])) continue;
		triples++;
		let j = 0;
		for (let k = 1; k < 3; k++) if (motion[i + k] < motion[i + j]) j = k;
		if (mod3(idx[i + j]) === short) hits++;
	}
	const others = short === null ? [] : by.filter((b, p) => p !== short && !Number.isNaN(b));
	const ratio = short === null ? Number.NaN : by[short] / mean(others);
	const moving = motion.filter((_, i) => valid[i]);
	return {
		firstFrameIndex: first,
		shortPhase: short,
		shortToLongRatio: ratio,
		consistency: triples ? hits / triples : Number.NaN,
		meanMotionPx1080p: moving.length ? (mean(moving) * 1920) / proxyWidth : 0,
		movingShare: motion.length ? moving.length / motion.length : 0,
		relStepByPhase: by,
		pairs: motion.length,
		movingPairs: moving.length,
		triples,
	};
}

export type CadenceEvenness = {
	/** Coefficient of variation (population std / mean) of the relative steps of the moving pairs; 0 = even. */
	cv: number;
	/** Coefficient of variation of the raw per-pair motion of the moving pairs (sensitive to speed changes). */
	rawCv: number;
	/** Phase-folded relative steps (median per `frameIndex mod 3`). */
	byPhase: [number, number, number];
	/** min/max of `byPhase` (1 = perfectly even; ~0.5 for an uncorrected 2:2:1 cadence). */
	minOverMax: number;
};

/** How even the per-pair steps are (tests, validation reports). */
export function cadenceEvenness(motion: readonly number[], opts: CadenceOptions = {}): CadenceEvenness {
	const { rel, valid } = relativeSteps(motion, opts);
	const cv = (xs: number[]) => {
		const m = mean(xs);
		if (!xs.length || m === 0) return Number.NaN;
		return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / m;
	};
	const r = analyseMotion(motion, opts);
	const phases = r.relStepByPhase.filter((b) => !Number.isNaN(b));
	return {
		cv: cv(rel.filter((_, i) => valid[i])),
		rawCv: cv(motion.filter((_, i) => valid[i])),
		byPhase: r.relStepByPhase,
		minOverMax: phases.length ? Math.min(...phases) / Math.max(...phases) : Number.NaN,
	};
}

/** Size of the grey analysis proxy for a `width`×`height` input (≤ 424 px wide, even dimensions). */
function analysisSize(
	width: number,
	height: number,
	maxWidth = ANALYSIS_MAX_WIDTH,
): { w: number; h: number } {
	const w = Math.min(width, maxWidth) & ~1 || Math.min(width, maxWidth);
	const h = Math.max(2, Math.round((height * w) / width / 2) * 2);
	return { w, h };
}

export type MotionMeasurement = {
	/** Per pair (frame i → i+1) 75th percentile of the flow magnitude, px on the proxy. */
	motion: number[];
	/** Median horizontal / vertical displacement per pair (diagnostics). */
	dx: number[];
	dy: number[];
	proxyWidth: number;
	proxyHeight: number;
	frames: number;
};

/**
 * Decodes `spec` as grey proxies and measures the per-pair motion on the pool (pairs run in parallel).
 */
export async function measureMotion(
	spec: DecodeSpec,
	pool: CvPool,
	opts: { maxWidth?: number; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<MotionMeasurement> {
	const { w, h } = analysisSize(spec.width, spec.height, opts.maxWidth);
	const jobs: Promise<{ p75: number; dx: number; dy: number }>[] = [];
	const window = Math.max(2, pool.size * 2);
	let prev: Uint8Array | null = null;
	let frames = 0;
	let done = 0;
	const pairsTotal = Math.max(1, spec.frames - 1);
	for await (const buf of decodeFrames(spec, { pixFmt: 'gray', width: w, height: h, signal: opts.signal })) {
		const cur = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
		frames++;
		if (prev) {
			const job = pool.motion(w, h, prev, cur);
			job.then(
				() => opts.onProgress?.(++done / pairsTotal),
				() => {},
			);
			jobs.push(job);
			// Bound the work in flight (back-pressure on the decoder).
			if (jobs.length - done > window) await jobs[jobs.length - 1 - window];
		}
		prev = cur;
	}
	const results = await Promise.all(jobs);
	return {
		motion: results.map((r) => r.p75),
		dx: results.map((r) => r.dx),
		dy: results.map((r) => r.dy),
		proxyWidth: w,
		proxyHeight: h,
		frames,
	};
}

/** Decodes and analyses the cadence of `spec` (PST-011). */
export async function analyseCadence(
	spec: DecodeSpec,
	pool: CvPool,
	opts: CadenceOptions & {
		maxWidth?: number;
		signal?: AbortSignal;
		onProgress?: (fraction: number) => void;
	} = {},
): Promise<CadenceResult & { measurement: MotionMeasurement }> {
	const measurement = await measureMotion(spec, pool, opts);
	const result = analyseMotion(measurement.motion, {
		firstFrameIndex: opts.firstFrameIndex,
		proxyWidth: measurement.proxyWidth,
	});
	return { ...result, measurement };
}
