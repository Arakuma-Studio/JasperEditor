// Property registry (S03 §11 adapted to S01 storage, ARCHITECTURE §2.3/§5.4). Drives Properties /
// Effect Controls rows, agent schemas and range clamping. Keys are dotted and relative to the owner:
// `transform.position`, `opacity`, `volumeDb`, `effects.<fxId>.<param>`, `params.<name>`, `text.sizePx`.
// Each spec carries labels, units, ranges, UI control hints, the reset value (`defaultValue`), its
// applicability by kind capabilities and how the UI writes it (`param.set` or `clip.update`).
import { z } from 'zod';
import type { ParamPath } from '../commands/schemas/common.ts';
import { evaluate } from '../keyframes.ts';
import type { Animatable, RGBA } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import { BLEND_MODES, type Clip, type EffectInstance, type Sequence } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import type { EffectRegistry, EffectSpec, ParamSpec } from './effects.ts';
import { kindCapabilities } from './kinds.ts';
import type { MgTemplateInfo } from './mg.ts';

export type ValueKind = 'number' | 'vec2' | 'color' | 'enum' | 'boolean' | 'string';
export type PropertyGroup =
	| 'motion'
	| 'opacity'
	| 'audio'
	| 'text'
	| 'solid'
	| 'params'
	| 'effect'
	| 'crop'
	| 'box';

/** Everything a default or a patch may need to know about the clip. */
export type PropertyContext = {
	doc: Pick<ProjectDocument, 'media' | 'synthetics'>;
	seq: Pick<Sequence, 'settings'>;
	clip: Clip;
};

export type PropertySpec = {
	key: string;
	label: string;
	group: PropertyGroup;
	kind: ValueKind;
	unit?: 'px' | '%' | 'deg' | 'dB' | 'frames' | 's';
	range?: { min?: number; max?: number; softMin?: number; softMax?: number; step?: number };
	/** `continuous` = interpolated keyframes; `hold-only` = step keyframes (S01:KF-007); `no` = static field. */
	animatable: 'continuous' | 'hold-only' | 'no';
	options?: readonly string[];
	optionLabels?: readonly string[];
	/**
	 * Path of the stored value inside the clip (an Animatable when `animatable !== 'no'`). Special heads:
	 * `$synthetic` (the clip's synthetic source) and `$effect` (`['$effect', fxId, param]`).
	 */
	storagePath: readonly string[];
	appliesTo(clip: Pick<Clip, 'kind'>): boolean;
	ui: {
		control: 'scrub' | 'slider' | 'vec2' | 'angle' | 'color' | 'select' | 'toggle' | 'text';
		bipolar?: boolean;
		/** Digits after the decimal point in the UI (derived from `range.step` when absent). */
		precision?: number;
		multiline?: boolean;
	};
	/** Reset value (S03:PRP-002 `defaultValue`), a constant or computed from the clip. */
	defaultValue?: unknown | ((ctx: PropertyContext) => unknown);
	/** How the UI writes the value: `param` (default) = `param.set`; `clip.update` = the returned patch. */
	write?:
		| { via: 'param' }
		| { via: 'clip.update'; patch(value: unknown, clip: Clip): Record<string, unknown> };
	description?: string;
};

const hasTransform = (c: Pick<Clip, 'kind'>) => !!kindCapabilities(c.kind)?.hasTransform;
const hasOpacity = (c: Pick<Clip, 'kind'>) => !!kindCapabilities(c.kind)?.hasOpacity;
const isAudio = (c: Pick<Clip, 'kind'>) => c.kind === 'audio' || c.kind === 'nest-audio';
const isText = (c: Pick<Clip, 'kind'>) => c.kind === 'text';

const spec = (s: PropertySpec) => s;
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
		const vs = asset?.probe.streams.find((s) => s.type === 'video');
		if (!asset || !vs || vs.type !== 'video') return frame;
		const swap = asset.probe.rotationDegrees === 90 || asset.probe.rotationDegrees === 270;
		return swap ? { width: vs.height, height: vs.width } : { width: vs.width, height: vs.height };
	}
	if (clip.kind === 'text') {
		const box = r.box as { width: number; height: number };
		return { width: box.width, height: box.height };
	}
	if (clip.kind === 'motion-graphic' || clip.kind === 'composition') {
		const canvas = r.canvas as 'sequence' | { width: number; height: number };
		return canvas === 'sequence' ? frame : { width: canvas.width, height: canvas.height };
	}
	return frame;
}

export const PROPERTY_SPECS: readonly PropertySpec[] = [
	spec({
		key: 'transform.position',
		label: 'Position',
		group: 'motion',
		kind: 'vec2',
		unit: 'px',
		range: { step: 0.1 },
		animatable: 'continuous',
		storagePath: ['transform', 'position'],
		appliesTo: hasTransform,
		ui: { control: 'vec2', precision: 1 },
		defaultValue: ({ seq }: PropertyContext) => [seq.settings.width / 2, seq.settings.height / 2],
		description: 'Where the anchor point lands in the frame (sequence pixels).',
	}),
	spec({
		key: 'transform.anchor',
		label: 'Anchor Point',
		group: 'motion',
		kind: 'vec2',
		unit: 'px',
		range: { step: 0.1 },
		animatable: 'continuous',
		storagePath: ['transform', 'anchor'],
		appliesTo: hasTransform,
		ui: { control: 'vec2', precision: 1 },
		defaultValue: (ctx: PropertyContext) => {
			const b = intrinsicBoxOf(ctx);
			return [b.width / 2, b.height / 2];
		},
		description: 'Pivot of scale and rotation in layer pixels.',
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
		key: 'transform.uniformScale',
		label: 'Uniform Scale',
		group: 'motion',
		kind: 'boolean',
		animatable: 'no',
		storagePath: ['transform', 'uniformScale'],
		appliesTo: hasTransform,
		ui: { control: 'toggle' },
		defaultValue: true,
	}),
	spec({
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
	}),
	spec({
		key: 'transform.flipH',
		label: 'Flip Horizontal',
		group: 'motion',
		kind: 'boolean',
		animatable: 'no',
		storagePath: ['transform', 'flipH'],
		appliesTo: hasTransform,
		ui: { control: 'toggle' },
		defaultValue: false,
	}),
	spec({
		key: 'transform.flipV',
		label: 'Flip Vertical',
		group: 'motion',
		kind: 'boolean',
		animatable: 'no',
		storagePath: ['transform', 'flipV'],
		appliesTo: hasTransform,
		ui: { control: 'toggle' },
		defaultValue: false,
	}),
	spec({
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
	}),
	spec({
		key: 'blendMode',
		label: 'Blend Mode',
		group: 'opacity',
		kind: 'enum',
		options: BLEND_MODES,
		optionLabels: ['Normal', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten', 'Add', 'Difference'],
		animatable: 'no',
		storagePath: ['blendMode'],
		appliesTo: (c) => hasOpacity(c) && c.kind !== 'captions',
		ui: { control: 'select' },
		defaultValue: 'normal',
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
		key: 'text.content',
		label: 'Text',
		group: 'text',
		kind: 'string',
		animatable: 'no',
		storagePath: ['content', 'text'],
		appliesTo: isText,
		ui: { control: 'text', multiline: true },
		write: { via: 'clip.update', patch: (v) => ({ content: { text: v } }) },
	}),
	spec({
		key: 'text.fontId',
		label: 'Font',
		group: 'text',
		kind: 'string',
		animatable: 'no',
		storagePath: ['content', 'style', 'fontId'],
		appliesTo: isText,
		ui: { control: 'select' },
		write: styleWrite('fontId'),
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
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
				const w = Number(v);
				return { content: { style: { strokes: w > 0 ? [{ ...cur, widthPx: w }] : [] } } };
			},
		},
		description: 'Outside stroke (0 = no stroke).',
	}),
	spec({
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
					content: { style: { strokes: [{ ...cur, widthPx: cur.widthPx > 0 ? cur.widthPx : 4, color: v }] } },
				};
			},
		},
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
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
	}),
	spec({
		key: 'solid.color',
		label: 'Color',
		group: 'solid',
		kind: 'color',
		animatable: 'no',
		storagePath: ['$synthetic', 'color'],
		appliesTo: (c) => c.kind === 'solid',
		ui: { control: 'color' },
		defaultValue: WHITE,
	}),
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

/** Specs for a motion-graphic clip's `params.<name>` from the template's params schema. */
export function paramsPropertySpecs(template: MgTemplateInfo): PropertySpec[] {
	let json: { properties?: Record<string, Record<string, unknown>> };
	try {
		json = z.toJSONSchema(template.paramsSchema, { unrepresentable: 'any', io: 'input' }) as typeof json;
	} catch {
		return [];
	}
	const out: PropertySpec[] = [];
	for (const [name, s] of Object.entries(json.properties ?? {})) {
		let kind: ValueKind = 'string';
		let options: readonly string[] | undefined;
		const numBound = (v: unknown) => (typeof v === 'number' && Math.abs(v) < SAFE_INT ? v : undefined);
		if (Array.isArray(s.enum)) {
			kind = 'enum';
			options = (s.enum as unknown[]).map(String);
		} else if (s.type === 'number' || s.type === 'integer') kind = 'number';
		else if (s.type === 'boolean') kind = 'boolean';
		else if (s.type === 'array' && s.minItems === 4 && s.maxItems === 4) kind = 'color';
		else if (s.type === 'array' && s.minItems === 2 && s.maxItems === 2) kind = 'vec2';
		const templateDefault = template.defaults[name];
		out.push({
			key: `params.${name}`,
			label: typeof s.title === 'string' ? s.title : humanize(name),
			group: 'params',
			kind,
			options,
			range:
				kind === 'number'
					? {
							min: numBound(s.minimum),
							max: numBound(s.maximum),
							step: s.type === 'integer' ? 1 : undefined,
						}
					: undefined,
			animatable: 'no',
			storagePath: ['params', name],
			appliesTo: (c) => c.kind === 'motion-graphic',
			ui: {
				control:
					kind === 'number'
						? 'scrub'
						: kind === 'boolean'
							? 'toggle'
							: kind === 'enum'
								? 'select'
								: kind === 'color'
									? 'color'
									: kind === 'vec2'
										? 'vec2'
										: 'text',
				precision: s.type === 'integer' ? 0 : undefined,
				multiline: kind === 'string' && typeof s.maxLength === 'number' && s.maxLength > 120,
			},
			defaultValue: templateDefault !== undefined ? templateDefault : s.default,
			description: typeof s.description === 'string' ? s.description : undefined,
		});
	}
	return out;
}

/** Specs for the params of one applied effect instance (`effects.<fxId>.<param>`). */
export function effectPropertySpecs(fx: Pick<EffectInstance, 'id'>, effect: EffectSpec): PropertySpec[] {
	return effect.params.map((p) => effectParamPropertySpec(fx.id, effect, p));
}

export function effectParamPropertySpec(fxId: string, effect: EffectSpec, p: ParamSpec): PropertySpec {
	const kind: ValueKind = p.type === 'media' ? 'string' : p.type;
	const control: PropertySpec['ui']['control'] =
		p.ui?.control ??
		(kind === 'number'
			? 'scrub'
			: kind === 'boolean'
				? 'toggle'
				: kind === 'enum'
					? 'select'
					: kind === 'color'
						? 'color'
						: kind === 'vec2'
							? 'vec2'
							: 'text');
	const step = p.range?.step;
	return {
		key: `effects.${fxId}.${p.name}`,
		label: p.label,
		group: effect.id === 'jasper.crop' ? 'crop' : 'effect',
		kind,
		unit: p.unit === 'Hz' ? undefined : p.unit,
		range: p.range,
		animatable: p.animatable ? 'continuous' : 'hold-only',
		options: p.options,
		optionLabels: p.optionLabels,
		storagePath: ['$effect', fxId, p.name],
		appliesTo: (c) => (effect.appliesTo === 'audio' ? isAudio(c) : !!kindCapabilities(c.kind)?.visual),
		ui: {
			control,
			bipolar: p.ui?.bipolar,
			precision: step === undefined ? 1 : step >= 1 ? 0 : step >= 0.1 ? 1 : 2,
		},
		defaultValue: p.default,
	};
}

/** Registry specs that apply to a clip, plus `params.*` for motion graphics when a template is given. */
export function propertiesForClip(clip: Pick<Clip, 'kind'>, template?: MgTemplateInfo): PropertySpec[] {
	const base = PROPERTY_SPECS.filter((s) => s.appliesTo(clip));
	return template && clip.kind === 'motion-graphic' ? [...base, ...paramsPropertySpecs(template)] : base;
}

/** Resolves a spec for a key, including dynamic `params.<name>` keys. */
export function resolvePropertySpec(key: string, template?: MgTemplateInfo): PropertySpec | undefined {
	if (key.startsWith('params.'))
		return template ? paramsPropertySpecs(template).find((s) => s.key === key) : undefined;
	return getPropertySpec(key);
}

// ---------------------------------------------------------------- reading and resolving values

function getAt(obj: unknown, path: readonly string[]): unknown {
	let cur = obj as Record<string, unknown> | undefined;
	for (const k of path) {
		if (!cur || typeof cur !== 'object') return undefined;
		cur = cur[k] as Record<string, unknown> | undefined;
	}
	return cur;
}

export function isAnimatableValue(v: unknown): v is Animatable<unknown> {
	return (
		!!v && typeof v === 'object' && 'value' in v && Array.isArray((v as { keyframes?: unknown }).keyframes)
	);
}

/**
 * The stored value of a property: the Animatable for animatable specs, the raw value for static ones,
 * or `undefined` when the clip does not carry it (e.g. no stroke yet, effect missing).
 */
export function readStoredProperty(ctx: PropertyContext, s: PropertySpec): unknown {
	const [head, a, b] = s.storagePath;
	if (head === '$synthetic') {
		const syn = ctx.doc.synthetics[(ctx.clip as { syntheticId?: string }).syntheticId ?? ''];
		return syn ? getAt(syn, s.storagePath.slice(1)) : undefined;
	}
	if (head === '$effect') {
		const fx = ((ctx.clip as { effects?: EffectInstance[] }).effects ?? []).find((e) => e.id === a);
		return fx?.params[b!];
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
	const F = flicksPerFrame(rate);
	const i = f - clip.start;
	const time = clip.speed.reverse
		? clip.sourceIn + (clip.duration - 1 - i) * F * clip.speed.rate
		: clip.sourceIn + i * F * clip.speed.rate;
	return { time, outside: f !== frame };
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
};

/** Value of a property at a sequence frame (S03:PRP-010). */
export function resolvePropertyAt(ctx: PropertyContext, s: PropertySpec, frame: number): ResolvedProperty {
	const { time, outside } = clipContentTimeAtFrame(ctx.clip, frame, ctx.seq.settings.frameRate);
	const stored = readStoredProperty(ctx, s);
	if (isAnimatableValue(stored)) {
		const clampRange =
			s.kind === 'number' && s.range && (s.range.min !== undefined || s.range.max !== undefined)
				? { min: s.range.min, max: s.range.max }
				: undefined;
		const value = evaluate(stored, time, { holdOnly: s.animatable === 'hold-only', clamp: clampRange });
		return { value, animated: stored.keyframes.length > 0, anim: stored, time, outside };
	}
	if (stored === undefined && s.defaultValue !== undefined)
		return { value: propertyDefault(ctx, s), animated: false, anim: null, time, outside };
	return { value: stored, animated: false, anim: null, time, outside };
}

// ---------------------------------------------------------------- write path helpers

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

/** Clamps a numeric value (and vector components) to the spec range. */
export function clampToSpec(s: Pick<PropertySpec, 'kind' | 'range'>, v: unknown): unknown {
	const f = (x: number) =>
		Math.min(s.range?.max ?? Number.POSITIVE_INFINITY, Math.max(s.range?.min ?? Number.NEGATIVE_INFINITY, x));
	if (s.kind === 'number' && typeof v === 'number') return f(v);
	if (s.kind === 'color' && Array.isArray(v)) return v.map((x) => Math.min(1, Math.max(0, Number(x))));
	return v;
}

// ---------------------------------------------------------------- JSON Schema (S03:PRP-003)

export type JsonSchemaObject = Record<string, unknown>;

/** JSON Schema of one property's value, annotated with `x-animatable` / `x-unit` for agents. */
export function propertyJsonSchema(s: PropertySpec): JsonSchemaObject {
	const base: JsonSchemaObject = { title: s.label };
	if (s.description) base.description = s.description;
	base['x-animatable'] = s.animatable;
	if (s.unit) base['x-unit'] = s.unit;
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
	}
}

/** Properties of one clip (intrinsics, template params, applied effect params) as a JSON Schema object. */
export function clipPropertiesJsonSchema(
	clip: Clip,
	opts: { template?: MgTemplateInfo; effects?: EffectRegistry } = {},
): JsonSchemaObject {
	const properties: Record<string, JsonSchemaObject> = {};
	for (const s of propertiesForClip(clip, opts.template)) properties[s.key] = propertyJsonSchema(s);
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

/** Every static registry entry with its value schema (for `schema.get` and docs). */
export function propertyRegistryJson(): {
	key: string;
	label: string;
	group: PropertyGroup;
	kinds: string[];
	schema: JsonSchemaObject;
}[] {
	const kinds = [
		'video',
		'audio',
		'still',
		'animated-image',
		'text',
		'solid',
		'captions',
		'motion-graphic',
		'composition',
		'nest-video',
		'nest-audio',
		'adjustment',
	] as const;
	return PROPERTY_SPECS.map((s) => ({
		key: s.key,
		label: s.label,
		group: s.group,
		kinds: kinds.filter((k) => s.appliesTo({ kind: k })),
		schema: propertyJsonSchema(s),
	}));
}

// ---------------------------------------------------------------- key <-> ParamPath

export type PropertyOwner = { clipId: string } | { trackId: string } | { master: true; sequenceId?: string };

/** Property key + owner → ParamPath (S01:CMD-010). */
export function propertyKeyToParamPath(owner: PropertyOwner, key: string): ParamPath {
	if (key.startsWith('effects.')) {
		const [, fxId, ...param] = key.split('.');
		return ['effect', fxId!, param.join('.')];
	}
	if ('clipId' in owner) return ['clip', owner.clipId, ...key.split('.')];
	if ('trackId' in owner) return ['track', owner.trackId, ...key.split('.')];
	return owner.sequenceId ? ['master', owner.sequenceId, key] : ['master', key];
}

/** ParamPath → owner + property key (inverse of `propertyKeyToParamPath`). */
export function paramPathToPropertyKey(
	path: readonly string[],
): { owner: PropertyOwner | { effectId: string }; key: string } | null {
	const [head, a, ...rest] = path;
	if (!head || a === undefined) return null;
	switch (head) {
		case 'clip':
			return rest.length ? { owner: { clipId: a }, key: rest.join('.') } : null;
		case 'track':
			return rest.length ? { owner: { trackId: a }, key: rest.join('.') } : null;
		case 'effect':
			return rest.length ? { owner: { effectId: a }, key: `effects.${a}.${rest.join('.')}` } : null;
		case 'master':
			return rest.length
				? { owner: { master: true, sequenceId: a }, key: rest.join('.') }
				: { owner: { master: true }, key: a };
		default:
			return null;
	}
}
