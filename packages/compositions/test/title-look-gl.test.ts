// @vitest-environment node
// Title Looks in real WebGL2 (headless Chrome, SwiftShader): the shape field, linear-light compositing, every layer type,
// resolution independence and determinism. Fingerprints: `goldens/title-look-fingerprints.json` (JASPER_BLESS=1).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LookRecipe, type Paint, TITLE_FINISHES, TITLE_LAYER_TYPES } from '@jasper/project';
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

const palette = {
	face: [0.95, 0.75, 0.2, 1],
	keyline: [0.1, 0.2, 0.9, 1],
	shadow: [0, 0, 0, 1],
	glow: [1, 0.2, 0.6, 1],
} as NonNullable<LookRecipe['palette']>;

const TEXT: LookRequest['input'] = { kind: 'text', text: 'Ag', size: 96 };
const BOX = { width: 320, height: 160 };

const flat = (hex: number[]): Paint => ({ kind: 'color', color: hex as [number, number, number, number] });

const six: LookRecipe = {
	palette,
	layers: [
		{ type: 'shadow', params: { distance: 10, blur: 8, angle: 60 } },
		{ type: 'glow', params: { radius: 24 } },
		{ type: 'rim', params: { width: 8 } },
		{ type: 'rim', params: { width: 4, paint: { kind: 'role', role: 'accent1' } } },
		{ type: 'rim', params: { width: 2, paint: { kind: 'role', role: 'accent2' } } },
		{ type: 'face', params: {} },
	],
};

/** Every param moved off its default (the perturbed fingerprint: unwired params show up as a golden change). */
function perturbedParams(type: (typeof TITLE_LAYER_TYPES)[number]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const p of type.params) {
		if (p.type === 'paint') {
			out[p.name] = flat([0.2, 0.8, 0.4, 1]);
			continue;
		}
		const d = p.default as unknown;
		if (p.type === 'number' && typeof d === 'number') {
			const hi = p.range?.softMax ?? p.range?.max ?? d + 10;
			out[p.name] = d + (hi - d) / 3;
		} else if (p.type === 'boolean') out[p.name] = !d;
		else if (p.type === 'enum' && p.options?.length)
			out[p.name] = p.options[(p.options.indexOf(d as string) + 1) % p.options.length];
	}
	return out;
}

const grid = (img: LookImage) =>
	meanGrid({ width: img.width, height: img.height, data: new Uint8Array(img.data) }, 4);

const difference = (a: LookImage, b: LookImage) => {
	let sum = 0;
	for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!);
	return sum / a.data.length;
};

describe.runIf(!!CHROME && process.env.FX_GL !== '0')('Title Looks in WebGL2', { timeout: 120_000 }, () => {
	let tl: LookPage;

	beforeAll(async () => {
		tl = await openLookPage(here);
	}, 120_000);

	afterAll(async () => {
		await tl?.browser.close();
	});

	const render = (recipe: LookRecipe, over: Partial<LookRequest> = {}) =>
		tl.render({ recipe, input: TEXT, box: BOX, ...over });

	it('runs on floating-point targets', async () => {
		expect(await tl.float()).toBe(true);
		console.info(`[title-look] renderer: ${await tl.renderer()}`);
	});

	it('refuses without float targets, never degrading to 8 bits (TL-032)', async () => {
		const message = await tl.withoutFloat({ recipe: six, input: TEXT, box: BOX });
		expect(message).toContain('TITLE_LOOK_NEEDS_FLOAT');
	});

	it('a look with no layers passes the clip through', async () => {
		const img = await render({ layers: [] });
		expect(img.passes).toBe(1);
		const lit = img.data.reduce((n, v, i) => n + (i % 4 === 3 && v > 200 ? 1 : 0), 0);
		expect(lit).toBeGreaterThan(500);
	});

	it('face: a flat paint fills exactly the input alpha', async () => {
		const img = await render(
			{ palette, layers: [{ type: 'face' }] },
			{ input: { kind: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, unitPx: 100 },
		);
		// The rectangle: 80…240 × 40…120 in the box. A palette colour comes back as it was stored (linear round trip).
		expect(pixel(img, 160, 80).map((v) => Math.round(v / 2.55))).toEqual([95, 75, 20, 100]);
		expect(pixel(img, 60, 80)[3]).toBe(0);
	});

	it('rim: a ring of exactly its width around the shape, in the unit (TL-012)', async () => {
		const img = await render(
			{ layers: [{ type: 'rim', params: { width: 10, paint: flat([1, 0, 0, 1]) } }] },
			{ input: { kind: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, unitPx: 100, pad: 0 },
		);
		const x0 = img.box.x + 80;
		// 10 % of 100 px = 10 px outside the left edge: inside at 5 px, gone at 12 px.
		expect(pixel(img, x0 - 5, img.box.y + 80)[3]).toBeGreaterThan(250);
		expect(pixel(img, x0 - 12, img.box.y + 80)[3]).toBe(0);
		// Hollow: well inside the shape nothing is painted.
		expect(pixel(img, x0 + 30, img.box.y + 80)[3]).toBe(0);
	});

	it('rims stack: each grows from the one above it', async () => {
		const img = await render(
			{
				layers: [
					{ type: 'rim', params: { width: 10, paint: flat([0, 0, 1, 1]) } },
					{ type: 'rim', params: { width: 10, paint: flat([0, 1, 0, 1]) } },
					{ type: 'face', params: { paint: flat([1, 0, 0, 1]) } },
				],
			},
			{ input: { kind: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, unitPx: 100 },
		);
		const y = img.box.y + 80;
		const x0 = img.box.x + 80;
		expect(pixel(img, x0 + 5, y)[0]).toBeGreaterThan(240); // face
		expect(pixel(img, x0 - 5, y)[1]).toBeGreaterThan(240); // first rim
		expect(pixel(img, x0 - 15, y)[2]).toBeGreaterThan(240); // second rim
		expect(pixel(img, x0 - 25, y)[3]).toBe(0);
	});

	it('a fading glyph fades its rim in, with no pop at any opacity (per-character animators)', async () => {
		const recipe: LookRecipe = { layers: [{ type: 'rim', params: { width: 6, paint: flat([1, 0, 0, 1]) } }] };
		const rect = { kind: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5 } as const;
		const at = async (o: number) => {
			const img = await render(recipe, { input: { ...rect, color: `rgba(255,255,255,${o})` }, unitPx: 100 });
			return pixel(img, img.box.x + 77, img.box.y + 80)[3];
		};
		const steps = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1];
		const alphas: number[] = [];
		for (const o of steps) alphas.push(await at(o));
		// Rises with the glyph and is full from half opacity: no step anywhere as the glyph crosses a threshold.
		for (let i = 1; i < alphas.length; i++) {
			expect(alphas[i]! - alphas[i - 1]!).toBeGreaterThanOrEqual(-1);
			expect(alphas[i]! - alphas[i - 1]!).toBeLessThan(70);
		}
		expect(alphas[0]).toBeGreaterThan(30);
		expect(alphas.at(-1)).toBeGreaterThan(250);
	});

	it('solid text has solid rims: thin antialiased edges do not read as a faint shape', async () => {
		const img = await render({ layers: [{ type: 'rim', params: { width: 14, paint: flat([1, 0, 0, 1]) } }] });
		// Every pixel well inside the band around the glyphs is opaque: a false edge shows up as a translucent wedge.
		let inBand = 0;
		let weak = 0;
		for (let y = 2; y < img.height - 2; y++)
			for (let x = 2; x < img.width - 2; x++) {
				const a = pixel(img, x, y)[3];
				if (a === 0) continue;
				// Three pixels inside the band every way: antialiased band edges are out of the count.
				const around = [-3, 0, 3].flatMap((dx) => [-3, 0, 3].map((dy) => pixel(img, x + dx, y + dy)[3]));
				if (around.some((v) => v < 250)) continue;
				inBand++;
				if (a < 250) weak++;
			}
		expect(inBand).toBeGreaterThan(300);
		expect(weak).toBe(0);
	});

	it('compositing is linear light: a half-covered glow over white matches the exact mix', async () => {
		const img = await render(
			{
				layers: [
					{ type: 'face', params: { paint: flat([1, 1, 1, 1]) } },
					{ type: 'face', params: { paint: flat([0, 0, 0, 1]), opacity: 50 } },
				],
			},
			{ input: { kind: 'rect', x: 0, y: 0, w: 1, h: 1 }, unitPx: 100 },
		);
		// Half black over white in linear light is 0.5 linear = 188 in sRGB (a gamma-space mix would give 128).
		const [r, , , a] = pixel(img, 160, 80);
		expect(a).toBe(255);
		expect(Math.abs(r - 188)).toBeLessThanOrEqual(1);
	});

	it('gradient paint: spans the alpha bounds of the shape (block), between its stops', async () => {
		const img = await render(
			{
				layers: [
					{
						type: 'face',
						params: {
							paint: {
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
							},
						},
					},
				],
			},
			{ input: { kind: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, unitPx: 100 },
		);
		const y = img.box.y + 80;
		const x0 = img.box.x + 80;
		expect(pixel(img, x0 + 1, y)[0]).toBeLessThan(12);
		expect(Math.abs(pixel(img, x0 + 80, y)[0] - 128)).toBeLessThan(6);
		expect(pixel(img, x0 + 158, y)[0]).toBeGreaterThan(244);
	});

	it('unit without text: the shorter side of the alpha bounds, whatever the margins (TL-012)', async () => {
		const rimOf = (b: { width: number; height: number }, r: { x: number; y: number; w: number; h: number }) =>
			render(
				{ layers: [{ type: 'rim', params: { width: 25, paint: flat([1, 0, 0, 1]) } }] },
				{ input: { kind: 'rect', ...r }, box: b, unitPx: null },
			);
		// The same 80×40 shape in a tight box and in a box with wide transparent margins: 25 % of 40 = 10 px.
		const tight = await rimOf({ width: 80, height: 40 }, { x: 0, y: 0, w: 1, h: 1 });
		const loose = await rimOf({ width: 320, height: 160 }, { x: 0.375, y: 0.375, w: 0.25, h: 0.25 });
		for (const img of [tight, loose]) {
			const cx = img.box.x + img.box.w / 2 - 40;
			const cy = img.box.y + img.box.h / 2;
			expect(pixel(img, cx - 7, cy)[3]).toBeGreaterThan(250);
			expect(pixel(img, cx - 13, cy)[3]).toBe(0);
		}
	});

	it('shadow: offset, blurred and behind the shape; padding keeps its tail on the canvas', async () => {
		const rect = { kind: 'rect', x: 0.4, y: 0.4, w: 0.2, h: 0.2 } as const;
		const img = await render(
			{
				layers: [
					{
						type: 'shadow',
						params: { distance: 20, blur: 0, angle: 0, opacity: 100, paint: flat([0, 0, 1, 1]) },
					},
					{ type: 'face', params: { paint: flat([1, 0, 0, 1]) } },
				],
			},
			{ input: rect, unitPx: 100 },
		);
		const y = img.box.y + 80;
		const right = img.box.x + 192;
		expect(pixel(img, right - 4, y)[0]).toBeGreaterThan(240); // the face stays on top
		expect(pixel(img, right + 10, y)[2]).toBeGreaterThan(240); // the shadow, 20 px to the right
		expect(pixel(img, right + 24, y)[3]).toBe(0);
		// The look is padded: a shadow reaching past the box stays on the canvas.
		const wide = await render(
			{ layers: [{ type: 'shadow', params: { distance: 50, blur: 40, angle: 0, opacity: 100 } }] },
			{ input: { kind: 'rect', x: 0.8, y: 0.4, w: 0.2, h: 0.2 }, unitPx: 100 },
		);
		expect(wide.padding.right).toBeGreaterThanOrEqual(90);
		let edge = 0;
		for (let j = 0; j < wide.height; j++) edge = Math.max(edge, pixel(wide, wide.width - 1, j)[3]);
		expect(edge).toBeLessThanOrEqual(2);
	});

	it('long and perspective shadows reach from the shape along their direction', async () => {
		const rect = { kind: 'rect', x: 0.4, y: 0.4, w: 0.2, h: 0.2 } as const;
		const long = await render(
			{
				layers: [
					{
						type: 'shadow',
						params: {
							kind: 'long',
							distance: 60,
							blur: 0,
							angle: 0,
							opacity: 100,
							paint: flat([0, 0, 1, 1]),
						},
					},
				],
			},
			{ input: rect, unitPx: 100 },
		);
		const y = long.box.y + 80;
		const right = long.box.x + 192;
		for (const dx of [5, 30, 55]) expect(pixel(long, right + dx, y)[3]).toBeGreaterThan(240);
		expect(pixel(long, right + 68, y)[3]).toBe(0);
		const persp = await render(
			{ layers: [{ type: 'shadow', params: { kind: 'perspective', distance: 40, blur: 0, opacity: 100 } }] },
			{ input: rect, unitPx: 100 },
		);
		let drawn = 0;
		for (let i = 3; i < persp.data.length; i += 4) if (persp.data[i]! > 128) drawn++;
		expect(drawn).toBeGreaterThan(200);
	});

	it('glow: soft is a blurred halo, precise follows the distance exactly', async () => {
		const rect = { kind: 'rect', x: 0.4, y: 0.4, w: 0.2, h: 0.2 } as const;
		const soft = await render(
			{ layers: [{ type: 'glow', params: { radius: 30, paint: flat([1, 1, 1, 1]) } }] },
			{ input: rect, unitPx: 100 },
		);
		const precise = await render(
			{ layers: [{ type: 'glow', params: { radius: 30, technique: 'precise', paint: flat([1, 1, 1, 1]) } }] },
			{ input: rect, unitPx: 100 },
		);
		const edgeX = (img: LookImage) => img.box.x + 192;
		const y = (img: LookImage) => img.box.y + 80;
		// Both fall off with distance…
		for (const img of [soft, precise]) {
			const a = [2, 12, 24].map((d) => pixel(img, edgeX(img) + d, y(img))[3]);
			expect(a[0]).toBeGreaterThan(a[1]!);
			expect(a[1]).toBeGreaterThan(a[2]!);
		}
		// …precise reaches zero at the radius.
		expect(pixel(precise, edgeX(precise) + 31, y(precise))[3]).toBe(0);
	});

	it('is deterministic: the same look draws the same pixels', async () => {
		const a = await render(six);
		const b = await render(six);
		expect(difference(a, b)).toBe(0);
	});

	it('resolution independence: 50 %, 100 % and 200 % match after scaling (TL-034)', async () => {
		const at = (k: number) =>
			render(six, {
				input: { kind: 'shapes' },
				unitPx: 96 * k,
				box: { width: BOX.width * k, height: BOX.height * k },
			});
		const [half, full, twice] = [await at(0.5), await at(1), await at(2)];
		// Compared at the smallest size: enlarging would measure the comparison's own blur.
		const crop = (img: LookImage) => layerCrop(img, lumaOver(img, 128));
		const h = crop(half);
		const atHalf = (img: LookImage) => {
			const c = crop(img);
			return resampleLuma(c.data, c.w, c.h, h.w, h.h);
		};
		const scores = {
			'100 % vs 50 %': ssim(atHalf(full), h.data, h.w, h.h),
			'200 % vs 50 %': ssim(atHalf(twice), h.data, h.w, h.h),
			'200 % vs 100 %': ssim(atHalf(twice), atHalf(full), h.w, h.h),
		};
		console.info(`[title-look] resolution SSIM ${JSON.stringify(scores)}`);
		for (const score of Object.values(scores)) expect(score).toBeGreaterThan(0.97);
	});

	it('preview scale: the same layer px at half canvas resolution matches the full render', async () => {
		const shapes = { input: { kind: 'shapes' }, unitPx: 96 } as const;
		const full = await render(six, shapes);
		const half = await render(six, { ...shapes, pxScale: 0.5 });
		const f = layerCrop(full, lumaOver(full, 128));
		const h = layerCrop(half, lumaOver(half, 128));
		const score = ssim(resampleLuma(f.data, f.w, f.h, h.w, h.h), h.data, h.w, h.h);
		console.info(`[title-look] fxPreviewScale 0.5 vs full: SSIM ${score.toFixed(4)}`);
		// Lower than the resolution test: at half scale the box sits between pixels and this crop interpolates.
		expect(score).toBeGreaterThan(0.95);
	});

	// Cost on this host (docs/performance.md §7): TL_PERF=1. Reports; the budget is on a real GPU.
	it.runIf(process.env.TL_PERF === '1')(
		'per-frame cost of a six-layer look at 1080p',
		{ timeout: 300_000 },
		async () => {
			const req = (pxScale: number): LookRequest => ({
				recipe: six,
				input: { kind: 'text', text: 'Title Look', size: 200 },
				box: { width: 1920, height: 1080 },
				pxScale,
				timingOnly: true,
			});
			await tl.render(req(1));
			const profile = await tl.render({ ...req(1), perPass: true });
			console.info(`[title-look-perf] passes:\n${(profile as { passLog?: string[] }).passLog?.join('\n')}`);
			const face = (pxScale: number): LookRequest => ({
				...req(pxScale),
				recipe: { palette, layers: [{ type: 'face' }] },
			});
			// A title's real box: the text and the look's padding, not the whole frame.
			const tight = (pxScale: number): LookRequest => ({
				...req(pxScale),
				box: { width: 1200, height: 280 },
			});
			for (const [name, pxScale] of [
				['full', 1],
				['1/2', 0.5],
				['1/4', 0.25],
			] as const) {
				for (const [what, r] of [
					['six layers, frame-sized box', req(pxScale)],
					['six layers, title-sized box', tight(pxScale)],
					['field + face, frame-sized box', face(pxScale)],
				] as const) {
					const first = await tl.render(r);
					const runs: number[] = [];
					for (let i = 0; i < 7; i++) runs.push((await tl.render(r)).ms);
					runs.sort((a, b) => a - b);
					console.info(
						`[title-look-perf] ${name}, ${what}: canvas ${first.width}×${first.height}, ${first.passes} passes, first ${first.ms.toFixed(0)} ms, median ${runs[3]!.toFixed(0)} ms, min ${runs[0]!.toFixed(0)} ms, max ${runs[6]!.toFixed(0)} ms`,
					);
				}
			}
		},
	);

	// Every registered layer type: this is the registry completeness check (a new type has no fingerprints until it is
	// blessed, and fails until then), plus the checks a type gets for free.
	for (const type of TITLE_LAYER_TYPES)
		describe(`layer type ${type.type}`, () => {
			const recipeOf = (params: Record<string, unknown> = {}): LookRecipe => ({
				palette,
				layers: [
					{ type: 'face', params: { paint: flat([0.3, 0.3, 0.3, 1]) } },
					{ type: type.type, params },
				],
			});
			const base: LookRecipe = {
				palette,
				layers: [{ type: 'face', params: { paint: flat([0.3, 0.3, 0.3, 1]) } }],
			};
			// A moment into the clip: what moves may legitimately start empty (a one-shot burst, a write-on).
			const moment = type.timeDependent ? { contentSeconds: 0.7 } : {};

			it('compiles, draws and matches its fingerprints at default and perturbed params', async () => {
				const d = await render(recipeOf(), moment);
				const p = await render(recipeOf(perturbedParams(type)), { pad: 40, ...moment });
				// A deliberate perturbation changes the picture. Before any fingerprint: a blank picture must never be blessed.
				const dg = grid(d);
				expect(grid(p).some((v, i) => Math.abs(v - dg[i]!) > 0.5)).toBe(true);
				expectFingerprints(
					GOLDENS,
					{ [`${type.type}@default`]: grid(d), [`${type.type}@perturbed`]: grid(p) },
					4,
				);
			});

			it('changes the picture compared with no layer', async () => {
				const on = await render(recipeOf(perturbedParams(type)), { pad: 60, ...moment });
				const off = await render(base, { pad: 60 });
				// The box and the 60 px both canvases have: a layer may draw only around the shape (focus lines).
				const a = layerCrop(on, lumaOver(on, 128), 60);
				const b = layerCrop(off, lumaOver(off, 128), 60);
				let d = 0;
				for (let i = 0; i < a.data.length; i++) d += Math.abs(a.data[i]! - b.data[i]!);
				expect(d / a.data.length).toBeGreaterThan(0.05);
			});

			it('stays inside its padding (nothing clipped at the canvas edge)', async () => {
				const img = await render(recipeOf(perturbedParams(type)), moment);
				let edge = 0;
				for (let x = 0; x < img.width; x++)
					edge = Math.max(edge, pixel(img, x, 0)[3], pixel(img, x, img.height - 1)[3]);
				for (let y = 0; y < img.height; y++)
					edge = Math.max(edge, pixel(img, 0, y)[3], pixel(img, img.width - 1, y)[3]);
				expect(edge).toBeLessThanOrEqual(3);
			});

			it('is resolution independent at two scales (TL-034)', async () => {
				const at = (k: number) =>
					render(recipeOf(perturbedParams(type)), {
						input: { kind: 'shapes' },
						unitPx: 96 * k,
						box: { width: BOX.width * k, height: BOX.height * k },
						...moment,
					});
				const [a, b] = [await at(1), await at(2)];
				const ca = layerCrop(a, lumaOver(a, 128));
				const cb = layerCrop(b, lumaOver(b, 128));
				const score = ssim(resampleLuma(cb.data, cb.w, cb.h, ca.w, ca.h), ca.data, ca.w, ca.h);
				expect(score).toBeGreaterThan(0.97);
			});
		});

	for (const finish of TITLE_FINISHES)
		it(`finish ${finish.id} compiles on a face and a rim`, async () => {
			await render({
				palette,
				layers: [
					{ type: 'rim', params: { finish: finish.id } },
					{ type: 'face', params: { finish: finish.id } },
				],
			});
		});
});
