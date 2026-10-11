// Values and keyframes use the dynamic property registry. Source Text exposes an Animatable view
// through sourceTextDraftAnim so it follows the same parameter commands.
import type { Draft } from 'immer';
import { contentTimeAt } from '../../derive/index.ts';
import { createFontRef } from '../../factories.ts';
import type { Animatable, Keyframe } from '../../schema/common.ts';
import { type Clip, type TextContent, TextContentSchema } from '../../schema/sequence.ts';
import type { TextAnimatorGroup, TextPathOptions, TextSelector } from '../../schema/text-animators.ts';
import { resolveTextAnimationWindows } from '../../text-animations.ts';
import {
	ANIMATOR_MENU_IDS,
	AXIS_TAG,
	addAnimatorProperties,
	newTextAnimator,
	newTextSelector,
	nextSelectorName,
} from '../../text-animators/catalog.ts';
import {
	buildPresetAnimators,
	getTextAnimatorPreset,
	legacyBasedOn,
	presetForLegacy,
	type TextAnimatorPreset,
} from '../../text-animators/presets.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../../time.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { CommandError } from '../types.ts';
import { PRUNE_EMPTY_KEYFRAMES } from './mg-template.ts';
import { type HandlerMap, idList } from './util.ts';

export const TEXT_ANIMATOR_OWNER = 'text-animators';

type DText = Draft<Extract<Clip, { kind: 'text' }>>;

/** A text clip by id, unlocked. */
function textClip(doc: DDoc, clipId: string, h: HandlerContext): { seq: DSeq; clip: DText } {
	const { seq, clip } = h.clip(doc, clipId);
	if (clip.kind !== 'text') h.fail('E_INVALID_PARAM', `${clipId} is not a text clip`, { path: ['clipId'] });
	assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
	return { seq, clip: clip as DText };
}

function textClips(doc: DDoc, ids: readonly string[], h: HandlerContext): { seq: DSeq; clips: DText[] } {
	const { seq, clips } = h.clipsOf(doc, ids);
	for (const c of clips) {
		if (c.kind !== 'text') h.fail('E_INVALID_PARAM', `${c.id} is not a text clip`, { path: ['clipIds'] });
		assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
	}
	return { seq, clips: clips as DText[] };
}

/** In/Out text animations on a clip that also has animators are drawn in their animator form (TypesetText). */
function warnLegacy(clip: DText, h: HandlerContext): void {
	const ta = clip.textAnimation;
	if (ta && (ta.in || ta.out))
		h.warn(
			'W_TEXT_ANIMATION_AS_ANIMATORS',
			`${clip.id} also has In/Out text animations: with animators they are drawn in their animator form (textAnimator.convertLegacy makes them editable animators)`,
			['textAnimation'],
		);
}

function animatorOf(
	clip: DText,
	id: string,
	h: HandlerContext,
): { a: Draft<TextAnimatorGroup>; index: number } {
	const list = clip.animators ?? [];
	const index = list.findIndex((a) => a.id === id);
	if (index < 0)
		h.fail('E_NOT_FOUND', `Text animator not found on ${clip.id}: ${id}`, { path: ['animatorId'] });
	return { a: list[index]!, index };
}

function checkEntries(entries: readonly string[] | undefined, h: HandlerContext): void {
	for (const e of entries ?? [])
		if (!ANIMATOR_MENU_IDS.includes(e))
			h.fail(
				'E_INVALID_PARAM',
				`Unknown animator property "${e}"; expected one of ${ANIMATOR_MENU_IDS.join(', ')}`,
				{
					path: ['properties'],
				},
			);
}

function addAxes(a: Draft<TextAnimatorGroup>, tags: readonly string[] | undefined): void {
	for (const tag of tags ?? []) {
		a.properties.axes ??= {};
		a.properties.axes[tag] ??= { value: 0, keyframes: [] };
	}
}

function moveTo<T>(list: T[], from: number, to: number): void {
	const [x] = list.splice(from, 1);
	list.splice(Math.min(to, list.length), 0, x!);
}

/** Fresh ids for a copied animator (selectors and every keyframe). */
function reId(a: TextAnimatorGroup, h: HandlerContext): TextAnimatorGroup {
	const copy = JSON.parse(JSON.stringify(a)) as TextAnimatorGroup;
	copy.id = h.ids.next('tan');
	for (const s of copy.selectors) s.id = h.ids.next('tsl');
	const walk = (v: unknown) => {
		if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === 'object') {
			const o = v as Record<string, unknown>;
			if (Array.isArray(o.keyframes) && 'value' in o)
				for (const k of o.keyframes as { id: string }[]) k.id = h.ids.next('kf');
			for (const x of Object.values(o)) walk(x);
		}
	};
	walk(copy.properties);
	walk(copy.selectors);
	return copy;
}

/** Places a preset on a clip: start content time, flicks per preset second, snapping, loop end. */
function presetContext(
	seq: DSeq,
	clip: DText,
	preset: TextAnimatorPreset,
	o: { at?: CommandOf<'textAnimator.applyPreset'>['at']; durationFrames?: number },
	h: HandlerContext,
) {
	const rate = seq.settings.frameRate as Rational;
	const fps = rate.num / rate.den;
	const frames = o.durationFrames ?? Math.max(1, Math.round(preset.duration * fps));
	const lengthSec = frames / fps;
	// Sequence frame of the preset's start: `at`, else the clip's first frame (Out: so it ends on the last frame).
	let startFrame: number;
	if (o.at !== undefined) {
		const t = h.clipContentTime(seq, clip, o.at);
		startFrame = Math.round(clip.start + (t - clip.sourceIn) / (flicksPerFrame(rate) * clip.speed.rate));
		if (clip.speed.reverse) startFrame = clip.start + clip.duration - 1 - (startFrame - clip.start);
	} else if (preset.phase === 'out') startFrame = clip.start + clip.duration - 1 - frames;
	else startFrame = clip.start;
	const F = flicksPerFrame(rate);
	// Key times are content times of (fractional) sequence frames, snapped to the clip's frame grid (S01:KF-005).
	const timeOfFrame = (f: number) => contentTimeAt(clip, f, rate);
	const start = timeOfFrame(startFrame);
	const step = F * clip.speed.rate;
	// Keys may precede the clip's first frame (a preset longer than the clip): content times may be negative.
	const snap = (t: number) => Math.round(clip.sourceIn + Math.round((t - clip.sourceIn) / step) * step);
	const scale = lengthSec / preset.duration;
	return {
		start,
		// Content flicks per preset second (negative for reversed clips: keys are sorted afterwards).
		flicksPerSecond: (clip.speed.reverse ? -1 : 1) * FLICKS_PER_SECOND * scale * clip.speed.rate,
		snap,
		loopUntil:
			preset.phase === 'loop'
				? timeOfFrame(clip.speed.reverse ? clip.start : clip.start + clip.duration - 1)
				: undefined,
		frames,
	};
}

function applyPresetTo(
	seq: DSeq,
	clip: DText,
	preset: TextAnimatorPreset,
	o: { at?: CommandOf<'textAnimator.applyPreset'>['at']; durationFrames?: number; replace?: boolean },
	h: HandlerContext,
): TextAnimatorGroup[] {
	const ctx = presetContext(seq, clip, preset, o, h);
	if (preset.perCharacter3d) clip.perCharacter3d = true;
	const groups = buildPresetAnimators(preset, {
		newId: (p) => h.ids.next(p === 'tan' ? 'tan' : p === 'sel' ? 'tsl' : 'kf'),
		start: ctx.start,
		flicksPerSecond: ctx.flicksPerSecond,
		snap: ctx.snap,
		...(ctx.loopUntil !== undefined ? { loopUntil: ctx.loopUntil } : {}),
		threeD: !!clip.perCharacter3d,
	});
	if (o.replace) clip.animators = [];
	clip.animators ??= [];
	clip.animators.push(...(groups as Draft<TextAnimatorGroup>[]));
	return groups;
}

/** Parses a Source Text value (text content); throws with the first issue. */
export function parseSourceText(v: unknown): TextContent {
	const p = TextContentSchema.safeParse(v);
	if (!p.success) throw new Error(p.error.issues[0]?.message ?? 'not text content');
	return p.data as TextContent;
}

/**
 * Source Text as an Animatable view for param / keyframe commands: `value` is the clip's `content` (writes
 * validate it), `keyframes` its `sourceTextKeyframes` (attached on first push, removed when emptied).
 */
export function sourceTextDraftAnim(clip: DClip, h: HandlerContext | null): Draft<Animatable<unknown>> {
	const t = clip as DText;
	const valid = (v: unknown): TextContent => {
		const p = TextContentSchema.safeParse(v);
		if (!p.success) {
			const message = `Invalid Source Text: ${p.error.issues[0]?.message ?? 'not text content'}`;
			if (h) return h.fail('E_INVALID_PARAM', message);
			throw new CommandError('E_INVALID_PARAM', message);
		}
		return p.data as TextContent;
	};
	const attach = () => {
		t.sourceTextKeyframes ??= [];
		return t.sourceTextKeyframes as Draft<Keyframe<unknown>>[];
	};
	const empty = new Proxy([] as Draft<Keyframe<unknown>>[], {
		get(target, prop, receiver) {
			if (prop === 'push')
				return (...items: Draft<Keyframe<unknown>>[]) => {
					for (const k of items) {
						k.value = valid(k.value) as never;
						k.interpolation = 'hold';
					}
					return attach().push(...items);
				};
			return Reflect.get(target, prop, receiver);
		},
	});
	return {
		get value() {
			return t.content;
		},
		set value(v: unknown) {
			t.content = valid(v) as never;
		},
		get keyframes(): Draft<Keyframe<unknown>>[] {
			const list = t.sourceTextKeyframes as Draft<Keyframe<unknown>>[] | undefined;
			if (!list) return empty;
			for (const k of list) k.interpolation = 'hold';
			return list;
		},
		set keyframes(list: Draft<Keyframe<unknown>>[]) {
			if (list.length === 0) delete t.sourceTextKeyframes;
			else {
				for (const k of list) {
					k.value = valid(k.value) as never;
					k.interpolation = 'hold';
				}
				t.sourceTextKeyframes = list as never;
			}
		},
		[PRUNE_EMPTY_KEYFRAMES]: () => {
			if (t.sourceTextKeyframes && t.sourceTextKeyframes.length === 0) delete t.sourceTextKeyframes;
		},
	} as unknown as Draft<Animatable<unknown>>;
}

/** Creates More Options with AE's defaults before its first write (`textMore.*` keys). */
export function ensureMoreOptions(clip: DClip): void {
	const t = clip as DText;
	t.moreOptions ??= {
		anchorPointGrouping: 'character',
		groupingAlignment: { value: [0, 0], keyframes: [] },
		fillAndStroke: 'perCharacter',
		interCharacterBlending: 'normal',
	} as Draft<NonNullable<DText['moreOptions']>>;
}

export const textAnimatorHandlers = {
	'font.add': (doc, cmd: CommandOf<'font.add'>, h) => {
		const family = cmd.family.trim();
		const existing = Object.values(doc.fonts).find((f) => f.family.toLowerCase() === family.toLowerCase());
		const id = existing?.id ?? h.ids.next('fnt');
		if (!existing) doc.fonts[id] = createFontRef({ next: () => id }, family) as never;
		h.defineRef(cmd.ref, id);
		return { fontId: id, added: !existing };
	},
	'textAnimator.add': (doc, cmd: CommandOf<'textAnimator.add'>, h) => {
		const { clip } = textClip(doc, cmd.clipId, h);
		checkEntries(cmd.properties, h);
		const list = (clip.animators ??= []);
		const id = h.ids.next('tan');
		const a = newTextAnimator(
			id,
			cmd.name ?? `Animator ${list.length + 1}`,
			cmd.selector === false ? null : h.ids.next('tsl'),
		);
		for (const e of cmd.properties ?? []) addAnimatorProperties(a, e, !!clip.perCharacter3d);
		addAxes(a as Draft<TextAnimatorGroup>, cmd.axes);
		list.splice(Math.min(cmd.index ?? list.length, list.length), 0, a as Draft<TextAnimatorGroup>);
		h.defineRef(cmd.ref, id);
		warnLegacy(clip, h);
		return { animatorId: id, selectorIds: a.selectors.map((s) => s.id) };
	},
	'textAnimator.remove': (doc, cmd: CommandOf<'textAnimator.remove'>, h) => {
		const { clip } = textClip(doc, cmd.clipId, h);
		for (const id of cmd.animatorIds) animatorOf(clip, id, h);
		clip.animators = clip.animators!.filter((a) => !cmd.animatorIds.includes(a.id));
		if (clip.animators.length === 0) delete clip.animators;
		return { removed: cmd.animatorIds };
	},
	'textAnimator.update': (doc, cmd: CommandOf<'textAnimator.update'>, h) => {
		const { clip } = textClip(doc, cmd.clipId, h);
		const { a, index } = animatorOf(clip, cmd.animatorId, h);
		if (cmd.name !== undefined) a.name = cmd.name;
		if (cmd.enabled !== undefined) a.enabled = cmd.enabled;
		if (cmd.index !== undefined) moveTo(clip.animators!, index, cmd.index);
		return { animatorId: a.id };
	},
	'textAnimator.duplicate': (doc, cmd: CommandOf<'textAnimator.duplicate'>, h) => {
		const { clip } = textClip(doc, cmd.clipId, h);
		const { a, index } = animatorOf(clip, cmd.animatorId, h);
		const copy = reId(a as TextAnimatorGroup, h);
		copy.name = `${a.name} copy`;
		clip.animators!.splice(index + 1, 0, copy as Draft<TextAnimatorGroup>);
		h.defineRef(cmd.ref, copy.id);
		return { animatorId: copy.id };
	},
	'textAnimator.addProperty': (doc, cmd: CommandOf<'textAnimator.addProperty'>, h) => {
		const { clip } = textClip(doc, cmd.clipId, h);
		checkEntries(cmd.properties, h);
		if (!cmd.properties?.length && !cmd.axes?.length)
			h.fail('E_INVALID_PARAM', 'Give properties and/or axes to add', { path: ['properties'] });
		const { a } = animatorOf(clip, cmd.animatorId, h);
		const added: string[] = [];
		for (const e of cmd.properties ?? [])
			added.push(...addAnimatorProperties(a as TextAnimatorGroup, e, !!clip.perCharacter3d));
		for (const tag of cmd.axes ?? []) if (!a.properties.axes?.[tag]) added.push(`axes.${tag}`);
		addAxes(a, cmd.axes);
		return { added };
	},
	'textAnimator.removeProperty': (doc, cmd: CommandOf<'textAnimator.removeProperty'>, h) => {
		const { clip } = textClip(doc, cmd.clipId, h);
		const { a } = animatorOf(clip, cmd.animatorId, h);
		const props = a.properties as Record<string, unknown>;
		for (const key of cmd.properties) {
			if (key.startsWith('axes.')) {
				const tag = key.slice(5);
				const axes = a.properties.axes;
				if (!axes?.[tag])
					return h.fail('E_NOT_FOUND', `${a.name} has no font axis ${tag}`, { path: ['properties'] });
				delete axes[tag];
				if (Object.keys(axes).length === 0) delete a.properties.axes;
				continue;
			}
			if (key === 'axes' || props[key] === undefined)
				h.fail('E_NOT_FOUND', `${a.name} has no property ${key}`, { path: ['properties'] });
			delete props[key];
		}
		return { removed: cmd.properties };
	},
	'textSelector.add': (doc, cmd: CommandOf<'textSelector.add'>, h) => {
		const { clip } = textClip(doc, cmd.clipId, h);
		const { a } = animatorOf(clip, cmd.animatorId, h);
		const id = h.ids.next('tsl');
		const s = newTextSelector(
			cmd.kind,
			id,
			cmd.name ?? nextSelectorName(cmd.kind, a.selectors as TextSelector[]),
		);
		a.selectors.push(s as Draft<TextSelector>);
		h.defineRef(cmd.ref, id);
		return { selectorId: id };
	},
	'textSelector.remove': (doc, cmd: CommandOf<'textSelector.remove'>, h) => {
		const { clip } = textClip(doc, cmd.clipId, h);
		const { a } = animatorOf(clip, cmd.animatorId, h);
		for (const id of cmd.selectorIds)
			if (!a.selectors.some((s) => s.id === id))
				h.fail('E_NOT_FOUND', `Selector not found on ${a.name}: ${id}`, { path: ['selectorIds'] });
		a.selectors = a.selectors.filter((s) => !cmd.selectorIds.includes(s.id));
		return { removed: cmd.selectorIds };
	},
	'textSelector.update': (doc, cmd: CommandOf<'textSelector.update'>, h) => {
		const { clip } = textClip(doc, cmd.clipId, h);
		const { a } = animatorOf(clip, cmd.animatorId, h);
		const index = a.selectors.findIndex((s) => s.id === cmd.selectorId);
		if (index < 0)
			h.fail('E_NOT_FOUND', `Selector not found on ${a.name}: ${cmd.selectorId}`, { path: ['selectorId'] });
		const s = a.selectors[index]!;
		if (cmd.name !== undefined) s.name = cmd.name;
		if (cmd.enabled !== undefined) s.enabled = cmd.enabled;
		if (cmd.index !== undefined) moveTo(a.selectors, index, cmd.index);
		return { selectorId: s.id };
	},
	'textAnimator.applyPreset': (doc, cmd: CommandOf<'textAnimator.applyPreset'>, h) => {
		const preset = getTextAnimatorPreset(cmd.preset);
		if (!preset)
			return h.fail(
				'E_UNKNOWN_EFFECT',
				`Unknown text animator preset ${cmd.preset} (list_text_animator_presets)`,
				{
					path: ['preset'],
				},
			);
		const { seq, clips } = textClips(doc, idList(cmd.clipIds), h);
		const out: Record<string, string[]> = {};
		for (const clip of clips) {
			const groups = applyPresetTo(seq, clip, preset, cmd, h);
			out[clip.id] = groups.map((g) => g.id);
			warnLegacy(clip, h);
		}
		return { preset: preset.id, animatorIds: out };
	},
	'textAnimator.convertLegacy': (doc, cmd: CommandOf<'textAnimator.convertLegacy'>, h) => {
		const { seq, clips } = textClips(doc, idList(cmd.clipIds), h);
		const out: Record<string, string[]> = {};
		for (const clip of clips) {
			const w = resolveTextAnimationWindows(clip as unknown as Clip & { duration: number });
			const ids: string[] = [];
			for (const side of ['in', 'out'] as const) {
				const r = w[side];
				if (!r || r.frames < 1) continue;
				const preset = presetForLegacy(r.preset, side);
				if (!preset) {
					h.warn(
						'W_TEXT_ANIMATION_NOT_CONVERTED',
						`${clip.id}: ${side} preset ${r.preset}@${r.version} has no animator equivalent and was kept`,
					);
					continue;
				}
				const groups = applyPresetTo(seq, clip, preset, { durationFrames: r.frames }, h);
				const based = legacyBasedOn(r.params);
				// The legacy unit applies to every cascade (Typewriter keeps its own character / word unit).
				if (based) for (const g of groups) for (const s of g.selectors) s.basedOn = based;
				ids.push(...groups.map((g) => g.id));
				const ta = clip.textAnimation;
				if (ta) delete ta[side];
			}
			if (clip.textAnimation && !clip.textAnimation.in && !clip.textAnimation.out) delete clip.textAnimation;
			out[clip.id] = ids;
		}
		return { animatorIds: out };
	},
	'text.setPathOptions': (doc, cmd: CommandOf<'text.setPathOptions'>, h) => {
		const { clips } = textClips(doc, idList(cmd.clipIds), h);
		for (const clip of clips) {
			if (cmd.maskId === null) {
				delete clip.pathOptions;
				continue;
			}
			const prev = clip.pathOptions;
			const maskId = cmd.maskId ?? prev?.maskId;
			if (!maskId)
				return h.fail(
					'E_INVALID_PARAM',
					`${clip.id} has no text path yet: give maskId (a mask of the clip)`,
					{
						path: ['maskId'],
					},
				);
			const masks = (clip as { masks?: { id: string }[] }).masks ?? [];
			if (!masks.some((m) => m.id === maskId))
				h.fail('E_NOT_FOUND', `Mask ${maskId} is not a mask of ${clip.id}`, { path: ['maskId'] });
			const margin = (v: number | undefined, a: Draft<Animatable<number>> | undefined) => {
				if (v === undefined) return a ?? { value: 0, keyframes: [] };
				if (a?.keyframes.length) {
					h.fail('E_INVALID_PARAM', 'The margin is keyframed: set it with param.set at a time', {
						path: ['firstMargin'],
					});
				}
				return { ...(a ?? {}), value: v, keyframes: [] };
			};
			const next: TextPathOptions = {
				maskId,
				reversePath: cmd.reversePath ?? prev?.reversePath ?? false,
				perpendicularToPath: cmd.perpendicularToPath ?? prev?.perpendicularToPath ?? true,
				forceAlignment: cmd.forceAlignment ?? prev?.forceAlignment ?? false,
				firstMargin: margin(cmd.firstMargin, prev?.firstMargin) as Animatable<number>,
				lastMargin: margin(cmd.lastMargin, prev?.lastMargin) as Animatable<number>,
			};
			clip.pathOptions = next as Draft<TextPathOptions>;
			warnLegacy(clip, h);
		}
		return {};
	},
	'text.setPerCharacter3d': (doc, cmd: CommandOf<'text.setPerCharacter3d'>, h) => {
		const { clips } = textClips(doc, idList(cmd.clipIds), h);
		for (const clip of clips) {
			if (!cmd.enabled) {
				delete clip.perCharacter3d;
				continue;
			}
			clip.perCharacter3d = true;
			// AE adds the 3D companions of the transform properties an animator has.
			for (const a of clip.animators ?? []) {
				const p = a.properties as Record<string, unknown>;
				for (const e of ['anchor', 'position', 'scale', 'rotation'] as const)
					if (p[e] !== undefined) addAnimatorProperties(a as TextAnimatorGroup, e, true);
			}
		}
		return {};
	},
} satisfies HandlerMap;

/** Valid axis tags (also used by the MCP tool). */
export const isAxisTag = (t: string) => AXIS_TAG.test(t);
