// Lumetri ▸ Basic Correction ▸ Auto (color-grade): sets Exposure, Contrast, Highlights, Shadows, Whites, Blacks and
// Saturation from the frame, as Premiere's Auto Tone does (helpx "Basic Correction ▸ Tone ▸ Auto": "Premiere Pro
// sets the slider values to optimize the image"; the algorithm is undocumented). Ours is explicit and repeatable:
// the luma distribution of the clip's picture before Lumetri is pushed towards a well-exposed target — a black point
// near 2 %, a white point near 98 %, the median near 42 % — by a damped least-squares solve through the real
// Lumetri maths (like Colour Match), so the result is ordinary, editable slider values. Saturation is reported but
// left alone (raising it on a deliberately muted frame would fight the grade).
import type { EffectParams } from '../registry/effects.ts';
import { luma709 } from './grade-math.ts';
import { gradeMatchImage, type MatchImage, shrinkMatchImage } from './match.ts';

export type AutoToneResult = {
	exposure: number;
	contrast: number;
	highlights: number;
	shadows: number;
	whites: number;
	blacks: number;
	saturation: number;
	/** Luma quantiles (1, 10, 50, 90, 99 %) before and after, in percent. */
	before: number[];
	after: number[];
};

/** Quantiles of the target distribution (p1, p10, p50, p90, p99). */
const TARGET = [0.02, 0.1, 0.42, 0.8, 0.98];
const Q = [0.01, 0.1, 0.5, 0.9, 0.99];

function quantiles(img: MatchImage): number[] {
	const n = img.w * img.h;
	const ys: number[] = [];
	for (let i = 0; i < n; i++) {
		if (img.alpha && img.alpha[i]! <= 1e-3) continue;
		ys.push(luma709(img.rgb[i * 3]!, img.rgb[i * 3 + 1]!, img.rgb[i * 3 + 2]!));
	}
	if (!ys.length) return Q.map(() => 0);
	ys.sort((a, b) => a - b);
	return Q.map((q) => {
		// Linear interpolation between order statistics (smooth enough for numerical derivatives).
		const p = q * (ys.length - 1);
		const i = Math.floor(p);
		const t = p - i;
		return ys[i]! + (ys[Math.min(ys.length - 1, i + 1)]! - ys[i]!) * t;
	});
}

/** Unknowns: [exposure/2, contrast/100, highlights/100, shadows/100, whites/100, blacks/100]. */
function toneParams(base: EffectParams, x: readonly number[], saturation: number): EffectParams {
	return {
		...base,
		basicOn: true,
		exposure: x[0]! * 2,
		contrast: x[1]! * 100,
		highlights: x[2]! * 100,
		shadows: x[3]! * 100,
		whites: x[4]! * 100,
		blacks: x[5]! * 100,
		saturation,
	};
}

/**
 * Auto tone of `image` (the clip's picture before its Lumetri instance, display-encoded). `base` = the instance's
 * params (everything else is kept; the tone sliders start from 0 like Premiere's Auto).
 */
export function autoTone(image: MatchImage, base: EffectParams = {}): AutoToneResult {
	const img = shrinkMatchImage(image, 128);
	const N = 6;
	const lambda = 0.05;
	let x = new Array<number>(N).fill(0);
	const sat0 = typeof base.saturation === 'number' ? base.saturation : 100;
	const resid = (xs: readonly number[]) => {
		const q = quantiles(gradeMatchImage(img, toneParams(base, xs, sat0)));
		return q.map((v, i) => (v - TARGET[i]!) * (i === 2 ? 1.5 : 1));
	};
	const cost = (xs: readonly number[]): [number[], number] => {
		const r = resid(xs);
		let c = 0;
		for (const v of r) c += v * v;
		for (const v of xs) c += lambda * lambda * v * v;
		return [r, c];
	};
	let [r, c] = cost(x);
	const before = quantiles(gradeMatchImage(img, toneParams(base, x, sat0)));
	let mu = 1e-2;
	for (let it = 0; it < 15; it++) {
		const h = 1e-2;
		const jac = r.map(() => new Array<number>(N).fill(0));
		for (let j = 0; j < N; j++) {
			const xp = [...x];
			xp[j]! += h;
			const rp = resid(xp);
			for (let i = 0; i < r.length; i++) jac[i]![j] = (rp[i]! - r[i]!) / h;
		}
		const A = Array.from({ length: N }, () => new Array<number>(N).fill(0));
		const g = new Array<number>(N).fill(0);
		for (let i = 0; i < r.length; i++)
			for (let p = 0; p < N; p++) {
				g[p]! += jac[i]![p]! * r[i]!;
				for (let q = 0; q < N; q++) A[p]![q]! += jac[i]![p]! * jac[i]![q]!;
			}
		for (let p = 0; p < N; p++) {
			g[p]! += lambda * lambda * x[p]!;
			A[p]![p]! += lambda * lambda + mu * (1 + A[p]![p]!);
		}
		// Gaussian elimination (6 × 6).
		const M = A.map((row, i) => [...row, -g[i]!]);
		let ok = true;
		for (let col = 0; col < N && ok; col++) {
			let piv = col;
			for (let i = col + 1; i < N; i++) if (Math.abs(M[i]![col]!) > Math.abs(M[piv]![col]!)) piv = i;
			if (Math.abs(M[piv]![col]!) < 1e-14) ok = false;
			else {
				[M[col], M[piv]] = [M[piv]!, M[col]!];
				for (let i = col + 1; i < N; i++) {
					const f = M[i]![col]! / M[col]![col]!;
					for (let k = col; k <= N; k++) M[i]![k]! -= f * M[col]![k]!;
				}
			}
		}
		if (!ok) break;
		const dx = new Array<number>(N).fill(0);
		for (let i = N - 1; i >= 0; i--) {
			let s = M[i]![N]!;
			for (let k = i + 1; k < N; k++) s -= M[i]![k]! * dx[k]!;
			dx[i] = s / M[i]![i]!;
		}
		const xn = x.map((v, p) => Math.min(1, Math.max(-1, v + dx[p]!)));
		const [rn, cn] = cost(xn);
		if (cn < c) {
			const improved = c - cn;
			x = xn;
			r = rn;
			c = cn;
			mu = Math.max(1e-6, mu * 0.3);
			if (improved < 1e-8) break;
		} else {
			mu *= 10;
			if (mu > 1e4) break;
		}
	}
	// Saturation is not touched (only the tone sliders move): a cast or a muted look is the grader's choice.
	const saturation = sat0;
	const after = quantiles(gradeMatchImage(img, toneParams(base, x, saturation)));
	const r2 = (v: number) => Math.round(v * 100) / 100;
	return {
		exposure: Math.round(x[0]! * 2 * 1000) / 1000,
		contrast: r2(x[1]! * 100),
		highlights: r2(x[2]! * 100),
		shadows: r2(x[3]! * 100),
		whites: r2(x[4]! * 100),
		blacks: r2(x[5]! * 100),
		saturation: r2(saturation),
		before: before.map((v) => r2(v * 100)),
		after: after.map((v) => r2(v * 100)),
	};
}
