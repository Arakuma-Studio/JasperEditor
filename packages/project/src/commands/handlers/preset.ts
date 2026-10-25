// effect.applyPreset (S03:FX-030, FX-010 "applying to N clips is one undo entry", AGT-002 `presets.apply`).
// The preset is validated first (parseEffectPreset). Per target clip:
// - intrinsic properties overwrite: Motion (only the properties the preset has), Opacity + Blend Mode, the pinned
//   Crop (the clip's first `jasper.crop`, created at index 0 when missing), Volume, Panner;
// - applied effects are appended (or inserted at `index`) as new instances with new ids; every param goes through
//   `buildParams`, so values are validated and clamped like `effect.add`, and keyframes get new ids;
// - key times map by the preset type (Scale / Anchor to In / Anchor to Out, effect-presets/time.ts) onto the clip's
//   frame grid and content time; `relative` presets re-express Motion values for the clip's frame and layer box.
// Unknown effect ids are skipped with a warning (W_PRESET_UNKNOWN_EFFECT); media params whose asset is not in the
// project fall back to the default (W_PRESET_MEDIA_MISSING). Nothing applicable on any clip fails the command.
import type { Draft } from 'immer';
import { type PresetAnim, parseEffectPreset } from '../../effect-presets/schema.ts';
import { presetKeyTime } from '../../effect-presets/time.ts';
import { EASE_PRESETS, normalizeKeySides } from '../../keyframes.ts';
import { CROP_EFFECT, type EffectSpec } from '../../registry/effects.ts';
import { kindCapabilities } from '../../registry/kinds.ts';
import { intrinsicBoxOf, resolvePropertySpec } from '../../registry/properties.ts';
import { dropForeignRotoRefs } from '../../roto/index.ts';
import type { Animatable, Keyframe, Vec2 } from '../../schema/common.ts';
import { type Clip, type EffectInstance, isKnownClipKind } from '../../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../../time.ts';
import type { DClip, DDoc, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { buildParams, validExpression } from './effect.ts';
import { refreshAutoBezier } from './keyframe.ts';
import { ruleFromParam, validateValue } from './param.ts';
import { clone, type HandlerMap, idList } from './util.ts';

export const PRESET_OWNER = 'wp-m3-presets';

type Rule = Parameters<typeof validateValue>[1];
type Box = { width: number; height: number };
type DRec = Draft<Record<string, unknown>>;

function propertyRule(key: string): Rule {
	const s = resolvePropertySpec(key)!;
	return { kind: s.kind, range: s.range, options: s.options, holdOnly: s.animatable !== 'continuous' };
}

const fit = (box: Box, frame: Box) => Math.min(frame.width / box.width, frame.height / box.height);

function applyPreset(doc: DDoc, cmd: CommandOf<'effect.applyPreset'>, h: HandlerContext) {
	const parsed = parseEffectPreset(cmd.preset);
	if (!parsed.ok) return h.fail(parsed.code, parsed.message, { path: ['preset'] });
	const preset = parsed.preset;
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	const rate = seq.settings.frameRate as Rational;
	const frame: Box = { width: seq.settings.width, height: seq.settings.height };
	const source = { duration: preset.source.duration, rate: preset.source.frameRate as Rational };
	if (!(flicksPerFrame(source.rate) > 0)) h.fail('E_INVALID_PARAM', 'preset.source.frameRate is invalid');
	const intrinsic = preset.intrinsic ?? {};
	const warned = new Set<string>();
	const warnOnce = (code: string, message: string) => {
		if (warned.has(`${code}:${message}`)) return;
		warned.add(`${code}:${message}`);
		h.warn(code, message);
	};
	const applied: Record<string, string[]> = {};
	const effectInstanceIds: Record<string, string[]> = {};
	const unknown = new Set<string>();

	for (const t of clips) {
		assertUnlocked(findTrackIn(seq, t.trackId)!.track, h);
		const caps = isKnownClipKind(t.kind) ? kindCapabilities(t.kind) : undefined;
		if (!caps) continue;
		const c = t as DRec & DClip;
		const timing = {
			start: t.start,
			duration: t.duration,
			sourceIn: t.sourceIn,
			speed: { rate: t.speed.rate, reverse: t.speed.reverse },
		};
		const keyTime = (o: number) => presetKeyTime(preset.type, o, source, { timing, rate });

		/** A preset anim on this clip: mapped key times (deduplicated, later wins), validated values, new ids. */
		const toAnim = <T>(a: PresetAnim<T>, rule: Rule, label: string, map?: (v: T) => T): Animatable<T> => {
			const val = (v: unknown) => {
				const r = validateValue(map ? map(v as T) : v, rule, h, label);
				if (r.clamped) warnOnce('W_VALUE_CLAMPED', `${label} clamped to the allowed range`);
				return r.value as T;
			};
			const byTime = new Map<number, Keyframe<T>>();
			for (const k of [...(a.keyframes ?? [])].sort((x, y) => x.time - y.time)) {
				const time = keyTime(k.time);
				const key: Keyframe<T> = {
					id: h.ids.next('kf'),
					time,
					value: val(k.value),
					interpolation: rule.holdOnly ? 'hold' : (k.interpolation ?? 'linear'),
					// keyframe-sides: the incoming side travels with the preset (made consistent below).
					...(k.inInterpolation !== undefined && !rule.holdOnly
						? { inInterpolation: k.inInterpolation }
						: {}),
					easeIn: k.easeIn
						? { influence: k.easeIn.influence, slope: k.easeIn.slope }
						: { ...EASE_PRESETS.linear },
					easeOut: k.easeOut
						? { influence: k.easeOut.influence, slope: k.easeOut.slope }
						: { ...EASE_PRESETS.linear },
				};
				normalizeKeySides(key);
				byTime.set(time, key);
			}
			const expression = validExpression(a.expression, label, h);
			const anim: Animatable<T> = {
				value: val(a.value),
				keyframes: [...byTime.values()].sort((x, y) => x.time - y.time),
				// Wave expressions: presets carry expressions (AE animation presets do).
				...(expression ? { expression } : {}),
			};
			refreshAutoBezier(anim as never);
			return anim;
		};

		/** Effect params with mapped key times, ready for `buildParams` (which validates and re-ids them). */
		const paramsFor = (spec: EffectSpec, params: Record<string, PresetAnim<unknown>>) => {
			const out: Record<string, Animatable<unknown>> = {};
			for (const [name, a] of Object.entries(params)) {
				const p = spec.params.find((x) => x.name === name);
				if (!p) {
					warnOnce('W_PRESET_PARAM_DROPPED', `${spec.label} has no parameter "${name}"; it was left out`);
					continue;
				}
				if (p.type === 'media') {
					const ids = [a.value, ...(a.keyframes ?? []).map((k) => k.value)].map(
						(v) => (v as { mediaId?: unknown } | null)?.mediaId,
					);
					if (ids.some((id) => typeof id !== 'string' || !doc.media[id])) {
						warnOnce(
							'W_PRESET_MEDIA_MISSING',
							`${spec.label} ${p.label}: the preset's media is not in this project; the default is used`,
						);
						continue;
					}
				}
				// buildParams validates and clamps animations silently: report clamping like effect.add does.
				const rule = ruleFromParam(p);
				for (const v of [a.value, ...(a.keyframes ?? []).map((k) => k.value)])
					if (validateValue(v, rule, h, `${spec.id}.${name}`).clamped)
						warnOnce('W_VALUE_CLAMPED', `${spec.label} ${p.label} clamped to the allowed range`);
				out[name] = {
					value: clone(a.value),
					keyframes: [...(a.keyframes ?? [])]
						.sort((x, y) => x.time - y.time)
						.map((k) => ({
							id: '',
							time: keyTime(k.time),
							value: clone(k.value),
							interpolation: k.interpolation ?? 'linear',
							...(k.inInterpolation !== undefined ? { inInterpolation: k.inInterpolation } : {}),
							easeIn: k.easeIn ?? { ...EASE_PRESETS.linear },
							easeOut: k.easeOut ?? { ...EASE_PRESETS.linear },
						}))
						// Keys mapped onto the same frame: the later one wins (as pastes do).
						.filter((k, i, arr) => arr[i + 1]?.time !== k.time),
					...(a.expression ? { expression: clone(a.expression) } : {}),
				};
			}
			return buildParams(spec, out, h);
		};

		const done: string[] = [];
		const m = intrinsic.motion;
		if (m && caps.hasTransform && 'transform' in c) {
			const tr = c.transform as DRec;
			let mapPos: ((v: Vec2) => Vec2) | undefined;
			let mapAnchor: ((v: Vec2) => Vec2) | undefined;
			let mapScale: ((v: number) => number) | undefined;
			const sf = preset.source.frame;
			if (preset.spatial === 'relative' && sf) {
				const sb = preset.source.box ?? sf;
				const tb = intrinsicBoxOf({ doc: doc as never, seq: seq as never, clip: t as Clip });
				mapPos = (v) => [(v[0] * frame.width) / sf.width, (v[1] * frame.height) / sf.height];
				mapAnchor = (v) => [(v[0] * tb.width) / sb.width, (v[1] * tb.height) / sb.height];
				const k = fit(tb, frame) / fit(sb, sf);
				mapScale = (v) => v * k;
			}
			const props = [
				['position', mapPos],
				['anchor', mapAnchor],
				['scale', mapScale],
				['scaleWidth', mapScale],
				['rotation', undefined],
			] as const;
			for (const [name, map] of props) {
				const a = m[name];
				if (a)
					tr[name] = toAnim(
						a as PresetAnim<unknown>,
						propertyRule(`transform.${name}`),
						`Motion ${name}`,
						map as never,
					) as never;
			}
			if (typeof m.uniformScale === 'boolean') tr.uniformScale = m.uniformScale;
			done.push('motion');
		}
		if ((intrinsic.opacity || intrinsic.blendMode) && 'opacity' in c) {
			if (intrinsic.opacity)
				c.opacity = toAnim(intrinsic.opacity, propertyRule('opacity'), 'Opacity') as never;
			if (intrinsic.blendMode && 'blendMode' in c) c.blendMode = intrinsic.blendMode;
			done.push('opacity');
		}
		const effects = () =>
			((c.effects as Draft<EffectInstance>[] | undefined) ??= [] as never) as Draft<EffectInstance>[];
		if (intrinsic.crop && caps.visual && caps.supportsEffects) {
			const spec = h.registries.effects.get(CROP_EFFECT.id) ?? CROP_EFFECT;
			const params = paramsFor(spec, intrinsic.crop.params as Record<string, PresetAnim<unknown>>);
			const list = effects();
			const existing = list.find((fx) => fx.effectId === CROP_EFFECT.id);
			if (existing) {
				existing.params = params as never;
				existing.enabled = intrinsic.crop.enabled ?? true;
			} else {
				list.splice(0, 0, {
					id: h.ids.next('fx'),
					effectId: spec.id,
					effectVersion: spec.version,
					enabled: intrinsic.crop.enabled ?? true,
					params,
				} as Draft<EffectInstance>);
			}
			done.push('crop');
		}
		if (intrinsic.volume && 'volumeDb' in c) {
			c.volumeDb = toAnim(intrinsic.volume, propertyRule('volumeDb'), 'Volume Level') as never;
			done.push('volume');
		}
		if (intrinsic.pan && 'pan' in c) {
			c.pan = toAnim(intrinsic.pan, propertyRule('pan'), 'Panner Balance') as never;
			done.push('panner');
		}
		const created: string[] = [];
		if (preset.effects?.length && caps.supportsEffects) {
			let at: number | null = null;
			for (const fx of preset.effects) {
				const spec =
					(fx.effectVersion !== undefined
						? h.registries.effects.get(fx.effectId, fx.effectVersion)
						: undefined) ?? h.registries.effects.get(fx.effectId);
				if (!spec) {
					unknown.add(fx.effectId);
					continue;
				}
				if ((spec.appliesTo === 'video' && !caps.visual) || (spec.appliesTo === 'audio' && !caps.audio))
					continue;
				const list = effects();
				at ??= Math.min(cmd.index ?? list.length, list.length);
				const instance: EffectInstance = {
					id: h.ids.next('fx'),
					effectId: spec.id,
					effectVersion: spec.version,
					enabled: fx.enabled ?? true,
					params: paramsFor(spec, fx.params as Record<string, PresetAnim<unknown>>),
				};
				dropForeignRotoRefs(c as { rotos?: { id: string }[] }, instance as never);
				list.splice(at++, 0, instance as Draft<EffectInstance>);
				created.push(instance.id);
				done.push(`effect:${spec.id}`);
			}
		}
		if (done.length) applied[t.id] = done;
		if (created.length) effectInstanceIds[t.id] = created;
	}
	for (const id of unknown)
		h.warn(
			'W_PRESET_UNKNOWN_EFFECT',
			`The preset uses an effect this version does not know (${id}); it was skipped`,
		);
	if (Object.keys(applied).length === 0)
		h.fail(
			'E_INVALID_PARAM',
			unknown.size && !preset.intrinsic
				? `"${preset.name}" only uses unknown effects (${[...unknown].join(', ')})`
				: `"${preset.name}" does not apply to these clips`,
		);
	return {
		presetId: preset.id,
		clipIds: Object.keys(applied),
		applied,
		effectInstanceIds,
		...(unknown.size ? { unknownEffects: [...unknown] } : {}),
	};
}

export const presetHandlers = {
	'effect.applyPreset': applyPreset,
} satisfies HandlerMap;
