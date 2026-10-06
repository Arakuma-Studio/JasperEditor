// Roto segmentation and propagation (Roto Brush), ported from EffectCraft `crates/track/src/roto/mod.rs` and
// `refine.rs` (MIT OR Apache-2.0, licenses/ported/roto.md), clean-room from published methods:
//
// - Interactive graph cuts (Y. Boykov and M.-P. Jolly, ICCV 2001): foreground / background strokes are hard
//   constraints, every other pixel gets a data cost from colour models and neighbouring pixels a contrast-sensitive
//   smoothness cost; the minimum s–t cut (`maxflow.ts`, Boykov–Kolmogorov) is the segmentation.
// - Iterated colour models (GrabCut, Rother et al., SIGGRAPH 2004): Gaussian mixtures (`gmm.ts`) fitted to the strokes,
//   re-fitted to the segmentation and the cut repeated; the 8-connected n-link weight is γ/dist · exp(−β‖Iₚ − I_q‖²)
//   with β = 1 / (2⟨‖Iₚ − I_q‖²⟩). A box prompt is GrabCut's rectangle: outside is hard background.
// - Coarse to fine (Lombaert et al., ICCV 2005): large frames are segmented at a reduced size, then re-cut at full
//   resolution in a narrow band around the upsampled boundary.
// - Propagation (in the spirit of Video SnapCut, Bai et al., SIGGRAPH 2009): the previous frame's matte is warped to
//   the next frame by dense optical flow (Farnebäck, computed by the caller), and the frame re-segmented by graph cut
//   only in a band of Search Radius pixels around the warped boundary, with the previous colour models and the warped
//   matte as a shape prior. Strokes on a frame re-cut the whole frame with the warped matte as a soft prior.
// - A trained model (SAM 2.1, `sam.ts`) prompted with the strokes / box / warped matte gives a foreground probability
//   that becomes a strong prior for the same cut, so strokes stay hard constraints and edges still snap to colour.
//   A model that fails, or whose mask disagrees with the flow (IoU < 0.5), is ignored for that frame.
//
// Everything here is synchronous, deterministic and runs in the roto worker thread. Images are straight RGB
// Float32Array triples (0..1) at the matte resolution; strokes are in matte pixels (callers scale media px).

import { type Gmm, gmmCost, gmmFit } from './gmm.ts';
import { closedForm, distance, gauss, guidedFilter, sample, signedDistance } from './matting.ts';
import { Graph, SOURCE } from './maxflow.ts';

export type StrokeKind = 'fg' | 'bg' | 'refine' | 'refineErase';

/** A stroke: a polyline swept by a disc of `radius` (matte px). */
export type Stroke = { kind: StrokeKind; radius: number; points: readonly (readonly [number, number])[] };

/** A box prompt [x0, y0, x1, y1] (matte px): GrabCut's rectangle. */
export type Box = readonly [number, number, number, number];

/** Segmentation settings (matte px). */
export type SegOpts = {
	/** Search Radius: the band re-cut by propagation. */
	searchRadius: number;
	/** Motion Threshold / Motion Damping, percent. */
	motionThreshold: number;
	motionDamping: number;
	/** Quality ▸ Best: higher working resolution, one more GrabCut iteration. */
	best: boolean;
};

export const DEFAULT_SEG_OPTS: SegOpts = {
	searchRadius: 15,
	motionThreshold: 10,
	motionDamping: 20,
	best: false,
};

/** One frame's segmentation: binary matte, Refine Edge band and colour models. */
export type FrameSeg = { w: number; h: number; matte: Uint8Array; refine: Uint8Array; fg: Gmm; bg: Gmm };

/** What a frame is segmented with besides its strokes: the matte propagated from its neighbour (or a model's). */
export type Prior = { soft: Float32Array; fg: Gmm; bg: Gmm; refine: Uint8Array; weight: number };

/** A trained mask model (SAM): foreground probability (0..1, w·h) for a prompt, or null when it fails. */
export type MaskModel = {
	id: string;
	segment(
		rgb: Float32Array,
		w: number,
		h: number,
		prompt: ModelPrompt,
	): Promise<Float32Array | null> | Float32Array | null;
};
export type ModelPrompt = {
	points: { x: number; y: number; fg: boolean }[];
	box: Box | null;
	/** A soft prior mask (w·h), used by models that take one; the rest ignore it. */
	mask: Float32Array | null;
};

const HARD_FG = 1;
const HARD_BG = 2;
/** Graph-cut energy weights. */
const GAMMA = 50;
const PRIOR = 1;
/** A trained model's matte as a prior: it outweighs the colour models. */
export const MODEL_PRIOR = 4;
/** Fixed-point scale of the energies. */
const K = 16;
const INF = 2 ** 40;
const COMPONENTS = 5;
const MAX_SAMPLES = 24_000;

/** 8-neighbourhood: dx, dy, forward (each undirected edge added once from its forward end). */
const NB: readonly (readonly [number, number, boolean])[] = [
	[1, 0, true],
	[0, 1, true],
	[1, 1, true],
	[-1, 1, true],
	[-1, 0, false],
	[0, -1, false],
	[-1, -1, false],
	[1, -1, false],
];

export function emptySeg(w: number, h: number): FrameSeg {
	return {
		w,
		h,
		matte: new Uint8Array(w * h),
		refine: new Uint8Array(w * h),
		fg: { comps: [] },
		bg: { comps: [] },
	};
}

/** Pixels covered by `strokes` of the given kinds (1 = covered). */
export function rasterize(
	strokes: readonly Stroke[],
	kinds: readonly StrokeKind[],
	w: number,
	h: number,
): Uint8Array {
	const m = new Uint8Array(w * h);
	for (const s of strokes) {
		if (!kinds.includes(s.kind) || s.points.length === 0) continue;
		const r = Math.max(0.5, s.radius);
		const pts = s.points;
		const segs: [readonly [number, number], readonly [number, number]][] =
			pts.length === 1 ? [[pts[0]!, pts[0]!]] : pts.slice(1).map((p, i) => [pts[i]!, p]);
		for (const [a, b] of segs) {
			const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - r));
			const x1 = Math.min(w, Math.ceil(Math.max(a[0], b[0]) + r));
			const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - r));
			const y1 = Math.min(h, Math.ceil(Math.max(a[1], b[1]) + r));
			const dx = b[0] - a[0];
			const dy = b[1] - a[1];
			const l2 = dx * dx + dy * dy;
			for (let y = y0; y < y1; y++)
				for (let x = x0; x < x1; x++) {
					const px = x + 0.5;
					const py = y + 0.5;
					const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
					if (Math.hypot(px - (a[0] + dx * t), py - (a[1] + dy * t)) <= r) m[y * w + x] = 1;
				}
		}
	}
	return m;
}

function beta(img: Float32Array, free: Uint8Array, w: number, h: number): number {
	let s = 0;
	let n = 0;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (!free[i]) continue;
			for (const [dx, dy] of [
				[1, 0],
				[0, 1],
			] as const) {
				const nx = x + dx;
				const ny = y + dy;
				if (nx < w && ny < h) {
					const j = ny * w + nx;
					const a = img[i * 3]! - img[j * 3]!;
					const b = img[i * 3 + 1]! - img[j * 3 + 1]!;
					const c = img[i * 3 + 2]! - img[j * 3 + 2]!;
					s += a * a + b * b + c * c;
					n++;
				}
			}
		}
	return s <= 1e-12 ? 1 : n / (2 * s);
}

/**
 * One min-cut over the `free` pixels; others keep `labels`. `prior`: P(foreground) per pixel and its weight against
 * the colour models.
 */
function cut(
	img: Float32Array,
	w: number,
	h: number,
	labels: Uint8Array,
	free: Uint8Array,
	hard: Uint8Array,
	fg: Gmm,
	bg: Gmm,
	prior: { p: Float32Array; weight: number } | null,
): void {
	const n = w * h;
	const idx = new Int32Array(n).fill(-1);
	let count = 0;
	for (let i = 0; i < n; i++) if (free[i]) idx[i] = count++;
	if (count === 0) return;
	const nodes = new Int32Array(count);
	for (let i = 0; i < n; i++) if (idx[i]! >= 0) nodes[idx[i]!] = i;
	const b = beta(img, free, w, h);
	const g = new Graph(count, count * 4);
	for (let k = 0; k < count; k++) {
		const i = nodes[k]!;
		const x = i % w;
		const y = (i / w) | 0;
		const r = img[i * 3]!;
		const gg = img[i * 3 + 1]!;
		const bb = img[i * 3 + 2]!;
		let cf = gmmCost(fg, r, gg, bb);
		let cb = gmmCost(bg, r, gg, bb);
		if (prior) {
			const pf = Math.min(0.98, Math.max(0.02, prior.p[i]!));
			cf += prior.weight * -Math.log(pf);
			cb += prior.weight * -Math.log(1 - pf);
		}
		const m = Math.min(cf, cb);
		let src = Math.round((cb - m) * K);
		let snk = Math.round((cf - m) * K);
		if (hard[i] === HARD_FG) {
			src = INF;
			snk = 0;
		} else if (hard[i] === HARD_BG) {
			src = 0;
			snk = INF;
		}
		g.addTWeights(k, src, snk);
		for (const [dx, dy, fwd] of NB) {
			const nx = x + dx;
			const ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
			const j = ny * w + nx;
			const a = r - img[j * 3]!;
			const c = gg - img[j * 3 + 1]!;
			const d = bb - img[j * 3 + 2]!;
			const d2 = a * a + c * c + d * d;
			const dist = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
			const wt = Math.round((GAMMA / dist) * Math.exp(-b * d2) * K);
			if (wt <= 0) continue;
			const nj = idx[j]!;
			if (nj < 0) {
				// Fixed neighbour: disagreeing with it costs the edge.
				if (labels[j]) g.addTWeights(k, wt, 0);
				else g.addTWeights(k, 0, wt);
			} else if (fwd) g.addEdge(k, nj, wt, wt);
		}
	}
	g.maxflow();
	for (let k = 0; k < count; k++) labels[nodes[k]!] = g.segment(k) === SOURCE ? 1 : 0;
}

/** Colour samples (RGB triples) of the pixels where `sel` holds. */
function samples(img: Float32Array, n: number, sel: (i: number) => boolean): Float32Array {
	let c = 0;
	for (let i = 0; i < n; i++) if (sel(i)) c++;
	const out = new Float32Array(c * 3);
	let k = 0;
	for (let i = 0; i < n; i++)
		if (sel(i)) {
			out[k++] = img[i * 3]!;
			out[k++] = img[i * 3 + 1]!;
			out[k++] = img[i * 3 + 2]!;
		}
	return out;
}

function fitModels(img: Float32Array, labels: Uint8Array): { fg: Gmm; bg: Gmm } {
	const n = labels.length;
	return {
		fg: gmmFit(
			samples(img, n, (i) => labels[i] !== 0),
			COMPONENTS,
			MAX_SAMPLES,
		),
		bg: gmmFit(
			samples(img, n, (i) => labels[i] === 0),
			COMPONENTS,
			MAX_SAMPLES,
		),
	};
}

/**
 * Keeps the foreground components (8-connected) that touch `seeds`; fills background holes smaller than 2 % of the
 * foreground that touch neither the frame edge nor a background seed.
 */
export function clean(
	labels: Uint8Array,
	seeds: Uint8Array,
	bgSeeds: Uint8Array,
	w: number,
	h: number,
): void {
	const n = w * h;
	const comp = new Int32Array(n).fill(-1);
	const HOLE = -2;
	const stack: number[] = [];
	let fgArea = 0;
	const members: number[] = [];
	for (let start = 0; start < n; start++) {
		if (comp[start] !== -1) continue;
		const lab = labels[start]!;
		comp[start] = start;
		stack.push(start);
		members.length = 0;
		let seeded = false;
		let edge = false;
		let bgs = false;
		while (stack.length) {
			const i = stack.pop()!;
			members.push(i);
			if (seeds[i]) seeded = true;
			if (bgSeeds[i]) bgs = true;
			const x = i % w;
			const y = (i / w) | 0;
			if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
			for (const [dx, dy] of NB) {
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
				const j = ny * w + nx;
				if (comp[j] === -1 && labels[j] === lab) {
					comp[j] = start;
					stack.push(j);
				}
			}
		}
		if (lab !== 0) {
			if (seeded) fgArea += members.length;
			else for (const i of members) labels[i] = 0;
		} else if (!edge && !bgs) for (const i of members) comp[i] = HOLE;
	}
	// Fill holes smaller than 2 % of the foreground.
	const seen = new Uint8Array(n);
	for (let start = 0; start < n; start++) {
		if (comp[start] !== HOLE || seen[start] || labels[start] !== 0) continue;
		const hole = [start];
		seen[start] = 1;
		for (let k = 0; k < hole.length; k++) {
			const i = hole[k]!;
			const x = i % w;
			const y = (i / w) | 0;
			for (const [dx, dy] of NB) {
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
				const j = ny * w + nx;
				if (!seen[j] && comp[j] === HOLE && labels[j] === 0) {
					seen[j] = 1;
					hole.push(j);
				}
			}
		}
		// A hole is enclosed by foreground that survived the component filter.
		const enclosed = hole.every((i) => {
			const x = i % w;
			const y = (i / w) | 0;
			return NB.every(([dx, dy]) => {
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h) return false;
				const j = ny * w + nx;
				return labels[j] !== 0 || comp[j] === HOLE;
			});
		});
		if (enclosed && hole.length < 0.02 * fgArea) for (const i of hole) labels[i] = 1;
	}
}

function downsampleRgb(img: Float32Array, w: number, h: number, f: number) {
	const cw = Math.ceil(w / f);
	const ch = Math.ceil(h / f);
	const out = new Float32Array(cw * ch * 3);
	for (let cy = 0; cy < ch; cy++)
		for (let cx = 0; cx < cw; cx++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;
			for (let y = cy * f; y < Math.min((cy + 1) * f, h); y++)
				for (let x = cx * f; x < Math.min((cx + 1) * f, w); x++) {
					const i = (y * w + x) * 3;
					r += img[i]!;
					g += img[i + 1]!;
					b += img[i + 2]!;
					n++;
				}
			const o = (cy * cw + cx) * 3;
			out[o] = r / n;
			out[o + 1] = g / n;
			out[o + 2] = b / n;
		}
	return { img: out, w: cw, h: ch };
}

/** Pixels deep inside a soft matte (more than `r` from its edge), else the matte itself. */
function coreOf(soft: Float32Array, w: number, h: number, r: number): Uint8Array {
	const n = w * h;
	const bin = new Uint8Array(n);
	for (let i = 0; i < n; i++) bin[i] = soft[i]! >= 0.5 ? 1 : 0;
	const sd = signedDistance(bin, w, h);
	const core = new Uint8Array(n);
	let any = false;
	for (let i = 0; i < n; i++)
		if (sd[i]! > r) {
			core[i] = 1;
			any = true;
		}
	return any ? core : bin;
}

/** The hard constraints of a frame: 1 = foreground, 2 = background (background strokes win; outside a box = bg). */
function hardOf(fgs: Uint8Array, bgs: Uint8Array, box: Box | null, w: number, h: number): Uint8Array {
	const n = w * h;
	const hard = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		if (bgs[i]) hard[i] = HARD_BG;
		else if (fgs[i]) hard[i] = HARD_FG;
		else if (box) {
			const x = (i % w) + 0.5;
			const y = ((i / w) | 0) + 0.5;
			if (x < box[0] || y < box[1] || x > box[2] || y > box[3]) hard[i] = HARD_BG;
		}
	}
	return hard;
}

/**
 * Segments a frame from its strokes / box (and a propagated or model prior): GrabCut iterations on a reduced copy,
 * then a full-resolution cut in a band around the boundary.
 */
export function segment(
	img: Float32Array,
	w: number,
	h: number,
	strokes: readonly Stroke[],
	box: Box | null,
	prior: Prior | null,
	opts: SegOpts,
	refineRadius: number,
): FrameSeg {
	if (w === 0 || h === 0) return emptySeg(w, h);
	const n = w * h;
	const fgs = rasterize(strokes, ['fg'], w, h);
	const bgs = rasterize(strokes, ['bg'], w, h);
	const hard = hardOf(fgs, bgs, box, w, h);
	// A warped matte is uncertain by about the search radius: blur it. A model's matte is not.
	const softPrior = prior
		? prior.weight > PRIOR
			? prior.soft
			: gauss(prior.soft, w, h, Math.max(1, opts.searchRadius / 4))
		: null;
	const pw = prior?.weight ?? PRIOR;
	// Initial colour models: the strokes (and the prior / box).
	let fgm: Gmm;
	let bgm: Gmm;
	if (prior) {
		const f = gmmFit(
			samples(img, n, (i) => hard[i] === HARD_FG || (hard[i] === 0 && prior.soft[i]! >= 0.5)),
			COMPONENTS,
			MAX_SAMPLES,
		);
		const b = gmmFit(
			samples(img, n, (i) => hard[i] === HARD_BG || (hard[i] === 0 && prior.soft[i]! < 0.5)),
			COMPONENTS,
			MAX_SAMPLES,
		);
		fgm = f.comps.length ? f : prior.fg;
		bgm = b.comps.length ? b : prior.bg;
	} else {
		let fgc = samples(img, n, (i) => hard[i] === HARD_FG);
		if (fgc.length === 0 && box) fgc = samples(img, n, (i) => hard[i] === 0);
		let bgc = samples(img, n, (i) => hard[i] === HARD_BG);
		if (bgc.length === 0) {
			// No background strokes: what is far from the foreground strokes.
			const d = distance(fgs, w, h);
			let rmax = 1;
			for (const s of strokes) if (s.kind === 'fg') rmax = Math.max(rmax, s.radius);
			const far = Math.max(4 * rmax, 0.25 * Math.max(w, h));
			bgc = samples(img, n, (i) => d[i]! > far);
			if (bgc.length === 0) bgc = samples(img, n, (i) => hard[i] !== HARD_FG);
		}
		fgm = gmmFit(fgc, COMPONENTS, MAX_SAMPLES);
		bgm = gmmFit(bgc, COMPONENTS, MAX_SAMPLES);
	}
	const iters = opts.best ? 4 : 3;
	const work = opts.best ? 960 : 480;
	const f = Math.max(1, Math.ceil(Math.max(w, h) / work));
	const labels = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		if (hard[i]) labels[i] = hard[i] === HARD_FG ? 1 : 0;
		else if (softPrior) labels[i] = softPrior[i]! >= 0.5 ? 1 : 0;
		else labels[i] = fgs[i] || (box && !hard[i]) ? 1 : 0;
	}
	const priorArg = softPrior ? { p: softPrior, weight: pw } : null;
	if (f > 1) {
		const c = downsampleRgb(img, w, h, f);
		const cn = c.w * c.h;
		const chard = new Uint8Array(cn);
		const cprior = softPrior ? new Float32Array(cn) : null;
		const clabels = new Uint8Array(cn);
		for (let cy = 0; cy < c.h; cy++)
			for (let cx = 0; cx < c.w; cx++) {
				let anyF = false;
				let anyB = false;
				let s = 0;
				let lab = 0;
				let cnt = 0;
				for (let y = cy * f; y < Math.min((cy + 1) * f, h); y++)
					for (let x = cx * f; x < Math.min((cx + 1) * f, w); x++) {
						const i = y * w + x;
						if (hard[i] === HARD_FG) anyF = true;
						if (hard[i] === HARD_BG) anyB = true;
						if (softPrior) s += softPrior[i]!;
						lab += labels[i]!;
						cnt++;
					}
				const ci = cy * c.w + cx;
				chard[ci] = anyF && !anyB ? HARD_FG : anyB && !anyF ? HARD_BG : 0;
				if (cprior) cprior[ci] = s / cnt;
				clabels[ci] = cprior ? (cprior[ci]! >= 0.5 ? 1 : 0) : chard[ci] === HARD_FG || lab * 2 > cnt ? 1 : 0;
			}
		const free = new Uint8Array(cn).fill(1);
		for (let it = 0; it < iters; it++) {
			cut(c.img, c.w, c.h, clabels, free, chard, fgm, bgm, cprior ? { p: cprior, weight: pw } : null);
			if (it + 1 < iters) {
				const m = fitModels(c.img, clabels);
				if (m.fg.comps.length && m.bg.comps.length) {
					fgm = m.fg;
					bgm = m.bg;
				}
			}
		}
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const i = y * w + x;
				labels[i] = hard[i] ? (hard[i] === HARD_FG ? 1 : 0) : clabels[((y / f) | 0) * c.w + ((x / f) | 0)]!;
			}
		const m = fitModels(img, labels);
		if (m.fg.comps.length && m.bg.comps.length) {
			fgm = m.fg;
			bgm = m.bg;
		}
		// Full-resolution band.
		const sd = signedDistance(labels, w, h);
		const band = f + 1.5;
		const bandFree = new Uint8Array(n);
		for (let i = 0; i < n; i++) bandFree[i] = Math.abs(sd[i]!) <= band ? 1 : 0;
		cut(img, w, h, labels, bandFree, hard, fgm, bgm, priorArg);
	} else {
		const free = new Uint8Array(n).fill(1);
		for (let it = 0; it < iters; it++) {
			cut(img, w, h, labels, free, hard, fgm, bgm, priorArg);
			if (it + 1 < iters) {
				const m = fitModels(img, labels);
				if (m.fg.comps.length && m.bg.comps.length) {
					fgm = m.fg;
					bgm = m.bg;
				}
			}
		}
	}
	// Keep what the strokes (or the prior's core, or the box's inside) select.
	const seeds = fgs.slice();
	if (softPrior) {
		const core = coreOf(softPrior, w, h, opts.searchRadius);
		for (let i = 0; i < n; i++) if (core[i]) seeds[i] = 1;
	}
	let anySeed = false;
	for (let i = 0; i < n; i++)
		if (seeds[i]) {
			anySeed = true;
			break;
		}
	// A box alone: keep the largest component inside it.
	if (!anySeed && box) largestComponentAsSeed(labels, seeds, w, h);
	clean(labels, seeds, bgs, w, h);
	return finish(img, w, h, labels, strokes, prior?.refine ?? null, refineRadius);
}

function largestComponentAsSeed(labels: Uint8Array, seeds: Uint8Array, w: number, h: number): void {
	const n = w * h;
	const comp = new Int32Array(n).fill(-1);
	let best: number[] = [];
	for (let s = 0; s < n; s++) {
		if (!labels[s] || comp[s] !== -1) continue;
		const members = [s];
		comp[s] = s;
		for (let k = 0; k < members.length; k++) {
			const i = members[k]!;
			const x = i % w;
			const y = (i / w) | 0;
			for (const [dx, dy] of NB) {
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
				const j = ny * w + nx;
				if (labels[j] && comp[j] === -1) {
					comp[j] = s;
					members.push(j);
				}
			}
		}
		if (members.length > best.length) best = members;
	}
	for (const i of best) seeds[i] = 1;
}

/** Final models and Refine Edge band of a segmented frame. */
function finish(
	img: Float32Array,
	w: number,
	h: number,
	labels: Uint8Array,
	strokes: readonly Stroke[],
	warpedRefine: Uint8Array | null,
	refineRadius: number,
): FrameSeg {
	const n = w * h;
	const { fg, bg } = fitModels(img, labels);
	const add = rasterize(strokes, ['refine'], w, h);
	const erase = rasterize(strokes, ['refineErase'], w, h);
	let carried = false;
	if (warpedRefine) for (let i = 0; i < n && !carried; i++) if (warpedRefine[i]) carried = true;
	const near = carried ? signedDistance(labels, w, h) : null;
	const rr = refineRadius + 2;
	const refine = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		const c = !!(near && warpedRefine?.[i] && Math.abs(near[i]!) <= rr);
		refine[i] = (c || add[i]) && !erase[i] ? 1 : 0;
	}
	return { w, h, matte: labels, refine, fg, bg };
}

/**
 * Warps the previous frame's segmentation onto the next frame. `flow` (next → prev, 2 floats per pixel, matte px) is
 * the dense optical flow; Motion Threshold / Damping are applied to its vectors.
 */
export function warpPrior(prev: FrameSeg, flow: Float32Array, w: number, h: number, opts: SegOpts): Prior {
	const thr = Math.max(0, (opts.motionThreshold / 100) * opts.searchRadius);
	const damp = Math.min(1, Math.max(0, 1 - opts.motionDamping / 100));
	const n = w * h;
	const src = new Float32Array(prev.matte.length);
	for (let i = 0; i < src.length; i++) src[i] = prev.matte[i]!;
	const same = prev.w === w && prev.h === h;
	const soft = new Float32Array(n);
	const refine = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		const x = (i % w) + 0.5;
		const y = ((i / w) | 0) + 0.5;
		let vx = flow[i * 2]!;
		let vy = flow[i * 2 + 1]!;
		if (Math.hypot(vx, vy) < thr) {
			vx *= damp;
			vy *= damp;
		}
		const sx = x + vx;
		const sy = y + vy;
		soft[i] = same ? sample(src, prev.w, prev.h, sx, sy) : 0;
		const ix = Math.min(Math.max(0, prev.w - 1), Math.max(0, Math.floor(sx)));
		const iy = Math.min(Math.max(0, prev.h - 1), Math.max(0, Math.floor(sy)));
		refine[i] = prev.refine[iy * prev.w + ix] ?? 0;
	}
	return { soft, fg: prev.fg, bg: prev.bg, refine, weight: PRIOR };
}

/**
 * Propagates the previous frame's segmentation to the next frame: warp it, then re-cut in a band of Search Radius
 * pixels around the warped boundary. Strokes on the next frame re-cut the whole frame with the warped matte as a
 * soft prior instead.
 */
export function propagate(
	prev: FrameSeg,
	flow: Float32Array,
	img: Float32Array,
	w: number,
	h: number,
	strokes: readonly Stroke[],
	opts: SegOpts,
	refineRadius: number,
): FrameSeg {
	const prior = warpPrior(prev, flow, w, h, opts);
	return propagateWithPrior(prev, prior, img, w, h, strokes, opts, refineRadius);
}

function propagateWithPrior(
	prev: FrameSeg,
	prior: Prior,
	img: Float32Array,
	w: number,
	h: number,
	strokes: readonly Stroke[],
	opts: SegOpts,
	refineRadius: number,
): FrameSeg {
	if (strokes.some((s) => s.kind === 'fg' || s.kind === 'bg'))
		return segment(img, w, h, strokes, null, prior, opts, refineRadius);
	const n = w * h;
	const labels = new Uint8Array(n);
	for (let i = 0; i < n; i++) labels[i] = prior.soft[i]! >= 0.5 ? 1 : 0;
	const sd = signedDistance(labels, w, h);
	const r = Math.max(2, opts.searchRadius);
	const free = new Uint8Array(n);
	for (let i = 0; i < n; i++) free[i] = Math.abs(sd[i]!) <= r ? 1 : 0;
	const hard = new Uint8Array(n);
	const soft = gauss(prior.soft, w, h, Math.max(1, r / 4));
	const models =
		prev.fg.comps.length && prev.bg.comps.length ? { fg: prev.fg, bg: prev.bg } : fitModels(img, labels);
	cut(img, w, h, labels, free, hard, models.fg, models.bg, { p: soft, weight: PRIOR });
	const seeds = coreOf(prior.soft, w, h, r);
	clean(labels, seeds, new Uint8Array(n), w, h);
	return finish(img, w, h, labels, strokes, prior.refine, refineRadius);
}

/** Points spread along a stroke, about one per stroke width, at most `max`. */
function pointsAlong(s: Stroke, max: number): [number, number][] {
	const pts = s.points;
	if (pts.length === 0) return [];
	let len = 0;
	for (let i = 1; i < pts.length; i++)
		len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
	const step = Math.max(1, Math.max(2 * s.radius, len / Math.max(1, max)));
	const out: [number, number][] = [[pts[0]![0], pts[0]![1]]];
	let carry = 0;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1]!;
		const b = pts[i]!;
		const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
		let t = step - carry;
		while (t <= d && out.length < max) {
			const f = t / Math.max(1e-9, d);
			out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
			t += step;
		}
		carry = (carry + d) % step;
	}
	return out;
}

/** A model prompt from the strokes (points along the foreground and background strokes) and the box. */
export function strokePrompt(strokes: readonly Stroke[], box: Box | null): ModelPrompt {
	const points: ModelPrompt['points'] = [];
	for (const [kind, fg] of [
		['fg', true],
		['bg', false],
	] as const) {
		const ss = strokes.filter((s) => s.kind === kind);
		const per = Math.max(1, Math.floor(16 / Math.max(1, ss.length)));
		for (const s of ss) for (const [x, y] of pointsAlong(s, per)) points.push({ x, y, fg });
	}
	return { points, box, mask: null };
}

/** Adds a prior matte to a prompt: its box (5 % larger), up to four points spread through its core, the matte. */
export function addPriorPrompt(prompt: ModelPrompt, soft: Float32Array, w: number, h: number): boolean {
	const n = w * h;
	const bin = new Uint8Array(n);
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = -1;
	let y1 = -1;
	for (let i = 0; i < n; i++) {
		if (soft[i]! < 0.5) continue;
		bin[i] = 1;
		const x = i % w;
		const y = (i / w) | 0;
		if (x < x0) x0 = x;
		if (y < y0) y0 = y;
		if (x > x1) x1 = x;
		if (y > y1) y1 = y;
	}
	if (x1 < 0) return false;
	const mx = Math.max(4, (x1 - x0) * 0.05);
	const my = Math.max(4, (y1 - y0) * 0.05);
	if (!prompt.box)
		prompt.box = [
			Math.max(0, x0 - mx),
			Math.max(0, y0 - my),
			Math.min(w, x1 + 1 + mx),
			Math.min(h, y1 + 1 + my),
		];
	// Farthest-point picks among the core (deep inside), starting from the deepest pixel.
	const sd = signedDistance(bin, w, h);
	let deep = 0;
	for (let i = 0; i < n; i++) if (sd[i]! > deep) deep = sd[i]!;
	const stepBy = Math.max(1, Math.floor(n / 20_000));
	const core: number[] = [];
	let cnt = 0;
	for (let i = 0; i < n; i++)
		if (sd[i]! >= Math.max(1, deep * 0.5)) {
			if (cnt % stepBy === 0) core.push(i);
			cnt++;
		}
	const picks: number[] = [];
	let deepest = -1;
	for (const c of core) if (deepest < 0 || sd[c]! > sd[deepest]!) deepest = c;
	if (deepest >= 0) picks.push(deepest);
	while (picks.length < 4 && core.length) {
		let far = -1;
		let farD = -1;
		for (const c of core) {
			let md = Number.POSITIVE_INFINITY;
			for (const p of picks) {
				const d = ((c % w) - (p % w)) ** 2 + (((c / w) | 0) - ((p / w) | 0)) ** 2;
				if (d < md) md = d;
			}
			if (md > farD) {
				farD = md;
				far = c;
			}
		}
		if (far < 0 || picks.includes(far)) break;
		picks.push(far);
	}
	for (const i of picks) prompt.points.push({ x: (i % w) + 0.5, y: ((i / w) | 0) + 0.5, fg: true });
	prompt.mask = soft;
	return true;
}

/** Intersection over union of two binary mattes. */
export function iou(a: Uint8Array, b: Uint8Array): number {
	let i = 0;
	let u = 0;
	for (let k = 0; k < a.length; k++) {
		const x = a[k] !== 0;
		const y = b[k] !== 0;
		if (x && y) i++;
		if (x || y) u++;
	}
	return u === 0 ? 1 : i / u;
}

/** `segment` with a trained model: its matte for the strokes / box (and the prior) becomes a strong prior. */
export async function segmentWith(
	img: Float32Array,
	w: number,
	h: number,
	strokes: readonly Stroke[],
	box: Box | null,
	prior: Prior | null,
	opts: SegOpts,
	refineRadius: number,
	model: MaskModel | null,
): Promise<{ seg: FrameSeg; usedModel: boolean }> {
	if (!model || w === 0 || h === 0)
		return { seg: segment(img, w, h, strokes, box, prior, opts, refineRadius), usedModel: false };
	const prompt = strokePrompt(strokes, box);
	if (prior) addPriorPrompt(prompt, prior.soft, w, h);
	if (!prompt.points.some((p) => p.fg) && !prompt.box)
		return { seg: segment(img, w, h, strokes, box, prior, opts, refineRadius), usedModel: false };
	let soft: Float32Array | null = null;
	try {
		soft = await model.segment(img, w, h, prompt);
	} catch {
		soft = null;
	}
	if (!soft || soft.length !== w * h)
		return { seg: segment(img, w, h, strokes, box, prior, opts, refineRadius), usedModel: false };
	const p: Prior = {
		soft,
		fg: prior?.fg ?? { comps: [] },
		bg: prior?.bg ?? { comps: [] },
		refine: prior?.refine ?? new Uint8Array(w * h),
		weight: MODEL_PRIOR,
	};
	return { seg: segment(img, w, h, strokes, box, p, opts, refineRadius), usedModel: true };
}

/**
 * `propagate` with a trained model: the model, prompted with the flow-warped matte, re-segments the frame; when it
 * disagrees with the flow (IoU < 0.5) the classical result stands.
 */
export async function propagateWith(
	prev: FrameSeg,
	flow: Float32Array,
	img: Float32Array,
	w: number,
	h: number,
	strokes: readonly Stroke[],
	opts: SegOpts,
	refineRadius: number,
	model: MaskModel | null,
): Promise<{ seg: FrameSeg; usedModel: boolean }> {
	const prior = warpPrior(prev, flow, w, h, opts);
	const classical = () => ({
		seg: propagateWithPrior(prev, prior, img, w, h, strokes, opts, refineRadius),
		usedModel: false,
	});
	if (!model || w === 0 || h === 0) return classical();
	const prompt = strokePrompt(strokes, null);
	if (!addPriorPrompt(prompt, prior.soft, w, h)) return classical();
	let soft: Float32Array | null = null;
	try {
		soft = await model.segment(img, w, h, prompt);
	} catch {
		soft = null;
	}
	if (!soft || soft.length !== w * h) return classical();
	const n = w * h;
	const a = new Uint8Array(n);
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		a[i] = soft[i]! >= 0.5 ? 1 : 0;
		b[i] = prior.soft[i]! >= 0.5 ? 1 : 0;
	}
	if (iou(a, b) < 0.5) return classical();
	const p: Prior = { ...prior, soft, weight: MODEL_PRIOR };
	return { seg: segment(img, w, h, strokes, null, p, opts, refineRadius), usedModel: true };
}

// ---------------------------------------------------------------- edge refinement (Refine Edge)

/** Edge matting of a frame (the engine half of the matte: image-dependent and expensive, so it is cached). */
export type EdgeOpts = {
	/** `off`: binary matte; `guided`: colour guided filter in the band; `closed-form`: + closed-form matting. */
	mode: 'off' | 'guided' | 'closed-form';
	/** Width (matte px) of the automatic band around the whole boundary; 0 = only Refine Edge strokes. */
	radius: number;
	/** Smooth (0..100+): regularisation of the edge matting. */
	smooth: number;
};

export const DEFAULT_EDGE_OPTS: EdgeOpts = { mode: 'guided', radius: 3, smooth: 1 };

/**
 * The soft matte (0..1) of a segmentation: the binary matte, with edge matting (guided filter, + closed-form matting
 * with `closed-form`) inside the band = Refine Edge strokes ∪ (with `radius` > 0) the pixels within `radius` of the
 * boundary. Outside the band the matte stays binary; the result blends in over the band's last two pixels.
 */
export function matteAlpha(
	rgb: Float32Array,
	seg: FrameSeg,
	edge: EdgeOpts,
	strokeRadius: number,
): Float32Array {
	const { w, h } = seg;
	const n = w * h;
	const a = new Float32Array(n);
	for (let i = 0; i < n; i++) a[i] = seg.matte[i]!;
	if (edge.mode === 'off') return a;
	const band = new Uint8Array(n);
	let any = false;
	if (edge.radius > 0) {
		const sd = signedDistance(seg.matte, w, h);
		for (let i = 0; i < n; i++)
			if (Math.abs(sd[i]!) <= edge.radius) {
				band[i] = 1;
				any = true;
			}
	}
	for (let i = 0; i < n; i++)
		if (seg.refine[i]) {
			band[i] = 1;
			any = true;
		}
	if (!any) return a;
	const r = Math.max(2, Math.round(Math.max(edge.radius, strokeRadius)));
	const eps = 2e-4 * (1 + Math.max(0, edge.smooth));
	// Work on the band's bounding box (plus the filter's reach).
	let x0 = w;
	let y0 = h;
	let x1 = 0;
	let y1 = 0;
	for (let i = 0; i < n; i++)
		if (band[i]) {
			const x = i % w;
			const y = (i / w) | 0;
			if (x < x0) x0 = x;
			if (y < y0) y0 = y;
			if (x + 1 > x1) x1 = x + 1;
			if (y + 1 > y1) y1 = y + 1;
		}
	const pad = 2 * r + 2;
	x0 = Math.max(0, x0 - pad);
	y0 = Math.max(0, y0 - pad);
	x1 = Math.min(w, x1 + pad);
	y1 = Math.min(h, y1 + pad);
	const cw = x1 - x0;
	const ch = y1 - y0;
	const cn = cw * ch;
	const cimg = new Float32Array(cn * 3);
	const cp = new Float32Array(cn);
	const cband = new Uint8Array(cn);
	const outside = new Uint8Array(cn);
	for (let j = 0; j < cn; j++) {
		const i = (y0 + ((j / cw) | 0)) * w + x0 + (j % cw);
		cimg[j * 3] = rgb[i * 3]!;
		cimg[j * 3 + 1] = rgb[i * 3 + 1]!;
		cimg[j * 3 + 2] = rgb[i * 3 + 2]!;
		cp[j] = a[i]!;
		cband[j] = band[i]!;
		outside[j] = band[i] ? 0 : 1;
	}
	let q = guidedFilter(cimg, cp, cw, ch, r, eps);
	for (let j = 0; j < cn; j++) q[j] = cband[j] ? Math.min(1, Math.max(0, q[j]!)) : cp[j]!;
	if (edge.mode === 'closed-form')
		q = closedForm(cimg, q, outside, cw, ch, 1, 1e-5 * (1 + Math.max(0, edge.smooth)), 50);
	// Blend in, fading over the band's last two pixels.
	const din = distance(outside, cw, ch);
	for (let j = 0; j < cn; j++) {
		if (!cband[j]) continue;
		const wgt = Math.min(1, Math.max(0, din[j]! / 2));
		const i = (y0 + ((j / cw) | 0)) * w + x0 + (j % cw);
		a[i] = a[i]! + (q[j]! - a[i]!) * wgt;
	}
	for (let i = 0; i < n; i++) a[i] = Math.min(1, Math.max(0, a[i]!));
	return a;
}
