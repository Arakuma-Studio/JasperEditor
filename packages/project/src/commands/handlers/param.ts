// param.set / param.setAnimated with Effect Controls stopwatch semantics (S01:KF-005, CMD-010, CMD-013).
import type { Draft } from 'immer';
import { compositionOfClip } from '../../composition/props.ts';
import { evaluate, isHoldOnlyValue, retimeRoving } from '../../keyframes.ts';
import { newKeySpatial, refreshAutoTangents } from '../../keyframes-spatial.ts';
import {
	MASK_EXPANSION_RANGE,
	MASK_FEATHER_RANGE,
	MASK_OPACITY_RANGE,
	MASK_PROP_LABELS,
	MASK_PROPS,
	type MaskProp,
} from '../../masks/model.ts';
import type { ParamSpec } from '../../registry/effects.ts';
import { type PropertySpec, resolvePropertySpec } from '../../registry/properties.ts';
import type { Animatable, Keyframe, SpatialInterpolation } from '../../schema/common.ts';
import type { Clip, EffectInstance, Sequence, Track } from '../../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../../time.ts';
import { transitionSpec, transitionStartFrame } from '../../transitions.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import { ClipPatchSchema } from '../schemas/clip.ts';
import type { CommandOf, ParamAt } from '../schemas/index.ts';
import { applyClipPatch } from './clip-core.ts';
import { setCompositionProp } from './composition.ts';
import { locateMask, validateMaskPath } from './mask.ts';
import { templateParamDraftAnim, templateParamsValidator } from './mg-template.ts';
import { ensureShapeStorage } from './shape.ts';
import type { HandlerMap } from './util.ts';

type ValueRule = {
	kind:
		| 'number'
		| 'vec2'
		| 'vec3'
		| 'color'
		| 'enum'
		| 'boolean'
		| 'string'
		| 'media'
		| 'curve'
		| 'json'
		| 'maskPath';
	range?: { min?: number; max?: number };
	options?: readonly string[];
	holdOnly: boolean;
	/** vec2 point parameters: the spatial interpolation of new keys (S03:KF-021); absent = not a point. */
	spatial?: SpatialInterpolation;
	/** wp shapes: structural check of the value (vector shape paths and gradients). */
	check?: (v: unknown) => boolean;
};

/** A resolved parameter target: either an Animatable (keyframable) or a static setter. */
export type Target =
	| {
			type: 'anim';
			anim: Draft<Animatable<unknown>>;
			rule: ValueRule;
			time(at: ParamAt | undefined): number;
			label: string;
	  }
	| { type: 'static'; set(v: unknown): void; rule: ValueRule; label: string };

function ruleFromProperty(s: PropertySpec): ValueRule {
	return {
		kind: s.kind,
		range: s.range,
		options: s.options,
		holdOnly: s.animatable === 'hold-only',
		...(s.kind === 'vec2' && s.animatable === 'continuous' && s.spatial ? { spatial: s.spatial } : {}),
		...(s.validate ? { check: s.validate } : {}),
	};
}
export function ruleFromParam(p: ParamSpec): ValueRule {
	return {
		kind: p.type,
		range: p.range,
		options: p.options,
		holdOnly: !p.animatable,
		...(p.type === 'vec2' && p.animatable && p.spatial ? { spatial: p.spatial } : {}),
	};
}

export function getAt(obj: unknown, path: readonly string[]): unknown {
	let cur = obj as Record<string, unknown> | undefined;
	for (const k of path) {
		if (!cur || typeof cur !== 'object') return undefined;
		cur = cur[k] as Record<string, unknown> | undefined;
	}
	return cur;
}

type EffectLocation = {
	seq: DSeq;
	list: Draft<EffectInstance>[];
	index: number;
	fx: Draft<EffectInstance>;
	clip: DClip | null;
	track: Draft<Track> | null;
};

/** Finds an effect instance in a clip, track or master stack. */
export function locateEffect(doc: DDoc, fxId: string): EffectLocation | null {
	for (const seq of Object.values(doc.sequences)) {
		for (const clip of Object.values(seq.clips)) {
			const list = (clip as { effects?: Draft<EffectInstance>[] }).effects;
			const index = list?.findIndex((e) => e.id === fxId) ?? -1;
			if (list && index >= 0) return { seq, list, index, fx: list[index]!, clip, track: null };
		}
		for (const t of [...seq.videoTracks, ...seq.audioTracks, ...(seq.submixTracks ?? [])]) {
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

/**
 * Resolves a parameter path. `create`: the caller writes an explicit value (param.set, keyframe.add with a value),
 * so a "None" shape fill/stroke may be created first (S11:SHP-003).
 */
export function resolveTarget(
	doc: DDoc,
	cmd: { target: string[]; sequenceId?: string },
	h: HandlerContext,
	opts: { create?: boolean } = {},
): Target {
	const [head, a, ...rest] = cmd.target;
	const bad = (): never =>
		h.fail('E_INVALID_PARAM', `Unsupported parameter path: ${JSON.stringify(cmd.target)}`);
	if (head === 'clip' && a) {
		const { seq, clip } = h.clip(doc, a);
		assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
		const key = rest.join('.');
		const template =
			clip.kind === 'motion-graphic'
				? h.registries.mgTemplates.get(
						(clip as { template: { id: string } }).template.id,
						(clip as { template: { version: number } }).template.version,
					)
				: undefined;
		// Composition clips (S08:MGC-007): `props.<path>` from the composition's schema (null = bundle unknown).
		const composition =
			clip.kind === 'composition' ? (compositionOfClip(doc as never, clip as Clip)?.info ?? null) : undefined;
		const spec = resolvePropertySpec(key, template, composition, clip as Clip);
		if (!spec?.appliesTo(clip)) return bad();
		// M2 (wp-m2-text-anim; S11:FIX-004, TXA-007): text properties written by clip.update (style and box fields,
		// text animators) take the clip.update path, so layout re-runs and animator params are validated whole.
		const write = spec.write;
		if (clip.kind === 'text' && write?.via === 'clip.update') {
			return {
				type: 'static',
				rule: ruleFromProperty(spec),
				label: key,
				set: (v) => {
					const patch = ClipPatchSchema.safeParse(write.patch(v, clip as Clip));
					if (!patch.success) h.fail('E_INVALID_PARAM', `Invalid value for ${key}: ${JSON.stringify(v)}`);
					applyClipPatch(doc, seq, clip, patch.data, h);
				},
			};
		}
		// wp-m2-shapes (S11:SHP-003): an explicit write to `shape.fill` / `shape.stroke.*` on a "None" fill/stroke
		// creates it first; any other command on it (stopwatch, keyframe.add without a value) is refused.
		if (spec.group === 'shape' && !ensureShapeStorage(clip, spec, opts.create === true))
			h.fail(
				'E_INVALID_PARAM',
				`${key}: the shape's ${spec.storagePath[1]} is "None"; set a value to create it`,
				{ path: cmd.target },
			);
		if (spec.group === 'props') {
			return {
				type: 'static',
				rule: ruleFromProperty(spec),
				label: key,
				set: (v) => setCompositionProp(doc, clip, spec.storagePath.slice(1), v, h),
			};
		}
		const time = (at: ParamAt | undefined) => h.clipContentTime(seq, clip, at);
		// ---- wp-m2-anime-templates (S11:ATP-006): keyframable params of anime templates
		if (spec.group === 'params' && spec.animatable !== 'no' && template) {
			const anim = templateParamDraftAnim(
				clip,
				spec.storagePath[1]!,
				templateParamsValidator(template, key, h),
			);
			return { type: 'anim', anim, rule: ruleFromProperty(spec), time, label: key };
		}
		// ---- end wp-m2-anime-templates
		if (spec.animatable !== 'no') {
			const anim = getAt(clip, spec.storagePath) as Draft<Animatable<unknown>> | undefined;
			if (!anim) return bad();
			return { type: 'anim', anim, rule: ruleFromProperty(spec), time, label: key };
		}
		if (spec.storagePath[0] === '$synthetic') {
			const syn = doc.synthetics[(clip as { syntheticId: string }).syntheticId];
			if (syn?.kind !== 'color-matte') return bad();
			return {
				type: 'static',
				rule: ruleFromProperty(spec),
				label: key,
				set: (v) => (syn.color = v as never),
			};
		}
		const parentPath = spec.storagePath.slice(0, -1);
		const field = spec.storagePath[spec.storagePath.length - 1]!;
		const parent = getAt(clip, parentPath) as Record<string, unknown> | undefined;
		if (!parent) return bad();
		return {
			type: 'static',
			rule: ruleFromProperty(spec),
			label: key,
			set: (v) => {
				if (key.startsWith('params.') && template) {
					const next = { ...(parent as Record<string, unknown>), [field]: v };
					const parsed = template.paramsSchema.safeParse(next);
					if (!parsed.success) h.fail('E_INVALID_PARAM', `Invalid value for ${key}`);
				}
				parent[field] = v;
			},
		};
	}
	if (head === 'effect' && a && rest.length === 1) {
		const found = locateEffect(doc, a);
		if (!found) return h.fail('E_NOT_FOUND', `Effect instance not found: ${a}`);
		const effSpec = h.registries.effects.get(found.fx.effectId, found.fx.effectVersion);
		if (!effSpec)
			return h.fail('E_UNKNOWN_EFFECT', `Unknown effect ${found.fx.effectId} (bypassed, not editable)`);
		const p = effSpec.params.find((x) => x.name === rest[0]);
		if (!p) return bad();
		if (found.clip) assertUnlocked(findTrackIn(found.seq, found.clip.trackId)!.track, h);
		found.fx.params[p.name] ??= { value: p.default, keyframes: [] } as never;
		const anim = found.fx.params[p.name] as Draft<Animatable<unknown>>;
		const clip = found.clip;
		const time = (at: ParamAt | undefined) =>
			clip ? h.clipContentTime(found.seq, clip, at) : h.sequenceContentTime(found.seq, at);
		return { type: 'anim', anim, rule: ruleFromParam(p), time, label: `${found.fx.effectId}.${p.name}` };
	}
	// wp masks: `["mask", maskId, "path" | "feather" | "opacity" | "expansion"]` (content time of the owning clip).
	if (head === 'mask' && a && rest.length === 1) {
		const prop = rest[0] as MaskProp;
		if (!MASK_PROPS.includes(prop)) return bad();
		const loc = locateMask(doc, a);
		if (!loc) return h.fail('E_NOT_FOUND', `Mask not found: ${a}`);
		assertUnlocked(findTrackIn(loc.seq, loc.clip.trackId)!.track, h);
		const range =
			prop === 'feather'
				? MASK_FEATHER_RANGE
				: prop === 'opacity'
					? MASK_OPACITY_RANGE
					: MASK_EXPANSION_RANGE;
		const rule: ValueRule =
			prop === 'path' ? { kind: 'maskPath', holdOnly: false } : { kind: 'number', range, holdOnly: false };
		return {
			type: 'anim',
			anim: loc.mask[prop] as Draft<Animatable<unknown>>,
			rule,
			time: (at) => h.clipContentTime(loc.seq, loc.clip, at),
			label: `${loc.mask.name}.${MASK_PROP_LABELS[prop]}`,
		};
	}
	// Wave-2 transition framework: `["transition", trnId, param]`; keyframe times are flicks from the span's start.
	if (head === 'transition' && a && rest.length === 1) {
		let seq: DSeq | undefined;
		for (const s of Object.values(doc.sequences)) if (s.transitions[a]) seq = s;
		const t = seq?.transitions[a];
		if (!seq || !t) return h.fail('E_NOT_FOUND', `Transition not found: ${a}`);
		const spec = transitionSpec(t.effectId);
		if (!spec) return h.fail('E_UNKNOWN_EFFECT', `Unknown transition ${t.effectId} (not editable)`);
		const p = spec.params.find((x) => x.name === rest[0]);
		if (!p) return bad();
		assertUnlocked(findTrackIn(seq, t.trackId)!.track, h);
		t.params[p.name] ??= { value: p.default, keyframes: [] } as never;
		const anim = t.params[p.name] as Draft<Animatable<unknown>>;
		const s = seq;
		const time = (at: ParamAt | undefined) => {
			const F = flicksPerFrame(s.settings.frameRate as Rational);
			const start = transitionStartFrame(s as Sequence, t) ?? 0;
			const f = h.sequenceContentTime(s, at) / F;
			return Math.round(Math.min(t.duration - 1, Math.max(0, f - start))) * F;
		};
		return { type: 'anim', anim, rule: ruleFromParam(p), time, label: `${spec.label}.${p.name}` };
	}
	if (head === 'track' && a && rest.length === 1 && (rest[0] === 'volumeDb' || rest[0] === 'pan')) {
		const seq = h.sequence(doc, cmd.sequenceId);
		const track = h.track(seq, a);
		if (track.kind !== 'audio') return bad();
		const key = rest[0];
		track[key] ??= { value: 0, keyframes: [] };
		const spec = resolvePropertySpec(key)!;
		return {
			type: 'anim',
			anim: track[key] as Draft<Animatable<unknown>>,
			rule: ruleFromProperty(spec),
			time: (at) => h.sequenceContentTime(seq, at),
			label: `track.${key}`,
		};
	}
	if (head === 'master') {
		const [seqId, key] = rest.length ? [a, rest[0]] : [cmd.sequenceId, a];
		if (key !== 'volumeDb') return bad();
		const seq = h.sequence(doc, seqId);
		return {
			type: 'anim',
			anim: seq.master.volumeDb as Draft<Animatable<unknown>>,
			rule: ruleFromProperty(resolvePropertySpec('volumeDb')!),
			time: (at) => h.sequenceContentTime(seq, at),
			label: 'master.volumeDb',
		};
	}
	return bad();
}

/** Validates a value against its rule and clamps numbers to the range (S03:PRP-021). */
export function validateValue(
	v: unknown,
	rule: ValueRule,
	h: HandlerContext,
	label: string,
): { value: unknown; clamped: boolean } {
	const fail = (): never => h.fail('E_INVALID_PARAM', `Invalid value for ${label}: ${JSON.stringify(v)}`);
	const clampN = (x: number) =>
		Math.min(
			rule.range?.max ?? Number.POSITIVE_INFINITY,
			Math.max(rule.range?.min ?? Number.NEGATIVE_INFINITY, x),
		);
	const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
	if (rule.check && !rule.check(v)) return fail();
	switch (rule.kind) {
		case 'number': {
			if (!isNum(v)) return fail();
			const c = clampN(v);
			return { value: c, clamped: c !== v };
		}
		case 'vec2': {
			if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum)) return fail();
			// Per-component range (wp-m2-shapes: `shape.size` ≥ 0); specs without min/max are unchanged.
			const c = [clampN(v[0]), clampN(v[1])];
			return { value: c, clamped: c[0] !== v[0] || c[1] !== v[1] };
		}
		case 'vec3': {
			if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) return fail();
			const c = [clampN(v[0]), clampN(v[1]), clampN(v[2])];
			return { value: c, clamped: c.some((x, i) => x !== v[i]) };
		}
		case 'color': {
			if (!Array.isArray(v) || v.length !== 4 || !v.every(isNum)) return fail();
			const c = v.map((x: number) => Math.min(1, Math.max(0, x)));
			return { value: c, clamped: c.some((x, i) => x !== v[i]) };
		}
		case 'boolean':
			if (typeof v !== 'boolean') return fail();
			return { value: v, clamped: false };
		case 'enum':
			if (typeof v !== 'string' || (rule.options && !rule.options.includes(v))) return fail();
			return { value: v, clamped: false };
		case 'string':
			if (typeof v !== 'string') return fail();
			return { value: v, clamped: false };
		case 'media':
			if (!v || typeof v !== 'object' || typeof (v as { mediaId?: unknown }).mediaId !== 'string')
				return fail();
			return { value: v, clamped: false };
		case 'json': {
			// Any JSON value (composition props: arrays, free-form objects); the schema check comes after.
			let copy: unknown;
			try {
				copy = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
			} catch {
				return fail();
			}
			if (copy === undefined) return fail();
			return { value: copy, clamped: false };
		}
		case 'maskPath':
			return { value: validateMaskPath(v, h, label), clamped: false };
		case 'curve': {
			// {curve: [[x, y], …]}: ≥ 2 points in 0..1 (clamped), sorted by x, x strictly increasing.
			const pts = (v as { curve?: unknown } | null)?.curve;
			if (!Array.isArray(pts) || pts.length < 2 || pts.length > 64) return fail();
			if (!pts.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum))) return fail();
			const c = (pts as [number, number][])
				.map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))] as [number, number])
				.sort((a, b) => a[0] - b[0]);
			for (let i = 1; i < c.length; i++) if (!(c[i]![0] > c[i - 1]![0])) return fail();
			const clamped = c.some((p, i) => p[0] !== (pts[i] as number[])[0] || p[1] !== (pts[i] as number[])[1]);
			return { value: { curve: c }, clamped };
		}
	}
}

/** A new key: Linear temporal, and the parameter's default spatial interpolation for points (S03:KF-021). */
export function newKeyframe(
	h: HandlerContext,
	time: number,
	value: unknown,
	hold: boolean,
	spatial?: SpatialInterpolation,
): Keyframe<unknown> {
	const s = hold ? undefined : newKeySpatial(spatial, value);
	return {
		id: h.ids.next('kf'),
		time,
		value,
		interpolation: hold ? 'hold' : 'linear',
		easeIn: { influence: 1 / 3, slope: 1 },
		easeOut: { influence: 1 / 3, slope: 1 },
		...(s ? { spatial: s } : {}),
	};
}

function upsertKeyframe(anim: Draft<Animatable<unknown>>, kf: Keyframe<unknown>): string {
	const existing = anim.keyframes.find((k) => k.time === kf.time);
	let id = kf.id;
	if (existing) {
		existing.value = kf.value as never;
		id = existing.id;
	} else {
		anim.keyframes.push(kf as never);
		anim.keyframes.sort((x, y) => x.time - y.time);
	}
	refreshAutoTangents(anim.keyframes as Keyframe<unknown>[]);
	// keyframes-blend: roving keys sit where the motion passes them.
	retimeRoving(anim.keyframes as Keyframe<unknown>[]);
	return id;
}

export const paramHandlers: HandlerMap = {
	'param.set': (doc, cmd: CommandOf<'param.set'>, h: HandlerContext) => {
		const target = resolveTarget(doc, cmd, h, { create: true });
		const { value, clamped } = validateValue(cmd.value, target.rule, h, target.label);
		if (clamped) h.warn('W_VALUE_CLAMPED', `${target.label} clamped to ${JSON.stringify(value)}`);
		if (target.type === 'static') {
			if (cmd.at !== undefined) h.fail('E_INVALID_PARAM', `${target.label} is not animatable`);
			target.set(value);
			return { applied: value, clamped };
		}
		if (target.anim.keyframes.length > 0) {
			const t = target.time(cmd.at);
			const hold = target.rule.holdOnly || isHoldOnlyValue(value);
			const id = upsertKeyframe(target.anim, newKeyframe(h, t, value, hold, target.rule.spatial));
			return { applied: value, clamped, keyframeId: id, time: t };
		}
		target.anim.value = value as never;
		return { applied: value, clamped };
	},
	'param.setAnimated': (doc, cmd: CommandOf<'param.setAnimated'>, h: HandlerContext) => {
		const target = resolveTarget(doc, cmd, h);
		if (target.type !== 'anim') return h.fail('E_INVALID_PARAM', `${target.label} is not animatable`);
		const t = target.time(cmd.at);
		const anim = target.anim;
		if (cmd.animated) {
			if (anim.keyframes.length > 0) return { keyframeId: null };
			const kf = newKeyframe(
				h,
				t,
				JSON.parse(JSON.stringify(anim.value)),
				target.rule.holdOnly || isHoldOnlyValue(anim.value),
				target.rule.spatial,
			);
			anim.keyframes.push(kf as never);
			return { keyframeId: kf.id, time: t };
		}
		if (anim.keyframes.length === 0) return { value: anim.value };
		const v = evaluate(anim as Animatable<unknown>, t, { holdOnly: target.rule.holdOnly });
		anim.value = JSON.parse(JSON.stringify(v)) as never;
		anim.keyframes = [];
		return { value: v };
	},
};
