// Effect stack handlers (ARCHITECTURE §5.3, S01 §11.3 FX-020…023): effect.add (clip, track or master
// target, optional index and params), effect.remove, effect.reorder, effect.setEnabled.
// Unknown effects already in a document are preserved verbatim and may still be removed, reordered or
// bypassed; only adding an unknown effect id is refused (S01:FX-022).
import type { Draft } from 'immer';
import { EASE_PRESETS } from '../../keyframes.ts';
import type { EffectSpec } from '../../registry/effects.ts';
import { kindCapabilities } from '../../registry/kinds.ts';
import { type Animatable, EaseSchema, InterpolationSchema, type ParamValue } from '../../schema/common.ts';
import { type EffectInstance, isKnownClipKind, type Track } from '../../schema/sequence.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { refreshAutoBezier } from './keyframe.ts';
import { ruleFromParam, validateValue } from './param.ts';
import type { HandlerMap } from './util.ts';

type DEffect = Draft<EffectInstance>;

export type EffectLocation = {
	seq: DSeq;
	/** The stack that holds the effect (clip, track or master effects). */
	list: DEffect[];
	index: number;
	fx: DEffect;
	clip: DClip | null;
	track: Draft<Track> | null;
};

/** Finds an effect instance anywhere in the document. */
export function locateEffect(doc: DDoc, fxId: string): EffectLocation | null {
	for (const seq of Object.values(doc.sequences)) {
		for (const clip of Object.values(seq.clips)) {
			const list = (clip as { effects?: DEffect[] }).effects;
			const index = list?.findIndex((e) => e.id === fxId) ?? -1;
			if (list && index >= 0) return { seq, list, index, fx: list[index]!, clip, track: null };
		}
		for (const t of [...seq.videoTracks, ...seq.audioTracks]) {
			const index = t.effects?.findIndex((e) => e.id === fxId) ?? -1;
			if (t.effects && index >= 0)
				return { seq, list: t.effects, index, fx: t.effects[index]!, clip: null, track: t };
		}
		const index = seq.master.effects.findIndex((e) => e.id === fxId);
		if (index >= 0)
			return {
				seq,
				list: seq.master.effects,
				index,
				fx: seq.master.effects[index]!,
				clip: null,
				track: null,
			};
	}
	return null;
}

function mustLocate(doc: DDoc, fxId: string, h: HandlerContext): EffectLocation {
	const loc = locateEffect(doc, fxId);
	if (!loc) return h.fail('E_NOT_FOUND', `Effect instance not found: ${fxId}`);
	if (loc.clip) assertUnlocked(findTrackIn(loc.seq, loc.clip.trackId)!.track, h);
	if (loc.track) assertUnlocked(loc.track, h);
	return loc;
}

/** Initial params: registry defaults with validated overrides (values or full Animatables). */
function buildParams(
	spec: EffectSpec,
	overrides: Record<string, unknown> | undefined,
	h: HandlerContext,
): Record<string, Animatable<ParamValue>> {
	for (const name of Object.keys(overrides ?? {}))
		if (!spec.params.some((p) => p.name === name))
			h.fail('E_INVALID_PARAM', `${spec.id} has no parameter "${name}"`);
	const out: Record<string, Animatable<ParamValue>> = {};
	for (const p of spec.params) {
		const raw = overrides?.[p.name];
		const label = `${spec.id}.${p.name}`;
		if (raw === undefined) {
			out[p.name] = { value: JSON.parse(JSON.stringify(p.default)) as ParamValue, keyframes: [] };
			continue;
		}
		if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'keyframes' in raw && 'value' in raw) {
			// Pasted/duplicated animation: validate the static value and every key value.
			const a = raw as Animatable<unknown>;
			const rule = ruleFromParam(p);
			const value = validateValue(a.value, rule, h, label).value as ParamValue;
			if (!Array.isArray(a.keyframes)) h.fail('E_INVALID_PARAM', `${label}: keyframes must be an array`);
			const keyframes = a.keyframes.map((k, i) => {
				// Only the S01 keyframe fields are taken over; each one is checked so a pasted or agent-supplied
				// animation can never leave the document with keys the evaluator cannot read.
				const where = `${label} keyframe ${i}`;
				const time = (k as { time?: unknown }).time;
				if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0)
					h.fail('E_INVALID_PARAM', `${where}: time must be a non-negative integer (flicks)`);
				const interp = InterpolationSchema.safeParse(
					(k as { interpolation?: unknown }).interpolation ?? 'linear',
				);
				if (!interp.success) h.fail('E_INVALID_PARAM', `${where}: unknown interpolation`);
				const ease = (e: unknown) => {
					if (e === undefined) return { ...EASE_PRESETS.linear };
					const r = EaseSchema.safeParse(e);
					if (!r.success) return h.fail('E_INVALID_PARAM', `${where}: invalid ease`);
					return { influence: r.data.influence, slope: r.data.slope };
				};
				const v = validateValue(k.value, rule, h, label).value as ParamValue;
				return {
					id: h.ids.next('kf'),
					time: time as number,
					value: v,
					interpolation: rule.holdOnly ? ('hold' as const) : interp.data!,
					easeIn: ease((k as { easeIn?: unknown }).easeIn),
					easeOut: ease((k as { easeOut?: unknown }).easeOut),
				};
			});
			keyframes.sort((x, y) => x.time - y.time);
			for (let i = 1; i < keyframes.length; i++)
				if (keyframes[i]!.time === keyframes[i - 1]!.time)
					h.fail('E_INVALID_PARAM', `${label}: two keyframes at the same time`);
			const anim = { value, keyframes } as Animatable<ParamValue>;
			refreshAutoBezier(anim as never);
			out[p.name] = anim;
			continue;
		}
		const v = validateValue(raw, ruleFromParam(p), h, label);
		if (v.clamped) h.warn('W_VALUE_CLAMPED', `${label} clamped to ${JSON.stringify(v.value)}`);
		out[p.name] = { value: v.value as ParamValue, keyframes: [] };
	}
	return out;
}

export const effectHandlers: HandlerMap = {
	'effect.add': (doc, cmd: CommandOf<'effect.add'>, h: HandlerContext) => {
		const spec = h.registries.effects.get(cmd.effectId);
		if (!spec) return h.fail('E_UNKNOWN_EFFECT', `Unknown effect: ${cmd.effectId}`);
		let list: DEffect[];
		if (cmd.target === 'master') {
			const seq = h.sequence(doc, cmd.sequenceId);
			if (spec.appliesTo !== 'audio')
				h.fail('E_INVALID_PARAM', `${spec.label} is a video effect; the master bus takes audio effects`);
			list = seq.master.effects;
		} else if ('clipId' in cmd.target) {
			const { seq, clip } = h.clip(doc, cmd.target.clipId);
			assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
			const caps = isKnownClipKind(clip.kind) ? kindCapabilities(clip.kind) : undefined;
			if (!caps?.supportsEffects)
				h.fail('E_INVALID_PARAM', `${clip.kind} clips do not take effects`, { path: [clip.id] });
			if ((spec.appliesTo === 'video' && !caps!.visual) || (spec.appliesTo === 'audio' && !caps!.audio))
				h.fail(
					'E_INVALID_PARAM',
					`${spec.label} is a ${spec.appliesTo} effect and cannot go on a ${clip.kind} clip`,
					{
						path: [clip.id],
					},
				);
			const c = clip as { effects?: DEffect[] };
			c.effects ??= [];
			list = c.effects;
		} else {
			const seq = h.sequence(doc, cmd.target.sequenceId ?? cmd.sequenceId);
			const track = h.track(seq, cmd.target.trackId);
			assertUnlocked(track, h);
			if (track.kind !== spec.appliesTo)
				h.fail('E_INVALID_PARAM', `${spec.label} cannot go on a ${track.kind} track`, { path: [track.id] });
			track.effects ??= [];
			list = track.effects;
		}
		const fx: EffectInstance = {
			id: h.ids.next('fx'),
			effectId: spec.id,
			effectVersion: spec.version,
			enabled: true,
			params: buildParams(spec, cmd.params, h),
		};
		const index = Math.min(cmd.index ?? list.length, list.length);
		list.splice(index, 0, fx as DEffect);
		h.defineRef(cmd.ref, fx.id);
		return { effectInstanceId: fx.id, index };
	},

	'effect.remove': (doc, cmd: CommandOf<'effect.remove'>, h: HandlerContext) => {
		const loc = mustLocate(doc, cmd.effectInstanceId, h);
		loc.list.splice(loc.index, 1);
		return { effectInstanceId: loc.fx.id, effectId: loc.fx.effectId };
	},

	'effect.reorder': (doc, cmd: CommandOf<'effect.reorder'>, h: HandlerContext) => {
		const loc = mustLocate(doc, cmd.effectInstanceId, h);
		const [fx] = loc.list.splice(loc.index, 1);
		const index = Math.min(cmd.index, loc.list.length);
		loc.list.splice(index, 0, fx!);
		return { index };
	},

	'effect.setEnabled': (doc, cmd: CommandOf<'effect.setEnabled'>, h: HandlerContext) => {
		const loc = mustLocate(doc, cmd.effectInstanceId, h);
		loc.fx.enabled = cmd.enabled;
		return { enabled: cmd.enabled };
	},
};
