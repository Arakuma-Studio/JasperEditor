// De-judder step (S07:PST-010…014): cadence analysis, auto/force decision and the flow-warp retiming.
//
// Retiming (port of the trailer project's `grade/tools/dejudder.py`, method `flow`): with 50 fps material
// decimated to 30 fps, each 3-frame cycle holds frames at 0 / 40 / 80 ms instead of 6.7 / 40 / 73.3 ms.
// With `shortPhase = p` (the step INTO frame n is short when n % 3 == p) and q = (n − p) mod 3:
//   q = 0 (arrived through the short step) → warped `shift` of the way towards the NEXT frame,
//   q = 1 (anchor)                         → passed through untouched,
//   q = 2                                  → warped `shift` of the way back towards the PREVIOUS frame.
// Each warp moves only the frame itself along the flow to its neighbour (never a blend: no ghosting).
// One frame in, one frame out; frames whose needed neighbour lies across a scene cut are copied. At the input
// edges a processed RANGE gets its neighbours from the source (M3, PST-013): the runner hands the step a
// context fetcher (`setRangeContext`) that decodes the source frame just before / after the range through the
// same head filters; those frames are used for the flow only and never emitted. Without context (whole files,
// the very start/end of the source, a frame step ahead of de-judder) edge frames are copied.
import type { ProcessStep } from '@jasper/project';
import type { DecodeSpec, FrameStep, RgbFrame, StepContext } from '../types.ts';
import { ANALYSIS_MAX_WIDTH, analyseCadence, type CadenceResult } from './cadence.ts';
import { CvPool, type FlowParams } from './pool.ts';

export type DejudderStepSpec = Extract<ProcessStep, { op: 'dejudder' }>;

/** PST-012 thresholds for `auto`. */
export const DEJUDDER_THRESHOLDS = {
	minConsistency: 0.8,
	maxShortToLong: 0.8,
	minMovingShare: 0.3,
	minMeanMotionPx1080p: 4,
} as const;

/** Scene-cut guard (PST-013): mean absolute difference on a sub-sampled grid, 0..1. */
export const CUT_THRESHOLD = 0.1;
const CUT_GRID = 8;

export const DEFAULT_SHIFT = 1 / 6;

/**
 * Warp flow defaults (Farnebäck; OpenCV.js has no DIS). Tuned with validate.ts-style experiments on
 * crudo.mp4 37–40 s (848×480): flow on a 480 px proxy with a σ = 4 px smoothing gave the lowest t = 1 warp
 * error on real pairs and on synthetic translations, removed the ≈1 px waviness that full-resolution
 * Farnebäck flow put on straight edges in flat areas, and costs ~0.1 s per warp (one worker).
 */
export const DEFAULT_FLOW: FlowParams = {
	maxWidth: 480,
	pyrScale: 0.5,
	levels: 4,
	winsize: 15,
	iterations: 3,
	polyN: 5,
	polySigma: 1.1,
	gaussian: false,
	smoothSigma: 4,
};

export type DejudderDecision = {
	apply: boolean;
	/** Human-readable reason (job note). */
	reason: string;
};

const pct = (x: number) => `${Math.round(x * 100)} %`;
const fix = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

/** PST-012: whether to retime, given the analysis. `force` skips the thresholds but needs a phase. */
export function decideDejudder(r: CadenceResult, mode: 'auto' | 'force'): DejudderDecision {
	const t = DEJUDDER_THRESHOLDS;
	if (r.shortPhase === null)
		return {
			apply: false,
			reason: 'dejudder: no cadence found (too little motion to measure), frames copied',
		};
	const found = `short phase ${r.shortPhase}, short/long ${fix(r.shortToLongRatio)}, consistency ${pct(
		Number.isFinite(r.consistency) ? r.consistency : 0,
	)}, motion ${fix(r.meanMotionPx1080p, 1)} px/frame@1080p, moving ${pct(r.movingShare)}`;
	if (mode === 'force') return { apply: true, reason: `dejudder: forced (${found}), frames retimed` };
	const fail: string[] = [];
	if (!(r.consistency >= t.minConsistency)) fail.push(`consistency ${pct(r.consistency || 0)} < 80 %`);
	if (!(r.shortToLongRatio < t.maxShortToLong)) fail.push(`short/long ${fix(r.shortToLongRatio)} ≥ 0.80`);
	if (fail.length)
		return { apply: false, reason: `dejudder: no cadence found (${fail.join(', ')}), frames copied` };
	if (r.movingShare < t.minMovingShare) fail.push(`moving pairs ${pct(r.movingShare)} < 30 %`);
	if (r.meanMotionPx1080p < t.minMeanMotionPx1080p)
		fail.push(`mean motion ${fix(r.meanMotionPx1080p, 1)} < 4 px/frame@1080p`);
	if (fail.length)
		return {
			apply: false,
			reason: `dejudder: cadence found but too little motion (${fail.join(', ')}), frames copied`,
		};
	return { apply: true, reason: `dejudder: uneven cadence found (${found}), frames retimed` };
}

/** Mean of R+G+B over each CUT_GRID×CUT_GRID cell (edge cells partial), as 0..3·65535 sums per pixel. */
export function cellMeans(f: RgbFrame): Float64Array {
	const { width: w, height: h, data } = f;
	const cw = Math.ceil(w / CUT_GRID);
	const ch = Math.ceil(h / CUT_GRID);
	const sum = new Float64Array(cw * ch);
	const cnt = new Float64Array(cw * ch);
	for (let y = 0; y < h; y++) {
		const row = ((y / CUT_GRID) | 0) * cw;
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 3;
			const c = row + ((x / CUT_GRID) | 0);
			sum[c] += data[i] + data[i + 1] + data[i + 2];
			cnt[c]++;
		}
	}
	for (let c = 0; c < sum.length; c++) sum[c] /= cnt[c];
	return sum;
}

/**
 * Scene-cut guard (PST-013): mean |Δ| of the 8×8-cell means (R+G+B), normalised to 0..1, above `threshold`.
 * Cell *means* rather than single sampled pixels (the trailer's `a[::8, ::8]`): point samples measure texture
 * contrast as soon as fine detail moves a few pixels, so a fast pan over a high-frequency texture sat right at
 * 0.10 (0.09–0.10) and, depending on the encoder of the very same pan, 16 of 60 frames were mistaken for cuts and
 * copied. With cell means a 12 px/frame noise-texture pan measures ≈ 0.06, real shot changes on crudo.mp4
 * 0.20–0.31 and fast real motion ≤ 0.09.
 */
export function isCut(a: RgbFrame, b: RgbFrame, threshold = CUT_THRESHOLD): boolean {
	return cutScore(cellMeans(a), cellMeans(b)) > threshold;
}

/** The scene-cut measure of two frames' cell means (`cellMeans` / `greyCellMeans`): mean |Δ|, 0..1. */
export function cutScore(ma: Float64Array, mb: Float64Array): number {
	if (!ma.length || ma.length !== mb.length) return 0;
	let sum = 0;
	for (let c = 0; c < ma.length; c++) sum += Math.abs(ma[c] - mb[c]);
	return sum / (ma.length * 3 * 65535);
}

/**
 * `cellMeans` of an 8-bit grey frame on the same scale (a grey pixel v counts as R = G = B = 257·v), so the
 * smooth-path analysis (PST-005), which only decodes luma, uses the very same cut guard and threshold.
 */
export function greyCellMeans(grey: Uint8Array, w: number, h: number): Float64Array {
	const cw = Math.ceil(w / CUT_GRID);
	const ch = Math.ceil(h / CUT_GRID);
	const sum = new Float64Array(cw * ch);
	const cnt = new Float64Array(cw * ch);
	for (let y = 0; y < h; y++) {
		const row = ((y / CUT_GRID) | 0) * cw;
		for (let x = 0; x < w; x++) {
			const c = row + ((x / CUT_GRID) | 0);
			sum[c] += 3 * 257 * grey[y * w + x];
			cnt[c]++;
		}
	}
	for (let c = 0; c < sum.length; c++) sum[c] /= cnt[c];
	return sum;
}

export type DejudderStepOptions = {
	/** Absolute index of the first input frame (phase reference when a sub-range is processed). Default 0. */
	firstFrameIndex?: number;
	/** Worker script (default `resolveWorkerUrl()`). */
	workerUrl?: URL;
	/** Warp flow parameters (merged over `DEFAULT_FLOW`). */
	flow?: Partial<FlowParams>;
	/** Analysis proxy width (default 424). */
	analysisMaxWidth?: number;
	/** Use this cadence instead of analysing (tests / re-runs); still subject to the auto/force decision. */
	cadence?: CadenceResult;
	/** Frames in flight per worker (default 2). */
	inFlightPerWorker?: number;
};

export type DejudderStats = {
	copied: number;
	interpolated: number;
	cutGuard: number;
	edge: number;
	/** Edge frames retimed with a context frame read from outside the processed range (PST-013). */
	context: number;
};

/**
 * Context frames outside the processed input (PST-013): `-1` = the source frame just before the first input
 * frame, `frames` = the one just after the last; null when the source has none.
 */
export type RangeContextFetcher = (relativeIndex: number) => Promise<RgbFrame | null>;

export type DejudderFrameStep = FrameStep & {
	readonly cadence: CadenceResult | null;
	readonly decision: DejudderDecision | null;
	readonly stats: DejudderStats;
	/** Called by the runner before `open` when a range of a source is processed (PST-013). */
	setRangeContext(fetch: RangeContextFetcher): void;
};

const mod3 = (n: number) => ((n % 3) + 3) % 3;
const jsonNum = (x: number) => (Number.isFinite(x) ? x : null);

/** The de-judder FrameStep (PST-010…014). */
export function createDejudderStep(
	step: DejudderStepSpec,
	opts: DejudderStepOptions = {},
): DejudderFrameStep {
	const shift = step.shift ?? DEFAULT_SHIFT;
	if (!(shift > 0 && shift < 0.5)) throw new Error(`dejudder: shift must be in (0, 0.5), got ${shift}`);
	const flow: FlowParams = { ...DEFAULT_FLOW, ...opts.flow };
	const first = opts.firstFrameIndex ?? 0;
	const stats: DejudderStats = { copied: 0, interpolated: 0, cutGuard: 0, edge: 0, context: 0 };
	let fetchContext: RangeContextFetcher | null = null;
	let ctx: StepContext | null = null;
	let pool: CvPool | null = null;
	let cadence: CadenceResult | null = opts.cadence ?? null;
	let decision: DejudderDecision | null = null;
	let phase = 0;
	let prev: RgbFrame | null = null;
	let cur: RgbFrame | null = null;
	const queue: { promise: Promise<RgbFrame>; settled: boolean }[] = [];
	/** Wall clock of the retiming pass: first push → end (includes decoding upstream, as a job would see it). */
	let firstPushAt = 0;
	let processMs = 0;
	let frames = 0;

	const getPool = async (c: StepContext) => {
		pool ??= await CvPool.create(Math.max(1, c.threads), opts.workerUrl);
		return pool;
	};

	const closePool = async () => {
		const p = pool;
		pool = null;
		await p?.close();
	};

	const decide = (c: StepContext) => {
		if (decision) return;
		if (!cadence) {
			decision = { apply: false, reason: 'dejudder: cadence was not analysed, frames copied' };
		} else {
			decision = decideDejudder(cadence, step.mode);
			if (cadence.shortPhase !== null) phase = cadence.shortPhase;
		}
		c.note(decision.reason);
		c.info('applied', decision.apply);
		c.info('mode', step.mode);
		c.info('shift', shift);
		if (cadence) {
			c.info('phase', cadence.shortPhase);
			c.info('ratio', jsonNum(cadence.shortToLongRatio));
			c.info('consistency', jsonNum(cadence.consistency));
			c.info('meanMotionPx1080p', jsonNum(cadence.meanMotionPx1080p));
			c.info('movingShare', jsonNum(cadence.movingShare));
			c.info('relStepByPhase', cadence.relStepByPhase.map(jsonNum));
			c.info('firstFrameIndex', cadence.firstFrameIndex);
		}
	};

	const warpFrame = async (near: RgbFrame, far: RgbFrame): Promise<RgbFrame> => {
		if (!pool) throw new Error('dejudder: worker pool is not running');
		const data = await pool.warp(near.width, near.height, near.data, far.data, shift, flow);
		return { index: near.index, width: near.width, height: near.height, data };
	};

	/**
	 * Output for `c` given its neighbours (null only at the input edges, where the source context — the frame
	 * before the first / after the last input frame — is read when a range is processed).
	 */
	const emit = async (p: RgbFrame | null, c: RgbFrame, n: RgbFrame | null): Promise<RgbFrame> => {
		const q = mod3(first + c.index - phase);
		if (q === 1) {
			stats.copied++;
			return c;
		}
		let other = q === 0 ? n : p;
		let fromContext = false;
		if (!other && fetchContext) {
			other = await fetchContext(q === 0 ? c.index + 1 : c.index - 1);
			fromContext = !!other;
		}
		if (!other) {
			stats.edge++;
			return c;
		}
		if (isCut(c, other)) {
			stats.cutGuard++;
			return c;
		}
		stats.interpolated++;
		if (fromContext) stats.context++;
		return warpFrame(c, other);
	};

	const submit = (promise: Promise<RgbFrame>) => {
		const item = { promise, settled: false };
		promise.then(
			() => {
				item.settled = true;
			},
			() => {
				item.settled = true;
			},
		);
		queue.push(item);
	};

	/** Pops finished frames in order; waits while more than `limit` are in flight. */
	const drain = async (limit: number): Promise<RgbFrame[]> => {
		const out: RgbFrame[] = [];
		while (queue.length && (queue[0].settled || queue.length > limit)) {
			out.push(await queue.shift()!.promise);
		}
		return out;
	};

	const limit = () => Math.max(2, (pool?.size ?? 1) * (opts.inFlightPerWorker ?? 2));

	const report = (c: StepContext) => {
		c.info('copied', stats.copied);
		c.info('interpolated', stats.interpolated);
		c.info('cutGuard', stats.cutGuard);
		c.info('edge', stats.edge);
		c.info('contextFrames', stats.context);
		c.info('secondsPerFrame', frames ? processMs / 1000 / frames : 0);
	};

	return {
		name: 'dejudder',
		get cadence() {
			return cadence;
		},
		get decision() {
			return decision;
		},
		stats,

		setRangeContext(fetch: RangeContextFetcher) {
			fetchContext = fetch;
		},

		async analyse(input: DecodeSpec, c: StepContext): Promise<void> {
			ctx = c;
			if (cadence) return;
			const t0 = performance.now();
			const p = await getPool(c);
			cadence = await analyseCadence(input, p, {
				firstFrameIndex: first,
				maxWidth: opts.analysisMaxWidth ?? ANALYSIS_MAX_WIDTH,
				signal: c.signal,
				onProgress: (f) => c.analysisProgress(f),
			});
			// Keep the measurement out of the sidecar; only the summary is reported.
			const { measurement: _m, ...summary } = cadence as CadenceResult & { measurement?: unknown };
			cadence = summary;
			c.info('analysisSeconds', (performance.now() - t0) / 1000);
			decide(c);
			if (!decision!.apply) await closePool();
		},

		async open(c: StepContext) {
			ctx = c;
			decide(c);
			if (decision!.apply) await getPool(c);
			c.signal.addEventListener('abort', () => void closePool(), { once: true });
			return { width: c.width, height: c.height };
		},

		async push(frame: RgbFrame): Promise<RgbFrame[]> {
			frames++;
			if (!decision?.apply) {
				stats.copied++;
				return [frame];
			}
			if (!firstPushAt) firstPushAt = performance.now();
			if (cur) submit(emit(prev, cur, frame));
			prev = cur;
			cur = frame;
			return drain(limit());
		},

		async end(): Promise<RgbFrame[]> {
			let out: RgbFrame[] = [];
			if (decision?.apply) {
				if (cur) submit(emit(prev, cur, null));
				prev = cur = null;
				out = await drain(0);
			}
			if (firstPushAt) processMs = performance.now() - firstPushAt;
			if (ctx) report(ctx);
			await closePool();
			return out;
		},

		async close() {
			queue.length = 0;
			await closePool();
		},
	};
}
