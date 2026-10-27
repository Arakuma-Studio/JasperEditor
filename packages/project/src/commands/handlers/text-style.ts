// spec 13 SH-003 / AS-032: `text.setStyle` (deep per-field style patches on many text clips), `effect.setParamMany` /
// `effect.addMany` / `effect.removeMany` (the same edit on many clips' effects, keys timed from each clip's In) and
// the linked project text styles (`textStyle.*`). Each command is one transaction, so one undo step for any number of
// clips; every refusal names the clips it is about.
import type { Draft } from 'immer';
import { defaultTextStyle } from '../../factories.ts';
import { evaluate, isHoldOnlyValue } from '../../keyframes.ts';
import { type EffectSpec, paramSpatialMetric } from '../../registry/effects.ts';
import { kindCapabilities } from '../../registry/kinds.ts';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import type { Animatable, Keyframe, ParamValue } from '../../schema/common.ts';
import { type Clip, type EffectInstance, isKnownClipKind, type TextStyle } from '../../schema/sequence.ts';
import type { ProjectTextStyle } from '../../text-styles/model.ts';
import {
	applyStylePatch,
	diffStyle,
	MAX_TEXT_STROKES,
	MAX_TEXT_STYLES,
	patchedFields,
	type TextStylePatch,
	textStyleProblem,
} from '../../text-styles/patch.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import type { RelativeKey } from '../schemas/text-style.ts';
import { ensureDefaultFont } from './clip-common.ts';
import { applyClipPatch } from './clip-core.ts';
import { buildParams } from './effect.ts';
import { effectOwnerBox, newKeyframe, ruleFromParam, upsertKeyframe, validateValue } from './param.ts';
import { clone, type HandlerMap, idList, peek, peekKeys } from './util.ts';

export const TEXT_STYLE_OWNER = 'text-styles' as const;

type DText = Draft<Extract<Clip, { kind: 'text' }>>;
type Located = { seq: DSeq; clip: DClip };
type LinkFields = { styleId?: string; styleOverrides?: unknown };

const LIST_MAX = 8;
/** "clp_A (video), clp_B (shape) and 3 more" */
function nameClips(list: readonly { id: string; kind?: string }[]): string {
	const shown = list.slice(0, LIST_MAX).map((c) => (c.kind ? `${c.id} (${c.kind})` : c.id));
	return list.length > LIST_MAX ? `${shown.join(', ')} and ${list.length - LIST_MAX} more` : shown.join(', ');
}

/** Text clips whose caption belongs to `groupId` (spec 13 AS-003 `TextClip.caption.groupId`), in every sequence. */
function groupClipIds(doc: DDoc, groupId: string): string[] {
	const out: string[] = [];
	const sequences = peek<Record<string, { clips: Record<string, Clip> }>>(doc, 'sequences')!;
	for (const sid of peekKeys(sequences)) {
		const clips = peek<Record<string, Clip>>(peek<object>(sequences, sid)!, 'clips')!;
		for (const cid of peekKeys(clips)) {
			const c = peek<Clip & { caption?: { groupId?: unknown } }>(clips, cid)!;
			if (c.kind === 'text' && c.caption?.groupId === groupId) out.push(cid);
		}
	}
	return out;
}

/** The ids a `{clipIds | groupId}` command names (exactly one of the two). */
function targetIds(
	doc: DDoc,
	cmd: { clipIds?: readonly string[] | '$selection'; groupId?: string },
	h: HandlerContext,
) {
	if ((cmd.clipIds === undefined) === (cmd.groupId === undefined))
		h.fail('E_INVALID_PARAM', 'Give clipIds or groupId (one of them)');
	if (cmd.groupId !== undefined) {
		const ids = groupClipIds(doc, cmd.groupId);
		if (!ids.length) h.fail('E_NOT_FOUND', `No text clips in subtitle group ${cmd.groupId}`);
		return ids;
	}
	const ids = idList(cmd.clipIds);
	if (!ids.length) h.fail('E_INVALID_PARAM', 'No clips given');
	return ids;
}

/** Every named clip, which must exist, be a text clip (the others are named) and sit on an unlocked track. */
function textClips(
	doc: DDoc,
	ids: readonly string[],
	h: HandlerContext,
	what: string,
): { seq: DSeq; clip: DText }[] {
	const found = ids.map((id) => h.clip(doc, id));
	const notText = found.filter((f) => f.clip.kind !== 'text').map((f) => f.clip);
	if (notText.length)
		h.fail('E_INVALID_PARAM', `${what} applies to text clips only; not text: ${nameClips(notText)}`, {
			blocking: notText.map((c) => c.id),
		});
	for (const f of found) assertUnlocked(findTrackIn(f.seq, f.clip.trackId)!.track, h);
	return found as { seq: DSeq; clip: DText }[];
}

/** The validated style, or a refusal naming the clip / style it was for. */
function checkedStyle(next: TextStyle, doc: DDoc, h: HandlerContext, who: string): TextStyle {
	if (next.strokes.length > MAX_TEXT_STROKES)
		h.fail('E_LIMIT', `${who}: at most ${MAX_TEXT_STROKES} strokes (${next.strokes.length} asked)`);
	const bad = textStyleProblem(next);
	if (bad) h.fail('E_INVALID_PARAM', `${who}: ${bad}`);
	if (!doc.fonts[next.fontId]) h.fail('E_NOT_FOUND', `Font not found: ${next.fontId}`);
	return next;
}

/** Fields removed from styled runs and paragraph settings (`runs: "clear-overridden"`). */
function clearFields<T extends { style: Record<string, unknown> }>(
	list: readonly T[] | undefined,
	fields: string[],
) {
	if (!list) return undefined;
	const out: T[] = [];
	for (const r of list) {
		const style = { ...r.style };
		for (const f of fields) delete style[f];
		if (Object.keys(style).length) out.push({ ...clone(r), style });
	}
	return out;
}

/** Writes a whole effective style to a text clip (layout, font check, linked-style overrides). */
function writeStyle(
	doc: DDoc,
	seq: DSeq,
	clip: DText,
	style: TextStyle,
	h: HandlerContext,
	extra: { runs?: unknown[]; paragraphs?: unknown[] } = {},
) {
	applyClipPatch(
		doc,
		seq,
		clip,
		{
			content: {
				style,
				...(extra.runs ? { runs: extra.runs } : {}),
				...(extra.paragraphs ? { paragraphs: extra.paragraphs } : {}),
			},
		} as never,
		h,
		'whole',
	);
}

// ---- project text styles

function stylesOf(doc: DDoc): Draft<Record<string, ProjectTextStyle>> {
	const d = doc as { textStyles?: Record<string, ProjectTextStyle> };
	d.textStyles ??= {};
	return d.textStyles as Draft<Record<string, ProjectTextStyle>>;
}

function mustStyle(doc: DDoc, id: string, h: HandlerContext): Draft<ProjectTextStyle> {
	const rec = peek<Record<string, ProjectTextStyle>>(doc, 'textStyles');
	if (!rec || typeof rec !== 'object' || !peek(rec, id))
		return h.fail('E_NOT_FOUND', `Text style not found: ${id}`);
	return (doc as { textStyles: Record<string, ProjectTextStyle> }).textStyles[id] as Draft<ProjectTextStyle>;
}

function assertUniqueName(doc: DDoc, name: string, h: HandlerContext, except?: string) {
	const rec = peek<Record<string, ProjectTextStyle>>(doc, 'textStyles');
	if (!rec || typeof rec !== 'object') return;
	const want = name.trim().toLocaleLowerCase();
	for (const id of peekKeys(rec)) {
		if (id === except) continue;
		const s = peek<ProjectTextStyle>(rec, id);
		if (typeof s?.name === 'string' && s.name.trim().toLocaleLowerCase() === want)
			h.fail('E_INVALID_PARAM', `A text style named "${s.name}" already exists (${id})`);
	}
}

/** Every text clip of the document linked to `styleId` (read without drafting, then resolved). */
function linkedClips(doc: DDoc, styleId: string): Located[] {
	const out: Located[] = [];
	const sequences = peek<Record<string, object>>(doc, 'sequences')!;
	for (const sid of peekKeys(sequences)) {
		const clips = peek<Record<string, Clip>>(peek<object>(sequences, sid)!, 'clips')!;
		for (const cid of peekKeys(clips)) {
			const c = peek<Clip & LinkFields>(clips, cid)!;
			if (c.kind === 'text' && c.styleId === styleId) {
				const seq = doc.sequences[sid]!;
				out.push({ seq, clip: seq.clips[cid]! });
			}
		}
	}
	return out;
}

// ---- batch effects

type FxTarget = { seq: DSeq; clip: DClip; fx: Draft<EffectInstance>; index: number; value?: unknown };

type Selector = {
	targets?: { clipId: string; effectInstanceId: string; value?: unknown }[];
	clipIds?: readonly string[] | '$selection';
	effectId?: string;
	occurrence?: number;
};

/** The instances a `{targets} | {clipIds, effectId, occurrence}` command edits (all on unlocked tracks). */
function effectTargets(doc: DDoc, cmd: Selector, h: HandlerContext): FxTarget[] {
	const byTargets = cmd.targets !== undefined;
	if (byTargets === (cmd.clipIds !== undefined))
		h.fail('E_INVALID_PARAM', 'Give targets or clipIds + effectId (one of them)');
	const out: FxTarget[] = [];
	const missing: { id: string }[] = [];
	if (byTargets) {
		if (cmd.effectId !== undefined || cmd.occurrence !== undefined)
			h.fail('E_INVALID_PARAM', 'effectId / occurrence go with clipIds, not with targets');
		const seen = new Set<string>();
		for (const t of cmd.targets!) {
			if (seen.has(t.effectInstanceId))
				h.fail('E_INVALID_PARAM', `Effect ${t.effectInstanceId} is listed twice`);
			seen.add(t.effectInstanceId);
			const { seq, clip } = h.clip(doc, t.clipId);
			const list = ((clip as { effects?: Draft<EffectInstance>[] }).effects ?? []) as Draft<EffectInstance>[];
			const index = list.findIndex((e) => e.id === t.effectInstanceId);
			if (index < 0) missing.push({ id: `${t.effectInstanceId} on ${t.clipId}` });
			else
				out.push({
					seq,
					clip,
					fx: list[index]!,
					index,
					...(t.value !== undefined ? { value: t.value } : {}),
				});
		}
	} else {
		if (!cmd.effectId) h.fail('E_INVALID_PARAM', 'clipIds needs effectId (and optionally occurrence)');
		const n = cmd.occurrence ?? 0;
		for (const id of idList(cmd.clipIds)) {
			const { seq, clip } = h.clip(doc, id);
			const list = ((clip as { effects?: Draft<EffectInstance>[] }).effects ?? []) as Draft<EffectInstance>[];
			let k = -1;
			const index = list.findIndex((e) => e.effectId === cmd.effectId && ++k === n);
			if (index < 0) missing.push({ id });
			else out.push({ seq, clip, fx: list[index]!, index });
		}
		if (!out.length && !missing.length) h.fail('E_INVALID_PARAM', 'No clips given');
	}
	if (missing.length)
		h.fail(
			'E_NOT_FOUND',
			byTargets
				? `Effect instances not found: ${nameClips(missing)}`
				: `${cmd.effectId} #${(cmd.occurrence ?? 0) + 1} is not on: ${nameClips(missing)}`,
			{ blocking: missing.map((m) => m.id) },
		);
	for (const t of out) assertUnlocked(findTrackIn(t.seq, t.clip.trackId)!.track, h);
	return out;
}

/** The sequence frame of a key `frames` after a clip's first frame (`in`) or before its last (`out`). */
function relativeFrame(clip: DClip, frames: number, anchor: 'in' | 'out' | undefined): number {
	return anchor === 'out' ? clip.duration - 1 - frames : frames;
}

/** Relative keys → stored keys in the clip's content time (flicks); keys landing on one time keep the last. */
function keysFor(
	seq: DSeq,
	clip: DClip,
	keys: readonly RelativeKey[],
	anchor: 'in' | 'out' | undefined,
	h: HandlerContext,
) {
	const byTime = new Map<number, Record<string, unknown>>();
	for (const k of keys) {
		const frames = 'frames' in k.offset ? k.offset.frames : h.frame(seq, { seconds: k.offset.seconds });
		const time = h.clipContentTime(seq, clip, { frames: relativeFrame(clip, frames, anchor) });
		if (byTime.has(time))
			h.warn('W_KEYFRAMES_DROPPED', `${clip.id}: two keys land on the same frame; the later one is kept`);
		byTime.set(time, {
			time,
			value: k.value,
			...(k.interpolation ? { interpolation: k.interpolation } : {}),
			...(k.inInterpolation ? { inInterpolation: k.inInterpolation } : {}),
			...(k.easeIn ? { easeIn: k.easeIn } : {}),
			...(k.easeOut ? { easeOut: k.easeOut } : {}),
		});
	}
	return [...byTime.values()].sort((a, b) => (a.time as number) - (b.time as number));
}

function specOf(fx: Draft<EffectInstance>, h: HandlerContext): EffectSpec {
	const spec = h.registries.effects.get(fx.effectId, fx.effectVersion);
	if (!spec) return h.fail('E_UNKNOWN_EFFECT', `Unknown effect ${fx.effectId} (bypassed, not editable)`);
	return spec;
}

function addDelta(base: unknown, delta: number | number[], label: string, h: HandlerContext): unknown {
	if (typeof delta === 'number') {
		if (typeof base !== 'number')
			return h.fail('E_INVALID_PARAM', `${label} is not a number; delta needs one`);
		return base + delta;
	}
	if (!Array.isArray(base) || base.length !== delta.length || !base.every((x) => typeof x === 'number'))
		return h.fail('E_INVALID_PARAM', `${label} does not take a ${delta.length}-component delta`);
	return (base as number[]).map((x, i) => x + delta[i]!);
}

export const textStyleHandlers = {
	'text.setStyle': (doc, cmd: CommandOf<'text.setStyle'>, h: HandlerContext) => {
		const clips = textClips(doc, targetIds(doc, cmd, h), h, 'text.setStyle');
		const patch = cmd.patch as TextStylePatch;
		const fields = cmd.runs === 'clear-overridden' ? patchedFields(patch) : [];
		for (const { seq, clip } of clips) {
			const next = checkedStyle(applyStylePatch(clip.content.style as TextStyle, patch), doc, h, clip.id);
			const content = clip.content as {
				runs?: { style: Record<string, unknown> }[];
				paragraphs?: { style: Record<string, unknown> }[];
			};
			writeStyle(
				doc,
				seq,
				clip,
				next,
				h,
				fields.length
					? {
							runs: clearFields(content.runs, fields) ?? [],
							paragraphs: clearFields(content.paragraphs, fields) ?? [],
						}
					: {},
			);
			if (fields.length && content.runs && !content.runs.length)
				delete (clip.content as { runs?: unknown }).runs;
		}
		return { clipIds: clips.map((c) => c.clip.id), count: clips.length };
	},

	'effect.setParamMany': (doc, cmd: CommandOf<'effect.setParamMany'>, h: HandlerContext) => {
		const modes = [
			cmd.value !== undefined,
			cmd.delta !== undefined,
			cmd.keyframes !== undefined,
			cmd.animated !== undefined,
		];
		const perTarget = cmd.targets?.some((t) => t.value !== undefined) ?? false;
		if (modes.filter(Boolean).length + (perTarget && !modes[0] ? 1 : 0) !== 1)
			h.fail(
				'E_INVALID_PARAM',
				'Give exactly one of value (or per-target values), delta, keyframes, animated',
			);
		const targets = effectTargets(doc, cmd, h);
		const keyed: string[] = [];
		const skipped: string[] = [];
		for (const t of targets) {
			const spec = specOf(t.fx, h);
			const p = spec.params.find((x) => x.name === cmd.param);
			if (!p) h.fail('E_INVALID_PARAM', `${spec.id} has no parameter "${cmd.param}"`);
			const label = `${spec.id}.${p.name}`;
			const rule = ruleFromParam(p);
			t.fx.params[p.name] ??= { value: clone(p.default), keyframes: [] } as never;
			const anim = t.fx.params[p.name] as Draft<Animatable<unknown>>;
			const metric = p.spatialMetric ? paramSpatialMetric(p, effectOwnerBox(doc, t.seq, t.clip)) : undefined;
			const at = cmd.at ? relativeFrame(t.clip, cmd.at.frames, cmd.anchor) : 0;
			const time = h.clipContentTime(t.seq, t.clip, { frames: at });
			if (cmd.keyframes) {
				if (!p.animatable) h.fail('E_INVALID_PARAM', `${label} is not animatable`);
				const box = intrinsicBoxOf({ doc: doc as never, seq: t.seq as never, clip: t.clip as never });
				const built = buildParams(
					spec,
					{
						[p.name]: {
							value: clone(anim.value),
							keyframes: keysFor(t.seq, t.clip, cmd.keyframes, cmd.anchor, h),
							...(anim.expression ? { expression: clone(anim.expression) } : {}),
						},
					},
					h,
					box,
				);
				t.fx.params[p.name] = built[p.name] as never;
				continue;
			}
			if (cmd.animated !== undefined) {
				if (!p.animatable) h.fail('E_INVALID_PARAM', `${label} is not animatable`);
				if (cmd.animated && anim.keyframes.length === 0) {
					const v = clone(anim.value);
					anim.keyframes.push(
						newKeyframe(h, time, v, rule.holdOnly || isHoldOnlyValue(v), rule.spatial) as never,
					);
				} else if (!cmd.animated && anim.keyframes.length > 0) {
					const v = evaluate(anim as Animatable<unknown>, time, {
						holdOnly: rule.holdOnly,
						...(metric ? { metric } : {}),
					});
					anim.value = clone(v) as never;
					anim.keyframes = [];
				}
				continue;
			}
			const animated = anim.keyframes.length > 0;
			if (animated && !cmd.at) {
				keyed.push(t.clip.id);
				continue;
			}
			const current = animated
				? evaluate(anim as Animatable<unknown>, time, {
						holdOnly: rule.holdOnly,
						...(metric ? { metric } : {}),
					})
				: anim.value;
			const raw =
				t.value !== undefined
					? t.value
					: cmd.value !== undefined
						? cmd.value
						: addDelta(current, cmd.delta!, label, h);
			const { value, clamped } = validateValue(raw, rule, h, label);
			if (clamped) h.warn('W_VALUE_CLAMPED', `${label} on ${t.clip.id} clamped to ${JSON.stringify(value)}`);
			if (animated) {
				if (at < 0 || at >= t.clip.duration) {
					skipped.push(t.clip.id);
					continue;
				}
				const hold = rule.holdOnly || isHoldOnlyValue(value);
				upsertKeyframe(anim, newKeyframe(h, time, value, hold, rule.spatial) as Keyframe<unknown>, metric);
			} else anim.value = value as never;
		}
		if (keyed.length)
			h.fail(
				'E_INVALID_PARAM',
				`${cmd.param} is keyframed on ${nameClips(keyed.map((id) => ({ id })))}; give at (frames from each clip's In) to set a key there, or keyframes`,
				{ blocking: keyed },
			);
		if (skipped.length)
			h.warn(
				'W_CLIP_SKIPPED',
				`${skipped.length} clip(s) are shorter than the key time; no key added: ${nameClips(skipped.map((id) => ({ id })))}`,
			);
		return { effectInstanceIds: targets.map((t) => t.fx.id), count: targets.length, skipped };
	},

	'effect.addMany': (doc, cmd: CommandOf<'effect.addMany'>, h: HandlerContext) => {
		const spec = h.registries.effects.get(cmd.effectId);
		if (!spec || spec.internal) return h.fail('E_UNKNOWN_EFFECT', `Unknown effect: ${cmd.effectId}`);
		for (const name of [...Object.keys(cmd.params ?? {}), ...Object.keys(cmd.keyframes ?? {})])
			if (!spec.params.some((p) => p.name === name))
				h.fail('E_INVALID_PARAM', `${spec.id} has no parameter "${name}"`);
		for (const name of Object.keys(cmd.keyframes ?? {}))
			if (!spec.params.find((p) => p.name === name)!.animatable)
				h.fail('E_INVALID_PARAM', `${spec.id}.${name} is not animatable`);
		const ids = idList(cmd.clipIds);
		if (!ids.length) h.fail('E_INVALID_PARAM', 'No clips given');
		const found = ids.map((id) => h.clip(doc, id));
		const refused = found
			.map((f) => f.clip)
			.filter((c) => {
				const caps = isKnownClipKind(c.kind) ? kindCapabilities(c.kind) : undefined;
				return !caps?.supportsEffects || (spec.appliesTo === 'video' ? !caps.visual : !caps.audio);
			});
		if (refused.length)
			h.fail(
				'E_INVALID_PARAM',
				`${spec.label} (a ${spec.appliesTo} effect) cannot go on: ${nameClips(refused)}`,
				{
					blocking: refused.map((c) => c.id),
				},
			);
		for (const f of found) assertUnlocked(findTrackIn(f.seq, f.clip.trackId)!.track, h);
		const effectInstanceIds: string[] = [];
		for (const { seq, clip } of found) {
			const box = intrinsicBoxOf({ doc: doc as never, seq: seq as never, clip: clip as never });
			const overrides: Record<string, unknown> = {
				...(spec.instanceDefaults ? spec.instanceDefaults({ box }) : {}),
				...clone(cmd.params ?? {}),
			};
			for (const [name, keys] of Object.entries(cmd.keyframes ?? {})) {
				const p = spec.params.find((x) => x.name === name)!;
				overrides[name] = {
					value: overrides[name] ?? clone(p.default),
					keyframes: keysFor(seq, clip, keys, cmd.anchor, h),
				};
			}
			const c = clip as { effects?: Draft<EffectInstance>[] };
			c.effects ??= [];
			const fx: EffectInstance = {
				id: h.ids.next('fx'),
				effectId: spec.id,
				effectVersion: spec.version,
				enabled: true,
				params: buildParams(spec, overrides, h, box) as Record<string, Animatable<ParamValue>>,
			};
			c.effects.splice(Math.min(cmd.index ?? c.effects.length, c.effects.length), 0, fx as never);
			effectInstanceIds.push(fx.id);
		}
		return { effectInstanceIds, clipIds: found.map((f) => f.clip.id) };
	},

	'effect.removeMany': (doc, cmd: CommandOf<'effect.removeMany'>, h: HandlerContext) => {
		const targets = effectTargets(doc, cmd, h);
		// Highest index first, so earlier indices of the same stack stay valid.
		for (const t of [...targets].sort((a, b) => b.index - a.index)) {
			const list = (t.clip as { effects: Draft<EffectInstance>[] }).effects;
			const i = list.findIndex((e) => e.id === t.fx.id);
			if (i >= 0) list.splice(i, 1);
		}
		return { effectInstanceIds: targets.map((t) => t.fx.id), count: targets.length };
	},

	'textStyle.create': (doc, cmd: CommandOf<'textStyle.create'>, h: HandlerContext) => {
		const rec = peek<Record<string, unknown>>(doc, 'textStyles');
		if (rec && typeof rec === 'object' && peekKeys(rec).length >= MAX_TEXT_STYLES)
			h.fail('E_LIMIT', `A project holds at most ${MAX_TEXT_STYLES} text styles`);
		assertUniqueName(doc, cmd.name, h);
		let base: TextStyle;
		if (cmd.fromClipId !== undefined) {
			const { clip } = h.clip(doc, cmd.fromClipId);
			if (clip.kind !== 'text')
				h.fail('E_INVALID_PARAM', `fromClipId must be a text clip; ${clip.id} is a ${clip.kind} clip`);
			base = clone((clip as DText).content.style as TextStyle);
		} else base = defaultTextStyle(ensureDefaultFont(doc, h));
		const style = checkedStyle(cmd.style ? applyStylePatch(base, cmd.style) : base, doc, h, cmd.name);
		const id = h.newId(doc, 'tsy', cmd.id);
		stylesOf(doc)[id] = { id, name: cmd.name, style } as never;
		h.defineRef(cmd.ref, id);
		return { styleId: id };
	},

	'textStyle.update': (doc, cmd: CommandOf<'textStyle.update'>, h: HandlerContext) => {
		const def = mustStyle(doc, cmd.styleId, h);
		if (cmd.patch === undefined && cmd.fromClipId === undefined)
			h.fail('E_INVALID_PARAM', 'Give patch or fromClipId');
		let base = clone(def.style as TextStyle);
		if (cmd.fromClipId !== undefined) {
			const { clip } = h.clip(doc, cmd.fromClipId);
			if (clip.kind !== 'text')
				h.fail('E_INVALID_PARAM', `fromClipId must be a text clip; ${clip.id} is a ${clip.kind} clip`);
			base = clone((clip as DText).content.style as TextStyle);
		}
		const old = clone(def.style as TextStyle);
		const next = checkedStyle(cmd.patch ? applyStylePatch(base, cmd.patch) : base, doc, h, def.name);
		const linked = linkedClips(doc, cmd.styleId);
		// Each linked clip keeps where it deviates from the style as it was (taken from the clip itself).
		const plans = linked.map((l) => ({ ...l, deviations: diffDeviations(old, l.clip as DText) }));
		def.style = next as never;
		const locked: string[] = [];
		let updated = 0;
		for (const { seq, clip, deviations } of plans) {
			if (findTrackIn(seq, clip.trackId)!.track.locked) {
				locked.push(clip.id);
				continue;
			}
			const effective = checkedStyle(applyStylePatch(next, deviations), doc, h, clip.id);
			writeStyle(doc, seq, clip as DText, effective, h);
			updated++;
		}
		if (locked.length)
			h.warn(
				'W_CLIP_SKIPPED',
				`${locked.length} linked clip(s) on locked tracks keep their look: ${nameClips(locked.map((id) => ({ id })))}`,
			);
		return { styleId: cmd.styleId, updated, skipped: locked };
	},

	'textStyle.rename': (doc, cmd: CommandOf<'textStyle.rename'>, h: HandlerContext) => {
		const def = mustStyle(doc, cmd.styleId, h);
		assertUniqueName(doc, cmd.name, h, cmd.styleId);
		def.name = cmd.name;
		return { styleId: cmd.styleId, name: cmd.name };
	},

	'textStyle.delete': (doc, cmd: CommandOf<'textStyle.delete'>, h: HandlerContext) => {
		mustStyle(doc, cmd.styleId, h);
		// The clips keep their look; only the link goes.
		const linked = linkedClips(doc, cmd.styleId);
		for (const { clip } of linked) {
			delete (clip as LinkFields).styleId;
			delete (clip as LinkFields).styleOverrides;
		}
		const d = doc as { textStyles?: Record<string, unknown> };
		delete d.textStyles![cmd.styleId];
		if (Object.keys(d.textStyles!).length === 0) delete d.textStyles;
		return { styleId: cmd.styleId, unlinked: linked.length };
	},

	'textStyle.apply': (doc, cmd: CommandOf<'textStyle.apply'>, h: HandlerContext) => {
		const def = mustStyle(doc, cmd.styleId, h);
		const style = clone(def.style as TextStyle);
		const clips = textClips(doc, targetIds(doc, cmd, h), h, 'textStyle.apply');
		for (const { seq, clip } of clips) {
			(clip as LinkFields).styleId = cmd.styleId;
			writeStyle(doc, seq, clip, clone(style), h);
		}
		return { styleId: cmd.styleId, clipIds: clips.map((c) => c.clip.id) };
	},

	'textStyle.detach': (doc, cmd: CommandOf<'textStyle.detach'>, h: HandlerContext) => {
		const clips = textClips(doc, targetIds(doc, cmd, h), h, 'textStyle.detach');
		const linked = clips.filter((c) => (c.clip as LinkFields).styleId !== undefined);
		if (!linked.length) h.fail('E_INVALID_PARAM', 'None of the clips is linked to a text style');
		for (const { clip } of linked) {
			delete (clip as LinkFields).styleId;
			delete (clip as LinkFields).styleOverrides;
		}
		return { clipIds: linked.map((c) => c.clip.id) };
	},

	'textStyle.reset': (doc, cmd: CommandOf<'textStyle.reset'>, h: HandlerContext) => {
		const clips = textClips(doc, targetIds(doc, cmd, h), h, 'textStyle.reset');
		const rec = peek<Record<string, ProjectTextStyle>>(doc, 'textStyles');
		const unlinked = clips
			.filter((c) => {
				const id = (c.clip as LinkFields).styleId;
				return !(typeof id === 'string' && rec && typeof rec === 'object' && peek(rec, id));
			})
			.map((c) => c.clip);
		if (unlinked.length)
			h.fail('E_INVALID_PARAM', `Not linked to a text style: ${nameClips(unlinked)}`, {
				blocking: unlinked.map((c) => c.id),
			});
		for (const { seq, clip } of clips) {
			const def = peek<ProjectTextStyle>(rec!, (clip as LinkFields).styleId!)!;
			const style = clone(def.style as TextStyle);
			let next: TextStyle = style;
			if (cmd.fields) {
				const cur = clone(clip.content.style as TextStyle) as unknown as Record<string, unknown>;
				for (const f of cmd.fields) {
					const v = (style as unknown as Record<string, unknown>)[f];
					if (v === undefined) delete cur[f];
					else cur[f] = clone(v);
				}
				next = checkedStyle(cur as unknown as TextStyle, doc, h, clip.id);
			}
			writeStyle(doc, seq, clip, next, h);
		}
		return { clipIds: clips.map((c) => c.clip.id) };
	},
} satisfies HandlerMap;

/** A linked clip's deviations from the style as it was before an edit. */
function diffDeviations(old: TextStyle, clip: DText) {
	return diffStyle(old, clip.content.style as TextStyle);
}
