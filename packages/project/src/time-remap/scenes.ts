// Scene Edit Detection: where a clip's shots change (hard cuts). Port of effectcraft
// `crates/raster/src/cuts.rs` (MIT OR Apache-2.0, licenses/ported/time.md) — the better of the two references, as its
// motion-compensated term rejects camera pans that filmcraft's plain grid difference reports — extended with a
// sensitivity (filmcraft's 0…100 control) and a flash test.
//
// Each frame is reduced to a `SceneSignature`: a joint RGB histogram (4×4×4 bins, normalised) and a small luma
// thumbnail (long side 96 px). Consecutive frames are compared with
// - the histogram distance (half the L1 distance, 0…1): large when the colour content changes, insensitive to motion;
// - the motion-compensated difference: block flow (time-remap/flow.ts) from the later thumbnail to the earlier one,
//   the earlier one warped along it, and the mean absolute luma error left (×4, clamped to 1): inside a shot motion
//   explains the change, across a cut nothing matches.
// The dissimilarity is the geometric mean of the two (both must agree). Frame i starts a new shot when its score is
// above the threshold set by the sensitivity, `peakRatio` × the median of its ±`window` neighbours (adaptive
// threshold: a dissolve spreads its change over many frames and never stands out), at least `minShotFrames` after
// the previous cut (the stronger of two close candidates wins), and is not a flash: when the picture before a change
// comes back 1–2 frames later, the change was a flash (or a single bad frame), not a new shot.
import { blockFlow, type FlowImage, flowAt, pyramid } from './flow.ts';

const BINS = 4;
/** Long side of the motion thumbnail (effectcraft THUMB). */
export const SCENE_THUMB = 96;
/** Long side of the frames the engine decodes for detection. */
export const SCENE_DECODE = 192;

export type SceneSignature = {
	/** BINS³ joint RGB histogram, sums to 1. */
	hist: Float32Array;
	/** Luma thumbnail (0…1). */
	tw: number;
	th: number;
	luma: Float32Array;
};

export type SceneOptions = {
	/** 0 (only the most obvious cuts) … 100 (also subtle ones). Default 50. */
	sensitivity: number;
	/** Shortest shot kept, in frames. Default 2 (effectcraft), Premiere has no setting. */
	minShotFrames: number;
	/** A cut must be this many times the median of its neighbours. Default 3. */
	peakRatio?: number;
	/** Neighbours on each side for the median. Default 4. */
	window?: number;
};

export const DEFAULT_SCENE_OPTIONS: SceneOptions = { sensitivity: 50, minShotFrames: 2 };

/** The absolute dissimilarity a cut must exceed: 0.45 at sensitivity 0, 0.25 at 50 (effectcraft), 0.05 at 100. */
export function sceneThreshold(sensitivity: number): number {
	const s = Math.min(100, Math.max(0, sensitivity)) / 100;
	return 0.45 - 0.4 * s;
}

/** Signature of an RGBA frame (8-bit or 0…1 floats with `scale` = 255 or 1). */
export function sceneSignature(img: FlowImage, scale = 255): SceneSignature {
	const hist = new Float32Array(BINS * BINS * BINS);
	const d = img.data;
	const n = img.width * img.height;
	// Soft (trilinear) binning: each channel value splits its weight between the two nearest bin centres, so the
	// histogram distance is continuous in colour. effectcraft's hard bins move a whole flat area to the next bin when
	// its colour drifts a few levels across a bin edge (the last step of a dissolve onto a flat gradient whose green sat
	// at 64 scored 0.6 and was reported as a cut).
	const lo = [0, 0, 0];
	const wt = [0, 0, 0];
	const split = (c: number, v: number) => {
		const p = Math.min(BINS - 0.5, Math.max(0.5, (v / scale) * BINS)) - 0.5;
		const i = Math.min(BINS - 2, Math.floor(p));
		lo[c] = i;
		wt[c] = p - i;
	};
	for (let i = 0; i < n; i++) {
		const o = i * 4;
		const a = d[o + 3]! / scale;
		// Straight colours over black by their alpha (effectcraft: premultiplied by min(a, 1)).
		const k = a > 1e-6 ? Math.min(1, a) : 0;
		split(0, d[o]! * k);
		split(1, d[o + 1]! * k);
		split(2, d[o + 2]! * k);
		for (let r = 0; r < 2; r++) {
			const wr = r ? wt[0]! : 1 - wt[0]!;
			if (wr === 0) continue;
			for (let g = 0; g < 2; g++) {
				const wg = wr * (g ? wt[1]! : 1 - wt[1]!);
				if (wg === 0) continue;
				const base = (lo[0]! + r) * BINS * BINS + (lo[1]! + g) * BINS + lo[2]!;
				hist[base]! += wg * (1 - wt[2]!);
				hist[base + 1]! += wg * wt[2]!;
			}
		}
	}
	if (n > 0) for (let i = 0; i < hist.length; i++) hist[i]! /= n;
	// Thumbnail: box resample to a long side of SCENE_THUMB (at least 8 px a side).
	const long = Math.max(img.width, img.height, 1);
	const s = long > SCENE_THUMB ? SCENE_THUMB / long : 1;
	const tw = Math.max(8, Math.round(img.width * s));
	const th = Math.max(8, Math.round(img.height * s));
	const luma = new Float32Array(tw * th);
	for (let y = 0; y < th; y++) {
		const y0 = Math.floor((y * img.height) / th);
		const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / th));
		for (let x = 0; x < tw; x++) {
			const x0 = Math.floor((x * img.width) / tw);
			const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / tw));
			let sum = 0;
			let cnt = 0;
			for (let yy = y0; yy < Math.min(y1, img.height); yy++)
				for (let xx = x0; xx < Math.min(x1, img.width); xx++) {
					const o = (yy * img.width + xx) * 4;
					sum += 0.2126 * d[o]! + 0.7152 * d[o + 1]! + 0.0722 * d[o + 2]!;
					cnt++;
				}
			luma[y * tw + x] = cnt > 0 ? sum / cnt / scale : 0;
		}
	}
	return { hist, tw, th, luma };
}

/** Bilinear luma sample of a thumbnail at pixel position (x, y) (centres at +0.5), clamped. */
function sampleLuma(s: SceneSignature, x: number, y: number): number {
	const fx = Math.min(s.tw - 1, Math.max(0, x - 0.5));
	const fy = Math.min(s.th - 1, Math.max(0, y - 0.5));
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const x1 = Math.min(x0 + 1, s.tw - 1);
	const y1 = Math.min(y0 + 1, s.th - 1);
	const tx = fx - x0;
	const ty = fy - y0;
	const g = (xx: number, yy: number) => s.luma[yy * s.tw + xx]!;
	const top = g(x0, y0) + (g(x1, y0) - g(x0, y0)) * tx;
	const bot = g(x0, y1) + (g(x1, y1) - g(x0, y1)) * tx;
	return top + (bot - top) * ty;
}

/** Dissimilarity of two frames, 0 (same) … 1 (unrelated). */
export function sceneDissimilarity(a: SceneSignature, b: SceneSignature): number {
	let h = 0;
	for (let i = 0; i < a.hist.length; i++) h += Math.abs(a.hist[i]! - b.hist[i]!);
	h *= 0.5;
	let motion = 1;
	if (a.tw === b.tw && a.th === b.th && a.luma.length > 0) {
		// Flow from B to A: for each pixel of B, where it came from in A (effectcraft `block_flow(tb, ta, 8, 4)`).
		const pb = pyramid({ w: b.tw, h: b.th, d: Float32Array.from(b.luma) });
		const pa = pyramid({ w: a.tw, h: a.th, d: Float32Array.from(a.luma) });
		const f = blockFlow(pb, pa);
		const v: [number, number] = [0, 0];
		let err = 0;
		for (let y = 0; y < b.th; y++)
			for (let x = 0; x < b.tw; x++) {
				flowAt(f, x + 0.5, y + 0.5, v);
				err += Math.abs(sampleLuma(a, x + 0.5 + v[0], y + 0.5 + v[1]) - b.luma[y * b.tw + x]!);
			}
		motion = Math.min(1, (err / Math.max(1, b.tw * b.th)) * 4);
	}
	return Math.sqrt(h * motion);
}

/** Dissimilarity of every frame to the previous one (`scores[0]` = 0). */
export function sceneScores(sigs: readonly SceneSignature[]): number[] {
	const out = [0];
	for (let i = 1; i < sigs.length; i++) out.push(sceneDissimilarity(sigs[i - 1]!, sigs[i]!));
	return out;
}

/**
 * Frames that start a new shot (indices into `scores`, never 0). `sigs` (the same frames' signatures) enables the
 * flash test; without them every peak counts.
 */
export function detectSceneCuts(
	scores: readonly number[],
	o: SceneOptions = DEFAULT_SCENE_OPTIONS,
	sigs?: readonly SceneSignature[],
): number[] {
	const thr = sceneThreshold(o.sensitivity);
	const ratio = o.peakRatio ?? 3;
	const window = o.window ?? 4;
	const minShot = Math.max(1, Math.round(o.minShotFrames));
	const cuts: number[] = [];
	for (let i = 1; i < scores.length; i++) {
		const s = scores[i]!;
		if (s < thr) continue;
		const lo = Math.max(1, i - window);
		const hi = Math.min(scores.length - 1, i + window);
		const nb: number[] = [];
		for (let j = lo; j <= hi; j++) if (j !== i) nb.push(scores[j]!);
		nb.sort((a, b) => a - b);
		const med = nb[nb.length >> 1] ?? 0;
		if (s < ratio * Math.max(med, 0.02)) continue;
		if (sigs && isFlash(sigs, i, thr)) continue;
		const last = cuts[cuts.length - 1];
		if (last !== undefined && i - last < minShot) {
			if (s > scores[last]!) {
				cuts.pop();
				cuts.push(i);
			}
		} else cuts.push(i);
	}
	return cuts;
}

/**
 * Frame i (a candidate) begins or ends a flash: frame i + 1 or i + 2 looks like frame i − 1 again (the flash starts
 * at i), or frame i looks like frame i − 2 or i − 3 (it ended at i).
 */
function isFlash(sigs: readonly SceneSignature[], i: number, thr: number): boolean {
	const near = (a: SceneSignature | undefined, b: SceneSignature | undefined) =>
		!!a && !!b && sceneDissimilarity(a, b) < thr * 0.5;
	const before = sigs[i - 1];
	if (near(before, sigs[i + 1]) || near(before, sigs[i + 2])) return true;
	return near(sigs[i], sigs[i - 2]) || near(sigs[i], sigs[i - 3]);
}
