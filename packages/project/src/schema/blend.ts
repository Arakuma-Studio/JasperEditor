import { z } from 'zod';

/**
 * Clip blend modes (keyframes-blend): Premiere Pro's 27 in its menu order (Normal, Dissolve | Darken, Multiply, Color
 * Burn, Linear Burn, Darker Color | Lighten, Screen, Color Dodge, Linear Dodge (Add), Lighter Color | Overlay, Soft
 * Light, Hard Light, Vivid Light, Linear Light, Pin Light, Hard Mix | Difference, Exclusion, Subtract, Divide | Hue,
 * Saturation, Color, Luminosity), then After Effects' utility modes (Stencil / Silhouette Alpha / Luma, Alpha Add).
 * `add` is Linear Dodge (Add). Formulas, groups and labels: `blend-modes.ts`.
 */
export const BLEND_MODES = [
	'normal',
	'dissolve',
	'darken',
	'multiply',
	'color-burn',
	'linear-burn',
	'darker-color',
	'lighten',
	'screen',
	'color-dodge',
	'add',
	'lighter-color',
	'overlay',
	'soft-light',
	'hard-light',
	'vivid-light',
	'linear-light',
	'pin-light',
	'hard-mix',
	'difference',
	'exclusion',
	'subtract',
	'divide',
	'hue',
	'saturation',
	'color',
	'luminosity',
	'stencil-alpha',
	'stencil-luma',
	'silhouette-alpha',
	'silhouette-luma',
	'alpha-add',
] as const;
export const BlendModeSchema = z.enum(BLEND_MODES);
export type BlendMode = z.infer<typeof BlendModeSchema>;
