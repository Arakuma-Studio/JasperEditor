// Keyframed properties on the native path (S03:ENG-032, S04:RN-020, wave1 native-animated-export). Every animated
// value is sampled once per frame with the shared evaluator (`resolveLayerProps` / `evaluate`, S03:KF-010), so
// linear, Bezier, hold and spatial interpolation come out exactly as the composition draws them. The samples become
// ffmpeg per-frame expressions: a piecewise-linear fit within a tolerance (Ramer–Douglas–Peucker over the frame
// samples, chunked so that it stays O(n·chunk) on any data), written as a balanced `if(lt(K,…),…,…)` tree over the
// frame index `K = t·fps`. The expression grows with the number of fitted pieces, not with the clip length.
//
// Expressions use `t` (the frame time), never `n`: FFmpeg 7.1 numbers `n` from 1 in `scale`/`overlay` but from 0 in
// `rotate`; `t` is the frame's own timestamp in every filter.
import {
	type Animatable,
	clipContentTime,
	evaluate,
	isAnimated,
	type Rational,
	type RenderVisualClip,
	type ResolvedLayerProps,
	resolveLayerProps,
} from '@jasper/project';

/** One linear piece over frames `[a, b]` (inclusive; neighbouring pieces share their end frame). */
export type Piece = { a: number; b: number; va: number; vb: number };

/** RDP runs on chunks of at most this many frames (forced breakpoints bound the worst case). */
const CHUNK = 1024;

/**
 * Piecewise-linear fit of per-frame samples `values[0..n)` (frame index = array index) such that every sample is
 * within `tol` of the fit at its frame. Pieces start and end on samples, so a step (hold key) becomes a one-frame
 * piece and is exact at every integer frame.
 */
export function fitPieces(values: ArrayLike<number>, tol: number): Piece[] {
	const n = values.length;
	if (n === 0) return [];
	if (n === 1) return [{ a: 0, b: 0, va: values[0]!, vb: values[0]! }];
	const keep = new Uint8Array(n);
	keep[0] = 1;
	keep[n - 1] = 1;
	for (let c = CHUNK; c < n - 1; c += CHUNK) keep[c] = 1;
	const stack: [number, number][] = [];
	for (let a = 0; a < n - 1; ) {
		let b = a + 1;
		while (!keep[b]) b++;
		stack.push([a, b]);
		a = b;
	}
	while (stack.length > 0) {
		const [a, b] = stack.pop()!;
		if (b - a < 2) continue;
		const va = values[a]!;
		const s = (values[b]! - va) / (b - a);
		let worst = -1;
		let dev = tol;
		for (let k = a + 1; k < b; k++) {
			const d = Math.abs(values[k]! - (va + (k - a) * s));
			if (d > dev) {
				dev = d;
				worst = k;
			}
		}
		if (worst < 0) continue;
		keep[worst] = 1;
		stack.push([a, worst], [worst, b]);
	}
	const out: Piece[] = [];
	let a = 0;
	for (let b = 1; b < n; b++) {
		if (!keep[b]) continue;
		out.push({ a, b, va: values[a]!, vb: values[b]! });
		a = b;
	}
	return out;
}

/** The fit at frame `k` (same formula the expression evaluates). */
export function pieceValue(pieces: readonly Piece[], k: number): number {
	let lo = 0;
	let hi = pieces.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (k < pieces[mid]!.a) hi = mid - 1;
		else lo = mid;
	}
	const p = pieces[lo]!;
	return p.b === p.a ? p.va : p.va + (k - p.a) * ((p.vb - p.va) / (p.b - p.a));
}

/** Number text for ffmpeg expressions: plain decimal (no exponent), up to 9 decimals, negatives parenthesized. */
export function num(x: number): string {
	const r = Math.round(x * 1e9) / 1e9;
	if (r === 0) return '0';
	const s = r.toFixed(9).replace(/\.?0+$/, '');
	return s.startsWith('-') ? `(${s})` : s;
}

/** C `round` (half away from zero), as ffmpeg's expression evaluator does it. */
export function roundC(x: number): number {
	return Math.sign(x) * Math.floor(Math.abs(x) + 0.5);
}

/**
 * The frame index of a filter's current frame, from its timestamp: `t·num/den` plus `offset` frames. With
 * `floor`, the index steps at frame boundaries (audio blocks inside a frame take that frame's value).
 */
export function frameIndex(fps: Rational, offset = 0, floor = false, time = 't'): string {
	const k = `${time}*${fps.num}/${fps.den}`;
	const shifted = offset === 0 ? k : `${k}${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
	return floor ? `floor(${shifted}+0.001)` : shifted;
}

/**
 * ffmpeg expression of a piecewise-linear function of the frame index (`index`, see `frameIndex`). The index is
 * stored in variable 0 (`st(0,…)`), then a balanced tree of `if(lt(ld(0),a),…,…)` picks the piece. Pieces agree
 * at shared ends, so a threshold at a piece start is exact for any index rounding.
 */
export function piecewiseExpr(pieces: readonly Piece[], index: string): string {
	if (pieces.length === 0) return '0';
	const constant = pieces.every((p) => p.va === pieces[0]!.va && p.vb === pieces[0]!.va);
	if (constant) return num(pieces[0]!.va);
	const leaf = (p: Piece): string => {
		if (p.va === p.vb || p.b === p.a) return num(p.va);
		const s = (p.vb - p.va) / (p.b - p.a);
		return `${num(p.va)}+(ld(0)-${p.a})*${num(s)}`;
	};
	const tree = (lo: number, hi: number): string => {
		if (lo === hi) return leaf(pieces[lo]!);
		const mid = (lo + hi + 1) >> 1;
		return `if(lt(ld(0),${pieces[mid]!.a}),${tree(lo, mid - 1)},${tree(mid, hi)})`;
	};
	return `st(0,${index});${tree(0, pieces.length - 1)}`;
}

/**
 * Frames `[a, b)` of the runs where `test(k)` holds over `k ∈ [0, n)`, as a timeline expression
 * (`between(t,…)` per run in seconds, half a frame of margin); '' when it never holds, '1' when always.
 */
export function framesWhere(n: number, test: (k: number) => boolean, fps: Rational, offset = 0): string {
	const runs: [number, number][] = [];
	for (let k = 0; k < n; k++) {
		if (!test(k)) continue;
		const last = runs[runs.length - 1];
		if (last && last[1] === k) last[1] = k + 1;
		else runs.push([k, k + 1]);
	}
	if (runs.length === 0) return '';
	if (runs.length === 1 && runs[0]![0] === 0 && runs[0]![1] === n && offset === 0) return '1';
	// Frame k is shown at t = (k + offset)/fps; half a frame of margin on both sides.
	const sec = (k: number) => num(((k + offset) * fps.den) / fps.num);
	return runs.map(([a, b]) => `between(t,${sec(a - 0.5)},${sec(b - 0.5)})`).join('+');
}

/**
 * Fit tolerances: sizes and positions in pixels, rotation in degrees, opacity as a 0..1 factor, gain in dB. Well
 * inside S03:ENG-032 (0.25 px / 0.1°); the filters then round sizes and positions to whole pixels anyway.
 */
export const FIT_TOLERANCE = { px: 0.1, deg: 0.005, alpha: 0.001, db: 0.01 } as const;

/** True when the layer's Motion or Opacity has keyframes (the builder then samples them per frame). */
export function layerAnimated(c: Pick<RenderVisualClip, 'transform' | 'opacity'>): boolean {
	const t = c.transform;
	return (
		isAnimated(c.opacity) ||
		(!!t &&
			(isAnimated(t.position) ||
				isAnimated(t.anchor) ||
				isAnimated(t.scale) ||
				isAnimated(t.scaleWidth) ||
				isAnimated(t.rotation)))
	);
}

export type MotionStageOptions = {
	clip: RenderVisualClip;
	/** First drawn and one-past-last sequence frame of the layer; first frame of the export range. */
	f0: number;
	f1: number;
	R0: number;
	fps: Rational;
	/** The clip's props at `f0`. */
	props: ResolvedLayerProps;
	/** Frame size of the source chain (the rounded intrinsic box). */
	bw: number;
	bh: number;
	/** Sequence size (layers without Motion are centred). */
	W: number;
	H: number;
	/** Unique label prefix for the sub-graphs of this layer. */
	label: string;
	/**
	 * The source chain's pixels are opaque or transparent black (no partial alpha over colour): bilinear rotation of
	 * the straight pixels then equals that of premultiplied ones, so no premultiplication is needed.
	 */
	opaque?: boolean;
	/** Threads of the export (swscale slice threads for a per-frame resize, at most 8). */
	threads?: number;
};

/**
 * Motion and Opacity of a layer (RGBA in, one frame size out) and its overlay offset: `pre` filters, then the
 * resize (`w`/`h` option text, per frame or constant; null = none), then `post`. The builder may fold the resize
 * into the source chain's own scale to the layer box (one resample, `mergeResize`), else it uses `motionFilters`.
 */
export type MotionStage = {
	pre: string[];
	/** `threads`: swscale slice threads of a per-frame resize (each new size re-creates the scaler). */
	resize: { w: string; h: string; perFrame: boolean; threads: number } | null;
	post: string[];
	x: string;
	y: string;
};

const resizeSize = (r: NonNullable<MotionStage['resize']>) =>
	r.perFrame ? `w=${r.w}:h=${r.h}:eval=frame` : `${r.w}:${r.h}`;
const resizeThreads = (r: NonNullable<MotionStage['resize']>) =>
	r.perFrame && r.threads > 1 ? `:threads=${r.threads}` : '';

/** The stage as one filter list with a standalone (RGBA) resize. */
export function motionFilters(m: MotionStage): string[] {
	const r = m.resize;
	const resize = r ? [`scale=${resizeSize(r)}:flags=bicubic${resizeThreads(r)}`] : [];
	return [...m.pre, ...resize, ...m.post];
}

/**
 * Folds the stage's resize into the source chain's scale to the layer box (`scale=<bw>:<bh><options>` at `index`,
 * followed only by `setsar`/`format`): the flips go in front of it and it scales straight to the per-frame size.
 * Returns false (nothing changed) when the stage premultiplies before resizing.
 */
export function mergeResize(
	chain: string[],
	source: { index: number; options: string },
	m: MotionStage,
): boolean {
	if (!m.resize || m.pre.some((f) => f.startsWith('premultiply'))) return false;
	const r = m.resize;
	chain.splice(source.index, 1, ...m.pre, `scale=${resizeSize(r)}${source.options}${resizeThreads(r)}`);
	chain.push(...m.post);
	return true;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
/** Degrees in [-180, 180). */
const normDeg = (deg: number) => (((deg % 360) + 540) % 360) - 180;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const outSize = (x: number) => Math.max(1, Math.ceil(x - 1e-6));
const rate = (r: Rational) => `${r.num}/${r.den}`;

/**
 * A layer's Motion → Opacity stage (M = P + R·S·(q − A), S03:DM-010): flips → scale → rotation about the centre →
 * alpha multiply, then `overlay` at the offset that puts the picture centre at `M(centre)`. A layer without
 * keyframes is the one-sample case (constant filters and offsets). With keyframes every frame is sampled with
 * `resolveLayerProps`; sizes and positions are whole pixels:
 * - flips: before scaling, on the fixed-size source; a sign that changes per frame (an eased scale overshooting 0)
 *   becomes `hflip`/`vflip` with timeline `enable`;
 * - size: `scale` with per-frame `w`/`h` (`eval=frame`);
 * - rotation (animated, or any angle with an animated size): the premultiplied picture gets a 2 px transparent
 *   border (`pad`, `eval=frame`: `rotate` reads the edge rows for samples up to 1 px outside its input) and
 *   `rotate` with a per-frame angle draws it into one fixed frame, centre on centre (exact for any size parity);
 * - without rotation: `pad` (`eval=frame`) centres it in a fixed box; the overlay offset repeats the size
 *   expression to take the box offset's ½ px parity into account;
 * - opacity (and frames with a zero scale): the alpha is multiplied with a per-frame constant (`geq` on a 1×1
 *   stream scaled to the frame, `lut2`, `alphamerge`);
 * - position: `overlay` `x`/`y` per frame.
 */
export function motionStage(o: MotionStageOptions): MotionStage {
	const { clip: c, f0, f1, fps, bw, bh, label } = o;
	// Without keyframes one sample (frame f0) stands for every frame: constant filters and offsets.
	const n = layerAnimated(c) ? Math.max(1, f1 - f0) : 1;

	const exW = new Float64Array(n);
	const exH = new Float64Array(n);
	const deg = new Float64Array(n);
	const cx = new Float64Array(n);
	const cy = new Float64Array(n);
	const alpha = new Float64Array(n);
	const negX = new Uint8Array(n);
	const negY = new Uint8Array(n);
	for (let k = 0; k < n; k++) {
		const p = k === 0 ? o.props : resolveLayerProps(c, clipContentTime(c, f0 + k, fps));
		const tv = p.transform;
		let hidden = false;
		if (tv) {
			const sxs = ((tv.uniformScale ? tv.scale : tv.scaleWidth) / 100) * (tv.flipH ? -1 : 1);
			const sys = (tv.scale / 100) * (tv.flipV ? -1 : 1);
			exW[k] = Math.abs(sxs) * bw;
			exH[k] = Math.abs(sys) * bh;
			negX[k] = sxs < 0 ? 1 : 0;
			negY[k] = sys < 0 ? 1 : 0;
			deg[k] = tv.rotation;
			const m = p.matrix;
			cx[k] = m.a * (bw / 2) + m.c * (bh / 2) + m.e;
			cy[k] = m.b * (bw / 2) + m.d * (bh / 2) + m.f;
			// A zero scale draws nothing (the composition's matrix is singular).
			hidden = exW[k]! < 1e-9 || exH[k]! < 1e-9;
		} else {
			exW[k] = bw;
			exH[k] = bh;
			cx[k] = o.W / 2;
			cy[k] = o.H / 2;
		}
		alpha[k] = hidden ? 0 : p.opacity / 100;
	}
	const varies = (a: ArrayLike<number>) => {
		for (let k = 1; k < n; k++) if (!near(a[k]!, a[0]!)) return true;
		return false;
	};
	const pre: string[] = [];
	const filters: string[] = [];
	const layerT = frameIndex(fps);

	const sizeVar = varies(exW) || varies(exH);
	const rotVar = varies(deg);
	const deg0 = normDeg(deg[0]!);
	const quarter = near(deg0, 0) || near(deg0, 90) || near(deg0, -90) || near(Math.abs(deg0), 180);
	// Quarter turns of a fixed-size picture stay exact transposes/flips; anything else goes through `rotate`.
	const rotating = rotVar || (sizeVar ? !near(deg0, 0) : !quarter);

	const flip = (neg: Uint8Array, filter: 'hflip' | 'vflip') => {
		const all = neg.every((v) => v === neg[0]);
		if (all && !neg[0]) return;
		pre.push(all ? filter : `${filter}=enable='${framesWhere(n, (k) => neg[k] === 1, fps)}'`);
	};
	flip(negX, 'hflip');
	flip(negY, 'vflip');

	const pw = fitPieces(exW, FIT_TOLERANCE.px);
	const ph = fitPieces(exH, FIT_TOLERANCE.px);
	const sizeExpr = (pieces: Piece[], index: string) => `max(1,round(${piecewiseExpr(pieces, index)}))`;
	const sw = new Int32Array(n);
	const sh = new Int32Array(n);
	for (let k = 0; k < n; k++) {
		sw[k] = Math.max(1, roundC(pieceValue(pw, k)));
		sh[k] = Math.max(1, roundC(pieceValue(ph, k)));
	}
	const maxW = Math.max(...sw);
	const maxH = Math.max(...sh);
	// Partial alpha over colour: rotate premultiplied pixels (before the resize, on the fixed-size frames).
	if (rotating && !o.opaque) pre.push('premultiply=inplace=1');
	const resize: MotionStage['resize'] = sizeVar
		? {
				w: `'${sizeExpr(pw, layerT)}'`,
				h: `'${sizeExpr(ph, layerT)}'`,
				perFrame: true,
				threads: Math.max(1, Math.min(8, o.threads ?? 1)),
			}
		: sw[0] !== bw || sh[0] !== bh
			? { w: String(sw[0]), h: String(sh[0]), perFrame: false, threads: 1 }
			: null;

	// Rotation is clockwise about the picture centre in y-down coordinates.
	let RW: number;
	let RH: number;
	/** Overlay offset expression (main time) for one axis. */
	let offset: (axis: 'x' | 'y') => string;
	const mainT = frameIndex(fps, f0 - o.R0);
	const smooth = (v: Float64Array, extra = '') =>
		varies(v) || extra
			? `'round(${piecewiseExpr(fitPieces(v, FIT_TOLERANCE.px), mainT)}${extra})'`
			: String(roundC(v[0]!));
	if (rotating) {
		const pd = fitPieces(deg, FIT_TOLERANCE.deg);
		RW = 1;
		RH = 1;
		for (let k = 0; k < n; k++) {
			const a = rad(pieceValue(pd, k));
			const w = sw[k]! + 4;
			const h = sh[k]! + 4;
			RW = Math.max(RW, outSize(Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))));
			RH = Math.max(RH, outSize(Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a))));
		}
		const angle = rotVar ? `'(${piecewiseExpr(pd, layerT)})*PI/180'` : num(rad(deg[0]!));
		// Bilinear on premultiplied pixels (right colour at the anti-aliased edges), back to straight alpha.
		filters.push(
			sizeVar
				? 'pad=w=iw+4:h=ih+4:x=2:y=2:color=black@0:eval=frame'
				: `pad=${sw[0]! + 4}:${sh[0]! + 4}:2:2:color=black@0`,
			`rotate=a=${angle}:ow=${RW}:oh=${RH}:c=black@0`,
			'unpremultiply=inplace=1',
		);
		const ox = cx.map((v) => v - RW / 2);
		const oy = cy.map((v) => v - RH / 2);
		offset = (axis) => smooth(axis === 'x' ? ox : oy);
	} else {
		[RW, RH] = sizeVar ? [maxW, maxH] : [sw[0]!, sh[0]!];
		if (sizeVar) filters.push(`pad=w=${RW}:h=${RH}:x='(ow-iw)/2':y='(oh-ih)/2':color=black@0:eval=frame`);
		// The picture's left edge lands at floor((box − size)/2) in the box: x = round(cx − that − size/2), with
		// the size expression repeated on the overlay's clock.
		const boxOffset = (box: number, pieces: Piece[]) =>
			`-floor((${box}-st(5,${sizeExpr(pieces, mainT)}))/2)-ld(5)/2`;
		const ox = cx.map((v) => v - RW / 2);
		const oy = cy.map((v) => v - RH / 2);
		offset = (axis) =>
			sizeVar
				? smooth(axis === 'x' ? cx : cy, boxOffset(axis === 'x' ? RW : RH, axis === 'x' ? pw : ph))
				: smooth(axis === 'x' ? ox : oy);
		if (near(deg0, 90) || near(deg0, -90)) {
			filters.push(near(deg0, 90) ? 'transpose=clock' : 'transpose=cclock');
			[RW, RH] = [RH, RW];
			const tx = cx.map((v) => v - RW / 2);
			const ty = cy.map((v) => v - RH / 2);
			offset = (axis) => smooth(axis === 'x' ? tx : ty);
		} else if (near(Math.abs(deg0), 180)) filters.push('hflip', 'vflip');
	}

	if (varies(alpha)) {
		const pa = fitPieces(alpha, FIT_TOLERANCE.alpha);
		const value = piecewiseExpr(pa, frameIndex(fps, 0, false, 'T'));
		const factor =
			`color=c=white:s=1x1:r=${rate(fps)}:d=${num(((n + 1) * fps.den) / fps.num)},format=gray,` +
			`trim=end_frame=${n},geq=lum='clip(round(255*(${value})),0,255)',scale=${RW}:${RH}:flags=neighbor`;
		filters.push(alphaMultiply(`${label}op`, factor));
	} else if (alpha[0]! < 1) filters.push(`colorchannelmixer=aa=${fmt6(alpha[0]!)}`);

	return { pre, resize, post: filters, x: offset('x'), y: offset('y') };
}

/**
 * Multiplies the alpha of the chain's frames with the luma of a gray stream of the same size (`factor`: a chain
 * starting with a source filter). One element of a comma-joined chain (a sub-graph with labels `<label>a…e`).
 */
export function alphaMultiply(label: string, factor: string): string {
	const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((s) => `${label}${s}`);
	return (
		`split[${a}][${b}];[${b}]alphaextract[${c}];${factor}[${d}];` +
		`[${c}][${d}]lut2=c0='floor(x*y/255+0.5)'[${e}];[${a}][${e}]alphamerge`
	);
}

export const CROP_EDGES = ['left', 'top', 'right', 'bottom'] as const;

/**
 * A crop with keyframed edges, as one chain element: the layer's alpha × a per-frame rectangle mask. The mask is a
 * white `w × h` picture (`scale`, `eval=frame`) in the centre of a black `2bw × 2bh` frame, cut back to `bw × bh`
 * with `crop` at a per-frame offset, so the white lands on the visible rect `[l, bw − r) × [t, bh − b)` (edges in
 * whole pixels as for a static crop). Frames with nothing left show the black half only. `crop` keeps its
 * `w`/`h` for a whole stream (only `x`/`y` are per frame), hence the mask.
 */
export function cropMaskFilter(o: {
	clip: RenderVisualClip;
	effect: RenderVisualClip['effects'][number];
	f0: number;
	f1: number;
	fps: Rational;
	bw: number;
	bh: number;
	label: string;
}): string {
	const { clip: c, effect, f0, f1, fps, bw, bh } = o;
	const n = f1 - f0;
	const edge = Object.fromEntries(CROP_EDGES.map((e) => [e, new Float64Array(n)])) as Record<
		(typeof CROP_EDGES)[number],
		Float64Array
	>;
	for (let k = 0; k < n; k++) {
		const t = clipContentTime(c, f0 + k, fps);
		for (const e of CROP_EDGES) {
			const anim = effect.params[e] as Animatable<number> | undefined;
			const pct = anim ? Number(evaluate(anim, t)) : 0;
			edge[e][k] = (pct / 100) * (e === 'left' || e === 'right' ? bw : bh);
		}
	}
	const T = frameIndex(fps);
	const px = (e: (typeof CROP_EDGES)[number]) =>
		`round(${piecewiseExpr(fitPieces(edge[e], FIT_TOLERANCE.px), T)})`;
	// Visible size and offset of the white in the cut: x = bw − l (0 = nothing visible).
	const size = (full: number, a: string, b: string) => `max(1,${full}-${a}-${b})`;
	const offset = (full: number, a: string, b: string) =>
		`st(2,${a});st(3,${b});if(lte(${full}-ld(2)-ld(3),0),0,${full}-ld(2))`;
	const mask =
		`color=c=white:s=1x1:r=${rate(fps)}:d=${num(((n + 1) * fps.den) / fps.num)},format=gray,trim=end_frame=${n},` +
		`scale=w='${size(bw, px('left'), px('right'))}':h='${size(bh, px('top'), px('bottom'))}':eval=frame:flags=neighbor,` +
		`pad=w=${2 * bw}:h=${2 * bh}:x=${bw}:y=${bh}:color=black:eval=frame,` +
		`crop=w=${bw}:h=${bh}:x='${offset(bw, px('left'), px('right'))}':y='${offset(bh, px('top'), px('bottom'))}'`;
	return alphaMultiply(o.label, mask);
}

const fmt6 = (n: number) => {
	const r = Math.round(n * 1e6) / 1e6;
	return Object.is(r, -0) ? '0' : String(r);
};
