// Document-level keyframe simplification (S09:TRK-023, S01:KF-010): turns animated parameters of a document into
// solver groups (`simplify.ts`) with the deviation that matters to the viewer, runs them and reports.
//
// - Geometry group (per clip): Motion (position, anchor, scale, scale width, rotation) and the clip's corner pin.
//   The deviation is the largest displacement, in sequence pixels, of the drawn layer's corners (the pinned quad's
//   corners and its centre when pinned): for an affine layer this bounds every point of the picture, because the
//   difference of two affine maps is affine and peaks at a corner of the box.
// - Value group (every other parameter): the distance in the parameter's own units (absolute value, Euclidean
//   for vectors). spatial-points: points normalised to their layer box measure it in the box's pixels (unit `px`),
//   and every effect point is evaluated with its spatial metric, as the renderers evaluate it.
// Samples: every frame the clip shows at its current timing, extended over the handles to the keys around the
// simplified span, plus every original key time. Pure; used by the `keyframes.simplify` command, `tracker.apply`
// (`simplify` option) and previews.
import { evaluate, isHoldOnlyValue } from '../keyframes.ts';
import type { SpatialMetric } from '../keyframes-spatial.ts';
import { effectParamMetric } from '../registry/effects.ts';
import { intrinsicBoxOf } from '../registry/properties.ts';
import { applyMat3, type Quad, unitSquareToQuad } from '../render/homography.ts';
import { CORNER_PIN_EFFECT_ID, CORNER_PIN_PARAMS } from '../render/scene.ts';
import { applyMatrix, layerMatrix } from '../render/transform.ts';
import type { Animatable, Keyframe, Vec2 } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, EffectInstance, Sequence, Transform } from '../schema/sequence.ts';
import { flicksPerFrame } from '../time.ts';
import { type SimplifyChannel, type SimplifyValue, simplifyKeyframes } from './simplify.ts';

/** Default tolerance (S09:TRK-023): 0.1 sequence px for geometry, 0.1 units otherwise. */
export const DEFAULT_SIMPLIFY_TOLERANCE = 0.1;

/** Grid (n×n over the picture) on which corner-pinned results are verified. */
const VERIFY_GRID = 9;

const MOTION_KEYS = ['position', 'anchor', 'scale', 'scaleWidth', 'rotation'] as const;
type MotionKey = (typeof MOTION_KEYS)[number];

/** One animated parameter to simplify. */
export type SimplifyTarget = {
	/** ParamPath (S01:CMD-010): ['clip', id, 'transform', 'position'], ['effect', fxId, 'topLeft'], … */
	path: readonly string[];
	anim: Animatable<unknown>;
	seq: Sequence;
	/** Owning clip (content-time keys), or null for track / master parameters (sequence time). */
	clip: Clip | null;
	/** Keys that may be removed (ids); undefined = all. The span runs from the first to the last of them. */
	selected?: ReadonlySet<string>;
	/** Unit of the value group (`px`, `%`, `deg`, …); geometry groups are always `px`. */
	unit?: string;
	label?: string;
};

export type SimplifyGroupReport = {
	kind: 'geometry' | 'value';
	clipId: string | null;
	/** `px` (sequence pixels) for geometry; the parameter's unit otherwise ('' when unitless). */
	unit: string;
	paths: string[][];
	samples: number;
	maxError: number;
	meanError: number;
	/** With `details`: deviation per sample (rounded to 1e-4) and the sample times (flicks). */
	errors?: number[];
	times?: number[];
};

export type SimplifyPropertyReport = {
	path: string[];
	label: string;
	unit: string;
	group: number;
	before: number;
	after: number;
};

export type SimplifyReport = {
	tolerance: number;
	before: number;
	after: number;
	removed: number;
	/** Largest deviation over all groups (each in its own unit). */
	maxError: number;
	properties: SimplifyPropertyReport[];
	groups: SimplifyGroupReport[];
	/** Parameters that were asked for but cannot be simplified (hold-only, fewer than 3 keys in the span). */
	skipped: { path: string[]; reason: string }[];
};

export type SimplifyPlan = {
	report: SimplifyReport;
	/** New keyframes per target (same order as the input; null = unchanged / skipped). */
	keys: (Keyframe<unknown>[] | null)[];
};

/** The Motion key of a ParamPath on a clip, or null. */
function motionKeyOf(t: SimplifyTarget): MotionKey | null {
	if (!t.clip || t.path[0] !== 'clip') return null;
	const key = t.path.slice(2).join('.');
	for (const k of MOTION_KEYS) if (key === `transform.${k}`) return k;
	return null;
}

/** The corner pin the renderer uses for a clip (first enabled one, else the first). */
function activePin(clip: Clip): EffectInstance | null {
	const effects = (clip as { effects?: EffectInstance[] }).effects ?? [];
	return (
		effects.find((e) => e.enabled && e.effectId === CORNER_PIN_EFFECT_ID) ??
		effects.find((e) => e.effectId === CORNER_PIN_EFFECT_ID) ??
		null
	);
}

function pinIndexOf(t: SimplifyTarget): number {
	if (!t.clip || t.path[0] !== 'effect') return -1;
	const pin = activePin(t.clip);
	if (!pin || t.path[1] !== pin.id) return -1;
	return (CORNER_PIN_PARAMS as readonly string[]).indexOf(t.path[2] ?? '');
}

/** Content-time sample grid of an owner: every sequence frame of the clip (extended), or every sequence frame. */
function gridTimes(seq: Sequence, clip: Clip | null, t0: number, t1: number): number[] {
	const F = flicksPerFrame(seq.settings.frameRate);
	const origin = clip ? clip.sourceIn : 0;
	const step = clip ? F * clip.speed.rate : F;
	const out: number[] = [];
	const k0 = Math.ceil((t0 - origin) / step - 1e-9);
	const k1 = Math.floor((t1 - origin) / step + 1e-9);
	for (let k = k0; k <= k1; k++) out.push(origin + k * step);
	return out;
}

/** Sorted unique union (merging times closer than 1e-6 flick). */
function mergeTimes(a: readonly number[], b: readonly number[]): number[] {
	const all = [...a, ...b].sort((x, y) => x - y);
	const out: number[] = [];
	for (const t of all) if (!out.length || t - out[out.length - 1]! > 1e-6) out.push(t);
	return out;
}

type Prepared = {
	target: SimplifyTarget;
	index: number;
	channel: SimplifyChannel;
	/** Verification window (flicks). */
	window: [number, number];
};

/**
 * spatial-points: the spatial metric of an effect point target (its layer box in pixels per unit: the clip's
 * intrinsic box, the sequence frame for track and master effects), else undefined.
 */
function targetMetric(doc: ProjectDocument, t: SimplifyTarget): SpatialMetric | undefined {
	if (t.path[0] !== 'effect') return undefined;
	const [, fxId, name] = t.path;
	const lists: (readonly EffectInstance[] | undefined)[] = t.clip
		? [(t.clip as { effects?: EffectInstance[] }).effects]
		: [...[...t.seq.videoTracks, ...t.seq.audioTracks].map((tr) => tr.effects), t.seq.master.effects];
	const fx = lists.flatMap((l) => l ?? []).find((e) => e.id === fxId);
	if (!fx || !name) return undefined;
	const box = t.clip
		? intrinsicBoxOf({ clip: t.clip, doc, seq: t.seq })
		: { width: t.seq.settings.width, height: t.seq.settings.height };
	return effectParamMetric(fx, name, box);
}

/** Checks a target and builds its solver channel, or returns why it cannot be simplified. */
function prepare(t: SimplifyTarget, index: number, metric?: SpatialMetric): Prepared | string {
	const keys = t.anim.keyframes as Keyframe<SimplifyValue>[];
	if (keys.length < 3) return 'fewer than 3 keyframes';
	if (keys.some((k) => isHoldOnlyValue(k.value))) return 'hold-only values cannot be simplified';
	const dims = new Set(keys.map((k) => (typeof k.value === 'number' ? 1 : (k.value as number[]).length)));
	if (dims.size !== 1) return 'keyframe values have different sizes';
	let i0 = 0;
	let i1 = keys.length - 1;
	let locked: Set<number> | undefined;
	if (t.selected) {
		const idx = keys.map((k, i) => (t.selected!.has(k.id) ? i : -1)).filter((i) => i >= 0);
		if (idx.length < 3) return 'fewer than 3 selected keyframes';
		i0 = idx[0]!;
		i1 = idx[idx.length - 1]!;
		locked = new Set<number>();
		for (let i = i0 + 1; i < i1; i++) if (!t.selected.has(keys[i]!.id)) locked.add(i);
	}
	const window: [number, number] = [
		keys[Math.max(0, i0 - 1)]!.time,
		keys[Math.min(keys.length - 1, i1 + 1)]!.time,
	];
	return {
		target: t,
		index,
		channel: { keys, span: [i0, i1], ...(locked?.size ? { locked } : {}), ...(metric ? { metric } : {}) },
		window,
	};
}

type GroupSpec = {
	kind: 'geometry' | 'value';
	clip: Clip | null;
	seq: Sequence;
	members: Prepared[];
};

/** Plans the simplification of `targets` with one tolerance (sequence px for geometry, units otherwise). */
export function planSimplify(
	doc: ProjectDocument,
	targets: readonly SimplifyTarget[],
	tolerance: number,
	opts: { details?: boolean } = {},
): SimplifyPlan {
	if (!(tolerance > 0) || !Number.isFinite(tolerance))
		throw new Error('The tolerance must be a positive number');
	const keys: (Keyframe<unknown>[] | null)[] = targets.map(() => null);
	const skipped: SimplifyReport['skipped'] = [];
	const groups: GroupSpec[] = [];
	const geometryByClip = new Map<string, GroupSpec>();
	const seen = new Set<string>();
	targets.forEach((t, i) => {
		const k = t.path.join('\u0000');
		if (seen.has(k)) return;
		seen.add(k);
		const p = prepare(t, i, targetMetric(doc, t));
		if (typeof p === 'string') {
			skipped.push({ path: [...t.path], reason: p });
			return;
		}
		const geometric = !!t.clip && 'transform' in t.clip && (motionKeyOf(t) !== null || pinIndexOf(t) >= 0);
		if (geometric) {
			let g = geometryByClip.get(t.clip!.id);
			if (!g) {
				g = { kind: 'geometry', clip: t.clip, seq: t.seq, members: [] };
				geometryByClip.set(t.clip!.id, g);
				groups.push(g);
			}
			g.members.push(p);
		} else groups.push({ kind: 'value', clip: t.clip, seq: t.seq, members: [p] });
	});

	const properties: SimplifyPropertyReport[] = [];
	const reports: SimplifyGroupReport[] = groups.map((g, gi) => {
		const w0 = Math.min(...g.members.map((m) => m.window[0]));
		const w1 = Math.max(...g.members.map((m) => m.window[1]));
		const keyTimes = g.members.flatMap((m) =>
			m.channel.keys.filter((k) => k.time >= w0 && k.time <= w1).map((k) => k.time),
		);
		const times = mergeTimes(gridTimes(g.seq, g.clip, w0, w1), keyTimes);
		const geometry = g.kind === 'geometry';
		const r = simplifyKeyframes({
			channels: g.members.map((m) => m.channel),
			times,
			deviation: geometry ? geometryDeviation(doc, g, times, 3) : valueDeviation(g.members[0]!, times),
			...(geometry ? { verify: geometryDeviation(doc, g, times, VERIFY_GRID) } : {}),
			tolerance,
		});
		g.members.forEach((m, j) => {
			keys[m.index] = r.keys[j]!;
			properties.push({
				path: [...m.target.path],
				label: m.target.label ?? m.target.path.slice(2).join('.'),
				unit: g.kind === 'geometry' || m.channel.metric ? 'px' : (m.target.unit ?? ''),
				group: gi,
				before: r.before[j]!,
				after: r.after[j]!,
			});
		});
		return {
			kind: g.kind,
			clipId: g.clip?.id ?? null,
			unit: g.kind === 'geometry' || g.members[0]!.channel.metric ? 'px' : (g.members[0]!.target.unit ?? ''),
			paths: g.members.map((m) => [...m.target.path]),
			samples: times.length,
			maxError: r.maxError,
			meanError: r.meanError,
			...(opts.details
				? { errors: Array.from(r.errors, (e) => Math.round(e * 1e4) / 1e4), times: [...times] }
				: {}),
		};
	});
	const before = properties.reduce((n, p) => n + p.before, 0);
	const after = properties.reduce((n, p) => n + p.after, 0);
	return {
		keys,
		report: {
			tolerance,
			before,
			after,
			removed: before - after,
			maxError: reports.reduce((m, r) => Math.max(m, r.maxError), 0),
			properties,
			groups: reports,
			skipped,
		},
	};
}

function toVec(v: unknown): number[] {
	return typeof v === 'number' ? [v] : (v as number[]);
}

/**
 * |Δ| in the parameter's units (absolute value, Euclidean for vectors); spatial-points: in layer pixels for points
 * normalised to their layer box (each component × the metric).
 */
function valueDeviation(m: Prepared, times: readonly number[]) {
	const anim = { value: m.channel.keys[0]!.value, keyframes: m.channel.keys as Keyframe<SimplifyValue>[] };
	const dim = toVec(m.channel.keys[0]!.value).length;
	const metric = m.channel.metric;
	const scale = (d: number) => (metric && dim === 2 ? metric[d]! : 1);
	const orig = new Float64Array(times.length * dim);
	times.forEach((t, s) => {
		const v = toVec(evaluate(anim, t, metric ? { metric } : undefined));
		for (let d = 0; d < dim; d++) orig[s * dim + d] = v[d]!;
	});
	return (s: number, values: readonly Float64Array[]): number => {
		const v = values[0]!;
		if (dim === 1) return Math.abs(v[0]! - orig[s]!);
		let sum = 0;
		for (let d = 0; d < dim; d++) sum += ((v[d]! - orig[s * dim + d]!) * scale(d)) ** 2;
		return Math.sqrt(sum);
	};
}

/**
 * Largest displacement (sequence px) of the drawn layer's reference points. Unpinned layers are affine, so the four
 * corners of the box bound every point of the picture. Pinned layers are projective: the points are an `n`×`n` grid
 * over the box through the pin's homography (3×3 = corners, edge midpoints and centre for the solver; a denser grid
 * verifies the result).
 */
function geometryDeviation(doc: ProjectDocument, g: GroupSpec, times: readonly number[], n: number) {
	const clip = g.clip!;
	const tr = (clip as unknown as { transform: Transform }).transform;
	const box = intrinsicBoxOf({ clip, doc, seq: g.seq });
	const pin = activePin(clip);
	// Channel index (into the solver's values) of each Motion key / pin corner, or -1 (then evaluated statically).
	const motionIdx: Record<MotionKey, number> = {
		position: -1,
		anchor: -1,
		scale: -1,
		scaleWidth: -1,
		rotation: -1,
	};
	const pinIdx = [-1, -1, -1, -1];
	g.members.forEach((m, c) => {
		const mk = motionKeyOf(m.target);
		if (mk) motionIdx[mk] = c;
		const pi = pinIndexOf(m.target);
		if (pi >= 0) pinIdx[pi] = c;
	});
	const S = times.length;
	// Original (fixed) values of every geometry channel at every sample.
	const fixedMotion = MOTION_KEYS.map((k) =>
		times.map((t) => toVec(evaluate(tr[k] as Animatable<unknown>, t))),
	);
	const defaults: Vec2[] = [
		[0, 0],
		[1, 0],
		[1, 1],
		[0, 1],
	];
	const fixedPin = pin
		? CORNER_PIN_PARAMS.map((name, i) =>
				times.map((t) => {
					const a = pin.params[name];
					// spatial-points: the corners' paths in the layer box's pixels, as the resolver evaluates them.
					const v = a ? evaluate(a, t, { metric: [box.width, box.height] }) : null;
					return Array.isArray(v) && v.length === 2 ? (v as number[]) : defaults[i]!;
				}),
			)
		: null;
	// Reference points in layer px (unpinned: the box corners; pinned: a grid over the unit square).
	const unit: Vec2[] = [];
	if (fixedPin) {
		for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) unit.push([i / (n - 1), j / (n - 1)]);
	}
	const corners: Vec2[] = [
		[0, 0],
		[box.width, 0],
		[box.width, box.height],
		[0, box.height],
	];
	const nPts = fixedPin ? unit.length : 4;
	const pts = new Float64Array(nPts * 2);
	const motionVals = MOTION_KEYS.map((k) => (k === 'position' || k === 'anchor' ? [0, 0] : [0]));
	const quad: Quad = [
		[0, 0],
		[0, 0],
		[0, 0],
		[0, 0],
	];
	const fill = (s: number, values: readonly Float64Array[] | null) => {
		MOTION_KEYS.forEach((k, ki) => {
			const c = motionIdx[k];
			const src = values && c >= 0 ? values[c]! : fixedMotion[ki]![s]!;
			const out = motionVals[ki]!;
			for (let d = 0; d < out.length; d++) out[d] = src[d]!;
		});
		const m = layerMatrix({
			position: motionVals[0] as Vec2,
			anchor: motionVals[1] as Vec2,
			scale: motionVals[2]![0]!,
			scaleWidth: motionVals[3]![0]!,
			uniformScale: tr.uniformScale,
			rotation: motionVals[4]![0]!,
			flipH: tr.flipH,
			flipV: tr.flipV,
		});
		if (fixedPin) {
			for (let i = 0; i < 4; i++) {
				const c = pinIdx[i]!;
				const src = values && c >= 0 ? values[c]! : fixedPin[i]![s]!;
				quad[i]![0] = src[0]! * box.width;
				quad[i]![1] = src[1]! * box.height;
			}
			const H = unitSquareToQuad(quad);
			for (let i = 0; i < nPts; i++) {
				// Degenerate pins (collinear corners) fall back to bilinear interpolation of the corners.
				const p = H ? applyMat3(H, unit[i]!) : bilinear(quad, unit[i]!);
				const q = applyMatrix(m, p);
				pts[i * 2] = q[0];
				pts[i * 2 + 1] = q[1];
			}
			return;
		}
		for (let i = 0; i < 4; i++) {
			const q = applyMatrix(m, corners[i]!);
			pts[i * 2] = q[0];
			pts[i * 2 + 1] = q[1];
		}
	};
	const orig = new Float64Array(S * nPts * 2);
	for (let s = 0; s < S; s++) {
		fill(s, null);
		orig.set(pts, s * nPts * 2);
	}
	return (s: number, values: readonly Float64Array[]): number => {
		fill(s, values);
		let worst = 0;
		const base = s * nPts * 2;
		for (let i = 0; i < nPts; i++) {
			const dx = pts[i * 2]! - orig[base + i * 2]!;
			const dy = pts[i * 2 + 1]! - orig[base + i * 2 + 1]!;
			const d = dx * dx + dy * dy;
			if (d > worst) worst = d;
		}
		return Math.sqrt(worst);
	};
}

function bilinear(q: Quad, [u, v]: Vec2): Vec2 {
	const top: Vec2 = [q[0][0] + u * (q[1][0] - q[0][0]), q[0][1] + u * (q[1][1] - q[0][1])];
	const bottom: Vec2 = [q[3][0] + u * (q[2][0] - q[3][0]), q[3][1] + u * (q[2][1] - q[3][1])];
	return [top[0] + v * (bottom[0] - top[0]), top[1] + v * (bottom[1] - top[1])];
}
