// Value / Velocity graph math for Effect Controls (S03:KF-022, S05:ECP-006). Pure helpers: curves are
// *sampled* from the shared `evaluate()` (S01:KF-009; never re-implemented here, so the graphs follow
// any change to the evaluator such as spatial vec2 paths), velocity is its numeric derivative, and
// direction handles convert to and from the stored eases (influence + normalised slope, S01:KF-003).
//
// Units: the x axis is the (fractional) sequence frame, like the mini-timeline lanes; velocities are
// value units per second of sequence time (signed for numbers, speed along the path for vec2).
import {
	type Animatable,
	type Clip,
	type Command,
	EASE_PRESETS,
	type Ease,
	type EvaluateOptions,
	evaluate,
	flicksPerFrame,
	type Interpolation,
	incomingEase,
	type Keyframe,
	outgoingEase,
	type PropertySpec,
	type Rational,
} from '@jasper/project';
import type { Range } from './lib.ts';

type Kf = Keyframe<unknown>;
type Anim = Animatable<unknown>;
export type Side = 'in' | 'out';
type GraphKind = 'number' | 'vec2';
/** One sampled point: x = sequence frame, y = value (or velocity). */
export type Pt = { x: number; y: number };

const LINEAR: Ease = EASE_PRESETS.linear;
const MIN_INFLUENCE = 0.01;
const MAX_INFLUENCE = 1;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Properties with graphs: continuously animatable numbers and vec2 (S03:EC-005 "twirl if it has graphs"). */
export function graphKindOf(spec: Pick<PropertySpec, 'kind' | 'animatable'>): GraphKind | null {
	if (spec.animatable !== 'continuous') return null;
	return spec.kind === 'number' || spec.kind === 'vec2' ? spec.kind : null;
}

/** Numeric components of a value: `[v]` for numbers, `[x, y]` for vec2. */
export function componentsOf(v: unknown): number[] {
	if (typeof v === 'number') return [v];
	if (Array.isArray(v)) return v.map((x) => Number(x));
	return [];
}

// ---------------------------------------------------------------- time mapping

/** Content time (flicks) ↔ sequence frame of one clip (mirrors `exactFrameOf`, S01:KF-002). */
type TimeMap = {
	toX(time: number): number;
	toTime(x: number): number;
	/** Flicks of content time per sequence frame along +x (negative on reversed clips). */
	flicksPerX: number;
	fps: number;
};

export function timeMapOf(
	clip: Pick<Clip, 'start' | 'duration' | 'sourceIn'> & { speed: { rate: number; reverse?: boolean } },
	rate: Rational,
): TimeMap {
	const step = flicksPerFrame(rate) * clip.speed.rate;
	const rev = !!clip.speed.reverse;
	const last = clip.start + clip.duration - 1;
	return {
		toX: (t) => {
			const i = (t - clip.sourceIn) / step;
			return rev ? last - i : clip.start + i;
		},
		toTime: (x) => clip.sourceIn + (rev ? last - x : x - clip.start) * step,
		flicksPerX: rev ? -step : step,
		fps: rate.num / rate.den,
	};
}

// ---------------------------------------------------------------- sampling

/** Samples per segment: about one every 2 px, at least 4, at most 400 (0 when off-screen). */
function samplesFor(xa: number, xb: number, range: Range, width: number): number {
	const lo = Math.min(xa, xb);
	const hi = Math.max(xa, xb);
	if (hi < range.start || lo > range.end) return 1;
	const px = ((hi - lo) / Math.max(1e-9, range.end - range.start)) * width;
	return clamp(Math.ceil(px / 2), 4, 400);
}

/**
 * Value curves, one per component (S03:KF-022 "Value graph"; vec2 shows X and Y). Points are in time
 * order mapped to x and sorted by x; hold steps get a point just before the next key.
 */
export function sampleValueCurves(
	anim: Anim,
	map: TimeMap,
	range: Range,
	width: number,
	opts?: EvaluateOptions,
): Pt[][] {
	const kfs = anim.keyframes;
	const times: number[] = [map.toTime(range.start), map.toTime(range.end)];
	for (let j = 0; j < kfs.length; j++) {
		const k = kfs[j]!;
		times.push(k.time);
		const next = kfs[j + 1];
		if (!next) continue;
		const T = next.time - k.time;
		const m = samplesFor(map.toX(k.time), map.toX(next.time), range, width);
		for (let s = 1; s < m; s++) times.push(k.time + (T * s) / m);
		times.push(next.time - T * 1e-6); // hold steps stay vertical
	}
	const pts = times
		.map((t) => ({ x: map.toX(t), v: componentsOf(evaluate(anim, t, opts)) }))
		.sort((a, b) => a.x - b.x);
	const dims = pts[0]?.v.length ?? 0;
	return Array.from({ length: dims }, (_, d) => pts.map((p) => ({ x: p.x, y: p.v[d]! })));
}

/** Display velocity (units / second) between two content times; signed for numbers, speed for vec2. */
function rateBetween(anim: Anim, t1: number, t2: number, map: TimeMap, opts?: EvaluateOptions): number {
	const a = componentsOf(evaluate(anim, t1, opts));
	const b = componentsOf(evaluate(anim, t2, opts));
	const perFlick = 1 / (t2 - t1);
	if (a.length === 1) return (b[0]! - a[0]!) * perFlick * map.flicksPerX * map.fps;
	let s = 0;
	for (let i = 0; i < a.length; i++) s += (b[i]! - a[i]!) ** 2;
	return Math.sqrt(s) * perFlick * Math.abs(map.flicksPerX) * map.fps;
}

const H = 1e-3; // derivative step as a fraction of the segment duration

/**
 * Velocity curve (S03:KF-022 "Velocity graph"): the numeric derivative of `evaluate()` per segment,
 * one-sided at the keys so in/out speed jumps show as vertical steps. Zero outside the keys and on holds.
 */
export function sampleVelocityCurve(
	anim: Anim,
	map: TimeMap,
	range: Range,
	width: number,
	opts?: EvaluateOptions,
): Pt[] {
	const kfs = anim.keyframes;
	if (kfs.length < 2) return [];
	const out: { t: number; y: number }[] = [];
	const first = kfs[0]!;
	const last = kfs[kfs.length - 1]!;
	out.push({ t: Math.min(first.time, map.toTime(range.start), map.toTime(range.end)), y: 0 });
	out.push({ t: first.time, y: 0 });
	for (let j = 0; j < kfs.length - 1; j++) {
		const a = kfs[j]!;
		const b = kfs[j + 1]!;
		const T = b.time - a.time;
		if (T <= 0) continue;
		if (a.interpolation === 'hold' || opts?.holdOnly) {
			out.push({ t: a.time, y: 0 }, { t: b.time, y: 0 });
			continue;
		}
		const m = samplesFor(map.toX(a.time), map.toX(b.time), range, width);
		for (let s = 0; s <= m; s++) {
			const u = s / m;
			const lo = Math.max(0, u - H);
			const hi = Math.min(1, u + H);
			out.push({ t: a.time + u * T, y: rateBetween(anim, a.time + lo * T, a.time + hi * T, map, opts) });
		}
	}
	out.push({ t: last.time, y: 0 });
	out.push({ t: Math.max(last.time, map.toTime(range.start), map.toTime(range.end)), y: 0 });
	const pts = out.map((p) => ({ x: map.toX(p.t), y: p.y }));
	return map.flicksPerX < 0 ? pts.reverse() : pts;
}

// ---------------------------------------------------------------- handles

/** The segment a side of key `i` shapes: `[a, b]` indices, or null at the ends / on holds. */
function segmentOf(kfs: readonly Kf[], i: number, side: Side): [number, number] | null {
	const [a, b] = side === 'out' ? [i, i + 1] : [i - 1, i];
	if (a < 0 || b >= kfs.length) return null;
	if (kfs[a]!.interpolation === 'hold') return null;
	return [a, b];
}

/**
 * Ease the evaluator actually uses on one side of key `i`. A segment leaving a Linear key is linear
 * whatever its end key stores, so the arriving side then reads as the linear-equivalent ease.
 */
export function effectiveEase(kfs: readonly Kf[], i: number, side: Side): Ease {
	if (side === 'out') return outgoingEase(kfs, i);
	const prev = kfs[i - 1];
	if (prev && prev.interpolation === 'linear') return LINEAR;
	return incomingEase(kfs, i);
}

/**
 * Display velocity at key `i` per unit of slope on one side, measured from `evaluate()` on a copy whose
 * segment is linear-equivalent (progress = u, so the derivative at the key is exactly the unit). This
 * follows whatever distance the evaluator normalises by (straight or spatial paths).
 */
export function unitVelocity(anim: Anim, i: number, side: Side, map: TimeMap): number {
	const seg = segmentOf(anim.keyframes, i, side);
	if (!seg) return 0;
	const [ai, bi] = seg;
	const kfs = anim.keyframes.map((k, j) =>
		j === ai || j === bi
			? { ...k, interpolation: 'bezier' as Interpolation, easeIn: { ...LINEAR }, easeOut: { ...LINEAR } }
			: k,
	);
	const probe = { value: anim.value, keyframes: kfs };
	const a = kfs[ai]!;
	const b = kfs[bi]!;
	const h = (b.time - a.time) * H;
	return side === 'out'
		? rateBetween(probe, a.time, a.time + h, map)
		: rateBetween(probe, b.time - h, b.time, map);
}

export type VelocityHandle = {
	side: Side;
	/** Key index the handle belongs to and the neighbour at the other end of its segment. */
	key: number;
	other: number;
	ease: Ease;
	/** Display velocity per unit slope (0 when the segment has no value change). */
	unit: number;
	/** Velocity at the key on this side (units / s). */
	velocity: number;
	/** Handle tip x (sequence frame): the influence fraction of the segment, measured from the key. */
	tipX: number;
};

/** Velocity-graph direction handles of key `i` (in, out) for the sides that are interpolated. */
export function velocityHandles(anim: Anim, i: number, map: TimeMap): VelocityHandle[] {
	const kfs = anim.keyframes;
	const k = kfs[i]!;
	const out: VelocityHandle[] = [];
	for (const side of ['in', 'out'] as const) {
		const seg = segmentOf(kfs, i, side);
		if (!seg) continue;
		const other = side === 'out' ? seg[1] : seg[0];
		const ease = effectiveEase(kfs, i, side);
		const unit = unitVelocity(anim, i, side, map);
		const span = kfs[other]!.time - k.time;
		out.push({
			side,
			key: i,
			other,
			ease,
			unit,
			velocity: ease.slope * unit,
			tipX: map.toX(k.time + ease.influence * span),
		});
	}
	return out;
}

/** Influence from a handle tip x (fraction of the segment from the key), clamped to 0.01..1 (KF-022). */
function influenceAt(kfs: readonly Kf[], i: number, other: number, tipX: number, map: TimeMap): number {
	const k = kfs[i]!;
	const span = kfs[other]!.time - k.time;
	if (span === 0) return MIN_INFLUENCE;
	return clamp((map.toTime(tipX) - k.time) / span, MIN_INFLUENCE, MAX_INFLUENCE);
}

/**
 * New ease for a dragged velocity handle: x → influence, y (velocity) → slope. keyframes-blend: the slope may cross
 * zero (the key leaves backwards: anticipation) or exceed the segment's average (overshoot), as Premiere's handles
 * allow; the property's range still clamps the evaluated value.
 */
export function easeFromVelocityDrag(
	anim: Anim,
	h: Pick<VelocityHandle, 'key' | 'other' | 'unit' | 'ease'>,
	tipX: number,
	velocity: number,
	map: TimeMap,
): Ease {
	const influence = influenceAt(anim.keyframes, h.key, h.other, tipX, map);
	const slope = h.unit === 0 ? h.ease.slope : velocity / h.unit;
	return { influence, slope: Number.isFinite(slope) ? slope : h.ease.slope };
}

export type ValueHandle = { side: Side; key: number; other: number; ease: Ease; tipX: number; tipY: number };

/**
 * Value-graph Bezier handles of a numeric key (S03:KF-022): the cubic control point of the segment in
 * value space, `influence · T` along time and `influence · slope · Δv` along the value.
 */
export function valueHandles(anim: Animatable<number>, i: number, map: TimeMap): ValueHandle[] {
	const kfs = anim.keyframes;
	const k = kfs[i]!;
	const out: ValueHandle[] = [];
	for (const side of ['in', 'out'] as const) {
		const seg = segmentOf(kfs as readonly Kf[], i, side);
		if (!seg) continue;
		const other = side === 'out' ? seg[1] : seg[0];
		const ease = effectiveEase(kfs as readonly Kf[], i, side);
		const o = kfs[other]!;
		out.push({
			side,
			key: i,
			other,
			ease,
			tipX: map.toX(k.time + ease.influence * (o.time - k.time)),
			tipY: k.value + ease.influence * ease.slope * (o.value - k.value),
		});
	}
	return out;
}

/** New ease for a dragged value-graph handle tip (inverse of `valueHandles`). */
export function easeFromValueDrag(
	anim: Animatable<number>,
	h: Pick<ValueHandle, 'key' | 'other' | 'ease'>,
	tipX: number,
	tipY: number,
	map: TimeMap,
): Ease {
	const kfs = anim.keyframes;
	const influence = influenceAt(kfs as readonly Kf[], h.key, h.other, tipX, map);
	const dv = kfs[h.other]!.value - kfs[h.key]!.value;
	if (dv === 0) return { influence, slope: h.ease.slope };
	const slope = (tipY - kfs[h.key]!.value) / (influence * dv);
	return { influence, slope: Number.isFinite(slope) ? slope : h.ease.slope };
}

// ---------------------------------------------------------------- vec2 value-graph handles (keyframes-blend)

/** Rate of change (component `d` per flick) at key `i` on one side, one-sided, from `evaluate()`. */
function componentRate(anim: Anim, i: number, other: number, d: number): number {
	const k = anim.keyframes[i]!;
	const o = anim.keyframes[other]!;
	// A short one-sided step (1e-6 of the segment): the tangent, not a chord.
	const h = (o.time - k.time) * 1e-6;
	if (h === 0) return 0;
	const a = componentsOf(evaluate(anim, k.time))[d]!;
	const b = componentsOf(evaluate(anim, k.time + h))[d]!;
	return (b - a) / h;
}

export type Vec2ValueHandle = ValueHandle & {
	/** The component (0 = X, 1 = Y) whose curve the handle sits on. */
	dim: number;
	/** The key's value of that component. */
	keyY: number;
	/** Rate of change of the component (per flick, towards the other key) per unit of slope. */
	unitRate: number;
};

/**
 * Value-graph Bezier handles of a vec2 key, one per side and component (keyframes-blend): tangent to the evaluated
 * X / Y curve at the key (`evaluate()`, so curved spatial paths work too), `influence · T` long in time. Both
 * components share the key's one temporal ease (speed along the path), so dragging either edits that ease.
 */
export function vec2ValueHandles(anim: Anim, i: number, map: TimeMap): Vec2ValueHandle[] {
	const kfs = anim.keyframes;
	const k = kfs[i]!;
	const v = componentsOf(k.value);
	if (v.length !== 2) return [];
	const out: Vec2ValueHandle[] = [];
	for (const side of ['in', 'out'] as const) {
		const seg = segmentOf(kfs, i, side);
		if (!seg) continue;
		const other = side === 'out' ? seg[1] : seg[0];
		const ease = effectiveEase(kfs, i, side);
		const span = kfs[other]!.time - k.time;
		// The linear-equivalent probe gives the rate per unit slope (as `unitVelocity`).
		const [ai, bi] = seg;
		const probe = {
			value: anim.value,
			keyframes: kfs.map((x, j) =>
				j === ai || j === bi
					? { ...x, interpolation: 'bezier' as Interpolation, easeIn: { ...LINEAR }, easeOut: { ...LINEAR } }
					: x,
			),
		};
		for (let d = 0; d < 2; d++) {
			const rate = componentRate(anim, i, other, d);
			out.push({
				side,
				key: i,
				other,
				ease,
				dim: d,
				keyY: v[d]!,
				unitRate: componentRate(probe, i, other, d),
				tipX: map.toX(k.time + ease.influence * span),
				tipY: v[d]! + rate * ease.influence * span,
			});
		}
	}
	return out;
}

/** New ease for a dragged vec2 value-graph handle (inverse of `vec2ValueHandles`). */
export function easeFromVec2ValueDrag(
	anim: Anim,
	h: Pick<Vec2ValueHandle, 'key' | 'other' | 'ease' | 'keyY' | 'unitRate'>,
	tipX: number,
	tipY: number,
	map: TimeMap,
): Ease {
	const kfs = anim.keyframes;
	const influence = influenceAt(kfs, h.key, h.other, tipX, map);
	const span = kfs[h.other]!.time - kfs[h.key]!.time;
	// A component that does not change along the segment has no speed scale: only the influence changes.
	if (span === 0 || Math.abs(h.unitRate * span) < 1e-9) return { influence, slope: h.ease.slope };
	const slope = (tipY - h.keyY) / (influence * span) / h.unitRate;
	return { influence, slope: Number.isFinite(slope) ? slope : h.ease.slope };
}

// ---------------------------------------------------------------- vertical zoom (keyframes-blend)

/** Zooms a range about value `at` by `factor` (> 1 = zoom out). */
export function zoomRange(r: YRange, at: number, factor: number): YRange {
	const f = Math.min(1e6, Math.max(1e-6, factor));
	return { min: at - (at - r.min) * f, max: at + (r.max - at) * f };
}

/** Pans a range by `delta` value units. */
export function panRange(r: YRange, delta: number): YRange {
	return { min: r.min + delta, max: r.max + delta };
}

/**
 * Commands for a handle edit on one side of key `i` (S03:KF-022, S01:KF-004):
 * - Continuous Bezier keeps its in/out speeds linked (the handler matches the other side), unless
 *   `breakLink` (Alt/Option) converts the key to Bezier;
 * - Linear and Auto Bezier keys become Bezier, with the untouched side frozen at its current shape;
 * - Hold keys keep holding (only their arriving side is editable);
 * - an arriving segment that leaves a Linear key needs that key to be Bezier (linear-equivalent eases)
 *   for the new ease to show (also for linked edits of the leaving side); `keyframe.update` does this
 *   for Bezier targets, here for the others.
 */
export function planEaseEdit(
	kfs: readonly Kf[],
	i: number,
	side: Side,
	ease: Ease,
	breakLink: boolean,
): Command[] {
	const k = kfs[i]!;
	const prev = kfs[i - 1];
	const next = kfs[i + 1];
	const linked = k.interpolation === 'continuous-bezier' && !breakLink;
	const interpolation: Interpolation =
		k.interpolation === 'hold' ? 'hold' : linked ? 'continuous-bezier' : 'bezier';
	const cmds: Command[] = [];
	// Linked (continuous) edits move the arriving side too, so it must be visible as well.
	if ((side === 'in' || linked) && prev?.interpolation === 'linear' && interpolation !== 'bezier') {
		const before = kfs[i - 2];
		const keepIn = before && before.interpolation !== 'linear' && before.interpolation !== 'hold';
		cmds.push({
			type: 'keyframe.update',
			keyframeId: prev.id,
			interpolation: 'bezier',
			easeOut: { ...LINEAR },
			...(keepIn ? { easeIn: effectiveEase(kfs, i - 1, 'in') } : {}),
		} as Command);
	}
	const e = { influence: ease.influence, slope: ease.slope };
	const update: Record<string, unknown> = { type: 'keyframe.update', keyframeId: k.id, interpolation };
	update[side === 'in' ? 'easeIn' : 'easeOut'] = e;
	if (!linked && interpolation === 'bezier' && k.interpolation !== 'bezier') {
		// Freeze the other side at the shape it had (stored eases of Linear keys are not meaningful).
		if (side === 'in' && next) update.easeOut = effectiveEase(kfs, i, 'out');
		if (side === 'out' && prev && prev.interpolation !== 'linear')
			update.easeIn = effectiveEase(kfs, i, 'in');
	}
	cmds.push(update as Command);
	return cmds;
}

// ---------------------------------------------------------------- vertical range

export type YRange = { min: number; max: number };

/** Auto-fit vertical range with headroom (S03:KF-022); flat curves get a unit band around the value. */
export function fitRange(
	values: Iterable<number>,
	opts: { includeZero?: boolean; headroom?: number } = {},
): YRange {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const v of values) {
		if (!Number.isFinite(v)) continue;
		if (v < min) min = v;
		if (v > max) max = v;
	}
	if (opts.includeZero) {
		min = Math.min(min, 0);
		max = Math.max(max, 0);
	}
	if (min > max) return { min: -1, max: 1 };
	if (max - min < 1e-9) {
		const pad = Math.abs(max) * 0.1 || 1;
		return { min: min - pad, max: max + pad };
	}
	const pad = (max - min) * (opts.headroom ?? 0.1);
	return { min: min - pad, max: max + pad };
}

/** Pixel ↔ value helpers for one graph box. */
export function yScale(r: YRange, height: number) {
	const span = r.max - r.min || 1;
	return {
		toPx: (v: number) => ((r.max - v) / span) * height,
		perPx: span / Math.max(1, height),
	};
}

/** Short label for an axis value (graph min/max at the left, S05:ECP-006). */
export function formatGraphValue(v: number, precision = 1): string {
	const p = Math.abs(v) >= 1000 ? 0 : precision;
	const s = v.toFixed(p);
	return s === `-${(0).toFixed(p)}` ? (0).toFixed(p) : s;
}

/** Rounds a dragged value to a hundredth of the property step. */
export function roundToStep(v: number, step = 1): number {
	const q = step / 100;
	const digits = Math.max(0, Math.ceil(-Math.log10(q)));
	return Number((Math.round(v / q) * q).toFixed(digits));
}

// ---------------------------------------------------------------- post-expression curves (wave expressions)

/**
 * Post-expression value curves (AE's "Show Post-Expression Graph"): an expression is any function of time, so the
 * curve is sampled evenly over the visible range (about one sample every 2 px, at most 600, plus the frames of the
 * keys) from the bound Animatable through the shared `evaluate()`.
 */
export function samplePostValueCurves(
	bound: Anim,
	map: TimeMap,
	range: Range,
	width: number,
	opts?: EvaluateOptions,
): Pt[][] {
	const n = clamp(Math.ceil(width / 2), 16, 600);
	const xs: number[] = [];
	for (let i = 0; i <= n; i++) xs.push(range.start + ((range.end - range.start) * i) / n);
	for (const k of bound.keyframes) {
		const x = map.toX(k.time);
		if (x > range.start && x < range.end) xs.push(x);
	}
	xs.sort((a, b) => a - b);
	const pts = xs.map((x) => ({ x, v: componentsOf(evaluate(bound, map.toTime(x), opts)) }));
	const dims = pts[0]?.v.length ?? 0;
	return Array.from({ length: dims }, (_, d) => pts.map((p) => ({ x: p.x, y: p.v[d] ?? 0 })));
}

/** Post-expression velocity (units / second, speed for vectors): central differences over the visible range. */
export function samplePostVelocityCurve(
	bound: Anim,
	map: TimeMap,
	range: Range,
	width: number,
	opts?: EvaluateOptions,
): Pt[] {
	const n = clamp(Math.ceil(width / 2), 16, 600);
	const out: Pt[] = [];
	const h = Math.max(1e-6, (range.end - range.start) / n / 4);
	for (let i = 0; i <= n; i++) {
		const x = range.start + ((range.end - range.start) * i) / n;
		out.push({ x, y: rateBetween(bound, map.toTime(x - h), map.toTime(x + h), map, opts) });
	}
	return out;
}
