// Text animator catalogue (workstream text-animators): the properties an animator can hold (AE "Animate ▸" /
// "Add ▸ Property" entries, their companions, defaults, ranges and units) and fresh animators / selectors with
// After Effects' defaults. Pure data + factories shared by commands, the property registry, the UI and MCP.
//
// Names, defaults and companions follow After Effects (Animation ▸ Animate Text; Range / Wiggly selector
// properties) as documented in the AE user guide "Animating text" (helpx.adobe.com/after-effects/using/
// animating-text.html) and EffectCraft `crates/project/src/build.rs` (`text_anim_props`, `range_selector`,
// `wiggly_selector`).
import type { Animatable, RGBA } from '../schema/common.ts';
import type {
	TextAnimatorGroup,
	TextAnimatorProperties,
	TextRangeSelector,
	TextSelector,
	TextSelectorKind,
	TextWigglySelector,
} from '../schema/text-animators.ts';

const anim = <T>(value: T): Animatable<T> => ({ value, keyframes: [] });

/** A property an animator can hold. `key` is its field in `TextAnimatorProperties`. */
export type AnimatorPropertyDef = {
	key: Exclude<keyof TextAnimatorProperties, 'axes'>;
	label: string;
	kind: 'number' | 'vec2' | 'color' | 'enum';
	default: number | [number, number] | RGBA | string;
	unit?: 'px' | '%' | 'deg';
	range?: { min?: number; max?: number; softMin?: number; softMax?: number; step?: number };
	ui: 'scrub' | 'slider' | 'vec2' | 'angle' | 'color' | 'select';
	options?: readonly string[];
	optionLabels?: readonly string[];
	/** Only shown / effective with per-character 3D. */
	threeD?: boolean;
	/** Static (no stopwatch, as AE's popups). */
	static?: boolean;
};

const pct = (min: number, max: number) => ({ min, max, step: 1 });

/** Every animator property, in the order AE lists them in an animator's Properties group. */
export const ANIMATOR_PROPERTY_DEFS: readonly AnimatorPropertyDef[] = [
	{
		key: 'anchor',
		label: 'Anchor Point',
		kind: 'vec2',
		default: [0, 0],
		unit: 'px',
		ui: 'vec2',
		range: { step: 0.1 },
	},
	{
		key: 'anchorZ',
		label: 'Anchor Point Z',
		kind: 'number',
		default: 0,
		unit: 'px',
		ui: 'scrub',
		threeD: true,
		range: { step: 0.1 },
	},
	{
		key: 'position',
		label: 'Position',
		kind: 'vec2',
		default: [0, 0],
		unit: 'px',
		ui: 'vec2',
		range: { step: 0.1 },
	},
	{
		key: 'positionZ',
		label: 'Position Z',
		kind: 'number',
		default: 0,
		unit: 'px',
		ui: 'scrub',
		threeD: true,
		range: { step: 0.1 },
	},
	{
		key: 'scale',
		label: 'Scale',
		kind: 'vec2',
		default: [100, 100],
		unit: '%',
		ui: 'vec2',
		range: { step: 0.1 },
	},
	{
		key: 'scaleZ',
		label: 'Scale Z',
		kind: 'number',
		default: 100,
		unit: '%',
		ui: 'scrub',
		threeD: true,
		range: { step: 0.1 },
	},
	{
		key: 'skew',
		label: 'Skew',
		kind: 'number',
		default: 0,
		ui: 'slider',
		range: { min: -85, max: 85, softMin: -70, softMax: 70, step: 0.1 },
	},
	{
		key: 'skewAxis',
		label: 'Skew Axis',
		kind: 'number',
		default: 0,
		unit: 'deg',
		ui: 'angle',
		range: { step: 0.1 },
	},
	{
		key: 'rotationX',
		label: 'X Rotation',
		kind: 'number',
		default: 0,
		unit: 'deg',
		ui: 'angle',
		threeD: true,
		range: { step: 0.1 },
	},
	{
		key: 'rotationY',
		label: 'Y Rotation',
		kind: 'number',
		default: 0,
		unit: 'deg',
		ui: 'angle',
		threeD: true,
		range: { step: 0.1 },
	},
	{
		key: 'rotation',
		label: 'Rotation',
		kind: 'number',
		default: 0,
		unit: 'deg',
		ui: 'angle',
		range: { step: 0.1 },
	},
	{
		key: 'opacity',
		label: 'Opacity',
		kind: 'number',
		default: 100,
		unit: '%',
		ui: 'slider',
		range: pct(0, 100),
	},
	{ key: 'fillColor', label: 'Fill Color', kind: 'color', default: [1, 0, 0, 1], ui: 'color' },
	{
		key: 'fillHue',
		label: 'Fill Hue',
		kind: 'number',
		default: 0,
		unit: 'deg',
		ui: 'angle',
		range: { step: 0.1 },
	},
	{
		key: 'fillSaturation',
		label: 'Fill Saturation',
		kind: 'number',
		default: 0,
		unit: '%',
		ui: 'slider',
		range: pct(-100, 100),
	},
	{
		key: 'fillBrightness',
		label: 'Fill Brightness',
		kind: 'number',
		default: 0,
		unit: '%',
		ui: 'slider',
		range: pct(-100, 100),
	},
	{
		key: 'fillOpacity',
		label: 'Fill Opacity',
		kind: 'number',
		default: 100,
		unit: '%',
		ui: 'slider',
		range: pct(0, 100),
	},
	{ key: 'strokeColor', label: 'Stroke Color', kind: 'color', default: [1, 0, 0, 1], ui: 'color' },
	{
		key: 'strokeHue',
		label: 'Stroke Hue',
		kind: 'number',
		default: 0,
		unit: 'deg',
		ui: 'angle',
		range: { step: 0.1 },
	},
	{
		key: 'strokeSaturation',
		label: 'Stroke Saturation',
		kind: 'number',
		default: 0,
		unit: '%',
		ui: 'slider',
		range: pct(-100, 100),
	},
	{
		key: 'strokeBrightness',
		label: 'Stroke Brightness',
		kind: 'number',
		default: 0,
		unit: '%',
		ui: 'slider',
		range: pct(-100, 100),
	},
	{
		key: 'strokeOpacity',
		label: 'Stroke Opacity',
		kind: 'number',
		default: 100,
		unit: '%',
		ui: 'slider',
		range: pct(0, 100),
	},
	{
		key: 'strokeWidth',
		label: 'Stroke Width',
		kind: 'number',
		default: 0,
		unit: 'px',
		ui: 'scrub',
		range: { softMin: 0, softMax: 50, step: 0.1 },
	},
	{
		key: 'trackingType',
		label: 'Tracking Type',
		kind: 'enum',
		default: 'beforeAndAfter',
		ui: 'select',
		options: ['beforeAndAfter', 'before', 'after'],
		optionLabels: ['Before & After', 'Before', 'After'],
		static: true,
	},
	{ key: 'tracking', label: 'Tracking Amount', kind: 'number', default: 0, ui: 'scrub', range: { step: 1 } },
	{
		key: 'lineAnchor',
		label: 'Line Anchor',
		kind: 'number',
		default: 0,
		unit: '%',
		ui: 'scrub',
		range: { step: 0.1 },
	},
	{
		key: 'lineSpacing',
		label: 'Line Spacing',
		kind: 'vec2',
		default: [0, 0],
		unit: 'px',
		ui: 'vec2',
		range: { step: 0.1 },
	},
	{
		key: 'characterAlignment',
		label: 'Character Alignment',
		kind: 'enum',
		default: 'center',
		ui: 'select',
		options: ['left', 'center', 'right', 'adjustKerning'],
		optionLabels: ['Left or Top', 'Center', 'Right or Bottom', 'Adjust Kerning'],
		static: true,
	},
	{
		key: 'characterRange',
		label: 'Character Range',
		kind: 'enum',
		default: 'preserveCaseAndDigits',
		ui: 'select',
		options: ['preserveCaseAndDigits', 'fullUnicode'],
		optionLabels: ['Preserve Case & Digits', 'Full Unicode'],
		static: true,
	},
	{
		key: 'characterOffset',
		label: 'Character Offset',
		kind: 'number',
		default: 0,
		ui: 'scrub',
		range: { step: 1 },
	},
	{
		key: 'characterValue',
		label: 'Character Value',
		kind: 'number',
		default: 0,
		ui: 'scrub',
		range: { min: 0, max: 0x10ffff, step: 1 },
	},
	{
		key: 'blur',
		label: 'Blur',
		kind: 'vec2',
		default: [0, 0],
		unit: 'px',
		ui: 'vec2',
		range: { min: 0, softMax: 200, step: 0.1 },
	},
];

export const ANIMATOR_PROPERTY_BY_KEY: ReadonlyMap<string, AnimatorPropertyDef> = new Map(
	ANIMATOR_PROPERTY_DEFS.map((d) => [d.key, d]),
);

/**
 * The "Animate ▸" / "Add ▸ Property" menu (AE order; `-` separators): entry id, label, and the properties it adds
 * (AE adds companions: Skew Axis with Skew, Tracking Type with Tracking, Character Alignment / Range with Character
 * Offset, Character Range with Character Value, X / Y rotation with Rotation when per-character 3D is on, Z
 * components with Anchor Point / Position / Scale when per-character 3D is on).
 */
export const ANIMATOR_MENU: readonly { id: string; label: string }[] = [
	{ id: 'anchor', label: 'Anchor Point' },
	{ id: 'position', label: 'Position' },
	{ id: 'scale', label: 'Scale' },
	{ id: 'skew', label: 'Skew' },
	{ id: 'rotation', label: 'Rotation' },
	{ id: 'opacity', label: 'Opacity' },
	{ id: 'transformAll', label: 'All Transform Properties' },
	{ id: '-', label: '-' },
	{ id: 'lineAnchor', label: 'Line Anchor' },
	{ id: 'lineSpacing', label: 'Line Spacing' },
	{ id: 'characterOffset', label: 'Character Offset' },
	{ id: 'characterValue', label: 'Character Value' },
	{ id: 'blur', label: 'Blur' },
	{ id: '-', label: '-' },
	{ id: 'fillColor', label: 'Fill Color: RGB' },
	{ id: 'fillHue', label: 'Fill Color: Hue' },
	{ id: 'fillSaturation', label: 'Fill Color: Saturation' },
	{ id: 'fillBrightness', label: 'Fill Color: Brightness' },
	{ id: 'fillOpacity', label: 'Fill Color: Opacity' },
	{ id: 'strokeColor', label: 'Stroke Color: RGB' },
	{ id: 'strokeHue', label: 'Stroke Color: Hue' },
	{ id: 'strokeSaturation', label: 'Stroke Color: Saturation' },
	{ id: 'strokeBrightness', label: 'Stroke Color: Brightness' },
	{ id: 'strokeOpacity', label: 'Stroke Color: Opacity' },
	{ id: 'strokeWidth', label: 'Stroke Width' },
	{ id: 'tracking', label: 'Tracking' },
];

export const ANIMATOR_MENU_IDS: readonly string[] = ANIMATOR_MENU.filter((m) => m.id !== '-').map(
	(m) => m.id,
);

/** The property keys a menu entry adds (with companions). Unknown entries → []. */
export function animatorMenuProperties(entry: string, threeD: boolean): AnimatorPropertyDef['key'][] {
	switch (entry) {
		case 'anchor':
			return threeD ? ['anchor', 'anchorZ'] : ['anchor'];
		case 'position':
			return threeD ? ['position', 'positionZ'] : ['position'];
		case 'scale':
			return threeD ? ['scale', 'scaleZ'] : ['scale'];
		case 'skew':
			return ['skew', 'skewAxis'];
		case 'rotation':
			return threeD ? ['rotationX', 'rotationY', 'rotation'] : ['rotation'];
		case 'transformAll':
			return ['anchor', 'position', 'scale', 'skew', 'rotation', 'opacity'].flatMap((k) =>
				animatorMenuProperties(k, threeD),
			);
		case 'tracking':
			return ['trackingType', 'tracking'];
		case 'characterOffset':
			return ['characterAlignment', 'characterRange', 'characterOffset'];
		case 'characterValue':
			return ['characterRange', 'characterValue'];
		default:
			return ANIMATOR_PROPERTY_BY_KEY.has(entry) ? [entry as AnimatorPropertyDef['key']] : [];
	}
}

/** The stored initial value of a property (an Animatable, or the raw value of static ones). */
export function defaultAnimatorPropertyValue(key: AnimatorPropertyDef['key']): unknown {
	const d = ANIMATOR_PROPERTY_BY_KEY.get(key)!;
	const v = Array.isArray(d.default) ? [...d.default] : d.default;
	return d.static ? v : anim(v);
}

/** Adds the properties of a menu entry to an animator (keeps the ones it has). Returns the keys added. */
export function addAnimatorProperties(
	a: { properties: TextAnimatorProperties },
	entry: string,
	threeD: boolean,
): string[] {
	const added: string[] = [];
	const props = a.properties as Record<string, unknown>;
	for (const key of animatorMenuProperties(entry, threeD)) {
		if (props[key] !== undefined) continue;
		props[key] = defaultAnimatorPropertyValue(key);
		added.push(key);
	}
	return added;
}

/** Variable font axis tag (4 printable ASCII characters, e.g. `wght`). */
export const AXIS_TAG = /^[\x20-\x7e]{4}$/;

// ---------------------------------------------------------------- selectors and animators

export function newRangeSelector(id: string, name = 'Range Selector 1'): TextRangeSelector {
	return {
		id,
		kind: 'range',
		name,
		enabled: true,
		start: anim(0),
		end: anim(100),
		offset: anim(0),
		units: 'percentage',
		basedOn: 'characters',
		mode: 'add',
		amount: anim(100),
		shape: 'square',
		smoothness: anim(100),
		easeHigh: anim(0),
		easeLow: anim(0),
		randomize: false,
		randomSeed: anim(0),
	};
}

/** Wiggly Selector (Mode defaults to Intersect, so it varies the selectors above it). */
export function newWigglySelector(id: string, name = 'Wiggly Selector 1'): TextWigglySelector {
	return {
		id,
		kind: 'wiggly',
		name,
		enabled: true,
		mode: 'intersect',
		maxAmount: anim(100),
		minAmount: anim(-100),
		basedOn: 'characters',
		wigglesPerSecond: anim(2),
		correlation: anim(50),
		temporalPhase: anim(0),
		spatialPhase: anim(0),
		lockDimensions: false,
		randomSeed: anim(0),
	};
}

export function newTextSelector(kind: TextSelectorKind, id: string, name: string): TextSelector {
	return kind === 'wiggly' ? newWigglySelector(id, name) : newRangeSelector(id, name);
}

export const SELECTOR_LABEL: Record<TextSelectorKind, string> = {
	range: 'Range Selector',
	wiggly: 'Wiggly Selector',
};

/** The next "Range Selector N" style name among existing selectors. */
export function nextSelectorName(kind: TextSelectorKind, existing: readonly TextSelector[]): string {
	return `${SELECTOR_LABEL[kind]} ${existing.filter((s) => s.kind === kind).length + 1}`;
}

/** A new animator with one Range Selector (AE: Animate ▸ property adds "Animator N" with "Range Selector 1"). */
export function newTextAnimator(id: string, name: string, selectorId: string | null): TextAnimatorGroup {
	return {
		id,
		name,
		enabled: true,
		properties: {},
		selectors: selectorId ? [newRangeSelector(selectorId)] : [],
	};
}

/** Selector fields: label, kind, range, default (Effect Controls rows, property specs, MCP schema). */
export type SelectorFieldDef = {
	key: string;
	label: string;
	kind: 'number' | 'enum' | 'boolean';
	animatable: boolean;
	unit?: '%' | 'deg';
	range?: { min?: number; max?: number; softMin?: number; softMax?: number; step?: number };
	ui: 'scrub' | 'slider' | 'angle' | 'select' | 'toggle';
	options?: readonly string[];
	optionLabels?: readonly string[];
	default: number | string | boolean;
	/** Shown in the selector's "Advanced" group (Range). */
	advanced?: boolean;
};

const BASED_ON_FIELD = {
	key: 'basedOn',
	label: 'Based On',
	kind: 'enum',
	animatable: false,
	ui: 'select',
	options: ['characters', 'charactersExcludingSpaces', 'words', 'lines'],
	optionLabels: ['Characters', 'Characters Excluding Spaces', 'Words', 'Lines'],
	default: 'characters',
} as const satisfies SelectorFieldDef;
const MODE_OPTIONS = ['add', 'subtract', 'intersect', 'min', 'max', 'difference'] as const;
const MODE_LABELS = ['Add', 'Subtract', 'Intersect', 'Min', 'Max', 'Difference'] as const;

export const RANGE_SELECTOR_FIELDS: readonly SelectorFieldDef[] = [
	{
		key: 'start',
		label: 'Start',
		kind: 'number',
		animatable: true,
		unit: '%',
		ui: 'scrub',
		range: { step: 0.1 },
		default: 0,
	},
	{
		key: 'end',
		label: 'End',
		kind: 'number',
		animatable: true,
		unit: '%',
		ui: 'scrub',
		range: { step: 0.1 },
		default: 100,
	},
	{
		key: 'offset',
		label: 'Offset',
		kind: 'number',
		animatable: true,
		unit: '%',
		ui: 'scrub',
		range: { step: 0.1 },
		default: 0,
	},
	{
		key: 'units',
		label: 'Units',
		kind: 'enum',
		animatable: false,
		ui: 'select',
		options: ['percentage', 'index'],
		optionLabels: ['Percentage', 'Index'],
		default: 'percentage',
		advanced: true,
	},
	{ ...BASED_ON_FIELD, advanced: true },
	{
		key: 'mode',
		label: 'Mode',
		kind: 'enum',
		animatable: false,
		ui: 'select',
		options: MODE_OPTIONS,
		optionLabels: MODE_LABELS,
		default: 'add',
		advanced: true,
	},
	{
		key: 'amount',
		label: 'Amount',
		kind: 'number',
		animatable: true,
		unit: '%',
		ui: 'slider',
		range: { min: -100, max: 100, step: 1 },
		default: 100,
		advanced: true,
	},
	{
		key: 'shape',
		label: 'Shape',
		kind: 'enum',
		animatable: false,
		ui: 'select',
		options: ['square', 'rampUp', 'rampDown', 'triangle', 'round', 'smooth'],
		optionLabels: ['Square', 'Ramp Up', 'Ramp Down', 'Triangle', 'Round', 'Smooth'],
		default: 'square',
		advanced: true,
	},
	{
		key: 'smoothness',
		label: 'Smoothness',
		kind: 'number',
		animatable: true,
		unit: '%',
		ui: 'slider',
		range: { min: 0, max: 100, step: 1 },
		default: 100,
		advanced: true,
	},
	{
		key: 'easeHigh',
		label: 'Ease High',
		kind: 'number',
		animatable: true,
		unit: '%',
		ui: 'slider',
		range: { min: -100, max: 100, step: 1 },
		default: 0,
		advanced: true,
	},
	{
		key: 'easeLow',
		label: 'Ease Low',
		kind: 'number',
		animatable: true,
		unit: '%',
		ui: 'slider',
		range: { min: -100, max: 100, step: 1 },
		default: 0,
		advanced: true,
	},
	{
		key: 'randomize',
		label: 'Randomize Order',
		kind: 'boolean',
		animatable: false,
		ui: 'toggle',
		default: false,
		advanced: true,
	},
	{
		key: 'randomSeed',
		label: 'Random Seed',
		kind: 'number',
		animatable: true,
		ui: 'scrub',
		range: { step: 1 },
		default: 0,
		advanced: true,
	},
];

export const WIGGLY_SELECTOR_FIELDS: readonly SelectorFieldDef[] = [
	{
		key: 'mode',
		label: 'Mode',
		kind: 'enum',
		animatable: false,
		ui: 'select',
		options: MODE_OPTIONS,
		optionLabels: MODE_LABELS,
		default: 'intersect',
	},
	{
		key: 'maxAmount',
		label: 'Max Amount',
		kind: 'number',
		animatable: true,
		unit: '%',
		ui: 'slider',
		range: { min: -100, max: 100, step: 1 },
		default: 100,
	},
	{
		key: 'minAmount',
		label: 'Min Amount',
		kind: 'number',
		animatable: true,
		unit: '%',
		ui: 'slider',
		range: { min: -100, max: 100, step: 1 },
		default: -100,
	},
	BASED_ON_FIELD,
	{
		key: 'wigglesPerSecond',
		label: 'Wiggles/Second',
		kind: 'number',
		animatable: true,
		ui: 'scrub',
		range: { min: 0, max: 1000, softMax: 10, step: 0.1 },
		default: 2,
	},
	{
		key: 'correlation',
		label: 'Correlation',
		kind: 'number',
		animatable: true,
		unit: '%',
		ui: 'slider',
		range: { min: 0, max: 100, step: 1 },
		default: 50,
	},
	{
		key: 'temporalPhase',
		label: 'Temporal Phase',
		kind: 'number',
		animatable: true,
		unit: 'deg',
		ui: 'angle',
		range: { step: 0.1 },
		default: 0,
	},
	{
		key: 'spatialPhase',
		label: 'Spatial Phase',
		kind: 'number',
		animatable: true,
		unit: 'deg',
		ui: 'angle',
		range: { step: 0.1 },
		default: 0,
	},
	{
		key: 'lockDimensions',
		label: 'Lock Dimensions',
		kind: 'boolean',
		animatable: false,
		ui: 'toggle',
		default: false,
	},
	{
		key: 'randomSeed',
		label: 'Random Seed',
		kind: 'number',
		animatable: true,
		ui: 'scrub',
		range: { step: 1 },
		default: 0,
	},
];

export function selectorFields(kind: TextSelectorKind): readonly SelectorFieldDef[] {
	return kind === 'wiggly' ? WIGGLY_SELECTOR_FIELDS : RANGE_SELECTOR_FIELDS;
}
