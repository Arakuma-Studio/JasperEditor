// Property specs of vector shape items (wp shapes): every field of every item addressed by key
// `shape.items.<itemId>.<field…>` (e.g. `shape.items.shp_…​.size`, `….transform.position`, `….dashes.segments.0.dash`,
// `….taper.startLength`), so `param.set`, the keyframe commands, Effect Controls, the graph editor and agents work on
// them like on any other property. Labels, units and ranges follow After Effects' names for these controls.

import { BLEND_MODE_LABELS } from '../blend-modes.ts';
import type { PropertySpec } from '../registry/properties.ts';
import type { Clip, ShapeData } from '../schema/sequence.ts';
import { BLEND_MODES } from '../schema/sequence.ts';
import type { ShapeItem, ShapeItemType, VectorShapeData } from '../schema/shapes.ts';
import { defaultDashes, defaultTaper, defaultWave, newShapeItem } from './defaults.ts';
import { validGradientValue, validPathValue } from './values.ts';

type F = {
	/** Field path relative to the item. */
	f: string[];
	label: string;
	kind: PropertySpec['kind'];
	unit?: PropertySpec['unit'];
	range?: PropertySpec['range'];
	control: PropertySpec['ui']['control'];
	precision?: number;
	animatable?: PropertySpec['animatable'];
	options?: readonly string[];
	optionLabels?: readonly string[];
	defaultValue?: unknown;
	bipolar?: boolean;
	description?: string;
	validate?: (v: unknown) => boolean;
};

const PX = { min: 0, max: 32768, softMax: 1000, step: 1 };
const PCT = { min: 0, max: 100, step: 0.1 };
const ANY = { softMin: -1000, softMax: 1000, step: 0.1 };
const n = (f: string[], label: string, extra: Partial<F> = {}): F => ({
	f,
	label,
	kind: 'number',
	control: 'scrub',
	precision: 1,
	...extra,
});
const deg = (f: string[], label: string, d = 0): F =>
	n(f, label, { unit: 'deg', control: 'angle', defaultValue: d });
const pct = (f: string[], label: string, d: number, range: PropertySpec['range'] = PCT): F =>
	n(f, label, { unit: '%', range, control: 'slider', defaultValue: d });
const v2 = (f: string[], label: string, d: [number, number], extra: Partial<F> = {}): F => ({
	f,
	label,
	kind: 'vec2',
	unit: 'px',
	control: 'vec2',
	precision: 1,
	defaultValue: d,
	...extra,
});
const en = (
	f: string[],
	label: string,
	options: readonly string[],
	labels: readonly string[],
	d: string,
): F => ({
	f,
	label,
	kind: 'enum',
	control: 'select',
	animatable: 'no',
	options,
	optionLabels: labels,
	defaultValue: d,
});

const DIRECTION = en(
	['direction'],
	'Path Direction',
	['normal', 'reversed'],
	['Normal', 'Reversed'],
	'normal',
);
const BLEND = en(['blendMode'], 'Blend Mode', BLEND_MODES, BLEND_MODE_LABELS, 'normal');
const COMPOSITE = en(
	['composite'],
	'Composite',
	['below', 'above'],
	['Below Previous in Same Group', 'Above Previous in Same Group'],
	'below',
);
const FILL_RULE = en(
	['fillRule'],
	'Fill Rule',
	['nonzero', 'evenodd'],
	['Non-Zero Winding', 'Even-Odd'],
	'nonzero',
);
const LINE_JOIN = en(
	['lineJoin'],
	'Line Join',
	['miter', 'round', 'bevel'],
	['Miter Join', 'Round Join', 'Bevel Join'],
	'miter',
);
const POINTS = (d: 'corner' | 'smooth') =>
	en(['points'], 'Points', ['corner', 'smooth'], ['Corner', 'Smooth'], d);

const GRADIENT_SCHEMA = {
	type: 'object',
	description:
		'Gradient: colour stops [{position 0..1, color [r,g,b] 0..1, midpoint?}] and opacity stops [{position, opacity 0..1, midpoint?}]',
} as const;
const PATH_SCHEMA = {
	type: 'object',
	description:
		'Bézier path: {closed, vertices: [{p: [x,y], in: [dx,dy], out: [dx,dy]}…]} (handles relative to their vertex; [0,0] = corner)',
} as const;

const gradientFields: F[] = [
	en(['gradientType'], 'Type', ['linear', 'radial'], ['Linear', 'Radial'], 'linear'),
	v2(['startPoint'], 'Start Point', [0, 0]),
	v2(['endPoint'], 'End Point', [100, 0]),
	pct(['highlightLength'], 'Highlight Length', 0, { min: -100, max: 100, step: 0.1 }),
	deg(['highlightAngle'], 'Highlight Angle'),
	{
		f: ['colors'],
		label: 'Colors',
		kind: 'json',
		control: 'json',
		description: GRADIENT_SCHEMA.description,
		validate: validGradientValue,
	},
];

const strokeFields = (gradient: boolean): F[] => [
	COMPOSITE,
	BLEND,
	...(gradient
		? gradientFields
		: [{ f: ['color'], label: 'Color', kind: 'color', control: 'color', defaultValue: [1, 1, 1, 1] } as F]),
	pct(['opacity'], 'Opacity', 100),
	n(['width'], 'Stroke Width', {
		unit: 'px',
		range: { min: 0, max: 4096, softMax: 100, step: 0.1 },
		defaultValue: 2,
	}),
	en(
		['lineCap'],
		'Line Cap',
		['butt', 'round', 'square'],
		['Butt Cap', 'Round Cap', 'Projecting Cap'],
		'butt',
	),
	LINE_JOIN,
	n(['miterLimit'], 'Miter Limit', { range: { min: 1, max: 100, softMax: 10, step: 0.1 }, defaultValue: 4 }),
	en(
		['position'],
		'Stroke Position',
		['center', 'inside', 'outside'],
		['Center', 'Inside', 'Outside'],
		'center',
	),
];

const ITEM_FIELDS: Record<ShapeItemType, F[]> = {
	group: [BLEND],
	rect: [
		DIRECTION,
		v2(['size'], 'Size', [100, 100], { range: PX }),
		v2(['position'], 'Position', [0, 0]),
		n(['roundness'], 'Roundness', {
			unit: 'px',
			range: { min: 0, max: 16384, softMax: 200, step: 0.1 },
			defaultValue: 0,
		}),
	],
	ellipse: [DIRECTION, v2(['size'], 'Size', [100, 100], { range: PX }), v2(['position'], 'Position', [0, 0])],
	polystar: [
		DIRECTION,
		en(['starType'], 'Type', ['star', 'polygon'], ['Star', 'Polygon'], 'star'),
		n(['points'], 'Points', {
			range: { min: 3, max: 100, softMax: 20, step: 1 },
			precision: 1,
			defaultValue: 5,
		}),
		v2(['position'], 'Position', [0, 0]),
		deg(['rotation'], 'Rotation'),
		n(['innerRadius'], 'Inner Radius', {
			unit: 'px',
			range: { min: 0, max: 32768, softMax: 500, step: 0.1 },
			defaultValue: 50,
		}),
		n(['outerRadius'], 'Outer Radius', {
			unit: 'px',
			range: { min: 0, max: 32768, softMax: 500, step: 0.1 },
			defaultValue: 100,
		}),
		pct(['innerRoundness'], 'Inner Roundness', 0, {
			min: -1000,
			max: 1000,
			softMin: -100,
			softMax: 100,
			step: 0.1,
		}),
		pct(['outerRoundness'], 'Outer Roundness', 0, {
			min: -1000,
			max: 1000,
			softMin: -100,
			softMax: 100,
			step: 0.1,
		}),
	],
	path: [
		DIRECTION,
		{
			f: ['path'],
			label: 'Path',
			kind: 'json',
			control: 'json',
			description: PATH_SCHEMA.description,
			validate: validPathValue,
		},
	],
	fill: [
		COMPOSITE,
		FILL_RULE,
		BLEND,
		{ f: ['color'], label: 'Color', kind: 'color', control: 'color', defaultValue: [1, 0, 0, 1] },
		pct(['opacity'], 'Opacity', 100),
	],
	stroke: strokeFields(false),
	gradientFill: [COMPOSITE, FILL_RULE, BLEND, ...gradientFields, pct(['opacity'], 'Opacity', 100)],
	gradientStroke: strokeFields(true),
	trim: [
		pct(['start'], 'Start', 0),
		pct(['end'], 'End', 100),
		deg(['offset'], 'Offset'),
		en(
			['mode'],
			'Trim Multiple Shapes',
			['simultaneous', 'individual'],
			['Simultaneously', 'Individually'],
			'simultaneous',
		),
	],
	repeater: [
		n(['copies'], 'Copies', { range: { min: 0, max: 1000, softMax: 30, step: 0.1 }, defaultValue: 3 }),
		n(['offset'], 'Offset', { range: { softMin: -10, softMax: 10, step: 0.1 }, defaultValue: 0 }),
		en(['composite'], 'Composite', ['below', 'above'], ['Below', 'Above'], 'below'),
		v2(['transform', 'anchor'], 'Anchor Point', [0, 0]),
		v2(['transform', 'position'], 'Position', [100, 0]),
		v2(['transform', 'scale'], 'Scale', [100, 100], {
			unit: '%',
			range: { softMin: -200, softMax: 200, step: 0.1 },
		}),
		deg(['transform', 'rotation'], 'Rotation'),
		pct(['transform', 'startOpacity'], 'Start Opacity', 100),
		pct(['transform', 'endOpacity'], 'End Opacity', 100),
	],
	offsetPaths: [
		n(['amount'], 'Amount', {
			unit: 'px',
			range: { min: -16384, max: 16384, softMin: -100, softMax: 100, step: 0.1 },
			defaultValue: 0,
			bipolar: true,
		}),
		LINE_JOIN,
		n(['miterLimit'], 'Miter Limit', {
			range: { min: 1, max: 100, softMax: 10, step: 0.1 },
			defaultValue: 4,
		}),
		n(['copies'], 'Copies', { range: { min: 1, max: 1000, softMax: 20, step: 1 }, defaultValue: 1 }),
		n(['copyOffset'], 'Copy Offset', { range: { softMin: -10, softMax: 10, step: 0.1 }, defaultValue: 0 }),
	],
	roundCorners: [
		n(['radius'], 'Radius', {
			unit: 'px',
			range: { min: 0, max: 16384, softMax: 200, step: 0.1 },
			defaultValue: 10,
		}),
	],
	zigZag: [
		n(['size'], 'Size', {
			unit: 'px',
			range: { min: -16384, max: 16384, softMin: -100, softMax: 100, step: 0.1 },
			defaultValue: 10,
		}),
		n(['ridges'], 'Ridges per segment', {
			range: { min: 0, max: 1000, softMax: 50, step: 1 },
			defaultValue: 5,
		}),
		POINTS('corner'),
	],
	twist: [deg(['angle'], 'Angle'), v2(['center'], 'Center', [0, 0])],
	wiggle: [
		n(['size'], 'Size', {
			unit: 'px',
			range: { min: 0, max: 16384, softMax: 100, step: 0.1 },
			defaultValue: 10,
		}),
		n(['detail'], 'Detail', { range: { min: 0, max: 1000, softMax: 50, step: 1 }, defaultValue: 10 }),
		POINTS('smooth'),
		n(['speed'], 'Wiggles/Second', {
			range: { min: -100, max: 100, softMin: 0, softMax: 10, step: 0.1 },
			defaultValue: 2,
		}),
		pct(['correlation'], 'Correlation', 50),
		deg(['temporalPhase'], 'Temporal Phase'),
		deg(['spatialPhase'], 'Spatial Phase'),
		n(['seed'], 'Random Seed', {
			range: { min: -100000, max: 100000, softMin: 0, softMax: 100, step: 1 },
			precision: 0,
			defaultValue: 0,
		}),
	],
	puckerBloat: [pct(['amount'], 'Amount', 0, { min: -100, max: 100, step: 0.1 })],
	mergePaths: [
		en(
			['mode'],
			'Mode',
			['merge', 'add', 'subtract', 'intersect', 'exclude'],
			['Merge', 'Add', 'Subtract', 'Intersect', 'Exclude Intersections'],
			'add',
		),
	],
};

const GROUP_TRANSFORM: F[] = [
	v2(['transform', 'anchor'], 'Anchor Point', [0, 0]),
	v2(['transform', 'position'], 'Position', [0, 0]),
	v2(['transform', 'scale'], 'Scale', [100, 100], {
		unit: '%',
		range: { softMin: -200, softMax: 200, step: 0.1 },
	}),
	n(['transform', 'skew'], 'Skew', {
		unit: 'deg',
		range: { min: -85, max: 85, step: 0.1 },
		defaultValue: 0,
		control: 'slider',
	}),
	deg(['transform', 'skewAxis'], 'Skew Axis'),
	deg(['transform', 'rotation'], 'Rotation'),
	pct(['transform', 'opacity'], 'Opacity', 100),
];

const TAPER: F[] = [
	en(['taper', 'units'], 'Length Units', ['percent', 'pixels'], ['Percent', 'Pixels'], 'percent'),
	n(['taper', 'startLength'], 'Start Length', {
		range: { min: 0, max: 32768, softMax: 100, step: 0.1 },
		defaultValue: 0,
	}),
	n(['taper', 'endLength'], 'End Length', {
		range: { min: 0, max: 32768, softMax: 100, step: 0.1 },
		defaultValue: 0,
	}),
	pct(['taper', 'startWidth'], 'Start Width', 0),
	pct(['taper', 'endWidth'], 'End Width', 0),
	pct(['taper', 'startEase'], 'Start Ease', 0),
	pct(['taper', 'endEase'], 'End Ease', 0),
];
const WAVE: F[] = [
	pct(['wave', 'amount'], 'Amount', 0),
	en(['wave', 'units'], 'Units', ['pixels', 'cycles'], ['Pixels', 'Cycles'], 'pixels'),
	n(['wave', 'wavelength'], 'Wavelength', {
		unit: 'px',
		range: { min: 0, max: 32768, softMax: 200, step: 0.1 },
		defaultValue: 20,
	}),
	n(['wave', 'cycles'], 'Cycles', {
		range: { min: 0, max: 10000, softMax: 50, step: 0.1 },
		defaultValue: 10,
	}),
	deg(['wave', 'phase'], 'Phase'),
];

/** Field descriptors that exist on an item right now (optional groups only when present). */
function itemFields(it: ShapeItem): F[] {
	const out = [...ITEM_FIELDS[it.type]];
	if (it.type === 'group') out.push(...GROUP_TRANSFORM);
	if (it.type === 'stroke' || it.type === 'gradientStroke') {
		if (it.dashes) {
			it.dashes.segments.forEach((_, i) => {
				const s = i === 0 ? '' : ` ${i + 1}`;
				out.push(
					n(['dashes', 'segments', String(i), 'dash'], `Dash${s}`, {
						unit: 'px',
						range: { min: 0, max: 32768, softMax: 100, step: 0.1 },
						defaultValue: 10,
					}),
					n(['dashes', 'segments', String(i), 'gap'], `Gap${s}`, {
						unit: 'px',
						range: { min: 0, max: 32768, softMax: 100, step: 0.1 },
						defaultValue: 10,
					}),
				);
			});
			out.push(n(['dashes', 'offset'], 'Offset', { unit: 'px', range: ANY, defaultValue: 0 }));
		}
		if (it.taper) out.push(...TAPER);
		if (it.wave) out.push(...WAVE);
	}
	return out;
}

const isVector = (
	c: Pick<Clip, 'kind'> & { shape?: ShapeData },
): c is Pick<Clip, 'kind'> & { shape: VectorShapeData } => c.kind === 'shape' && c.shape?.type === 'vector';

export const SHAPE_ITEM_KEY_PREFIX = 'shape.items.';

/** Property key of an item field. */
export const shapeItemKey = (itemId: string, field: readonly string[]) =>
	`${SHAPE_ITEM_KEY_PREFIX}${itemId}.${field.join('.')}`;

/** Parses `shape.items.<id>.<field…>`. */
export function parseShapeItemKey(key: string): { itemId: string; field: string[] } | null {
	if (!key.startsWith(SHAPE_ITEM_KEY_PREFIX)) return null;
	const [itemId, ...field] = key.slice(SHAPE_ITEM_KEY_PREFIX.length).split('.');
	return itemId && field.length ? { itemId, field } : null;
}

export type ShapeItemPropertySpec = PropertySpec & { itemId: string; itemType: ShapeItemType };

function specsOfItem(it: ShapeItem, storage: string[]): ShapeItemPropertySpec[] {
	return itemFields(it).map((d) => {
		const kind = d.kind;
		const animatable = d.animatable ?? 'continuous';
		return {
			key: shapeItemKey(it.id, d.f),
			label: d.label,
			group: 'shape',
			kind,
			...(d.unit ? { unit: d.unit } : {}),
			...(d.range ? { range: d.range } : {}),
			animatable,
			...(d.options ? { options: d.options, optionLabels: d.optionLabels } : {}),
			storagePath: [...storage, ...d.f],
			appliesTo: isVector,
			ui: {
				control: d.control,
				...(d.precision !== undefined ? { precision: d.precision } : {}),
				...(d.bipolar ? { bipolar: true } : {}),
			},
			...(d.defaultValue !== undefined ? { defaultValue: d.defaultValue } : {}),
			description: `${it.name}: ${d.description ?? d.label}`,
			...(d.validate ? { validate: d.validate } : {}),
			...(kind === 'json'
				? { valueSchema: (d.f[0] === 'path' ? PATH_SCHEMA : GRADIENT_SCHEMA) as never }
				: {}),
			itemId: it.id,
			itemType: it.type,
		} satisfies ShapeItemPropertySpec;
	});
}

/** Specs of every item of a vector shape clip (empty for other clips). */
export function shapeItemPropertySpecs(clip: Pick<Clip, 'kind'>): ShapeItemPropertySpec[] {
	if (!isVector(clip)) return [];
	// Not cached: documents are edited through immer drafts, whose objects keep their identity while they change.
	const contents = clip.shape.contents;
	const out: ShapeItemPropertySpec[] = [];
	const walk = (items: ShapeItem[], storage: string[]) => {
		items.forEach((it, i) => {
			const path = [...storage, String(i)];
			out.push(...specsOfItem(it, path));
			if (it.type === 'group') walk(it.contents, [...path, 'contents']);
		});
	};
	walk(contents, ['shape', 'contents']);
	return out;
}

/** Specs of one item. */
export function shapeItemSpecs(clip: Pick<Clip, 'kind'>, itemId: string): ShapeItemPropertySpec[] {
	return shapeItemPropertySpecs(clip).filter((s) => s.itemId === itemId);
}

/** Specs of a single item with storage paths relative to the item (validation). */
export function shapeItemSpecsOf(it: ShapeItem): ShapeItemPropertySpec[] {
	return specsOfItem(it, []);
}

/** Spec kinds that take expressions (gradients and paths are structured values and do not). */
const EXPRESSION_SPEC_KINDS = new Set(['number', 'vec2', 'color']);

/**
 * Every expression-capable item property of a vector shape's contents: the Animatable, its property key and the
 * storage path relative to the contents array (expressions: enumeration and binding).
 */
export function shapeItemAnimatables(contents: readonly ShapeItem[]): {
	key: string;
	path: (string | number)[];
	anim: { value: unknown; keyframes: unknown[]; expression?: unknown };
}[] {
	const out: { key: string; path: (string | number)[]; anim: { value: unknown; keyframes: unknown[] } }[] =
		[];
	const walk = (items: readonly ShapeItem[], at: (string | number)[]) => {
		items.forEach((it, i) => {
			for (const s of specsOfItem(it, [])) {
				if (s.animatable === 'no' || !EXPRESSION_SPEC_KINDS.has(s.kind)) continue;
				let v: unknown = it;
				for (const k of s.storagePath)
					v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
				if (v && typeof v === 'object' && Array.isArray((v as { keyframes?: unknown }).keyframes))
					out.push({ key: s.key, path: [...at, i, ...s.storagePath], anim: v as never });
			}
			if (it.type === 'group') walk(it.contents, [...at, i, 'contents']);
		});
	};
	walk(contents, []);
	return out;
}

/**
 * Copy-on-write map over the expression-capable animatables of a contents tree: `f` returns the same object to keep
 * it; the tree is copied along changed paths only.
 */
export function mapShapeItemAnimatables(
	contents: readonly ShapeItem[],
	f: (anim: object, key: string) => object,
): readonly ShapeItem[] {
	let root: unknown = contents;
	for (const { key, path, anim } of shapeItemAnimatables(contents)) {
		const next = f(anim, key);
		if (next === anim) continue;
		const set = (node: unknown, i: number): unknown => {
			const k = path[i]!;
			const copy = Array.isArray(node) ? [...node] : { ...(node as object) };
			(copy as Record<string | number, unknown>)[k] =
				i === path.length - 1 ? next : set((node as Record<string | number, unknown>)[k], i + 1);
			return copy;
		};
		root = set(root, 0);
	}
	return root as readonly ShapeItem[];
}

/**
 * Field catalogue of every shape item type for agents (`describe_commands` schema): property key pattern
 * `shape.items.<itemId>.<field>`, label, kind, unit, range and whether it keyframes. Stroke rows include the optional
 * Dashes (one pair shown; up to three), Taper and Wave fields.
 */
export function shapeItemFieldCatalog(): Record<
	ShapeItemType,
	{
		field: string;
		label: string;
		kind: PropertySpec['kind'];
		unit?: PropertySpec['unit'];
		range?: PropertySpec['range'];
		animatable: PropertySpec['animatable'];
		options?: readonly string[];
	}[]
> {
	const out = {} as ReturnType<typeof shapeItemFieldCatalog>;
	for (const type of Object.keys(ITEM_FIELDS) as ShapeItemType[]) {
		const sample = newShapeItem(type, { id: 'x', name: type });
		if (sample.type === 'stroke' || sample.type === 'gradientStroke') {
			sample.dashes = defaultDashes();
			sample.taper = defaultTaper();
			sample.wave = defaultWave();
		}
		out[type] = itemFields(sample).map((d) => ({
			field: d.f.join('.'),
			label: d.label,
			kind: d.kind,
			...(d.unit ? { unit: d.unit } : {}),
			...(d.range ? { range: d.range } : {}),
			animatable: d.animatable ?? 'continuous',
			...(d.options ? { options: d.options } : {}),
		}));
	}
	return out;
}
