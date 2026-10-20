// Ease curves (keyframe assistant): a normalised curve from (0, 0) to (1, 1) laid over keyframe segments, x = the
// fraction of the span's time, y = the fraction of its value change. A `cubic` curve is CSS cubic-bezier(x1, y1, x2,
// y2) over one segment; a `multi` curve spans several segments and creates keys at its interior points (bounce,
// elastic, anticipation). The keyframe model stores {influence, slope} per side (schema/common.ts), so a segment from
// key A to key B maps exactly: x1 = A.out.influence, y1 = x1 · A.out.slope, x2 = 1 − B.in.influence,
// y2 = 1 − (1 − x2) · B.in.slope (`bezierProgress` in keyframes.ts). Influence must be > 0: a handle at x = 0 (or
// x2 = 1) is stored at MIN_EASE_INFLUENCE with the same y, the closest the model can hold.
import { z } from 'zod';
import type { Ease } from '../schema/common.ts';

/** Smallest stored influence (After Effects' 0.1 %). */
export const MIN_EASE_INFLUENCE = 0.001;
/** Bound on curve y (progress) values: ±10× the value change covers every published overshoot / elastic curve. */
export const EASE_Y_LIMIT = 10;
/** Most points a multi-segment curve may carry (first and last included). */
export const MAX_EASE_POINTS = 64;

const unit = z.number().min(0).max(1);
const progress = z.number().min(-EASE_Y_LIMIT).max(EASE_Y_LIMIT);

export const CubicEaseSchema = z.strictObject({
	kind: z.literal('cubic'),
	x1: unit,
	y1: progress,
	x2: unit,
	y2: progress,
});
export type CubicEase = z.infer<typeof CubicEaseSchema>;

/** A handle position, absolute in the curve's normalised space. */
const HandleSchema = z.tuple([unit, progress]);

/**
 * A point of a multi-segment curve. `in` / `out` are the handles toward the previous / next point; a missing handle
 * is linear (one third of the way toward the neighbour along the straight chord).
 */
export const EaseCurvePointSchema = z.strictObject({
	x: unit,
	y: progress,
	in: HandleSchema.optional(),
	out: HandleSchema.optional(),
});
export type EaseCurvePoint = z.infer<typeof EaseCurvePointSchema>;

export const MultiEaseSchema = z
	.strictObject({
		kind: z.literal('multi'),
		points: z.array(EaseCurvePointSchema).min(3).max(MAX_EASE_POINTS),
	})
	.superRefine((curve, ctx) => {
		const pts = curve.points;
		const first = pts[0];
		const last = pts[pts.length - 1];
		if (!first || first.x !== 0 || first.y !== 0)
			ctx.addIssue({ code: 'custom', path: ['points', 0], message: 'the first point must be (0, 0)' });
		if (!last || last.x !== 1 || last.y !== 1)
			ctx.addIssue({
				code: 'custom',
				path: ['points', pts.length - 1],
				message: 'the last point must be (1, 1)',
			});
		for (let i = 0; i < pts.length; i++) {
			const p = pts[i] as EaseCurvePoint;
			const prev = pts[i - 1];
			const next = pts[i + 1];
			if (prev && !(p.x > prev.x))
				ctx.addIssue({ code: 'custom', path: ['points', i, 'x'], message: 'point x must increase strictly' });
			if (p.out && next && !(p.out[0] > p.x && p.out[0] <= next.x))
				ctx.addIssue({
					code: 'custom',
					path: ['points', i, 'out'],
					message: 'an out handle must lie after its point and not past the next point',
				});
			if (p.in && prev && !(p.in[0] < p.x && p.in[0] >= prev.x))
				ctx.addIssue({
					code: 'custom',
					path: ['points', i, 'in'],
					message: 'an in handle must lie before its point and not before the previous point',
				});
		}
	});
export type MultiEase = z.infer<typeof MultiEaseSchema>;

export const EaseCurveSchema = z.union([CubicEaseSchema, MultiEaseSchema]);
export type EaseCurve = CubicEase | MultiEase;

/**
 * Which segments of a keyframe selection an ease goes to (per property, keys sorted by time): `in` = the segment
 * into the first selected key, `middle` = the segments between consecutive selected keys, `out` = the segment after
 * the last selected key.
 */
export const EASE_SECTIONS = ['in', 'middle', 'out'] as const;
export const EaseSectionSchema = z.enum(EASE_SECTIONS);
export type EaseSection = z.infer<typeof EaseSectionSchema>;

/** A named curve in the built-in catalog or a user library. */
export const EasePresetSchema = z.strictObject({
	id: z.string().min(1).max(200),
	name: z.string().min(1).max(200),
	group: z.string().min(1).max(200),
	curve: EaseCurveSchema,
});
export type EasePreset = z.infer<typeof EasePresetSchema>;

const finiteOr = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
const clampInfluence = (v: number) =>
	Math.min(1, Math.max(MIN_EASE_INFLUENCE, finiteOr(v, MIN_EASE_INFLUENCE)));

/** cubic-bezier(x1, y1, x2, y2) → the out ease of the segment's first key and the in ease of its last key. */
export function cubicToEases(curve: CubicEase): { easeOut: Ease; easeIn: Ease } {
	const outInfluence = clampInfluence(curve.x1);
	const inInfluence = clampInfluence(1 - curve.x2);
	return {
		easeOut: { influence: outInfluence, slope: finiteOr(curve.y1, 0) / outInfluence },
		easeIn: { influence: inInfluence, slope: (1 - finiteOr(curve.y2, 1)) / inInfluence },
	};
}

/** The segment's eases → cubic-bezier(x1, y1, x2, y2), the exact inverse of `cubicToEases` for stored eases. */
export function easesToCubic(easeOut: Ease, easeIn: Ease): CubicEase {
	const outInfluence = clampInfluence(easeOut.influence);
	const inInfluence = clampInfluence(easeIn.influence);
	return {
		kind: 'cubic',
		x1: outInfluence,
		y1: outInfluence * finiteOr(easeOut.slope, 0),
		x2: 1 - inInfluence,
		y2: 1 - inInfluence * finiteOr(easeIn.slope, 0),
	};
}

/** One cubic Bézier piece of a curve: start, its out handle, the end's in handle, end — [x, y] each. */
export type EaseSegment = readonly [
	readonly [number, number],
	readonly [number, number],
	readonly [number, number],
	readonly [number, number],
];

/** The curve as cubic pieces in order, missing multi-curve handles filled in as linear (one third along the chord). */
export function easeCurveSegments(curve: EaseCurve): EaseSegment[] {
	if (curve.kind === 'cubic')
		return [
			[
				[0, 0],
				[curve.x1, curve.y1],
				[curve.x2, curve.y2],
				[1, 1],
			],
		];
	const out: EaseSegment[] = [];
	for (let i = 0; i + 1 < curve.points.length; i++) {
		const a = curve.points[i] as EaseCurvePoint;
		const b = curve.points[i + 1] as EaseCurvePoint;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		out.push([
			[a.x, a.y],
			a.out ? [a.out[0], a.out[1]] : [a.x + dx / 3, a.y + dy / 3],
			b.in ? [b.in[0], b.in[1]] : [b.x - dx / 3, b.y - dy / 3],
			[b.x, b.y],
		]);
	}
	return out;
}

const bez = (t: number, p0: number, p1: number, p2: number, p3: number) => {
	const s = 1 - t;
	return s * s * s * p0 + 3 * s * s * t * p1 + 3 * s * t * t * p2 + t * t * t * p3;
};

/**
 * Progress y at time fraction x ∈ [0, 1] (clamped). Each piece's x(t) is monotone because its handles stay inside
 * the piece's x range, so bisection finds the unique t (to below 1e-15 in 64 halvings).
 */
export function evaluateEaseCurve(curve: EaseCurve, x: number): number {
	const u = Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
	const segments = easeCurveSegments(curve);
	let seg = segments[segments.length - 1] as EaseSegment;
	for (const s of segments) {
		if (u <= s[3][0]) {
			seg = s;
			break;
		}
	}
	const [p0, p1, p2, p3] = seg;
	if (u <= p0[0]) return p0[1];
	if (u >= p3[0]) return p3[1];
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 64; i++) {
		const mid = (lo + hi) / 2;
		if (bez(mid, p0[0], p1[0], p2[0], p3[0]) < u) lo = mid;
		else hi = mid;
	}
	return bez((lo + hi) / 2, p0[1], p1[1], p2[1], p3[1]);
}
