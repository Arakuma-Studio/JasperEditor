// Keyframes live in content time (flicks) of the owning clip; track and master parameters use sequence
// time in flicks (S01:KF-002). Keys are addressed by id; the handlers locate them anywhere in the
// document and re-use param.ts target resolution for validation, lock checks and time conversion.
import type { Draft } from 'immer';
import {
	autoSlope,
	EASE_PRESETS,
	evaluate,
	explicitInSide,
	isBothSided,
	isHoldOnlyValue,
	keySidesIssue,
	retimeRoving,
	stopRoving,
} from '../../keyframes.ts';
import {
	newKeySpatial,
	refreshAutoTangents,
	type SpatialMetric,
	setSpatialMode,
} from '../../keyframes-spatial.ts';
import { MASK_PROPS } from '../../masks/model.ts';
import { PROPERTY_SPECS } from '../../registry/properties.ts';
import { textAnimatorPropertySpecs } from '../../registry/text-animator-properties.ts';
import type {
	Animatable,
	Ease,
	InInterpolation,
	Interpolation,
	InterpolationSide,
	Keyframe,
} from '../../schema/common.ts';
import type { Mask } from '../../schema/mask.ts';
import { PUPPET_PIN_PROPS } from '../../schema/puppet.ts';
import { type EffectInstance, isKnownClipKind, type Track } from '../../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../../time.ts';
import { type Appearance, globalLightOf } from '../../title-looks/model.ts';
import { appearanceSlots, GLOBAL_LIGHT_PATH, LIGHT_PROPS } from '../../title-looks/properties.ts';
import { shapeItemPropertySpecs } from '../../vector/properties.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import type { CommandOf, ParamPath } from '../schemas/index.ts';
import { PRUNE_EMPTY_KEYFRAMES, templateParamDraftAnim } from './mg-template.ts';
import { getAt, resolveTarget, type Target, validateValue } from './param.ts';
import { sourceTextDraftAnim } from './text-animators.ts';
import type { HandlerMap } from './util.ts';
import { clone } from './util.ts';

type DAnim = Draft<Animatable<unknown>>;
type DKey = Draft<Keyframe<unknown>>;

const LINEAR: Ease = EASE_PRESETS.linear;
const AUTO_INFLUENCE = 1 / 3;

function isAnim(v: unknown): v is DAnim {
	return (
		!!v && typeof v === 'object' && 'value' in v && Array.isArray((v as { keyframes?: unknown }).keyframes)
	);
}

/** One animatable parameter somewhere in the document. */
export type AnimLocation = {
	anim: DAnim;
	/** ParamPath addressing it (S01:CMD-010). */
	path: ParamPath;
	seq: DSeq;
	/** Owning clip (content-time keys), or null for track/master parameters (sequence time). */
	clip: DClip | null;
};

/** Every animatable parameter of one clip: intrinsic properties and applied effect params. */
export function clipAnimatables(seq: DSeq, clip: DClip): AnimLocation[] {
	const out: AnimLocation[] = [];
	if (isKnownClipKind(clip.kind)) {
		for (const s of PROPERTY_SPECS) {
			if (s.animatable === 'no' || s.storagePath[0]!.startsWith('$') || !s.appliesTo(clip)) continue;
			const a = getAt(clip, s.storagePath);
			if (isAnim(a)) out.push({ anim: a, path: ['clip', clip.id, ...s.key.split('.')], seq, clip });
		}
	}
	for (const fx of (clip as { effects?: Draft<EffectInstance>[] }).effects ?? []) {
		for (const [name, a] of Object.entries(fx.params)) {
			if (isAnim(a)) out.push({ anim: a, path: ['effect', fx.id, name], seq, clip });
		}
	}
	// every item property of a vector shape (dynamic `shape.items.<id>.<field>` keys).
	if (clip.kind === 'shape')
		for (const s of shapeItemPropertySpecs(clip as never)) {
			if (s.animatable === 'no') continue;
			const a = getAt(clip, s.storagePath);
			if (isAnim(a)) out.push({ anim: a, path: ['clip', clip.id, ...s.key.split('.')], seq, clip });
		}
	// animator properties, selector fields, Path / More Options, Source Text.
	if (clip.kind === 'text') {
		for (const s of textAnimatorPropertySpecs(clip as never)) {
			if (s.animatable === 'no') continue;
			const a = getAt(clip, s.storagePath);
			if (isAnim(a)) out.push({ anim: a, path: ['clip', clip.id, ...s.key.split('.')], seq, clip });
		}
		if ((clip as { sourceTextKeyframes?: unknown[] }).sourceTextKeyframes?.length)
			out.push({
				anim: sourceTextDraftAnim(clip, null),
				path: ['clip', clip.id, 'text', 'sourceText'],
				seq,
				clip,
			});
	}
	// Opacity masks and effect masks (`["mask", id, prop]`).
	const maskLists = [
		(clip as { masks?: Draft<Mask>[] }).masks ?? [],
		...((clip as { effects?: Draft<EffectInstance>[] }).effects ?? []).map(
			(fx) => (fx.masks ?? []) as Draft<Mask>[],
		),
	];
	for (const list of maskLists)
		for (const m of list)
			for (const prop of MASK_PROPS) {
				const a = m[prop];
				if (isAnim(a)) out.push({ anim: a as DAnim, path: ['mask', m.id, prop], seq, clip });
			}
	// Puppet pin properties (`["puppetPin", id, prop]`).
	for (const fx of (clip as { effects?: Draft<EffectInstance>[] }).effects ?? [])
		for (const pin of fx.puppet?.pins ?? [])
			for (const prop of PUPPET_PIN_PROPS) {
				const a = pin[prop];
				if (isAnim(a)) out.push({ anim: a as DAnim, path: ['puppetPin', pin.id, prop], seq, clip });
			}
	// spec 19 TL-014: everything an appearance animates.
	for (const fx of (clip as { effects?: Draft<EffectInstance>[] }).effects ?? [])
		if (fx.appearance)
			for (const s of appearanceSlots(fx.id, fx.appearance as Appearance))
				if (isAnim(s.anim)) out.push({ anim: s.anim as DAnim, path: s.path, seq, clip });
	// S11:ATP-006: keyframed params of anime templates (dynamic `params.<name>` keys; edits validate through
	// param.ts target resolution, which needs the template to be installed).
	if (clip.kind === 'motion-graphic') {
		const kf = (clip as { paramKeyframes?: Record<string, unknown[]> }).paramKeyframes ?? {};
		for (const name of Object.keys(kf)) {
			if ((kf[name]?.length ?? 0) === 0) continue;
			out.push({
				anim: templateParamDraftAnim(clip, name),
				path: ['clip', clip.id, 'params', name],
				seq,
				clip,
			});
		}
	}
	return out;
}

function trackAnimatables(seq: DSeq, t: Draft<Track>): AnimLocation[] {
	const out: AnimLocation[] = [];
	for (const key of ['volumeDb', 'pan'] as const) {
		const a = t[key];
		if (isAnim(a)) out.push({ anim: a, path: ['track', t.id, key], seq, clip: null });
	}
	for (const fx of t.effects ?? [])
		for (const [name, a] of Object.entries(fx.params))
			if (isAnim(a)) out.push({ anim: a, path: ['effect', fx.id, name], seq, clip: null });
	return out;
}

/** Every animatable parameter of the document (clips, tracks, master). */
export function allAnimatables(doc: DDoc): AnimLocation[] {
	const out: AnimLocation[] = [];
	for (const seq of Object.values(doc.sequences)) {
		for (const clip of Object.values(seq.clips)) out.push(...clipAnimatables(seq, clip));
		for (const t of [...seq.videoTracks, ...seq.audioTracks]) out.push(...trackAnimatables(seq, t));
		if (isAnim(seq.master.volumeDb))
			out.push({ anim: seq.master.volumeDb as DAnim, path: ['master', seq.id, 'volumeDb'], seq, clip: null });
		// spec 19 TL-017: the sequence's light (sequence time).
		const light = globalLightOf(seq as never)
			? (seq.settings as { globalLight?: Record<string, unknown> }).globalLight
			: null;
		if (light)
			for (const k of LIGHT_PROPS)
				if (isAnim(light[k]))
					out.push({ anim: light[k] as DAnim, path: [GLOBAL_LIGHT_PATH, seq.id, k], seq, clip: null });
		for (const fx of seq.master.effects)
			for (const [name, a] of Object.entries(fx.params))
				if (isAnim(a)) out.push({ anim: a, path: ['effect', fx.id, name], seq, clip: null });
		// Transition params (wave-2 transition framework; times = flicks from the span's start).
		for (const t of Object.values(seq.transitions))
			for (const [name, a] of Object.entries(t.params))
				if (isAnim(a)) out.push({ anim: a as DAnim, path: ['transition', t.id, name], seq, clip: null });
	}
	return out;
}

type Located = AnimLocation & { key: DKey };

/** Finds keyframes by id; fails with E_NOT_FOUND for any missing id. */
export function locate(doc: DDoc, ids: readonly string[], h: HandlerContext): Located[] {
	const want = new Set(ids);
	const found = new Map<string, Located>();
	for (const loc of allAnimatables(doc)) {
		for (const k of loc.anim.keyframes) if (want.has(k.id)) found.set(k.id, { ...loc, key: k as DKey });
		if (found.size === want.size) break;
	}
	for (const id of want) if (!found.has(id)) h.fail('E_NOT_FOUND', `Keyframe not found: ${id}`);
	return [...want].map((id) => found.get(id)!);
}

/** spatial-points: metrics of the animations touched by a handler (`finish`'s `metricOf`). */
export class MetricMap {
	private readonly m = new Map<DAnim, SpatialMetric>();
	/** Records a target's metric for its animation; returns the target. */
	note<T extends Extract<Target, { type: 'anim' }>>(t: T): T {
		if (t.metric) this.m.set(t.anim, t.metric);
		return t;
	}
	readonly of = (a: DAnim): SpatialMetric | undefined => this.m.get(a);
}

/** Target resolution (validation rule, lock check) for a located parameter. */
export function targetOf(doc: DDoc, loc: AnimLocation, h: HandlerContext): Extract<Target, { type: 'anim' }> {
	const t = resolveTarget(doc, { target: [...loc.path], sequenceId: loc.seq.id }, h);
	if (t.type !== 'anim') return h.fail('E_INVALID_PARAM', `${t.label} is not animatable`);
	return t;
}

/** Refuses spatial data on parameters that are not points (S03:KF-021 "vec2 position and anchor"). */
export function assertSpatialTarget(target: Target, h: HandlerContext): void {
	if (!target.rule.spatial)
		h.fail('E_INVALID_PARAM', `${target.label} is not a point property; it has no spatial interpolation`);
}

function magnitude(a: unknown, b: unknown, metric?: SpatialMetric): number {
	if (typeof a === 'number' && typeof b === 'number') return Math.abs(b - a);
	if (Array.isArray(a) && Array.isArray(b)) {
		let s = 0;
		// spatial-points: a point normalised to its layer box measures in the box's pixels.
		for (let i = 0; i < a.length; i++)
			s += (((b[i] as number) - (a[i] as number)) * (metric && a.length === 2 ? metric[i]! : 1)) ** 2;
		return Math.sqrt(s);
	}
	return 0;
}

/**
 * Average velocity (value units per flick) of the segment between keys i and i+1, or 0: signed for numbers (so a
 * Continuous key at a local extremum gets a smooth zero crossing), the speed along the value / path otherwise.
 */
function segmentVelocity(kfs: readonly Keyframe<unknown>[], i: number, metric?: SpatialMetric): number {
	const a = kfs[i];
	const b = kfs[i + 1];
	if (!a || !b || b.time === a.time) return 0;
	if (typeof a.value === 'number' && typeof b.value === 'number')
		return (b.value - a.value) / (b.time - a.time);
	return magnitude(a.value, b.value, metric) / (b.time - a.time);
}

/**
 * Stores the auto-bezier eases of every `auto-bezier` key (S01:KF-004, S03:KF-020 "recomputed whenever
 * a neighbor changes"). The evaluator derives them on the fly anyway; storing keeps the stored eases
 * honest for the UI and for a later switch to `bezier` (which then starts from the auto shape).
 */
export function refreshAutoBezier(anim: DAnim, metric?: SpatialMetric): void {
	const kfs = anim.keyframes;
	kfs.forEach((key, i) => {
		if (key.interpolation !== 'auto-bezier') return;
		key.easeIn = { influence: AUTO_INFLUENCE, slope: autoSlope(kfs, i, 'in', metric) };
		key.easeOut = { influence: AUTO_INFLUENCE, slope: autoSlope(kfs, i, 'out', metric) };
	});
}

/**
 * Continuous Bezier (S01:KF-004): the side that was not edited gets the same velocity as the edited
 * one, so the curve has no corner. Slopes are normalized per segment, so the conversion scales by the
 * ratio of the two segments' average speeds.
 */
function matchContinuous(anim: DAnim, i: number, edited: 'in' | 'out', metric?: SpatialMetric): void {
	const kfs = anim.keyframes as Keyframe<unknown>[];
	const key = anim.keyframes[i] as DKey;
	const vIn = segmentVelocity(kfs, i - 1, metric);
	const vOut = segmentVelocity(kfs, i, metric);
	if (i === 0 || i === kfs.length - 1) return; // one side only
	// keyframes-blend: signed (numbers): the same velocity on both sides, also through a local extremum.
	if (edited === 'out') {
		const slope = vIn !== 0 ? (key.easeOut.slope * vOut) / vIn : key.easeOut.slope;
		key.easeIn = { influence: key.easeIn.influence, slope };
	} else {
		const slope = vOut !== 0 ? (key.easeIn.slope * vIn) / vOut : key.easeIn.slope;
		key.easeOut = { influence: key.easeOut.influence, slope };
	}
}

/**
 * Normalises edited animations: time order, Auto Bezier spatial tangents, roving times, auto-bezier eases.
 * spatial-points: `metricOf` gives the spatial metric of an animation (effect points: `Target.metric`).
 */
export function finish(
	anims: Iterable<DAnim>,
	metricOf: (a: DAnim) => SpatialMetric | undefined = () => undefined,
): void {
	for (const a of anims) {
		const metric = metricOf(a);
		a.keyframes.sort((x, y) => x.time - y.time);
		// Spatial auto tangents first: auto-bezier temporal slopes measure curved paths (S03:KF-030).
		refreshAutoTangents(a.keyframes as Keyframe<unknown>[], metric);
		// keyframes-blend: roving keys sit where the motion passes them.
		retimeRoving(a.keyframes as Keyframe<unknown>[], metric);
		refreshAutoBezier(a, metric);
		// Template param views drop an emptied keyframe list (S11:ATP-006).
		(a as { [PRUNE_EMPTY_KEYFRAMES]?: () => void })[PRUNE_EMPTY_KEYFRAMES]?.();
	}
}

/** Content-time grid of the owner: one sequence frame of the clip (× speed), or one sequence frame. */
function gridOf(loc: AnimLocation): { origin: number; step: number } {
	const F = flicksPerFrame(loc.seq.settings.frameRate as Rational);
	return loc.clip ? { origin: loc.clip.sourceIn, step: F * loc.clip.speed.rate } : { origin: 0, step: F };
}
function snapTime(loc: AnimLocation, t: number): number {
	const g = gridOf(loc);
	return Math.round(g.origin + Math.round((t - g.origin) / g.step) * g.step);
}

/** The incoming type of a key read the legacy way, as an incoming side (Hold keys arrive with their stored ease). */
function inInterpolationLegacy(key: DKey): Interpolation {
	return key.interpolation === 'hold' ? 'bezier' : key.interpolation;
}

function setEase(key: DKey, side: 'in' | 'out', e: Ease): void {
	if (side === 'in') key.easeIn = { influence: e.influence, slope: e.slope };
	else key.easeOut = { influence: e.influence, slope: e.slope };
}

/**
 * keyframe-sides: makes key i's incoming side explicit WITHOUT changing the segment arriving at it (used when only its
 * outgoing side is edited). A key read the legacy way contributes: nothing after a Linear key (the segment is linear:
 * explicit Linear reproduces it), its stored ease after a curving key (a legacy Linear key ⅓·1 — kept as a Bezier side
 * with that ease, since an explicit Linear side is After Effects' ⅙·1), the computed ease for Auto Bezier.
 */
function freezeIncoming(kfs: DKey[], i: number): void {
	const k = kfs[i]!;
	if (k.inInterpolation !== undefined) return;
	// The evaluator's rule (`explicitInSide`); a Bezier side takes the ease it contributed (a Hold key's stored one,
	// ⅓·1 for a legacy Linear key).
	const side = explicitInSide(kfs as Keyframe<unknown>[], i);
	k.inInterpolation = side.type;
	if (side.type === 'bezier') k.easeIn = { influence: side.ease.influence, slope: side.ease.slope };
}

/**
 * keyframe-sides: makes key i's incoming side explicit with its own type (a legacy key's `interpolation`; Hold keys
 * arrive with their stored ease, i.e. Bezier). Used for the key after an edited outgoing side, so the edited segment is
 * evaluated per side.
 */
function explicitIncoming(kfs: DKey[], i: number): void {
	const k = kfs[i];
	if (!k || k.inInterpolation !== undefined) return;
	k.inInterpolation = k.interpolation === 'hold' ? 'bezier' : k.interpolation;
}

/**
 * keyframe-sides: Auto / Continuous Bezier shape both sides, so on a key whose sides now differ they become Bezier,
 * frozen at their current shape (After Effects: adjusting one side of an Auto Bezier key converts it).
 */
function settleSides(kfs: DKey[], i: number, metric?: SpatialMetric): void {
	const k = kfs[i]!;
	if (k.inInterpolation === undefined || k.inInterpolation === k.interpolation) return;
	const ks = kfs as Keyframe<unknown>[];
	if (k.inInterpolation === 'auto-bezier')
		k.easeIn = { influence: AUTO_INFLUENCE, slope: autoSlope(ks, i, 'in', metric) };
	if (isBothSided(k.inInterpolation)) k.inInterpolation = 'bezier';
	if (k.interpolation === 'auto-bezier')
		k.easeOut = { influence: AUTO_INFLUENCE, slope: autoSlope(ks, i, 'out', metric) };
	if (isBothSided(k.interpolation)) k.interpolation = 'bezier';
}

/** Refusal for a temporal interpolation that cannot go on the requested side (keyframe-sides). */
function sideRefusal(
	interpolation: Interpolation,
	side: InterpolationSide,
	easeIn: Ease | undefined,
	easeOut: Ease | undefined,
): string | null {
	if (side !== 'both' && isBothSided(interpolation))
		return `${interpolation === 'auto-bezier' ? 'Auto Bezier' : 'Continuous Bezier'} shapes both sides of a key; use side "both"`;
	if (side === 'in' && interpolation === 'hold')
		return 'Hold applies to the side leaving a key (use side "out" or "both")';
	if (side === 'in' && easeOut) return 'easeOut does not apply to the incoming side';
	if (side === 'out' && easeIn) return 'easeIn does not apply to the outgoing side';
	return null;
}

/**
 * Applies a temporal interpolation (+ optional eases) to one side, or both, of one key (S01:KF-004; keyframe-sides):
 * - `in`: the key's incoming type; its outgoing side keeps its shape (an Auto / Continuous one becomes Bezier).
 * - `out` (and Hold on `both`: Hold only leaves a key): the outgoing type; the incoming side is made explicit first,
 *   unchanged, and the next key's incoming side explicit, so the edited segment is evaluated per side.
 * - `both`: both types; the next key's incoming side becomes explicit.
 * Per-side segments follow After Effects: a segment is linear only when both its sides are Linear, so an Ease In after
 * a Linear key shapes the segment without touching the Linear key.
 */
export function applyInterpolation(
	anim: DAnim,
	key: DKey,
	interpolation: Interpolation,
	easeIn: Ease | undefined,
	easeOut: Ease | undefined,
	side: InterpolationSide = 'both',
	metric?: SpatialMetric,
): void {
	const kfs = anim.keyframes as DKey[];
	const i = kfs.indexOf(key);
	const where = side === 'both' && interpolation === 'hold' ? 'out' : side;
	if (where === 'in') {
		key.inInterpolation = interpolation as InInterpolation;
		if (easeIn) setEase(key, 'in', easeIn);
	} else {
		if (where === 'out') freezeIncoming(kfs, i);
		else key.inInterpolation = interpolation as InInterpolation;
		key.interpolation = interpolation;
		if (easeIn) setEase(key, 'in', easeIn);
		if (easeOut) setEase(key, 'out', easeOut);
		explicitIncoming(kfs, i + 1);
	}
	settleSides(kfs, i, metric);
	if (interpolation === 'continuous-bezier')
		matchContinuous(anim, i, easeIn && !easeOut ? 'in' : 'out', metric);
}

export const keyframeHandlers = {
	'keyframe.add': (doc, cmd: CommandOf<'keyframe.add'>, h: HandlerContext) => {
		const target = resolveTarget(doc, cmd, h, { create: cmd.value !== undefined });
		if (target.type !== 'anim') return h.fail('E_INVALID_PARAM', `${target.label} is not animatable`);
		const anim = target.anim;
		const time = target.time(cmd.at);
		const hold = target.rule.holdOnly;
		let value: unknown;
		if (cmd.value !== undefined) {
			const v = validateValue(cmd.value, target.rule, h, target.label);
			if (v.clamped) h.warn('W_VALUE_CLAMPED', `${target.label} clamped to ${JSON.stringify(v.value)}`);
			value = v.value;
		} else
			value = clone(
				evaluate(anim as Animatable<unknown>, time, {
					holdOnly: hold,
					...(target.metric ? { metric: target.metric } : {}),
				}),
			);
		if (cmd.spatial) assertSpatialTarget(target, h);
		let key = anim.keyframes.find((k) => k.time === time) as DKey | undefined;
		if (key) {
			key.value = value as never; // KF-002: same time → replace the value, keep id and interpolation
			if (cmd.interpolation) key.interpolation = cmd.interpolation;
			// keyframe-sides: an explicit incoming side follows a both-sided type (Auto / Continuous shape both sides).
			if (cmd.inInterpolation) key.inInterpolation = cmd.inInterpolation;
			else if (key.inInterpolation !== undefined && isBothSided(cmd.interpolation))
				key.inInterpolation = cmd.interpolation as InInterpolation;
			if (cmd.easeIn) setEase(key, 'in', cmd.easeIn);
			if (cmd.easeOut) setEase(key, 'out', cmd.easeOut);
		} else {
			const steps = hold || isHoldOnlyValue(value);
			// S03:KF-021: new keys of point properties get the property's spatial default (Auto Bezier for position).
			const spatial = steps ? undefined : newKeySpatial(target.rule.spatial, value);
			key = {
				id: h.ids.next('kf'),
				time,
				value: value as never,
				interpolation: cmd.interpolation ?? (steps ? 'hold' : 'linear'),
				...(cmd.inInterpolation && !steps ? { inInterpolation: cmd.inInterpolation } : {}),
				easeIn: { ...(cmd.easeIn ?? LINEAR) },
				easeOut: { ...(cmd.easeOut ?? LINEAR) },
				...(spatial ? { spatial } : {}),
			} as DKey;
			anim.keyframes.push(key);
		}
		const sides = keySidesIssue(key);
		if (sides) h.fail('E_INVALID_PARAM', `${target.label}: ${sides}`);
		const id = key.id;
		if (cmd.spatial) {
			anim.keyframes.sort((x, y) => x.time - y.time);
			const kfs = anim.keyframes as Keyframe<unknown>[];
			setSpatialMode(kfs, kfs.indexOf(key as Keyframe<unknown>), cmd.spatial, target.metric);
		}
		finish([anim], () => target.metric);
		h.defineRef(cmd.ref, id);
		return { keyframeId: id, time, value };
	},

	'keyframe.update': (doc, cmd: CommandOf<'keyframe.update'>, h: HandlerContext) => {
		const [loc] = locate(doc, [cmd.keyframeId], h);
		const target = targetOf(doc, loc!, h);
		const key = loc!.key;
		if (cmd.value !== undefined) {
			const v = validateValue(cmd.value, target.rule, h, target.label);
			if (v.clamped) h.warn('W_VALUE_CLAMPED', `${target.label} clamped to ${JSON.stringify(v.value)}`);
			key.value = v.value as never;
		}
		const side = cmd.side ?? 'both';
		// keyframe-sides: without `interpolation`, the edited side keeps its type.
		const interpolation =
			cmd.interpolation ??
			(side === 'in' ? (key.inInterpolation ?? inInterpolationLegacy(key)) : key.interpolation);
		if (cmd.interpolation !== undefined || cmd.easeIn || cmd.easeOut) {
			const refusal = sideRefusal(interpolation, side, cmd.easeIn, cmd.easeOut);
			if (refusal) h.fail('E_INVALID_PARAM', `${target.label}: ${refusal}`);
			applyInterpolation(loc!.anim, key, interpolation, cmd.easeIn, cmd.easeOut, side, target.metric);
		}
		if (cmd.spatial) {
			assertSpatialTarget(target, h);
			const kfs = loc!.anim.keyframes as Keyframe<unknown>[];
			setSpatialMode(kfs, kfs.indexOf(key as Keyframe<unknown>), cmd.spatial, target.metric);
		}
		finish([loc!.anim], () => target.metric);
		return { keyframeId: key.id };
	},

	'keyframe.remove': (doc, cmd: CommandOf<'keyframe.remove'>, h: HandlerContext) => {
		const found = locate(doc, cmd.keyframeIds, h);
		const touched = new Set<DAnim>();
		const metrics = new MetricMap();
		for (const loc of found) {
			metrics.note(targetOf(doc, loc, h)); // lock check
			const i = loc.anim.keyframes.findIndex((k) => k.id === loc.key.id);
			const [removed] = loc.anim.keyframes.splice(i, 1);
			// Removing the last key turns the stopwatch off and keeps that key's value (S01:KF-005).
			if (loc.anim.keyframes.length === 0) loc.anim.value = clone(removed!.value) as never;
			touched.add(loc.anim);
		}
		finish(touched, metrics.of);
		return { removed: found.length };
	},

	'keyframe.move': (doc, cmd: CommandOf<'keyframe.move'>, h: HandlerContext) => {
		const found = locate(doc, cmd.keyframeIds, h);
		const byAnim = new Map<DAnim, Located[]>();
		const metrics = new MetricMap();
		for (const loc of found) {
			metrics.note(targetOf(doc, loc, h));
			byAnim.set(loc.anim, [...(byAnim.get(loc.anim) ?? []), loc]);
		}
		const moved: Record<string, number> = {};
		for (const [anim, locs] of byAnim) {
			const loc = locs[0]!;
			// keyframes-blend: a roving key dragged in time stops roving (it gets a time of its own), keeping its speed.
			for (const l of locs)
				if (l.key.roving)
					stopRoving(
						anim.keyframes as Keyframe<unknown>[],
						anim.keyframes.indexOf(l.key as never),
						metrics.of(anim),
					);
			const g = gridOf(loc);
			// `frames` are sequence frames: on reversed clips content time runs backwards.
			const delta =
				'flicks' in cmd.delta
					? cmd.delta.flicks
					: cmd.delta.frames * g.step * (loc.clip?.speed.reverse ? -1 : 1);
			const movingIds = new Set(locs.map((l) => l.key.id));
			const targets = new Map<string, number>();
			for (const l of locs) {
				const t = snapTime(l, l.key.time + delta);
				if (t < 0) h.fail('E_INVALID_PARAM', `Keyframe ${l.key.id} would move before content time 0`);
				targets.set(l.key.id, t);
			}
			// Moving onto another key's time replaces that key (S01:KF-005); among moved keys the later wins.
			const occupied = new Set(targets.values());
			anim.keyframes = anim.keyframes.filter(
				(k) => movingIds.has(k.id) || !occupied.has(k.time),
			) as typeof anim.keyframes;
			const seen = new Map<number, DKey>();
			for (const k of anim.keyframes as DKey[]) {
				if (!movingIds.has(k.id)) continue;
				k.time = targets.get(k.id)!;
				moved[k.id] = k.time;
				seen.set(k.time, k);
			}
			anim.keyframes = anim.keyframes.filter(
				(k) => !movingIds.has(k.id) || seen.get(k.time) === k,
			) as typeof anim.keyframes;
		}
		finish(byAnim.keys(), metrics.of);
		return { times: moved };
	},

	'keyframe.setInterpolation': (doc, cmd: CommandOf<'keyframe.setInterpolation'>, h: HandlerContext) => {
		const found = locate(doc, cmd.keyframeIds, h);
		const touched = new Set<DAnim>();
		// Process in time order so neighbour conversions see the final state of earlier keys.
		found.sort((a, b) => a.key.time - b.key.time);
		const side = cmd.side ?? 'both';
		const refusal = sideRefusal(cmd.interpolation, side, cmd.easeIn, cmd.easeOut);
		if (refusal) h.fail('E_INVALID_PARAM', refusal);
		const metrics = new MetricMap();
		for (const loc of found) {
			const t = metrics.note(targetOf(doc, loc, h));
			applyInterpolation(loc.anim, loc.key, cmd.interpolation, cmd.easeIn, cmd.easeOut, side, t.metric);
			touched.add(loc.anim);
		}
		finish(touched, metrics.of);
		return { updated: found.length };
	},

	'keyframes.prune': (doc, cmd: CommandOf<'keyframes.prune'>, h: HandlerContext) => {
		const { seq, clip } = h.clip(doc, cmd.clipId);
		const F = flicksPerFrame(seq.settings.frameRate as Rational);
		const step = F * clip.speed.rate;
		const a = clip.sourceIn;
		const b = clip.sourceIn + (clip.duration - 1) * step;
		const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
		let removed = 0;
		for (const loc of clipAnimatables(seq, clip)) {
			const kfs = loc.anim.keyframes;
			if (kfs.length < 2) continue;
			const target = targetOf(doc, loc, h);
			// Keep keys inside the visible range plus the nearest key on each side (they shape it).
			let first = 0;
			while (first + 1 < kfs.length && kfs[first + 1]!.time <= lo) first++;
			let last = kfs.length - 1;
			while (last - 1 >= 0 && kfs[last - 1]!.time >= hi) last--;
			// Auto-bezier slopes depend on both neighbours: keep one more key so they do not change.
			if (first > 0 && kfs[first]!.interpolation === 'auto-bezier') first--;
			if (last < kfs.length - 1 && kfs[last]!.interpolation === 'auto-bezier') last++;
			if (first === 0 && last === kfs.length - 1) continue;
			removed += kfs.length - (last - first + 1);
			loc.anim.keyframes = kfs.slice(first, last + 1) as typeof kfs;
			finish([loc.anim], () => target.metric);
		}
		return { removed };
	},
} satisfies HandlerMap;
