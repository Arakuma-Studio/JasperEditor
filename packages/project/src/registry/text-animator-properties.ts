// Property specs of text animators, Path Options and More Options (workstream text-animators). Dynamic per clip:
// keys address animators and selectors by id, storage paths by their index in the clip, so `param.set`,
// `param.setAnimated` and every keyframe command work on them like on any clip property (stopwatches, keys,
// graphs, copy/paste of keyframes). Static popups (Based On, Mode, Shape, …) are `animatable: 'no'` fields
// written in place.
//
// Keys:
//   textAnimators.<animatorId>.properties.<prop>          e.g. `textAnimators.tan1.properties.position`
//   textAnimators.<animatorId>.properties.axes.<tag>      variable font axis offsets
//   textAnimators.<animatorId>.selectors.<selectorId>.<field>
//   textPath.<field>                                      Path Options (when the clip has a path)
//   textMore.<field>                                      More Options
//   text.sourceText                                       Source Text (hold keyframes; json value)
import type { Clip } from '../schema/sequence.ts';
import type { TextAnimatorGroup, TextPathOptions } from '../schema/text-animators.ts';
import {
	ANIMATOR_PROPERTY_BY_KEY,
	ANIMATOR_PROPERTY_DEFS,
	type AnimatorPropertyDef,
	type SelectorFieldDef,
	selectorFields,
} from '../text-animators/catalog.ts';
import type { PropertySpec } from './properties.ts';

type TextLike = Pick<Clip, 'kind'> & {
	animators?: TextAnimatorGroup[];
	pathOptions?: TextPathOptions;
	perCharacter3d?: boolean;
};

const isText = (c: Pick<Clip, 'kind'>) => c.kind === 'text';

export const TEXT_ANIMATOR_KEY_PREFIX = 'textAnimators.';

function propertySpec(a: TextAnimatorGroup, ai: number, def: AnimatorPropertyDef): PropertySpec {
	return {
		key: `${TEXT_ANIMATOR_KEY_PREFIX}${a.id}.properties.${def.key}`,
		label: def.label,
		group: 'textAnimator',
		kind: def.kind,
		...(def.unit ? { unit: def.unit } : {}),
		...(def.range ? { range: def.range } : {}),
		animatable: def.static ? 'no' : 'continuous',
		...(def.key === 'position' || def.key === 'anchor' ? { spatial: 'linear' as const } : {}),
		...(def.options ? { options: def.options, optionLabels: def.optionLabels } : {}),
		storagePath: ['animators', String(ai), 'properties', def.key],
		appliesTo: isText,
		ui: {
			control: def.ui,
			...(def.key === 'skew' || def.key.endsWith('Saturation') || def.key.endsWith('Brightness')
				? { bipolar: true }
				: {}),
		},
		defaultValue: Array.isArray(def.default) ? [...def.default] : def.default,
		description: `Text animator "${a.name}": ${def.label}`,
	};
}

function axisSpec(a: TextAnimatorGroup, ai: number, tag: string): PropertySpec {
	return {
		key: `${TEXT_ANIMATOR_KEY_PREFIX}${a.id}.properties.axes.${tag}`,
		label: `Font Axis ${tag}`,
		group: 'textAnimator',
		kind: 'number',
		range: { step: 0.1 },
		animatable: 'continuous',
		storagePath: ['animators', String(ai), 'properties', 'axes', tag],
		appliesTo: isText,
		ui: { control: 'scrub' },
		defaultValue: 0,
		description: `Text animator "${a.name}": offset of the variable font axis "${tag}" (user units)`,
	};
}

function selectorFieldSpec(a: TextAnimatorGroup, ai: number, si: number, f: SelectorFieldDef): PropertySpec {
	const sel = a.selectors[si]!;
	const index = sel.kind === 'range' && sel.units === 'index';
	const unitless = index && (f.key === 'start' || f.key === 'end' || f.key === 'offset');
	return {
		key: `${TEXT_ANIMATOR_KEY_PREFIX}${a.id}.selectors.${sel.id}.${f.key}`,
		label: f.label,
		group: 'textAnimator',
		kind: f.kind,
		...(f.unit && !unitless ? { unit: f.unit } : {}),
		...(f.range ? { range: f.range } : {}),
		animatable: f.animatable ? 'continuous' : 'no',
		...(f.options ? { options: f.options, optionLabels: f.optionLabels } : {}),
		storagePath: ['animators', String(ai), 'selectors', String(si), f.key],
		appliesTo: isText,
		ui: {
			control: f.ui,
			...(f.key === 'amount' || f.key.startsWith('ease') || f.key.endsWith('Amount')
				? { bipolar: true }
				: {}),
		},
		defaultValue: f.default,
		description: `Text animator "${a.name}", ${sel.name}: ${f.label}`,
	};
}

/** Path Options specs (present when the clip has a text path). */
function pathSpecs(): PropertySpec[] {
	const bool = (field: string, label: string, d: boolean): PropertySpec => ({
		key: `textPath.${field}`,
		label,
		group: 'textAnimator',
		kind: 'boolean',
		animatable: 'no',
		storagePath: ['pathOptions', field],
		appliesTo: isText,
		ui: { control: 'toggle' },
		defaultValue: d,
	});
	const margin = (field: string, label: string): PropertySpec => ({
		key: `textPath.${field}`,
		label,
		group: 'textAnimator',
		kind: 'number',
		unit: 'px',
		range: { step: 0.1 },
		animatable: 'continuous',
		storagePath: ['pathOptions', field],
		appliesTo: isText,
		ui: { control: 'scrub' },
		defaultValue: 0,
	});
	return [
		bool('reversePath', 'Reverse Path', false),
		bool('perpendicularToPath', 'Perpendicular To Path', true),
		bool('forceAlignment', 'Force Alignment', false),
		margin('firstMargin', 'First Margin'),
		margin('lastMargin', 'Last Margin'),
	];
}

/** More Options specs (always offered on text clips; the options are created on first write). */
export const TEXT_MORE_OPTIONS_SPECS: readonly PropertySpec[] = [
	{
		key: 'textMore.anchorPointGrouping',
		label: 'Anchor Point Grouping',
		group: 'textAnimator',
		kind: 'enum',
		animatable: 'no',
		options: ['character', 'word', 'line', 'all'],
		optionLabels: ['Character', 'Word', 'Line', 'All'],
		storagePath: ['moreOptions', 'anchorPointGrouping'],
		appliesTo: isText,
		ui: { control: 'select' },
		defaultValue: 'character',
	},
	{
		key: 'textMore.groupingAlignment',
		label: 'Grouping Alignment',
		group: 'textAnimator',
		kind: 'vec2',
		unit: '%',
		range: { step: 0.1 },
		animatable: 'continuous',
		storagePath: ['moreOptions', 'groupingAlignment'],
		appliesTo: isText,
		ui: { control: 'vec2' },
		defaultValue: [0, 0],
	},
	{
		key: 'textMore.fillAndStroke',
		label: 'Fill & Stroke',
		group: 'textAnimator',
		kind: 'enum',
		animatable: 'no',
		options: ['perCharacter', 'allFillsOverAllStrokes', 'allStrokesOverAllFills'],
		optionLabels: ['Per Character Palette', 'All Fills Over All Strokes', 'All Strokes Over All Fills'],
		storagePath: ['moreOptions', 'fillAndStroke'],
		appliesTo: isText,
		ui: { control: 'select' },
		defaultValue: 'perCharacter',
	},
	{
		key: 'textMore.interCharacterBlending',
		label: 'Inter-Character Blending',
		group: 'textAnimator',
		kind: 'enum',
		animatable: 'no',
		options: [
			'normal',
			'darken',
			'multiply',
			'color-burn',
			'lighten',
			'screen',
			'color-dodge',
			'overlay',
			'soft-light',
			'hard-light',
			'difference',
			'exclusion',
			'hue',
			'saturation',
			'color',
			'luminosity',
		],
		optionLabels: [
			'Normal',
			'Darken',
			'Multiply',
			'Color Burn',
			'Lighten',
			'Screen',
			'Color Dodge',
			'Overlay',
			'Soft Light',
			'Hard Light',
			'Difference',
			'Exclusion',
			'Hue',
			'Saturation',
			'Color',
			'Luminosity',
		],
		storagePath: ['moreOptions', 'interCharacterBlending'],
		appliesTo: isText,
		ui: { control: 'select' },
		defaultValue: 'normal',
	},
];

/** Source Text: hold keyframes of the whole text content (AE Source Text). */
export const SOURCE_TEXT_SPEC: PropertySpec = {
	key: 'text.sourceText',
	label: 'Source Text',
	group: 'text',
	kind: 'json',
	animatable: 'hold-only',
	storagePath: ['$sourceText'],
	appliesTo: isText,
	ui: { control: 'json' },
	description:
		'The text content {text, style, runs?, paragraphs?} (hold keyframes: the text changes at each key; without keys it is `content`).',
};

/** Every dynamic text-animator spec of a clip (in Effect Controls order). */
export function textAnimatorPropertySpecs(clip: TextLike): PropertySpec[] {
	if (clip.kind !== 'text') return [];
	const out: PropertySpec[] = [];
	(clip.animators ?? []).forEach((a, ai) => {
		const props = a.properties as Record<string, unknown>;
		for (const def of ANIMATOR_PROPERTY_DEFS)
			if (props[def.key] !== undefined) out.push(propertySpec(a, ai, def));
		for (const tag of Object.keys(a.properties.axes ?? {})) out.push(axisSpec(a, ai, tag));
		a.selectors.forEach((s, si) => {
			for (const f of selectorFields(s.kind)) out.push(selectorFieldSpec(a, ai, si, f));
		});
	});
	if (clip.pathOptions) out.push(...pathSpecs());
	out.push(...TEXT_MORE_OPTIONS_SPECS);
	return out;
}

/** Resolves one dynamic key against a clip (undefined when it does not address anything on it). */
export function resolveTextAnimatorSpec(key: string, clip: TextLike | undefined): PropertySpec | undefined {
	if (key === SOURCE_TEXT_SPEC.key) return SOURCE_TEXT_SPEC;
	if (key.startsWith('textMore.')) return TEXT_MORE_OPTIONS_SPECS.find((s) => s.key === key);
	if (clip?.kind !== 'text') return undefined;
	if (key.startsWith('textPath.'))
		return clip.pathOptions ? pathSpecs().find((s) => s.key === key) : undefined;
	if (!key.startsWith(TEXT_ANIMATOR_KEY_PREFIX)) return undefined;
	const parts = key.slice(TEXT_ANIMATOR_KEY_PREFIX.length).split('.');
	const ai = (clip.animators ?? []).findIndex((a) => a.id === parts[0]);
	const a = clip.animators?.[ai];
	if (!a) return undefined;
	if (parts[1] === 'properties') {
		if (parts[2] === 'axes' && parts.length === 4)
			return a.properties.axes?.[parts[3]!] ? axisSpec(a, ai, parts[3]!) : undefined;
		const def = parts.length === 3 ? ANIMATOR_PROPERTY_BY_KEY.get(parts[2]!) : undefined;
		return def && (a.properties as Record<string, unknown>)[def.key] !== undefined
			? propertySpec(a, ai, def)
			: undefined;
	}
	if (parts[1] === 'selectors' && parts.length === 4) {
		const si = a.selectors.findIndex((s) => s.id === parts[2]);
		const sel = a.selectors[si];
		const f = sel ? selectorFields(sel.kind).find((x) => x.key === parts[3]) : undefined;
		return f ? selectorFieldSpec(a, ai, si, f) : undefined;
	}
	return undefined;
}

/** True for keys this module resolves (they need the clip). */
export function isTextAnimatorKey(key: string): boolean {
	return (
		key.startsWith(TEXT_ANIMATOR_KEY_PREFIX) ||
		key.startsWith('textPath.') ||
		key.startsWith('textMore.') ||
		key === SOURCE_TEXT_SPEC.key
	);
}
