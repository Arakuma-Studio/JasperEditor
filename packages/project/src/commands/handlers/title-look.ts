// Spec 19 TL-015…TL-019: applying and editing looks. Every command is one undo step whatever the number of clips, and
// refuses with `E_*` codes: `E_LIMIT` over TL-013's limits, `E_TRACK_LOCKED` on locked tracks (except `look.update`,
// which skips them with `W_CLIP_SKIPPED`), `E_NOT_FOUND`, `E_INVALID_PARAM`.
import type { Draft } from 'immer';
import { contentTimeAt } from '../../derive/index.ts';
import { createFontRef, defaultTransform } from '../../factories.ts';
import { isPaintParam } from '../../registry/fx/title-look/contract.ts';
import { paramSpec, titleLayerType } from '../../registry/fx/title-look/registry.ts';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import type { Clip, EffectInstance } from '../../schema/sequence.ts';
import type { Rational } from '../../time.ts';
import { factoryColorway, factoryLook } from '../../title-looks/factory/index.ts';
import { chooseLookFont } from '../../title-looks/font.ts';
import {
	type Appearance,
	type AppearanceLayer,
	appearanceBytes,
	type Colorway,
	ColorwaySchema,
	clipLook,
	emptyAppearance,
	type GlobalLight,
	GradientSchema,
	MAX_APPEARANCE_BYTES,
	MAX_APPEARANCE_LAYERS,
	MAX_TITLE_LOOK_NAME,
	MAX_TITLE_LOOKS,
	type Paint,
	type Role,
	seedFromId,
	staticAnim,
	TITLE_LOOK_CLIP_KINDS,
	TITLE_LOOK_EFFECT_ID,
	TITLE_LOOK_INTENSITY,
	type TitleLook,
} from '../../title-looks/model.ts';
import {
	adoptLayerIds,
	appearanceOfLook,
	applyColorway,
	countKeyframes,
	lookBodyOf,
	paintRoles,
	paintWithoutRoles,
	rebaseAppearance,
} from '../../title-looks/overrides.ts';
import {
	appearanceFromRecipe,
	LookRecipeSchema,
	layerFromRecipe,
	MAX_RECIPE_BYTES,
} from '../../title-looks/recipe.ts';
import { resolveAppearance } from '../../title-looks/resolve.ts';
import {
	appearanceProblem,
	paintLimitProblem,
	paintProblem,
	titleLookOf,
} from '../../title-looks/validate.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, cleanupSequence, findTrackIn, trackSlotOf } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { commonFields, frameBox, newGeneratorClip, visualFields } from './clip-common.ts';
import { applyClipPatch } from './clip-core.ts';
import { buildParams } from './effect.ts';
import { locateEffect } from './param.ts';
import { clone, type HandlerMap, idList, peek, peekKeys } from './util.ts';

export const TITLE_LOOK_OWNER = 'title-looks' as const;

type DFx = Draft<EffectInstance>;
type LookLocation = { seq: DSeq; clip: DClip; fx: DFx };

const effectsOf = (clip: DClip) => (clip as unknown as { effects?: DFx[] }).effects;

function looksOf(doc: DDoc): Draft<Record<string, TitleLook>> {
	const d = doc as { titleLooks?: Record<string, TitleLook> };
	d.titleLooks ??= {};
	return d.titleLooks as Draft<Record<string, TitleLook>>;
}

/** A clip that may take a look (TL-010), on an unlocked track. */
function lookClip(doc: DDoc, id: string, h: HandlerContext): { seq: DSeq; clip: DClip } {
	const { seq, clip } = h.clip(doc, id);
	if (!(TITLE_LOOK_CLIP_KINDS as readonly string[]).includes(clip.kind))
		h.fail('E_INVALID_PARAM', `${clip.kind} clips take no look; ${clip.id} is a ${clip.kind} clip`, {
			path: [clip.id],
		});
	assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
	return { seq, clip };
}

/** The look instance `id`, on an unlocked track. */
function lookInstance(doc: DDoc, id: string, h: HandlerContext): LookLocation {
	const loc = locateEffect(doc, id);
	if (!loc) return h.fail('E_NOT_FOUND', `Effect instance not found: ${id}`);
	if (loc.fx.effectId !== TITLE_LOOK_EFFECT_ID || !loc.clip || !loc.fx.appearance)
		h.fail('E_INVALID_PARAM', `${id} is not a look on a clip`);
	assertUnlocked(findTrackIn(loc.seq, loc.clip!.trackId)!.track, h);
	return { seq: loc.seq, clip: loc.clip!, fx: loc.fx };
}

/** The clip's look, or a refusal. */
function linkedInstance(doc: DDoc, id: string, h: HandlerContext): LookLocation {
	const { seq, clip } = lookClip(doc, id, h);
	const fx = clipLook(effectsOf(clip));
	if (!fx?.appearance) return h.fail('E_INVALID_PARAM', `Clip ${clip.id} has no look`, { path: [clip.id] });
	return { seq, clip, fx };
}

function layerAt(a: Draft<Appearance>, id: string, h: HandlerContext): number {
	const i = a.layers.findIndex((l) => l.id === id);
	if (i < 0) h.fail('E_NOT_FOUND', `Layer not found: ${id}`);
	return i;
}

/** TL-013 on what a command is about to store. */
function assertAppearance(a: unknown, who: string, h: HandlerContext): void {
	const n = (a as Appearance).layers.length;
	if (n > MAX_APPEARANCE_LAYERS)
		h.fail('E_LIMIT', `${who}: a look holds at most ${MAX_APPEARANCE_LAYERS} layers (${n} asked)`);
	if (appearanceBytes(a) > MAX_APPEARANCE_BYTES)
		h.fail('E_LIMIT', `${who}: a look holds at most ${MAX_APPEARANCE_BYTES} bytes`);
	const bad = appearanceProblem(a);
	if (bad) h.fail(/stops/.test(bad) ? 'E_LIMIT' : 'E_INVALID_PARAM', `${who}: ${bad}`);
}

function appearanceOfRecipe(raw: unknown, h: HandlerContext, who: string): Appearance {
	if (appearanceBytes(raw) > MAX_RECIPE_BYTES) h.fail('E_LIMIT', `${who}: the recipe is too large`);
	const r = LookRecipeSchema.safeParse(raw);
	if (!r.success) {
		const i = r.error.issues[0]!;
		return h.fail('E_INVALID_PARAM', `${who}: ${i.path.join('.')}: ${i.message}`);
	}
	if (r.data.layers.length > MAX_APPEARANCE_LAYERS)
		h.fail(
			'E_LIMIT',
			`${who}: a look holds at most ${MAX_APPEARANCE_LAYERS} layers (${r.data.layers.length} asked)`,
		);
	let a: Appearance;
	try {
		a = appearanceFromRecipe(r.data, () => h.ids.next('apl'));
	} catch (e) {
		return h.fail('E_INVALID_PARAM', `${who}: ${(e as Error).message}`);
	}
	assertAppearance(a, who, h);
	return a;
}

function colorwaysOf(raw: readonly unknown[] | undefined, h: HandlerContext, who: string): Colorway[] {
	return (raw ?? []).map((c) => {
		const r = ColorwaySchema.safeParse(c);
		if (!r.success) return h.fail('E_INVALID_PARAM', `${who}: unreadable colourway`);
		return r.data as Colorway;
	});
}

function assertRoom(doc: DDoc, h: HandlerContext): void {
	const rec = peek<Record<string, unknown>>(doc, 'titleLooks');
	if (rec && peekKeys(rec).length >= MAX_TITLE_LOOKS)
		h.fail('E_LIMIT', `A project holds at most ${MAX_TITLE_LOOKS} looks`);
}

function assertUniqueName(doc: DDoc, name: string, h: HandlerContext, except?: string): void {
	for (const l of Object.values((doc as { titleLooks?: Record<string, TitleLook> }).titleLooks ?? {}))
		if (l.id !== except && l.name.toLowerCase() === name.toLowerCase())
			h.fail('E_INVALID_PARAM', `A look named "${name}" already exists`);
}

/** The project copy of a library or given look, made on first use (TL-015). */
function lookForApply(doc: DDoc, cmd: CommandOf<'look.apply'>, h: HandlerContext): Draft<TitleLook> {
	if (cmd.lookId && cmd.look) h.fail('E_INVALID_PARAM', 'Give lookId or look, not both');
	const rec = (doc as { titleLooks?: Record<string, TitleLook> }).titleLooks;
	if (cmd.lookId && rec && Object.hasOwn(rec, cmd.lookId)) {
		if (!titleLookOf(doc as never, cmd.lookId)) h.fail('E_INVALID_PARAM', `Look ${cmd.lookId} is unreadable`);
		return looksOf(doc)[cmd.lookId]!;
	}
	const source = cmd.lookId ? factoryLook(cmd.lookId) : undefined;
	if (cmd.lookId && !source) h.fail('E_NOT_FOUND', `Look not found: ${cmd.lookId}`);
	const given = cmd.look;
	if (!source && !given) h.fail('E_INVALID_PARAM', 'look.apply needs lookId or look');
	const sourceId = source?.libraryId ?? given?.sourceId;
	if (sourceId !== undefined) {
		const twin = (Object.values(rec ?? {}) as TitleLook[]).find((l) => l.sourceId === sourceId);
		if (twin) return looksOf(doc)[twin.id]!;
	}
	assertRoom(doc, h);
	const name = (source?.name ?? given!.name).slice(0, MAX_TITLE_LOOK_NAME);
	const who = `Look "${name}"`;
	const appearance = appearanceOfRecipe(source ? source.recipe : given!.recipe, h, who);
	const colorways = source?.colorways ?? colorwaysOf(given?.colorways, h, who);
	const tags = source?.tags ?? given?.tags;
	const category = source?.category ?? given?.category;
	const quickControls = source?.quickControls ?? given?.quickControls;
	const id = h.ids.next('tlk');
	looksOf(doc)[id] = {
		id,
		name,
		...(tags?.length ? { tags: [...tags] } : {}),
		...(category ? { category } : {}),
		...(sourceId !== undefined ? { sourceId } : {}),
		...(colorways.length ? { colorways: clone(colorways) } : {}),
		...(quickControls?.length ? { quickControls: clone(quickControls) } : {}),
		appearance,
	} as never;
	return looksOf(doc)[id]!;
}

/** A colourway by id: the linked look's own, then the library's. */
function colorwayOf(look: TitleLook | null, id: string, h: HandlerContext): Colorway {
	const c = look?.colorways?.find((x) => x.id === id) ?? factoryColorway(id);
	if (!c) return h.fail('E_NOT_FOUND', `Colourway not found: ${id}`);
	return c;
}

/**
 * `font` of a look on a text clip: applied once (TL-011), chosen by `chooseLookFont` (TL-053). A family the project lacks
 * gets a font reference. The look's weight and tracking come with it: a display face has few weights.
 */
function applyLookFont(
	doc: DDoc,
	seq: DSeq,
	clip: DClip,
	a: Appearance,
	h: HandlerContext,
	available?: readonly string[],
): void {
	if (clip.kind !== 'text' || !a.font) return;
	const content = (clip as unknown as { content: { text: string; style: object } }).content;
	const { family, ...face } = chooseLookFont(a.font, content.text, available);
	let fontId = Object.values(doc.fonts).find((f) => f.family === family)?.id;
	if (!fontId) {
		const font = createFontRef(h.ids, family);
		doc.fonts[font.id] = font as never;
		fontId = font.id;
	}
	const style = { ...clone(content.style), ...face, fontId };
	applyClipPatch(doc, seq, clip, { content: { style } } as never, h, 'whole');
}

/** Adds or replaces a clip's look instance. Returns the instance and the keys the replaced params had. */
function writeLook(clip: DClip, next: Appearance, h: HandlerContext): { fx: DFx; dropped: number } {
	const c = clip as unknown as { effects?: DFx[] };
	c.effects ??= [];
	const old = clipLook(c.effects);
	if (old) {
		const dropped = old.appearance ? countKeyframes(old.appearance as Appearance) : 0;
		old.appearance = next as never;
		return { fx: old, dropped };
	}
	const fx = {
		id: h.ids.next('fx'),
		effectId: TITLE_LOOK_EFFECT_ID,
		effectVersion: 1,
		enabled: true,
		params: {},
		appearance: next,
	};
	// First in the stack: the user's effects keep applying to the title as a whole (TL-019).
	c.effects.unshift(fx as never);
	return { fx: c.effects[0]!, dropped: 0 };
}

function clipFirstTime(seq: DSeq, clip: DClip): number {
	return contentTimeAt(clip, clip.start, seq.settings.frameRate as Rational);
}

const paintParamOf = (layer: AppearanceLayer, name: string | undefined, h: HandlerContext) => {
	const def = titleLayerType(layer.type);
	if (!def) return h.fail('E_UNKNOWN_EFFECT', `Unknown layer type ${layer.type}`);
	const spec = paramSpec(def, name ?? 'paint');
	if (!spec || !isPaintParam(spec))
		return h.fail('E_INVALID_PARAM', `${layer.type} has no paint "${name ?? 'paint'}"`);
	return spec;
};

function setPaint(layer: Draft<AppearanceLayer>, name: string, paint: Paint): void {
	const a = layer.params[name];
	if (a) {
		a.value = paint as never;
		a.keyframes = [];
	} else layer.params[name] = staticAnim(paint) as never;
}

function limitOr(paint: unknown, h: HandlerContext, who: string): Paint {
	const bad = paintProblem(paint);
	if (bad) h.fail(paintLimitProblem(paint as Paint) ? 'E_LIMIT' : 'E_INVALID_PARAM', `${who}: ${bad}`);
	return clone(paint) as Paint;
}

export const titleLookHandlers = {
	'look.apply': (doc, cmd: CommandOf<'look.apply'>, h: HandlerContext) => {
		const ids = idList(cmd.clipIds);
		if (ids.length === 0) h.fail('E_INVALID_PARAM', 'look.apply needs at least one clip');
		// Refuse before anything is copied in.
		const targets = ids.map((id) => lookClip(doc, id, h));
		const look = lookForApply(doc, cmd, h);
		const lookPlain = clone(look) as unknown as TitleLook;
		const colorway = cmd.colorwayId ? colorwayOf(lookPlain, cmd.colorwayId, h) : null;
		let droppedKeyframes = 0;
		const effectInstanceIds: string[] = [];
		for (const { seq, clip } of targets) {
			const prev = clipLook(effectsOf(clip));
			const seed =
				cmd.seed ?? (prev?.appearance as Appearance | undefined)?.seed ?? seedFromId(h.ids.next('apl'));
			const next = appearanceOfLook(lookPlain, seed);
			if (colorway) applyColorway(next, colorway);
			assertAppearance(next, lookPlain.name, h);
			const { fx, dropped } = writeLook(clip, next, h);
			droppedKeyframes += dropped;
			effectInstanceIds.push(fx.id);
			applyLookFont(doc, seq, clip, lookPlain.appearance, h, cmd.availableFonts);
		}
		return { lookId: look.id, clipIds: ids, effectInstanceIds, droppedKeyframes };
	},

	'look.remove': (doc, cmd: CommandOf<'look.remove'>, h: HandlerContext) => {
		const out: string[] = [];
		for (const id of idList(cmd.clipIds)) {
			const { clip, fx } = linkedInstance(doc, id, h);
			const list = effectsOf(clip)!;
			list.splice(list.indexOf(fx), 1);
			out.push(clip.id);
		}
		return { clipIds: out };
	},

	'look.detach': (doc, cmd: CommandOf<'look.detach'>, h: HandlerContext) => {
		const out: string[] = [];
		for (const id of idList(cmd.clipIds)) {
			const { fx } = linkedInstance(doc, id, h);
			const a = fx.appearance as Draft<Appearance>;
			if (a.lookId === undefined) continue;
			delete a.lookId;
			delete a.lookOverrides;
			out.push(id);
		}
		if (out.length === 0) h.fail('E_INVALID_PARAM', 'None of the clips is linked to a look');
		return { clipIds: out };
	},

	'look.reset': (doc, cmd: CommandOf<'look.reset'>, h: HandlerContext) => {
		const out: string[] = [];
		let droppedKeyframes = 0;
		for (const id of idList(cmd.clipIds)) {
			const { fx } = linkedInstance(doc, id, h);
			const a = fx.appearance as Draft<Appearance>;
			const look = a.lookId ? titleLookOf(doc as never, a.lookId) : null;
			if (!look) h.fail('E_INVALID_PARAM', `Clip ${id} is not linked to a look`);
			const fresh = appearanceOfLook(look!, a.seed);
			if (a.colorwayId !== undefined) fresh.colorwayId = a.colorwayId;
			if (cmd.layerIds) {
				for (const lid of cmd.layerIds) {
					const i = layerAt(a, lid, h);
					const base = fresh.layers.find((l) => l.id === lid);
					if (!base) h.fail('E_INVALID_PARAM', `Layer ${lid} is not part of the look`);
					droppedKeyframes += Object.values((a.layers[i] as AppearanceLayer).params).reduce(
						(n, p) => n + p.keyframes.length,
						0,
					);
					a.layers[i] = base as never;
				}
			} else {
				droppedKeyframes += countKeyframes(a as Appearance);
				droppedKeyframes += fx.params[TITLE_LOOK_INTENSITY]?.keyframes.length ?? 0;
				delete fx.params[TITLE_LOOK_INTENSITY];
				fx.appearance = fresh as never;
			}
			out.push(id);
		}
		return { clipIds: out, droppedKeyframes };
	},

	'look.setColorway': (doc, cmd: CommandOf<'look.setColorway'>, h: HandlerContext) => {
		if (!cmd.palette && !cmd.colorwayId)
			h.fail('E_INVALID_PARAM', 'look.setColorway needs colorwayId or palette');
		const out: string[] = [];
		const keptAnimated: Record<string, Role[]> = {};
		for (const id of idList(cmd.clipIds)) {
			const { fx } = linkedInstance(doc, id, h);
			const a = fx.appearance as Draft<Appearance>;
			const look = a.lookId ? titleLookOf(doc as never, a.lookId) : null;
			const way = cmd.palette
				? { palette: cmd.palette as Colorway['palette'], ...(cmd.colorwayId ? { id: cmd.colorwayId } : {}) }
				: colorwayOf(look, cmd.colorwayId!, h);
			const { keptAnimated: kept } = applyColorway(a as Appearance, way);
			if (kept.length) keptAnimated[id] = kept;
			out.push(id);
		}
		return { clipIds: out, keptAnimated };
	},

	'look.create': (doc, cmd: CommandOf<'look.create'>, h: HandlerContext) => {
		assertRoom(doc, h);
		assertUniqueName(doc, cmd.name, h);
		if ((cmd.fromClipId === undefined) === (cmd.recipe === undefined))
			h.fail('E_INVALID_PARAM', 'look.create needs fromClipId or recipe');
		let appearance: Appearance;
		if (cmd.fromClipId !== undefined) {
			const { seq, clip } = h.clip(doc, cmd.fromClipId);
			const fx = clipLook(effectsOf(clip));
			if (!fx?.appearance) return h.fail('E_INVALID_PARAM', `Clip ${clip.id} has no look`);
			appearance = lookBodyOf(clone(fx.appearance) as Appearance, clipFirstTime(seq, clip));
		} else appearance = appearanceOfRecipe(cmd.recipe, h, cmd.name);
		const id = h.newId(doc, 'tlk', cmd.id);
		looksOf(doc)[id] = {
			id,
			name: cmd.name,
			...(cmd.tags?.length ? { tags: [...cmd.tags] } : {}),
			...(cmd.category ? { category: cmd.category } : {}),
			appearance,
		} as never;
		if (cmd.link) {
			if (cmd.fromClipId === undefined) h.fail('E_INVALID_PARAM', 'link needs fromClipId');
			const { fx } = linkedInstance(doc, cmd.fromClipId!, h);
			(fx.appearance as Draft<Appearance>).lookId = id;
		}
		h.defineRef(cmd.ref, id);
		return { lookId: id };
	},

	'look.update': (doc, cmd: CommandOf<'look.update'>, h: HandlerContext) => {
		const old = titleLookOf(doc as never, cmd.lookId);
		if (!old) return h.fail('E_NOT_FOUND', `Look not found: ${cmd.lookId}`);
		if ((cmd.fromClipId === undefined) === (cmd.recipe === undefined))
			h.fail('E_INVALID_PARAM', 'look.update needs fromClipId or recipe');
		let body: Appearance;
		if (cmd.fromClipId !== undefined) {
			const { seq, clip } = h.clip(doc, cmd.fromClipId);
			const fx = clipLook(effectsOf(clip));
			if (!fx?.appearance) return h.fail('E_INVALID_PARAM', `Clip ${clip.id} has no look`);
			body = lookBodyOf(clone(fx.appearance) as Appearance, clipFirstTime(seq, clip));
		} else body = appearanceOfRecipe(cmd.recipe, h, old.name);
		const prior = clone(old.appearance);
		adoptLayerIds(prior, body);
		(looksOf(doc)[cmd.lookId] as Draft<TitleLook>).appearance = body as never;
		const skipped: string[] = [];
		let updated = 0;
		for (const seq of Object.values(doc.sequences))
			for (const cid of peekKeys(seq.clips)) {
				const raw = peek<Clip>(seq.clips, cid)!;
				const fxRaw = clipLook((raw as { effects?: EffectInstance[] }).effects);
				if ((fxRaw?.appearance as Appearance | undefined)?.lookId !== cmd.lookId) continue;
				const clip = seq.clips[cid]!;
				if (findTrackIn(seq, clip.trackId)!.track.locked) {
					skipped.push(cid);
					continue;
				}
				const fx = clipLook(effectsOf(clip))!;
				const next = rebaseAppearance(prior, body, clone(fx.appearance) as Appearance);
				assertAppearance(next, clip.id, h);
				fx.appearance = next as never;
				updated++;
			}
		if (skipped.length)
			h.warn(
				'W_CLIP_SKIPPED',
				`${skipped.length} linked clip(s) on locked tracks keep their look: ${skipped.join(', ')}`,
			);
		return { lookId: cmd.lookId, updated, skipped };
	},

	'look.rename': (doc, cmd: CommandOf<'look.rename'>, h: HandlerContext) => {
		if (!titleLookOf(doc as never, cmd.lookId)) h.fail('E_NOT_FOUND', `Look not found: ${cmd.lookId}`);
		assertUniqueName(doc, cmd.name, h, cmd.lookId);
		looksOf(doc)[cmd.lookId]!.name = cmd.name;
		return { lookId: cmd.lookId, name: cmd.name };
	},

	'look.delete': (doc, cmd: CommandOf<'look.delete'>, h: HandlerContext) => {
		const rec = (doc as { titleLooks?: Record<string, TitleLook> }).titleLooks;
		if (!rec || !Object.hasOwn(rec, cmd.lookId)) h.fail('E_NOT_FOUND', `Look not found: ${cmd.lookId}`);
		// TL-015: the clips keep their effective values, only the link goes.
		let unlinked = 0;
		for (const seq of Object.values(doc.sequences))
			for (const cid of peekKeys(seq.clips)) {
				const raw = peek<Clip>(seq.clips, cid)!;
				const fxRaw = clipLook((raw as { effects?: EffectInstance[] }).effects);
				if ((fxRaw?.appearance as Appearance | undefined)?.lookId !== cmd.lookId) continue;
				const a = clipLook(effectsOf(seq.clips[cid]!))!.appearance as Draft<Appearance>;
				delete a.lookId;
				delete a.lookOverrides;
				unlinked++;
			}
		delete rec![cmd.lookId];
		if (Object.keys(rec!).length === 0) delete (doc as { titleLooks?: unknown }).titleLooks;
		return { lookId: cmd.lookId, unlinked };
	},

	'appearance.addLayer': (doc, cmd: CommandOf<'appearance.addLayer'>, h: HandlerContext) => {
		const { fx } = lookInstance(doc, cmd.effectInstanceId, h);
		const a = fx.appearance as Draft<Appearance>;
		if (a.layers.length >= MAX_APPEARANCE_LAYERS)
			h.fail('E_LIMIT', `A look holds at most ${MAX_APPEARANCE_LAYERS} layers`);
		let layer: AppearanceLayer;
		try {
			layer = layerFromRecipe(
				{
					type: cmd.layerType,
					...(cmd.name ? { name: cmd.name } : {}),
					...(cmd.params ? { params: cmd.params } : {}),
				},
				h.ids.next('apl'),
			);
		} catch (e) {
			return h.fail(
				titleLayerType(cmd.layerType) ? 'E_INVALID_PARAM' : 'E_UNKNOWN_EFFECT',
				(e as Error).message,
			);
		}
		const index = Math.min(cmd.index ?? a.layers.length, a.layers.length);
		a.layers.splice(index, 0, layer as never);
		assertAppearance(a, 'appearance.addLayer', h);
		h.defineRef(cmd.ref, layer.id);
		return { layerId: layer.id, index };
	},

	'appearance.removeLayer': (doc, cmd: CommandOf<'appearance.removeLayer'>, h: HandlerContext) => {
		const { fx } = lookInstance(doc, cmd.effectInstanceId, h);
		const a = fx.appearance as Draft<Appearance>;
		a.layers.splice(layerAt(a, cmd.layerId, h), 1);
		return { layerId: cmd.layerId };
	},

	'appearance.reorderLayer': (doc, cmd: CommandOf<'appearance.reorderLayer'>, h: HandlerContext) => {
		const { fx } = lookInstance(doc, cmd.effectInstanceId, h);
		const a = fx.appearance as Draft<Appearance>;
		const from = layerAt(a, cmd.layerId, h);
		const [layer] = a.layers.splice(from, 1);
		const index = Math.min(cmd.index, a.layers.length);
		a.layers.splice(index, 0, clone(layer!) as never);
		return { layerId: cmd.layerId, index };
	},

	'appearance.setLayerEnabled': (doc, cmd: CommandOf<'appearance.setLayerEnabled'>, h: HandlerContext) => {
		const { fx } = lookInstance(doc, cmd.effectInstanceId, h);
		const a = fx.appearance as Draft<Appearance>;
		a.layers[layerAt(a, cmd.layerId, h)]!.enabled = cmd.enabled;
		return { layerId: cmd.layerId, enabled: cmd.enabled };
	},

	'appearance.setLayerFixedColor': (
		doc,
		cmd: CommandOf<'appearance.setLayerFixedColor'>,
		h: HandlerContext,
	) => {
		const { seq, clip, fx } = lookInstance(doc, cmd.effectInstanceId, h);
		const a = fx.appearance as Draft<Appearance>;
		const layer = a.layers[layerAt(a, cmd.layerId, h)]!;
		if (!cmd.fixed) {
			delete layer.fixedColor;
			return { layerId: cmd.layerId, fixed: false, flattened: 0 };
		}
		layer.fixedColor = true;
		// A fixed layer reads no role, so the colours it shows now are the colours it keeps.
		const { palette } = resolveAppearance(a as Appearance, clipFirstTime(seq, clip));
		let flattened = 0;
		for (const anim of Object.values(layer.params)) {
			for (const slot of [anim, ...anim.keyframes]) {
				if (paintRoles(slot.value).length === 0) continue;
				slot.value = paintWithoutRoles(slot.value as Paint, palette) as never;
				flattened++;
			}
		}
		assertAppearance(a, 'appearance.setLayerFixedColor', h);
		return { layerId: cmd.layerId, fixed: true, flattened };
	},

	'appearance.setPaint': (doc, cmd: CommandOf<'appearance.setPaint'>, h: HandlerContext) => {
		const { fx } = lookInstance(doc, cmd.effectInstanceId, h);
		const a = fx.appearance as Draft<Appearance>;
		const layer = a.layers[layerAt(a, cmd.layerId, h)]!;
		const spec = paintParamOf(layer as AppearanceLayer, cmd.param, h);
		setPaint(layer, spec.name, limitOr(cmd.paint, h, 'appearance.setPaint'));
		assertAppearance(a, 'appearance.setPaint', h);
		return { layerId: cmd.layerId, param: spec.name };
	},

	'appearance.setGradient': (doc, cmd: CommandOf<'appearance.setGradient'>, h: HandlerContext) => {
		const { fx } = lookInstance(doc, cmd.effectInstanceId, h);
		const a = fx.appearance as Draft<Appearance>;
		const layer = a.layers[layerAt(a, cmd.layerId, h)]!;
		const spec = paintParamOf(layer as AppearanceLayer, cmd.param, h);
		const g = GradientSchema.safeParse(cmd.gradient);
		if (!g.success) h.fail('E_INVALID_PARAM', `appearance.setGradient: ${g.error.issues[0]?.message}`);
		setPaint(layer, spec.name, limitOr({ kind: 'gradient', gradient: g.data }, h, 'appearance.setGradient'));
		assertAppearance(a, 'appearance.setGradient', h);
		return { layerId: cmd.layerId, param: spec.name };
	},

	'appearance.setLightSource': (doc, cmd: CommandOf<'appearance.setLightSource'>, h: HandlerContext) => {
		const { fx } = lookInstance(doc, cmd.effectInstanceId, h);
		(fx.appearance as Draft<Appearance>).light.source = cmd.source;
		return { source: cmd.source };
	},

	'sequence.setGlobalLight': (doc, cmd: CommandOf<'sequence.setGlobalLight'>, h: HandlerContext) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const s = seq.settings as Draft<{ globalLight?: GlobalLight }>;
		if (cmd.clear) {
			if (cmd.angle !== undefined || cmd.altitude !== undefined)
				h.fail('E_INVALID_PARAM', 'clear takes no values');
			delete s.globalLight;
			return { sequenceId: seq.id, cleared: true };
		}
		if (cmd.angle === undefined && cmd.altitude === undefined && s.globalLight)
			h.fail('E_INVALID_PARAM', 'Give angle or altitude');
		const base = emptyAppearance().light;
		s.globalLight ??= { angle: base.angle, altitude: base.altitude } as never;
		for (const k of ['angle', 'altitude'] as const) {
			const v = cmd[k];
			if (v === undefined) continue;
			const anim = s.globalLight![k];
			if (anim.keyframes.length > 0)
				h.fail('E_INVALID_PARAM', `Global light ${k} is keyframed: set it with param.set at a time`);
			anim.value = v;
		}
		return { sequenceId: seq.id };
	},

	'clip.addGenerator': (doc, cmd: CommandOf<'clip.addGenerator'>, h: HandlerContext) => {
		const effectId = cmd.effectId.startsWith('generator:')
			? `jasper.generator.${cmd.effectId.slice('generator:'.length)}`
			: cmd.effectId;
		const spec = h.registries.effects.get(effectId);
		if (!spec) return h.fail('E_UNKNOWN_EFFECT', `Unknown effect: ${cmd.effectId}`);
		if (spec.category !== 'Generate' || spec.appliesTo !== 'video')
			h.fail('E_INVALID_PARAM', `${spec.label} is not a generator`);
		const seq0 = h.sequence(doc, cmd.sequenceId);
		let track = cmd.track ?? 'V1';
		// TL-064: on a free track below the selected title when there is one.
		if (cmd.belowClipId !== undefined) {
			const { seq, clip } = h.clip(doc, cmd.belowClipId);
			if (seq.id !== seq0.id) h.fail('E_INVALID_PARAM', 'belowClipId is in another sequence');
			const at = h.frame(seq, cmd.at);
			const end = at + h.durationFrames(seq, cmd.duration);
			const slot = trackSlotOf(seq, clip.trackId, h);
			for (let i = slot.index - 1; i >= 0; i--) {
				const t = seq.videoTracks[i]!;
				const busy = Object.values(seq.clips).some(
					(c) => c.trackId === t.id && c.start < end && c.start + c.duration > at,
				);
				if (!busy && !t.locked) {
					track = t.id;
					break;
				}
				if (i === 0) track = clip.trackId;
			}
			if (slot.index === 0) track = clip.trackId;
		}
		const {
			seq,
			track: t,
			at,
			duration,
			id,
		} = newGeneratorClip(
			doc,
			{
				sequenceId: cmd.sequenceId,
				at: cmd.at,
				duration: cmd.duration,
				track,
				placement: 'first-free',
				id: cmd.id,
			} as Parameters<typeof newGeneratorClip>[1],
			h,
			'solid',
		);
		const synId = h.ids.next('syn');
		doc.synthetics[synId] = { id: synId, kind: 'transparent' } as never;
		const box = frameBox(seq);
		seq.clips[id] = {
			...commonFields(id, t.id, at, duration, 0, cmd.name ?? spec.label, 'tan'),
			kind: 'solid',
			syntheticId: synId,
			...visualFields(defaultTransform(box, box, 'none')),
		} as DClip;
		const fx = {
			id: h.ids.next('fx'),
			effectId: spec.id,
			effectVersion: spec.version,
			enabled: true,
			params: buildParams(
				spec,
				cmd.params,
				h,
				intrinsicBoxOf({ doc: doc as never, seq: seq as never, clip: seq.clips[id] as Clip }),
			),
		};
		(seq.clips[id] as unknown as { effects: unknown[] }).effects.push(fx);
		cleanupSequence(seq, h);
		h.defineRef(cmd.ref, id);
		return { clipId: id, effectInstanceId: fx.id, syntheticId: synId };
	},
} satisfies HandlerMap;
