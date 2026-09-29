// param.set / param.setAnimated with Effect Controls stopwatch semantics (S01:KF-005, CMD-010, CMD-013).
import type { Draft } from 'immer';
import { evaluate, isHoldOnlyValue } from '../../keyframes.ts';
import type { ParamSpec } from '../../registry/effects.ts';
import { type PropertySpec, resolvePropertySpec } from '../../registry/properties.ts';
import type { Animatable, Keyframe } from '../../schema/common.ts';
import type { EffectInstance } from '../../schema/sequence.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf, ParamAt } from '../schemas/index.ts';
import type { HandlerMap } from './util.ts';

type ValueRule = {
	kind: 'number' | 'vec2' | 'color' | 'enum' | 'boolean' | 'string' | 'media';
	range?: { min?: number; max?: number };
	options?: readonly string[];
	holdOnly: boolean;
};

/** A resolved parameter target: either an Animatable (keyframable) or a static setter. */
type Target =
	| { type: 'anim'; anim: Draft<Animatable<unknown>>; rule: ValueRule; time(at: ParamAt | undefined): number; label: string }
	| { type: 'static'; set(v: unknown): void; rule: ValueRule; label: string };

function ruleFromProperty(s: PropertySpec): ValueRule {
	return { kind: s.kind, range: s.range, options: s.options, holdOnly: s.animatable === 'hold-only' };
}
function ruleFromParam(p: ParamSpec): ValueRule {
	return { kind: p.type, range: p.range, options: p.options, holdOnly: !p.animatable };
}

function getAt(obj: unknown, path: readonly string[]): unknown {
	let cur = obj as Record<string, unknown> | undefined;
	for (const k of path) {
		if (!cur || typeof cur !== 'object') return undefined;
		cur = cur[k] as Record<string, unknown> | undefined;
	}
	return cur;
}

function findEffect(doc: DDoc, fxId: string): { seq: DSeq; fx: Draft<EffectInstance>; clip: DClip | null } | null {
	for (const seq of Object.values(doc.sequences)) {
		for (const clip of Object.values(seq.clips)) {
			const fx = (clip as { effects?: Draft<EffectInstance>[] }).effects?.find((e) => e.id === fxId);
			if (fx) return { seq, fx, clip };
		}
		for (const t of [...seq.videoTracks, ...seq.audioTracks]) {
			const fx = t.effects?.find((e) => e.id === fxId);
			if (fx) return { seq, fx, clip: null };
		}
		const fx = seq.master.effects.find((e) => e.id === fxId);
		if (fx) return { seq, fx, clip: null };
	}
	return null;
}

function resolveTarget(doc: DDoc, cmd: { target: string[]; sequenceId?: string }, h: HandlerContext): Target {
	const [head, a, ...rest] = cmd.target;
	const bad = (): never => h.fail('E_INVALID_PARAM', `Unsupported parameter path: ${JSON.stringify(cmd.target)}`);
	if (head === 'clip' && a) {
		const { seq, clip } = h.clip(doc, a);
		assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
		const key = rest.join('.');
		const template =
			clip.kind === 'motion-graphic'
				? h.registries.mgTemplates.get((clip as { template: { id: string } }).template.id, (clip as { template: { version: number } }).template.version)
				: undefined;
		const spec = resolvePropertySpec(key, template);
		if (!spec || !spec.appliesTo(clip)) return bad();
		const time = (at: ParamAt | undefined) => h.clipContentTime(seq, clip, at);
		if (spec.animatable !== 'no') {
			const anim = getAt(clip, spec.storagePath) as Draft<Animatable<unknown>> | undefined;
			if (!anim) return bad();
			return { type: 'anim', anim, rule: ruleFromProperty(spec), time, label: key };
		}
		if (spec.storagePath[0] === '$synthetic') {
			const syn = doc.synthetics[(clip as { syntheticId: string }).syntheticId];
			if (!syn || syn.kind !== 'color-matte') return bad();
			return { type: 'static', rule: ruleFromProperty(spec), label: key, set: (v) => (syn.color = v as never) };
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
		const found = findEffect(doc, a);
		if (!found) return h.fail('E_NOT_FOUND', `Effect instance not found: ${a}`);
		const effSpec = h.registries.effects.get(found.fx.effectId, found.fx.effectVersion);
		if (!effSpec) return h.fail('E_UNKNOWN_EFFECT', `Unknown effect ${found.fx.effectId} (bypassed, not editable)`);
		const p = effSpec.params.find((x) => x.name === rest[0]);
		if (!p) return bad();
		if (found.clip) assertUnlocked(findTrackIn(found.seq, found.clip.trackId)!.track, h);
		found.fx.params[p.name] ??= { value: p.default, keyframes: [] } as never;
		const anim = found.fx.params[p.name] as Draft<Animatable<unknown>>;
		const clip = found.clip;
		const time = (at: ParamAt | undefined) => (clip ? h.clipContentTime(found.seq, clip, at) : h.sequenceContentTime(found.seq, at));
		return { type: 'anim', anim, rule: ruleFromParam(p), time, label: `${found.fx.effectId}.${p.name}` };
	}
	if (head === 'track' && a && rest.length === 1 && (rest[0] === 'volumeDb' || rest[0] === 'pan')) {
		const seq = h.sequence(doc, cmd.sequenceId);
		const track = h.track(seq, a);
		if (track.kind !== 'audio') return bad();
		const key = rest[0];
		track[key] ??= { value: 0, keyframes: [] };
		const spec = resolvePropertySpec(key)!;
		return { type: 'anim', anim: track[key] as Draft<Animatable<unknown>>, rule: ruleFromProperty(spec), time: (at) => h.sequenceContentTime(seq, at), label: `track.${key}` };
	}
	if (head === 'master') {
		const [seqId, key] = rest.length ? [a, rest[0]] : [cmd.sequenceId, a];
		if (key !== 'volumeDb') return bad();
		const seq = h.sequence(doc, seqId);
		return { type: 'anim', anim: seq.master.volumeDb as Draft<Animatable<unknown>>, rule: ruleFromProperty(resolvePropertySpec('volumeDb')!), time: (at) => h.sequenceContentTime(seq, at), label: 'master.volumeDb' };
	}
	return bad();
}

/** Validates a value against its rule and clamps numbers to the range (S03:PRP-021). */
function validateValue(v: unknown, rule: ValueRule, h: HandlerContext, label: string): { value: unknown; clamped: boolean } {
	const fail = (): never => h.fail('E_INVALID_PARAM', `Invalid value for ${label}: ${JSON.stringify(v)}`);
	const clampN = (x: number) => Math.min(rule.range?.max ?? Number.POSITIVE_INFINITY, Math.max(rule.range?.min ?? Number.NEGATIVE_INFINITY, x));
	const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
	switch (rule.kind) {
		case 'number': {
			if (!isNum(v)) return fail();
			const c = clampN(v);
			return { value: c, clamped: c !== v };
		}
		case 'vec2':
			if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum)) return fail();
			return { value: [v[0], v[1]], clamped: false };
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
			if (!v || typeof v !== 'object' || typeof (v as { mediaId?: unknown }).mediaId !== 'string') return fail();
			return { value: v, clamped: false };
	}
}

function newKeyframe(h: HandlerContext, time: number, value: unknown, hold: boolean): Keyframe<unknown> {
	return {
		id: h.ids.next('kf'),
		time,
		value,
		interpolation: hold ? 'hold' : 'linear',
		easeIn: { influence: 1 / 3, slope: 1 },
		easeOut: { influence: 1 / 3, slope: 1 },
	};
}

function upsertKeyframe(anim: Draft<Animatable<unknown>>, kf: Keyframe<unknown>): string {
	const existing = anim.keyframes.find((k) => k.time === kf.time);
	if (existing) {
		existing.value = kf.value as never;
		return existing.id;
	}
	anim.keyframes.push(kf as never);
	anim.keyframes.sort((x, y) => x.time - y.time);
	return kf.id;
}

export const paramHandlers: HandlerMap = {
	'param.set': (doc, cmd: CommandOf<'param.set'>, h: HandlerContext) => {
		const target = resolveTarget(doc, cmd, h);
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
			const id = upsertKeyframe(target.anim, newKeyframe(h, t, value, hold));
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
			const kf = newKeyframe(h, t, JSON.parse(JSON.stringify(anim.value)), target.rule.holdOnly || isHoldOnlyValue(anim.value));
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
