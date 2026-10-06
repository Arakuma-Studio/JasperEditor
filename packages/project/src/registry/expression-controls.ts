// Expression Controls (wave expressions; After Effects ▸ Effect ▸ Expression Controls): parameter-only effects that
// hold values for expressions — effect("Slider Control")("Slider"). They draw nothing (`passthrough`): render
// snapshots omit them, so no preview, export path or planner sees them. Names, parameters, ranges and defaults
// follow Adobe's "Expression Controls effects" reference; see docs/wp-notes/expressions.md for sources.
// Ported from EffectCraft `crates/effects/src/controls.rs` (MIT OR Apache-2.0).
import type { EffectSpec, ParamSpec } from './effects.ts';

const control = (
	id: string,
	label: string,
	description: string,
	params: ParamSpec[],
	extra: Partial<EffectSpec> = {},
): EffectSpec => ({
	id,
	version: 1,
	label,
	category: 'Expression Controls',
	appliesTo: 'video',
	params,
	preview: {},
	native: null,
	capabilities: { preview: 'none', export: ['remotion', 'native'] },
	passthrough: true,
	description,
	keywords: ['expression', 'control', 'rig'],
	...extra,
});

export const SLIDER_CONTROL_ID = 'jasper.slider-control';
export const ANGLE_CONTROL_ID = 'jasper.angle-control';
export const CHECKBOX_CONTROL_ID = 'jasper.checkbox-control';
export const COLOR_CONTROL_ID = 'jasper.color-control';
export const POINT_CONTROL_ID = 'jasper.point-control';
export const POINT3D_CONTROL_ID = 'jasper.point3d-control';
export const LAYER_CONTROL_ID = 'jasper.layer-control';
export const DROPDOWN_CONTROL_ID = 'jasper.dropdown-control';

/** Items of a Dropdown Menu Control instance (one per line of its `items` param; never empty). */
export function dropdownItems(items: unknown): string[] {
	const list = String(items ?? '')
		.split('\n')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return list.length ? list : ['Item 1'];
}

export const EXPRESSION_CONTROL_EFFECTS: readonly EffectSpec[] = [
	control(SLIDER_CONTROL_ID, 'Slider Control', 'A number for expressions (−1,000,000 … 1,000,000; slider 0 … 100).', [
		{
			name: 'slider',
			label: 'Slider',
			type: 'number',
			default: 0,
			range: { min: -1_000_000, max: 1_000_000, softMin: 0, softMax: 100, step: 0.01 },
			animatable: true,
			ui: { control: 'slider' },
		},
	]),
	control(ANGLE_CONTROL_ID, 'Angle Control', 'An angle in degrees for expressions.', [
		{ name: 'angle', label: 'Angle', type: 'number', default: 0, unit: 'deg', animatable: true, ui: { control: 'angle' } },
	]),
	control(CHECKBOX_CONTROL_ID, 'Checkbox Control', 'An on/off switch for expressions (reads 1 or 0).', [
		{ name: 'checkbox', label: 'Checkbox', type: 'boolean', default: false, animatable: false, ui: { control: 'toggle' } },
	]),
	control(COLOR_CONTROL_ID, 'Color Control', 'A colour for expressions ([r, g, b, a] in 0…1).', [
		{ name: 'color', label: 'Color', type: 'color', default: [1, 0, 0, 1], animatable: true, ui: { control: 'color' } },
	]),
	control(
		POINT_CONTROL_ID,
		'Point Control',
		'A 2D point (layer pixels) for expressions; starts at the centre of the clip.',
		[
			{
				name: 'point',
				label: 'Point',
				type: 'vec2',
				default: [0, 0],
				unit: 'px',
				range: { step: 0.1 },
				animatable: true,
				spatial: 'auto-bezier',
			},
		],
		{ instanceDefaults: ({ box }) => ({ point: [box.width / 2, box.height / 2] }) },
	),
	control(
		POINT3D_CONTROL_ID,
		'3D Point Control',
		'A 3D point for expressions; starts at the centre of the clip, z = 0.',
		[
			{
				name: 'point',
				label: '3D Point',
				type: 'vec3',
				default: [0, 0, 0],
				unit: 'px',
				range: { step: 0.1 },
				animatable: true,
			},
		],
		{ instanceDefaults: ({ box }) => ({ point: [box.width / 2, box.height / 2, 0] }) },
	),
	control(LAYER_CONTROL_ID, 'Layer Control', 'Picks a clip of the sequence; expressions read it as a layer.', [
		{ name: 'layer', label: 'Layer', type: 'string', default: '', animatable: false, ui: { control: 'layer' } },
	]),
	control(
		DROPDOWN_CONTROL_ID,
		'Dropdown Menu Control',
		'A menu for expressions (reads the 1-based index of the chosen item). Edit the items, one per line.',
		[
			{
				name: 'menu',
				label: 'Menu',
				type: 'number',
				default: 1,
				range: { min: 1, max: 1000, step: 1 },
				animatable: false,
				ui: { control: 'menu' },
			},
			{ name: 'items', label: 'Menu Items', type: 'string', default: 'Item 1\nItem 2\nItem 3', animatable: false },
		],
	),
];
