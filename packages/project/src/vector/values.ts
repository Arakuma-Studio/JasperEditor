// Animatable value types of shape layers (wp shapes). Path values are the shared Bézier model of `path/model.ts`
// (`BezierPath`, also used by masks; interpolated by `path/interp.ts`); this module converts them to and from the
// compound-path kernel (`geom.ts`). Gradients (colour stops and opacity stops with midpoints) interpolate stop by
// stop (stop lists of different structure are resampled onto the union of their positions); `keyframes.ts` calls
// `isShapeValue` / `lerpShapeValue`, so they animate like numbers.

import { type BezierPath, isBezierPath } from '../path/model.ts';
import type { BezPath, Cubic } from './geom.ts';
import { isLine, lineCubic, samePoint } from './geom.ts';

export type GradientColorStop = { position: number; color: [number, number, number]; midpoint?: number };
export type GradientOpacityStop = { position: number; opacity: number; midpoint?: number };
export type GradientValue = { colors: GradientColorStop[]; opacities: GradientOpacityStop[] };

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function isGradientValue(v: unknown): v is GradientValue {
	if (!v || typeof v !== 'object') return false;
	const o = v as Partial<GradientValue>;
	return Array.isArray(o.colors) && Array.isArray(o.opacities);
}

/** True for the shape value types this module interpolates (gradients; paths go through `path/interp.ts`). */
export const isShapeValue = (v: unknown): boolean => isGradientValue(v);

/** A well-formed path value (the shared `BezierPath`). */
export const validPathValue = (v: unknown): v is BezierPath => isBezierPath(v);

export function validGradientValue(v: unknown): v is GradientValue {
	if (!isGradientValue(v)) return false;
	const unit = (x: unknown) => isNum(x) && x >= 0 && x <= 1;
	const mid = (x: unknown) => x === undefined || (isNum(x) && x > 0 && x < 1);
	return (
		v.colors.length >= 1 &&
		v.colors.every(
			(s) =>
				!!s &&
				unit(s.position) &&
				Array.isArray(s.color) &&
				s.color.length === 3 &&
				s.color.every(unit) &&
				mid(s.midpoint),
		) &&
		v.opacities.every((s) => !!s && unit(s.position) && unit(s.opacity) && mid(s.midpoint))
	);
}

const zero = (v: readonly number[] | undefined) => !v || (v[0] === 0 && v[1] === 0);

/** One subpath from a path value (straight segments where both handles are zero). */
export function bezierPathToBez(v: BezierPath): BezPath {
	const n = v.vertices.length;
	if (n === 0) return [];
	const segs: Cubic[] = [];
	const seg = (a: number, b: number) => {
		const va = v.vertices[a]!;
		const vb = v.vertices[b]!;
		segs.push(
			zero(va.out) && zero(vb.in)
				? lineCubic(va.p, vb.p)
				: [va.p, [va.p[0] + va.out[0], va.p[1] + va.out[1]], [vb.p[0] + vb.in[0], vb.p[1] + vb.in[1]], vb.p],
		);
	};
	for (let k = 0; k + 1 < n; k++) seg(k, k + 1);
	if (v.closed && n > 1) seg(n - 1, 0);
	if (!segs.length) return [];
	return [{ segs, closed: v.closed }];
}

/** Path values (one per subpath) from a compound path. */
export function bezToBezierPaths(p: BezPath): BezierPath[] {
	const out: BezierPath[] = [];
	for (const sp of p) {
		if (!sp.segs.length) continue;
		const first = sp.segs[0]![0];
		const vertices: BezierPath['vertices'] = [{ p: [first[0], first[1]], in: [0, 0], out: [0, 0] }];
		for (const c of sp.segs) {
			const prev = vertices[vertices.length - 1]!;
			prev.out = isLine(c) ? [0, 0] : [c[1][0] - c[0][0], c[1][1] - c[0][1]];
			vertices.push({
				p: [c[3][0], c[3][1]],
				in: isLine(c) ? [0, 0] : [c[2][0] - c[3][0], c[2][1] - c[3][1]],
				out: [0, 0],
			});
		}
		// A closing segment ending on the first vertex duplicates it.
		if (
			sp.closed &&
			vertices.length > 1 &&
			samePoint(vertices[0]!.p, vertices[vertices.length - 1]!.p, 1e-9)
		) {
			const last = vertices.pop()!;
			vertices[0]!.in = last.in;
		}
		out.push({ closed: sp.closed, vertices });
	}
	return out;
}

export const DEFAULT_GRADIENT: GradientValue = {
	colors: [
		{ position: 0, color: [1, 1, 1] },
		{ position: 1, color: [0, 0, 0] },
	],
	opacities: [
		{ position: 0, opacity: 1 },
		{ position: 1, opacity: 1 },
	],
};

/**
 * Midpoint shaping between two stops: the blend reaches 50 % at `m` (Photoshop / After Effects gradient editor
 * convention, f(u) = u^(ln ½ / ln m)).
 */
export function midpointCurve(u: number, m: number | undefined): number {
	if (m === undefined || Math.abs(m - 0.5) < 1e-6) return u;
	const mm = Math.min(0.99, Math.max(0.01, m));
	return u <= 0 ? 0 : u >= 1 ? 1 : u ** (Math.log(0.5) / Math.log(mm));
}

function sortedStops<T extends { position: number }>(s: readonly T[]): T[] {
	return [...s].sort((a, b) => a.position - b.position);
}

function sampleStops<T extends { position: number; midpoint?: number }>(
	stops: readonly T[],
	t: number,
	mix: (a: T, b: T, f: number) => number[],
	only: (a: T) => number[],
): number[] {
	const s = sortedStops(stops);
	if (!s.length) return [];
	if (t <= s[0]!.position) return only(s[0]!);
	for (let i = 0; i + 1 < s.length; i++) {
		const a = s[i]!;
		const b = s[i + 1]!;
		if (t <= b.position) {
			const span = b.position - a.position;
			const u = span > 1e-12 ? (t - a.position) / span : 1;
			return mix(a, b, midpointCurve(u, a.midpoint));
		}
	}
	return only(s[s.length - 1]!);
}

/** Straight RGBA of a gradient at t ∈ [0, 1]. */
export function sampleGradient(g: GradientValue, t: number): [number, number, number, number] {
	const tt = Math.min(1, Math.max(0, t));
	const c = sampleStops(
		g.colors,
		tt,
		(a, b, f) => a.color.map((x, i) => x + (b.color[i]! - x) * f),
		(a) => [...a.color],
	);
	const o = g.opacities.length
		? sampleStops(
				g.opacities,
				tt,
				(a, b, f) => [a.opacity + (b.opacity - a.opacity) * f],
				(a) => [a.opacity],
			)
		: [1];
	return [c[0] ?? 1, c[1] ?? 1, c[2] ?? 1, o[0] ?? 1];
}

function sameStructure(a: GradientValue, b: GradientValue): boolean {
	return (
		a.colors.length === b.colors.length &&
		a.opacities.length === b.opacities.length &&
		a.colors.every((s, i) => (s.midpoint === undefined) === (b.colors[i]!.midpoint === undefined)) &&
		a.opacities.every((s, i) => (s.midpoint === undefined) === (b.opacities[i]!.midpoint === undefined))
	);
}

/** Both gradients resampled onto the union of their stop positions (midpoints baked into extra stops). */
function resample(g: GradientValue, positions: number[]): GradientValue {
	return {
		colors: positions.map((p) => {
			const c = sampleGradient(g, p);
			return { position: p, color: [c[0], c[1], c[2]] };
		}),
		opacities: positions.map((p) => ({ position: p, opacity: sampleGradient(g, p)[3] })),
	};
}

export function lerpGradientValue(a: GradientValue, b: GradientValue, t: number): GradientValue {
	let x = { colors: sortedStops(a.colors), opacities: sortedStops(a.opacities) };
	let y = { colors: sortedStops(b.colors), opacities: sortedStops(b.opacities) };
	if (!sameStructure(x, y)) {
		const set = new Set<number>();
		for (const g of [x, y]) {
			for (const s of g.colors) set.add(s.position);
			for (const s of g.opacities) set.add(s.position);
			// Midpoints are curves: sample them densely so the blend keeps their shape.
			for (const list of [g.colors, g.opacities] as { position: number; midpoint?: number }[][])
				for (let i = 0; i + 1 < list.length; i++)
					if (list[i]!.midpoint !== undefined)
						for (let k = 1; k < 8; k++)
							set.add(list[i]!.position + ((list[i + 1]!.position - list[i]!.position) * k) / 8);
		}
		const positions = [...set].sort((p, q) => p - q);
		x = resample(x, positions);
		y = resample(y, positions);
	}
	const n = (p: number, q: number) => p + (q - p) * t;
	return {
		colors: x.colors.map((s, i) => {
			const o = y.colors[i]!;
			return {
				position: n(s.position, o.position),
				color: [n(s.color[0], o.color[0]), n(s.color[1], o.color[1]), n(s.color[2], o.color[2])],
				...(s.midpoint !== undefined ? { midpoint: n(s.midpoint, o.midpoint ?? 0.5) } : {}),
			};
		}),
		opacities: x.opacities.map((s, i) => {
			const o = y.opacities[i]!;
			return {
				position: n(s.position, o.position),
				opacity: n(s.opacity, o.opacity),
				...(s.midpoint !== undefined ? { midpoint: n(s.midpoint, o.midpoint ?? 0.5) } : {}),
			};
		}),
	};
}

/** Interpolates two shape values of the same kind (else holds `a`). */
export function lerpShapeValue<T>(a: T, b: T, t: number): T {
	if (isGradientValue(a) && isGradientValue(b)) return lerpGradientValue(a, b, t) as T;
	return a;
}

/**
 * SVG gradient stops (offset, straight colour, alpha) for a gradient: the union of colour and opacity stop
 * positions, plus samples along midpoint curves, so a linear-interpolating renderer reproduces the gradient.
 */
export function gradientSvgStops(
	g: GradientValue,
): { offset: number; color: [number, number, number]; alpha: number }[] {
	const set = new Set<number>([0, 1]);
	for (const list of [sortedStops(g.colors), sortedStops(g.opacities)] as {
		position: number;
		midpoint?: number;
	}[][]) {
		for (const s of list) set.add(Math.min(1, Math.max(0, s.position)));
		for (let i = 0; i + 1 < list.length; i++) {
			const a = list[i]!;
			const b = list[i + 1]!;
			// Two stops at one position: a hard edge, sampled just either side of it.
			if (Math.abs(b.position - a.position) < 1e-9) {
				set.add(Math.max(0, a.position - 1e-6));
				set.add(Math.min(1, a.position + 1e-6));
			}
			if (a.midpoint !== undefined && Math.abs(a.midpoint - 0.5) > 1e-6)
				for (let k = 1; k < 16; k++) set.add(a.position + ((b.position - a.position) * k) / 16);
		}
	}
	return [...set]
		.sort((p, q) => p - q)
		.map((offset) => {
			const c = sampleGradient(g, offset);
			return { offset, color: [c[0], c[1], c[2]], alpha: c[3] };
		});
}
