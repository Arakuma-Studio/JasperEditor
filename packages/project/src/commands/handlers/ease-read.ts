// Keyframe assistant (easing): selection grouping shared by the ease commands, and the pure read helpers the UI and
// MCP use — `describeKeyframeEases` (the Keyframe Velocity editor's numbers), `copyEase` and `copyValues` (the ease /
// value clipboard read by `keyframe.pasteEase` / `keyframe.pasteValues`). See docs/wp-notes/easing.md.
import { produce } from 'immer';
import { type CubicEase, easesToCubic, type MultiEase, MultiEaseSchema } from '../../ease/curve.ts';
import {
	type EaseSpan,
	LINEAR_EASE,
	spanAverageVelocity,
	spanDistance,
	spanEases,
	spanLeaving,
} from '../../ease/segments.ts';
import { createCounterIdSource } from '../../ids.ts';
import { isHoldOnlyValue, rovingRuns } from '../../keyframes.ts';
import { isVec2Value } from '../../keyframes-spatial.ts';
import { defaultPresetRegistry } from '../../presets.ts';
import { defaultEffectRegistry } from '../../registry/effects.ts';
import { emptyMgRegistry } from '../../registry/mg.ts';
import type { Ease, Interpolation, Keyframe } from '../../schema/common.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import { FLICKS_PER_SECOND } from '../../time.ts';
import { type DDoc, HandlerContext } from '../context.ts';
import type { ParamPath } from '../schemas/index.ts';
import { CommandError, type Registries } from '../types.ts';
import { type AnimLocation, allAnimatables, targetOf } from './keyframe.ts';
import type { Target } from './param.ts';
import { clone } from './util.ts';

type Keys = Keyframe<unknown>[];

/** The selected keys of one property: a plain copy of its keys (time order) and the selected indices. */
export type EaseGroup = {
	loc: AnimLocation;
	target: Extract<Target, { type: 'anim' }>;
	kfs: Keys;
	/** Indices into `kfs` of the selected keys, ascending. */
	selected: number[];
};

/**
 * Groups keyframe ids by property, in document order (the order every ease command and clipboard helper uses:
 * property, then time). Fails with E_NOT_FOUND for unknown ids and E_TRACK_LOCKED on locked tracks.
 */
export function selectionGroups(doc: DDoc, ids: readonly string[], h: HandlerContext): EaseGroup[] {
	const want = new Set(ids);
	const found = new Set<string>();
	const groups: EaseGroup[] = [];
	for (const loc of allAnimatables(doc)) {
		if (!loc.anim.keyframes.some((k) => want.has(k.id))) continue;
		const kfs = (clone(loc.anim.keyframes) as Keys).sort((x, y) => x.time - y.time);
		const selected: number[] = [];
		kfs.forEach((k, i) => {
			if (want.has(k.id)) {
				selected.push(i);
				found.add(k.id);
			}
		});
		groups.push({ loc, target: targetOf(doc, loc, h), kfs, selected });
		if (found.size === want.size) break;
	}
	for (const id of want) if (!found.has(id)) h.fail('E_NOT_FOUND', `Keyframe not found: ${id}`);
	return groups;
}

/** True when the property's keys only step (hold-only parameters, strings, booleans…). */
export function isSteppingGroup(g: EaseGroup): boolean {
	return g.target.rule.holdOnly || g.kfs.some((k) => isHoldOnlyValue(k.value));
}

/** True for vec2 point properties (spatial interpolation, a drawn motion path). */
export function isPointGroup(g: EaseGroup): boolean {
	return g.target.rule.kind === 'vec2' && !!g.target.rule.spatial && g.kfs.every((k) => isVec2Value(k.value));
}

/**
 * The segments an ease goes to (EaseSection rules), as spans in time order: `in` = the span arriving at the first
 * selected key, `middle` = every span between two consecutive selected keys (adjacent keys, or keys of one roving
 * run), `out` = the span leaving the last selected key. Spans touching a roving key are its enclosing run.
 */
export function sectionSpans(g: EaseGroup, sections: readonly string[] | undefined): EaseSpan[] {
	const { kfs, selected: sel } = g;
	if (!sel.length) return [];
	const runs = rovingRuns([...kfs]);
	const secs = sections ?? (sel.length >= 2 ? ['middle'] : ['in', 'out']);
	const out: EaseSpan[] = [];
	const push = (sp: EaseSpan | null) => {
		if (sp && !out.some((o) => o.a === sp.a && o.b === sp.b)) out.push(sp);
	};
	if (secs.includes('in')) push(spanLeaving(kfs, sel[0]! - 1, runs));
	if (secs.includes('middle'))
		for (let k = 0; k + 1 < sel.length; k++) {
			const sp = spanLeaving(kfs, sel[k]!, runs);
			if (sp && sp.b >= sel[k + 1]!) push(sp);
		}
	if (secs.includes('out')) push(spanLeaving(kfs, sel[sel.length - 1]!, runs));
	return out.sort((x, y) => x.a - y.a);
}

// ---- Pure read helpers ------------------------------------------------------------------------------------------

export type ReadFailure = { ok: false; code: string; message: string };

const DEFAULT_REGISTRIES: Registries = {
	effects: defaultEffectRegistry,
	mgTemplates: emptyMgRegistry,
	presets: defaultPresetRegistry,
};

/** Runs `fn` on a throw-away draft (tracks unlocked: reading is allowed on locked tracks). */
function readSelection<T>(
	doc: ProjectDocument,
	ids: readonly string[],
	registries: Registries | undefined,
	fn: (groups: EaseGroup[]) => T,
): { ok: true; value: T } | ReadFailure {
	let value: T | undefined;
	try {
		produce(doc, (draft) => {
			for (const seq of Object.values(draft.sequences))
				for (const t of [...seq.videoTracks, ...seq.audioTracks, ...(seq.submixTracks ?? [])])
					if (t.locked) t.locked = false;
			const h = new HandlerContext(
				{
					ids: createCounterIdSource(1),
					now: () => '',
					revision: 0,
					registries: registries ?? DEFAULT_REGISTRIES,
				},
				{ origin: 'system' },
				new Map(),
			);
			value = fn(selectionGroups(draft as DDoc, ids, h));
		});
	} catch (e) {
		if (e instanceof CommandError) return { ok: false, code: e.code, message: e.message };
		return { ok: false, code: 'E_INVALID_PARAM', message: (e as Error).message };
	}
	return { ok: true, value: value as T };
}

/** One side of a key as the Keyframe Velocity editor shows it. */
export type EaseSideInfo = {
	/** Influence as a fraction (0, 1] and in percent. */
	influence: number;
	influencePercent: number;
	/** Slope relative to the segment's average speed (1 = linear). */
	slope: number;
	/** Speed in property units per second (sequence px/s along the path for points; signed for numbers). */
	speed: number;
};

export type EaseKeyInfo = {
	id: string;
	/** Content time (flicks) and seconds. */
	time: number;
	seconds: number;
	value: unknown;
	interpolation: Interpolation;
	roving: boolean;
	/** Effective eases (null: no segment on that side, or the key roves). */
	easeIn: EaseSideInfo | null;
	easeOut: EaseSideInfo | null;
};

export type EaseSegmentInfo = {
	fromId: string;
	toId: string;
	section: 'in' | 'middle' | 'out';
	hold: boolean;
	/** A run of roving keys between the two fixed keys. */
	roving: boolean;
	/** The segment as cubic-bezier (linear = (⅓, ⅓, ⅔, ⅔)). */
	curve: CubicEase;
	/** Average speed of the segment in property units per second (signed for numbers). */
	averageSpeed: number;
};

export type EasePropertyInfo = {
	path: ParamPath;
	label: string;
	/** The sequence holding the property, and its clip (null for track, master and transition parameters). */
	sequenceId: string;
	clipId: string | null;
	/** Point property (speeds along the drawn path). */
	spatial: boolean;
	keys: EaseKeyInfo[];
	segments: EaseSegmentInfo[];
};

function sideInfo(e: Ease, avg: number): EaseSideInfo {
	return {
		influence: e.influence,
		influencePercent: e.influence * 100,
		slope: e.slope,
		speed: e.slope * avg,
	};
}

/** The Keyframe Velocity view of one group (selected keys, segments). */
export function describeEaseGroup(g: EaseGroup): EasePropertyInfo {
	const { kfs } = g;
	const runs = rovingRuns([...kfs]);
	const roving = (i: number) => runs.some((r) => i > r.a && i < r.b);
	const keys: EaseKeyInfo[] = g.selected.map((i) => {
		const k = kfs[i]!;
		const before = roving(i) ? null : spanLeaving(kfs, i - 1, runs);
		const after = roving(i) ? null : spanLeaving(kfs, i, runs);
		const side = (sp: EaseSpan | null, which: 'in' | 'out') => {
			if (!sp) return null;
			const e = spanEases(kfs, sp.a, sp.b);
			const ease = e.hold ? (which === 'in' ? k.easeIn : k.easeOut) : which === 'in' ? e.in : e.out;
			return sideInfo(ease, spanAverageVelocity(kfs, sp.a, sp.b));
		};
		return {
			id: k.id,
			time: k.time,
			seconds: k.time / FLICKS_PER_SECOND,
			value: clone(k.value),
			interpolation: k.interpolation,
			roving: roving(i),
			easeIn: side(before, 'in'),
			easeOut: side(after, 'out'),
		};
	});
	const segments: EaseSegmentInfo[] = [];
	for (const section of ['in', 'middle', 'out'] as const)
		for (const sp of sectionSpans(g, [section])) {
			const e = spanEases(kfs, sp.a, sp.b);
			segments.push({
				fromId: kfs[sp.a]!.id,
				toId: kfs[sp.b]!.id,
				section,
				hold: e.hold,
				roving: sp.roving,
				curve: e.hold ? easesToCubic(LINEAR_EASE, LINEAR_EASE) : easesToCubic(e.out, e.in),
				averageSpeed: spanAverageVelocity(kfs, sp.a, sp.b),
			});
		}
	segments.sort((x, y) => kfs.findIndex((k) => k.id === x.fromId) - kfs.findIndex((k) => k.id === y.fromId));
	return {
		path: [...g.loc.path],
		label: g.target.label,
		sequenceId: g.loc.seq.id,
		clipId: g.loc.clip?.id ?? null,
		spatial: isPointGroup(g),
		keys,
		segments,
	};
}

/**
 * Per property (document order): the selected keys with their effective eases (influence, slope, speed) and the
 * segments around / between them as cubic-bezier curves. Reads locked tracks too.
 */
export function describeKeyframeEases(
	doc: ProjectDocument,
	keyframeIds: readonly string[],
	registries?: Registries,
): { ok: true; properties: EasePropertyInfo[] } | ReadFailure {
	const r = readSelection(doc, keyframeIds, registries, (groups) => groups.map(describeEaseGroup));
	return r.ok ? { ok: true, properties: r.value } : r;
}

/** An ease clipboard entry (`keyframe.pasteEase`'s `clip`). */
export type EaseClip =
	| { kind: 'key'; easeIn: Ease; easeOut: Ease }
	| { kind: 'segments'; segments: CubicEase[]; curve?: MultiEase };

/** Progress coordinate of a key along span A → B: arc fraction for points, projection for vectors. */
function progressOf(g: EaseGroup, a: number, b: number, i: number): number | null {
	const { kfs } = g;
	const A = kfs[a]!.value;
	const B = kfs[b]!.value;
	const V = kfs[i]!.value;
	if (isPointGroup(g)) {
		const total = spanDistance(kfs, a, b);
		return total > 0 ? spanDistance(kfs, a, i) / total : null;
	}
	if (typeof A === 'number' && typeof B === 'number' && typeof V === 'number')
		return B !== A ? (V - A) / (B - A) : null;
	if (Array.isArray(A) && Array.isArray(B) && Array.isArray(V)) {
		let num = 0;
		let den = 0;
		for (let k = 0; k < A.length; k++) {
			const d = (B[k] as number) - (A[k] as number);
			num += ((V[k] as number) - (A[k] as number)) * d;
			den += d * d;
		}
		return den > 0 ? num / den : null;
	}
	return null;
}

/** The keys first … last of one property as a multi-point curve, or null when it cannot be expressed. */
function curveOf(g: EaseGroup, a: number, b: number): MultiEase | null {
	const { kfs } = g;
	if (b - a < 2 || rovingRuns([...kfs]).some((r) => r.a < b && r.b > a)) return null;
	const T = kfs[b]!.time - kfs[a]!.time;
	const xs: number[] = [];
	const ys: number[] = [];
	for (let i = a; i <= b; i++) {
		const y = progressOf(g, a, b, i);
		if (y === null) return null;
		xs.push((kfs[i]!.time - kfs[a]!.time) / T);
		ys.push(y);
	}
	const points: MultiEase['points'] = xs.map((x, m) => ({ x, y: ys[m]! }));
	points[0] = { x: 0, y: 0 };
	points[points.length - 1] = { x: 1, y: 1 };
	for (let i = a; i < b; i++) {
		const m = i - a;
		const e = spanEases(kfs, i, i + 1);
		if (e.hold) return null;
		const c = easesToCubic(e.out, e.in);
		const p = points[m]!;
		const q = points[m + 1]!;
		const dx = q.x - p.x;
		const dy = q.y - p.y;
		p.out = [p.x + c.x1 * dx, p.y + c.y1 * dy];
		q.in = [p.x + c.x2 * dx, p.y + c.y2 * dy];
	}
	const parsed = MultiEaseSchema.safeParse({ kind: 'multi', points });
	return parsed.success ? (parsed.data as MultiEase) : null;
}

/**
 * Copies eases from keys: one key → its two effective eases (`kind: 'key'`); otherwise the segments between
 * consecutive selected keys (property order, then time) as cubic-bezier curves, plus — for three or more keys of a
 * single property whose first and last values differ — the whole span as a multi-point curve. Reads locked tracks.
 */
export function copyEase(
	doc: ProjectDocument,
	keyframeIds: readonly string[],
	registries?: Registries,
): { ok: true; clip: EaseClip } | ReadFailure {
	const r = readSelection(doc, keyframeIds, registries, (groups): EaseClip | string => {
		const total = groups.reduce((n, g) => n + g.selected.length, 0);
		const keyClip = (g: EaseGroup, i: number): EaseClip => {
			const kfs = g.kfs;
			const before = spanLeaving(kfs, i - 1);
			const after = spanLeaving(kfs, i);
			const e1 = before ? spanEases(kfs, before.a, before.b) : null;
			const e2 = after ? spanEases(kfs, after.a, after.b) : null;
			return {
				kind: 'key',
				easeIn: { ...(e1 && !e1.hold ? e1.in : kfs[i]!.easeIn) },
				easeOut: { ...(e2 && !e2.hold ? e2.out : kfs[i]!.easeOut) },
			};
		};
		if (total === 1) return keyClip(groups[0]!, groups[0]!.selected[0]!);
		const segments: CubicEase[] = [];
		for (const g of groups) {
			if (isSteppingGroup(g)) continue;
			for (const sp of sectionSpans(g, ['middle'])) {
				const e = spanEases(g.kfs, sp.a, sp.b);
				if (!e.hold) segments.push(easesToCubic(e.out, e.in));
			}
		}
		if (!segments.length) {
			if (groups.every((g) => g.selected.length === 1)) return keyClip(groups[0]!, groups[0]!.selected[0]!);
			return 'Select two adjacent keyframes of a property (or one keyframe) to copy its ease';
		}
		const single = groups.length === 1 ? groups[0]! : null;
		const curve =
			single && single.selected.length >= 3 && !isSteppingGroup(single)
				? curveOf(single, single.selected[0]!, single.selected[single.selected.length - 1]!)
				: null;
		return { kind: 'segments', segments: segments.slice(0, 256), ...(curve ? { curve } : {}) };
	});
	if (!r.ok) return r;
	if (typeof r.value === 'string') return { ok: false, code: 'E_INVALID_PARAM', message: r.value };
	return { ok: true, clip: r.value };
}

/** Copies the values of keys in order (property, then time) for `keyframe.pasteValues`. Reads locked tracks. */
export function copyValues(
	doc: ProjectDocument,
	keyframeIds: readonly string[],
	registries?: Registries,
): { ok: true; values: unknown[] } | ReadFailure {
	const r = readSelection(doc, keyframeIds, registries, (groups) =>
		groups.flatMap((g) => g.selected.map((i) => clone(g.kfs[i]!.value))),
	);
	return r.ok ? { ok: true, values: r.value } : r;
}
