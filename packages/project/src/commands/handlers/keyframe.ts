// Keyframe handlers (ARCHITECTURE §5.3, S01 §12, S03 §12.3): keyframe.add/update/remove/move,
// keyframe.setInterpolation (Linear / Bezier / Auto Bezier / Continuous Bezier / Hold and the Ease In,
// Ease Out, Easy Ease presets of S01:KF-004) and keyframes.prune (S01:KF-006).
//
// Keyframes live in content time (flicks) of the owning clip; track and master parameters use sequence
// time in flicks (S01:KF-002). Keys are addressed by id; the handlers locate them anywhere in the
// document and re-use param.ts target resolution for validation, lock checks and time conversion.
import type { Draft } from 'immer';
import { autoSlope, EASE_PRESETS, evaluate, isHoldOnlyValue } from '../../keyframes.ts';
import { PROPERTY_SPECS } from '../../registry/properties.ts';
import type { Animatable, Ease, Interpolation, Keyframe } from '../../schema/common.ts';
import { type EffectInstance, isKnownClipKind, type Track } from '../../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../../time.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import type { CommandOf, ParamPath } from '../schemas/index.ts';
import { PRUNE_EMPTY_KEYFRAMES, templateParamDraftAnim } from './mg-template.ts';
import { getAt, resolveTarget, type Target, validateValue } from './param.ts';
import type { HandlerMap } from './util.ts';

type DAnim = Draft<Animatable<unknown>>;
type DKey = Draft<Keyframe<unknown>>;

const LINEAR: Ease = EASE_PRESETS.linear;
const AUTO_INFLUENCE = 1 / 3;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function isAnim(v: unknown): v is DAnim {
	return (
		!!v && typeof v === 'object' && 'value' in v && Array.isArray((v as { keyframes?: unknown }).keyframes)
	);
}

/** One animatable parameter somewhere in the document. */
type AnimLocation = {
	anim: DAnim;
	/** ParamPath addressing it (S01:CMD-010). */
	path: ParamPath;
	seq: DSeq;
	/** Owning clip (content-time keys), or null for track/master parameters (sequence time). */
	clip: DClip | null;
};

/** Every animatable parameter of one clip: intrinsic properties and applied effect params. */
function clipAnimatables(seq: DSeq, clip: DClip): AnimLocation[] {
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
function allAnimatables(doc: DDoc): AnimLocation[] {
	const out: AnimLocation[] = [];
	for (const seq of Object.values(doc.sequences)) {
		for (const clip of Object.values(seq.clips)) out.push(...clipAnimatables(seq, clip));
		for (const t of [...seq.videoTracks, ...seq.audioTracks]) out.push(...trackAnimatables(seq, t));
		if (isAnim(seq.master.volumeDb))
			out.push({ anim: seq.master.volumeDb as DAnim, path: ['master', seq.id, 'volumeDb'], seq, clip: null });
		for (const fx of seq.master.effects)
			for (const [name, a] of Object.entries(fx.params))
				if (isAnim(a)) out.push({ anim: a, path: ['effect', fx.id, name], seq, clip: null });
	}
	return out;
}

type Located = AnimLocation & { key: DKey };

/** Finds keyframes by id; fails with E_NOT_FOUND for any missing id. */
function locate(doc: DDoc, ids: readonly string[], h: HandlerContext): Located[] {
	const want = new Set(ids);
	const found = new Map<string, Located>();
	for (const loc of allAnimatables(doc)) {
		for (const k of loc.anim.keyframes) if (want.has(k.id)) found.set(k.id, { ...loc, key: k as DKey });
		if (found.size === want.size) break;
	}
	for (const id of want) if (!found.has(id)) h.fail('E_NOT_FOUND', `Keyframe not found: ${id}`);
	return [...want].map((id) => found.get(id)!);
}

/** Target resolution (validation rule, lock check) for a located parameter. */
function targetOf(doc: DDoc, loc: AnimLocation, h: HandlerContext): Extract<Target, { type: 'anim' }> {
	const t = resolveTarget(doc, { target: [...loc.path], sequenceId: loc.seq.id }, h);
	if (t.type !== 'anim') return h.fail('E_INVALID_PARAM', `${t.label} is not animatable`);
	return t;
}

// ---------------------------------------------------------------- curve maintenance

function magnitude(a: unknown, b: unknown): number {
	if (typeof a === 'number' && typeof b === 'number') return Math.abs(b - a);
	if (Array.isArray(a) && Array.isArray(b)) {
		let s = 0;
		for (let i = 0; i < a.length; i++) s += ((b[i] as number) - (a[i] as number)) ** 2;
		return Math.sqrt(s);
	}
	return 0;
}

/** Average speed (value units per flick) of the segment between keys i and i+1, or 0. */
function segmentVelocity(kfs: readonly Keyframe<unknown>[], i: number): number {
	const a = kfs[i];
	const b = kfs[i + 1];
	if (!a || !b || b.time === a.time) return 0;
	return magnitude(a.value, b.value) / (b.time - a.time);
}

/**
 * Stores the auto-bezier eases of every `auto-bezier` key (S01:KF-004, S03:KF-020 "recomputed whenever
 * a neighbor changes"). The evaluator derives them on the fly anyway; storing keeps the stored eases
 * honest for the UI and for a later switch to `bezier` (which then starts from the auto shape).
 */
export function refreshAutoBezier(anim: DAnim): void {
	const kfs = anim.keyframes;
	kfs.forEach((key, i) => {
		if (key.interpolation !== 'auto-bezier') return;
		key.easeIn = { influence: AUTO_INFLUENCE, slope: autoSlope(kfs, i, 'in') };
		key.easeOut = { influence: AUTO_INFLUENCE, slope: autoSlope(kfs, i, 'out') };
	});
}

/**
 * Continuous Bezier (S01:KF-004): the side that was not edited gets the same velocity as the edited
 * one, so the curve has no corner. Slopes are normalized per segment, so the conversion scales by the
 * ratio of the two segments' average speeds.
 */
function matchContinuous(anim: DAnim, i: number, edited: 'in' | 'out'): void {
	const kfs = anim.keyframes as Keyframe<unknown>[];
	const key = anim.keyframes[i] as DKey;
	const vIn = segmentVelocity(kfs, i - 1);
	const vOut = segmentVelocity(kfs, i);
	if (i === 0 || i === kfs.length - 1) return; // one side only
	if (edited === 'out') {
		const slope = vIn > 0 ? (key.easeOut.slope * vOut) / vIn : key.easeOut.slope;
		key.easeIn = { influence: key.easeIn.influence, slope: Math.max(0, slope) };
	} else {
		const slope = vOut > 0 ? (key.easeIn.slope * vIn) / vOut : key.easeIn.slope;
		key.easeOut = { influence: key.easeOut.influence, slope: Math.max(0, slope) };
	}
}

function finish(anims: Iterable<DAnim>): void {
	for (const a of anims) {
		a.keyframes.sort((x, y) => x.time - y.time);
		refreshAutoBezier(a);
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

function setEase(key: DKey, side: 'in' | 'out', e: Ease): void {
	if (side === 'in') key.easeIn = { influence: e.influence, slope: e.slope };
	else key.easeOut = { influence: e.influence, slope: e.slope };
}

/**
 * Applies an interpolation (+ optional eases) to one key. For Ease In on a key whose previous key is
 * `linear`, the previous key becomes `bezier` with linear-equivalent eases: the segment then honours
 * the new arrival ease while the previous key's other segment is unchanged (S01:KF-003 step 5).
 */
function applyInterpolation(
	anim: DAnim,
	key: DKey,
	interpolation: Interpolation,
	easeIn: Ease | undefined,
	easeOut: Ease | undefined,
): void {
	key.interpolation = interpolation;
	if (easeIn) setEase(key, 'in', easeIn);
	if (easeOut) setEase(key, 'out', easeOut);
	const i = anim.keyframes.indexOf(key);
	if (interpolation === 'bezier' && easeIn && i > 0) {
		const prev = anim.keyframes[i - 1] as DKey;
		if (prev.interpolation === 'linear') {
			prev.interpolation = 'bezier';
			prev.easeIn = { ...LINEAR };
			prev.easeOut = { ...LINEAR };
		}
	}
	if (interpolation === 'continuous-bezier') matchContinuous(anim, i, easeIn && !easeOut ? 'in' : 'out');
}

// ---------------------------------------------------------------- handlers

export const keyframeHandlers: HandlerMap = {
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
		} else value = clone(evaluate(anim as Animatable<unknown>, time, { holdOnly: hold }));
		let key = anim.keyframes.find((k) => k.time === time) as DKey | undefined;
		if (key) {
			key.value = value as never; // KF-002: same time → replace the value, keep id and interpolation
			if (cmd.interpolation) key.interpolation = cmd.interpolation;
			if (cmd.easeIn) setEase(key, 'in', cmd.easeIn);
			if (cmd.easeOut) setEase(key, 'out', cmd.easeOut);
		} else {
			key = {
				id: h.ids.next('kf'),
				time,
				value: value as never,
				interpolation: cmd.interpolation ?? (hold || isHoldOnlyValue(value) ? 'hold' : 'linear'),
				easeIn: { ...(cmd.easeIn ?? LINEAR) },
				easeOut: { ...(cmd.easeOut ?? LINEAR) },
			} as DKey;
			anim.keyframes.push(key);
		}
		const id = key.id;
		finish([anim]);
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
		const interpolation = cmd.interpolation ?? key.interpolation;
		if (cmd.interpolation !== undefined || cmd.easeIn || cmd.easeOut)
			applyInterpolation(loc!.anim, key, interpolation, cmd.easeIn, cmd.easeOut);
		finish([loc!.anim]);
		return { keyframeId: key.id };
	},

	'keyframe.remove': (doc, cmd: CommandOf<'keyframe.remove'>, h: HandlerContext) => {
		const found = locate(doc, cmd.keyframeIds, h);
		const touched = new Set<DAnim>();
		for (const loc of found) {
			targetOf(doc, loc, h); // lock check
			const i = loc.anim.keyframes.findIndex((k) => k.id === loc.key.id);
			const [removed] = loc.anim.keyframes.splice(i, 1);
			// Removing the last key turns the stopwatch off and keeps that key's value (S01:KF-005).
			if (loc.anim.keyframes.length === 0) loc.anim.value = clone(removed!.value) as never;
			touched.add(loc.anim);
		}
		finish(touched);
		return { removed: found.length };
	},

	'keyframe.move': (doc, cmd: CommandOf<'keyframe.move'>, h: HandlerContext) => {
		const found = locate(doc, cmd.keyframeIds, h);
		const byAnim = new Map<DAnim, Located[]>();
		for (const loc of found) {
			targetOf(doc, loc, h);
			byAnim.set(loc.anim, [...(byAnim.get(loc.anim) ?? []), loc]);
		}
		const moved: Record<string, number> = {};
		for (const [anim, locs] of byAnim) {
			const loc = locs[0]!;
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
		finish(byAnim.keys());
		return { times: moved };
	},

	'keyframe.setInterpolation': (doc, cmd: CommandOf<'keyframe.setInterpolation'>, h: HandlerContext) => {
		const found = locate(doc, cmd.keyframeIds, h);
		const touched = new Set<DAnim>();
		// Process in time order so neighbour conversions see the final state of earlier keys.
		found.sort((a, b) => a.key.time - b.key.time);
		for (const loc of found) {
			targetOf(doc, loc, h);
			applyInterpolation(loc.anim, loc.key, cmd.interpolation, cmd.easeIn, cmd.easeOut);
			touched.add(loc.anim);
		}
		finish(touched);
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
			targetOf(doc, loc, h);
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
			finish([loc.anim]);
		}
		return { removed };
	},
};
