// @vitest-environment node
// Finishes and the layer types over them in real WebGL2 (spec 19 §5.1, TL-034, TL-036, TL-038). The picture tests every type
// gets are in title-look-gl.test.ts; this file holds what each one must do.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type LookRecipe,
	type Paint,
	type SpanBox,
	type SpanGlyph,
	TITLE_FINISHES,
	type TitleParamSpec,
	TL_ENV_PRESETS,
	TL_PATTERN_KINDS,
	TL_PROFILES,
} from '@jasper/project';
import { expectFingerprints } from '@jasper/testkit/golden';
import { meanGrid } from '@jasper/testkit/image';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	CHROME,
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
const GOLDENS = join(here, 'goldens', 'title-look-fingerprints.json');

const flat = (r: number, g: number, b: number, a = 1): Paint => ({ kind: 'color', color: [r, g, b, a] });
const palette = {
	face: [0.92, 0.72, 0.2, 1],
	faceAlt: [1, 0.9, 0.55, 1],
	keyline: [0.08, 0.1, 0.2, 1],
	shadow: [0.05, 0.03, 0.02, 1],
	accent1: [0.1, 0.1, 0.12, 1],
	accent2: [0.95, 0.3, 0.2, 1],
	base: [0.12, 0.2, 0.45, 1],
} as NonNullable<LookRecipe['palette']>;

const TEXT: LookRequest['input'] = { kind: 'text', text: 'Agate', size: 96 };
const BOX = { width: 420, height: 180 };
const RECT = { kind: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5 } as const;
const WIDE = { kind: 'rect', x: 0.05, y: 0.05, w: 0.9, h: 0.9 } as const;
const RIDGED = {
	curve: [
		[0, 0],
		[0.3, 1],
		[0.6, 0.1],
		[1, 0.7],
	],
};

const RAMP: Paint = {
	kind: 'gradient',
	gradient: {
		type: 'linear',
		span: 'block',
		angle: 30,
		stops: [
			{ at: 0, paint: { color: [0.1, 0.1, 0.5, 1] } },
			{ at: 1, paint: { color: [1, 0.9, 0.6, 1] } },
		],
	},
};

const face = (finish: string, params: Record<string, unknown> = {}, paint?: Paint): LookRecipe => ({
	palette,
	layers: [{ type: 'face', params: { finish, ...params, ...(paint ? { paint } : {}) } }],
});

/** Luma spread inside the shape: a finish that reads as flat colour has almost none. */
function lumaSpread(img: LookImage): number {
	const values: number[] = [];
	for (let i = 0; i < img.data.length; i += 4) {
		if (img.data[i + 3]! < 250) continue;
		values.push(0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!);
	}
	values.sort((a, b) => a - b);
	return values[Math.floor(values.length * 0.95)]! - values[Math.floor(values.length * 0.05)]!;
}

const meanRgb = (img: LookImage) => {
	const s = [0, 0, 0];
	let n = 0;
	for (let i = 0; i < img.data.length; i += 4) {
		if (img.data[i + 3]! < 250) continue;
		for (let k = 0; k < 3; k++) s[k]! += img.data[i + k]!;
		n++;
	}
	return s.map((v) => v / Math.max(1, n)) as [number, number, number];
};

const alphaSum = (img: LookImage) => {
	let s = 0;
	for (let i = 3; i < img.data.length; i += 4) s += img.data[i]!;
	return s;
};

const grid = (img: LookImage) =>
	meanGrid({ width: img.width, height: img.height, data: new Uint8Array(img.data) }, 4);

const difference = (a: LookImage, b: LookImage) => {
	let sum = 0;
	for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!);
	return sum / a.data.length;
};

/** SSIM of two renders of one layer box at different scales, compared at the smaller. */
function scaledSsim(small: LookImage, large: LookImage): number {
	const a = layerCrop(small, lumaOver(small, 128));
	const b = layerCrop(large, lumaOver(large, 128));
	return ssim(resampleLuma(b.data, b.w, b.h, a.w, a.h), a.data, a.w, a.h);
}

describe.runIf(!!CHROME && process.env.FX_GL !== '0')('Title Look finishes', { timeout: 240_000 }, () => {
	let tl: LookPage;

	beforeAll(async () => {
		tl = await openLookPage(here);
	}, 120_000);

	afterAll(async () => {
		await tl?.browser.close();
	}, 120_000);

	const render = (recipe: LookRecipe, over: Partial<LookRequest> = {}) =>
		tl.render({ recipe, input: TEXT, box: BOX, ...over });

	// Every finish, on every layer type that takes one (§5.1): this is the finishes' completeness check.
	const SHAPE_REQ = { input: { kind: 'shapes' } as const, unitPx: 96, box: { width: 320, height: 160 } };
	/** Base params so every param of the finish has something to change. */
	const CONTEXT: Record<string, Record<string, unknown>> = {
		bevel: { bevelProfile: 'custom', bevelCurve: RIDGED },
		metal: { metalKind: 'brushed', metalEnv: 'studio' },
		glass: { paint: RAMP },
		pattern: { patternKind: 'leopard', patternRelief: 60 },
		reflection: { reflectionColorize: 40 },
	};
	const moved = (p: TitleParamSpec): unknown => {
		if (p.type === 'boolean') return !p.default;
		if (p.type === 'enum') {
			const o = p.options ?? [];
			return o[(o.indexOf(p.default as string) + 1) % o.length];
		}
		if (p.type === 'color') return [0.9, 0.2, 0.1, 1];
		if (p.type === 'number') {
			const d = p.default as number;
			if (p.unit === 'deg') return d + 70;
			return d > 0 ? d * 0.45 : (p.range?.softMax ?? p.range?.max ?? 100) / 3;
		}
		return undefined;
	};
	const tint = flat(0.75, 0.3, 0.25);

	for (const finish of TITLE_FINISHES.filter((f) => f.id !== 'flat'))
		describe(`finish ${finish.id}`, () => {
			const params = (extra: Record<string, unknown> = {}) => ({
				finish: finish.id,
				...CONTEXT[finish.id],
				...extra,
			});
			const onFace = (extra?: Record<string, unknown>): LookRecipe => ({
				palette,
				layers: [{ type: 'face', params: { paint: tint, ...params(extra) } }],
			});

			it('draws on a face, a rim, an inline and a plate, and each differs from flat', async () => {
				for (const layer of ['face', 'rim', 'inline', 'plate']) {
					const layers = (extra: Record<string, unknown>): LookRecipe => ({
						palette,
						layers: [
							...(layer === 'face' ? [] : [{ type: 'face', params: { paint: flat(0.1, 0.1, 0.1) } }]),
							{ type: layer, params: { paint: tint, ...(layer === 'rim' ? { width: 9 } : {}), ...extra } },
						],
					});
					const on = await render(layers(params()), SHAPE_REQ);
					const off = await render(layers({}), SHAPE_REQ);
					expect(difference(on, off), layer).toBeGreaterThan(0.05);
				}
			});

			it('matches its fingerprints at default and perturbed params', async () => {
				const d = await render({
					palette,
					layers: [{ type: 'face', params: { paint: tint, finish: finish.id } }],
				});
				const changed: Record<string, unknown> = {};
				for (const p of finish.params) {
					const v = moved(p);
					if (v !== undefined) changed[p.name] = v;
				}
				const p = await render(onFace(changed));
				expectFingerprints(
					GOLDENS,
					{ [`finish:${finish.id}@default`]: grid(d), [`finish:${finish.id}@perturbed`]: grid(p) },
					4,
				);
			});

			it('every param changes the picture', async () => {
				const base = await render(onFace());
				// The angle of a finish's own paint turns a gradient; these paints are solid here.
				const paints = finish.params.filter((p) => p.type === 'paint').map((p) => `${p.name}Angle`);
				for (const p of finish.params) {
					const v = moved(p);
					if (v === undefined || paints.includes(p.name)) continue;
					const img = await render(onFace({ [p.name]: v }));
					expect(difference(img, base), p.name).toBeGreaterThan(0.01);
				}
			});

			it('is resolution independent and deterministic (TL-034, TL-035)', async () => {
				const at = (k: number) =>
					render(onFace(), {
						input: { kind: 'shapes' },
						unitPx: 96 * k,
						box: { width: 320 * k, height: 160 * k },
					});
				const [a, b, again] = [await at(1), await at(2), await at(1)];
				expect(difference(a, again)).toBe(0);
				const score = scaledSsim(a, b);
				console.info(`[title-look] ${finish.id} 200 % vs 100 %: SSIM ${score.toFixed(4)}`);
				expect(score).toBeGreaterThan(0.97);
			});
		});

	describe('bevel', () => {
		const paint = flat(0.5, 0.5, 0.5);
		const square = { input: RECT, unitPx: 100 };
		it('lights the edge facing the light and shades the other; the top stays the paint', async () => {
			const img = await render(face('bevel', { bevelSize: 10 }, paint), square);
			const x0 = img.box.x + 105;
			const x1 = img.box.x + 315;
			const y = img.box.y + 90;
			const top = pixel(img, x0 + 100, y)[0];
			// The default light is up and to the left.
			expect(pixel(img, x0 + 3, y)[0]).toBeGreaterThan(top + 40);
			expect(pixel(img, x1 - 3, y)[0]).toBeLessThan(top - 40);
			expect(Math.abs(top - 128)).toBeLessThan(3);
		});
		it('each profile has its own cross-section', async () => {
			const seen: number[][] = [];
			for (const p of TL_PROFILES) {
				const img = await render(
					face('bevel', { bevelProfile: p, bevelSize: 16, bevelSoftness: 0, bevelCurve: RIDGED }, paint),
					square,
				);
				seen.push([2, 6, 10, 14].map((d) => pixel(img, img.box.x + 105 + d, img.box.y + 90)[0]));
			}
			for (let i = 0; i < seen.length; i++)
				for (let j = i + 1; j < seen.length; j++)
					expect(
						seen[i]!.some((v, k) => Math.abs(v - seen[j]![k]!) > 6),
						`${TL_PROFILES[i]}/${TL_PROFILES[j]}`,
					).toBe(true);
		});
		it('Fit domes to the centre line of a wide stroke; a fixed size leaves it flat', async () => {
			const at = (fit: boolean) =>
				render(face('bevel', { bevelFit: fit, bevelSize: 8, bevelDepth: 200 }, paint), square);
			const [fixed, fit] = [await at(false), await at(true)];
			const p = (img: LookImage) => pixel(img, img.box.x + 210, img.box.y + 45 + 20)[0];
			expect(Math.abs(p(fixed) - 128)).toBeLessThan(3);
			expect(p(fit)).toBeGreaterThan(p(fixed) + 15);
		});
		it('a rim fits as a tube across its width: the band has two sides', async () => {
			const img = await render(
				{
					layers: [
						{ type: 'rim', params: { width: 16, finish: 'bevel', bevelFit: true, bevelDepth: 200, paint } },
					],
				},
				square,
			);
			const x0 = img.box.x + 105;
			const y = img.box.y + 90;
			// Left rim, 0…16 px outside the rectangle: its outer half faces the light, its inner half turns away.
			expect(pixel(img, x0 - 12, y)[0]).toBeGreaterThan(pixel(img, x0 - 4, y)[0] + 30);
		});
		it('a small shape in a big transparent box bevels as sharply as in a tight box', async () => {
			// No text: the unit is the alpha bounds, unknown when passes are sized.
			const of = (
				box: { width: number; height: number },
				r: { x: number; y: number; w: number; h: number },
			) =>
				render(face('bevel', { bevelSize: 12 }, paint), { input: { kind: 'rect', ...r }, box, unitPx: null });
			// 20 px of margin: a shape that touches its canvas's edge has no edge there (the seeds clamp at the border).
			const tight = await of({ width: 160, height: 100 }, { x: 0.125, y: 0.2, w: 0.75, h: 0.6 });
			// A 120 × 60 shape in a frame-sized box: planned from the box, the blur would run at a quarter of the resolution.
			const loose = await of(
				{ width: 1920, height: 1080 },
				{ x: 900 / 1920, y: 510 / 1080, w: 120 / 1920, h: 60 / 1080 },
			);
			const left = (img: LookImage) => img.width / 2 - 60;
			for (const d of [2, 4, 6]) {
				const a = pixel(tight, left(tight) + d, tight.height / 2)[0];
				const b = pixel(loose, left(loose) + d, loose.height / 2)[0];
				// Measured: equal with the planner's margin, up to 15 levels apart when passes are sized from the box.
				expect(Math.abs(a - b), `${d} px in`).toBeLessThanOrEqual(4);
			}
		});
		it('uses the look’s light', async () => {
			const look = (angle: number): LookRecipe => ({
				...face('bevel', { bevelSize: 10 }, paint),
				light: { angle },
			});
			const [a, b] = [await render(look(180), square), await render(look(0), square)];
			const p = (img: LookImage) => pixel(img, img.box.x + 108, img.box.y + 90)[0];
			expect(p(a)).toBeGreaterThan(p(b) + 60);
		});
	});

	describe('metal', () => {
		it('never reads as flat grey: every metal has a wide range of tones', async () => {
			for (const m of ['gold', 'silver', 'chrome', 'copper', 'brushed']) {
				const img = await render(face('metal', { metalKind: m }));
				expect(lumaSpread(img), m).toBeGreaterThan(70);
			}
		});
		it('gold and copper are warm, silver and chrome neutral', async () => {
			const mean = async (m: string) => meanRgb(await render(face('metal', { metalKind: m })));
			const gold = await mean('gold');
			expect(gold[0]).toBeGreaterThan(gold[1] * 1.1);
			expect(gold[1]).toBeGreaterThan(gold[2] * 1.2);
			const copper = await mean('copper');
			expect(copper[0]).toBeGreaterThan(copper[1] * 1.15);
			for (const m of ['silver', 'chrome']) {
				const c = await mean(m);
				expect(Math.abs(c[0] - c[2]) / c[1], m).toBeLessThan(0.25);
			}
		});
		it('a large flat face is not one flat colour: the sheet bend runs the horizon across it', async () => {
			const img = await render(face('metal', { metalFit: false, metalSize: 4 }), {
				input: WIDE,
				unitPx: 100,
			});
			expect(lumaSpread(img)).toBeGreaterThan(90);
		});
		it('brushed metal has grain across its direction, in the unit', async () => {
			const img = await render(
				face('metal', { metalKind: 'brushed', metalFit: false, metalCurve: 0, metalGrain: 2 }),
				{ input: RECT, unitPx: 100 },
			);
			const x = img.box.x + 200;
			let across = 0;
			let along = 0;
			for (let i = 0; i < 40; i++) {
				across += Math.abs(pixel(img, x, img.box.y + 70 + i)[1] - pixel(img, x, img.box.y + 71 + i)[1]);
				along += Math.abs(
					pixel(img, x - 20 + i, img.box.y + 80)[1] - pixel(img, x - 19 + i, img.box.y + 80)[1],
				);
			}
			expect(across).toBeGreaterThan(along * 2);
		});
	});

	describe('glass', () => {
		it('shows what is under it, more through the body than at its rim', async () => {
			const img = await render(
				{
					palette,
					layers: [
						{ type: 'plate', params: { grow: 20, paint: flat(1, 0, 0), corner: 0 } },
						{
							type: 'face',
							params: { finish: 'glass', glassTint: 0, paint: flat(0.2, 0.7, 1), glassSize: 12 },
						},
					],
				},
				{ input: RECT, unitPx: 100 },
			);
			const y = img.box.y + 90;
			const body = pixel(img, img.box.x + 210, y);
			const edge = pixel(img, img.box.x + 108, y);
			expect(body[0]).toBeGreaterThan(60); // the red plate through the body
			expect(edge[0]).toBeLessThan(body[0]);
		});
		it('refracts its own fill: a gradient bends at the edges, the middle stays', async () => {
			const g: Paint = {
				kind: 'gradient',
				gradient: {
					type: 'linear',
					span: 'block',
					angle: 0,
					stops: [
						{ at: 0, paint: { color: [0, 0, 0, 1] } },
						{ at: 1, paint: { color: [1, 1, 1, 1] } },
					],
				},
			};
			const at = (r: number) =>
				render(face('glass', { glassRefraction: r, glassOpacity: 100 }, g), { input: RECT, unitPx: 100 });
			const [off, on] = [await at(0), await at(14)];
			const p = (img: LookImage, dx: number) => pixel(img, img.box.x + 105 + dx, img.box.y + 90)[2];
			expect(Math.abs(p(off, 100) - p(on, 100))).toBeLessThan(4);
			expect(Math.abs(p(off, 205) - p(on, 205))).toBeGreaterThan(4);
		});
	});

	describe('reflection environments (TL-038)', () => {
		it('every preset is its own room', async () => {
			const seen: LookImage[] = [];
			for (const e of TL_ENV_PRESETS) seen.push(await render(face('reflection', { reflectionEnv: e })));
			for (let i = 0; i < seen.length; i++)
				for (let j = i + 1; j < seen.length; j++)
					expect(difference(seen[i]!, seen[j]!), `${TL_ENV_PRESETS[i]}/${TL_ENV_PRESETS[j]}`).toBeGreaterThan(
						1,
					);
		});
		it('blur softens the room, rotation turns it', async () => {
			const at = (x: Record<string, unknown>) => render(face('reflection', { reflectionEnv: 'neon', ...x }));
			const [sharp, soft, turned] = [
				await at({ reflectionBlur: 0 }),
				await at({ reflectionBlur: 60 }),
				await at({ reflectionRotation: 90 }),
			];
			expect(lumaSpread(soft)).toBeLessThan(lumaSpread(sharp));
			expect(difference(sharp, turned)).toBeGreaterThan(1);
		});
		const SKY_OVER_GROUND = { width: 64, height: 32, bands: ['#ff0000', '#00ff00', '#0000ff'] };
		it('draws a real image bound through a {mediaId} param: red zenith, green horizon, blue ground', async () => {
			const recipe = face('reflection', {
				reflectionImage: { mediaId: 'mda_panorama' },
				reflectionBlur: 0,
				reflectionSize: 30,
				reflectionFit: false,
			});
			const img = await render(recipe, {
				input: RECT,
				unitPx: 100,
				images: { mda_panorama: SKY_OVER_GROUND },
			});
			const x = img.box.x + 210;
			const top = pixel(img, x, img.box.y + 45 + 6);
			const mid = pixel(img, x, img.box.y + 90);
			const bottom = pixel(img, x, img.box.y + 135 - 6);
			// The top edge leans back and mirrors the zenith, the flat middle the horizon, the bottom edge the ground.
			expect(top[0]).toBeGreaterThan(top[1] + 80);
			expect(mid[1]).toBeGreaterThan(mid[0] + 80);
			expect(bottom[2]).toBeGreaterThan(bottom[1] + 80);
		});
		it('blurs the image in direction space, the same at every resolution', async () => {
			const at = (k: number) =>
				render(face('reflection', { reflectionImage: { mediaId: 'mda_p' }, reflectionBlur: 30 }), {
					input: { kind: 'shapes' },
					unitPx: 96 * k,
					box: { width: 320 * k, height: 160 * k },
					images: { mda_p: SKY_OVER_GROUND },
				});
			expect(scaledSsim(await at(1), await at(2))).toBeGreaterThan(0.97);
		});
		it('an image that is not there (offline) draws the preset, not black', async () => {
			const on = await render(
				face('reflection', { reflectionImage: { mediaId: 'mda_gone' }, reflectionEnv: 'sky' }),
			);
			const preset = await render(face('reflection', { reflectionEnv: 'sky' }));
			expect(difference(on, preset)).toBe(0);
		});
	});

	describe('pattern', () => {
		it('every motif draws marks, with crisp edges', async () => {
			for (const k of TL_PATTERN_KINDS.filter((x) => x !== 'image')) {
				const img = await render(
					face(
						'pattern',
						{ patternKind: k, patternScale: 14, patternInk: flat(0, 0, 0), patternInkAlt: flat(1, 1, 1) },
						flat(1, 1, 1),
					),
					{ input: WIDE, unitPx: 100 },
				);
				let dark = 0;
				let light = 0;
				for (let i = 0; i < img.data.length; i += 4) {
					if (img.data[i + 3]! < 250) continue;
					if (img.data[i]! < 40) dark++;
					else if (img.data[i]! > 215) light++;
				}
				expect(dark, k).toBeGreaterThan(300);
				expect(light, k).toBeGreaterThan(300);
			}
		});
		it('sits on the layer box: padding around the look does not move it', async () => {
			const recipe = face('pattern', { patternKind: 'checker', patternScale: 20 }, flat(1, 1, 1));
			const a = await render(recipe, { input: RECT, unitPx: 100 });
			const b = await render(recipe, { input: RECT, unitPx: 100, pad: 37 });
			const ca = layerCrop(a, lumaOver(a, 128));
			const cb = layerCrop(b, lumaOver(b, 128));
			expect(ssim(ca.data, cb.data, ca.w, ca.h)).toBeGreaterThan(0.999);
		});
		it('tiles a real image through a {mediaId} param', async () => {
			const recipe = face(
				'pattern',
				{
					patternKind: 'image',
					patternImage: { mediaId: 'mda_tile' },
					patternScale: 40,
					patternInk: flat(0, 0, 0),
				},
				flat(1, 0, 0),
			);
			const img = await render(recipe, {
				input: WIDE,
				unitPx: 100,
				images: { mda_tile: { width: 64, height: 64, checker: ['#ffffff', '#000000'] } },
			});
			const none = await render(recipe, { input: WIDE, unitPx: 100 });
			expect(difference(img, none)).toBeGreaterThan(5);
			// No picture: no marks, the paint alone.
			expect(pixel(none, none.box.x + 200, none.box.y + 90)[0]).toBeGreaterThan(250);
		});
	});

	describe('plate', () => {
		const plate = (params: Record<string, unknown>): LookRecipe => ({
			layers: [{ type: 'plate', params: { paint: flat(0, 0, 1), ...params } }],
		});
		const THIN = { kind: 'rect', x: 0.3, y: 0.3, w: 0.4, h: 0.4 } as const;
		it('box: the bounds grown, round corners; pill: full round ends', async () => {
			const box = await render(plate({ kind: 'box', grow: 10, corner: 0 }), { input: THIN, unitPx: 100 });
			const rx = box.box.x + 126;
			const ry = box.box.y + 54;
			expect(pixel(box, rx - 6, ry - 6)[3]).toBeGreaterThan(250);
			expect(pixel(box, rx - 13, ry + 20)[3]).toBe(0);
			const round = await render(plate({ kind: 'box', grow: 10, corner: 30 }), { input: THIN, unitPx: 100 });
			expect(pixel(round, rx - 8, ry - 8)[3]).toBe(0);
			const pill = await render(plate({ kind: 'pill', grow: 10 }), { input: THIN, unitPx: 100 });
			expect(pixel(pill, rx - 6, ry - 6)[3]).toBe(0);
			expect(pixel(pill, rx - 6, ry + 36)[3]).toBeGreaterThan(250);
		});
		it('hull: bridges what contour leaves open', async () => {
			const input = {
				kind: 'bars',
				bars: [
					{ x: 0.2, y: 0.2, w: 0.1, h: 0.6 },
					{ x: 0.2, y: 0.7, w: 0.6, h: 0.1 },
				],
			} as const;
			const hull = await render(plate({ kind: 'hull', grow: 0 }), { input, unitPx: 100 });
			const contour = await render(plate({ kind: 'contour', grow: 0, close: 0 }), { input, unitPx: 100 });
			// Inside the triangle of an L, near the hypotenuse.
			const x = hull.box.x + 420 * 0.38;
			const y = hull.box.y + 180 * 0.6;
			expect(pixel(hull, x, y)[3]).toBeGreaterThan(250);
			expect(pixel(contour, x, y)[3]).toBe(0);
			// Outside the hypotenuse.
			expect(pixel(hull, hull.box.x + 420 * 0.6, hull.box.y + 180 * 0.3)[3]).toBe(0);
		});
		it('contour: Close fills a counter up to its radius', async () => {
			const input = {
				kind: 'bars',
				bars: [
					{ x: 0.2, y: 0.2, w: 0.25, h: 0.6 },
					{ x: 0.55, y: 0.2, w: 0.25, h: 0.6 },
				],
			} as const;
			const gap = (img: LookImage) => pixel(img, img.box.x + 210, img.box.y + 90)[3];
			const [open, closed] = [
				await render(plate({ kind: 'contour', grow: 2, close: 0 }), { input, unitPx: 100 }),
				await render(plate({ kind: 'contour', grow: 2, close: 30 }), { input, unitPx: 100 }),
			];
			expect(gap(open)).toBe(0);
			expect(gap(closed)).toBeGreaterThan(250);
		});
		it('slant: leans by Skew, tight on the ink, and its padding holds a tall shape', async () => {
			const tall = { kind: 'rect', x: 0.4, y: 0, w: 0.2, h: 1 } as const;
			const img = await render(plate({ kind: 'slant', skew: 20, grow: 0, corner: 0 }), {
				input: tall,
				unitPx: 100,
			});
			const lean = Math.tan((20 * Math.PI) / 180) * 180;
			const right = img.box.x + 252;
			// Leaning right at the top: past the ink's right side up there, on it at the bottom.
			expect(pixel(img, right + lean * 0.9, img.box.y + 4)[3]).toBeGreaterThan(250);
			expect(pixel(img, right + 20, img.box.y + 176)[3]).toBe(0);
			let edge = 0;
			for (let y = 0; y < img.height; y++)
				edge = Math.max(edge, pixel(img, 0, y)[3], pixel(img, img.width - 1, y)[3]);
			expect(edge).toBeLessThanOrEqual(3);
		});
		it('takes a finish across its own shape: a bevel lights the plate’s edge, not the text’s', async () => {
			const img = await render(
				plate({
					kind: 'box',
					grow: 20,
					corner: 0,
					finish: 'bevel',
					bevelSize: 8,
					paint: flat(0.5, 0.5, 0.5),
				}),
				{ input: THIN, unitPx: 100 },
			);
			const y = img.box.y + 90;
			const left = img.box.x + 126 - 20;
			expect(pixel(img, left + 3, y)[0]).toBeGreaterThan(pixel(img, left + 18, y)[0] + 40);
			expect(Math.abs(pixel(img, left + 18, y)[0] - 128)).toBeLessThan(4);
		});
	});

	describe('layers over the stack', () => {
		const base = { type: 'face', params: { paint: flat(0.4, 0.4, 0.45) } };
		const square = { input: RECT, unitPx: 100 };
		it('sheen: Position moves the band, and it paints nothing outside the shape', async () => {
			const at = (position: number) =>
				render({ layers: [base, { type: 'sheen', params: { position, angle: 0, width: 12 } }] }, square);
			const peak = (img: LookImage) => {
				let best = 0;
				let where = 0;
				for (let x = 0; x < img.width; x++) {
					const v = pixel(img, x, img.box.y + 90)[0];
					if (v > best) {
						best = v;
						where = x;
					}
				}
				return where - img.box.x;
			};
			const [a, b] = [await at(25), await at(75)];
			expect(Math.abs(peak(a) - (105 + 52))).toBeLessThan(6);
			expect(Math.abs(peak(b) - (105 + 157))).toBeLessThan(6);
			const off = await render({ layers: [base] }, square);
			expect(alphaSum(a)).toBe(alphaSum(off));
		});
		it('sheen crosses what is below it, rims included', async () => {
			const stack = (sheen: boolean): LookRecipe => ({
				layers: [
					{ type: 'rim', params: { width: 8, paint: flat(0.2, 0.2, 0.2) } },
					base,
					...(sheen ? [{ type: 'sheen', params: { position: 0, angle: 0, width: 8 } }] : []),
				],
			});
			const [on, off] = [await render(stack(true), square), await render(stack(false), square)];
			const p = (img: LookImage) => pixel(img, img.box.x + 101, img.box.y + 90)[0];
			expect(p(on)).toBeGreaterThan(p(off) + 30);
		});
		it('gloss: a cap across the upper part, keeping the alpha', async () => {
			const img = await render(
				{ layers: [base, { type: 'gloss', params: { intensity: 70, curve: 0 } }] },
				square,
			);
			const off = await render({ layers: [base] }, square);
			const x = img.box.x + 210;
			expect(pixel(img, x, img.box.y + 50)[0]).toBeGreaterThan(pixel(img, x, img.box.y + 130)[0] + 40);
			expect(alphaSum(img)).toBe(alphaSum(off));
		});
		const texture = (params: Record<string, unknown>): LookRecipe => ({
			layers: [base, { type: 'texture', params }],
		});
		it('grain sits in the unit: the same grain at 100 % and 200 %, no render-pixel noise (TL-034)', async () => {
			const at = (k: number) =>
				render(texture({ kind: 'grain', scale: 3, amount: 90 }), {
					input: WIDE,
					unitPx: 100 * k,
					box: { width: 420 * k, height: 180 * k },
				});
			const [a, b] = [await at(1), await at(2)];
			expect(lumaSpread(a)).toBeGreaterThan(15);
			expect(scaledSsim(a, b)).toBeGreaterThan(0.9);
		});
		it('boil animates grain as a closed form of content time, and is still without it', async () => {
			const boil = texture({ kind: 'grain', scale: 3, amount: 90, boil: 12 });
			const [a, again, b] = [
				await render(boil, { contentSeconds: 1 }),
				await render(boil, { contentSeconds: 1 }),
				await render(boil, { contentSeconds: 1.2 }),
			];
			expect(difference(a, again)).toBe(0);
			expect(difference(a, b)).toBeGreaterThan(0.2);
			const still = texture({ kind: 'grain', scale: 3, amount: 90 });
			expect(
				difference(await render(still, { contentSeconds: 1 }), await render(still, { contentSeconds: 2 })),
			).toBe(0);
		});
		it('the appearance seed and Seed reshuffle noise; the same seed draws the same', async () => {
			const n = texture({ kind: 'noise', scale: 8, amount: 90 });
			const [a, b, c] = [
				await render(n, { seed: 1 }),
				await render(n, { seed: 1 }),
				await render(n, { seed: 2 }),
			];
			expect(difference(a, b)).toBe(0);
			expect(difference(a, c)).toBeGreaterThan(0.2);
			const d = await render(texture({ kind: 'noise', scale: 8, amount: 90, noiseSeed: 5 }), { seed: 1 });
			expect(difference(a, d)).toBeGreaterThan(0.2);
		});
		it('pattern over the stack marks everything below it', async () => {
			const img = await render(
				texture({
					kind: 'pattern',
					motif: 'checker',
					scale: 20,
					amount: 100,
					paint: flat(1, 0, 0),
					paintAlt: flat(0, 1, 0),
				}),
				square,
			);
			let red = 0;
			let green = 0;
			for (let i = 0; i < img.data.length; i += 4) {
				if (img.data[i + 3]! < 250) continue;
				if (img.data[i]! > 200) red++;
				if (img.data[i + 1]! > 200) green++;
			}
			expect(red).toBeGreaterThan(1000);
			expect(green).toBeGreaterThan(1000);
		});
		it('dry-brush erosion takes ink from the edges, along the drag, and keeps the middle', async () => {
			const stack = (amount: number): LookRecipe => ({
				layers: [
					base,
					{ type: 'texture', params: { kind: 'erosion', amount, scale: 1.5, edge: 24, length: 40 } },
				],
			});
			const [off, on] = [await render(stack(0), square), await render(stack(70), square)];
			expect(alphaSum(on)).toBeLessThan(alphaSum(off) * 0.98);
			expect(pixel(on, on.box.x + 210, on.box.y + 90)[3]).toBe(255);
			// Across the drag the cut alternates (lanes).
			let across = 0;
			for (let i = 0; i < 80; i++)
				across += Math.abs(
					pixel(on, on.box.x + 110, on.box.y + 50 + i)[3] - pixel(on, on.box.x + 110, on.box.y + 51 + i)[3],
				);
			expect(across).toBeGreaterThan(200);
		});
	});

	describe('line and glyph spans (TL-036)', () => {
		const ramp = {
			type: 'linear',
			angle: 0,
			stops: [
				{ at: 0, paint: { color: [0, 0, 0, 1] } },
				{ at: 1, paint: { color: [1, 1, 1, 1] } },
			],
		};
		const span = (s: 'block' | 'line' | 'glyph'): LookRecipe => ({
			layers: [
				{ type: 'face', params: { paint: { kind: 'gradient', gradient: { ...ramp, span: s } } as Paint } },
			],
		});
		// Three "glyphs" of 42 px, two on the first line and one on the second, in a 420 × 180 box.
		const A = { x: 0.1, y: 0.1, w: 0.1, h: 0.3 };
		const B = { x: 0.4, y: 0.1, w: 0.1, h: 0.3 };
		const C = { x: 0.1, y: 0.6, w: 0.1, h: 0.3 };
		const boxOf = (r: typeof A): SpanBox => [r.x * 420, r.y * 180, (r.x + r.w) * 420, (r.y + r.h) * 180];
		const glyphs: SpanGlyph[] = [
			{ box: boxOf(A), line: 0 },
			{ box: boxOf(B), line: 0 },
			{ box: boxOf(C), line: 1 },
		];
		const input = { kind: 'bars', bars: [A, B, C] } as const;
		const shade = (img: LookImage, r: typeof A, at: number) =>
			pixel(img, img.box.x + (r.x + r.w * at) * 420, img.box.y + (r.y + r.h / 2) * 180)[0];

		it('glyph: each glyph runs the whole ramp', async () => {
			const img = await render(span('glyph'), { input, unitPx: 100, glyphs });
			for (const r of [A, B, C]) {
				expect(shade(img, r, 0.03)).toBeLessThan(50);
				expect(shade(img, r, 0.97)).toBeGreaterThan(230);
			}
		});
		it('line: the ramp runs across each line', async () => {
			const img = await render(span('line'), { input, unitPx: 100, glyphs });
			expect(shade(img, A, 0.03)).toBeLessThan(50);
			expect(shade(img, A, 0.97)).toBeLessThan(150);
			expect(shade(img, B, 0.97)).toBeGreaterThan(230);
			// The second line holds one glyph: it runs the whole ramp on its own.
			expect(shade(img, C, 0.97)).toBeGreaterThan(230);
		});
		it('block: the ramp runs across the text at rest', async () => {
			const img = await render(span('block'), { input, unitPx: 100, glyphs });
			expect(shade(img, C, 0.97)).toBeLessThan(150);
			expect(shade(img, B, 0.97)).toBeGreaterThan(230);
		});
		it('a moved glyph carries its ramp, and every other glyph keeps its own', async () => {
			// B drawn 60 px to the right and 30 px down, A and C where they rest.
			const dx = 60;
			const dy = 30;
			const movedInput = {
				kind: 'bars',
				bars: [A, { ...B, x: B.x + dx / 420, y: B.y + dy / 180 }, C],
			} as const;
			const moved = glyphs.map((g, i) => (i === 1 ? { ...g, toDrawn: [1, 0, dx, 0, 1, dy, 0, 0, 1] } : g));
			const still = await render(span('glyph'), { input, unitPx: 100, glyphs });
			const img = await render(span('glyph'), { input: movedInput, unitPx: 100, glyphs: moved });
			const at = (i: LookImage, ox: number, oy: number) =>
				pixel(i, i.box.x + (B.x + B.w * 0.5) * 420 + ox, i.box.y + (B.y + B.h / 2) * 180 + oy)[0];
			expect(Math.abs(at(img, dx, dy) - at(still, 0, 0))).toBeLessThanOrEqual(2);
			expect(Math.abs(shade(img, A, 0.5) - shade(still, A, 0.5))).toBeLessThanOrEqual(1);
			// Line spans too: the moved glyph's colour comes from where it rests in its line.
			const line = await render(span('line'), { input, unitPx: 100, glyphs });
			const lineMoved = await render(span('line'), { input: movedInput, unitPx: 100, glyphs: moved });
			expect(Math.abs(at(lineMoved, dx, dy) - at(line, 0, 0))).toBeLessThanOrEqual(2);
		});
		it('a turned glyph keeps its ramp along its own axis', async () => {
			// A quarter turn about the centre of A: the horizontal ramp now runs down the screen.
			const r = boxOf(A);
			const cx = (r[0] + r[2]) / 2;
			const cy = (r[1] + r[3]) / 2;
			const hw = (r[2] - r[0]) / 2;
			const hh = (r[3] - r[1]) / 2;
			const turned = { x: (cx - hh) / 420, y: (cy - hw) / 180, w: (2 * hh) / 420, h: (2 * hw) / 180 };
			const img = await render(span('glyph'), {
				input: { kind: 'bars', bars: [turned] },
				unitPx: 100,
				glyphs: [{ box: r, line: 0, toDrawn: [0, -1, cx + cy, 1, 0, cy - cx, 0, 0, 1] }],
			});
			const x = img.box.x + cx;
			expect(pixel(img, x, img.box.y + cy - hw + 2)[0]).toBeLessThan(50);
			expect(pixel(img, x, img.box.y + cy + hw - 2)[0]).toBeGreaterThan(220);
		});
		it('a seam between two glyphs under a rim is antialiased, not stepped', async () => {
			const down = { ...ramp, type: 'linear', angle: 90, span: 'glyph' };
			const a = { x: 0.2, y: 0.2, w: 0.1, h: 0.2 };
			const b = { x: 0.34, y: 0.6, w: 0.1, h: 0.2 };
			const img = await render(
				{
					layers: [
						{ type: 'rim', params: { width: 80, paint: { kind: 'gradient', gradient: down } as Paint } },
					],
				},
				{
					input: { kind: 'bars', bars: [a, b] },
					unitPx: 100,
					glyphs: [
						{ box: boxOf(a), line: 0 },
						{ box: boxOf(b), line: 0 },
					],
				},
			);
			// Along a row between the glyphs the owner changes: the step between two pixels stays below the jump.
			const y = img.box.y + 0.5 * 180;
			const row = Array.from({ length: 80 }, (_, i) => pixel(img, img.box.x + 100 + i * 2, y)[0]);
			const low = Math.min(...row);
			const high = Math.max(...row);
			expect(high - low).toBeGreaterThan(80);
			const inBetween = row.filter((v) => v > low + 8 && v < high - 8).length;
			expect(inBetween).toBeGreaterThan(0);
		});
		it('without text layout, line and glyph are exactly block (the clip has no glyphs)', async () => {
			const block = await render(span('block'), { input, unitPx: 100 });
			for (const s of ['line', 'glyph'] as const)
				expect(difference(await render(span(s), { input, unitPx: 100 }), block)).toBe(0);
		});
		it('is resolution independent: boxes are in layer px', async () => {
			const at = (k: number) =>
				render(span('glyph'), {
					input,
					unitPx: 100 * k,
					box: { width: 420 * k, height: 180 * k },
					glyphs: glyphs.map((g) => ({ ...g, box: g.box.map((v) => v * k) as unknown as SpanBox })),
				});
			expect(scaledSsim(await at(1), await at(2))).toBeGreaterThan(0.98);
		});
		it('preview scale: records stay in layer px when the canvas is drawn smaller', async () => {
			const [a, b] = [
				await render(span('glyph'), { input, unitPx: 100, glyphs }),
				await render(span('glyph'), { input, unitPx: 100, glyphs, pxScale: 0.5 }),
			];
			const ca = layerCrop(a, lumaOver(a, 128));
			const cb = layerCrop(b, lumaOver(b, 128));
			expect(ssim(resampleLuma(ca.data, ca.w, ca.h, cb.w, cb.h), cb.data, cb.w, cb.h)).toBeGreaterThan(0.93);
		});
	});

	describe('Title Material (§8)', () => {
		const card = { kind: 'card' } as const;
		const params = (material: string, extra: Record<string, unknown> = {}) => ({
			material,
			size: 100,
			...extra,
		});
		const run = (material: Record<string, unknown>, input: LookRequest['input'] = card) =>
			tl.render({ recipe: { layers: [] }, input, box: BOX, material, unitPx: 100 });
		it('shades exactly as the finish it shares: on any alpha it equals a look’s face over the clip’s picture', async () => {
			for (const [material, finish] of [
				['bevel', 'bevel'],
				['chrome', 'metal'],
				['glass', 'glass'],
				['satin', 'satin'],
			] as const) {
				const a = await run(params(material));
				const b = await render(
					{ layers: [{ type: 'face', params: { paint: { kind: 'source' }, finish } }] },
					{ input: card, unitPx: 100, seed: 0 },
				);
				expect(difference(a, b), material).toBeLessThan(0.05);
			}
		});
		it('each material changes the picture, keeps the clip’s alpha and adds no padding', async () => {
			const off = await render(
				{ layers: [{ type: 'face', params: { paint: { kind: 'source' } } }] },
				{ input: card, unitPx: 100 },
			);
			for (const m of ['bevel', 'chrome', 'satin']) {
				const img = await run(params(m));
				expect(difference(img, off), m).toBeGreaterThan(1);
				expect(alphaSum(img), m).toBe(alphaSum(off));
				expect(img.padding).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
			}
		});
		it('Size scales it with the layer (TL-034)', async () => {
			const at = (k: number) =>
				tl.render({
					recipe: { layers: [] },
					input: { kind: 'shapes' },
					box: { width: 320 * k, height: 160 * k },
					material: { material: 'chrome', size: 100 * k },
				});
			expect(scaledSsim(await at(1), await at(2))).toBeGreaterThan(0.97);
		});
	});
});
