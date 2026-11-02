// Spec 19 TL-113: Photoshop layer styles as looks. What maps, what is approximated and that nothing is lost silently; the
// parser's own tests are in apps/engine/test/ps-styles.test.ts.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	appearanceFromRecipe,
	LookRecipeSchema,
	mapPsStyle,
	type PsStyle,
	PsStyleSchema,
	psColorRgb,
	titleLayerType,
} from '../src/index.ts';

const style = (effects: PsStyle['effects'], over: Partial<PsStyle> = {}): PsStyle => ({
	effects,
	baseColor: null,
	ppi: 72,
	globalAngle: 120,
	globalAltitude: 30,
	fillOpacity: 1,
	knockout: false,
	...over,
});
const px = (value: number) => ({ units: 'Pixels', value });
const red = { r: 255, g: 0, b: 0 };
const blue = { r: 0, g: 0, b: 255 };

const ids = () => {
	let n = 0;
	return () => `apl_${n++}`;
};

/** Every report line must name something, and the recipe must be storable. */
function mapped(s: PsStyle, size = 100) {
	const out = mapPsStyle(s, size);
	expect(LookRecipeSchema.safeParse(out.recipe).success).toBe(true);
	expect(() => appearanceFromRecipe(out.recipe, ids())).not.toThrow();
	return out;
}
const layer = (r: ReturnType<typeof mapped>, type: string) => r.recipe.layers.find((l) => l.type === type);

describe('layer styles (TL-113)', () => {
	it('stroke becomes a rim in percent of the size', () => {
		const r = mapped(
			style({ stroke: [{ enabled: true, size: px(8), color: red, position: 'outside', fillType: 'color' }] }),
			200,
		);
		expect(layer(r, 'rim')!.params!.width).toBe(4);
		expect(r.report.mapped).toContain('Stroke');
		expect(r.recipe.palette?.keyline?.slice(0, 3)).toEqual([1, 0, 0]);
	});

	it('strokes stack cumulatively, outermost at the bottom; a hidden one is named', () => {
		const r = mapped(
			style({
				stroke: [
					{ enabled: true, size: px(6), color: red, position: 'outside', fillType: 'color' },
					{ enabled: true, size: px(10), color: blue, position: 'outside', fillType: 'color' },
					{ enabled: true, size: px(4), color: blue, position: 'outside', fillType: 'color' },
				],
			}),
		);
		const rims = r.recipe.layers.filter((l) => l.type === 'rim');
		expect(rims.map((l) => l.params!.width)).toEqual([4, 6]);
		expect(r.report.unsupported.join()).toContain('hidden under a wider stroke');
		expect(r.recipe.layers.findIndex((l) => l.type === 'rim')).toBeLessThan(
			r.recipe.layers.findIndex((l) => l.type === 'face'),
		);
	});

	it('centre and inside strokes say what they became', () => {
		const r = mapped(
			style({ stroke: [{ enabled: true, size: px(10), position: 'center', fillType: 'color' }] }),
		);
		expect(layer(r, 'rim')!.params!.width).toBe(5);
		expect(r.report.approximated.join()).toContain('centre stroke');
		const inside = mapped(
			style({ stroke: [{ enabled: true, size: px(10), position: 'inside', fillType: 'color' }] }),
		);
		if (!titleLayerType('inline')) expect(inside.report.approximated.join()).toContain('inside stroke');
	});

	it('a Shape Burst gradient stroke maps to a shape gradient', () => {
		const r = mapped(
			style({
				stroke: [
					{
						enabled: true,
						size: px(10),
						position: 'outside',
						fillType: 'gradient',
						gradient: {
							style: 'shapeburst',
							angle: 90,
							name: 'G',
							type: 'solid',
							colorStops: [
								{ color: red, location: 0, midpoint: 0.5 },
								{ color: blue, location: 1, midpoint: 0.5 },
							],
							opacityStops: [{ opacity: 1, location: 0 }],
						},
					},
				],
			}),
		);
		const p = layer(r, 'rim')!.params!.paint as { kind: string; gradient: { type: string } };
		expect(p.kind).toBe('gradient');
		expect(p.gradient.type).toBe('shape');
	});

	it('gradient geometry: clockwise angle, reflected mirrored exactly, midpoints, opacity stops, diamond noted', () => {
		const gradient = {
			name: 'G',
			type: 'solid',
			colorStops: [
				{ color: red, location: 0, midpoint: 0.5 },
				{ color: blue, location: 1, midpoint: 0.25 },
			],
			opacityStops: [
				{ opacity: 1, location: 0 },
				{ opacity: 0, location: 1 },
			],
		};
		const linear = mapped(
			style({ gradientOverlay: [{ enabled: true, gradient, type: 'linear', angle: 90 }] }),
		);
		const paint = layer(linear, 'face')!.params!.paint as {
			gradient: { angle: number; stops: { at: number; alpha?: number }[] };
		};
		expect(paint.gradient.angle).toBe(270);
		expect(paint.gradient.stops.map((s) => s.at)).toEqual([0, 0.25, 1]);
		expect(paint.gradient.stops[2]!.alpha).toBe(0);
		const reflected = mapped(style({ gradientOverlay: [{ enabled: true, gradient, type: 'reflected' }] }));
		const rs = (
			layer(reflected, 'face')!.params!.paint as { gradient: { type: string; stops: { at: number }[] } }
		).gradient;
		expect(rs.type).toBe('linear');
		expect(rs.stops[0]!.at).toBe(0);
		expect(rs.stops.at(-1)!.at).toBe(1);
		const diamond = mapped(style({ gradientOverlay: [{ enabled: true, gradient, type: 'diamond' }] }));
		expect(diamond.report.approximated.join()).toContain('Diamond');
	});

	it('a noise gradient is named, never dropped silently', () => {
		const r = mapped(
			style({ gradientOverlay: [{ enabled: true, gradient: { name: 'Spectrum', type: 'noise' } }] }),
		);
		expect(r.report.unsupported.join()).toContain('noise gradient "Spectrum"');
	});

	it('overlays stack over the base: an opaque one replaces it, a translucent one keeps the clip below', () => {
		const opaque = mapped(style({ solidFill: [{ enabled: true, color: red, opacity: 1 }] }));
		expect(opaque.recipe.layers.filter((l) => l.type === 'face')).toHaveLength(1);
		const glass = mapped(style({ solidFill: [{ enabled: true, color: red, opacity: 0.4 }] }));
		const faces = glass.recipe.layers.filter((l) => l.type === 'face');
		expect(faces).toHaveLength(2);
		expect((faces[0]!.params!.paint as { kind: string }).kind).toBe('source');
		expect(faces[1]!.params!.opacity).toBe(40);
	});

	it('fill opacity is the base fill only', () => {
		const r = mapped(style({ dropShadow: [{ enabled: true }] }, { fillOpacity: 0.25 }));
		expect(layer(r, 'face')!.params!.opacity).toBe(25);
		expect(layer(r, 'shadow')!.params!.opacity).toBe(75);
		expect(r.report.mapped.join()).toContain('Fill Opacity 25');
	});

	it('drop shadow: falls away from the light, spread from choke, global light follows the look', () => {
		const r = mapped(
			style({
				dropShadow: [
					{
						enabled: true,
						angle: 120,
						distance: px(10),
						size: px(20),
						choke: px(50),
						color: red,
						opacity: 0.5,
					},
				],
			}),
		);
		const s = layer(r, 'shadow')!.params!;
		expect(s.angle).toBe(60);
		expect(s.distance).toBe(10);
		expect(s.blur).toBe(10);
		expect(s.spread).toBe(10);
		expect(s.opacity).toBe(50);
		const g = mapped(
			style(
				{ dropShadow: [{ enabled: true, useGlobalLight: true }] },
				{ globalAngle: 90, globalAltitude: 40 },
			),
		);
		expect(layer(g, 'shadow')!.params!.useLight).toBe(true);
		expect(g.recipe.light).toEqual({ source: 'look', angle: 270, altitude: 40 });
	});

	it('outer glow: radius and intensity, spread and blend noted', () => {
		const r = mapped(
			style({
				outerGlow: {
					enabled: true,
					size: px(30),
					opacity: 0.6,
					color: blue,
					choke: px(20),
					blendMode: 'multiply',
				},
			}),
		);
		expect(layer(r, 'glow')!.params!.radius).toBe(30);
		expect(layer(r, 'glow')!.params!.intensity).toBe(60);
		expect(r.report.approximated.join()).toContain('spread 20 %');
		expect(r.report.approximated.join()).toContain('multiply');
	});

	it('every effect lands in a list, even with what this build lacks', () => {
		const r = mapped(
			style(
				{
					bevel: { enabled: true, technique: 'chisel soft', size: px(5), useTexture: true },
					satin: { enabled: true },
					innerGlow: { enabled: true, source: 'center', noise: 0.5 },
					innerShadow: [{ enabled: true }],
					patternOverlay: { enabled: true, pattern: { name: 'Bricks' } },
				},
				{ knockout: true },
			),
		);
		const all = [...r.report.mapped, ...r.report.approximated, ...r.report.unsupported].join('\n');
		for (const word of [
			'Bevel',
			'Satin',
			'Inner Glow',
			'Inner Shadow',
			'Pattern Overlay: "Bricks"',
			'Knockout',
		])
			expect(all).toContain(word);
	});

	it('names a layer type the build does not have, and the look still imports', () => {
		if (titleLayerType('innerGlow')) return;
		const r = mapped(style({ innerGlow: { enabled: true } }));
		expect(r.report.unsupported.join()).toContain('this build has no innerGlow layer');
		expect(layer(r, 'innerGlow')).toBeUndefined();
	});

	it('disabled effects are not imported', () => {
		const r = mapped(style({ stroke: [{ enabled: false, size: px(9) }] }));
		expect(layer(r, 'rim')).toBeUndefined();
		expect(r.report.mapped).not.toContain('Stroke');
	});

	it('an effects-off file says so', () => {
		expect(mapped(style({ disabled: true })).report.unsupported.join()).toContain('switched off');
	});

	it('physical units and Scale Effects scale sizes', () => {
		const r = mapped(
			style(
				{
					scale: 2,
					stroke: [
						{ enabled: true, position: 'outside', fillType: 'color', size: { units: 'Points', value: 3 } },
					],
				},
				{ ppi: 144 },
			),
		);
		expect(layer(r, 'rim')!.params!.width).toBe(12);
	});

	it('refuses a size of zero', () => {
		expect(() => mapPsStyle(style({}), 0)).toThrow(RangeError);
		expect(() => mapPsStyle(style({}), Number.NaN)).toThrow(RangeError);
	});

	it('colour models come out in sRGB and stay in range', () => {
		expect(psColorRgb({ r: 255, g: 0, b: 128 })).toEqual([1, 0, 128 / 255]);
		expect(psColorRgb({ fr: 2, fg: -1, fb: 0.5 })).toEqual([1, 0, 0.5]);
		const lab = psColorRgb({ l: 1, a: 0, b: 0 });
		expect(lab[0]).toBeCloseTo(1, 1);
		const hsb = psColorRgb({ h: 0, s: 1, b: 1 });
		expect(hsb.map((v) => Math.round(v))).toEqual([1, 0, 0]);
		const cmyk = psColorRgb({ c: 0, m: 255, y: 255, k: 0 });
		expect(cmyk).toEqual([1, 0, 0]);
	});

	it('fuzz: any style that passes the schema maps to a storable recipe', () => {
		const color = fc.oneof(
			fc.record({
				r: fc.double({ noNaN: true, noDefaultInfinity: true }),
				g: fc.double({ noNaN: true, noDefaultInfinity: true }),
				b: fc.double({ noNaN: true, noDefaultInfinity: true }),
			}),
			fc.record({ k: fc.double({ noNaN: true, noDefaultInfinity: true }) }),
		);
		const units = fc.record({
			units: fc.constantFrom('Pixels', 'Points', 'Inches', 'junk'),
			value: fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
		});
		const stop = fc.record({
			color,
			location: fc.double({ noNaN: true, noDefaultInfinity: true }),
			midpoint: fc.double({ noNaN: true, noDefaultInfinity: true }),
		});
		const gradient = fc.record(
			{
				name: fc.string({ maxLength: 8 }),
				type: fc.constantFrom('solid', 'noise', 'x'),
				colorStops: fc.array(stop, { maxLength: 40 }),
				opacityStops: fc.array(
					fc.record({
						opacity: fc.double({ noNaN: true, noDefaultInfinity: true }),
						location: fc.double({ noNaN: true, noDefaultInfinity: true }),
					}),
					{ maxLength: 8 },
				),
			},
			{ requiredKeys: ['type'] },
		);
		const stroke = fc.record(
			{
				enabled: fc.boolean(),
				size: units,
				color,
				position: fc.constantFrom('outside', 'inside', 'center', 'x'),
				fillType: fc.constantFrom('color', 'gradient', 'pattern', 'x'),
				opacity: fc.double({ noNaN: true, noDefaultInfinity: true }),
				gradient: gradient.map((g) => ({ ...g, style: 'shapeburst' })),
			},
			{ requiredKeys: [] },
		);
		const fx = fc.record(
			{
				enabled: fc.boolean(),
				color,
				size: units,
				distance: units,
				choke: units,
				opacity: fc.double({ noNaN: true, noDefaultInfinity: true }),
				angle: fc.double({ noNaN: true, noDefaultInfinity: true }),
				gradient,
				blendMode: fc.string({ maxLength: 8 }),
			},
			{ requiredKeys: [] },
		);
		fc.assert(
			fc.property(
				fc.record(
					{
						stroke: fc.array(stroke, { maxLength: 8 }),
						dropShadow: fc.array(fx, { maxLength: 4 }),
						innerShadow: fc.array(fx, { maxLength: 3 }),
						outerGlow: fx,
						innerGlow: fx,
						solidFill: fc.array(fx, { maxLength: 4 }),
						gradientOverlay: fc.array(fx, { maxLength: 4 }),
						scale: fc.double({ noNaN: true, noDefaultInfinity: true }),
					},
					{ requiredKeys: [] },
				),
				fc.double({ min: 0.01, max: 1e6, noNaN: true }),
				(effects, size) => {
					const parsed = PsStyleSchema.safeParse({
						effects,
						baseColor: null,
						ppi: 72,
						globalAngle: 120,
						globalAltitude: 30,
						fillOpacity: 1,
						knockout: false,
					});
					if (!parsed.success) return;
					const r = mapPsStyle(parsed.data, size);
					expect(() => appearanceFromRecipe(r.recipe, ids())).not.toThrow();
					expect(LookRecipeSchema.safeParse(r.recipe).success).toBe(true);
				},
			),
			{ numRuns: 300 },
		);
	});
});
