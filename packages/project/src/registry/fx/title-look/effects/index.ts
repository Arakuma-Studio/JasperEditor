// The standalone effects of spec 19 §8, on any clip, each sharing its GLSL with a look layer (the layer files say which).
// Outer Glow is not here: it extends `jasper.alpha-glow`, which already did that job. Decisions per effect:
// docs/wp-notes/title-looks.md "Standalone effects". Adding one: an entry in a file here and one line in the list.
import type { EffectParams, EffectSpec } from '../../../effects.ts';
import { fxParam } from '../../params.ts';
import { OVERLAY_BLEND_LABELS, OVERLAY_BLENDS } from '../layers/gradient-overlay.ts';
import {
	colorPaint,
	defineLookEffect,
	gradientPaint,
	type LookEffectLayer,
	SOURCE_FACE,
} from '../look-effect.ts';
import { DEEP_GLOW } from './deep-glow.ts';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Largest distance of a param whose reach is the padding (`FX_MAX_PADDING`). */
const MAX_REACH = 2000;

const px = (name: string, label: string, def: number, softMax: number, min = 0) =>
	fxParam.number(
		name,
		label,
		def,
		{ min, max: MAX_REACH, softMax, ...(min < 0 ? { softMin: Math.max(min, -softMax) } : {}), step: 0.1 },
		{ unit: 'px' },
	);

/** The params of a layer an effect passes on as they are. */
const pick = (p: EffectParams, names: readonly string[]) =>
	Object.fromEntries(
		names.filter((n) => p[n] !== undefined).map((n) => [n, p[n]!]),
	) as LookEffectLayer['params'];

const INTENSITY = () =>
	fxParam.number('intensity', 'Intensity', 100, { min: 0, max: 1000, softMax: 300, step: 1 }, { unit: '%' });

const USE_GLOBAL_LIGHT = () => fxParam.toggle('useGlobalLight', 'Use Global Light', false);

export const INNER_GLOW = defineLookEffect({
	id: 'jasper.inner-glow',
	label: 'Inner Glow',
	category: 'Stylize',
	description: 'Light inside the clip’s alpha: from its edges inward, or from its centre outward.',
	keywords: ['glow', 'inner', 'edge', 'light', 'title', 'alpha'],
	params: [
		fxParam.choice('technique', 'Technique', ['soft', 'precise'], ['Soft', 'Precise'], 'soft'),
		fxParam.choice('origin', 'Source', ['edge', 'center'], ['Edge', 'Center'], 'edge'),
		px('radius', 'Radius', 18, 200),
		INTENSITY(),
		fxParam.percent('choke', 'Choke', 0),
		fxParam.color('color', 'Color', [1, 0.96, 0.63, 1]),
		fxParam.choice('blend', 'Blend', ['normal', 'screen', 'add'], ['Normal', 'Screen', 'Add'], 'screen'),
		fxParam.percent('opacity', 'Opacity', 100),
	],
	layers: (p) => [
		SOURCE_FACE,
		{
			type: 'innerGlow',
			params: {
				...pick(p, ['technique', 'origin', 'radius', 'intensity', 'choke', 'blend', 'opacity']),
				paint: colorPaint(p.color),
			},
		},
	],
});

export const INNER_SHADOW = defineLookEffect({
	id: 'jasper.inner-shadow',
	label: 'Inner Shadow',
	category: 'Perspective',
	description:
		'A shadow inside the clip’s alpha, cast inward by the edge facing the light (0° = right, clockwise).',
	keywords: ['shadow', 'inner', 'inset', 'depth', 'title', 'alpha'],
	params: [
		fxParam.angle('angle', 'Direction', 60),
		USE_GLOBAL_LIGHT(),
		px('distance', 'Distance', 6, 100),
		px('blur', 'Blur', 8, 100),
		fxParam.percent('choke', 'Choke', 0),
		fxParam.color('color', 'Color', [0, 0, 0, 1]),
		fxParam.percent('opacity', 'Opacity', 60),
	],
	layers: (p) => [
		SOURCE_FACE,
		{
			type: 'innerShadow',
			params: {
				...pick(p, ['angle', 'distance', 'blur', 'choke', 'opacity']),
				useLight: p.useGlobalLight === true,
				paint: colorPaint(p.color, [0, 0, 0, 1]),
			},
		},
	],
});

const RAINBOW = [
	[1, 0, 0, 1],
	[1, 1, 0, 1],
	[0, 1, 0, 1],
	[0, 1, 1, 1],
	[0, 0, 1, 1],
	[1, 0, 1, 1],
	[1, 0, 0, 1],
] as const;

export const CONTOUR_LINES = defineLookEffect({
	id: 'jasper.contour-lines',
	label: 'Contour Lines',
	category: 'Stylize',
	description:
		'Glowing lines that follow the clip’s alpha at even spacing, inside it or around it, coloured across the clip or by line, like an edge-lit panel.',
	keywords: ['lines', 'outline', 'neon', 'light guide', 'edge lit', 'rings', 'title'],
	params: [
		fxParam.choice(
			'mode',
			'Lines',
			['inside', 'outside', 'both'],
			['Inside', 'Around', 'Inside and Around'],
			'inside',
		),
		fxParam.number('count', 'Line Count', 6, { min: 1, max: 40, step: 1 }),
		px('spacing', 'Spacing', 9, 100, 0.1),
		px('lineWidth', 'Line Width', 2.5, 40),
		px('offset', 'First Line', 4, 100),
		fxParam.percent('falloff', 'Falloff', 60),
		fxParam.toggle('rainbow', 'Rainbow', true),
		fxParam.color('colorA', 'Start Color', [0.2, 0.9, 1, 1]),
		fxParam.color('colorB', 'End Color', [1, 0.3, 0.8, 1]),
		fxParam.choice('colorBy', 'Colour By', ['across', 'line'], ['Across the Clip', 'Line Number'], 'across'),
		fxParam.angle('angle', 'Gradient Angle', 315),
		fxParam.number('intensity', 'Intensity', 1.2, { min: 0, max: 100, softMax: 6, step: 0.01 }),
		px('glowSize', 'Glow Size', 12, 200),
		fxParam.number('glow', 'Glow Amount', 0.8, { min: 0, max: 100, softMax: 4, step: 0.01 }),
		fxParam.percent('dim', 'Dim Picture', 0),
	],
	layers: (p) => {
		const stops =
			p.rainbow === false
				? ([
						[0, p.colorA],
						[1, p.colorB],
					] as const)
				: RAINBOW.map((c, i) => [i / (RAINBOW.length - 1), c] as const);
		return [
			SOURCE_FACE,
			{
				type: 'contourLines',
				params: {
					...pick(p, [
						'mode',
						'count',
						'spacing',
						'lineWidth',
						'offset',
						'falloff',
						'colorBy',
						'intensity',
						'glowSize',
						'glow',
						'dim',
					]),
					paint: gradientPaint('linear', num(p.angle), stops),
				},
			},
		];
	},
});

export const PERSPECTIVE_SHADOW = defineLookEffect({
	id: 'jasper.perspective-shadow',
	label: 'Perspective Shadow',
	category: 'Perspective',
	description:
		'A shadow cast on a floor at the base of the clip’s alpha: sheared, squashed, narrowing, blurring and fading with distance. Up (−90°) falls behind the clip, down (90°) in front.',
	keywords: ['shadow', 'cast', 'floor', 'ground', 'depth', 'title'],
	params: [
		fxParam.angle('angle', 'Direction', -55),
		USE_GLOBAL_LIGHT(),
		px('length', 'Length', 230, 1000),
		fxParam.percent('foreshorten', 'Foreshorten', 100),
		fxParam.percent('convergence', 'Perspective', 35),
		px('blurNear', 'Blur Near', 2, 100),
		px('blurFar', 'Blur Far', 22, 300),
		fxParam.percent('fade', 'Fade', 75),
		px('floorOffset', 'Floor Offset', 0, 300, -MAX_REACH),
		fxParam.color('color', 'Color', [0, 0, 0, 1]),
		fxParam.percent('opacity', 'Opacity', 70),
	],
	layers: (p) => [
		{
			type: 'shadow',
			params: {
				...pick(p, ['angle', 'foreshorten', 'convergence', 'blurNear', 'fade', 'floorOffset', 'opacity']),
				kind: 'perspective',
				useLight: p.useGlobalLight === true,
				distance: num(p.length),
				blur: num(p.blurFar),
				paint: colorPaint(p.color, [0, 0, 0, 1]),
			},
		},
		SOURCE_FACE,
	],
});

export const FLOOR_REFLECTION = defineLookEffect({
	id: 'jasper.floor-reflection',
	label: 'Floor Reflection',
	category: 'Perspective',
	description:
		'A mirrored copy below the clip’s alpha, as on a glossy floor, fading and blurring with distance.',
	keywords: ['reflection', 'mirror', 'floor', 'glossy', 'title'],
	params: [
		px('gap', 'Gap', 4, 100, -MAX_REACH),
		px('fade', 'Fade Length', 150, 1000),
		px('blur', 'Blur Growth', 14, 200),
		fxParam.number('falloff', 'Falloff', 1.4, { min: 0.3, max: 5, step: 0.05 }),
		fxParam.number('scale', 'Vertical Scale', 1, { min: 0.2, max: 2, step: 0.01 }),
		fxParam.percent('opacity', 'Opacity', 45),
	],
	layers: (p) => [
		SOURCE_FACE,
		{ type: 'reflection', params: pick(p, ['gap', 'fade', 'blur', 'falloff', 'scale', 'opacity']) },
	],
});

export const GRADIENT_OVERLAY = defineLookEffect({
	id: 'jasper.gradient-overlay',
	label: 'Gradient Overlay',
	category: 'Stylize',
	description:
		'Recolours the clip with a gradient in linear light, keeping its alpha: fitted to its alpha bounds, or a band of fixed length moved across it (a glint).',
	keywords: ['gradient', 'overlay', 'color', 'fill', 'recolor', 'glint', 'sweep', 'title'],
	params: [
		fxParam.color('startColor', 'Start Color', [1, 0.85, 0.3, 1]),
		fxParam.color('middleColor', 'Middle Color', [1, 0.5, 0.1, 1]),
		fxParam.color('endColor', 'End Color', [0.55, 0.15, 0, 1]),
		fxParam.percent('middle', 'Middle Position', 50),
		fxParam.choice('shape', 'Shape', ['linear', 'radial'], ['Linear', 'Radial'], 'linear'),
		fxParam.choice('style', 'Style', ['fit', 'band'], ['Fit to Alpha', 'Band'], 'fit'),
		fxParam.angle('angle', 'Angle', 90),
		fxParam.number('scale', 'Scale', 100, { min: 1, max: 1000, softMax: 300, step: 0.1 }, { unit: '%' }),
		fxParam.number('offset', 'Offset', 0, { min: -200, max: 200, step: 0.1 }, { unit: '%' }),
		px('bandLength', 'Band Length', 200, 1000, 0.1),
		fxParam.number('position', 'Position', 0, { min: -100, max: 100, step: 0.1 }, { unit: '%' }),
		fxParam.choice('wrap', 'Wrap', ['clamp', 'repeat', 'mirror'], ['Clamp', 'Repeat', 'Mirror'], 'clamp'),
		fxParam.percent('amount', 'Amount', 100),
		fxParam.choice('blend', 'Blend', OVERLAY_BLENDS, OVERLAY_BLEND_LABELS, 'normal'),
	],
	layers: (p) => [
		SOURCE_FACE,
		{
			type: 'gradientOverlay',
			params: {
				...pick(p, ['style', 'scale', 'offset', 'bandLength', 'position', 'wrap', 'amount', 'blend']),
				paint: gradientPaint(p.shape === 'radial' ? 'radial' : 'linear', num(p.angle), [
					[0, p.startColor],
					[Math.min(1, Math.max(0, num(p.middle, 50) / 100)), p.middleColor],
					[1, p.endColor],
				]),
			},
		},
	],
});

export const SHADED_EXTRUDE = defineLookEffect({
	id: 'jasper.shaded-extrude',
	label: 'Shaded Extrude',
	category: 'Perspective',
	description:
		'Stacks the clip’s alpha along a direction with shaded, gradient sides behind it. With Shading and Edge Darkening at 0 and some Fade it is a flat long shadow.',
	keywords: ['extrude', '3d', 'depth', 'long shadow', 'block', 'title'],
	params: [
		fxParam.angle('angle', 'Direction', 75),
		px('depth', 'Depth', 22, 500),
		fxParam.color('frontColor', 'Front Color', [0.85, 0.48, 0, 1]),
		fxParam.color('backColor', 'Back Color', [0.29, 0.09, 0, 1]),
		USE_GLOBAL_LIGHT(),
		fxParam.angle('lightAngle', 'Light From', 240),
		fxParam.percent('shading', 'Shading', 70),
		fxParam.percent('edge', 'Edge Darkening', 55),
		fxParam.percent('fade', 'Fade', 0),
		fxParam.percent('opacity', 'Opacity', 100),
	],
	layers: (p) => [
		{
			type: 'extrude',
			params: {
				...pick(p, ['angle', 'depth', 'lightAngle', 'shading', 'edge', 'fade', 'opacity']),
				useLight: p.useGlobalLight === true,
				paint: gradientPaint('linear', 0, [
					[0, p.frontColor],
					[1, p.backColor],
				]),
			},
		},
		SOURCE_FACE,
	],
});

export const KEYLINE = defineLookEffect({
	id: 'jasper.keyline',
	label: 'Keyline',
	category: 'Stylize',
	description:
		'An outline traced from the clip’s alpha, behind it and just outside it: a thin line separating a title from the background, or a stroke. Several make stacked strokes.',
	keywords: ['stroke', 'outline', 'border', 'edge', 'rim', 'title'],
	params: [
		px('width', 'Width', 2, 100),
		px('offset', 'Offset', 0, 100),
		fxParam.color('color', 'Color', [0.04, 0.02, 0.02, 1]),
		fxParam.percent('opacity', 'Opacity', 100),
		fxParam.percent('softness', 'Softness', 0),
	],
	layers: (p) => [
		{
			type: 'rim',
			params: {
				...pick(p, ['width', 'offset', 'opacity', 'softness']),
				paint: colorPaint(p.color, [0, 0, 0, 1]),
			},
		},
		SOURCE_FACE,
	],
});

export const TITLE_LOOK_EFFECTS: readonly EffectSpec[] = [
	DEEP_GLOW,
	INNER_GLOW,
	INNER_SHADOW,
	CONTOUR_LINES,
	PERSPECTIVE_SHADOW,
	FLOOR_REFLECTION,
	GRADIENT_OVERLAY,
	SHADED_EXTRUDE,
	KEYLINE,
];
