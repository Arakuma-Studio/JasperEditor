// @vitest-environment node
// Spec 19, stream Glows, in real WebGL2 (headless Chrome, SwiftShader): what each layer type and effect is for, against
// independent numbers. Fingerprints, the perturbation check, padding and the two-scale test of every layer type are in
// `title-look-gl.test.ts`, of every effect in `fx-gl.test.ts` and below.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	defaultEffectRegistry,
	dgOctaves,
	type EffectSpec,
	type LookRecipe,
	type Paint,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeSheet } from './title-look-glows-sheet.ts';
import {
	CHROME,
	type EffectRequest,
	type LookImage,
	type LookPage,
	type LookRequest,
	layerCrop,
	lumaOver,
	openLookPage,
	pixel,
	resampleLuma,
	ssim,
} from './title-look-harness.ts';

const here = dirname(fileURLToPath(import.meta.url));

const flat = (r: number, g: number, b: number, a = 1): Paint => ({ kind: 'color', color: [r, g, b, a] });
const WHITE = flat(1, 1, 1);
const RED = flat(1, 0, 0);

const TEXT: LookRequest['input'] = { kind: 'text', text: 'Title', size: 96 };
const BOX = { width: 300, height: 130 };
const RECT = { kind: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5 } as const;
const R_BOX = { width: 320, height: 160 };

const palette = {
	face: [0.95, 0.75, 0.2, 1],
	keyline: [0.1, 0.2, 0.9, 1],
	shadow: [0, 0, 0, 1],
	glow: [1, 0.25, 0.65, 1],
	accent1: [0.2, 0.8, 1, 1],
	accent2: [1, 0.3, 0.8, 1],
	accent3: [1, 0.85, 0.2, 1],
} as NonNullable<LookRecipe['palette']>;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The picture composited in the signal over black, as linear light (what a sequence shows there). */
const lightAt = (img: LookImage, x: number, y: number, k = 0) => {
	const p = pixel(img, x, y);
	return toLinear((p[k]! / 255) * (p[3]! / 255));
};
/** Pixels are read back straight: the signal over black is colour × alpha. */
function lightSum(img: LookImage, k = 0) {
	let sum = 0;
	for (let i = 0; i < img.width * img.height; i++) {
		const a = img.data[i * 4 + 3]! / 255;
		sum += toLinear((img.data[i * 4 + k]! / 255) * a);
	}
	return sum;
}
/** Horizontal second moment of the light around its centroid, per axis (x, y). */
function moments(img: LookImage, k = 1) {
	let m = 0;
	let mx = 0;
	let my = 0;
	for (let y = 0; y < img.height; y++)
		for (let x = 0; x < img.width; x++) {
			const i = (y * img.width + x) * 4;
			const l = toLinear((img.data[i + k]! / 255) * (img.data[i + 3]! / 255));
			m += l;
			mx += l * x;
			my += l * y;
		}
	mx /= m;
	my /= m;
	let vx = 0;
	let vy = 0;
	for (let y = 0; y < img.height; y++)
		for (let x = 0; x < img.width; x++) {
			const i = (y * img.width + x) * 4;
			const l = toLinear((img.data[i + k]! / 255) * (img.data[i + 3]! / 255));
			vx += l * (x - mx) ** 2;
			vy += l * (y - my) ** 2;
		}
	return { x: vx / m, y: vy / m, mass: m };
}

/** Largest alpha on the outermost pixels of the canvas: a clipped glow leaves light there. */
function edgeAlpha(img: LookImage) {
	let edge = 0;
	for (let x = 0; x < img.width; x++)
		edge = Math.max(edge, pixel(img, x, 0)[3], pixel(img, x, img.height - 1)[3]);
	for (let y = 0; y < img.height; y++)
		edge = Math.max(edge, pixel(img, 0, y)[3], pixel(img, img.width - 1, y)[3]);
	return edge;
}

const meanDiff = (a: LookImage, b: LookImage) => {
	let sum = 0;
	for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!);
	return sum / a.data.length;
};

describe.runIf(!!CHROME && process.env.FX_GL !== '0')('Title Looks: glows', { timeout: 240_000 }, () => {
	let tl: LookPage;

	beforeAll(async () => {
		tl = await openLookPage(here);
	}, 120_000);

	afterAll(async () => {
		await tl?.browser.close();
	});

	const look = (layers: LookRecipe['layers'], over: Partial<LookRequest> = {}) =>
		tl.render({ recipe: { palette, layers }, input: TEXT, box: BOX, ...over });
	/** On the exact rectangle, unit 100 px: 1 % = 1 px; the rectangle is 160 × 80 at (80, 40) in the box. */
	const onRect = (layers: LookRecipe['layers'], over: Partial<LookRequest> = {}) =>
		tl.render({ recipe: { palette, layers }, input: RECT, box: R_BOX, unitPx: 100, ...over });
	const face = (paint: Paint = flat(0.95, 0.75, 0.2)) => ({ type: 'face', params: { paint } });

	describe('deepGlow', () => {
		const DOT = { kind: 'rect', x: 0.48, y: 0.46, w: 0.04, h: 0.08 } as const; // 40 × 40 in a 1000 × 500 box
		const DOT_BOX = { width: 1000, height: 500 };
		const lit = (params: Record<string, unknown>, over: Partial<LookRequest> = {}) =>
			tl.render({
				recipe: {
					layers: [
						{
							type: 'deepGlow',
							params: { paint: WHITE, exposure: 0, highlightShift: 0, radius: 60, ...params },
						},
					],
				},
				input: DOT,
				box: DOT_BOX,
				unitPx: 100,
				...over,
			});

		it('holds its energy: Radius and Falloff reshape the light, the total stays the emitter’s', async () => {
			const totals: number[] = [];
			for (const [radius, falloff] of [
				[40, 50],
				[120, 50],
				[120, 10],
				[120, 90],
			] as const)
				totals.push(lightSum(await lit({ radius, falloff })));
			// A 40 × 40 emitter of 1: 1600. Light above 1 clips and faint tails fall under 8 bits: a few percent.
			for (const t of totals) {
				expect(t).toBeGreaterThan(1600 * 0.88);
				expect(t).toBeLessThan(1600 * 1.05);
			}
			const r = await lit({ radius: 120, intensity: 0.5 });
			expect(lightSum(r) / totals[1]!).toBeCloseTo(0.5, 1);
		});

		it('has the variance of its octaves at any resolution: the pyramid’s own blur is compensated', async () => {
			const radius = 240;
			const o = dgOctaves(radius, 50, 0);
			const wanted = o.reduce((s, c) => s + c.weight * c.sigma[1] ** 2, 0) + 40 ** 2 / 12;
			for (const k of [1, 0.5, 0.25]) {
				const m = moments(await lit({ radius }, { pxScale: k }));
				// Canvas px² back to layer px²; a tail past 3σ falls under 8 bits, so a little is missing, never added.
				expect(m.x / k ** 2 / wanted).toBeGreaterThan(0.85);
				expect(m.x / k ** 2 / wanted).toBeLessThan(1.04);
				expect(Math.abs(m.x - m.y) / m.x).toBeLessThan(0.03);
			}
		});

		it('Exposure is in stops, and light below the threshold does not emit', async () => {
			const at = (img: LookImage) => lightAt(img, img.box.x + 500, img.box.y + 250 + 40);
			const one = await lit({ exposure: -2 });
			const two = await lit({ exposure: -1 });
			expect(at(two) / at(one)).toBeCloseTo(2, 0);
			expect(Math.abs(at(two) / at(one) - 2)).toBeLessThan(0.2);
			// A 50 % grey is 0.21 in linear light: under a threshold of 0.5 with a thin knee nothing comes out…
			const grey = flat(0.5, 0.5, 0.5);
			const dark = await lit({ paint: grey, threshold: 0.5, knee: 0.05 });
			expect(lightSum(dark)).toBe(0);
			// …and white, 0.5 above it, emits half its light (only the excess).
			const full = await lit({ threshold: 0 });
			const half = await lit({ threshold: 0.5, knee: 0.05 });
			expect(lightSum(half) / lightSum(full)).toBeGreaterThan(0.44);
			expect(lightSum(half) / lightSum(full)).toBeLessThan(0.56);
		});

		it('over-exposed light burns towards white through its spectral neighbours, and nothing else changes', async () => {
			const blue = flat(0.1, 0.2, 1);
			const hot = (highlightShift: number) =>
				look([
					face(blue),
					{ type: 'deepGlow', params: { from: 'stack', exposure: 2, intensity: 0, highlightShift } },
				]);
			const plain = await hot(0);
			const burnt = await hot(100);
			const y = plain.box.y + plain.box.h / 2;
			const x = plain.box.x + plain.box.w / 2;
			// Find a solid part of the text.
			let at = [x, y];
			for (let i = 0; i < plain.width; i++)
				if (
					pixel(plain, i, y)[3] === 255 &&
					pixel(plain, i + 2, y)[3] === 255 &&
					pixel(plain, i - 2, y)[3] === 255
				) {
					at = [i, y];
					break;
				}
			// Without the shift the blue channel clips and the colour stays blue; with it, green and red come up.
			const p0 = pixel(plain, at[0]!, at[1]!);
			const p1 = pixel(burnt, at[0]!, at[1]!);
			expect(p1[1]).toBeGreaterThan(p0[1] + 20);
			expect(p1[1]).toBeGreaterThan(p1[0]); // cyan on the way to white, not magenta
			expect(p1[2]).toBe(255);
			// A picture nothing pushed over 1 stays as it was: the response is the identity there.
			const dim = (highlightShift: number) =>
				look([
					face(flat(0.4, 0.3, 0.2)),
					{ type: 'deepGlow', params: { from: 'stack', exposure: 0, intensity: 0, highlightShift } },
				]);
			expect(meanDiff(await dim(0), await dim(100))).toBe(0);
		});

		it('chromatic scatter spreads red wider than blue, and the sign swaps them', async () => {
			const tail = (img: LookImage, k: number) => lightAt(img, img.box.x + 500 + 90, img.box.y + 250, k);
			const plain = await lit({ radius: 200 });
			const wide = await lit({ radius: 200, chroma: 100 });
			const swap = await lit({ radius: 200, chroma: -100 });
			expect(Math.abs(tail(plain, 0) - tail(plain, 2))).toBeLessThan(tail(plain, 0) * 0.05);
			expect(tail(wide, 0)).toBeGreaterThan(tail(wide, 2) * 1.3);
			expect(tail(swap, 2)).toBeGreaterThan(tail(swap, 0) * 1.3);
		});

		it('tint replaces the colour, keeps the brightest channel, inner to outer over the radius', async () => {
			const gradient: Paint = {
				kind: 'gradient',
				gradient: {
					type: 'linear',
					span: 'block',
					angle: 0,
					stops: [
						{ at: 0, paint: { color: [1, 1, 1, 1] } },
						{ at: 1, paint: { color: [1, 0, 0, 1] } },
					],
				},
			};
			const plain = await lit({ radius: 200, exposure: 5 });
			const tinted = await lit({ radius: 200, exposure: 5, tintAmount: 100, tint: gradient });
			const x = plain.box.x + 500;
			const y = plain.box.y + 250;
			// Far out it is the outer stop: red, as bright as the untinted light.
			const far = 160;
			expect(lightAt(tinted, x + far, y, 1)).toBeLessThan(lightAt(tinted, x + far, y, 0) * 0.3);
			expect(lightAt(tinted, x + far, y, 0) / lightAt(plain, x + far, y, 0)).toBeGreaterThan(0.8);
			// Near the emitter the narrow octaves count: more of the inner stop, white, than far out.
			const green = (d: number) => lightAt(tinted, x + d, y, 1) / lightAt(tinted, x + d, y, 0);
			expect(green(24)).toBeGreaterThan(green(far) * 2);
		});

		it('Glow Over Face keeps the face or lights it, and light on nothing stays visible', async () => {
			const off = await onRect([
				face(flat(0.2, 0.2, 0.6)),
				{ type: 'deepGlow', params: { radius: 100, paint: WHITE, onFace: 0, highlightShift: 0 } },
			]);
			const on = await onRect([
				face(flat(0.2, 0.2, 0.6)),
				{ type: 'deepGlow', params: { radius: 100, paint: WHITE, onFace: 100, highlightShift: 0 } },
			]);
			const cx = off.box.x + 160;
			const cy = off.box.y + 80;
			expect(pixel(off, cx, cy).slice(0, 3).map(Math.round)).toEqual([51, 51, 153]);
			expect(pixel(on, cx, cy)[0]).toBeGreaterThan(120);
			// Beside the rectangle there is nothing but light: it has alpha, so a sequence shows it.
			const beside = pixel(on, off.box.x + 60, cy);
			expect(beside[3]).toBeGreaterThan(40);
			expect(beside[0]).toBeGreaterThan(200); // the colour of the light, not grey with its alpha taken out twice
		});

		it('Layers Below emits only what is there; Shape emits at any position in the stack', async () => {
			const none = await onRect([{ type: 'deepGlow', params: { from: 'stack', radius: 60, paint: WHITE } }]);
			expect(lightSum(none)).toBe(0);
			const behind = await onRect([{ type: 'deepGlow', params: { radius: 60, paint: WHITE } }, face(RED)]);
			expect(pixel(behind, behind.box.x + 60, behind.box.y + 80)[3]).toBeGreaterThan(15);
			expect(pixel(behind, behind.box.x + 160, behind.box.y + 80).slice(0, 3)).toEqual([255, 0, 0]);
		});

		it('an animated radius is continuous: no pop where an octave changes pyramid level', async () => {
			// σ = radius / 3 of the widest octave reaches 32 × 1.25 px at radius 120, where it drops one level.
			let prev: LookImage | null = null;
			let worst = 0;
			for (const radius of [116, 119, 121, 124]) {
				const img = await lit(
					{ radius },
					{ input: { kind: 'rect', x: 0.45, y: 0.4, w: 0.1, h: 0.2 }, box: R_BOX, pad: 130 - radius },
				);
				// Alpha: read-back is straight, so colour means nothing where there is almost no light.
				if (prev)
					for (let i = 3; i < img.data.length; i += 4)
						worst = Math.max(worst, Math.abs(img.data[i]! - prev.data[i]!));
				prev = img;
			}
			expect(worst).toBeLessThanOrEqual(6);
		});

		it('two deep glows in one look each draw their own light', async () => {
			const one = await onRect([{ type: 'deepGlow', params: { radius: 40, paint: RED } }]);
			const both = await onRect([
				{ type: 'deepGlow', params: { radius: 40, paint: RED } },
				{ type: 'deepGlow', params: { radius: 40, paint: flat(0, 0, 1) } },
			]);
			const x = one.box.x + 60;
			const y = one.box.y + 80;
			expect(lightAt(both, x, y, 2)).toBeGreaterThan(0.005);
			expect(lightAt(both, x, y, 0) / lightAt(one, x, y, 0)).toBeGreaterThan(0.6);
			expect(lightAt(both, x, y, 0) / lightAt(one, x, y, 0)).toBeLessThan(2);
		});
	});

	describe('innerShadow', () => {
		it('darkens the edge facing the light, inside the shape only', async () => {
			const img = await onRect([
				face(WHITE),
				{
					type: 'innerShadow',
					params: { angle: 0, distance: 20, blur: 0, opacity: 100, paint: flat(0, 0, 0) },
				},
			]);
			const x0 = img.box.x + 80;
			const x1 = img.box.x + 240;
			const y = img.box.y + 80;
			// The shape shifted right by 20 leaves its left 20 px uncovered: shaded. Its right edge stays lit.
			expect(pixel(img, x0 + 10, y)[0]).toBeLessThan(10);
			expect(pixel(img, x0 + 30, y)[0]).toBeGreaterThan(245);
			expect(pixel(img, x1 - 5, y)[0]).toBeGreaterThan(245);
			expect(pixel(img, x0 - 5, y)[3]).toBe(0);
		});

		it('fades with its glyph, and the blur softens it', async () => {
			const sharp = await onRect([
				face(WHITE),
				{
					type: 'innerShadow',
					params: { angle: 0, distance: 20, blur: 0, opacity: 100, paint: flat(0, 0, 0) },
				},
			]);
			const soft = await onRect([
				face(WHITE),
				{
					type: 'innerShadow',
					params: { angle: 0, distance: 20, blur: 30, opacity: 100, paint: flat(0, 0, 0) },
				},
			]);
			const x = sharp.box.x + 80 + 28;
			const y = sharp.box.y + 80;
			expect(pixel(sharp, x, y)[0]).toBeGreaterThan(245);
			expect(pixel(soft, x, y)[0]).toBeLessThan(245);
			const faded = await tl.render({
				recipe: {
					layers: [
						face(WHITE),
						{
							type: 'innerShadow',
							params: { angle: 0, distance: 20, blur: 0, opacity: 100, paint: flat(0, 0, 0) },
						},
					],
				},
				input: { ...RECT, color: 'rgba(255,255,255,0.5)' },
				box: R_BOX,
				unitPx: 100,
			});
			expect(pixel(faded, faded.box.x + 90, y)[3]).toBeGreaterThan(110);
			expect(pixel(faded, faded.box.x + 90, y)[0]).toBeLessThan(20);
		});

		it('a clip filling its box is shaded from the box’s edge (TL-012: the padding gives the blur a shape to leave)', async () => {
			const img = await tl.render({
				recipe: {
					layers: [
						face(WHITE),
						{
							type: 'innerShadow',
							params: { angle: 0, distance: 10, blur: 10, opacity: 100, paint: flat(0, 0, 0) },
						},
					],
				},
				input: { kind: 'rect', x: 0, y: 0, w: 1, h: 1 },
				box: R_BOX,
				unitPx: 100,
			});
			expect(pixel(img, img.box.x + 3, img.box.y + 80)[0]).toBeLessThan(60);
			expect(pixel(img, img.box.x + 160, img.box.y + 80)[0]).toBeGreaterThan(245);
		});

		it('follows the look’s light when told to (TL-017)', async () => {
			const lit = (angle: number) =>
				tl.render({
					recipe: {
						light: { angle, altitude: 45 },
						layers: [
							face(WHITE),
							{
								type: 'innerShadow',
								params: {
									useLight: true,
									angle: 90,
									distance: 20,
									blur: 0,
									opacity: 100,
									paint: flat(0, 0, 0),
								},
							},
						],
					},
					input: RECT,
					box: R_BOX,
					unitPx: 100,
				});
			const fromLeft = await lit(180); // the light is left: the shadow falls right, from the left edge
			const fromRight = await lit(0);
			const y = fromLeft.box.y + 80;
			expect(pixel(fromLeft, fromLeft.box.x + 90, y)[0]).toBeLessThan(10);
			expect(pixel(fromRight, fromRight.box.x + 230, y)[0]).toBeLessThan(10);
			expect(pixel(fromRight, fromRight.box.x + 90, y)[0]).toBeGreaterThan(245);
		});
	});

	describe('innerGlow', () => {
		const dark = face(flat(0.1, 0.1, 0.1));
		it('precise: brightest at the edge, gone past the radius, inside the shape only', async () => {
			const img = await onRect([
				dark,
				{ type: 'innerGlow', params: { technique: 'precise', radius: 20, paint: WHITE } },
			]);
			const x0 = img.box.x + 80;
			const y = img.box.y + 80;
			const v = [2, 10, 18, 30].map((d) => pixel(img, x0 + d, y)[0]);
			expect(v[0]).toBeGreaterThan(v[1]!);
			expect(v[1]).toBeGreaterThan(v[2]!);
			expect(v[3]).toBe(26); // the face: 0.1 stays 26 / 255
			expect(pixel(img, x0 - 3, y)[3]).toBe(0);
		});

		it('from the centre it reverses; soft blurs the same way', async () => {
			const centre = await onRect([
				dark,
				{ type: 'innerGlow', params: { technique: 'precise', origin: 'center', radius: 30, paint: WHITE } },
			]);
			const x0 = centre.box.x + 80;
			const y = centre.box.y + 80;
			expect(pixel(centre, x0 + 2, y)[0]).toBeLessThan(pixel(centre, x0 + 35, y)[0]);
			const soft = await onRect([dark, { type: 'innerGlow', params: { radius: 30, paint: WHITE } }]);
			const a = [2, 12, 32].map((d) => pixel(soft, soft.box.x + 80 + d, soft.box.y + 80)[0]);
			expect(a[0]).toBeGreaterThan(a[1]!);
			expect(a[1]).toBeGreaterThan(a[2]!);
		});

		it('blends in linear light: Add, Screen and Normal differ as their formulas say', async () => {
			const at = async (blend: string) => {
				const img = await onRect([
					face(flat(0.5, 0.5, 0.5)),
					{
						type: 'innerGlow',
						params: {
							technique: 'precise',
							radius: 200,
							choke: 100,
							intensity: 100,
							opacity: 50,
							blend,
							paint: flat(0.5, 0.5, 0.5),
						},
					},
				]);
				return pixel(img, img.box.x + 100, img.box.y + 80)[0] / 255;
			};
			const base = toLinear(0.5);
			const srgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
			const k = 0.5;
			expect(await at('add')).toBeCloseTo(srgb(base + base * k), 1);
			expect(await at('screen')).toBeCloseTo(srgb(base + (base - base * base) * k), 1);
			expect(await at('normal')).toBeCloseTo(0.5, 1);
		});
	});

	describe('reflection', () => {
		const stack = (params: Record<string, unknown> = {}) => [
			face(RED),
			{ type: 'reflection', params: { gap: 0, fade: 80, blur: 0, falloff: 1, opacity: 100, ...params } },
		];

		it('mirrors below the base, fading linearly with Falloff 1, and draws nothing above it', async () => {
			const img = await onRect(stack());
			const x = img.box.x + 160;
			const base = img.box.y + 120;
			expect(pixel(img, x, base + 3)[3]).toBeGreaterThan(200);
			expect(pixel(img, x, base + 40)[3]).toBeGreaterThan(100);
			expect(pixel(img, x, base + 40)[3]).toBeLessThan(150);
			expect(pixel(img, x, base + 79)[3]).toBeLessThan(10);
			expect(pixel(img, x, base + 85)[3]).toBe(0);
			// Above the rectangle: nothing.
			expect(pixel(img, x, img.box.y + 30)[3]).toBe(0);
			expect(edgeAlpha(img)).toBeLessThanOrEqual(3);
		});

		it('is a mirror: what is near the base comes first', async () => {
			const twoTone = await tl.render({
				recipe: {
					layers: [
						{
							type: 'face',
							params: {
								paint: {
									kind: 'gradient',
									gradient: {
										type: 'linear',
										span: 'block',
										angle: 90,
										stops: [
											{ at: 0, paint: { color: [0, 0, 1, 1] } },
											{ at: 0.5, paint: { color: [0, 0, 1, 1] } },
											{ at: 0.5001, paint: { color: [1, 0, 0, 1] } },
											{ at: 1, paint: { color: [1, 0, 0, 1] } },
										],
									},
								},
							},
						},
						{ type: 'reflection', params: { gap: 0, fade: 300, blur: 0, falloff: 1, opacity: 100 } },
					],
				},
				input: RECT,
				box: R_BOX,
				unitPx: 100,
			});
			const x = twoTone.box.x + 160;
			const base = twoTone.box.y + 120;
			const near = pixel(twoTone, x, base + 10);
			const far = pixel(twoTone, x, base + 70);
			expect(near[0]).toBeGreaterThan(near[2]); // the red bottom of the rectangle, reflected first
			expect(far[2]).toBeGreaterThan(far[0]); // its blue top, further down
		});

		it('Gap moves the mirror line, Vertical Scale stretches it, Blur grows with distance', async () => {
			const x = (i: LookImage) => i.box.x + 160;
			const b = (i: LookImage) => i.box.y + 120;
			const gap = await onRect(stack({ gap: 20 }));
			expect(pixel(gap, x(gap), b(gap) + 10)[3]).toBe(0);
			expect(pixel(gap, x(gap), b(gap) + 25)[3]).toBeGreaterThan(150);
			// Half scale: the 80 px rectangle ends 40 px below the base.
			const squash = await onRect(stack({ scale: 0.5, fade: 200 }));
			expect(pixel(squash, x(squash), b(squash) + 30)[3]).toBeGreaterThan(100);
			expect(pixel(squash, x(squash), b(squash) + 46)[3]).toBe(0);
			// Blur: the left edge of the rectangle is sharp near the base and soft far from it.
			const blur = await onRect(stack({ blur: 40, fade: 200, opacity: 100 }));
			const edge = blur.box.x + 80;
			const contrast = (dy: number) =>
				pixel(blur, edge + 4, b(blur) + dy)[3] - pixel(blur, edge - 4, b(blur) + dy)[3];
			expect(contrast(4)).toBeGreaterThan(contrast(70) + 40);
		});

		it('sits under the outermost rim, though the rim is below it in the stack', async () => {
			const img = await onRect([
				{ type: 'rim', params: { width: 20, paint: flat(0, 1, 0) } },
				face(RED),
				{ type: 'reflection', params: { gap: 0, fade: 80, blur: 0, falloff: 1, opacity: 100 } },
			]);
			const x = img.box.x + 160;
			const rimBottom = img.box.y + 140;
			expect(pixel(img, x, rimBottom - 5)[1]).toBeGreaterThan(240); // the rim, not covered
			const r = pixel(img, x, rimBottom + 6);
			expect(r[1]).toBeGreaterThan(r[0]); // the rim's own reflection comes first
			expect(edgeAlpha(img)).toBeLessThanOrEqual(3);
		});

		it('From Clip Picture mirrors the input wherever the layer sits', async () => {
			const img = await onRect([
				{
					type: 'reflection',
					params: { from: 'source', gap: 0, fade: 80, blur: 0, falloff: 1, opacity: 100 },
				},
				face(RED),
			]);
			expect(pixel(img, img.box.x + 160, img.box.y + 130)[3]).toBeGreaterThan(150);
		});
	});

	describe('shadow', () => {
		it('regression: a long shadow reaches its full length however far that is from the field', async () => {
			// Before the fix a march capped at 48 steps of the field's short reach stopped about 290 px out.
			const img = await tl.render({
				recipe: {
					layers: [
						{
							type: 'shadow',
							params: { kind: 'long', distance: 500, blur: 0, angle: 0, opacity: 100, paint: flat(0, 0, 1) },
						},
					],
				},
				input: { kind: 'rect', x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
				box: R_BOX,
				unitPx: 100,
			});
			const y = img.box.y + 80;
			const right = img.box.x + 192;
			for (const d of [100, 300, 450, 490]) expect(pixel(img, right + d, y)[3]).toBeGreaterThan(240);
			expect(pixel(img, right + 510, y)[3]).toBe(0);
		});

		it('regression: a shadow following a light from the lower right is not clipped at the top left', async () => {
			const img = await tl.render({
				recipe: {
					light: { angle: 45, altitude: 45 },
					layers: [
						{
							type: 'shadow',
							params: { useLight: true, distance: 60, blur: 0, opacity: 100, paint: flat(0, 0, 1) },
						},
					],
				},
				input: { kind: 'rect', x: 0, y: 0, w: 1, h: 1 },
				box: R_BOX,
				unitPx: 100,
			});
			// The whole box moved up and left by 60 × cos 45° ≈ 42 px: there must be canvas for it.
			expect(img.padding.left).toBeGreaterThanOrEqual(60);
			expect(img.padding.top).toBeGreaterThanOrEqual(60);
			expect(pixel(img, img.box.x - 30, img.box.y - 30)[3]).toBeGreaterThan(240);
		});

		it('regression: a perspective shadow keeps its shape at any resolution (TL-034)', async () => {
			const at = (k: number) =>
				tl.render({
					recipe: {
						layers: [
							{
								type: 'shadow',
								params: { kind: 'perspective', angle: 60, distance: 80, blur: 12, foreshorten: 100 },
							},
							face(WHITE),
						],
					},
					input: { kind: 'shapes' },
					unitPx: 96 * k,
					box: { width: R_BOX.width * k, height: R_BOX.height * k },
				});
			const [a, b] = [await at(1), await at(2)];
			const ca = layerCrop(a, lumaOver(a, 128));
			const cb = layerCrop(b, lumaOver(b, 128));
			expect(ssim(resampleLuma(cb.data, cb.w, cb.h, ca.w, ca.h), ca.data, ca.w, ca.h)).toBeGreaterThan(0.97);
		});

		it('perspective: cast on the floor at the base, its tip at Distance along the direction', async () => {
			const img = await onRect([
				{
					type: 'shadow',
					params: {
						kind: 'perspective',
						angle: 90,
						distance: 60,
						foreshorten: 100,
						convergence: 0,
						blur: 0,
						blurNear: 0,
						fade: 0,
						opacity: 100,
						paint: flat(0, 0, 1),
					},
				},
			]);
			const x = img.box.x + 160;
			const base = img.box.y + 120;
			expect(pixel(img, x, base + 30)[3]).toBeGreaterThan(240);
			expect(pixel(img, x, base + 57)[3]).toBeGreaterThan(240);
			expect(pixel(img, x, base + 64)[3]).toBe(0);
			// Nothing above the base: the shape stands on the floor.
			expect(pixel(img, x, base - 20)[3]).toBe(0);
			expect(edgeAlpha(img)).toBeLessThanOrEqual(3);
		});

		it('perspective: shears with the direction, narrows with Perspective, fades with height', async () => {
			const cast = (params: Record<string, unknown>) =>
				onRect([
					{
						type: 'shadow',
						params: {
							kind: 'perspective',
							angle: 60,
							distance: 100,
							foreshorten: 100,
							convergence: 0,
							blur: 0,
							blurNear: 0,
							fade: 0,
							opacity: 100,
							...params,
						},
					},
				]);
			const widthAt = (img: LookImage, y: number) => {
				let w = 0;
				for (let x = 0; x < img.width; x++) if (pixel(img, x, y)[3] > 128) w++;
				return w;
			};
			const leftAt = (img: LookImage, y: number) => {
				for (let x = 0; x < img.width; x++) if (pixel(img, x, y)[3] > 128) return x;
				return -1;
			};
			const plain = await cast({});
			const near = plain.box.y + 120 + 5;
			const far = plain.box.y + 120 + 80;
			expect(widthAt(plain, near)).toBeCloseTo(widthAt(plain, far), -1);
			// Direction 60°: over 80 px down the floor the shape moves right by 80 × cos 60 / sin 60 ≈ 46 px.
			expect(Math.abs(leftAt(plain, far) - leftAt(plain, near) - 44)).toBeLessThan(6);
			const narrowed = await cast({ convergence: 60 });
			expect(widthAt(narrowed, far)).toBeLessThan(widthAt(plain, far) * 0.6);
			const faded = await cast({ fade: 100 });
			expect(pixel(faded, leftAt(plain, far) + 60, far)[3]).toBeLessThan(40);
		});

		it('perspective under a light recedes behind the title (a floor shadow mirrors `away`)', async () => {
			const img = await tl.render({
				recipe: {
					light: { angle: 225, altitude: 45 },
					layers: [
						{
							type: 'shadow',
							params: {
								kind: 'perspective',
								useLight: true,
								distance: 60,
								foreshorten: 100,
								convergence: 0,
								blur: 0,
								fade: 0,
								opacity: 100,
								paint: flat(0, 0, 1),
							},
						},
					],
				},
				input: RECT,
				box: R_BOX,
				unitPx: 100,
			});
			// Light upper left: `away` is down right, and the floor mirrors it to up right, behind the shape's base.
			const base = img.box.y + 120;
			expect(pixel(img, img.box.x + 250, base - 20)[3]).toBeGreaterThan(200);
			expect(pixel(img, img.box.x + 200, base + 20)[3]).toBe(0);
		});
	});

	describe('glow', () => {
		it('regression: Intensity above 100 % on a layer glow never cuts into what is below it', async () => {
			// Alpha above 1 made `under * (1 - a)` negative. A grey picture over a white face, blurred alpha ≈ 0.5 at its
			// edge, × 8: 4 × 0.21 − 3 × 1 is below zero, a black hole. The glow there is simply the picture's grey.
			const img = await tl.render({
				recipe: {
					layers: [face(WHITE), { type: 'glow', params: { from: 'layer', radius: 20, intensity: 800 } }],
				},
				input: { ...RECT, color: 'rgb(128,128,128)' },
				box: R_BOX,
				unitPx: 100,
			});
			const p = pixel(img, img.box.x + 82, img.box.y + 80);
			expect(p[3]).toBe(255);
			expect(Math.abs(p[0] - 128)).toBeLessThan(12);
		});

		it('Precise from the layer lights with the picture’s colours (Pachislop’s From layer holds for both techniques)', async () => {
			const img = await tl.render({
				recipe: { layers: [{ type: 'glow', params: { technique: 'precise', from: 'layer', radius: 30 } }] },
				input: { ...RECT, color: 'rgb(255,0,0)' },
				box: R_BOX,
				unitPx: 100,
			});
			const p = pixel(img, img.box.x + 70, img.box.y + 80);
			expect(p[3]).toBeGreaterThan(100);
			expect(p[0]).toBeGreaterThan(240);
			expect(p[1]).toBeLessThan(10);
		});

		it('Spread holds the glow solid further out; Distance runs a gradient outward', async () => {
			const at = (params: Record<string, unknown>) =>
				onRect([{ type: 'glow', params: { technique: 'precise', radius: 40, paint: WHITE, ...params } }]);
			const plain = await at({});
			const spread = await at({ spread: 75 });
			const x = plain.box.x + 80 - 25;
			const y = plain.box.y + 80;
			expect(pixel(spread, x, y)[3]).toBe(255);
			expect(pixel(plain, x, y)[3]).toBeLessThan(150);
			const distance = await at({
				from: 'distance',
				paint: {
					kind: 'gradient',
					gradient: {
						type: 'shape',
						span: 'block',
						angle: 0,
						stops: [
							{ at: 0, paint: { color: [1, 0, 0, 1] } },
							{ at: 1, paint: { color: [0, 0, 1, 1] } },
						],
					},
				},
			});
			const near = pixel(distance, plain.box.x + 76, y);
			const far = pixel(distance, plain.box.x + 80 - 34, y);
			expect(near[0]).toBeGreaterThan(near[2]);
			expect(far[2]).toBeGreaterThan(far[0]);
		});

		it('Add as Light adds over the title by Glow Over Face, and shows on nothing', async () => {
			const at = (onFace: number) =>
				onRect([
					face(flat(0.2, 0.2, 0.2)),
					{ type: 'glow', params: { blend: 'add', radius: 30, paint: WHITE, onFace } },
				]);
			const off = await at(0);
			const on = await at(100);
			const x = off.box.x + 84;
			const y = off.box.y + 80;
			expect(pixel(off, x, y)[0]).toBe(51);
			expect(pixel(on, x, y)[0]).toBeGreaterThan(90);
			expect(pixel(on, off.box.x + 70, y)[3]).toBeGreaterThan(60);
		});
	});

	describe('rim', () => {
		it('Softness feathers its outer part', async () => {
			const at = (softness: number) =>
				onRect([{ type: 'rim', params: { width: 20, softness, paint: WHITE } }]);
			const hard = await at(0);
			const soft = await at(100);
			const x = hard.box.x + 80;
			const y = hard.box.y + 80;
			expect(pixel(hard, x - 15, y)[3]).toBe(255);
			expect(pixel(soft, x - 15, y)[3]).toBeLessThan(100);
			expect(pixel(soft, x - 3, y)[3]).toBeGreaterThan(200);
		});
	});

	describe('contourLines', () => {
		const lines = (params: Record<string, unknown>) =>
			onRect([
				face(flat(0, 0, 0)),
				{
					type: 'contourLines',
					params: {
						paint: WHITE,
						spacing: 8,
						lineWidth: 2,
						offset: 3,
						count: 4,
						falloff: 0,
						intensity: 1,
						glowSize: 0,
						...params,
					},
				},
			]);
		/** Bright runs along a cut from the left edge inward (or outward with `step` −1). */
		function runs(img: LookImage, from: number, y: number, step: number, n: number) {
			let count = 0;
			let inside = false;
			const at: number[] = [];
			for (let i = 0; i < n; i++) {
				const v = pixel(img, from + i * step, y);
				const on = v[0] * (v[3] / 255) > 110;
				if (on && !inside) {
					count++;
					at.push(i);
				}
				inside = on;
			}
			return { count, at };
		}

		it('draws Line Count lines at Spacing from First Line, inside the shape', async () => {
			const img = await lines({});
			const r = runs(img, img.box.x + 80, img.box.y + 80, 1, 40);
			expect(r.count).toBe(4);
			expect(r.at[1]! - r.at[0]!).toBe(8);
			expect(r.at[0]).toBeGreaterThanOrEqual(1);
			expect(r.at[0]).toBeLessThanOrEqual(3);
			// None outside.
			expect(pixel(img, img.box.x + 74, img.box.y + 80)[3]).toBe(0);
		});

		it('Around goes outside; Inside and Around both; every line keeps its place as the count animates', async () => {
			const around = await lines({ mode: 'outside', count: 3 });
			expect(runs(around, around.box.x + 79, around.box.y + 80, -1, 30).count).toBe(3);
			expect(runs(around, around.box.x + 80, around.box.y + 80, 1, 30).count).toBe(0);
			const both = await lines({ mode: 'both', count: 3 });
			expect(runs(both, both.box.x + 79, both.box.y + 80, -1, 30).count).toBe(3);
			expect(runs(both, both.box.x + 81, both.box.y + 80, 1, 30).count).toBe(3);
			expect(edgeAlpha(both)).toBeLessThanOrEqual(3);
		});

		it('Falloff dims the far lines; a gradient by line number colours each; the glow adds light', async () => {
			const fall = await lines({ falloff: 80 });
			const y = fall.box.y + 80;
			const x0 = fall.box.x + 80;
			const plain = await lines({});
			expect(pixel(fall, x0 + 27, y)[0]).toBeLessThan(pixel(plain, x0 + 27, y)[0] - 40);
			const ramp: Paint = {
				kind: 'gradient',
				gradient: {
					type: 'linear',
					span: 'block',
					angle: 0,
					stops: [
						{ at: 0, paint: { color: [1, 0, 0, 1] } },
						{ at: 1, paint: { color: [0, 0, 1, 1] } },
					],
				},
			};
			const byLine = await lines({ colorBy: 'line', paint: ramp });
			expect(pixel(byLine, x0 + 3, y)[0]).toBeGreaterThan(pixel(byLine, x0 + 3, y)[2]);
			expect(pixel(byLine, x0 + 27, y)[2]).toBeGreaterThan(pixel(byLine, x0 + 27, y)[0]);
			const glow = await lines({ glowSize: 12, glow: 2 });
			const gap = x0 + 7;
			expect(pixel(glow, gap, y)[0]).toBeGreaterThan(pixel(plain, gap, y)[0] + 20);
		});
	});

	describe('extrude', () => {
		const block = (params: Record<string, unknown>, top = true) => {
			const ex = {
				type: 'extrude',
				params: { angle: 0, depth: 40, paint: flat(0, 1, 0), shading: 0, edge: 0, fade: 0, ...params },
			};
			return onRect(top ? [ex, face(RED)] : [face(RED), ex]);
		};

		it('stacks the shape along the direction, behind the face, to Depth', async () => {
			const img = await block({});
			const y = img.box.y + 80;
			const right = img.box.x + 240;
			expect(pixel(img, right - 5, y).slice(0, 3)).toEqual([255, 0, 0]);
			expect(pixel(img, right + 20, y)[1]).toBeGreaterThan(245);
			expect(pixel(img, right + 37, y)[1]).toBeGreaterThan(245);
			expect(pixel(img, right + 44, y)[3]).toBe(0);
			expect(pixel(img, img.box.x + 70, y)[3]).toBe(0);
			expect(edgeAlpha(img)).toBeLessThanOrEqual(3);
		});

		it('is the same above the face or below it', async () => {
			expect(meanDiff(await block({}), await block({}, false))).toBeLessThan(0.5);
		});

		it('shades each side from the light', async () => {
			const img = await block({ angle: 45, shading: 100, lightAngle: 270 });
			// Light from above: the side whose outward normal points up is lit, the one below is not.
			const top = pixel(img, img.box.x + 245, img.box.y + 55);
			const bottom = pixel(img, img.box.x + 180, img.box.y + 135);
			expect(top[1]).toBeGreaterThan(bottom[1] + 60);
		});

		it('follows the look’s light when told to (TL-017)', async () => {
			const lit = (angle: number) =>
				tl.render({
					recipe: {
						light: { angle, altitude: 45 },
						layers: [
							{
								type: 'extrude',
								params: { angle: 45, depth: 40, useLight: true, shading: 100, edge: 0, paint: flat(0, 1, 0) },
							},
							face(RED),
						],
					},
					input: RECT,
					box: R_BOX,
					unitPx: 100,
				});
			// The side at the right of the rectangle: its normal points right.
			const right = await lit(0);
			const left = await lit(180);
			const p = (i: LookImage) => pixel(i, i.box.x + 245, i.box.y + 55)[1];
			expect(p(right)).toBeGreaterThan(p(left) + 60);
		});

		it('flat with a fade is a long shadow; a gradient runs front to back', async () => {
			const fade = await block({ fade: 100 });
			const y = fade.box.y + 80;
			const right = fade.box.x + 240;
			expect(pixel(fade, right + 3, y)[3]).toBeGreaterThan(pixel(fade, right + 35, y)[3] + 100);
			const ramp = await block({
				paint: {
					kind: 'gradient',
					gradient: {
						type: 'linear',
						span: 'block',
						angle: 0,
						stops: [
							{ at: 0, paint: { color: [1, 0, 0, 1] } },
							{ at: 1, paint: { color: [0, 0, 1, 1] } },
						],
					},
				},
			});
			expect(pixel(ramp, right + 3, y)[0]).toBeGreaterThan(pixel(ramp, right + 3, y)[2]);
			expect(pixel(ramp, right + 37, y)[2]).toBeGreaterThan(pixel(ramp, right + 37, y)[0]);
		});
	});

	describe('gradientOverlay', () => {
		const ramp = (type: 'linear' | 'radial' = 'linear', angle = 0): Paint => ({
			kind: 'gradient',
			gradient: {
				type,
				span: 'block',
				angle,
				stops: [
					{ at: 0, paint: { color: [0, 0, 0, 1] } },
					{ at: 1, paint: { color: [1, 1, 1, 1] } },
				],
			},
		});
		const over = (params: Record<string, unknown>) =>
			onRect([face(WHITE), { type: 'gradientOverlay', params: { paint: ramp(), ...params } }]);

		it('recolours across the alpha bounds and keeps the alpha', async () => {
			const img = await over({});
			const y = img.box.y + 80;
			const x0 = img.box.x + 80;
			expect(pixel(img, x0 + 2, y)[0]).toBeLessThan(14);
			expect(Math.abs(pixel(img, x0 + 80, y)[0] - 128)).toBeLessThan(8);
			expect(pixel(img, x0 + 157, y)[0]).toBeGreaterThan(242);
			expect(pixel(img, x0 - 4, y)[3]).toBe(0);
			expect(pixel(img, x0 + 80, y)[3]).toBe(255);
		});

		it('mixes in linear light, whatever the blend', async () => {
			const img = await onRect([
				face(WHITE),
				{ type: 'gradientOverlay', params: { paint: flat(0, 0, 0), amount: 50 } },
			]);
			// Half black over white in linear light is 0.5 linear = 188 in sRGB (a signal mix would give 128).
			expect(Math.abs(pixel(img, img.box.x + 160, img.box.y + 80)[0] - 188)).toBeLessThanOrEqual(2);
			const multiply = await onRect([
				face(flat(0.5, 0.5, 0.5)),
				{ type: 'gradientOverlay', params: { paint: flat(0.5, 0.5, 0.5), blend: 'multiply' } },
			]);
			// 0.214 × 0.214 = 0.0458 linear, 0.235 in the signal (a signal multiply would give 0.25).
			expect(
				Math.abs(pixel(multiply, multiply.box.x + 160, multiply.box.y + 80)[0] - 60),
			).toBeLessThanOrEqual(2);
		});

		it('Scale, Offset and Wrap move the gradient', async () => {
			const y = (i: LookImage) => i.box.y + 80;
			const x = (i: LookImage, d: number) => i.box.x + 80 + d;
			const half = await over({ scale: 50 });
			expect(pixel(half, x(half, 30), y(half))[0]).toBeLessThan(12); // black before the ramp starts
			expect(pixel(half, x(half, 130), y(half))[0]).toBeGreaterThan(240);
			const shift = await over({ offset: 50 });
			expect(pixel(shift, x(shift, 2), y(shift))[0]).toBeGreaterThan(110);
			const repeat = await over({ scale: 50, wrap: 'repeat' });
			expect(pixel(repeat, x(repeat, 38), y(repeat))[0]).toBeGreaterThan(200);
			expect(pixel(repeat, x(repeat, 42), y(repeat))[0]).toBeLessThan(60);
			// 10 px in, the gradient's position is −0.375: repeated it is 0.625, mirrored 0.375.
			const mirror = await over({ scale: 50, wrap: 'mirror' });
			expect(Math.abs(pixel(mirror, x(mirror, 10), y(mirror))[0] - 96)).toBeLessThan(10);
			expect(Math.abs(pixel(repeat, x(repeat, 10), y(repeat))[0] - 159)).toBeLessThan(10);
		});

		it('a band of fixed length crosses the title: Position −100 is just off one side, 100 just off the other', async () => {
			const band: Paint = {
				kind: 'gradient',
				gradient: {
					type: 'linear',
					span: 'block',
					angle: 0,
					stops: [
						{ at: 0, paint: { color: [0, 0, 0, 1] } },
						{ at: 0.5, paint: { color: [1, 0, 0, 1] } },
						{ at: 1, paint: { color: [0, 0, 0, 1] } },
					],
				},
			};
			const at = (position: number) =>
				over({ paint: band, style: 'band', bandLength: 40, position, blend: 'add', amount: 100 });
			const y = (i: LookImage) => i.box.y + 80;
			const white = (i: LookImage, d: number) => pixel(i, i.box.x + 80 + d, y(i));
			const off = await at(-100);
			for (const d of [2, 80, 158]) expect(white(off, d).slice(0, 3)).toEqual([255, 255, 255]);
			const blackFace = (position: number) =>
				onRect([
					face(flat(0, 0, 0)),
					{
						type: 'gradientOverlay',
						params: { paint: band, style: 'band', bandLength: 40, position, blend: 'add' },
					},
				]);
			const mid = await blackFace(0);
			expect(pixel(mid, mid.box.x + 160, y(mid))[0]).toBeGreaterThan(200);
			expect(pixel(mid, mid.box.x + 100, y(mid))[0]).toBe(0);
			const end = await blackFace(100);
			expect(pixel(end, end.box.x + 160, y(end))[0]).toBe(0);
			expect(pixel(end, end.box.x + 238, y(end))[0]).toBe(0);
		});
	});

	describe('standalone effects', () => {
		const IDS = [
			'jasper.deep-glow',
			'jasper.alpha-glow',
			'jasper.inner-glow',
			'jasper.inner-shadow',
			'jasper.contour-lines',
			'jasper.perspective-shadow',
			'jasper.floor-reflection',
			'jasper.gradient-overlay',
			'jasper.shaded-extrude',
			'jasper.keyline',
		];
		const CARD = { input: { kind: 'card' }, box: R_BOX } as const;
		const fx = (id: string, params: Record<string, unknown> = {}, over: Partial<EffectRequest> = {}) =>
			tl.effect({ id, params, ...CARD, ...over });
		/** Outer Glow at its own technique; the others at their defaults. */
		const on = (id: string): Record<string, unknown> =>
			id === 'jasper.alpha-glow' ? { technique: 'soft', glow: 24, startColor: [1, 0.8, 0.2, 1] } : {};

		/** Every number a third of the way to its slider's end, the next option, toggles flipped (as `fx-gl`). */
		function perturbed(s: EffectSpec): Record<string, unknown> {
			const out: Record<string, unknown> = {};
			for (const p of s.params) {
				const d = p.default as unknown;
				if (p.type === 'number' && typeof d === 'number') {
					const hi = p.range?.softMax ?? p.range?.max;
					out[p.name] = hi !== undefined && hi > d ? d + (hi - d) / 3 : d;
				} else if (p.type === 'boolean') out[p.name] = !d;
				else if (p.type === 'enum' && p.options?.length)
					out[p.name] = p.options[(p.options.indexOf(d as string) + 1) % p.options.length];
				else if (p.type === 'color') out[p.name] = [0.9, 0.25, 0.45, 1];
				else out[p.name] = d;
			}
			if (s.id === 'jasper.alpha-glow') out.technique = 'soft';
			return out;
		}

		for (const id of IDS)
			describe(id, () => {
				const s = () => defaultEffectRegistry.get(id) as EffectSpec;

				it('moves with its params, and draws the same pixels every time', async () => {
					// Not white: Screen and Add on white change nothing.
					const request = {
						input: { kind: 'rect', x: 0.2, y: 0.25, w: 0.6, h: 0.5, color: '#305080' },
						box: BOX,
					} as const;
					const a = await tl.effect({ id, params: on(id), ...request });
					const b = await tl.effect({ id, params: on(id), ...request });
					expect(meanDiff(a, b)).toBe(0);
					const p = await tl.effect({ id, params: perturbed(s()), ...request });
					const ca = layerCrop(a, lumaOver(a, 128));
					const cp = layerCrop(p, lumaOver(p, 128));
					let d = 0;
					for (let i = 0; i < ca.data.length; i++) d += Math.abs(ca.data[i]! - cp.data[i]!);
					expect(d / ca.data.length).toBeGreaterThan(0.5);
				});

				it('stays inside its padding at any params: nothing clipped at the canvas edge', async () => {
					const img = await tl.effect({ id, params: perturbed(s()), input: TEXT, box: BOX });
					expect(edgeAlpha(img)).toBeLessThanOrEqual(3);
				});

				it('keeps its size at half the resolution (layer px follow pxScale)', async () => {
					const params = perturbed(s());
					const shapes = { input: { kind: 'shapes' }, box: BOX } as const;
					const full = await tl.effect({ id, params, ...shapes });
					const half = await tl.effect({ id, params, ...shapes, pxScale: 0.5 });
					const f = layerCrop(full, lumaOver(full, 128));
					const h = layerCrop(half, lumaOver(half, 128));
					expect(ssim(resampleLuma(f.data, f.w, f.h, h.w, h.h), h.data, h.w, h.h)).toBeGreaterThan(0.93);
				});
			});

		it('neutral settings leave the picture as it was, in every channel and in alpha', async () => {
			const neutral: Record<string, Record<string, unknown>> = {
				'jasper.deep-glow': { exposure: 0, intensity: 0, highlightShift: 0 },
				'jasper.inner-glow': { intensity: 0 },
				'jasper.inner-shadow': { opacity: 0 },
				'jasper.contour-lines': { intensity: 0 },
				'jasper.perspective-shadow': { opacity: 0 },
				'jasper.floor-reflection': { opacity: 0 },
				'jasper.gradient-overlay': { amount: 0 },
				'jasper.shaded-extrude': { opacity: 0 },
				'jasper.keyline': { opacity: 0 },
			};
			const base = await tl.render({
				recipe: { layers: [] },
				input: { kind: 'card' },
				box: R_BOX,
			});
			for (const [id, params] of Object.entries(neutral)) {
				const img = await fx(id, params);
				const crop = (i: LookImage) => {
					const out: number[] = [];
					for (let y = 0; y < R_BOX.height; y += 7)
						for (let x = 0; x < R_BOX.width; x += 7) out.push(...pixel(i, i.box.x + x, i.box.y + y));
					return out;
				};
				const a = crop(img);
				const b = crop(base);
				const worst = a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i]!)), 0);
				expect(worst, id).toBeLessThanOrEqual(2);
			}
		});

		it('transparent input stays transparent where the effect draws nothing', async () => {
			const rect = { input: RECT, box: R_BOX };
			for (const id of ['jasper.inner-glow', 'jasper.inner-shadow', 'jasper.gradient-overlay']) {
				const img = await tl.effect({ id, ...rect });
				expect(pixel(img, img.box.x + 40, img.box.y + 80)[3], id).toBe(0);
			}
		});

		it('Deep Glow lights footage: bright parts bloom over the picture and past its edge', async () => {
			const card = { input: { kind: 'card' }, box: R_BOX, pad: 0 } as const;
			const none = await tl.effect({
				id: 'jasper.deep-glow',
				params: { intensity: 0, exposure: 0 },
				...card,
			});
			const glow = await tl.effect({ id: 'jasper.deep-glow', params: { radius: 60 }, ...card });
			const inside = pixel(glow, glow.box.x + 200, glow.box.y + 80);
			const before = pixel(none, none.box.x + 200, none.box.y + 80);
			expect(inside[1]).toBeGreaterThan(before[1]);
			// Outside the layer box there is light, with alpha, fading out.
			// The card stops at 90 % of the box: distances are from the picture's edge.
			const out = (d: number) => pixel(glow, glow.box.x + glow.box.w * 0.9 + d, glow.box.y + 80)[3];
			expect(out(6)).toBeGreaterThan(out(40));
			expect(out(6)).toBeGreaterThan(10);
		});

		it('Deep Glow with a custom colour emits in that colour', async () => {
			const img = await tl.effect({
				id: 'jasper.deep-glow',
				params: { colorMode: 'custom', color: [1, 0, 0, 1], radius: 60, highlightShift: 0 },
				input: RECT,
				box: R_BOX,
			});
			const p = pixel(img, img.box.x + 50, img.box.y + 80);
			expect(p[0]).toBeGreaterThan(200);
			expect(p[1]).toBeLessThan(30);
		});

		it('honours the global light (TL-017)', async () => {
			const rect = { input: RECT, box: R_BOX };
			const params = { useGlobalLight: true, distance: 20, blur: 0, opacity: 100 };
			const left = await tl.effect({
				id: 'jasper.inner-shadow',
				params,
				...rect,
				globalLight: { angle: 180, altitude: 30 },
			});
			const right = await tl.effect({
				id: 'jasper.inner-shadow',
				params,
				...rect,
				globalLight: { angle: 0, altitude: 30 },
			});
			const y = left.box.y + 80;
			expect(pixel(left, left.box.x + 90, y)[0]).toBeLessThan(10);
			expect(pixel(right, right.box.x + 90, y)[0]).toBeGreaterThan(245);
			const ex = (angle: number) =>
				tl.effect({
					id: 'jasper.shaded-extrude',
					params: { useGlobalLight: true, angle: 45, depth: 40, shading: 100, edge: 0 },
					...rect,
					globalLight: { angle, altitude: 30 },
				});
			const lightRight = await ex(0);
			const lightLeft = await ex(180);
			const side = (i: LookImage) => pixel(i, i.box.x + 245, i.box.y + 55)[0];
			expect(side(lightRight)).toBeGreaterThan(side(lightLeft) + 50);
		});

		it('Keyline is a stroke of its width, softness feathering it', async () => {
			const img = await tl.effect({
				id: 'jasper.keyline',
				params: { width: 8, color: [1, 0, 0, 1] },
				input: RECT,
				box: R_BOX,
			});
			const x = img.box.x + 80;
			const y = img.box.y + 80;
			expect(pixel(img, x - 4, y).slice(0, 3)).toEqual([255, 0, 0]);
			expect(pixel(img, x - 11, y)[3]).toBe(0);
			expect(pixel(img, x + 4, y).slice(0, 3)).toEqual([255, 255, 255]);
		});

		it('Outer Glow: Classic stays Premiere’s, Soft and Precise are the look’s glow', async () => {
			const params = { glow: 24, startColor: [1, 0, 0, 1] };
			const classic = await tl.effect({ id: 'jasper.alpha-glow', params, input: RECT, box: R_BOX });
			const soft = await tl.effect({
				id: 'jasper.alpha-glow',
				params: { ...params, technique: 'soft' },
				input: RECT,
				box: R_BOX,
			});
			const look = await onRect(
				[
					{ type: 'glow', params: { radius: 24, paint: RED } },
					{ type: 'face', params: { paint: { kind: 'source' } } },
				],
				{ input: RECT },
			);
			expect(meanDiff(soft, classic)).toBeGreaterThan(0.1);
			const x = (i: LookImage) => i.box.x + 70;
			const y = (i: LookImage) => i.box.y + 80;
			expect(
				Math.abs(pixel(soft, x(soft), y(soft))[3] - pixel(look, x(look), y(look))[3]),
			).toBeLessThanOrEqual(2);
		});
	});

	// Cost on this host (docs/performance.md §7): TL_PERF=1. Reports; the budget is on a real GPU.
	it.runIf(process.env.TL_PERF === '1')(
		'per-frame cost of Deep Glow at 1080p',
		{ timeout: 600_000 },
		async () => {
			const text = { kind: 'text', text: 'Title Look', size: 200 } as const;
			const median = async (run: () => Promise<LookImage>) => {
				const first = await run();
				const times: number[] = [];
				for (let i = 0; i < 5; i++) times.push((await run()).ms);
				times.sort((a, b) => a - b);
				return `canvas ${first.width}×${first.height}, ${first.passes} passes, median ${times[2]!.toFixed(0)} ms`;
			};
			const box = { width: 1200, height: 280 };
			const frame = { width: 1920, height: 1080 };
			for (const pxScale of [1, 0.5]) {
				const fx = (b: { width: number; height: number }, input: LookRequest['input']) =>
					median(() =>
						tl.effect({
							id: 'jasper.deep-glow',
							params: { radius: 200 },
							input,
							box: b,
							pxScale,
							timingOnly: true,
						}),
					);
				console.info(`[glows-perf] ${pxScale} effect, title box: ${await fx(box, text)}`);
				console.info(`[glows-perf] ${pxScale} effect, full frame: ${await fx(frame, { kind: 'card' })}`);
				const layer = median(() =>
					tl.render({
						recipe: { layers: [face(), { type: 'deepGlow', params: { from: 'stack', radius: 100 } }] },
						input: text,
						box,
						pxScale,
						timingOnly: true,
					}),
				);
				console.info(`[glows-perf] ${pxScale} look layer, title box: ${await layer}`);
			}
		},
	);

	it.runIf(!!process.env.TL_SHEET)('contact sheet', async () => {
		const path = process.env.TL_SHEET ?? join(here, 'glows.png');
		mkdirSync(dirname(path), { recursive: true });
		const fx = (id: string, params: Record<string, unknown> = {}, input = TEXT) =>
			tl.effect({ id, params, input, box: BOX });
		const LIGHT = 205;
		const tiles: { label: string; img: LookImage; bg?: number }[] = [
			{
				label: 'deepGlow Shape, behind a white face',
				img: await look([{ type: 'deepGlow', params: { radius: 90, exposure: 2 } }, face(WHITE)]),
			},
			{
				label: 'deepGlow Layers Below, gold face',
				img: await look([face(), { type: 'deepGlow', params: { from: 'stack', radius: 90, exposure: 2 } }]),
			},
			{
				label: 'deepGlow neon: blue, over-exposed',
				img: await look([
					face(flat(0.1, 0.3, 1)),
					{ type: 'deepGlow', params: { from: 'stack', radius: 120, exposure: 3, highlightShift: 100 } },
				]),
			},
			{
				label: 'deepGlow chromatic scatter 100 %',
				img: await look([
					face(flat(1, 1, 1)),
					{
						type: 'deepGlow',
						params: { from: 'stack', radius: 110, exposure: 2, chroma: 100, intensity: 2 },
					},
				]),
			},
			{
				label: 'deepGlow over a mid grey',
				img: await look([{ type: 'deepGlow', params: { radius: 90, exposure: 2 } }, face(WHITE)]),
				bg: 96,
			},
			{ label: 'glow soft', img: await look([{ type: 'glow', params: { radius: 30 } }, face()]) },
			{
				label: 'glow precise',
				img: await look([{ type: 'glow', params: { radius: 30, technique: 'precise' } }, face()]),
			},
			{
				label: 'glow Add as Light',
				img: await look([face(), { type: 'glow', params: { radius: 30, blend: 'add' } }]),
			},
			{
				label: 'innerGlow',
				img: await look([face(flat(0.1, 0.1, 0.3)), { type: 'innerGlow', params: { radius: 14 } }]),
			},
			{
				label: 'innerShadow',
				img: await look([face(), { type: 'innerShadow', params: { distance: 6, blur: 6, opacity: 90 } }]),
			},
			{
				label: 'reflection under a rim',
				img: await look([
					{ type: 'rim', params: { width: 3 } },
					face(),
					{ type: 'reflection', params: { fade: 60 } },
				]),
			},
			{
				label: 'shadow perspective',
				bg: LIGHT,
				img: await look([
					{ type: 'shadow', params: { kind: 'perspective', angle: -55, distance: 90, foreshorten: 100 } },
					face(),
				]),
			},
			{
				label: 'shadow long',
				bg: LIGHT,
				img: await look([{ type: 'shadow', params: { kind: 'long', distance: 50, blur: 0 } }, face()]),
			},
			{
				label: 'contourLines inside',
				img: await look([
					face(flat(0.05, 0.05, 0.1)),
					{ type: 'contourLines', params: { spacing: 3, count: 4 } },
				]),
			},
			{
				label: 'contourLines around',
				img: await look([
					face(flat(0.9, 0.9, 1)),
					{ type: 'contourLines', params: { mode: 'outside', count: 5 } },
				]),
			},
			{ label: 'extrude', img: await look([{ type: 'extrude', params: { depth: 18 } }, face()]) },
			{ label: 'gradientOverlay', img: await look([face(flat(1, 1, 1)), { type: 'gradientOverlay' }]) },
			{ label: 'FX Deep Glow, text', img: await fx('jasper.deep-glow', { radius: 150 }) },
			{
				label: 'FX Deep Glow, card with a threshold',
				img: await tl.effect({
					id: 'jasper.deep-glow',
					params: { radius: 100, threshold: 0.25, exposure: 2 },
					input: { kind: 'card' },
					box: BOX,
				}),
			},
			{
				label: 'FX Alpha Glow Soft (Outer Glow)',
				img: await fx('jasper.alpha-glow', { technique: 'soft', glow: 30, startColor: [1, 0.8, 0.2, 1] }),
			},
			{
				label: 'FX Alpha Glow Precise, End Color',
				img: await fx('jasper.alpha-glow', {
					technique: 'precise',
					glow: 30,
					useEndColor: true,
					startColor: [1, 1, 0.6, 1],
					endColor: [1, 0, 0, 1],
				}),
			},
			{
				label: 'FX Inner Glow',
				img: await fx('jasper.inner-glow', { color: [1, 0.2, 0.2, 1], blend: 'normal' }),
			},
			{ label: 'FX Inner Shadow', img: await fx('jasper.inner-shadow', { opacity: 100 }) },
			{ label: 'FX Contour Lines', img: await fx('jasper.contour-lines', { mode: 'both', spacing: 7 }) },
			{
				label: 'FX Perspective Shadow',
				bg: LIGHT,
				img: await fx('jasper.perspective-shadow', { length: 100 }),
			},
			{ label: 'FX Floor Reflection', img: await fx('jasper.floor-reflection', { fade: 60 }) },
			{ label: 'FX Gradient Overlay', img: await fx('jasper.gradient-overlay') },
			{ label: 'FX Shaded Extrude', img: await fx('jasper.shaded-extrude') },
			{ label: 'FX Keyline', img: await fx('jasper.keyline', { color: [1, 0.2, 0.2, 1], width: 4 }) },
		];
		await writeSheet(tl, path, tiles);
	});
});
