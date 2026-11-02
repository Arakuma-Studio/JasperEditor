// Property registry (S03 §11 adapted to S01 storage, ARCHITECTURE §2.3/§5.4). Drives Properties /
// Effect Controls rows, agent schemas and range clamping. Keys are dotted and relative to the owner:
// `transform.position`, `opacity`, `volumeDb`, `effects.<fxId>.<param>`, `params.<name>`, `text.sizePx`.
// Each spec carries labels, units, ranges, UI control hints, the reset value (`defaultValue`), its
// applicability by kind capabilities and how the UI writes it (`param.set` or `clip.update`).

import { z } from 'zod';
import { BLEND_MODE_GROUPS, BLEND_MODE_LABELS } from '../blend-modes.ts';
import type { ParamPath } from '../commands/schemas/common.ts';
import {
	derefSchema,
	type JsonSchemaNode as JsonSchema,
	type PropsUiHint,
} from '../composition/json-schema.ts';
import { contentTimeAt } from '../derive/index.ts';
import { DEFAULT_SHAPE_SIZE, shapeIntrinsicBox } from '../factories.ts';
import { mediaDisplaySize } from '../interpret/model.ts';
import { type EvaluateOptions, evaluate } from '../keyframes.ts';
import type { SpatialMetric } from '../keyframes-spatial.ts';
import {
	MASK_DEFAULT_FEATHER,
	MASK_EXPANSION_RANGE,
	MASK_FEATHER_RANGE,
	MASK_OPACITY_RANGE,
	MASK_PROP_LABELS,
	type MaskProp,
} from '../masks/model.ts';
import { TEMPLATE_MEDIA_KIND, TEMPLATE_MEDIA_KINDS_KEY, TEMPLATE_PARAM_KIND_KEY } from '../param-media.ts';
import type { Animatable, Keyframe, RGBA, SpatialInterpolation } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Mask } from '../schema/mask.ts';
import type { MgCompositionInfo } from '../schema/media.ts';
import { PUPPET_PIN_LABELS, type PuppetPinKind, type PuppetPinProp } from '../schema/puppet.ts';
import {
	BLEND_MODES,
	type Clip,
	type EffectInstance,
	type Sequence,
	type TextAnimation,
	type TextStyle,
} from '../schema/sequence.ts';
import {
	getTextAnimationSpec,
	LATEST_TEXT_ANIMATION_SPECS,
	scaleAnimationFrames,
	TEXT_ANIMATION_SIDES,
	type TextAnimationSide,
} from '../text-animations.ts';
import {
	DEFAULT_TEXT_BACKGROUND,
	DEFAULT_TEXT_SHADOW,
	DEFAULT_TEXT_STROKE,
	MAX_TEXT_STROKES,
} from '../text-styles/patch.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import type { Appearance } from '../title-looks/model.ts';
import { appearanceAnimAt, appearancePropertySpecs } from '../title-looks/properties.ts';
import { isThreeDDynamicKey, threeDDynamicSpecs } from './three-d-properties.ts';
import { SHAPE_ITEM_KEY_PREFIX, shapeItemPropertySpecs } from '../vector/properties.ts';
import type { EffectRegistry, EffectSpec, ParamSpec } from './effects.ts';
import { kindCapabilities } from './kinds.ts';
import type { MgTemplateInfo, MgTemplateUi } from './mg.ts';
import {
	isTextAnimatorKey,
	resolveTextAnimatorSpec,
	SOURCE_TEXT_SPEC,
	textAnimatorPropertySpecs,
} from './text-animator-properties.ts';
import { THREE_D_PROPERTY_SPECS } from './three-d-properties.ts';

/** `json` properties carry their schema in `valueSchema` (arrays and free-form composition props). */
export type ValueKind = ParamSpec['type'] | 'json';
export type PropertyGroup =
	| 'motion'
	| 'opacity'
	| 'audio'
	| 'text'
	| 'solid'
	| 'params'
	/** M2 (S08): composition clip props (`props.<dotted.path>`). */
	| 'props'
	/** M2 (S11:TXA-007, wp-m2-text-anim): text animators (`textAnimation.<side>.…`). */
	| 'textAnimation'
	| 'effect'
	| 'crop'
	| 'box'
	/** M2 (S11:SHP-005, wp-m2-shapes): shape geometry and paint (`shape.*`). */
	| 'shape'
	/** Animator, selector, Path Options, and More Options keys (`textAnimators.*`, …). */
	| 'textAnimator'
	/** wp masks: Opacity / effect mask properties (`masks.<maskId>.<prop>`). */
	| 'mask'
	/** three-d: 3D transform of a 3D layer, its Material Options and Geometry Options; cameras; lights. */
	| 'threeD'
	| 'material'
	| 'geometry'
	| 'camera'
	| 'light';

/** Everything a default or a patch may need to know about the clip. */
export type PropertyContext = {
	doc: Pick<ProjectDocument, 'media' | 'synthetics'> & Partial<Pick<ProjectDocument, 'sequences'>>;
	seq: Pick<Sequence, 'settings'>;
	clip: Clip;
};

export type PropertySpec = {
	key: string;
	label: string;
	group: PropertyGroup;
	kind: ValueKind;
	unit?: ParamSpec['unit'];
	range?: ParamSpec['range'];
	/** `continuous` = interpolated keyframes; `hold-only` = step keyframes (S01:KF-007); `no` = static field. */
	animatable: 'continuous' | 'hold-only' | 'no';
	/**
	 * vec2 point properties with a spatial path (S03:KF-021): the spatial interpolation new keys get. Absent = not
	 * spatial (the keys never carry `spatial`; e.g. scale-like vectors, shape size, colour wheels).
	 */
	spatial?: SpatialInterpolation;
	/** spatial-points: units of the spatial path (`ParamSpec.spatialMetric`); absent = isotropic value units. */
	spatialMetric?: 'layer-box';
	options?: readonly string[];
	optionLabels?: readonly string[];
	/** Menu section of each option (`options` order); consecutive runs are drawn as labelled groups. */
	optionGroups?: readonly string[];
	/**
	 * Path of the stored value inside the clip (an Animatable when `animatable !== 'no'`). Special heads:
	 * `$synthetic` (the clip's synthetic source) and `$effect` (`['$effect', fxId, param]`).
	 */
	storagePath: readonly string[];
	appliesTo(clip: Pick<Clip, 'kind'>): boolean;
	ui: {
		control:
			| 'scrub'
			| 'slider'
			| 'vec2'
			| 'angle'
			| 'color'
			| 'select'
			| 'toggle'
			| 'text'
			| 'wheel'
			| 'curve'
			| 'media'
			/** M2 (S08): a JSON editor (arrays, free-form objects). */
			| 'json'
			/** wp masks: a video-track picker (value = track id, '' = none). */
			| 'track'
			/** Wave expressions: x, y, z fields (3D Point Control). */
			| 'vec3'
			/** Wave expressions: a clip picker (Layer Control; value = clip id, '' = none). */
			| 'layer'
			/** Wave expressions: Dropdown Menu Control (1-based index into the effect's `items`). */
			| 'menu'
			/** parity (roto): picker of the clip's roto objects (string param holding a roto id). */
			| 'roto-object'
			/** sim-warp: a distortion mesh row (stopwatch and keyframe navigation; edited on the Program monitor). */
			| 'mesh';
		bipolar?: boolean;
		/** Digits after the decimal point in the UI (derived from `range.step` when absent). */
		precision?: number;
		multiline?: boolean;
		/**
		 * Template params (`ui.params.<name>.control`): a custom control registered by the web app under this name
		 * (`registerTemplateParamControl`); an unregistered name falls back to the `control` editor.
		 */
		customControl?: string;
	};
	/** Template params (`ui.groups`): the sub-section of the template's Parameters the row belongs to. */
	section?: { id: string; label: string };
	/**
	 * Template params (`ui.params.<name>.visibleWhen`): the row is shown only while the sibling param `param` holds
	 * one of `in` (`templateParamVisible`). The value stays settable (agents, set_motion_graphic_params).
	 */
	visibleWhen?: { param: string; in: readonly unknown[] };
	/** Reset value (S03:PRP-002 `defaultValue`), a constant or computed from the clip. */
	defaultValue?: unknown | ((ctx: PropertyContext) => unknown);
	/** How the UI writes the value: `param` (default) = `param.set`; `clip.update` = the returned patch. */
	write?:
		| { via: 'param' }
		| { via: 'clip.update'; patch(value: unknown, clip: Clip): Record<string, unknown> };
	description?: string;
	/** M2 (S08): JSON Schema of the value (`json` kind and every spec built from a JSON Schema). */
	valueSchema?: JsonSchemaObject;
	/** `media` values (fx framework): the asset kinds the picker offers (absent = LUTs, the M2 colour pickers). */
	mediaKinds?: readonly string[];
	/**
	 * `media` values of template params (`mediaParam()`, social comments): "None" is `null` (effect media params
	 * write `{mediaId: ''}`).
	 */
	mediaNullable?: boolean;
	/** wp shapes: structural check of a written value (`json` paths and gradients); false = E_INVALID_PARAM. */
	validate?: (value: unknown) => boolean;
};

const hasTransform = (c: Pick<Clip, 'kind'>) => !!kindCapabilities(c.kind)?.hasTransform;
const hasOpacity = (c: Pick<Clip, 'kind'>) => !!kindCapabilities(c.kind)?.hasOpacity;
const isAudio = (c: Pick<Clip, 'kind'>) =>
	c.kind === 'audio' || c.kind === 'nest-audio' || c.kind === 'synthetic-audio';
const isText = (c: Pick<Clip, 'kind'>) => c.kind === 'text';

const styleWrite = (field: string): PropertySpec['write'] => ({
	via: 'clip.update',
	patch: (v) => ({ content: { style: { [field]: v } } }),
});
const WHITE: RGBA = [1, 1, 1, 1];
const BLACK: RGBA = [0, 0, 0, 1];

/** Intrinsic (layer) box of a visual clip in pixels (S03:DM-003). */
export function intrinsicBoxOf(ctx: PropertyContext): { width: number; height: number } {
	const { clip, doc, seq } = ctx;
	const frame = { width: seq.settings.width, height: seq.settings.height };
	const r = clip as Record<string, unknown>;
	if (clip.kind === 'video' || clip.kind === 'still' || clip.kind === 'animated-image') {
		const asset = doc.media[r.mediaId as string];
		// imports: rotation and the (conformed) pixel aspect ratio.
		return (asset && mediaDisplaySize(asset)) ?? frame;
	}
	if (clip.kind === 'text') {
		const box = r.box as { width: number; height: number };
		return { width: box.width, height: box.height };
	}
	if (clip.kind === 'motion-graphic' || clip.kind === 'composition') {
		const canvas = r.canvas as 'sequence' | { width: number; height: number };
		return canvas === 'sequence' ? frame : { width: canvas.width, height: canvas.height };
	}
	// M2 (S11:SHP-001): size plus the stroke drawn outside the geometry; vector shapes (wp shapes): the frame.
	if (clip.kind === 'shape') return shapeIntrinsicBox(clip.shape, frame);
	// edit-structure (S01:KND-020): a nest clip's box is the nested sequence's frame.
	if (clip.kind === 'nest-video') {
		const nested = doc.sequences?.[r.sequenceId as string];
		if (nested) return { width: nested.settings.width, height: nested.settings.height };
	}
	return frame;
}

// S11:TXA-007: static keys `textAnimation.<side>.preset` (enum incl. `none`) and `.durationFrames`; dynamic keys
// `textAnimation.<side>.params.<name>` from the chosen preset's schema. Every key is static (`animatable: 'no'`)
// and written through `clip.update {textAnimation}` (the handler validates the preset's params as a whole).

type TextAnimated = Pick<Clip, 'kind'> & { textAnimation?: TextAnimation | null };
const SIDE_LABEL: Record<TextAnimationSide, string> = { in: 'In', out: 'Out' };
const sidePatch = (side: TextAnimationSide, value: unknown) => ({ textAnimation: { [side]: value } });

function textAnimationSideSpecs(side: TextAnimationSide): PropertySpec[] {
	const presets = LATEST_TEXT_ANIMATION_SPECS.filter((s) => s.phases.includes(side));
	return [
		{
			key: `textAnimation.${side}.preset`,
			label: `${SIDE_LABEL[side]} Animation`,
			group: 'textAnimation',
			kind: 'enum',
			options: ['none', ...presets.map((s) => s.id)],
			optionLabels: ['None', ...presets.map((s) => s.label)],
			animatable: 'no',
			storagePath: ['textAnimation', side, 'preset'],
			appliesTo: isText,
			ui: { control: 'select' },
			defaultValue: 'none',
			write: {
				via: 'clip.update',
				patch: (v) => sidePatch(side, v === 'none' ? null : { preset: v }),
			},
			description: `Text animation preset played ${side === 'in' ? 'at the start' : 'at the end'} of the clip (params reset to the preset's defaults).`,
		},
		{
			key: `textAnimation.${side}.durationFrames`,
			label: `${SIDE_LABEL[side]} Duration`,
			group: 'textAnimation',
			kind: 'number',
			unit: 'frames',
			range: { min: 1, max: 100000, softMax: 300, step: 1 },
			animatable: 'no',
			storagePath: ['textAnimation', side, 'durationFrames'],
			appliesTo: isText,
			ui: { control: 'scrub', precision: 0 },
			defaultValue: ({ clip, seq }: PropertyContext) => {
				const a = (clip as TextAnimated).textAnimation?.[side];
				const spec = a ? getTextAnimationSpec(a.preset, a.version) : undefined;
				return spec ? scaleAnimationFrames(spec.defaultDurationFrames, seq.settings.frameRate) : undefined;
			},
			write: { via: 'clip.update', patch: (v) => sidePatch(side, { durationFrames: v }) },
			description: `Length of the ${side} window in frames, anchored to the clip's ${side === 'in' ? 'first' : 'last'} visible frame.`,
		},
	];
}

const paramSpecCache = new Map<string, PropertySpec[]>();

/** `textAnimation.<side>.params.<name>` specs of the clip's current presets (unknown presets have none). */
export function textAnimationParamSpecs(clip: TextAnimated): PropertySpec[] {
	if (clip.kind !== 'text') return [];
	return TEXT_ANIMATION_SIDES.flatMap((side) => {
		const a = clip.textAnimation?.[side];
		const spec = a ? getTextAnimationSpec(a.preset, a.version) : undefined;
		if (!spec) return [];
		const cacheKey = `${side}:${spec.id}@${spec.version}`;
		let specs = paramSpecCache.get(cacheKey);
		if (!specs) {
			const json = z.toJSONSchema(spec.paramsSchema, { unrepresentable: 'any', io: 'input' });
			specs = jsonSchemaPropertySpecs(json as JsonSchemaObject, {
				keyPrefix: `textAnimation.${side}.params`,
				storageRoot: ['textAnimation', side, 'params'],
				group: 'textAnimation',
				appliesTo: isText,
				defaults: spec.defaults,
				nested: false,
			}).map(({ valueSchema: _v, ...s }) => {
				const name = s.storagePath[s.storagePath.length - 1]!;
				return {
					...s,
					label: `${SIDE_LABEL[side]} ${s.label}`,
					write: { via: 'clip.update', patch: (v: unknown) => sidePatch(side, { params: { [name]: v } }) },
				} satisfies PropertySpec;
			});
			paramSpecCache.set(cacheKey, specs);
		}
		return specs;
	});
}

/** Largest shape side and stroke width the registry accepts (layer pixels); larger values are clamped. */
export const SHAPE_LIMITS = { size: 32768, strokeWidth: 4096, cornerRadius: 16384 } as const;
/** Stroke added when a "None" stroke is first edited (Properties ▸ Shape, `param.set shape.stroke.*`). */
export const DEFAULT_SHAPE_STROKE = {
	color: BLACK,
	width: 8,
	position: 'center' as const,
};
/** Rectangle / ellipse shapes (vector shapes have per-item `shape.items.*` keys instead, wp shapes). */
const isShape = (c: Pick<Clip, 'kind'>) =>
	c.kind === 'shape' && (c as { shape?: { type?: string } }).shape?.type !== 'vector';
/** Corner radius applies to rectangles; a bare `{kind}` (agent schema) counts as a possible rectangle. */
const isRectShape = (c: Pick<Clip, 'kind'>) =>
	isShape(c) && (c as { shape?: { type?: string } }).shape?.type !== 'ellipse';

/** Shape specs: keyframable size, fill, stroke colour/width and corner radius (shared KF evaluator). */
const SHAPE_PROPERTY_SPECS: readonly PropertySpec[] = [
	{
		key: 'shape.size',
		label: 'Size',
		group: 'shape',
		kind: 'vec2',
		unit: 'px',
		range: { min: 0, max: SHAPE_LIMITS.size, step: 1 },
		animatable: 'continuous',
		storagePath: ['shape', 'size'],
		appliesTo: isShape,
		ui: { control: 'vec2', precision: 1 },
		defaultValue: DEFAULT_SHAPE_SIZE,
		description: 'Width and height of the rectangle or ellipse in layer pixels (the stroke is not scaled).',
	},
	{
		key: 'shape.fill',
		label: 'Fill',
		group: 'shape',
		kind: 'color',
		animatable: 'continuous',
		storagePath: ['shape', 'fill'],
		appliesTo: isShape,
		ui: { control: 'color' },
		defaultValue: WHITE,
		description: 'Fill colour; clip.update {shape: {fill: null}} removes the fill ("None").',
	},
	{
		key: 'shape.stroke.color',
		label: 'Stroke Color',
		group: 'shape',
		kind: 'color',
		animatable: 'continuous',
		storagePath: ['shape', 'stroke', 'color'],
		appliesTo: isShape,
		ui: { control: 'color' },
		defaultValue: DEFAULT_SHAPE_STROKE.color,
		description: 'Stroke colour; setting any stroke property adds a stroke when there is none.',
	},
	{
		key: 'shape.stroke.width',
		label: 'Stroke Width',
		group: 'shape',
		kind: 'number',
		unit: 'px',
		range: { min: 0, max: SHAPE_LIMITS.strokeWidth, softMax: 100, step: 0.1 },
		animatable: 'continuous',
		storagePath: ['shape', 'stroke', 'width'],
		appliesTo: isShape,
		ui: { control: 'scrub', precision: 1 },
		defaultValue: DEFAULT_SHAPE_STROKE.width,
		description: 'Visible stroke width in layer pixels, whatever the position.',
	},
	{
		key: 'shape.stroke.position',
		label: 'Stroke Position',
		group: 'shape',
		kind: 'enum',
		options: ['inside', 'center', 'outside'],
		optionLabels: ['Inside', 'Center', 'Outside'],
		animatable: 'no',
		storagePath: ['shape', 'stroke', 'position'],
		appliesTo: isShape,
		ui: { control: 'select' },
		defaultValue: DEFAULT_SHAPE_STROKE.position,
		description: 'Where the stroke sits relative to the outline: inside, centred on it, or outside.',
	},
	{
		key: 'shape.cornerRadius',
		label: 'Corner Radius',
		group: 'shape',
		kind: 'number',
		unit: 'px',
		range: { min: 0, max: SHAPE_LIMITS.cornerRadius, softMax: 200, step: 0.1 },
		animatable: 'continuous',
		storagePath: ['shape', 'cornerRadius'],
		appliesTo: isRectShape,
		ui: { control: 'scrub', precision: 1 },
		defaultValue: 0,
		description: 'Rounded corners of a rectangle (limited to half the shorter side when drawn).',
	},
];

type TypoStyle = Partial<TextStyle> & Record<string, unknown>;
/** Readers of the typography specs (`['$typo', key]` storage: values with read-time defaults). */
const TYPO_GETTERS = new Map<string, (s: TypoStyle) => unknown>();
const styleOfClip = (c: Clip) => (c.kind === 'text' ? (c.content.style as TypoStyle) : ({} as TypoStyle));
const typo = (
	key: string,
	label: string,
	kind: PropertySpec['kind'],
	get: (s: TypoStyle) => unknown,
	patch: (v: unknown, s: TypoStyle) => Record<string, unknown>,
	extra: Partial<PropertySpec> & { defaultValue: unknown },
): PropertySpec => {
	TYPO_GETTERS.set(key, get);
	return {
		key: `text.${key}`,
		label,
		group: 'text',
		kind,
		animatable: 'no',
		storagePath: ['$typo', key],
		appliesTo: isText,
		ui: {
			control:
				kind === 'boolean' ? 'toggle' : kind === 'enum' ? 'select' : kind === 'string' ? 'text' : 'scrub',
		},
		write: { via: 'clip.update', patch: (v, clip) => ({ content: { style: patch(v, styleOfClip(clip)) } }) },
		...extra,
		description: extra.description ?? `${label} (Character / Paragraph settings)`,
	};
};
const field = (f: string) => (v: unknown) => ({ [f]: v });
const ot = (f: string) => (v: unknown, s: TypoStyle) => ({
	openType: { ...((s.openType as object) ?? {}), [f]: v },
});
const otGet = (f: string, d: unknown) => (s: TypoStyle) =>
	(s.openType as Record<string, unknown> | undefined)?.[f] ?? d;
/** `"wght 650, wdth 80"` ↔ `{wght: 650, wdth: 80}`. */
export function parseFontVariations(v: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	for (const part of String(v ?? '').split(',')) {
		const m = /^\s*['"]?([\x20-\x7e]{4})['"]?\s+(-?\d+(?:\.\d+)?)\s*$/.exec(part);
		if (m) out[m[1]!] = Number(m[2]);
	}
	return out;
}
export const TYPOGRAPHY_SPECS: readonly PropertySpec[] = [
	typo(
		'kerning',
		'Kerning',
		'enum',
		(s) => s.kerning ?? 'metrics',
		(v, s) => ({ kerning: v === 'manual' ? (typeof s.kerning === 'number' ? s.kerning : 0) : v }),
		{
			options: ['metrics', 'optical', 'manual'],
			optionLabels: ['Metrics', 'Optical', 'Manual'],
			defaultValue: 'metrics',
			description:
				"Kerning: the font's pairs (Metrics), from the glyph outlines (Optical) or Manual (1/1000 em before each character).",
		},
	),
	typo(
		'kerningAmount',
		'Kerning Amount',
		'number',
		(s) => (typeof s.kerning === 'number' ? s.kerning : 0),
		field('kerning'),
		{
			range: { min: -1000, max: 10000, step: 1 },
			defaultValue: 0,
			description: 'Manual kerning in 1/1000 em before each character (sets Kerning to Manual).',
		},
	),
	typo(
		'baselineShiftPx',
		'Baseline Shift',
		'number',
		(s) => s.baselineShiftPx ?? 0,
		field('baselineShiftPx'),
		{
			unit: 'px',
			range: { min: -1000, max: 1000, step: 0.1 },
			defaultValue: 0,
		},
	),
	typo('tsume', 'Tsume', 'number', (s) => s.tsume ?? 0, field('tsume'), {
		unit: '%',
		range: { min: 0, max: 100, step: 1 },
		defaultValue: 0,
	}),
	typo('fauxBold', 'Faux Bold', 'boolean', (s) => !!s.fauxBold, field('fauxBold'), { defaultValue: false }),
	typo('fauxItalic', 'Faux Italic', 'boolean', (s) => !!s.fauxItalic, field('fauxItalic'), {
		defaultValue: false,
	}),
	typo('smallCaps', 'Small Caps', 'boolean', (s) => !!s.smallCaps, field('smallCaps'), {
		defaultValue: false,
	}),
	typo('script', 'Superscript / Subscript', 'enum', (s) => s.script ?? 'normal', field('script'), {
		options: ['normal', 'superscript', 'subscript'],
		optionLabels: ['Normal', 'Superscript', 'Subscript'],
		defaultValue: 'normal',
	}),
	typo('ligatures', 'Ligatures', 'boolean', (s) => s.ligatures !== false, field('ligatures'), {
		defaultValue: true,
	}),
	typo(
		'discretionaryLigatures',
		'Discretionary Ligatures',
		'boolean',
		otGet('discretionaryLigatures', false),
		ot('discretionaryLigatures'),
		{
			defaultValue: false,
		},
	),
	typo(
		'contextualAlternates',
		'Contextual Alternates',
		'boolean',
		otGet('contextualAlternates', true),
		ot('contextualAlternates'),
		{
			defaultValue: true,
		},
	),
	typo(
		'stylisticAlternates',
		'Stylistic Alternates',
		'boolean',
		otGet('stylisticAlternates', false),
		ot('stylisticAlternates'),
		{
			defaultValue: false,
		},
	),
	typo('swash', 'Swash', 'boolean', otGet('swash', false), ot('swash'), {
		defaultValue: false,
	}),
	typo('titling', 'Titling Alternates', 'boolean', otGet('titling', false), ot('titling'), {
		defaultValue: false,
	}),
	typo('ordinals', 'Ordinals', 'boolean', otGet('ordinals', false), ot('ordinals'), {
		defaultValue: false,
	}),
	typo('fractions', 'Fractions', 'boolean', otGet('fractions', false), ot('fractions'), {
		defaultValue: false,
	}),
	typo('allSmallCaps', 'All Small Caps', 'boolean', otGet('allSmallCaps', false), ot('allSmallCaps'), {
		defaultValue: false,
	}),
	typo('figureStyle', 'Figure Style', 'enum', otGet('figureStyle', 'default'), ot('figureStyle'), {
		options: ['default', 'lining', 'oldStyle'],
		optionLabels: ['Default', 'Lining', 'Oldstyle'],
		defaultValue: 'default',
	}),
	typo('figureWidth', 'Figure Width', 'enum', otGet('figureWidth', 'default'), ot('figureWidth'), {
		options: ['default', 'proportional', 'tabular'],
		optionLabels: ['Default', 'Proportional', 'Tabular'],
		defaultValue: 'default',
	}),
	typo(
		'stylisticSets',
		'Stylistic Sets',
		'string',
		(s) => ((s.openType as { stylisticSets?: number[] } | undefined)?.stylisticSets ?? []).join(', '),
		(v, s) => ({
			openType: {
				...((s.openType as object) ?? {}),
				stylisticSets: [
					...new Set(
						String(v)
							.split(/[\s,]+/)
							.map(Number),
					),
				].filter((n) => Number.isInteger(n) && n >= 1 && n <= 20),
			},
		}),
		{ defaultValue: '', description: 'Stylistic sets on, e.g. "1, 3" (ss01, ss03).' },
	),
	typo(
		'fontVariations',
		'Variable Font Axes',
		'string',
		(s) =>
			Object.entries((s.fontVariations as Record<string, number> | undefined) ?? {})
				.map(([t, v]) => `${t} ${v}`)
				.join(', '),
		(v) => ({ fontVariations: parseFontVariations(v) }),
		{
			defaultValue: '',
			description: 'Variable font axis values, e.g. "wght 650, wdth 80" (the font must be variable).',
		},
	),
	typo('justifyLast', 'Justify Last Line', 'enum', (s) => s.justifyLast ?? 'left', field('justifyLast'), {
		options: ['left', 'center', 'right', 'justify'],
		optionLabels: ['Left', 'Center', 'Right', 'Justify All'],
		defaultValue: 'left',
	}),
	typo('indentLeftPx', 'Indent Left Margin', 'number', (s) => s.indentLeftPx ?? 0, field('indentLeftPx'), {
		unit: 'px',
		range: { min: -2000, max: 2000, step: 1 },
		defaultValue: 0,
	}),
	typo(
		'indentRightPx',
		'Indent Right Margin',
		'number',
		(s) => s.indentRightPx ?? 0,
		field('indentRightPx'),
		{
			unit: 'px',
			range: { min: -2000, max: 2000, step: 1 },
			defaultValue: 0,
		},
	),
	typo(
		'indentFirstLinePx',
		'Indent First Line',
		'number',
		(s) => s.indentFirstLinePx ?? 0,
		field('indentFirstLinePx'),
		{
			unit: 'px',
			range: { min: -2000, max: 2000, step: 1 },
			defaultValue: 0,
		},
	),
	typo(
		'spaceBeforePx',
		'Space Before Paragraph',
		'number',
		(s) => s.spaceBeforePx ?? 0,
		field('spaceBeforePx'),
		{
			unit: 'px',
			range: { min: -2000, max: 2000, step: 1 },
			defaultValue: 0,
		},
	),
	typo('spaceAfterPx', 'Space After Paragraph', 'number', (s) => s.spaceAfterPx ?? 0, field('spaceAfterPx'), {
		unit: 'px',
		range: { min: -2000, max: 2000, step: 1 },
		defaultValue: 0,
	}),
];

// spec 13 AS-030: shadow (incl. spread), background opacity and the stroke list of text clips. Each write patches the
// clip's own object (other fields and the other strokes stay); editing a shadow row turns the shadow on.
type Shadow = { color: RGBA; angleDeg: number; distancePx: number; blurPx: number; spreadPx?: number };
const shadowOf = (s: TypoStyle): Shadow =>
	(s.shadow as Shadow | null | undefined) ?? (DEFAULT_TEXT_SHADOW as Shadow);
const shadowPatch = (s: TypoStyle, fields: Partial<Shadow>) => ({ shadow: { ...shadowOf(s), ...fields } });
const backgroundOf = (s: TypoStyle) =>
	(s.background as { color: RGBA; paddingPx: number; radiusPx: number } | null | undefined) ??
	DEFAULT_TEXT_BACKGROUND;
const look = (extra: Partial<PropertySpec> & { defaultValue: unknown; description: string }) => extra;
export const TEXT_LOOK_SPECS: readonly PropertySpec[] = [
	typo(
		'shadow',
		'Shadow',
		'boolean',
		(s) => !!s.shadow,
		(v, s) => ({ shadow: v ? shadowOf(s) : null }),
		look({
			group: 'text',
			defaultValue: false,
			description: 'Drop shadow behind the text (Essential Graphics ▸ Shadow).',
		}),
	),
	typo(
		'shadowColor',
		'Shadow Color',
		'color',
		(s) => shadowOf(s).color,
		(v, s) => shadowPatch(s, { color: [...(v as RGBA)] as RGBA }),
		look({
			group: 'text',
			ui: { control: 'color' },
			defaultValue: DEFAULT_TEXT_SHADOW.color,
			description: 'Shadow colour; its alpha is the Shadow Opacity.',
		}),
	),
	typo(
		'shadowOpacity',
		'Shadow Opacity',
		'number',
		(s) => Math.round(shadowOf(s).color[3] * 1000) / 10,
		(v, s) => shadowPatch(s, { color: [...shadowOf(s).color.slice(0, 3), Number(v) / 100] as RGBA }),
		look({
			group: 'text',
			unit: '%',
			range: { min: 0, max: 100, step: 1 },
			defaultValue: 75,
			description: 'Shadow opacity in percent.',
		}),
	),
	typo(
		'shadowAngle',
		'Shadow Angle',
		'number',
		(s) => shadowOf(s).angleDeg,
		(v, s) => shadowPatch(s, { angleDeg: Number(v) }),
		look({
			group: 'text',
			unit: 'deg',
			range: { min: -36000, max: 36000, step: 1 },
			defaultValue: 135,
			description: 'Direction the shadow falls in, degrees.',
		}),
	),
	typo(
		'shadowDistance',
		'Shadow Distance',
		'number',
		(s) => shadowOf(s).distancePx,
		(v, s) => shadowPatch(s, { distancePx: Number(v) }),
		look({
			group: 'text',
			unit: 'px',
			range: { min: 0, max: 10000, softMax: 200, step: 0.5 },
			defaultValue: 7,
			description: 'How far the shadow is offset, pixels.',
		}),
	),
	typo(
		'shadowBlur',
		'Shadow Blur',
		'number',
		(s) => shadowOf(s).blurPx,
		(v, s) => shadowPatch(s, { blurPx: Number(v) }),
		look({
			group: 'text',
			unit: 'px',
			range: { min: 0, max: 1000, softMax: 200, step: 0.5 },
			defaultValue: 10,
			description: 'Softness of the shadow edge, pixels.',
		}),
	),
	typo(
		'shadowSpread',
		'Shadow Spread',
		'number',
		(s) => shadowOf(s).spreadPx ?? 0,
		(v, s) => shadowPatch(s, { spreadPx: Number(v) }),
		look({
			group: 'text',
			unit: 'px',
			range: { min: 0, max: 1000, softMax: 100, step: 0.5 },
			defaultValue: 0,
			description: 'How far the shadow grows beyond the glyphs before it is blurred, pixels.',
		}),
	),
	typo(
		'background',
		'Background',
		'boolean',
		(s) => !!s.background,
		(v, s) => ({ background: v ? backgroundOf(s) : null }),
		look({ group: 'box', defaultValue: false, description: 'Box behind the text.' }),
	),
	typo(
		'backgroundOpacity',
		'Background Opacity',
		'number',
		(s) => Math.round(backgroundOf(s).color[3] * 1000) / 10,
		(v, s) => {
			const bg = backgroundOf(s);
			return { background: { ...bg, color: [...bg.color.slice(0, 3), Number(v) / 100] } };
		},
		look({
			group: 'box',
			unit: '%',
			range: { min: 0, max: 100, step: 1 },
			defaultValue: 60,
			description: 'Opacity of the box behind the text, percent.',
		}),
	),
];

/**
 * Display templates of the dynamic stroke rows and of the stroke list's History steps (UI-6 model strings: the editor
 * translates "Stroke 2 Width" through "Stroke {0} Width").
 */
export const TEXT_STROKE_MODEL_STRINGS = [
	'Stroke {0} Width',
	'Stroke {0} Color',
	'Stroke {0} Position',
	'Add Stroke',
	'Remove Stroke {0}',
] as const;

/** Stroke list rows: `text.stroke.<i>.width | color | position` (spec 13 AS-030; every stroke, not only the first). */
export const TEXT_STROKE_KEY = /^text\.stroke\.(\d{1,2})\.(width|color|position)$/;
const strokeSpecCache = new Map<string, PropertySpec>();
export function textStrokePropertySpec(key: string): PropertySpec | undefined {
	const m = TEXT_STROKE_KEY.exec(key);
	if (!m) return undefined;
	const index = Number(m[1]);
	if (index >= MAX_TEXT_STROKES) return undefined;
	const hit = strokeSpecCache.get(key);
	if (hit) return hit;
	const field = m[2] as 'width' | 'color' | 'position';
	type Stroke = { color: RGBA; widthPx: number; position: 'outside' | 'center' | 'inside' };
	const list = (s: TypoStyle) => (Array.isArray(s.strokes) ? (s.strokes as Stroke[]) : []);
	const at = (s: TypoStyle): Stroke => list(s)[index] ?? (DEFAULT_TEXT_STROKE as Stroke);
	const write = (s: TypoStyle, fields: Partial<Stroke>) => {
		const next = [...list(s)];
		if (index < next.length) next[index] = { ...next[index]!, ...fields };
		else next.push({ ...(DEFAULT_TEXT_STROKE as Stroke), ...fields });
		return { strokes: next };
	};
	const n = index + 1;
	const short = `stroke.${index}.${field}`;
	const spec =
		field === 'width'
			? typo(
					short,
					`Stroke ${n} Width`,
					'number',
					(s) => at(s).widthPx,
					(v, s) => write(s, { widthPx: Number(v) }),
					{
						group: 'text',
						unit: 'px',
						range: { min: 0, max: 1000, softMax: 100, step: 0.5 },
						defaultValue: DEFAULT_TEXT_STROKE.widthPx,
						description: `Width of stroke ${n}, pixels.`,
					},
				)
			: field === 'color'
				? typo(
						short,
						`Stroke ${n} Color`,
						'color',
						(s) => at(s).color,
						(v, s) => write(s, { color: v as RGBA }),
						{
							group: 'text',
							ui: { control: 'color' },
							defaultValue: DEFAULT_TEXT_STROKE.color,
							description: `Colour of stroke ${n}.`,
						},
					)
				: typo(
						short,
						`Stroke ${n} Position`,
						'enum',
						(s) => at(s).position,
						(v, s) => write(s, { position: v as Stroke['position'] }),
						{
							group: 'text',
							options: ['outside', 'center', 'inside'],
							optionLabels: ['Outside', 'Center', 'Inside'],
							defaultValue: 'outside',
							description: `Where stroke ${n} sits on the glyph outline.`,
						},
					);
	strokeSpecCache.set(key, spec);
	return spec;
}

export const PROPERTY_SPECS: readonly PropertySpec[] = [
	{
		key: 'transform.position',
		label: 'Position',
		group: 'motion',
		kind: 'vec2',
		unit: 'px',
		range: { step: 0.1 },
		animatable: 'continuous',
		storagePath: ['transform', 'position'],
		// S03:KF-021: new position keys are Auto Bezier spatial with Linear temporal (Premiere's default feel).
		spatial: 'auto-bezier',
		appliesTo: hasTransform,
		ui: { control: 'vec2', precision: 1 },
		defaultValue: ({ seq }: PropertyContext) => [seq.settings.width / 2, seq.settings.height / 2],
		description: 'Where the anchor point lands in the frame (sequence pixels).',
	},
	{
		key: 'transform.anchor',
		label: 'Anchor Point',
		group: 'motion',
		kind: 'vec2',
		unit: 'px',
		range: { step: 0.1 },
		animatable: 'continuous',
		storagePath: ['transform', 'anchor'],
		spatial: 'auto-bezier',
		appliesTo: hasTransform,
		ui: { control: 'vec2', precision: 1 },
		defaultValue: (ctx: PropertyContext) => {
			const b = intrinsicBoxOf(ctx);
			return [b.width / 2, b.height / 2];
		},
		description: 'Pivot of scale and rotation in layer pixels.',
	},
	{
		key: 'transform.scale',
		label: 'Scale',
		group: 'motion',
		kind: 'number',
		unit: '%',
		range: { min: 0, max: 10000, softMax: 400, step: 0.1 },
		animatable: 'continuous',
		storagePath: ['transform', 'scale'],
		appliesTo: hasTransform,
		ui: { control: 'scrub', precision: 1 },
		defaultValue: 100,
	},
	{
		key: 'transform.scaleWidth',
		label: 'Scale Width',
		group: 'motion',
		kind: 'number',
		unit: '%',
		range: { min: 0, max: 10000, softMax: 400, step: 0.1 },
		animatable: 'continuous',
		storagePath: ['transform', 'scaleWidth'],
		appliesTo: hasTransform,
		ui: { control: 'scrub', precision: 1 },
		defaultValue: 100,
		description: 'Horizontal scale, used when Uniform Scale is off.',
	},
	{
		key: 'transform.uniformScale',
		label: 'Uniform Scale',
		group: 'motion',
		kind: 'boolean',
		animatable: 'no',
		storagePath: ['transform', 'uniformScale'],
		appliesTo: hasTransform,
		ui: { control: 'toggle' },
		defaultValue: true,
	},
	{
		key: 'transform.rotation',
		label: 'Rotation',
		group: 'motion',
		kind: 'number',
		unit: 'deg',
		range: { step: 0.1 },
		animatable: 'continuous',
		storagePath: ['transform', 'rotation'],
		appliesTo: hasTransform,
		ui: { control: 'angle', precision: 1 },
		defaultValue: 0,
	},
	{
		key: 'transform.flipH',
		label: 'Flip Horizontal',
		group: 'motion',
		kind: 'boolean',
		animatable: 'no',
		storagePath: ['transform', 'flipH'],
		appliesTo: hasTransform,
		ui: { control: 'toggle' },
		defaultValue: false,
	},
	{
		key: 'transform.flipV',
		label: 'Flip Vertical',
		group: 'motion',
		kind: 'boolean',
		animatable: 'no',
		storagePath: ['transform', 'flipV'],
		appliesTo: hasTransform,
		ui: { control: 'toggle' },
		defaultValue: false,
	},
	{
		key: 'opacity',
		label: 'Opacity',
		group: 'opacity',
		kind: 'number',
		unit: '%',
		range: { min: 0, max: 100, step: 0.1 },
		animatable: 'continuous',
		storagePath: ['opacity'],
		appliesTo: hasOpacity,
		ui: { control: 'slider', precision: 1 },
		defaultValue: 100,
	},
	{
		key: 'blendMode',
		label: 'Blend Mode',
		group: 'opacity',
		kind: 'enum',
		options: BLEND_MODES,
		optionLabels: BLEND_MODE_LABELS,
		optionGroups: BLEND_MODE_GROUPS,
		animatable: 'no',
		storagePath: ['blendMode'],
		appliesTo: (c) => hasOpacity(c) && c.kind !== 'captions',
		ui: { control: 'select' },
		defaultValue: 'normal',
	},
	{
		key: 'gainDb',
		label: 'Gain',
		group: 'audio',
		kind: 'number',
		unit: 'dB',
		range: { min: -96, max: 96, step: 0.1 },
		animatable: 'no',
		storagePath: ['gainDb'],
		appliesTo: isAudio,
		ui: { control: 'scrub', bipolar: true, precision: 1 },
		defaultValue: 0,
		description: 'Clip gain before effects (not keyframable).',
	},
	{
		key: 'volumeDb',
		label: 'Level',
		group: 'audio',
		kind: 'number',
		unit: 'dB',
		range: { min: -96, max: 15, step: 0.1 },
		animatable: 'continuous',
		storagePath: ['volumeDb'],
		appliesTo: isAudio,
		ui: { control: 'scrub', bipolar: true, precision: 1 },
		defaultValue: 0,
	},
	{
		key: 'pan',
		label: 'Pan',
		group: 'audio',
		kind: 'number',
		range: { min: -100, max: 100, step: 1 },
		animatable: 'continuous',
		storagePath: ['pan'],
		appliesTo: isAudio,
		ui: { control: 'scrub', bipolar: true, precision: 0 },
		defaultValue: 0,
		description: 'Balance, −100 = left, +100 = right.',
	},
	{
		key: 'text.content',
		label: 'Text',
		group: 'text',
		kind: 'string',
		animatable: 'no',
		storagePath: ['content', 'text'],
		appliesTo: isText,
		ui: { control: 'text', multiline: true },
		write: { via: 'clip.update', patch: (v) => ({ content: { text: v } }) },
	},
	{
		key: 'text.fontId',
		label: 'Font',
		group: 'text',
		kind: 'string',
		animatable: 'no',
		storagePath: ['content', 'style', 'fontId'],
		appliesTo: isText,
		ui: { control: 'select' },
		write: styleWrite('fontId'),
	},
	{
		key: 'text.weight',
		label: 'Weight',
		group: 'text',
		kind: 'number',
		range: { min: 100, max: 900, step: 100 },
		animatable: 'no',
		storagePath: ['content', 'style', 'weight'],
		appliesTo: isText,
		ui: { control: 'select', precision: 0 },
		defaultValue: 400,
		write: styleWrite('weight'),
	},
	{
		key: 'text.italic',
		label: 'Italic',
		group: 'text',
		kind: 'boolean',
		animatable: 'no',
		storagePath: ['content', 'style', 'italic'],
		appliesTo: isText,
		ui: { control: 'toggle' },
		defaultValue: false,
		write: styleWrite('italic'),
	},
	{
		key: 'text.sizePx',
		label: 'Font Size',
		group: 'text',
		kind: 'number',
		unit: 'px',
		range: { min: 1, max: 2000, softMax: 400, step: 1 },
		animatable: 'no',
		storagePath: ['content', 'style', 'sizePx'],
		appliesTo: isText,
		ui: { control: 'scrub', precision: 0 },
		defaultValue: 100,
		write: styleWrite('sizePx'),
		description: 'Layout-affecting, so hold-only; animate Motion › Scale to animate size (S03:TXT-007).',
	},
	{
		key: 'text.lineHeight',
		label: 'Leading',
		group: 'text',
		kind: 'number',
		range: { min: 0.1, max: 10, step: 0.05 },
		animatable: 'no',
		storagePath: ['content', 'style', 'lineHeight'],
		appliesTo: isText,
		ui: { control: 'scrub', precision: 2 },
		defaultValue: 1.2,
		write: styleWrite('lineHeight'),
	},
	{
		key: 'text.trackingEm',
		label: 'Tracking',
		group: 'text',
		kind: 'number',
		range: { min: -1000, max: 1000, step: 1 },
		animatable: 'no',
		storagePath: ['content', 'style', 'trackingEm'],
		appliesTo: isText,
		ui: { control: 'scrub', precision: 0 },
		defaultValue: 0,
		write: styleWrite('trackingEm'),
	},
	{
		key: 'text.align',
		label: 'Align',
		group: 'text',
		kind: 'enum',
		options: ['left', 'center', 'right', 'justify'],
		optionLabels: ['Left', 'Center', 'Right', 'Justify'],
		animatable: 'no',
		storagePath: ['content', 'style', 'align'],
		appliesTo: isText,
		ui: { control: 'select' },
		defaultValue: 'center',
		write: styleWrite('align'),
	},
	{
		key: 'text.fill',
		label: 'Fill',
		group: 'text',
		kind: 'color',
		animatable: 'no',
		storagePath: ['content', 'style', 'fill'],
		appliesTo: isText,
		ui: { control: 'color' },
		defaultValue: WHITE,
		write: styleWrite('fill'),
	},
	{
		key: 'text.strokeWidth',
		label: 'Stroke Width',
		group: 'text',
		kind: 'number',
		unit: 'px',
		range: { min: 0, max: 200, step: 0.5 },
		animatable: 'no',
		storagePath: ['content', 'style', 'strokes', '0', 'widthPx'],
		appliesTo: isText,
		ui: { control: 'scrub', precision: 1 },
		defaultValue: 0,
		write: {
			via: 'clip.update',
			patch: (v, clip) => {
				const cur = firstStroke(clip);
				const rest = otherStrokes(clip);
				const w = Number(v);
				// spec 13 SH-004: the other strokes stay; 0 removes the only stroke, or hides the first of several.
				return {
					content: {
						style: {
							strokes:
								w > 0
									? [{ ...cur, widthPx: w }, ...rest]
									: rest.length
										? [{ ...cur, widthPx: 0 }, ...rest]
										: [],
						},
					},
				};
			},
		},
		description: 'Width of the first stroke (0 = none; the other strokes keep theirs).',
	},
	{
		key: 'text.strokeColor',
		label: 'Stroke Color',
		group: 'text',
		kind: 'color',
		animatable: 'no',
		storagePath: ['content', 'style', 'strokes', '0', 'color'],
		appliesTo: isText,
		ui: { control: 'color' },
		defaultValue: BLACK,
		write: {
			via: 'clip.update',
			patch: (v, clip) => {
				const cur = firstStroke(clip);
				return {
					content: {
						style: {
							strokes: [
								{ ...cur, widthPx: cur.widthPx > 0 ? cur.widthPx : 4, color: v },
								...otherStrokes(clip),
							],
						},
					},
				};
			},
		},
	},
	{
		key: 'text.backgroundColor',
		label: 'Background',
		group: 'box',
		kind: 'color',
		animatable: 'no',
		storagePath: ['content', 'style', 'background', 'color'],
		appliesTo: isText,
		ui: { control: 'color' },
		defaultValue: [0, 0, 0, 0],
		write: {
			via: 'clip.update',
			patch: (v, clip) => {
				const bg = textStyleOf(clip)?.background ?? null;
				const color = v as RGBA;
				return {
					content: {
						style: {
							background:
								color[3] === 0 ? null : { paddingPx: 16, radiusPx: 0, ...(bg ?? {}), color: [...color] },
						},
					},
				};
			},
		},
		description: 'Box behind the text (alpha 0 removes it).',
	},
	{
		key: 'text.backgroundPadding',
		label: 'Box Padding',
		group: 'box',
		kind: 'number',
		unit: 'px',
		range: { min: 0, max: 500, step: 1 },
		animatable: 'no',
		storagePath: ['content', 'style', 'background', 'paddingPx'],
		appliesTo: isText,
		ui: { control: 'scrub', precision: 0 },
		defaultValue: 16,
		write: {
			via: 'clip.update',
			patch: (v, clip) => {
				const bg = textStyleOf(clip)?.background ?? null;
				return {
					content: {
						style: {
							background: { color: [0, 0, 0, 0.6], radiusPx: 0, ...(bg ?? {}), paddingPx: Number(v) },
						},
					},
				};
			},
		},
	},
	{
		key: 'text.backgroundRadius',
		label: 'Box Radius',
		group: 'box',
		kind: 'number',
		unit: 'px',
		range: { min: 0, max: 500, step: 1 },
		animatable: 'no',
		storagePath: ['content', 'style', 'background', 'radiusPx'],
		appliesTo: isText,
		ui: { control: 'scrub', precision: 0 },
		defaultValue: 0,
		write: {
			via: 'clip.update',
			patch: (v, clip) => {
				const bg = textStyleOf(clip)?.background ?? null;
				return {
					content: {
						style: {
							background: { color: [0, 0, 0, 0.6], paddingPx: 16, ...(bg ?? {}), radiusPx: Number(v) },
						},
					},
				};
			},
		},
	},
	{
		key: 'text.boxWidth',
		label: 'Box Width',
		group: 'box',
		kind: 'number',
		unit: 'px',
		range: { min: 0, max: 16384, step: 1 },
		animatable: 'no',
		storagePath: ['box', 'width'],
		appliesTo: isText,
		ui: { control: 'scrub', precision: 0 },
		write: { via: 'clip.update', patch: (v) => ({ box: { width: v } }) },
	},
	{
		key: 'text.boxHeight',
		label: 'Box Height',
		group: 'box',
		kind: 'number',
		unit: 'px',
		range: { min: 0, max: 16384, step: 1 },
		animatable: 'no',
		storagePath: ['box', 'height'],
		appliesTo: isText,
		ui: { control: 'scrub', precision: 0 },
		write: { via: 'clip.update', patch: (v) => ({ box: { height: v } }) },
	},
	{
		key: 'text.autoSize',
		label: 'Auto Size',
		group: 'box',
		kind: 'enum',
		options: ['none', 'width', 'height'],
		optionLabels: ['Fixed', 'Grow Width', 'Grow Height'],
		animatable: 'no',
		storagePath: ['box', 'autoSize'],
		appliesTo: isText,
		ui: { control: 'select' },
		write: { via: 'clip.update', patch: (v) => ({ box: { autoSize: v } }) },
	},
	{
		key: 'text.allCaps',
		label: 'All Caps',
		group: 'text',
		kind: 'boolean',
		animatable: 'no',
		storagePath: ['content', 'style', 'allCaps'],
		appliesTo: isText,
		ui: { control: 'toggle' },
		defaultValue: false,
		write: styleWrite('allCaps'),
	},
	// Character and Paragraph settings (AE Character / Paragraph panels).
	...TYPOGRAPHY_SPECS,
	...TEXT_LOOK_SPECS,
	{
		key: 'solid.color',
		label: 'Color',
		group: 'solid',
		kind: 'color',
		animatable: 'no',
		storagePath: ['$synthetic', 'color'],
		appliesTo: (c) => c.kind === 'solid',
		ui: { control: 'color' },
		defaultValue: WHITE,
	},
	// M2 (S11:TXA-007, wp-m2-text-anim): preset + window of each side; params are dynamic (below).
	...TEXT_ANIMATION_SIDES.flatMap(textAnimationSideSpecs),

	...SHAPE_PROPERTY_SPECS,

	// three-d: 3D layers, cameras, lights.
	...THREE_D_PROPERTY_SPECS,
];

function textStyleOf(clip: Clip) {
	return clip.kind === 'text' ? clip.content.style : null;
}
function firstStroke(clip: Clip): {
	color: RGBA;
	widthPx: number;
	position: 'outside' | 'center' | 'inside';
} {
	const s = textStyleOf(clip)?.strokes[0];
	return s
		? { color: [...s.color] as RGBA, widthPx: s.widthPx, position: s.position }
		: { color: [...BLACK] as RGBA, widthPx: 0, position: 'outside' };
}

/** The strokes after the first (kept by the first stroke's rows). */
function otherStrokes(clip: Clip): TextStyle['strokes'] {
	return (textStyleOf(clip)?.strokes ?? []).slice(1).map((s) => ({ ...s, color: [...s.color] as RGBA }));
}

const BY_KEY = new Map(PROPERTY_SPECS.map((s) => [s.key, s]));

export function getPropertySpec(key: string): PropertySpec | undefined {
	return BY_KEY.get(key);
}

const SAFE_INT = 2 ** 53 - 1;
const humanize = (name: string) =>
	name
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/^./, (c) => c.toUpperCase());

export type JsonSchemaSpecOptions = {
	/** Key prefix and storage root, e.g. `params` / `['params']`, `props` / `['props']`. */
	keyPrefix: string;
	storageRoot: readonly string[];
	group: PropertyGroup;
	appliesTo(clip: Pick<Clip, 'kind'>): boolean;
	/** Default values by the same structure as the value (template defaults, composition defaultProps). */
	defaults?: Record<string, unknown>;
	/** Recurse into nested objects with `properties` (one spec per leaf, dotted keys). Default true. */
	nested?: boolean;
	/** Arrays of exactly 4 / 2 numbers become `color` (RGBA 0..1) / `vec2` kinds (M1 template params). */
	tuples?: boolean;
	/** UI hints by dotted path relative to the root (manifest `ui`, inferred colour/textarea hints). */
	ui?: Record<string, PropsUiHint | undefined>;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);

/** `anyOf`/`oneOf` of one schema plus `null` (zod `.nullable()`) → that schema; otherwise the input. */
function unwrapNullable(root: JsonSchema, s: JsonSchema): JsonSchema {
	for (const key of ['anyOf', 'oneOf'] as const) {
		const list = s[key];
		if (!Array.isArray(list)) continue;
		const rest = list
			.map((x) => derefSchema(root, x as JsonSchema))
			.filter((x) => !(isRecord(x) && x.type === 'null'));
		if (rest.length === 1 && isRecord(rest[0])) {
			const { [key]: _drop, ...others } = s;
			return { ...others, ...rest[0] };
		}
	}
	return s;
}

/** Literal-only unions (`anyOf: [{const: 'a'}, …]`) and `enum` → option strings. */
function literalOptions(root: JsonSchema, s: JsonSchema): string[] | null {
	if (Array.isArray(s.enum)) return (s.enum as unknown[]).map(String);
	for (const key of ['anyOf', 'oneOf'] as const) {
		const list = s[key];
		if (!Array.isArray(list) || list.length === 0) continue;
		const out: string[] = [];
		for (const x of list) {
			const d = derefSchema(root, x as JsonSchema);
			if (isRecord(d) && 'const' in d && typeof d.const === 'string') out.push(d.const);
			else if (isRecord(d) && Array.isArray(d.enum) && d.enum.every((e) => typeof e === 'string'))
				out.push(...(d.enum as string[]));
			else return null;
		}
		return out;
	}
	return null;
}

/**
 * Generic JSON Schema → property specs (S08:MGU-003, generalising the M1 `params.*` specs): one spec per leaf
 * property (nested objects recurse into dotted keys), with kinds number / boolean / enum / string / json (arrays,
 * free-form objects), ranges from `minimum`/`maximum`, labels from `title` (else the humanized name),
 * descriptions, defaults and UI hints. Every spec is static (`animatable: 'no'`, S08:MGC-006) and written with
 * `param.set` on `[…storageRoot, …path]`.
 */
export function jsonSchemaPropertySpecs(
	schema: JsonSchemaObject | null | undefined,
	o: JsonSchemaSpecOptions,
): PropertySpec[] {
	if (!schema) return [];
	const root = schema as JsonSchema;
	const out: PropertySpec[] = [];
	const nested = o.nested ?? true;
	const numBound = (v: unknown) => (typeof v === 'number' && Math.abs(v) < SAFE_INT ? v : undefined);
	const leaf = (name: string, path: string[], s0: JsonSchema, dflt: unknown) => {
		const s = unwrapNullable(root, s0);
		const hint = o.ui?.[path.join('.')];
		// Template media params (`mediaParam()`: `{mediaId} | null` with `x-jasper-kind: "media"`): the media picker.
		const mediaKinds = templateMediaKindsOf(s0) ?? templateMediaKindsOf(s);
		// A media param whose value can also be another shape (the social-comment avatar `{mediaId} | {generated} |
		// null`) is a JSON value validated whole by the template schema; it keeps its media kinds for its control.
		const mixedMedia = mediaKinds !== null && isMixedMediaUnion(root, s);
		if (mediaKinds && !mixedMedia) {
			out.push({
				key: [o.keyPrefix, ...path].join('.'),
				label:
					typeof hint?.label === 'string'
						? hint.label
						: typeof s.title === 'string'
							? s.title
							: humanize(name),
				group: o.group,
				kind: 'media',
				animatable: 'no',
				storagePath: [...o.storageRoot, ...path],
				appliesTo: o.appliesTo,
				ui: { control: 'media' },
				defaultValue: dflt !== undefined ? dflt : (s0.default ?? s.default ?? null),
				description: typeof s.description === 'string' ? s.description : undefined,
				valueSchema: s0,
				mediaKinds,
				mediaNullable: true,
			});
			return;
		}
		let kind: ValueKind = 'string';
		let options: readonly string[] | undefined;
		const enumOpts = literalOptions(root, s);
		const t = Array.isArray(s.type) ? (s.type as string[]).find((x) => x !== 'null') : s.type;
		if (enumOpts) {
			kind = 'enum';
			options = enumOpts;
		} else if (t === 'number' || t === 'integer') kind = 'number';
		else if (t === 'boolean') kind = 'boolean';
		else if (t === 'string') kind = 'string';
		else if (o.tuples && t === 'array' && s.minItems === 4 && s.maxItems === 4) kind = 'color';
		else if (o.tuples && t === 'array' && s.minItems === 2 && s.maxItems === 2) kind = 'vec2';
		// WP7a: an object or a union of shapes (e.g. the social-comment avatar `{mediaId} | {generated} | null`) is a
		// JSON value validated whole by the template schema (as a string it could never be written).
		else if (t === 'object' || (t === undefined && (Array.isArray(s.anyOf) || Array.isArray(s.oneOf))))
			kind = 'json';
		else kind = o.tuples ? 'string' : 'json';
		if (hint?.control === 'json') kind = 'json';
		const integer = t === 'integer';
		const min = numBound(s.minimum) ?? (typeof hint?.min === 'number' ? hint.min : undefined);
		const max = numBound(s.maximum) ?? (typeof hint?.max === 'number' ? hint.max : undefined);
		const control: PropertySpec['ui']['control'] =
			kind === 'json'
				? 'json'
				: kind === 'number'
					? hint?.control === 'slider' && min !== undefined && max !== undefined
						? 'slider'
						: 'scrub'
					: kind === 'boolean'
						? 'toggle'
						: kind === 'enum'
							? 'select'
							: kind === 'color'
								? 'color'
								: kind === 'vec2'
									? 'vec2'
									: hint?.control === 'color'
										? 'color'
										: 'text';
		out.push({
			key: [o.keyPrefix, ...path].join('.'),
			label:
				typeof hint?.label === 'string' ? hint.label : typeof s.title === 'string' ? s.title : humanize(name),
			group: o.group,
			kind,
			options,
			range:
				kind === 'number'
					? { min, max, step: integer ? 1 : typeof hint?.step === 'number' ? hint.step : undefined }
					: undefined,
			animatable: 'no',
			storagePath: [...o.storageRoot, ...path],
			appliesTo: o.appliesTo,
			ui: {
				control,
				precision: integer ? 0 : undefined,
				multiline:
					kind === 'string' &&
					(hint?.control === 'textarea' || (typeof s.maxLength === 'number' && s.maxLength > 120)),
			},
			defaultValue: dflt !== undefined ? dflt : s.default,
			description: typeof s.description === 'string' ? s.description : undefined,
			valueSchema: s,
			...(mixedMedia && mediaKinds ? { mediaKinds, mediaNullable: true } : {}),
		});
	};
	const walk = (s0: JsonSchema | boolean | undefined, path: string[], dflt: unknown, depth: number) => {
		const s = derefSchema(root, s0);
		if (!isRecord(s) || depth > 12) return;
		for (const [name, sub0] of Object.entries(isRecord(s.properties) ? s.properties : {})) {
			const sub = derefSchema(root, sub0 as JsonSchema);
			if (!isRecord(sub)) continue;
			const d = isRecord(dflt) ? dflt[name] : undefined;
			const u = unwrapNullable(root, sub);
			if (nested && isRecord(u.properties) && Object.keys(u.properties).length > 0 && u.type !== 'array')
				walk(u, [...path, name], d, depth + 1);
			else leaf(name, [...path, name], sub, d);
		}
	};
	walk(root, [], o.defaults, 0);
	return out;
}

/** Whether a template media param node is a union with members other than `{mediaId}` objects and `null`. */
function isMixedMediaUnion(root: JsonSchema, s: JsonSchema): boolean {
	const members = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null;
	if (!members) return false;
	return members.some((m0) => {
		const m = derefSchema(root, m0 as JsonSchema);
		if (!isRecord(m)) return true;
		if (m.type === 'null') return false;
		const props = isRecord(m.properties) ? Object.keys(m.properties) : [];
		return !(props.length === 1 && props[0] === 'mediaId');
	});
}

/** The media kinds of a template media param schema node (`x-jasper-kind: "media"`), else null. */
function templateMediaKindsOf(s: JsonSchema | undefined): string[] | null {
	if (!isRecord(s) || s[TEMPLATE_PARAM_KIND_KEY] !== TEMPLATE_MEDIA_KIND) return null;
	const kinds = s[TEMPLATE_MEDIA_KINDS_KEY];
	return Array.isArray(kinds) ? kinds.filter((k): k is string => typeof k === 'string') : [];
}

const templateJsonCache = new WeakMap<object, JsonSchema | null>();
function templateJson(template: Pick<MgTemplateInfo, 'paramsSchema'>): JsonSchema | null {
	const key = template.paramsSchema as object;
	if (templateJsonCache.has(key)) return templateJsonCache.get(key)!;
	let json: JsonSchema | null = null;
	try {
		json = z.toJSONSchema(template.paramsSchema, { unrepresentable: 'any', io: 'input' }) as JsonSchema;
	} catch {
		json = null;
	}
	templateJsonCache.set(key, json);
	return json;
}

/**
 * The media kinds the template param at `path` (inside `params`, e.g. `['avatar']` or `['gallery', '0']`) takes,
 * when the schema declares it a media param (`mediaParam()`); null when it does not (or the path is not in the
 * schema). An empty list means "any kind".
 */
export function templateMediaKindsAt(
	template: Pick<MgTemplateInfo, 'paramsSchema'>,
	path: readonly string[],
): string[] | null {
	const root = templateJson(template);
	if (!root) return null;
	let cur: JsonSchema | undefined = root;
	for (const key of path) {
		const s = derefSchema(root, cur);
		if (!isRecord(s)) return null;
		const branches = [
			s,
			...(['anyOf', 'oneOf', 'allOf'] as const).flatMap((k) => (Array.isArray(s[k]) ? s[k] : [])),
		]
			.map((b) => derefSchema(root, b as JsonSchema))
			.filter(isRecord);
		let next: JsonSchema | undefined;
		for (const b of branches) {
			if (/^\d+$/.test(key) && isRecord(b.items)) next = b.items as JsonSchema;
			else if (/^\d+$/.test(key) && Array.isArray(b.prefixItems))
				next = b.prefixItems[Number(key)] as JsonSchema;
			else if (isRecord(b.properties) && isRecord(b.properties[key])) next = b.properties[key] as JsonSchema;
			else if (isRecord(b.additionalProperties)) next = b.additionalProperties as JsonSchema;
			if (next) break;
		}
		if (!next) return null;
		cur = next;
	}
	const node = derefSchema(root, cur);
	return isRecord(node) ? templateMediaKindsOf(node) : null;
}

/** Specs for a motion-graphic clip's `params.<name>` from the template's params schema. */
export function paramsPropertySpecs(template: MgTemplateInfo): PropertySpec[] {
	let json: JsonSchemaObject;
	try {
		json = z.toJSONSchema(template.paramsSchema, { unrepresentable: 'any', io: 'input' }) as JsonSchemaObject;
	} catch {
		return [];
	}
	const specs = jsonSchemaPropertySpecs(json, {
		keyPrefix: 'params',
		storageRoot: ['params'],
		group: 'params',
		appliesTo: (c) => c.kind === 'motion-graphic',
		defaults: template.defaults,
		nested: false,
		tuples: true,
	}).map(({ valueSchema: _v, ...s }) =>
		// wp-m2-anime-templates (S11:ATP-006): numeric/colour params of anime templates are keyframable.
		isKeyframableTemplateParam(template, s) ? { ...s, animatable: 'continuous' as const } : s,
	);
	return applyTemplateUi(template.ui, specs);
}

const paramNameOf = (s: Pick<PropertySpec, 'key'>) => s.key.slice('params.'.length);

/**
 * A template's `ui` hints on its param specs: labels, tooltips, multi-line text, visibility and custom controls per
 * param, then the order of `ui.groups` (params in no group first, in schema order; then each group's params in the
 * group's order, tagged with `section`). Names the template does not have are ignored (the registry rejects them).
 */
function applyTemplateUi(ui: MgTemplateUi | undefined, specs: PropertySpec[]): PropertySpec[] {
	if (!ui) return specs;
	const hinted = specs.map((s): PropertySpec => {
		const h = ui.params?.[paramNameOf(s)];
		if (!h) return s;
		return {
			...s,
			...(h.label ? { label: h.label } : {}),
			...(h.description ? { description: h.description } : {}),
			...(h.visibleWhen ? { visibleWhen: { param: h.visibleWhen.param, in: [...h.visibleWhen.in] } } : {}),
			...(h.options && s.options
				? { optionLabels: s.options.map((o, i) => h.options?.[o] ?? s.optionLabels?.[i] ?? o) }
				: {}),
			ui: {
				...s.ui,
				...(h.multiline !== undefined && s.kind === 'string' ? { multiline: h.multiline } : {}),
				...(h.control ? { customControl: h.control } : {}),
			},
		};
	});
	if (!ui.groups?.length) return hinted;
	const byName = new Map(hinted.map((s) => [paramNameOf(s), s]));
	const grouped: PropertySpec[] = [];
	const taken = new Set<string>();
	for (const g of ui.groups) {
		for (const name of g.params) {
			const s = byName.get(name);
			if (!s || taken.has(name)) continue;
			taken.add(name);
			grouped.push({ ...s, section: { id: g.id, label: g.label } });
		}
	}
	return [...hinted.filter((s) => !taken.has(paramNameOf(s))), ...grouped];
}

function sameParamValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

/** Whether a template param row is shown for a clip's `params` (its `visibleWhen`; true without one). */
export function templateParamVisible(
	spec: Pick<PropertySpec, 'visibleWhen'>,
	params: Readonly<Record<string, unknown>> | undefined,
): boolean {
	const w = spec.visibleWhen;
	if (!w) return true;
	const v = params?.[w.param];
	return w.in.some((x) => sameParamValue(x, v));
}

/** A run of template param specs sharing a `section` (null = the params in no group). */
export type TemplateParamSection = { section: { id: string; label: string } | null; specs: PropertySpec[] };

/** Splits template param specs (as `paramsPropertySpecs` orders them) into their sections, in order. */
export function templateParamSections(specs: readonly PropertySpec[]): TemplateParamSection[] {
	const out: TemplateParamSection[] = [];
	for (const s of specs) {
		const last = out.at(-1);
		const id = s.section?.id ?? null;
		if (last && (last.section?.id ?? null) === id) last.specs.push(s);
		else out.push({ section: s.section ?? null, specs: [s] });
	}
	return out;
}

// Storage: the static value stays in `clip.params[name]` (validated by the template schema, read by every M1
// consumer); keyframes live in `clip.paramKeyframes[name]` (content time, flicks). fframes template params stay
// static: their masters are rendered by `jasper-mg` from the params alone.

/** Numeric (non-integer) and colour params of anime templates may carry keyframes. */
export function isKeyframableTemplateParam(
	template: Pick<MgTemplateInfo, 'renderer'>,
	s: Pick<PropertySpec, 'kind' | 'ui'>,
): boolean {
	return (
		template.renderer === 'anime' && (s.kind === 'color' || (s.kind === 'number' && s.ui.precision !== 0))
	);
}

type MgParamFields = {
	params?: Record<string, unknown>;
	paramKeyframes?: Record<string, Keyframe<unknown>[]>;
};

/** Names of the params of a motion-graphic clip that carry at least one keyframe. */
export function animatedTemplateParams(clip: Pick<Clip, 'kind'>): string[] {
	const kf = (clip as MgParamFields).paramKeyframes ?? {};
	return Object.keys(kf).filter((k) => (kf[k]?.length ?? 0) > 0);
}

const templateRanges = new WeakMap<object, Map<string, PropertySpec>>();
function keyframableSpecs(template: MgTemplateInfo): Map<string, PropertySpec> {
	let m = templateRanges.get(template.paramsSchema);
	if (!m) {
		m = new Map(
			paramsPropertySpecs(template)
				.filter((s) => s.animatable !== 'no')
				.map((s) => [s.key.slice('params.'.length), s]),
		);
		templateRanges.set(template.paramsSchema, m);
	}
	return m;
}

/**
 * Params of an anime template at content time `t` (flicks): every keyframed param evaluated with the shared
 * evaluator (S01:KF-009) and clamped to its range (colours to 0..1), the others as stored. Keyframes on params
 * that are not keyframable for this template (unknown names, fframes templates) are ignored.
 */
export function evaluateTemplateParams(
	template: MgTemplateInfo | undefined,
	params: Record<string, unknown>,
	paramKeyframes: Record<string, readonly Keyframe<unknown>[]> | undefined,
	t: number,
): Record<string, unknown> {
	if (!template || !paramKeyframes) return params;
	const specs = keyframableSpecs(template);
	let out: Record<string, unknown> | null = null;
	for (const [name, kfs] of Object.entries(paramKeyframes)) {
		const s = specs.get(name);
		if (!s || !kfs || kfs.length === 0) continue;
		const clamp = s.kind === 'color' ? { min: 0, max: 1 } : { min: s.range?.min, max: s.range?.max };
		out ??= { ...params };
		out[name] = evaluate({ value: params[name], keyframes: kfs as Keyframe<unknown>[] }, t, { clamp });
	}
	return out ?? params;
}

/**
 * Specs for a composition clip's `props.<dotted.path>` (S08:MGU-003) from the composition's `propsSchema`
 * (schema module, manifest or inferred), its `defaultProps` and UI hints.
 */
export function compositionPropsPropertySpecs(
	info: Pick<MgCompositionInfo, 'propsSchema' | 'defaultProps' | 'ui'>,
): PropertySpec[] {
	return jsonSchemaPropertySpecs(info.propsSchema as JsonSchemaObject | null, {
		keyPrefix: 'props',
		storageRoot: ['props'],
		group: 'props',
		appliesTo: (c) => c.kind === 'composition',
		defaults: info.defaultProps,
		nested: true,
		ui: info.ui as Record<string, PropsUiHint> | undefined,
	});
}

/**
 * A `props.<path>` spec for a path the schema does not describe as a leaf: inside a `json` leaf (array
 * element, nested free-form value) or a prop the schema allows implicitly. Kind `json`; the whole effective
 * props object is validated against the schema when written.
 */
export function genericPropsPropertySpec(key: string, valueSchema?: JsonSchemaObject): PropertySpec {
	const path = key.split('.').slice(1);
	return {
		key,
		label: humanize(path[path.length - 1] ?? 'props'),
		group: 'props',
		kind: 'json',
		animatable: 'no',
		storagePath: ['props', ...path],
		appliesTo: (c) => c.kind === 'composition',
		ui: { control: 'json' },
		...(valueSchema ? { valueSchema } : {}),
	};
}

/** Specs for the params of one applied effect instance (`effects.<fxId>.<param>`). */
export function effectPropertySpecs(fx: Pick<EffectInstance, 'id'>, effect: EffectSpec): PropertySpec[] {
	return effect.params.map((p) => effectParamPropertySpec(fx.id, effect, p));
}

export function effectParamPropertySpec(fxId: string, effect: EffectSpec, p: ParamSpec): PropertySpec {
	const kind: ValueKind = p.type;
	// fx framework: `point` params are vec2 fields in the inspector (the Program monitor adds the on-canvas handle).
	const hint = p.ui?.control === 'point' ? 'vec2' : p.ui?.control;
	const control: PropertySpec['ui']['control'] =
		hint ??
		(kind === 'curve'
			? 'curve'
			: kind === 'mesh'
				? 'mesh'
				: kind === 'media'
					? 'media'
					: kind === 'number'
						? 'scrub'
						: kind === 'boolean'
							? 'toggle'
							: kind === 'enum'
								? 'select'
								: kind === 'color'
									? 'color'
									: kind === 'vec2'
										? 'vec2'
										: kind === 'vec3'
											? 'vec3'
											: 'text');
	const step = p.range?.step;
	return {
		key: `effects.${fxId}.${p.name}`,
		label: p.label,
		group: effect.id === 'jasper.crop' ? 'crop' : 'effect',
		kind,
		unit: p.unit,
		range: p.range,
		animatable: p.animatable ? 'continuous' : 'hold-only',
		...(p.type === 'vec2' && p.animatable && p.spatial ? { spatial: p.spatial } : {}),
		...(p.type === 'vec2' && p.animatable && p.spatial && p.spatialMetric
			? { spatialMetric: p.spatialMetric }
			: {}),
		options: p.options,
		optionLabels: p.optionLabels,
		storagePath: ['$effect', fxId, p.name],
		appliesTo: (c) => (effect.appliesTo === 'audio' ? isAudio(c) : !!kindCapabilities(c.kind)?.visual),
		ui: {
			control,
			bipolar: p.ui?.bipolar,
			...(p.ui?.multiline ? { multiline: true } : {}),
			precision: step === undefined ? 1 : step >= 1 ? 0 : step >= 0.1 ? 1 : 2,
		},
		defaultValue: p.default,
		...(p.mediaKinds ? { mediaKinds: p.mediaKinds } : {}),
	};
}

/** Registry specs that apply to a clip, plus `params.*` for motion graphics when a template is given. */
export function propertiesForClip(
	clip: Pick<Clip, 'kind'>,
	template?: MgTemplateInfo,
	composition?: Pick<MgCompositionInfo, 'propsSchema' | 'defaultProps' | 'ui'>,
): PropertySpec[] {
	const base = PROPERTY_SPECS.filter((s) => s.appliesTo(clip));
	// wp shapes: per-item keys of vector shapes.
	const threeD = threeDDynamicSpecs(clip as never);
	if (clip.kind === 'shape') return [...base, ...shapeItemPropertySpecs(clip), ...threeD];
	if (clip.kind === 'text')
		return [
			...base,
			...textAnimationParamSpecs(clip as TextAnimated),
			// animators, selectors, Path / More Options, Source Text.
			SOURCE_TEXT_SPEC,
			...textAnimatorPropertySpecs(clip as Parameters<typeof textAnimatorPropertySpecs>[0]),
			...threeD,
		];
	if (template && clip.kind === 'motion-graphic') return [...base, ...paramsPropertySpecs(template)];
	if (composition && clip.kind === 'composition')
		return [...base, ...compositionPropsPropertySpecs(composition)];
	return [...base, ...threeD];
}

/**
 * Resolves a spec for a key, including dynamic `params.<name>` keys (motion graphics, given the template),
 * `props.<dotted.path>` keys (composition clips, given the composition; paths below a schema leaf or not
 * described by the schema resolve to a generic `json` spec, validated as a whole when written) and (M2,
 * S11:TXA-007) `textAnimation.<side>.params.<name>` keys (text clips, given the clip).
 */
export function resolvePropertySpec(
	key: string,
	template?: MgTemplateInfo,
	composition?: Pick<MgCompositionInfo, 'propsSchema' | 'defaultProps' | 'ui'> | null,
	clip?: TextAnimated,
): PropertySpec | undefined {
	// spec 19 TL-014: `appearance.<fxId>.<slot>.<name>` (given the clip).
	if (key.startsWith('appearance.')) {
		const fxs = (clip as { effects?: EffectInstance[] } | undefined)?.effects ?? [];
		const fx = fxs.find((e) => e.id === key.split('.')[1]);
		return fx?.appearance
			? appearancePropertySpecs(fx, fx.appearance as Appearance).find((s) => s.key === key)
			: undefined;
	}
	// spec 19 §9: a 3D layer's surfaces, bevel bands and backplates (given the clip).
	if (isThreeDDynamicKey(key))
		return clip ? threeDDynamicSpecs(clip as never).find((s) => s.key === key) : undefined;
	// wp shapes: `shape.items.<itemId>.<field…>` of vector shapes (given the clip).
	if (key.startsWith(SHAPE_ITEM_KEY_PREFIX))
		return clip ? shapeItemPropertySpecs(clip as Pick<Clip, 'kind'>).find((s) => s.key === key) : undefined;
	// dynamic animator / selector / path / more-options keys (need the clip).
	if (isTextAnimatorKey(key))
		return resolveTextAnimatorSpec(key, clip as Parameters<typeof resolveTextAnimatorSpec>[1]);
	if (/^textAnimation\.(in|out)\.params\./.test(key))
		return clip ? textAnimationParamSpecs(clip).find((s) => s.key === key) : undefined;
	if (key.startsWith('params.'))
		return template ? paramsPropertySpecs(template).find((s) => s.key === key) : undefined;
	if (key.startsWith('text.stroke.')) return textStrokePropertySpec(key);
	if (key.startsWith('props.') && key.length > 'props.'.length) {
		if (composition === undefined) return undefined;
		if (composition === null) return genericPropsPropertySpec(key);
		const specs = compositionPropsPropertySpecs(composition);
		const exact = specs.find((s) => s.key === key);
		if (exact) return exact;
		const parent = specs.find((s) => key.startsWith(`${s.key}.`));
		if (parent && parent.kind !== 'json') return undefined;
		return genericPropsPropertySpec(key);
	}
	return getPropertySpec(key);
}

function getAt(obj: unknown, path: readonly string[]): unknown {
	let cur = obj as Record<string, unknown> | undefined;
	for (const k of path) {
		if (!cur || typeof cur !== 'object') return undefined;
		cur = cur[k] as Record<string, unknown> | undefined;
	}
	return cur;
}

function isAnimatableValue(v: unknown): v is Animatable<unknown> {
	return (
		!!v && typeof v === 'object' && 'value' in v && Array.isArray((v as { keyframes?: unknown }).keyframes)
	);
}

/**
 * The stored value of a property: the Animatable for animatable specs, the raw value for static ones,
 * or `undefined` when the clip does not carry it (e.g. no stroke yet, effect missing).
 */
function readStoredProperty(ctx: PropertyContext, s: PropertySpec): unknown {
	const [head, a, b] = s.storagePath;
	if (head === '$synthetic') {
		const syn = ctx.doc.synthetics[(ctx.clip as { syntheticId?: string }).syntheticId ?? ''];
		return syn ? getAt(syn, s.storagePath.slice(1)) : undefined;
	}
	if (head === '$effect') {
		const fx = ((ctx.clip as { effects?: EffectInstance[] }).effects ?? []).find((e) => e.id === a);
		return fx?.params[b!];
	}
	// typography values with read-time defaults.
	if (head === '$typo') {
		const st = ctx.clip.kind === 'text' ? (ctx.clip.content.style as TypoStyle) : ({} as TypoStyle);
		return TYPO_GETTERS.get(a!)?.(st);
	}
	// Source Text as an Animatable view (`content` + hold keys).
	if (head === '$sourceText') {
		const t = ctx.clip as { content?: unknown; sourceTextKeyframes?: Keyframe<unknown>[] };
		return { value: t.content, keyframes: t.sourceTextKeyframes ?? [] };
	}
	// wp masks: `['$mask', maskId, prop]` — an Opacity mask or a mask of one of the clip's effects.
	if (head === '$mask') {
		const c = ctx.clip as { masks?: Mask[]; effects?: EffectInstance[] };
		const m =
			c.masks?.find((x) => x.id === a) ?? c.effects?.flatMap((fx) => fx.masks ?? []).find((x) => x.id === a);
		return m ? (m as Record<string, unknown>)[b!] : undefined;
	}
	// sim-warp: `['$puppetPin', pinId, prop]` — a pin of one of the clip's Puppet effects.
	if (head === '$puppetPin') {
		const c = ctx.clip as { effects?: EffectInstance[] };
		const pin = c.effects?.flatMap((fx) => fx.puppet?.pins ?? []).find((x) => x.id === a);
		return pin ? (pin as Record<string, unknown>)[b!] : undefined;
	}
	// spec 19 TL-014: `['$appearance', fxId, slot, name]`.
	if (head === '$appearance') {
		const fx = ((ctx.clip as { effects?: EffectInstance[] }).effects ?? []).find((e) => e.id === a);
		return fx?.appearance ? appearanceAnimAt(fx.appearance as Appearance, b!, s.storagePath[3]!) : undefined;
	}
	// wp-m2-anime-templates (S11:ATP-006): keyframable template params read as an Animatable view.
	if (s.group === 'params' && s.animatable !== 'no') {
		const clip = ctx.clip as MgParamFields;
		return { value: clip.params?.[a!], keyframes: clip.paramKeyframes?.[a!] ?? [] };
	}
	return getAt(ctx.clip, s.storagePath);
}

/** The reset value for a property on a clip (S03:PRP-002). */
export function propertyDefault(ctx: PropertyContext, s: PropertySpec): unknown {
	const d = s.defaultValue;
	return typeof d === 'function' ? (d as (c: PropertyContext) => unknown)(ctx) : d;
}

/** Content time (flicks) at a sequence frame, clamped to the clip's visible frames (S03:EC-006). */
export function clipContentTimeAtFrame(
	clip: Pick<Clip, 'start' | 'duration' | 'sourceIn' | 'speed'>,
	frame: number,
	rate: Rational,
): { time: number; outside: boolean } {
	const f = Math.min(clip.start + clip.duration - 1, Math.max(clip.start, frame));
	return { time: contentTimeAt(clip, f, rate), outside: f !== frame };
}

/** Sequence frame at which a content time is shown (inverse of the above; may lie outside the clip). */
export function sequenceFrameOfContentTime(
	clip: Pick<Clip, 'start' | 'duration' | 'sourceIn' | 'speed'>,
	time: number,
	rate: Rational,
): number {
	const F = flicksPerFrame(rate);
	const i = (time - clip.sourceIn) / (F * clip.speed.rate);
	return Math.round(clip.speed.reverse ? clip.start + clip.duration - 1 - i : clip.start + i);
}

export type ResolvedProperty = {
	/** Value at the playhead (static value when not animated; `undefined` when absent). */
	value: unknown;
	animated: boolean;
	/** The Animatable when the spec is animatable and present. */
	anim: Animatable<unknown> | null;
	/** Content time used for evaluation. */
	time: number;
	/** The playhead is outside the clip (value is the clamped first/last one, S03:EC-006). */
	outside: boolean;
	/**
	 * spatial-points: the spatial metric the value was evaluated with (points normalised to the layer box: [box width,
	 * box height]); consumers sampling `anim` themselves (graphs, lanes) pass it to `evaluate()`.
	 */
	metric?: SpatialMetric;
};

/**
 * Options `evaluate()` uses for a property (hold-only types step; numbers clamp to their range). Shared
 * by the resolver and every consumer that samples the curve itself (Effect Controls graphs, S03:KF-022).
 */
export function propertyEvaluateOptions(
	s: Pick<PropertySpec, 'kind' | 'range' | 'animatable'> &
		Partial<Pick<PropertySpec, 'spatial' | 'spatialMetric'>>,
	/** spatial-points: the layer box of the owner (points normalised to it measure their paths in its pixels). */
	box?: { width: number; height: number } | null,
): EvaluateOptions {
	const clamp =
		s.kind === 'number' && s.range && (s.range.min !== undefined || s.range.max !== undefined)
			? { min: s.range.min, max: s.range.max }
			: undefined;
	const metric =
		box && s.kind === 'vec2' && s.spatial && s.spatialMetric === 'layer-box'
			? ([box.width, box.height] as const)
			: undefined;
	return { holdOnly: s.animatable === 'hold-only', clamp, ...(metric ? { metric } : {}) };
}

/** Value of a property at a sequence frame (S03:PRP-010). */
export function resolvePropertyAt(ctx: PropertyContext, s: PropertySpec, frame: number): ResolvedProperty {
	const { time, outside } = clipContentTimeAtFrame(ctx.clip, frame, ctx.seq.settings.frameRate);
	const stored = readStoredProperty(ctx, s);
	if (isAnimatableValue(stored)) {
		const opts = propertyEvaluateOptions(s, s.spatialMetric ? intrinsicBoxOf(ctx) : undefined);
		const value = evaluate(stored, time, opts);
		return {
			value,
			animated: stored.keyframes.length > 0,
			anim: stored,
			time,
			outside,
			...(opts.metric ? { metric: opts.metric } : {}),
		};
	}
	if (stored === undefined && s.defaultValue !== undefined)
		return { value: propertyDefault(ctx, s), animated: false, anim: null, time, outside };
	return { value: stored, animated: false, anim: null, time, outside };
}

export type PropertyWriteCommand =
	| { type: 'param.set'; target: ParamPath; value: unknown; at?: { sequenceFrame: number } }
	| { type: 'clip.update'; clipId: string; patch: Record<string, unknown> };

/**
 * The document command that writes `value` to a clip property (S03:PRP-020 `auto` mode): animated
 * properties get a keyframe at `atFrame` (param.set upserts it), others their static value.
 */
export function propertyWriteCommand(
	clip: Clip,
	s: PropertySpec,
	value: unknown,
	atFrame?: number,
): PropertyWriteCommand {
	if (s.write?.via === 'clip.update')
		return { type: 'clip.update', clipId: clip.id, patch: s.write.patch(value, clip) };
	const target = propertyKeyToParamPath({ clipId: clip.id }, s.key);
	return atFrame !== undefined && s.animatable !== 'no'
		? { type: 'param.set', target, value, at: { sequenceFrame: atFrame } }
		: { type: 'param.set', target, value };
}

export type JsonSchemaObject = Record<string, unknown>;

/** JSON Schema of one property's value, annotated with `x-animatable` / `x-unit` for agents. */
export function propertyJsonSchema(s: PropertySpec): JsonSchemaObject {
	const base: JsonSchemaObject = { title: s.label };
	if (s.description) base.description = s.description;
	base['x-animatable'] = s.animatable;
	if (s.unit) base['x-unit'] = s.unit;
	// Composition props keep their own schema (patterns, formats, nested shapes).
	if (s.group === 'props' && s.valueSchema) return { ...s.valueSchema, ...base };
	switch (s.kind) {
		case 'number':
			return {
				...base,
				type: 'number',
				...(s.range?.min !== undefined ? { minimum: s.range.min } : {}),
				...(s.range?.max !== undefined ? { maximum: s.range.max } : {}),
			};
		case 'vec2':
			return { ...base, type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
		case 'vec3':
			return { ...base, type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
		case 'color':
			return {
				...base,
				type: 'array',
				description: `${s.description ? `${s.description} ` : ''}Straight sRGB RGBA floats 0..1.`,
				items: { type: 'number', minimum: 0, maximum: 1 },
				minItems: 4,
				maxItems: 4,
			};
		case 'enum':
			return { ...base, type: 'string', enum: [...(s.options ?? [])] };
		case 'boolean':
			return { ...base, type: 'boolean' };
		case 'string':
			return { ...base, type: 'string' };
		case 'curve':
			return {
				...base,
				type: 'object',
				description: `${s.description ? `${s.description} ` : ''}Tone curve: {curve: [[x, y], …]} with x, y in 0..1 sorted by x.`,
				properties: {
					curve: {
						type: 'array',
						minItems: 2,
						items: {
							type: 'array',
							items: { type: 'number', minimum: 0, maximum: 1 },
							minItems: 2,
							maxItems: 2,
						},
					},
				},
				required: ['curve'],
			};
		case 'media':
			return {
				...base,
				type: 'object',
				properties: { mediaId: { type: 'string' } },
				required: ['mediaId'],
			};
		case 'json':
			return { ...(s.valueSchema ?? {}), ...base };
		case 'mesh':
			return {
				...base,
				type: 'array',
				description: `${s.description ? `${s.description} ` : ''}Distortion mesh: a flat list of numbers in the effect's layout (edit it with the effect's mesh/brush commands).`,
				items: { type: 'number' },
				maxItems: 400000,
			};
	}
}

/** Properties of one clip (intrinsics, template params, applied effect params) as a JSON Schema object. */
export function clipPropertiesJsonSchema(
	clip: Clip,
	opts: {
		template?: MgTemplateInfo;
		effects?: EffectRegistry;
		composition?: Pick<MgCompositionInfo, 'propsSchema' | 'defaultProps' | 'ui'>;
	} = {},
): JsonSchemaObject {
	const properties: Record<string, JsonSchemaObject> = {};
	for (const s of propertiesForClip(clip, opts.template, opts.composition))
		properties[s.key] = propertyJsonSchema(s);
	for (const fx of (clip as { effects?: EffectInstance[] }).effects ?? []) {
		const effect = opts.effects?.get(fx.effectId, fx.effectVersion);
		if (!effect) continue; // unknown effects are not editable (S01:FX-022)
		for (const s of effectPropertySpecs(fx, effect)) properties[s.key] = propertyJsonSchema(s);
	}
	return {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		title: `Properties of ${clip.kind} clip ${clip.id}`,
		type: 'object',
		properties,
		additionalProperties: false,
	};
}

export type PropertyOwner = { clipId: string } | { trackId: string } | { master: true; sequenceId?: string };

/** Property key + owner → ParamPath (S01:CMD-010). */
export function propertyKeyToParamPath(owner: PropertyOwner, key: string): ParamPath {
	// wp masks: `masks.<maskId>.<prop>` → `["mask", maskId, prop]`.
	if (key.startsWith('masks.')) {
		const [, maskId, prop] = key.split('.');
		return ['mask', maskId!, prop!];
	}
	if (key.startsWith('effects.')) {
		const [, fxId, ...param] = key.split('.');
		return ['effect', fxId!, param.join('.')];
	}
	// spec 19 TL-014: `appearance.<fxId>.<slot>.<name>` → `["appearance", fxId, slot, name]`.
	if (key.startsWith('appearance.')) return key.split('.');
	// sim-warp: `puppet.<pinId>.<prop>` → `["puppetPin", pinId, prop]`.
	if (key.startsWith('puppet.')) {
		const [, pinId, prop] = key.split('.');
		return ['puppetPin', pinId!, prop!];
	}
	if ('clipId' in owner) return ['clip', owner.clipId, ...key.split('.')];
	if ('trackId' in owner) return ['track', owner.trackId, ...key.split('.')];
	return owner.sequenceId ? ['master', owner.sequenceId, key] : ['master', key];
}

/** The Effect Controls / Properties spec of a mask property (`masks.<maskId>.<prop>`). */
export function maskPropertySpec(maskId: string, prop: MaskProp): PropertySpec {
	const base = {
		key: `masks.${maskId}.${prop}`,
		label: MASK_PROP_LABELS[prop],
		group: 'mask' as const,
		animatable: 'continuous' as const,
		storagePath: ['$mask', maskId, prop],
		appliesTo: (c: Pick<Clip, 'kind'>) => hasOpacity(c),
	};
	switch (prop) {
		case 'path':
			return { ...base, kind: 'json', ui: { control: 'json' } };
		case 'feather':
			return {
				...base,
				kind: 'number',
				unit: 'px',
				range: { ...MASK_FEATHER_RANGE, softMax: 200, step: 0.1 },
				ui: { control: 'scrub', precision: 1 },
				defaultValue: MASK_DEFAULT_FEATHER,
			};
		case 'opacity':
			return {
				...base,
				kind: 'number',
				unit: '%',
				range: { ...MASK_OPACITY_RANGE, step: 0.1 },
				ui: { control: 'scrub', precision: 1 },
				defaultValue: 100,
			};
		default:
			return {
				...base,
				kind: 'number',
				unit: 'px',
				range: { ...MASK_EXPANSION_RANGE, softMin: -200, softMax: 200, step: 0.1 },
				ui: { control: 'scrub', precision: 1 },
				defaultValue: 0,
			};
	}
}

/** The Effect Controls / Properties spec of a Puppet pin property (`puppet.<pinId>.<prop>`). */
export function puppetPinPropertySpec(pinId: string, prop: PuppetPinProp): PropertySpec {
	const base = {
		key: `puppet.${pinId}.${prop}`,
		label: PUPPET_PIN_LABELS[prop],
		group: 'effect' as const,
		animatable: 'continuous' as const,
		storagePath: ['$puppetPin', pinId, prop],
		appliesTo: (c: Pick<Clip, 'kind'>) => !!kindCapabilities(c.kind)?.visual,
	};
	switch (prop) {
		case 'position':
			return {
				...base,
				kind: 'vec2',
				spatial: 'auto-bezier',
				ui: { control: 'vec2', precision: 3 },
				range: { step: 0.001 },
			};
		case 'scale':
			return {
				...base,
				kind: 'number',
				unit: '%',
				range: { min: 0, max: 10000, softMax: 400, step: 0.1 },
				ui: { control: 'scrub', precision: 1 },
				defaultValue: 100,
			};
		case 'rotation':
			return {
				...base,
				kind: 'number',
				unit: 'deg',
				range: { step: 0.1 },
				ui: { control: 'angle', precision: 1 },
				defaultValue: 0,
			};
		case 'amount':
			return {
				...base,
				kind: 'number',
				range: { min: 0, max: 100, step: 0.1 },
				ui: { control: 'slider', precision: 1 },
				defaultValue: 50,
			};
		case 'extent':
			return {
				...base,
				kind: 'number',
				unit: 'px',
				range: { min: 0, max: 10000, softMax: 500, step: 0.1 },
				ui: { control: 'scrub', precision: 1 },
				defaultValue: 15,
			};
		default:
			return {
				...base,
				kind: 'number',
				range: { min: -100, max: 100, step: 0.1 },
				ui: { control: 'slider', precision: 1, bipolar: true },
				defaultValue: 50,
			};
	}
}

/** Pin properties a pin kind shows (After Effects: Position; + Scale, Rotation (Advanced); Bend: Scale, Rotation;
 * Starch: Amount, Extent; Overlap: In Front, Extent). */
export function puppetPinPropsOf(kind: PuppetPinKind): PuppetPinProp[] {
	switch (kind) {
		case 'advanced':
			return ['position', 'scale', 'rotation'];
		case 'bend':
			return ['scale', 'rotation'];
		case 'starch':
			return ['amount', 'extent'];
		case 'overlap':
			return ['inFront', 'extent'];
		default:
			return ['position'];
	}
}
