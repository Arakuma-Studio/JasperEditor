// Reconciling a clip's essential effects, gain, Volume and pan with its Essential Sound settings (port of filmcraft
// `essential::apply`): missing effects are inserted in canonical order, effects of slots that were switched off are
// removed, and only parameters whose derived value changed are written — at `time` (content flicks) as a keyframe when
// the parameter is animated, else as the static value — so keyframes the user added in Effect Controls survive
// unrelated slider moves. Gain, Volume and pan change by deltas (the user's own levels are kept).
import { audioEffectSpec } from '../registry/audio/index.ts';
import type { Animatable, Keyframe, ParamValue } from '../schema/common.ts';
import type { EffectInstance } from '../schema/sequence.ts';
import {
	ESSENTIAL_SLOTS,
	type EssentialSlot,
	type EssentialSound,
	essentialEffects,
	loudnessGainDb,
	panValue,
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

/** Adds `db` to a level: the static value and every keyframe (keeps ducking shapes). */
export function offsetLevel(a: Animatable<number>, db: number): void {
	const add = (v: number) => Math.min(Math.max(v + db, -96), 15);
	a.value = add(a.value);
	for (const k of a.keyframes) k.value = add(k.value);
}

export type ReconcileContext = {
	/** Content time (flicks) where changed animated parameters get their keyframe (the playhead). */
	time: number;
	newEffectId(): string;
	newKey: NewKey;
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
	const dv = volumeOffsetDb(next) - volumeOffsetDb(old);
	if (Math.abs(dv) > 1e-12) offsetLevel(clip.volumeDb, dv);
	const pOld = panValue(old);
	const pNew = panValue(next);
	if (pNew !== pOld) setAt(clip.pan as Animatable<ParamValue>, pNew ?? 0, ctx.time, ctx.newKey, false);
}
