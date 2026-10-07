// Effect Controls content model (S03:EC-003, S05:ECP-003/008): Video and Audio groups with the
// intrinsic effects (Motion, Opacity, pinned Crop, Template parameters; Volume, Panner) followed by the
// applied effects in stack order. Unknown effects show as "Missing effect: <id>" (S01:FX-022).
import {
	type Clip,
	CORNER_PIN_EFFECT_ID,
	CROP_EFFECT,
	type EffectInstance,
	type EffectRegistry,
	type EffectSpec,
	MASK_PROPS,
	type Mask,
	type MgTemplateRegistry,
	maskPropertySpec,
	type ProjectDocument,
	paramsPropertySpecs,
	propertyDefault,
	resolvePropertyAt,
	type Sequence,
} from '@jasper/project';
import { shapePropertyKeys } from '../../shapes/keys.ts';
import {
	bindCrop,
	bindEffectParam,
	bindProperty,
	cropEffectOf,
	isAudioClip,
	isVisualClip,
	makeRow,
	type Row,
	templateOf,
} from '../properties/lib/model.ts';

export type FxSection = {
	/** Stable section id (collapse state, focus). */
	id: string;
	title: string;
	clip: Clip;
	rows: Row[];
	/** Intrinsic sections cannot be reordered or removed (Motion cannot be bypassed either). */
	intrinsic: boolean;
	/** The applied (or pinned crop) effect instance, when the section is backed by one. */
	fx?: EffectInstance;
	effect?: EffectSpec;
	/** Index of `fx` in the clip's effect stack. */
	stackIndex?: number;
	missing?: boolean;
	/** wp masks: the section's masks (Opacity masks, or the effect's own masks) and their property rows. */
	masks?: MaskList;
};

/** wp masks: a section's mask tools and masks (Premiere: under Opacity and every video effect). */
export type MaskList = {
	owner: { clipId: string; effectId: string | null };
	blocks: { mask: Mask; rows: Row[] }[];
};

function maskList(
	doc: ProjectDocument,
	seq: Sequence,
	clip: Clip,
	masks: readonly Mask[] | undefined,
	effectId: string | null,
	frame: number,
): MaskList {
	return {
		owner: { clipId: clip.id, effectId },
		blocks: (masks ?? []).map((mask) => ({
			mask,
			rows: MASK_PROPS.map((prop) => {
				const spec = maskPropertySpec(mask.id, prop);
				return makeRow(spec.key, [
					{
						clip,
						spec,
						path: ['mask', mask.id, prop],
						resolved: resolvePropertyAt({ doc, seq, clip }, spec, frame),
					},
				]);
			}).filter((r): r is Row => r !== null),
		})),
	};
}

type EcGroup = { id: 'video' | 'audio'; title: string; sections: FxSection[] };

/** The primary clip plus its linked partner of the other medium (video clip + its audio, S01:KND-003). */
export function shownClips(seq: Sequence, primary: Clip): Clip[] {
	const out = [primary];
	if (primary.linkId) {
		const members = seq.links[primary.linkId]?.members ?? [];
		const want = isVisualClip(primary) ? isAudioClip : isVisualClip;
		const partner = members
			.map((id) => seq.clips[id])
			.find((c): c is Clip => !!c && c.id !== primary.id && want(c));
		if (partner) out.push(partner);
	}
	return out.sort((a, b) => Number(isAudioClip(a)) - Number(isAudioClip(b)));
}

export function buildGroups(
	doc: ProjectDocument,
	seq: Sequence,
	clips: readonly Clip[],
	frame: number,
	registries: { effects: EffectRegistry; mgTemplates: MgTemplateRegistry },
): EcGroup[] {
	const groups: EcGroup[] = [];
	for (const clip of clips) {
		const prop = (key: string) => bindProperty(doc, seq, clip, key, frame, registries.mgTemplates);
		const rows = (keys: string[]) =>
			keys.map((k) => makeRow(k, [prop(k)])).filter((r): r is Row => r !== null);
		const sections: FxSection[] = [];
		const effects = (clip as { effects?: EffectInstance[] }).effects ?? [];
		const pinned = isVisualClip(clip) ? cropEffectOf(clip) : null;
		if (isVisualClip(clip)) {
			const nonUniform =
				(clip as { transform?: { uniformScale: boolean } }).transform?.uniformScale === false;
			sections.push({
				id: `${clip.id}:motion`,
				title: 'Motion',
				clip,
				intrinsic: true,
				rows: rows([
					'transform.position',
					'transform.scale',
					...(nonUniform ? ['transform.scaleWidth'] : []),
					'transform.uniformScale',
					'transform.rotation',
					'transform.anchor',
				]),
			});
			sections.push({
				id: `${clip.id}:opacity`,
				title: 'Opacity',
				clip,
				intrinsic: true,
				rows: rows(['opacity', 'blendMode']),
				masks: maskList(doc, seq, clip, (clip as { masks?: Mask[] }).masks, null, frame),
			});
			// Wave expressions: Source Text, where an expression can drive the text (AE's Text ▸ Source Text).
			if (clip.kind === 'text')
				sections.push({
					id: `${clip.id}:sourceText`,
					title: 'Text',
					clip,
					intrinsic: true,
					rows: rows(['text.content']),
				});
			// M2 (wp-m2-text-anim, S11:TXA-022): the Text Animation section (body drawn by TextAnimationSection).
			if (clip.kind === 'text')
				sections.push({
					id: `${clip.id}:textAnimation`,
					title: 'Text Animation',
					clip,
					intrinsic: true,
					rows: [],
				});
			sections.push({
				id: `${clip.id}:crop`,
				title: 'Crop',
				clip,
				intrinsic: true,
				fx: pinned ?? undefined,
				effect: CROP_EFFECT,
				stackIndex: pinned ? effects.indexOf(pinned) : undefined,
				rows: CROP_EFFECT.params
					.map((p) => makeRow(`crop.${p.name}`, [bindCrop(doc, seq, clip, p.name, frame)]))
					.filter((r): r is Row => r !== null),
				...(pinned ? { masks: maskList(doc, seq, clip, pinned.masks, pinned.id, frame) } : {}),
			});
			if (clip.kind === 'shape')
				sections.push({
					id: `${clip.id}:shape`,
					title: 'Shape',
					clip,
					intrinsic: true,
					rows: rows(shapePropertyKeys(clip)),
				});
			const tpl = templateOf(clip, registries.mgTemplates);
			if (tpl) {
				sections.push({
					id: `${clip.id}:template`,
					title: `Template · ${tpl.name}`,
					clip,
					intrinsic: true,
					rows: rows(paramsPropertySpecs(tpl).map((s) => s.key)),
				});
			}
		} else if (isAudioClip(clip)) {
			sections.push({
				id: `${clip.id}:volume`,
				title: 'Volume',
				clip,
				intrinsic: true,
				rows: rows(['volumeDb', 'gainDb']),
			});
			sections.push({ id: `${clip.id}:panner`, title: 'Panner', clip, intrinsic: true, rows: rows(['pan']) });
		}
		effects.forEach((fx, stackIndex) => {
			if (fx === pinned) return;
			const effect = registries.effects.get(fx.effectId, fx.effectVersion);
			if (!effect) {
				sections.push({
					id: `${clip.id}:fx:${fx.id}`,
					title: `Missing effect: ${fx.effectId}`,
					clip,
					intrinsic: false,
					fx,
					stackIndex,
					missing: true,
					rows: [],
				});
				return;
			}
			sections.push({
				id: `${clip.id}:fx:${fx.id}`,
				// Wave expressions: a renamed instance shows its own name (expressions find it by that name).
				title: fx.name ?? effect.label,
				clip,
				intrinsic: false,
				fx,
				effect,
				stackIndex,
				rows: effect.params
					.map((p) =>
						makeRow(`effects.${fx.id}.${p.name}`, [bindEffectParam(doc, seq, clip, fx, effect, p, frame)]),
					)
					.filter((r): r is Row => r !== null),
				// wp masks: every video effect but the corner pin (the layer geometry) has masks.
				...(effect.appliesTo === 'video' && fx.effectId !== CORNER_PIN_EFFECT_ID && !effect.passthrough
					? { masks: maskList(doc, seq, clip, fx.masks, fx.id, frame) }
					: {}),
			});
		});
		const medium = isAudioClip(clip) ? 'audio' : 'video';
		if (sections.length) groups.push({ id: medium, title: medium === 'video' ? 'Video' : 'Audio', sections });
	}
	return groups;
}

/** Footer filter (S05:ECP-007): all rows, only animated ones, or only ones that differ from the default. */
export type RowFilter = 'all' | 'animated' | 'modified';

export function rowVisible(doc: ProjectDocument, seq: Sequence, row: Row, filter: RowFilter): boolean {
	if (filter === 'all') return true;
	const b = row.bindings[0]!;
	// Keyframed, or driven by an expression (wave expressions).
	if (b.resolved.animated || (b.resolved.anim as { expression?: unknown } | null)?.expression) return true;
	if (filter === 'animated') return false;
	if (b.spec.defaultValue === undefined) return false;
	const d = propertyDefault({ doc, seq, clip: b.clip }, b.spec);
	return JSON.stringify(d) !== JSON.stringify(b.resolved.value);
}
