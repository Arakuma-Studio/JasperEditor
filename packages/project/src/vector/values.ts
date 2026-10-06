// Animatable value types of shape layers (wp shapes): Bézier path values (After Effects' vertex / in-tangent /
// out-tangent model, tangents relative to their vertex) and gradients (colour stops and opacity stops with
// midpoints). Both interpolate between keyframes: paths vertex by vertex (shorter paths are subdivided first so the
// counts match), gradients stop by stop (stop lists of different structure are resampled onto the union of their
// positions). `keyframes.ts` calls `isShapeValue` / `lerpShapeValue`, so these values animate like numbers.
import type { BezPath, Cubic, P } from './geom.ts';
import { cSplit, isLine, lineCubic, samePoint } from './geom.ts';

type V2 = [number, number];

export type PathValue = {
	vertices: V2[];
	/** Incoming handle of each vertex, relative to the vertex. */
	inTangents: V2[];
	/** Outgoing handle of each vertex, relative to the vertex. */
	outTangents: V2[];
	closed: boolean;
};

export type GradientColorStop = { position: number; color: [number, number, number]; midpoint?: number };
export type GradientOpacityStop = { position: number; opacity: number; midpoint?: number };
export type GradientValue = { colors: GradientColorStop[]; opacities: GradientOpacityStop[] };

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isV2 = (v: unknown): v is V2 => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

export function isPathValue(v: unknown): v is PathValue {
	if (!v || typeof v !== 'object') return false;
	const o = v as Partial<PathValue>;
	return (
		Array.isArray(o.vertices) &&
		Array.isArray(o.inTangents) &&
		Array.isArray(o.outTangents) &&
		typeof o.closed === 'boolean'
	);
}

export function isGradientValue(v: unknown): v is GradientValue {
	if (!v || typeof v !== 'object') return false;
	const o = v as Partial<GradientValue>;
	return Array.isArray(o.colors) && Array.isArray(o.opacities);
}

/** True for the shape value types that interpolate (path, gradient). */
export const isShapeValue = (v: unknown): boolean => isPathValue(v) || isGradientValue(v);

/** Structural validity (used by invariants and command validation). */
export function validPathValue(v: unknown): v is PathValue {
	if (!isPathValue(v)) return false;
	const n = v.vertices.length;
	return (
		v.inTangents.length === n &&
		v.outTangents.length === n &&
		v.vertices.every(isV2) &&
		v.inTangents.every(isV2) &&
		v.outTangents.every(isV2)
	);
}

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

// ---------------------------------------------------------------- path value ⇄ Bézier

const addV = (a: readonly number[], b: readonly number[]): P => [a[0]! + b[0]!, a[1]! + b[1]!];
const subV = (a: readonly number[], b: readonly number[]): V2 => [a[0]! - b[0]!, a[1]! - b[1]!];
const zero = (v: readonly number[] | undefined) => !v || (v[0] === 0 && v[1] === 0);

/** One subpath from a path value (straight segments where both tangents are zero). */
export function pathValueToBez(v: PathValue): BezPath {
	const n = v.vertices.length;
	if (n === 0) return [];
	const segs: Cubic[] = [];
	const seg = (a: number, b: number) => {
		const va = v.vertices[a]!;
		const vb = v.vertices[b]!;
		const o = v.outTangents[a];
		const i = v.inTangents[b];
		segs.push(zero(o) && zero(i) ? lineCubic(va, vb) : [va, addV(va, o ?? [0, 0]), addV(vb, i ?? [0, 0]), vb]);
	};
	for (let k = 0; k + 1 < n; k++) seg(k, k + 1);
	if (v.closed && n > 1) seg(n - 1, 0);
	if (!segs.length) return [];
	return [{ segs, closed: v.closed }];
}

/** Path values (one per subpath) from a Bézier path. */
export function bezToPathValues(p: BezPath): PathValue[] {
	const out: PathValue[] = [];
	for (const sp of p) {
		if (!sp.segs.length) continue;
		const vertices: V2[] = [];
		const inT: V2[] = [];
		const outT: V2[] = [];
		const first = sp.segs[0]![0];
		vertices.push([first[0], first[1]]);
		inT.push([0, 0]);
		outT.push([0, 0]);
		sp.segs.forEach((c, k) => {
			outT[k] = isLine(c) ? [0, 0] : subV(c[1], c[0]);
			vertices.push([c[3][0], c[3][1]]);
			inT.push(isLine(c) ? [0, 0] : subV(c[2], c[3]));
			outT.push([0, 0]);
		});
		// A closing segment ending on the first vertex duplicates it.
		if (sp.closed && vertices.length > 1 && samePoint(vertices[0]!, vertices[vertices.length - 1]!, 1e-9)) {
			const it = inT.pop()!;
			vertices.pop();
			outT.pop();
			inT[0] = it;
		}
		out.push({ vertices, inTangents: inT, outTangents: outT, closed: sp.closed });
	}
	return out;
}

export const emptyPathValue = (): PathValue => ({ vertices: [], inTangents: [], outTangents: [], closed: false });

// ---------------------------------------------------------------- path interpolation

/** Inserts a vertex in the middle of segment `k` (k → k+1, closing segment for k = n−1), shape unchanged. */
export function splitPathSegment(v: PathValue, k: number, t = 0.5): PathValue {
	const n = v.vertices.length;
	const b = (k + 1) % n;
	const va = v.vertices[k]!;
	const vb = v.vertices[b]!;
	const c: Cubic = [va, addV(va, v.outTangents[k]!), addV(vb, v.inTangents[b]!), vb];
	const straight = zero(v.outTangents[k]) && zero(v.inTangents[b]);
	const [l, r] = cSplit(c, t);
	const m = l[3];
	const vertices = v.vertices.map((p) => [p[0], p[1]] as V2);
	const inT = v.inTangents.map((p) => [p[0], p[1]] as V2);
	const outT = v.outTangents.map((p) => [p[0], p[1]] as V2);
	outT[k] = straight ? [0, 0] : subV(l[1], l[0]);
	inT[b] = straight ? [0, 0] : subV(r[2], r[3]);
	vertices.splice(k + 1, 0, [m[0], m[1]]);
	inT.splice(k + 1, 0, straight ? [0, 0] : subV(l[2], l[3]));
	outT.splice(k + 1, 0, straight ? [0, 0] : subV(r[1], r[0]));
	return { vertices, inTangents: inT, outTangents: outT, closed: v.closed };
}

/** Subdivides the longest segments until the path has `n` vertices. */
function growTo(v: PathValue, n: number): PathValue {
	let cur = v;
	while (cur.vertices.length < n && cur.vertices.length > 0) {
		const m = cur.vertices.length;
		const segs = cur.closed ? m : m - 1;
		if (segs <= 0) {
			// A single point: repeat it.
			const p = cur.vertices[0]!;
			cur = {
				...cur,
				vertices: [...cur.vertices, [p[0], p[1]]],
				inTangents: [...cur.inTangents, [0, 0]],
				outTangents: [...cur.outTangents, [0, 0]],
			};
			continue;
		}
		let best = 0;
		let bestLen = -1;
		for (let k = 0; k < segs; k++) {
			const a = cur.vertices[k]!;
			const b = cur.vertices[(k + 1) % m]!;
			const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
			if (l > bestLen) {
				bestLen = l;
				best = k;
			}
		}
		cur = splitPathSegment(cur, best);
	}
	return cur;
}

export function lerpPathValue(a: PathValue, b: PathValue, t: number): PathValue {
	let x = a;
	let y = b;
	if (x.vertices.length < y.vertices.length) x = growTo(x, y.vertices.length);
	else if (y.vertices.length < x.vertices.length) y = growTo(y, x.vertices.length);
	const l = (p: V2, q: V2 | undefined): V2 =>
		q ? [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t] : [p[0], p[1]];
	return {
		vertices: x.vertices.map((p, i) => l(p, y.vertices[i])),
		inTangents: x.inTangents.map((p, i) => l(p, y.inTangents[i])),
		outTangents: x.outTangents.map((p, i) => l(p, y.outTangents[i])),
		closed: t < 1 ? x.closed : y.closed,
	};
}

// ---------------------------------------------------------------- gradients

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
	if (isPathValue(a) && isPathValue(b)) return lerpPathValue(a, b, t) as T;
	if (isGradientValue(a) && isGradientValue(b)) return lerpGradientValue(a, b, t) as T;
	return a;
}

/**
 * SVG gradient stops (offset, straight colour, alpha) for a gradient: the union of colour and opacity stop
 * positions, plus samples along midpoint curves, so a linear-interpolating renderer reproduces the gradient.
 */
export function gradientSvgStops(g: GradientValue): { offset: number; color: [number, number, number]; alpha: number }[] {
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
