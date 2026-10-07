// Lumetri ▸ Color Wheels & Match ▸ Apply Match (color-grade): grade the current clip so its colour matches a
// reference frame, solved INTO the clip's Lumetri parameters (an ordinary, editable grade). Ported from FilmCraft
// `crates/render/src/color_match.rs` (MIT OR Apache-2.0, licenses/ported/color-grade.md):
//
// 1. Both frames are downsampled (≤ 96 px wide) and converted to Oklab (Björn Ottosson, 2020), a perceptual space
//    where L is lightness and (a, b) the colour axes.
// 2. Each pixel is weighted into three tonal ranges by its L — shadows `smoothstep(0.55, 0.15, L)`, highlights
//    `smoothstep(0.45, 0.85, L)`, midtones the rest — and per range we take the mean L, a and b. A global chroma
//    statistic (mean √(a² + b²)) captures saturation.
// 3. Skin-tone protection ("Face Detection"): pixels near the skin-tone line (Oklab hue 20°–75°, chroma 0.02–0.2,
//    L 0.25–0.92) are down-weighted (× 0.2) in the colour statistics so faces do not drive the cast; afterwards the
//    solved cast is scaled down until the mean hue of the current frame's skin pixels moves by at most 8°. When face
//    boxes are known (the roto face detector), only skin pixels inside faces count as skin — fewer false positives
//    on wood, sand or warm walls than the hue test alone (FilmCraft uses the hue test only).
// 4. The match is solved in Lumetri's own parameters — the three colour wheels (x, y), their levels and Basic
//    Saturation (10 unknowns) — by damped Gauss–Newton (Levenberg–Marquardt) with numerical derivatives through the
//    real Lumetri maths (`lumetriFn`). A small penalty on the parameters keeps the grade minimal.
import type { EffectParams } from '../registry/effects.ts';
import { smoothstep } from './grade-math.ts';
import { lumetriFn } from './lumetri.ts';
import type { Rgb } from './lut.ts';

/** A frame for matching: straight RGB(A) float, display-encoded (Rec.709 / sRGB code values), rows top to bottom. */
export type MatchImage = { w: number; h: number; rgb: Float32Array; alpha?: Float32Array };

/** A face (or any skin region) as a normalised rectangle (0..1 over the frame). */
export type FaceBox = { x: number; y: number; w: number; h: number };

/** sRGB EOTF (code value → linear light). */
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** sRGB-primaries linear RGB → Oklab. */
export function oklab(r0: number, g0: number, b0: number): [number, number, number] {
	const r = Math.max(0, r0);
	const g = Math.max(0, g0);
	const b = Math.max(0, b0);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

/** Tonal-range weights (shadows, midtones, highlights) of an Oklab lightness. */
export function tonalWeights(l: number): [number, number, number] {
	const s = smoothstep(0.55, 0.15, l);
	const h = smoothstep(0.45, 0.85, l);
	return [s, Math.max(0, 1 - s - h), h];
}

/** How much an Oklab colour looks like skin (0..1). */
export function skinWeight(lab: readonly [number, number, number]): number {
	const c = Math.hypot(lab[1], lab[2]);
	if (c < 0.02 || c > 0.2 || lab[0] < 0.25 || lab[0] > 0.92) return 0;
	const h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
	const d = h < 20 ? 20 - h : h > 75 ? h - 75 : 0;
	return Math.min(1, Math.max(0, 1 - d / 10));
}

/** Frame statistics: per tonal range (weight, mean L, mean a, mean b), mean chroma, skin (mean a, mean b, weight). */
export type MatchStats = {
	bands: [number, number, number, number][];
	chroma: number;
	skin: [number, number, number];
};

/** RGBA8 (straight) → a match image (encoded floats). */
export function matchImageFromRgba8(data: ArrayLike<number>, w: number, h: number): MatchImage {
	const n = Math.max(0, w * h);
	const rgb = new Float32Array(n * 3);
	const alpha = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		rgb[i * 3] = (data[i * 4] ?? 0) / 255;
		rgb[i * 3 + 1] = (data[i * 4 + 1] ?? 0) / 255;
		rgb[i * 3 + 2] = (data[i * 4 + 2] ?? 0) / 255;
		alpha[i] = (data[i * 4 + 3] ?? 255) / 255;
	}
	return { w, h, rgb, alpha };
}

/** Downsample by box filtering (halving) until at most `maxW` wide. */
export function shrinkMatchImage(img: MatchImage, maxW = 96): MatchImage {
	let cur = img;
	while (cur.w > maxW && cur.w >= 2 && cur.h >= 2) {
		const w = cur.w >> 1;
		const h = cur.h >> 1;
		const rgb = new Float32Array(w * h * 3);
		const alpha = new Float32Array(w * h);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const o = y * w + x;
				let a = 0;
				const acc = [0, 0, 0];
				for (const [dx, dy] of [
					[0, 0],
					[1, 0],
					[0, 1],
					[1, 1],
				] as const) {
					const i = (2 * y + dy) * cur.w + 2 * x + dx;
					const ai = cur.alpha ? cur.alpha[i]! : 1;
					a += ai;
					for (let k = 0; k < 3; k++) acc[k]! += cur.rgb[i * 3 + k]! * ai;
				}
				alpha[o] = a / 4;
				for (let k = 0; k < 3; k++) rgb[o * 3 + k] = a > 0 ? acc[k]! / a : 0;
			}
		cur = { w, h, rgb, alpha };
	}
	return cur;
}

const insideFaces = (faces: readonly FaceBox[] | undefined, x: number, y: number) =>
	!faces || faces.some((f) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h);

/**
 * Statistics of an image. `skinProtect` down-weights skin pixels in the colour means; `faces` (normalised boxes)
 * limits "skin" to pixels inside faces (none = the hue test alone).
 */
export function matchStats(img: MatchImage, skinProtect: boolean, faces?: readonly FaceBox[]): MatchStats {
	const acc = [
		[0, 0, 0, 0],
		[0, 0, 0, 0],
		[0, 0, 0, 0],
	];
	const cw = [0, 0, 0];
	let chromaSum = 0;
	let chromaW = 0;
	const skin = [0, 0, 0];
	const n = img.w * img.h;
	for (let i = 0; i < n; i++) {
		const a = img.alpha ? img.alpha[i]! : 1;
		if (a <= 1e-3) continue;
		const lab = oklab(
			toLinear(img.rgb[i * 3]!),
			toLinear(img.rgb[i * 3 + 1]!),
			toLinear(img.rgb[i * 3 + 2]!),
		);
		const px = ((i % img.w) + 0.5) / img.w;
		const py = (Math.floor(i / img.w) + 0.5) / img.h;
		const sk = skinWeight(lab) * (insideFaces(faces, px, py) ? 1 : 0);
		const cwi = skinProtect ? 1 - 0.8 * sk : 1;
		const w = tonalWeights(lab[0]);
		for (let k = 0; k < 3; k++) {
			const wk = w[k]!;
			acc[k]![0]! += wk;
			acc[k]![1]! += wk * lab[0];
			acc[k]![2]! += wk * cwi * lab[1];
			acc[k]![3]! += wk * cwi * lab[2];
			cw[k]! += wk * cwi;
		}
		chromaSum += cwi * Math.hypot(lab[1], lab[2]);
		chromaW += cwi;
		skin[0]! += sk * lab[1];
		skin[1]! += sk * lab[2];
		skin[2]! += sk;
	}
	const nn = Math.max(1, n);
	const bands = acc.map(
		(a, k) =>
			[
				a[0]! / nn,
				a[1]! / Math.max(1e-9, a[0]!),
				a[2]! / Math.max(1e-9, cw[k]!),
				a[3]! / Math.max(1e-9, cw[k]!),
			] as [number, number, number, number],
	);
	const sw = Math.max(1e-9, skin[2]!);
	return {
		bands,
		chroma: chromaSum / Math.max(1e-9, chromaW),
		skin: [skin[0]! / sw, skin[1]! / sw, skin[2]! / nn],
	};
}

/** Residuals between graded statistics and the reference's (bands weighted by how much of both frames they cover). */
function residuals(cur: MatchStats, ref: MatchStats): number[] {
	const r: number[] = [];
	for (let k = 0; k < 3; k++) {
		const w = Math.sqrt(Math.min(1, Math.max(0, Math.min(cur.bands[k]![0], ref.bands[k]![0]) * 3)));
		r.push((cur.bands[k]![1] - ref.bands[k]![1]) * w);
		r.push((cur.bands[k]![2] - ref.bands[k]![2]) * w * 2);
		r.push((cur.bands[k]![3] - ref.bands[k]![3]) * w * 2);
	}
	r.push((cur.chroma - ref.chroma) * 2);
	return r;
}

/** The solved grade (Lumetri param values) and the statistics distance before and after. */
export type ColorMatchResult = {
	shadowsWheel: [number, number];
	midtonesWheel: [number, number];
	highlightsWheel: [number, number];
	shadowsLevel: number;
	midtonesLevel: number;
	highlightsLevel: number;
	saturation: number;
	before: number;
	after: number;
	/** Where skin protection found skin: `faces` (face boxes), `hue` (the skin-tone test), `off`. */
	skin: 'faces' | 'hue' | 'off';
	/** Share of the current frame recognised as skin (0..1). */
	skinShare: number;
	/** Skin hue shift of the current frame after protection (degrees), when skin was found. */
	skinHueShift: number | null;
};

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** The Lumetri params of the unknowns: [sx, sy, mx, my, hx, hy, sl, ml, hl, sat] (levels/100, saturation − 1). */
export function matchParams(base: EffectParams, x: readonly number[]): EffectParams {
	return {
		...base,
		wheelsOn: true,
		basicOn: true,
		shadowsWheel: [x[0]!, x[1]!],
		midtonesWheel: [x[2]!, x[3]!],
		highlightsWheel: [x[4]!, x[5]!],
		shadowsLevel: x[6]! * 100,
		midtonesLevel: x[7]! * 100,
		highlightsLevel: x[8]! * 100,
		saturation: Math.min(200, Math.max(0, (1 + x[9]!) * 100)),
	};
}

/** The image graded by Lumetri `params` (pointwise steps; the spatial ones do not move tonal statistics). */
export function gradeMatchImage(img: MatchImage, params: EffectParams): MatchImage {
	const fn = lumetriFn(params, { lut: () => null });
	if (!fn) return img;
	const rgb = new Float32Array(img.rgb.length);
	const c: Rgb = [0, 0, 0];
	for (let i = 0; i < img.rgb.length; i += 3) {
		c[0] = img.rgb[i]!;
		c[1] = img.rgb[i + 1]!;
		c[2] = img.rgb[i + 2]!;
		fn(c);
		rgb[i] = c[0];
		rgb[i + 1] = c[1];
		rgb[i + 2] = c[2];
	}
	return { w: img.w, h: img.h, rgb, ...(img.alpha ? { alpha: img.alpha } : {}) };
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(a: number[][], b: number[]): number[] | null {
	const n = b.length;
	for (let col = 0; col < n; col++) {
		let piv = col;
		for (let i = col + 1; i < n; i++) if (Math.abs(a[i]![col]!) > Math.abs(a[piv]![col]!)) piv = i;
		if (Math.abs(a[piv]![col]!) < 1e-14) return null;
		[a[col], a[piv]] = [a[piv]!, a[col]!];
		[b[col], b[piv]] = [b[piv]!, b[col]!];
		for (let row = col + 1; row < n; row++) {
			const f = a[row]![col]! / a[col]![col]!;
			for (let k = col; k < n; k++) a[row]![k]! -= f * a[col]![k]!;
			b[row]! -= f * b[col]!;
		}
	}
	const x = new Array<number>(n).fill(0);
	for (let i = n - 1; i >= 0; i--) {
		let s = 0;
		for (let k = i + 1; k < n; k++) s += a[i]![k]! * x[k]!;
		x[i] = (b[i]! - s) / a[i]![i]!;
	}
	return x;
}

export type ColorMatchOptions = {
	/** Face Detection: protect skin tones (default true, as Premiere). */
	skinProtect?: boolean;
	/** Faces in the current / reference frames (normalised boxes); absent = skin by the hue test. */
	currentFaces?: readonly FaceBox[];
	referenceFaces?: readonly FaceBox[];
};

/**
 * Solves the grade that matches `current` (the clip's picture BEFORE its Lumetri instance) to `reference`. `base`
 * is the instance's params: its other settings are kept; wheels, levels and Basic Saturation are solved.
 */
export function solveColorMatch(
	current: MatchImage,
	reference: MatchImage,
	base: EffectParams,
	opts: ColorMatchOptions = {},
): ColorMatchResult {
	const skinProtect = opts.skinProtect ?? true;
	const cur = shrinkMatchImage(current, 96);
	const ref = matchStats(shrinkMatchImage(reference, 96), skinProtect, opts.referenceFaces);
	const graded = (x: readonly number[]) =>
		matchStats(gradeMatchImage(cur, matchParams(base, x)), skinProtect, opts.currentFaces);
	const N = 10;
	let x = new Array<number>(N).fill(0);
	const lambda = 0.02;
	const cost = (xs: readonly number[]): [number[], number] => {
		const r = residuals(graded(xs), ref);
		let c = 0;
		for (const v of r) c += v * v;
		for (const v of xs) c += lambda * lambda * v * v;
		return [r, c];
	};
	let [r, c] = cost(x);
	const before = Math.sqrt(c);
	let mu = 1e-3;
	for (let it = 0; it < 20; it++) {
		const h = 1e-2;
		const jac: number[][] = r.map(() => new Array<number>(N).fill(0));
		for (let j = 0; j < N; j++) {
			const xp = [...x];
			xp[j]! += h;
			const [rp] = cost(xp);
			for (let i = 0; i < r.length; i++) jac[i]![j] = (rp[i]! - r[i]!) / h;
		}
		const A: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0));
		const g = new Array<number>(N).fill(0);
		for (let i = 0; i < r.length; i++) {
			const row = jac[i]!;
			for (let p = 0; p < N; p++) {
				g[p]! += row[p]! * r[i]!;
				for (let q = 0; q < N; q++) A[p]![q]! += row[p]! * row[q]!;
			}
		}
		for (let p = 0; p < N; p++) {
			g[p]! += lambda * lambda * x[p]!;
			A[p]![p]! += lambda * lambda + mu * (1 + A[p]![p]!);
		}
		const dx = solveLinear(
			A,
			g.map((v) => -v),
		);
		if (!dx) break;
		const xn = x.map((v, p) => Math.min(1, Math.max(-1, v + dx[p]!)));
		const [rn, cn] = cost(xn);
		if (cn < c) {
			const improved = c - cn;
			x = xn;
			r = rn;
			c = cn;
			mu = Math.max(1e-6, mu * 0.3);
			if (improved < 1e-7) break;
		} else {
			mu *= 10;
			if (mu > 1e4) break;
		}
	}
	const s0 = matchStats(cur, true, opts.currentFaces);
	const skinFound = s0.skin[2] > 0.002;
	let skinHueShift: number | null = null;
	if (skinProtect && skinFound) {
		// Limit the hue shift of the current frame's skin tones to 8°.
		const hue = (s: MatchStats) => (Math.atan2(s.skin[1], s.skin[0]) * 180) / Math.PI;
		const h0 = hue(s0);
		const shift = (xs: readonly number[]) => {
			const s1 = matchStats(gradeMatchImage(cur, matchParams(base, xs)), true, opts.currentFaces);
			let d = Math.abs(hue(s1) - h0);
			if (d > 180) d = 360 - d;
			return d;
		};
		let k = 1;
		let d = 0;
		for (let i = 0; i < 8; i++) {
			d = shift(x.map((v, j) => (j < 6 ? v * k : v)));
			if (d <= 8) break;
			k *= 0.7;
		}
		x = x.map((v, j) => (j < 6 ? v * k : v));
		c = cost(x)[1];
		skinHueShift = round(shift(x), 2);
	}
	return {
		shadowsWheel: [round(x[0]!, 4), round(x[1]!, 4)],
		midtonesWheel: [round(x[2]!, 4), round(x[3]!, 4)],
		highlightsWheel: [round(x[4]!, 4), round(x[5]!, 4)],
		shadowsLevel: round(x[6]! * 100, 2),
		midtonesLevel: round(x[7]! * 100, 2),
		highlightsLevel: round(x[8]! * 100, 2),
		saturation: round(Math.min(200, Math.max(0, (1 + x[9]!) * 100)), 2),
		before: round(before, 6),
		after: round(Math.sqrt(c), 6),
		skin: !skinProtect ? 'off' : opts.currentFaces ? 'faces' : 'hue',
		skinShare: round(s0.skin[2], 4),
		skinHueShift,
	};
}
