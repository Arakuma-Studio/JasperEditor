// Easing panel ▸ pure curve editing: handle drags (Shift constrains to one axis, Alt breaks a linked handle),
// adding a point by splitting a piece at the clicked time (de Casteljau, so the shape is unchanged), removing a
// point, the symmetric Mirror, numeric fields, the `cubic-bezier(a, b, c, d)` text form and the editor's own
// undo history. Every function returns a curve that passes `EaseCurveSchema` (handles clamped into their piece,
// y within ±EASE_Y_LIMIT); none of them throws on non-finite input.
import {
	type CubicEase,
	EASE_Y_LIMIT,
	type EaseCurve,
	type EaseCurvePoint,
	easeCurveSegments,
	MAX_EASE_POINTS,
	type MultiEase,
} from '@jasper/project';

/** The straight line (handles one third along the diagonal). */
export const LINEAR_EASE_CURVE: CubicEase = { kind: 'cubic', x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };

/** Smallest x gap kept between a point and its neighbours. */
const POINT_GAP = 1e-3;
/** Smallest x gap between a point and its own handle (the schema wants it strictly after / before the point). */
const HANDLE_GAP = 1e-6;

export type Vec = readonly [number, number];

/** A draggable part of a curve: a cubic handle, a multi-curve point, or a point's in / out handle. */
export type HandleRef =
	| { kind: 'cubic'; handle: 1 | 2 }
	| { kind: 'point'; index: number }
	| { kind: 'in' | 'out'; index: number };

export type DragMods = { alt: boolean; shift: boolean };

const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, finite(v, lo)));
export const clampY = (v: number) => clamp(v, -EASE_Y_LIMIT, EASE_Y_LIMIT);
export const clampX = (v: number) => clamp(v, 0, 1);

const copyPoint = (p: EaseCurvePoint): EaseCurvePoint => ({
	x: p.x,
	y: p.y,
	...(p.in ? { in: [p.in[0], p.in[1]] as [number, number] } : {}),
	...(p.out ? { out: [p.out[0], p.out[1]] as [number, number] } : {}),
});

/** Default (linear) handle of point i toward a neighbour, one third along the chord. */
function defaultHandle(
	points: readonly EaseCurvePoint[],
	i: number,
	side: 'in' | 'out',
): [number, number] | null {
	const p = points[i];
	const q = points[side === 'out' ? i + 1 : i - 1];
	if (!p || !q) return null;
	return [p.x + (q.x - p.x) / 3, p.y + (q.y - p.y) / 3];
}

/** Position of a handle or point in curve space (missing multi-curve handles at their linear default). */
export function handlePosition(curve: EaseCurve, ref: HandleRef): [number, number] | null {
	if (curve.kind === 'cubic') {
		if (ref.kind !== 'cubic') return null;
		return ref.handle === 1 ? [curve.x1, curve.y1] : [curve.x2, curve.y2];
	}
	if (ref.kind === 'cubic') return null;
	const p = curve.points[ref.index];
	if (!p) return null;
	if (ref.kind === 'point') return [p.x, p.y];
	const own = ref.kind === 'in' ? p.in : p.out;
	return own ? [own[0], own[1]] : defaultHandle(curve.points, ref.index, ref.kind);
}

/** Every draggable part of a curve, in tab order. */
export function handleRefs(curve: EaseCurve): HandleRef[] {
	if (curve.kind === 'cubic')
		return [
			{ kind: 'cubic', handle: 1 },
			{ kind: 'cubic', handle: 2 },
		];
	const out: HandleRef[] = [];
	const last = curve.points.length - 1;
	curve.points.forEach((_, i) => {
		if (i > 0) out.push({ kind: 'in', index: i });
		if (i > 0 && i < last) out.push({ kind: 'point', index: i });
		if (i < last) out.push({ kind: 'out', index: i });
	});
	return out;
}

export const sameRef = (a: HandleRef | null, b: HandleRef | null): boolean =>
	!!a &&
	!!b &&
	a.kind === b.kind &&
	(a.kind === 'cubic' ? a.handle === (b as typeof a).handle : a.index === (b as { index: number }).index);

/** Shift: keep whichever axis moved further since the drag began. */
export function constrainToAxis(start: Vec, pos: Vec): [number, number] {
	return Math.abs(pos[0] - start[0]) >= Math.abs(pos[1] - start[1]) ? [pos[0], start[1]] : [start[0], pos[1]];
}

/** Point-symmetric about (½, ½): the second handle mirrors the first. */
export function isSymmetric(c: CubicEase, tol = 1e-6): boolean {
	return Math.abs(c.x2 - (1 - c.x1)) <= tol && Math.abs(c.y2 - (1 - c.y1)) <= tol;
}

/**
 * Clamps every point and handle into the schema's constraints: interior points strictly increasing with a gap,
 * first (0, 0) and last (1, 1), out handles in (x, next.x], in handles in [prev.x, x), y within the limit.
 */
export function sanitizeMulti(points: readonly EaseCurvePoint[]): MultiEase {
	const pts = points.map(copyPoint);
	const n = pts.length;
	pts[0] = { ...pts[0]!, x: 0, y: 0 };
	pts[n - 1] = { ...pts[n - 1]!, x: 1, y: 1 };
	for (let i = 1; i < n - 1; i++) {
		const p = pts[i]!;
		const lo = pts[i - 1]!.x + POINT_GAP;
		const hi = 1 - POINT_GAP * (n - 1 - i);
		p.x = clamp(p.x, Math.min(lo, hi), hi);
		p.y = clampY(p.y);
	}
	for (let i = 0; i < n; i++) {
		const p = pts[i]!;
		const prev = pts[i - 1];
		const next = pts[i + 1];
		if (!prev) delete p.in;
		else if (p.in) p.in = [clamp(p.in[0], prev.x, p.x - HANDLE_GAP), clampY(p.in[1])];
		if (!next) delete p.out;
		else if (p.out) p.out = [clamp(p.out[0], p.x + HANDLE_GAP, next.x), clampY(p.out[1])];
	}
	return { kind: 'multi', points: pts };
}

function cubicFromEnds(points: readonly EaseCurvePoint[]): CubicEase {
	const a = points[0]!;
	const b = points[points.length - 1]!;
	const out = a.out ?? defaultHandle(points, 0, 'out')!;
	const inn = b.in ?? defaultHandle(points, points.length - 1, 'in')!;
	return { kind: 'cubic', x1: clampX(out[0]), y1: clampY(out[1]), x2: clampX(inn[0]), y2: clampY(inn[1]) };
}

/** Rotates `opp` (a handle of `p`) to point away from `moved`, keeping its length, its x inside [lo, hi]. */
function opposite(p: EaseCurvePoint, moved: Vec, opp: Vec, lo: number, hi: number): [number, number] {
	const dx = p.x - moved[0];
	const dy = p.y - moved[1];
	const d = Math.hypot(dx, dy);
	const len = Math.hypot(opp[0] - p.x, opp[1] - p.y);
	if (!(d > 1e-9) || !(len > 1e-9)) return [opp[0], opp[1]];
	let ux = (dx / d) * len;
	let uy = (dy / d) * len;
	const x = p.x + ux;
	// Shorten along the same direction when the x would leave the handle's allowed range.
	const limit = x > hi ? (hi - p.x) / ux : x < lo ? (lo - p.x) / ux : 1;
	if (limit < 1) {
		ux *= Math.max(0, limit);
		uy *= Math.max(0, limit);
	}
	return [p.x + ux, p.y + uy];
}

/** In and out handles of point i form a straight line through it (a smooth point). */
function colinear(points: readonly EaseCurvePoint[], i: number): boolean {
	const p = points[i]!;
	const a = p.in ?? defaultHandle(points, i, 'in');
	const b = p.out ?? defaultHandle(points, i, 'out');
	if (!a || !b) return false;
	const v1 = [p.x - a[0], p.y - a[1]];
	const v2 = [b[0] - p.x, b[1] - p.y];
	const l1 = Math.hypot(v1[0]!, v1[1]!);
	const l2 = Math.hypot(v2[0]!, v2[1]!);
	if (l1 < 1e-9 || l2 < 1e-9) return false;
	const cross = (v1[0]! * v2[1]! - v1[1]! * v2[0]!) / (l1 * l2);
	const dot = (v1[0]! * v2[0]! + v1[1]! * v2[1]!) / (l1 * l2);
	return Math.abs(cross) < 1e-3 && dot > 0;
}

/**
 * The curve with `ref` dragged to `pos` (curve space), from the curve as it was when the drag began (`base`) and
 * where the grabbed part was then (`grab`). Shift constrains the move to one axis; a symmetric cubic stays
 * symmetric and a smooth multi-curve point stays smooth unless Alt is held.
 */
export function dragHandle(base: EaseCurve, ref: HandleRef, pos: Vec, mods: DragMods, grab: Vec): EaseCurve {
	const [px, py] = mods.shift ? constrainToAxis(grab, pos) : [pos[0], pos[1]];
	if (base.kind === 'cubic') {
		if (ref.kind !== 'cubic') return base;
		const x = clampX(px);
		const y = clampY(py);
		const linked = !mods.alt && isSymmetric(base);
		if (ref.handle === 1)
			return linked ? { ...base, x1: x, y1: y, x2: 1 - x, y2: clampY(1 - y) } : { ...base, x1: x, y1: y };
		return linked ? { ...base, x2: x, y2: y, x1: 1 - x, y1: clampY(1 - y) } : { ...base, x2: x, y2: y };
	}
	if (ref.kind === 'cubic') return base;
	const pts = base.points.map(copyPoint);
	const i = ref.index;
	const p = pts[i];
	if (!p) return base;
	const prev = pts[i - 1];
	const next = pts[i + 1];
	if (ref.kind === 'point') {
		if (!prev || !next) return base; // the end points stay at (0, 0) and (1, 1)
		const x = clamp(px, prev.x + POINT_GAP, next.x - POINT_GAP);
		const y = clampY(py);
		const dx = x - p.x;
		const dy = y - p.y;
		// The point carries its handles; implicit (linear) handles become explicit so they move with it.
		const inn = p.in ?? defaultHandle(pts, i, 'in')!;
		const out = p.out ?? defaultHandle(pts, i, 'out')!;
		p.x = x;
		p.y = y;
		p.in = [inn[0] + dx, inn[1] + dy];
		p.out = [out[0] + dx, out[1] + dy];
		return sanitizeMulti(pts);
	}
	const smooth = !mods.alt && !!prev && !!next && colinear(base.points, i);
	if (ref.kind === 'out') {
		if (!next) return base;
		const h: [number, number] = [clamp(px, p.x + HANDLE_GAP, next.x), clampY(py)];
		p.out = h;
		if (smooth && prev) p.in = opposite(p, h, p.in ?? defaultHandle(pts, i, 'in')!, prev.x, p.x - HANDLE_GAP);
	} else {
		if (!prev) return base;
		const h: [number, number] = [clamp(px, prev.x, p.x - HANDLE_GAP), clampY(py)];
		p.in = h;
		if (smooth && next)
			p.out = opposite(p, h, p.out ?? defaultHandle(pts, i, 'out')!, p.x + HANDLE_GAP, next.x);
	}
	return sanitizeMulti(pts);
}

/** Keyboard nudge of a handle or point (arrow keys; Shift for 10×). */
export function nudgeHandle(curve: EaseCurve, ref: HandleRef, dx: number, dy: number): EaseCurve {
	const at = handlePosition(curve, ref);
	if (!at) return curve;
	return dragHandle(curve, ref, [at[0] + dx, at[1] + dy], { alt: true, shift: false }, at);
}

const bez = (t: number, a: number, b: number, c: number, d: number) => {
	const s = 1 - t;
	return s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d;
};
const lerp = (a: Vec, b: Vec, t: number): [number, number] => [
	a[0] + (b[0] - a[0]) * t,
	a[1] + (b[1] - a[1]) * t,
];

/**
 * Adds a point on the curve at time fraction `x` by splitting the piece there (the shape does not change). A cubic
 * becomes a three-point multi curve. Null when `x` is too close to an existing point or the curve is full.
 */
export function addPoint(curve: EaseCurve, x: number): { curve: MultiEase; index: number } | null {
	if (!Number.isFinite(x)) return null;
	const pieces = easeCurveSegments(curve);
	const count = curve.kind === 'cubic' ? 2 : curve.points.length;
	if (count >= MAX_EASE_POINTS) return null;
	const k = pieces.findIndex((s) => x > s[0][0] + POINT_GAP && x < s[3][0] - POINT_GAP);
	if (k < 0) return null;
	const [p0, p1, p2, p3] = pieces[k]!;
	let lo = 0;
	let hi = 1;
	for (let n = 0; n < 60; n++) {
		const mid = (lo + hi) / 2;
		if (bez(mid, p0[0], p1[0], p2[0], p3[0]) < x) lo = mid;
		else hi = mid;
	}
	const t = (lo + hi) / 2;
	const p01 = lerp(p0, p1, t);
	const p12 = lerp(p1, p2, t);
	const p23 = lerp(p2, p3, t);
	const p012 = lerp(p01, p12, t);
	const p123 = lerp(p12, p23, t);
	const mid = lerp(p012, p123, t);
	const points: EaseCurvePoint[] =
		curve.kind === 'cubic'
			? [
					{ x: 0, y: 0 },
					{ x: 1, y: 1 },
				]
			: curve.points.map(copyPoint);
	const a = points[k]!;
	const b = points[k + 1]!;
	a.out = p01;
	b.in = p23;
	points.splice(k + 1, 0, { x: mid[0], y: mid[1], in: p012, out: p123 });
	return { curve: sanitizeMulti(points), index: k + 1 };
}

/** Removes interior point `index`; a multi curve left with its two end points becomes a cubic. */
export function removePoint(curve: EaseCurve, index: number): EaseCurve {
	if (curve.kind !== 'multi') return curve;
	if (index <= 0 || index >= curve.points.length - 1) return curve;
	const pts = curve.points.map(copyPoint);
	pts.splice(index, 1);
	return pts.length <= 2 ? cubicFromEnds(pts) : sanitizeMulti(pts);
}

/** Interior point of a multi curve nearest to `x` within `tol` (time fraction), else -1. */
export function pointNear(curve: EaseCurve, x: number, tol: number): number {
	if (curve.kind !== 'multi') return -1;
	let best = -1;
	let dist = tol;
	curve.points.forEach((p, i) => {
		if (i === 0 || i === curve.points.length - 1) return;
		const d = Math.abs(p.x - x);
		if (d <= dist) {
			dist = d;
			best = i;
		}
	});
	return best;
}

/**
 * Mirror: the symmetric curve (point-symmetric about (½, ½)) built from its first half — the first handle of a
 * cubic, the points before the middle of a multi curve.
 */
export function mirrorCurve(curve: EaseCurve): EaseCurve {
	if (curve.kind === 'cubic') return { ...curve, x2: 1 - curve.x1, y2: clampY(1 - curve.y1) };
	const flip = (h: readonly [number, number]): [number, number] => [1 - h[0], clampY(1 - h[1])];
	const pts = curve.points.map(copyPoint);
	const left = pts.filter((p) => p.x < 0.5 - POINT_GAP);
	const mid = pts.find((p) => Math.abs(p.x - 0.5) <= POINT_GAP && p.x !== 0 && p.x !== 1);
	const half = left.length + (mid ? 1 : 0);
	if (2 * left.length + (mid ? 1 : 0) > MAX_EASE_POINTS || half === 0) return curve;
	const lastLeft = left[left.length - 1]!;
	if (!mid && lastLeft.out) lastLeft.out = [Math.min(lastLeft.out[0], 0.5), lastLeft.out[1]];
	const right = left
		.slice()
		.reverse()
		.map(
			(p): EaseCurvePoint => ({
				x: 1 - p.x,
				y: clampY(1 - p.y),
				...(p.out ? { in: flip(p.out) } : {}),
				...(p.in ? { out: flip(p.in) } : {}),
			}),
		);
	const centre: EaseCurvePoint[] = mid
		? [
				{
					x: 0.5,
					y: 0.5,
					...(mid.in ? { in: [mid.in[0], mid.in[1]] as [number, number], out: flip(mid.in) } : {}),
				},
			]
		: [];
	const points = [...left, ...centre, ...right];
	if (points.length < 3) return cubicFromEnds(points);
	return sanitizeMulti(points);
}

export type CubicField = 'x1' | 'y1' | 'x2' | 'y2';

/** A numeric field of a cubic: x clamped to 0…1, y to the limit. */
export function setCubicField(c: CubicEase, field: CubicField, value: number): CubicEase {
	if (!Number.isFinite(value)) return c;
	return { ...c, [field]: field[0] === 'x' ? clampX(value) : clampY(value) };
}

export type PointField = 'x' | 'y' | 'inX' | 'inY' | 'outX' | 'outY';

/** A numeric field of a multi-curve point (end points keep their position; handles are clamped). */
export function setPointField(c: MultiEase, index: number, field: PointField, value: number): MultiEase {
	if (!Number.isFinite(value) || !c.points[index]) return c;
	const pts = c.points.map(copyPoint);
	const p = pts[index]!;
	if (field === 'x' || field === 'y') {
		if (index === 0 || index === pts.length - 1) return c;
		p[field] = value;
	} else {
		const side = field.startsWith('in') ? 'in' : 'out';
		const h = p[side] ?? defaultHandle(pts, index, side);
		if (!h) return c;
		p[side] = field.endsWith('X') ? [value, h[1]] : [h[0], value];
	}
	return sanitizeMulti(pts);
}

const round = (v: number, digits: number) => {
	const r = Number(v.toFixed(digits));
	return Object.is(r, -0) ? 0 : r;
};

/** `cubic-bezier(0.25, 0.1, 0.25, 1)` — CSS syntax, up to `digits` decimals. */
export function formatCubicBezier(c: CubicEase, digits = 3): string {
	return `cubic-bezier(${[c.x1, c.y1, c.x2, c.y2].map((v) => round(v, digits)).join(', ')})`;
}

/** CSS timing-function keywords (CSS Easing Functions Level 1, §2.2). */
const CSS_KEYWORDS: Record<string, readonly [number, number, number, number]> = {
	linear: [1 / 3, 1 / 3, 2 / 3, 2 / 3],
	ease: [0.25, 0.1, 0.25, 1],
	'ease-in': [0.42, 0, 1, 1],
	'ease-out': [0, 0, 0.58, 1],
	'ease-in-out': [0.42, 0, 0.58, 1],
};

export type CubicParse = { ok: true; curve: CubicEase } | { ok: false; error: string };

const MAX_TEXT = 200;

/**
 * Reads `cubic-bezier(a, b, c, d)`, a bare `a, b, c, d` / `[a, b, c, d]` / `a b c d`, or a CSS keyword (`ease-in`…).
 * x values must lie in 0…1 and y values within ±EASE_Y_LIMIT.
 */
export function parseCubicBezier(text: string): CubicParse {
	const t = String(text ?? '').trim();
	if (!t) return { ok: false, error: 'Enter cubic-bezier(x1, y1, x2, y2)' };
	if (t.length > MAX_TEXT) return { ok: false, error: 'The text is too long' };
	const name = t.toLowerCase().replace(/;$/, '');
	const keyword = Object.hasOwn(CSS_KEYWORDS, name) ? CSS_KEYWORDS[name] : undefined;
	if (keyword) {
		const [x1, y1, x2, y2] = keyword;
		return { ok: true, curve: { kind: 'cubic', x1, y1, x2, y2 } };
	}
	const m = /^(?:cubic-bezier\s*)?[([]?\s*([^()[\]]*?)\s*[)\]]?\s*;?$/i.exec(t);
	const body = m?.[1];
	if (body === undefined) return { ok: false, error: 'Enter cubic-bezier(x1, y1, x2, y2)' };
	const parts = body.split(/\s*,\s*|\s+/).filter((s) => s !== '');
	const nums = parts.map((s) => (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? Number(s) : Number.NaN));
	if (nums.length !== 4 || nums.some((v) => !Number.isFinite(v)))
		return { ok: false, error: 'Enter four numbers: cubic-bezier(x1, y1, x2, y2)' };
	const [x1, y1, x2, y2] = nums as [number, number, number, number];
	if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return { ok: false, error: 'x1 and x2 must be between 0 and 1' };
	if (Math.abs(y1) > EASE_Y_LIMIT || Math.abs(y2) > EASE_Y_LIMIT)
		return { ok: false, error: `y1 and y2 must be between −${EASE_Y_LIMIT} and ${EASE_Y_LIMIT}` };
	return { ok: true, curve: { kind: 'cubic', x1, y1, x2, y2 } };
}

/** Same shape within `tol` (cubic values, or every point and handle of a multi curve). */
export function curvesEqual(a: EaseCurve | null, b: EaseCurve | null, tol = 1e-9): boolean {
	if (!a || !b) return a === b;
	if (a.kind !== b.kind) return false;
	const near = (u: number, v: number) => Math.abs(u - v) <= tol;
	if (a.kind === 'cubic') {
		const c = b as CubicEase;
		return near(a.x1, c.x1) && near(a.y1, c.y1) && near(a.x2, c.x2) && near(a.y2, c.y2);
	}
	const m = b as MultiEase;
	if (a.points.length !== m.points.length) return false;
	const sa = easeCurveSegments(a);
	const sb = easeCurveSegments(m);
	return sa.every((s, i) => s.every((p, j) => near(p[0], sb[i]![j]![0]) && near(p[1], sb[i]![j]![1])));
}

/** Lowest and highest y the curve reaches (handles included), for the view's vertical range. */
export function curveYRange(curve: EaseCurve): { min: number; max: number } {
	let min = 0;
	let max = 1;
	for (const s of easeCurveSegments(curve))
		for (const p of s) {
			min = Math.min(min, p[1]);
			max = Math.max(max, p[1]);
		}
	return { min, max };
}

/** The editor's own undo / redo (separate from document History). */
export type CurveHistory = { past: EaseCurve[]; present: EaseCurve; future: EaseCurve[] };

const HISTORY_LIMIT = 100;

export const historyInit = (present: EaseCurve): CurveHistory => ({ past: [], present, future: [] });

/** Records `next` as a new step (no-op when it equals the present); clears the redo stack. */
export function historyPush(h: CurveHistory, next: EaseCurve): CurveHistory {
	if (curvesEqual(h.present, next)) return h;
	return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

export function historyUndo(h: CurveHistory): CurveHistory {
	const prev = h.past[h.past.length - 1];
	if (!prev) return h;
	return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function historyRedo(h: CurveHistory): CurveHistory {
	const next = h.future[0];
	if (!next) return h;
	return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: h.future.slice(1) };
}
