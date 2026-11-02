// Effect Controls content model (S03:EC-003, S05:ECP-003/008): Video and Audio groups with the
// intrinsic effects (Motion, Opacity, pinned Crop, Template parameters; Volume, Panner) followed by the
// applied effects in stack order. Unknown effects show as "Missing effect: <id>" (S01:FX-022).
// crop-order (schema v8): Crop renders where it sits in the stack. The pinned Crop section shows a crop at the top of
// the stack (stack index 0, draggable like an effect header) or, when the clip has no crop, registry defaults whose
// first edit adds one at index 0; a crop placed after other effects is listed with them at its stack position.
import {
	type AppearanceLayer,
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
	type PuppetMesh,
	type PuppetPin,
	paramsPropertySpecs,
	pinnedCropOf,
	propertyDefault,
	puppetPinPropertySpec,
	puppetPinPropsOf,
	resolvePropertyAt,
	type Sequence,
	selectorFields,
	shapeItemSpecs,
	type TextAnimatorGroup,
	type TextClip,
	type TextSelector,
	templateParamSections,
	templateParamVisible,
	textAnimatorPropertySpecs,
	TITLE_LOOK_EFFECT_ID,
	walkItems,
} from '@jasper/project';
import { shapePropertyKeys } from '../../shapes/keys.ts';
import { layerRows, lightRows, paletteRows } from '../../title-looks/rows.ts';
import { lookedClip, sharedStack } from '../../title-looks/selection.ts';
import {
	bindCrop,
	bindEffectParam,
	bindProperty,
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
	/** the section's masks (Opacity masks, or the effect's own masks) and their property rows. */
	masks?: MaskList;
	/** the Text section's animators, selectors, Path Options and More Options. */
	textAnimators?: TextAnimatorListModel;
	/** the Motion section carries the 3D Layer switch of the clip. */
	threeDSwitch?: { clipId: string; enabled: boolean };
	/** a Puppet effect's meshes and pins (their property rows). */
	puppet?: PuppetListModel;
	/** spec 19 TL-090: a look's stack. */
	appearance?: AppearanceBlockModel;
	/**
	 * C3: the template section's `ui.groups`, in order: each group's row ids (rows in no group are drawn first, without
	 * a header).
	 */
	rowGroups?: { id: string; label: string; rowIds: string[] }[];
};

/** what a Puppet section shows below its params. */
export type PuppetListModel = {
	clipId: string;
	fxId: string;
	meshes: PuppetMesh[];
	pins: { pin: PuppetPin; rows: Row[] }[];
};

/** spec 19 TL-090: what a look's section shows below Intensity, top of the stack first. */
export type AppearanceBlockModel = {
	clipId: string;
	fxId: string;
	palette: Row[];
	light: Row[];
	layers: { layer: AppearanceLayer; rows: Row[] }[];
};

function appearanceBlock(
	doc: ProjectDocument,
	seq: Sequence,
	clip: Clip,
	fx: EffectInstance,
	frame: number,
): AppearanceBlockModel | null {
	const looked = lookedClip(clip);
	if (!looked || looked.fx.id !== fx.id) return null;
	return {
		clipId: clip.id,
		fxId: fx.id,
		palette: paletteRows(doc, seq, [looked], frame),
		light: lightRows(doc, seq, [looked], frame),
		layers: (sharedStack([looked]) ?? []).map((s) => ({
			layer: s.layers[0]!,
			rows: layerRows(doc, seq, s, frame),
		})),
	};
}

/** Every row of a section, also those a block draws (keys, snapping, Simplify). */
export function sectionRows(s: FxSection): Row[] {
	if (!s.appearance) return s.rows;
	return [
		...s.rows,
		...s.appearance.palette,
		...s.appearance.light,
		...s.appearance.layers.flatMap((l) => l.rows),
	];
}

function puppetList(
	doc: ProjectDocument,
	seq: Sequence,
	clip: Clip,
	fx: EffectInstance,
	frame: number,
): PuppetListModel {
	const pup = fx.puppet ?? { meshes: [], pins: [] };
	return {
		clipId: clip.id,
		fxId: fx.id,
		meshes: pup.meshes as PuppetMesh[],
		pins: pup.pins.map((pin) => ({
			pin: pin as PuppetPin,
			rows: puppetPinPropsOf(pin.kind)
				.map((prop) => {
					const spec = puppetPinPropertySpec(pin.id, prop);
					return makeRow(spec.key, [
						{
							clip,
							spec,
							path: ['puppetPin', pin.id, prop],
							resolved: resolvePropertyAt({ doc, seq, clip }, spec, frame),
						},
					]);
				})
				.filter((r): r is Row => r !== null),
		})),
	};
}

/** one selector block. */
export type SelectorBlock = { selector: TextSelector; rows: Row[]; advanced: Row[] };
/** one animator block (property rows, selector blocks). */
export type AnimatorBlock = { animator: TextAnimatorGroup; rows: Row[]; selectors: SelectorBlock[] };
/** what the Text section shows below Source Text. */
export type TextAnimatorListModel = {
	clipId: string;
	/** Source Text hold keys (AE Source Text stopwatch). */
	sourceText: Row | null;
	perCharacter3d: boolean;
	hasLegacyAnimation: boolean;
	path: { maskId: string | null; masks: { id: string; name: string }[]; rows: Row[] };
	more: Row[];
	animators: AnimatorBlock[];
};

function textAnimatorList(
	doc: ProjectDocument,
	seq: Sequence,
	clip: TextClip,
	frame: number,
): TextAnimatorListModel {
	const bind = (key: string) => makeRow(key, [bindProperty(doc, seq, clip, key, frame)]);
	const ok = (r: Row | null): r is Row => r !== null;
	const c = clip;
	const specs = textAnimatorPropertySpecs(c);
	return {
		clipId: clip.id,
		sourceText: bind('text.sourceText'),
		perCharacter3d: !!c.perCharacter3d,
		hasLegacyAnimation: !!(c.textAnimation?.in || c.textAnimation?.out),
		path: {
			maskId: c.pathOptions?.maskId ?? null,
			masks: (c.masks ?? []).map((m) => ({ id: m.id, name: m.name })),
			rows: specs
				.filter((sp) => sp.key.startsWith('textPath.'))
				.map((sp) => bind(sp.key))
				.filter(ok),
		},
		more: specs
			.filter((sp) => sp.key.startsWith('textMore.'))
			.map((sp) => bind(sp.key))
			.filter(ok),
		animators: (c.animators ?? []).map((a) => {
			const prefix = `textAnimators.${a.id}.`;
			return {
				animator: a,
				rows: specs
					.filter((sp) => sp.key.startsWith(`${prefix}properties.`))
					.map((sp) => bind(sp.key))
					.filter(ok),
				selectors: a.selectors.map((sel) => {
					const fields = selectorFields(sel.kind);
					const rowOf = (key: string) => bind(`${prefix}selectors.${sel.id}.${key}`);
					return {
						selector: sel,
						rows: fields
							.filter((f) => !f.advanced)
							.map((f) => rowOf(f.key))
							.filter(ok),
						advanced: fields
							.filter((f) => f.advanced)
							.map((f) => rowOf(f.key))
							.filter(ok),
					};
				}),
			};
		}),
	};
}

/** a section's mask tools and masks (Premiere: under Opacity and every video effect). */
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

const MATERIAL_KEYS = [
	'threeD.material.castsShadows',
	'threeD.material.lightTransmission',
	'threeD.material.acceptsShadows',
	'threeD.material.acceptsLights',
	'threeD.material.ambient',
	'threeD.material.diffuse',
	'threeD.material.specularIntensity',
	'threeD.material.specularShininess',
	'threeD.material.metal',
	'threeD.material.reflectionIntensity',
	'threeD.material.reflectionSharpness',
];
const CAMERA_OPTION_KEYS = [
	'camera.zoom',
	'camera.depthOfField',
	'camera.focusDistance',
	'camera.aperture',
	'camera.blurLevel',
	'camera.irisShape',
	'camera.irisRotation',
	'camera.irisRoundness',
	'camera.irisAspectRatio',
	'camera.irisDiffractionFringe',
	'camera.highlightGain',
	'camera.highlightThreshold',
	'camera.highlightSaturation',
];
const LIGHT_OPTION_KEYS = [
	'light.type',
	'light.intensity',
	'light.color',
	'light.coneAngle',
	'light.coneFeather',
	'light.falloff',
	'light.radius',
	'light.falloffDistance',
	'light.castsShadows',
	'light.shadowDarkness',
	'light.shadowDiffusion',
	'light.environmentRotation',
	'light.environmentBackground',
];

export type EcGroup = { id: 'video' | 'audio'; title: string; sections: FxSection[] };

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
		const pinned = isVisualClip(clip) ? pinnedCropOf(effects) : null;
		// The pinned section (defaults that create a crop at index 0) only while the clip has no crop elsewhere.
		const showPinnedCrop = !!pinned || !effects.some((e) => e.effectId === CROP_EFFECT.id);
		// cameras and lights (After Effects' Transform / Camera Options / Light Options groups).
		if (clip.kind === 'camera' || clip.kind === 'light') {
			const k = clip.kind;
			sections.push({
				id: `${clip.id}:${k}:transform`,
				title: 'Transform',
				clip,
				intrinsic: true,
				rows: rows(
					k === 'camera'
						? [
								'camera.type',
								'camera.pointOfInterest',
								'camera.position',
								'camera.orientation',
								'camera.rotationX',
								'camera.rotationY',
								'camera.rotationZ',
							]
						: [
								'light.autoOrient',
								'light.pointOfInterest',
								'light.position',
								'light.orientation',
								'light.rotationX',
								'light.rotationY',
								'light.rotationZ',
							],
				),
			});
			sections.push({
				id: `${clip.id}:${k}:options`,
				title: k === 'camera' ? 'Camera Options' : 'Light Options',
				clip,
				intrinsic: true,
				rows: rows(
					(k === 'camera' ? CAMERA_OPTION_KEYS : LIGHT_OPTION_KEYS).filter((key) => {
						// Depth of field rows show with Depth of Field on (AE greys them; they are noise otherwise).
						if (k === 'camera' && key !== 'camera.zoom' && key !== 'camera.depthOfField')
							return (clip as { camera?: { depthOfField?: boolean } }).camera?.depthOfField === true;
						return true;
					}),
				),
			});
		}
		if (isVisualClip(clip)) {
			const nonUniform = 'transform' in clip && clip.transform.uniformScale === false;
			const td = 'threeD' in clip ? clip.threeD : undefined;
			const is3d = !!td?.enabled && clip.kind !== 'captions';
			sections.push({
				id: `${clip.id}:motion`,
				title: 'Motion',
				clip,
				intrinsic: true,
				rows: rows(
					is3d
						? [
								'transform.position',
								'threeD.positionZ',
								'transform.scale',
								...(nonUniform ? ['transform.scaleWidth'] : []),
								'threeD.scaleZ',
								'transform.uniformScale',
								'threeD.orientation',
								'threeD.rotationX',
								'threeD.rotationY',
								'transform.rotation',
								'transform.anchor',
								'threeD.anchorZ',
								'threeD.autoOrient',
							]
						: [
								'transform.position',
								'transform.scale',
								...(nonUniform ? ['transform.scaleWidth'] : []),
								'transform.uniformScale',
								'transform.rotation',
								'transform.anchor',
							],
				),
				...(clip.kind !== 'captions' ? { threeDSwitch: { clipId: clip.id, enabled: is3d } } : {}),
			});
			if (is3d) {
				sections.push({
					id: `${clip.id}:material`,
					title: 'Material Options',
					clip,
					intrinsic: true,
					rows: rows(MATERIAL_KEYS),
				});
				if (td?.geometry && seq.threeD?.renderer === 'advanced')
					sections.push({
						id: `${clip.id}:geometry`,
						title: 'Geometry Options',
						clip,
						intrinsic: true,
						rows: rows([
							'threeD.geometry.bevelStyle',
							'threeD.geometry.bevelDepth',
							'threeD.geometry.holeBevelDepth',
							'threeD.geometry.extrusionDepth',
						]),
					});
			}
			sections.push({
				id: `${clip.id}:opacity`,
				title: 'Opacity',
				clip,
				intrinsic: true,
				rows: rows(['opacity', 'blendMode']),
				masks: maskList(doc, seq, clip, (clip as { masks?: Mask[] }).masks, null, frame),
			});
			if (clip.kind === 'video' || clip.kind === 'nest-video')
				sections.push({
					id: `${clip.id}:timeRemap`,
					title: 'Time Remapping',
					clip,
					intrinsic: true,
					rows: [],
				});
			// Wave expressions: Source Text, where an expression can drive the text (AE's Text ▸ Source Text).
			if (clip.kind === 'text')
				sections.push({
					id: `${clip.id}:sourceText`,
					title: 'Text',
					clip,
					intrinsic: true,
					rows: rows(['text.content']),
					// Source Text keys, Path Options, More Options, animators (AE's Text group).
					textAnimators: textAnimatorList(doc, seq, clip, frame),
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
			if (showPinnedCrop)
				sections.push({
					id: `${clip.id}:crop`,
					title: 'Crop',
					clip,
					intrinsic: true,
					fx: pinned ?? undefined,
					effect: CROP_EFFECT,
					stackIndex: pinned ? 0 : undefined,
					rows: CROP_EFFECT.params
						.map((p) => makeRow(`crop.${p.name}`, [bindCrop(doc, seq, clip, p.name, frame)]))
						.filter((r): r is Row => r !== null),
					...(pinned ? { masks: maskList(doc, seq, clip, pinned.masks, pinned.id, frame) } : {}),
				});
			if (clip.kind === 'shape' && clip.shape.type !== 'vector')
				sections.push({
					id: `${clip.id}:shape`,
					title: 'Shape',
					clip,
					intrinsic: true,
					rows: rows(shapePropertyKeys(clip)),
				});
			// a vector shape's contents, one section per item (AE's Contents twirl-downs), in list order.
			if (clip.kind === 'shape' && clip.shape.type === 'vector') {
				const names = new Map<string, string>();
				walkItems(clip.shape.contents, (it, parent) => {
					const title = parent ? `${names.get(parent.id)} › ${it.name}` : it.name;
					names.set(it.id, title);
					sections.push({
						id: `${clip.id}:shape:${it.id}`,
						title: `Contents › ${title}${it.enabled === false ? ' (off)' : ''}`,
						clip,
						intrinsic: true,
						rows: rows(shapeItemSpecs(clip, it.id).map((sp) => sp.key)),
					});
				});
			}
			const tpl = templateOf(clip, registries.mgTemplates);
			if (tpl) {
				// C3: params that do not apply to the clip are hidden (`visibleWhen`); the others in the template's groups.
				const params = (clip as { params?: Record<string, unknown> }).params;
				const specs = paramsPropertySpecs(tpl).filter((s) => templateParamVisible(s, params));
				const groups = templateParamSections(specs).flatMap((sec) =>
					sec.section
						? [{ id: sec.section.id, label: sec.section.label, rowIds: sec.specs.map((s) => s.key) }]
						: [],
				);
				sections.push({
					id: `${clip.id}:template`,
					title: `Template · ${tpl.name}`,
					clip,
					intrinsic: true,
					rows: rows(specs.map((s) => s.key)),
					...(groups.length ? { rowGroups: groups } : {}),
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
				...(fx.effectId === 'jasper.puppet' ? { puppet: puppetList(doc, seq, clip, fx, frame) } : {}),
				...(() => {
					const appearance =
						fx.effectId === TITLE_LOOK_EFFECT_ID ? appearanceBlock(doc, seq, clip, fx, frame) : null;
					return appearance ? { appearance } : {};
				})(),
				// every video effect but the corner pin (the layer geometry) has masks.
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
	if (b.resolved.animated || b.resolved.anim?.expression) return true;
	if (filter === 'animated') return false;
	if (b.spec.defaultValue === undefined) return false;
	const d = propertyDefault({ doc, seq, clip: b.clip }, b.spec);
	return JSON.stringify(d) !== JSON.stringify(b.resolved.value);
}
