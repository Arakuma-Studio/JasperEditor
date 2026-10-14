// Reconciling a clip's essential effects, gain, Volume and pan with its Essential Sound settings (port of filmcraft
// `essential::apply`): missing effects are inserted in canonical order, effects of slots that were switched off are
// removed, and only parameters whose derived value changed are written — at `time` (content flicks) as a keyframe when
// the parameter is animated, else as the static value — so keyframes the user added in Effect Controls survive
// unrelated slider moves. Gain, Volume and pan change by deltas (the user's own levels are kept, see `offsetLevel`).
import { audioEffectSpec } from '../registry/audio/index.ts';
import type { Animatable, Keyframe, ParamValue } from '../schema/common.ts';
import type { EffectInstance } from '../schema/sequence.ts';
import {
	ESSENTIAL_SLOTS,
	type EssentialSlot,
	type EssentialSound,
	essentialEffects,
	loudnessGainDb,
	panOffset,
	volumeOffsetDb,
} from './model.ts';

/** The audio clip fields reconciliation touches. */
export type EssentialTarget = {
	gainDb: number;
	volumeDb: Animatable<number>;
	pan: Animatable<number>;
	effects: EffectInstance[];
};

type NewKey = (time: number, value: ParamValue, hold: boolean) => Keyframe<ParamValue>;

const rank = (slot: string | undefined) => {
	const i = ESSENTIAL_SLOTS.indexOf(slot as EssentialSlot);
	return i < 0 ? ESSENTIAL_SLOTS.length : i;
};

/** Writes `value` at `time`: a keyframe (replacing one at the same time) when animated, else the static value. */
function setAt(
	a: Animatable<ParamValue>,
	value: ParamValue,
	time: number,
	newKey: NewKey,
	hold: boolean,
): void {
	if (a.keyframes.length === 0) {
		a.value = value;
		return;
	}
	const k = a.keyframes.find((x) => x.time === time);
	if (k) k.value = value;
	else {
		a.keyframes.push(newKey(time, value, hold));
		a.keyframes.sort((x, y) => x.time - y.time);
	}
}

/**
 * Adds `d` to a level: the static value and every keyframe (keeps ducking shapes), clamped to `[lo, hi]`. What the
 * clamp takes away is kept in `residual` (per `value` / keyframe id) and given back by the next offset, so an
 * offset switched on and off again restores the level exactly. A residual only applies while its value still sits
 * on the bound it was clamped to: once the user moved that value (Effect Controls, Clip Mixer, keyframe edits) it is
 * stale and dropped. Residuals are limited to the range width (a hostile file cannot store more).
 */
export function offsetLevel(
	a: Animatable<number>,
	d: number,
	lo = -96,
	hi = 15,
	residual: Record<string, number> = {},
): void {
	const left: Record<string, number> = {};
	const add = (key: string, v: number) => {
		const r = residual[key] ?? 0;
		const live =
			Number.isFinite(r) && ((r > 0 && v >= hi - 1e-9) || (r < 0 && v <= lo + 1e-9))
				? Math.sign(r) * Math.min(Math.abs(r), hi - lo)
				: 0;
		const want = v + d + live;
		const got = Math.min(Math.max(want, lo), hi) + 0;
		if (Math.abs(want - got) > 1e-9) left[key] = want - got;
		return got;
	};
	a.value = add('value', a.value);
	for (const k of a.keyframes) k.value = add(k.id, k.value);
	for (const k of Object.keys(residual)) delete residual[k];
	Object.assign(residual, left);
}

export type ReconcileContext = {
	/** Content time (flicks) where changed animated parameters get their keyframe (the playhead). */
	time: number;
	newEffectId(): string;
	newKey: NewKey;
	/** Clamp residuals of the Clip Volume and Pan offsets (see `offsetLevel`); updated in place. */
	residual?: { volume: Record<string, number>; pan: Record<string, number> };
};

/** Reconciles `clip` from the settings `old` (null = none applied yet) to `next` (null = type cleared). */
export function reconcileEssential(
	clip: EssentialTarget,
	old: EssentialSound | null,
	next: EssentialSound | null,
	ctx: ReconcileContext,
): void {
	const want = essentialEffects(next);
	const had = essentialEffects(old);
	// Remove essential effects no longer wanted.
	for (let i = clip.effects.length - 1; i >= 0; i--) {
		const e = clip.effects[i]!;
		if (e.essential && !want.some((w) => w.slot === e.essential && w.effectId === e.effectId))
			clip.effects.splice(i, 1);
	}
	for (const w of want) {
		const existing = clip.effects.find((e) => e.essential === w.slot && e.effectId === w.effectId);
		const spec = audioEffectSpec(w.effectId);
		if (!spec) continue;
		if (existing) {
			existing.enabled = w.enabled;
			const prev = had.find((h) => h.slot === w.slot);
			for (const [name, v] of Object.entries(w.params)) {
				if (prev && prev.params[name] === v) continue;
				const p = existing.params[name];
				const ps = spec.params.find((x) => x.name === name);
				if (!p || !ps) continue;
				setAt(p, v, ctx.time, ctx.newKey, ps.type !== 'number');
			}
			continue;
		}
		const params: Record<string, Animatable<ParamValue>> = {};
		for (const ps of spec.params)
			params[ps.name] = {
				value: (w.params[ps.name] ?? JSON.parse(JSON.stringify(ps.default))) as ParamValue,
				keyframes: [],
			};
		const fx: EffectInstance = {
			id: ctx.newEffectId(),
			effectId: spec.id,
			effectVersion: spec.version,
			enabled: w.enabled,
			params,
			essential: w.slot,
		};
		// After the last essential effect of a lower rank, else first (before the user's effects).
		const r = rank(w.slot);
		let pos = 0;
		clip.effects.forEach((e, i) => {
			if (e.essential && rank(e.essential) < r) pos = i + 1;
		});
		clip.effects.splice(pos, 0, fx);
	}
	// Clip gain (Auto-Match), Volume offset (Clip Volume), Pan.
	const dg = loudnessGainDb(next) - loudnessGainDb(old);
	if (Math.abs(dg) > 1e-12) clip.gainDb = Math.min(Math.max(clip.gainDb + dg, -96), 96);
	const res = ctx.residual ?? { volume: {}, pan: {} };
	const dv = volumeOffsetDb(next) - volumeOffsetDb(old);
	if (Math.abs(dv) > 1e-12) offsetLevel(clip.volumeDb, dv, -96, 15, res.volume);
	const dp = panOffset(next) - panOffset(old);
	if (Math.abs(dp) > 1e-12) offsetLevel(clip.pan, dp, -100, 100, res.pan);
}
