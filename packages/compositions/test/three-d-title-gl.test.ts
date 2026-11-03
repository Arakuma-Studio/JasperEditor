// @vitest-environment node
// Spec 19 §9 on the GPU (headless Chrome, SwiftShader): metal that reads as metal, surfaces, transmission of the
// backdrop, tone mapping, HDR float, glints that hold still, cached geometry. A scene is described by JSON (entry.ts) and
// every behaviour has a perturbation: the same scene without the feature must differ.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openGlPage } from './gl-browser.ts';
import type { TitleScene } from './three-d-title/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const W = 320;
const H = 160;
const round = (width: number, depth: number, profile = 'round') => ({
	width,
	depth,
	profile,
	curve: 0,
	segments: 6,
});
const base = { W, H, text: 'GOLD', rotY: -24, rotX: 12, toneMapping: 'aces' } as const;
const gold = {
	...base,
	geometry: { depth: 26, bands: [round(5, 5)] },
	surfaces: { base: 'gold' },
	envPreset: 0,
	backdrop: 'grey',
} as TitleScene;

describe.runIf(!!CHROME && process.env.FX_GL !== '0')('3D titles on the GPU', { timeout: 300_000 }, () => {
	let browser: Browser;
	let page: Page;
	const call = <T>(name: string, ...args: unknown[]): Promise<T> =>
		page.evaluate(
			([n, a]) =>
				(window as unknown as { __title: Record<string, (...x: unknown[]) => unknown> }).__title[
					n as string
				]!(...(a as unknown[])),
			[name, args] as const,
		) as Promise<T>;
	const render = (s: TitleScene) => call<number[]>('render', s);
	const dump = async (name: string, s: TitleScene) => {
		const url = await call<string>('png', s);
		if (process.env.THREE_D_DEBUG) {
			mkdirSync('/tmp/three-d-gl', { recursive: true });
			writeFileSync(`/tmp/three-d-gl/${name}.png`, Buffer.from(url.split(',')[1]!, 'base64'));
		}
	};
	const px = (img: number[], x: number, y: number, w = W) => img.slice((y * w + x) * 4, (y * w + x) * 4 + 4);
	const diff = (a: number[], b: number[]) => {
		let n = 0;
		for (let i = 0; i < a.length; i += 4)
			if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > 24)
				n++;
		return n / (a.length / 4);
	};
	const opaque = (img: number[]) => {
		let n = 0;
		for (let i = 3; i < img.length; i += 4) if (img[i]! > 128) n++;
		return n;
	};
	/** Mean colour and spread of the pixels that differ from the backdrop. */
	const stats = (img: number[], back = [58, 63, 74]) => {
		let n = 0;
		const sum = [0, 0, 0];
		let lo = 255;
		let hi = 0;
		for (let i = 0; i < img.length; i += 4) {
			const d =
				Math.abs(img[i]! - back[0]!) + Math.abs(img[i + 1]! - back[1]!) + Math.abs(img[i + 2]! - back[2]!);
			if (d < 12) continue;
			n++;
			for (let c = 0; c < 3; c++) sum[c]! += img[i + c]!;
			const l = 0.2126 * img[i]! + 0.7152 * img[i + 1]! + 0.0722 * img[i + 2]!;
			lo = Math.min(lo, l);
			hi = Math.max(hi, l);
		}
		return { n, mean: sum.map((v) => v / Math.max(1, n)), lo, hi };
	};

	beforeAll(async () => {
		({ browser, page } = await openGlPage(join(here, 'three-d-title', 'entry.ts'), {
			page: { viewport: { width: 64, height: 64 } },
		}));
	}, 180_000);
	afterAll(async () => {
		await browser?.close();
	});

	it('the host has float targets here: the rest of the suite means something', async () => {
		expect(await call<boolean>('hasFloat')).toBe(true);
	});

	it('gold reads as gold: warm, saturated, with real contrast between faces, bevels and highlights', async () => {
		await dump('gold', gold);
		const s = stats(await render(gold));
		expect(s.n).toBeGreaterThan(2000);
		expect(s.mean[0]!).toBeGreaterThan(s.mean[2]! * 1.5);
		expect(s.mean[0]!).toBeGreaterThan(90);
		expect(s.hi - s.lo).toBeGreaterThan(120);
	});

	it('chrome reads as chrome: neutral, and darker and brighter than any diffuse grey', async () => {
		const chrome = { ...gold, surfaces: { base: 'chrome' }, envPreset: 4 } as TitleScene;
		await dump('chrome', chrome);
		const s = stats(await render(chrome));
		expect(Math.abs(s.mean[0]! - s.mean[2]!)).toBeLessThan(70);
		expect(s.hi - s.lo).toBeGreaterThan(150);
		// The perturbation: the same solid in matte grey has no such range.
		const matte = {
			...gold,
			surfaces: { base: { base: 'color', baseColor: [0.6, 0.6, 0.6, 1], roughness: 90 } },
		} as TitleScene;
		const m = stats(await render(matte));
		expect(m.hi - m.lo).toBeLessThan(s.hi - s.lo);
	});

	it('every surface has its own material: face, band, side and back', async () => {
		const s = {
			...base,
			text: undefined,
			rects: [[60, 40, 200, 80]],
			rotY: -40,
			rotX: 25,
			backdrop: 'grey',
			toneMapping: 'none',
			geometry: { depth: 40, bands: [round(8, 8, 'chamfer')] },
			surfaces: {
				base: { base: 'color', baseColor: [0.5, 0.5, 0.5, 1], roughness: 60 },
				face: { base: 'color', baseColor: [1, 0, 0, 1], roughness: 60 },
				band0: { base: 'color', baseColor: [0, 1, 0, 1], roughness: 60 },
				side: { base: 'color', baseColor: [0, 0, 1, 1], roughness: 60 },
			},
		} as TitleScene;
		await dump('surfaces', s);
		const img = await render(s);
		let r = 0;
		let g = 0;
		let b = 0;
		for (let i = 0; i < img.length; i += 4) {
			if (img[i]! > img[i + 1]! * 2 && img[i]! > img[i + 2]! * 2) r++;
			if (img[i + 1]! > img[i]! * 2 && img[i + 1]! > img[i + 2]! * 2) g++;
			if (img[i + 2]! > img[i]! * 2 && img[i + 2]! > img[i + 1]! * 2) b++;
		}
		expect(r).toBeGreaterThan(1000);
		expect(g).toBeGreaterThan(100);
		expect(b).toBeGreaterThan(100);
	});

	it.each([
		[
			'clearcoat',
			{ base: { base: 'color', baseColor: [0.6, 0.02, 0.03, 1], roughness: 60, clearcoat: 100 } },
		],
		[
			'flakes',
			{
				base: {
					base: 'color',
					baseColor: [0.6, 0.6, 0.65, 1],
					metalness: 100,
					roughness: 25,
					flakes: 90,
					flakeScale: 4,
				},
			},
		],
		[
			'crumple',
			{
				base: {
					base: 'color',
					baseColor: [0.9, 0.9, 0.9, 1],
					metalness: 100,
					roughness: 15,
					relief: 'crumple',
					reliefAmount: 70,
					reliefScale: 40,
				},
			},
		],
		[
			'hammered',
			{
				base: {
					base: 'color',
					baseColor: [0.9, 0.7, 0.2, 1],
					metalness: 100,
					roughness: 15,
					relief: 'hammered',
					reliefAmount: 70,
					reliefScale: 30,
				},
			},
		],
		[
			'liquid',
			{
				base: {
					base: 'color',
					baseColor: [0.9, 0.9, 0.9, 1],
					metalness: 100,
					roughness: 5,
					relief: 'liquid',
					reliefAmount: 70,
					reliefScale: 80,
				},
			},
		],
		[
			'iridescence',
			{
				base: {
					base: 'color',
					baseColor: [0.2, 0.2, 0.25, 1],
					metalness: 60,
					roughness: 20,
					iridescence: 100,
					iridescenceThickness: 480,
				},
			},
		],
	] as const)('%s changes the picture', async (name, surfaces) => {
		const s = { ...gold, text: 'A8', surfaces } as TitleScene;
		const plain = {
			...s,
			surfaces: { base: { ...surfaces.base, clearcoat: 0, flakes: 0, relief: 'none', iridescence: 0 } },
		} as TitleScene;
		await dump(`fx-${name}`, s);
		expect(diff(await render(s), await render(plain))).toBeGreaterThan(0.004);
	});

	it('transmission refracts the sequence backdrop; opaque, the same solid hides it', async () => {
		const glass = {
			...base,
			text: 'O',
			backdrop: 'stripes',
			toneMapping: 'none',
			rotY: 0,
			rotX: 0,
			geometry: { depth: 30, bands: [round(8, 8)] },
			surfaces: { base: 'glass' },
		} as TitleScene;
		await dump('glass', glass);
		const img = await render(glass);
		const noGlass = await render({ ...glass, geometry: { depth: 0, bands: [] }, surfaces: {} });
		// Inside the letter's stroke: some red stripes must have moved.
		const stroke = await render({
			...glass,
			backdrop: 'none',
			surfaces: { base: { base: 'color', baseColor: [1, 1, 1, 1] } },
		});
		let inGlass = 0;
		let moved = 0;
		let red = 0;
		for (let i = 0; i < img.length; i += 4) {
			if (stroke[i + 3]! < 200) continue;
			inGlass++;
			if (Math.abs(img[i]! - noGlass[i]!) + Math.abs(img[i + 1]! - noGlass[i + 1]!) > 60) moved++;
			if (img[i]! > 120 && img[i + 1]! < 110) red++;
		}
		expect(inGlass).toBeGreaterThan(800);
		expect(moved / inGlass).toBeGreaterThan(0.1);
		expect(red / inGlass).toBeGreaterThan(0.1);
		// Perturbation: opaque body.
		const opaqueBody = await render({
			...glass,
			surfaces: { base: { base: 'color', baseColor: [0.2, 0.2, 0.2, 1] } },
		});
		let opaqueRed = 0;
		for (let i = 0; i < img.length; i += 4)
			if (stroke[i + 3]! >= 200 && opaqueBody[i]! > 120 && opaqueBody[i + 1]! < 110) opaqueRed++;
		expect(opaqueRed / inGlass).toBeLessThan(0.02);
	});

	it('a clear pane shows the backdrop through without tone mapping it', async () => {
		const pane = {
			W,
			H,
			rects: [[60, 30, 200, 100]],
			backdrop: 'gradient',
			toneMapping: 'aces',
			geometry: { depth: 2 },
			surfaces: {
				base: {
					base: 'color',
					baseColor: [1, 1, 1, 1],
					roughness: 0,
					transmission: 100,
					ior: 1,
					thickness: 0,
				},
			},
			noEnv: true,
		} as unknown as TitleScene;
		const img = await render(pane);
		const back = await render({ ...pane, geometry: { depth: 0 }, surfaces: {}, rects: [[0, 0, 1, 1]] });
		expect(Math.abs(px(img, 160, 80)[0]! - px(back, 160, 80)[0]!)).toBeLessThanOrEqual(3);
	});

	it.each(['aces', 'agx', 'neutral', 'hue'] as const)(
		'tone mapping %s: HDR values roll off, none clips',
		async (toneMapping) => {
			const hot = { ...gold, envColor: [8, 8, 8] } as TitleScene;
			const on = await render({ ...hot, toneMapping });
			const off = await render({ ...hot, toneMapping: 'none' });
			const clipped = (img: number[]) => {
				let n = 0;
				for (let i = 0; i < img.length; i += 4)
					if (img[i]! > 253 || img[i + 1]! > 253 || img[i + 2]! > 253) n++;
				return n;
			};
			await dump(`tone-${toneMapping}`, { ...hot, toneMapping });
			expect(diff(on, off)).toBeGreaterThan(0.02);
			expect(clipped(on)).toBeLessThan(clipped(off) + 1);
		},
	);

	it('the hue-preserving mode keeps saturated gold saturated where ACES desaturates it', async () => {
		const hot = {
			...gold,
			surfaces: { base: { base: 'color', baseColor: [1, 0.6, 0, 1], metalness: 100, roughness: 30 } },
			envColor: [4, 4, 4],
		} as TitleScene;
		const sat = (img: number[]) => {
			const s = stats(img);
			return (s.mean[0]! - s.mean[2]!) / Math.max(1, s.mean[0]!);
		};
		expect(sat(await render({ ...hot, toneMapping: 'hue' }))).toBeGreaterThan(
			sat(await render({ ...hot, toneMapping: 'aces' })),
		);
	});

	it('tone mapping leaves the backdrop alone', async () => {
		const a = await render({ ...gold, toneMapping: 'aces' });
		const b = await render({ ...gold, toneMapping: 'agx' });
		expect(px(a, 3, 3)).toEqual([58, 63, 74, 255]);
		expect(px(b, 3, 3)).toEqual([58, 63, 74, 255]);
	});

	it('HDR float is preserved: a sun at 500 reads brighter through a rough mirror than a white of 1', async () => {
		const pano = (sun: number) => {
			const w = 64;
			const h = 32;
			const data: number[] = [];
			for (let y = 0; y < h; y++)
				for (let x = 0; x < w; x++) {
					const s = (x - 0) ** 2 + (y - 16) ** 2 < 9 || (x - 63) ** 2 + (y - 16) ** 2 < 9;
					data.push(s ? sun : 0.05, s ? sun : 0.05, s ? sun : 0.05, 1);
				}
			return { width: w, height: h, data };
		};
		const mirror = {
			W,
			H,
			rects: [[40, 20, 240, 120]],
			geometry: { depth: 4 },
			surfaces: { base: { base: 'color', baseColor: [1, 1, 1, 1], metalness: 100, roughness: 35 } },
			toneMapping: 'neutral',
		} as unknown as TitleScene;
		const bright = await render({ ...mirror, envFloat: pano(500) });
		const dim = await render({ ...mirror, envFloat: pano(1) });
		expect(px(bright, 160, 80)[0]!).toBeGreaterThan(px(dim, 160, 80)[0]! + 40);
	});

	it('environment rotation turns the reflection; every preset differs', async () => {
		const s = { ...gold, surfaces: { base: 'chrome' } } as TitleScene;
		const pics = await Promise.all([0, 1, 2, 3, 4, 5].map((envPreset) => render({ ...s, envPreset })));
		for (let i = 0; i < pics.length; i++) await dump(`env-${i}`, { ...s, envPreset: i });
		for (let i = 1; i < pics.length; i++) expect(diff(pics[0]!, pics[i]!)).toBeGreaterThan(0.02);
		expect(diff(await render({ ...s, envRotation: 70 }), pics[0]!)).toBeGreaterThan(0.02);
	});

	it('prefiltered reflections: roughness blurs, a mirror keeps the strip lights', async () => {
		// A round bevel sweeps over the environment, where a flat face sees a few degrees of it.
		const flat = {
			W,
			H,
			text: 'O',
			geometry: { depth: 2, bands: [round(14, 14)] },
			envPreset: 5,
			toneMapping: 'aces',
		} as unknown as TitleScene;
		const contrast = (img: number[]) => {
			let c = 0;
			for (let y = 12; y < H - 12; y++)
				for (let x = 12; x < W - 12; x++)
					if (px(img, x, y)[3]! > 250 && px(img, x, y + 1)[3]! > 250)
						c += Math.abs(px(img, x, y)[1]! - px(img, x, y + 1)[1]!);
			return c;
		};
		const m = (roughness: number) => ({
			base: { base: 'color', baseColor: [1, 1, 1, 1], metalness: 100, roughness },
		});
		const mirror = contrast(await render({ ...flat, surfaces: m(0) } as TitleScene));
		const rough = contrast(await render({ ...flat, surfaces: m(60) } as TitleScene));
		expect(mirror).toBeGreaterThan(rough * 1.3);
	});

	it('exposure scales the light and tone mapping rolls it off', async () => {
		const dark = stats(await render({ ...gold, exposure: -2 }));
		const lit = stats(await render({ ...gold, exposure: 2 }));
		expect(lit.mean[0]!).toBeGreaterThan(dark.mean[0]! + 30);
	});

	it('glints: bloom and rays around highlights, none below the threshold, and alpha rises on transparency', async () => {
		const g = {
			...gold,
			envColor: [3, 3, 3],
			glint: { threshold: 2, intensity: 300, radius: 10, rays: 4, length: 50, angle: 45 },
		} as TitleScene;
		await dump('glint', g);
		const on = await render(g);
		const off = await render({ ...g, glint: { ...g.glint, intensity: 0 } });
		expect(diff(on, off)).toBeGreaterThan(0.005);
		const high = await render({ ...g, glint: { ...g.glint, threshold: 60 } });
		expect(diff(high, off)).toBeLessThan(0.002);
		const clear = await render({ ...g, backdrop: 'none' });
		const clearOff = await render({ ...g, backdrop: 'none', glint: { ...g.glint, intensity: 0 } });
		expect(opaque(clear)).toBeGreaterThanOrEqual(opaque(clearOff));
	});

	it('glints hold still: energy changes smoothly as the title turns', { timeout: 900_000 }, async () => {
		const g = {
			...gold,
			W: 192,
			H: 96,
			envColor: [3, 3, 3],
			glint: { threshold: 2, intensity: 300, radius: 8, rays: 4, length: 40, angle: 45 },
		} as TitleScene;
		const energies: number[] = [];
		for (let i = 0; i < 8; i++) {
			const rotY = -24 + i * 0.15;
			const on = await render({ ...g, rotY });
			const off = await render({ ...g, rotY, glint: { ...g.glint, intensity: 0 } });
			let e = 0;
			for (let k = 0; k < on.length; k += 4) e += Math.max(0, on[k]! - off[k]!);
			energies.push(e);
		}
		const mean = energies.reduce((a, b) => a + b, 0) / energies.length;
		let jump = 0;
		for (let i = 1; i < energies.length; i++)
			jump = Math.max(jump, Math.abs(energies[i]! - energies[i - 1]!));
		process.stdout.write(`glint energy mean ${mean.toFixed(0)} largest step ${jump.toFixed(0)}\n`);
		expect(mean).toBeGreaterThan(50);
		expect(jump / mean).toBeLessThan(0.2);
	});

	it('supersampling keeps the picture and cleans its edges', async () => {
		const one = await render(gold);
		const two = await render({ ...gold, supersampling: 2 });
		expect(diff(one, two)).toBeLessThan(0.08);
		expect(diff(one, two)).toBeGreaterThan(0);
	});

	it('inflate and backplates render, and depth orders them', async () => {
		const s = {
			...gold,
			text: 'Rg',
			toneMapping: 'neutral',
			geometry: {
				mode: 'inflate',
				depth: 8,
				inflate: {
					height: 24,
					curve: [
						{ x: 0, y: 0 },
						{ x: 0.4, y: 0.85 },
						{ x: 1, y: 1 },
					],
					smoothness: 60,
					detail: 1,
				},
				plates: [
					{
						enabled: true,
						shape: 'contour',
						grow: 8,
						depth: 8,
						gap: 0,
						corner: 0,
						fillCounters: true,
						bevelWidth: 2,
						bevelDepth: 2,
						bevelProfile: 'round',
					},
					{
						enabled: true,
						shape: 'box',
						grow: 6,
						depth: 6,
						gap: 2,
						corner: 10,
						fillCounters: false,
						bevelWidth: 2,
						bevelDepth: 2,
						bevelProfile: 'chamfer',
					},
				],
			},
			surfaces: {
				base: 'candy',
				plate0Face: 'gold',
				plate0Side: 'gold',
				plate1Face: 'black-gloss',
				plate1Side: 'black-gloss',
			},
		} as TitleScene;
		await dump('inflate-plates', s);
		const img = await render({ ...s, backdrop: 'none' });
		const withoutPlates = await render({ ...s, backdrop: 'none', geometry: { ...s.geometry, plates: [] } });
		expect(opaque(img)).toBeGreaterThan(opaque(withoutPlates) * 1.02);
	});

	it('a moving camera, light or material builds no geometry', async () => {
		const n0 = await call<number>('builds');
		await render(gold);
		const n1 = await call<number>('builds');
		await render({ ...gold, orbit: 8 });
		await render({ ...gold, surfaces: { base: 'chrome' } });
		await render({ ...gold, envRotation: 40, exposure: 1 });
		expect(await call<number>('builds')).toBe(n1);
		expect(n1).toBeLessThanOrEqual(n0 + 1);
		// The perturbation: a bevel change does build.
		await render({ ...gold, geometry: { depth: 26, bands: [round(7, 5)] } });
		expect(await call<number>('builds')).toBe(n1 + 1);
	});

	// `THREE_D_SHEET=<file>`: the contact sheet of the stream, for looking at.
	it.runIf(!!process.env.THREE_D_SHEET)('contact sheet', { timeout: 1_500_000 }, async () => {
		const tile = { W: 440, H: 220, backdrop: 'gradient', toneMapping: 'aces', rotY: -22, rotX: 10 };
		const bands = (w = 7) => ({ depth: 34, bands: [round(w, w)] });
		const look = (label: string, more: object) => ({ ...tile, label, geometry: bands(), ...more });
		const plate = {
			enabled: true,
			gap: 0,
			corner: 0,
			fillCounters: true,
			bevelWidth: 3,
			bevelDepth: 3,
			bevelProfile: 'round',
		};
		const scenes = [
			look('Gold, Studio, ACES', { text: 'GOLD', surfaces: { base: 'gold' }, envPreset: 0 }),
			look('Chrome, Chrome Bands, ACES', { text: 'CHROME', surfaces: { base: 'chrome' }, envPreset: 4 }),
			look('Gold, Sunset, Hue Preserving', {
				text: 'GOLD',
				surfaces: { base: 'gold' },
				envPreset: 3,
				toneMapping: 'hue',
			}),
			look('Chrome, City, AgX', {
				text: 'CHROME',
				surfaces: { base: 'chrome' },
				envPreset: 2,
				toneMapping: 'agx',
			}),
			look('Three bands, each its own metal', {
				text: 'BANDS',
				geometry: { depth: 22, bands: [round(5, 5), round(4, 3, 'chamfer'), round(5, 5, 'tube')] },
				surfaces: {
					face: 'white-gloss',
					band0: 'gold',
					band1: 'black-gloss',
					band2: 'chrome',
					side: 'gold',
					back: 'gold',
					base: 'gold',
				},
			}),
			look('Face red paint, gold rim, chrome side', {
				text: 'MIX',
				surfaces: { base: 'gold', face: 'candy', side: 'chrome' },
				envPreset: 0,
			}),
			look('Kanji hairlines: bevels narrow, nothing folds', {
				text: '鬱龜書',
				font: '700 120px "Noto Sans CJK JP", sans-serif',
				geometry: { depth: 18, position: 'center', bands: [round(2.5, 3)] },
				surfaces: { base: 'gold' },
			}),
			look('Thin strokes, outside bevel', {
				text: 'Hairline',
				font: '300 110px "Liberation Serif", serif',
				geometry: { depth: 16, position: 'outside', bands: [round(3, 3)] },
				surfaces: { base: 'chrome' },
				envPreset: 4,
			}),
			look('Inflate', {
				text: 'Puffy',
				font: '900 130px "Liberation Sans", sans-serif',
				geometry: {
					mode: 'inflate',
					depth: 6,
					inflate: {
						height: 30,
						curve: [
							{ x: 0, y: 0 },
							{ x: 0.35, y: 0.75 },
							{ x: 1, y: 1 },
						],
						smoothness: 70,
						detail: 2,
					},
				},
				surfaces: { base: 'chrome' },
				envPreset: 3,
			}),
			look('Backplates: contour, box', {
				text: 'PLATE',
				font: '900 96px "Liberation Sans", sans-serif',
				geometry: {
					depth: 14,
					bands: [round(4, 4)],
					plates: [
						{ ...plate, shape: 'contour', grow: 10, depth: 12 },
						{ ...plate, shape: 'box', grow: 10, depth: 10, gap: 2, corner: 14 },
					],
				},
				surfaces: {
					base: 'gold',
					plate0Face: 'black-gloss',
					plate0Side: 'black-gloss',
					plate1Face: 'chrome',
					plate1Side: 'chrome',
				},
			}),
			look('Glass refracting the backdrop', {
				text: 'GLASS',
				backdrop: 'stripes',
				surfaces: { base: 'glass' },
				toneMapping: 'neutral',
			}),
			look('Ruby, dispersion', {
				text: 'RUBY',
				backdrop: 'stripes',
				surfaces: { base: 'ruby' },
				envPreset: 5,
			}),
			look('Candy paint: flakes under clearcoat', {
				text: 'CANDY',
				surfaces: { base: 'candy' },
				envPreset: 0,
			}),
			look('Hammered gold', {
				text: 'HAMMER',
				font: '900 80px "Liberation Sans", sans-serif',
				surfaces: { base: 'hammered-gold' },
			}),
			look('Liquid chrome', {
				text: 'LIQUID',
				font: '900 90px "Liberation Sans", sans-serif',
				surfaces: { base: 'liquid-chrome' },
				envPreset: 4,
			}),
			look('Crumpled foil', { text: 'FOIL', surfaces: { base: 'foil' } }),
			look('Pearl: iridescence', { text: 'PEARL', surfaces: { base: 'pearl' } }),
			look('Glints: stable star rays', {
				text: 'STAR',
				surfaces: { base: 'gold' },
				envColor: [2.4, 2.4, 2.4],
				glint: { threshold: 2, intensity: 260, radius: 14, rays: 4, length: 70, angle: 45 },
			}),
			look('Neon environment', { text: 'NEON', surfaces: { base: 'chrome' }, envPreset: 5 }),
			look('Sky environment', { text: 'SKY', surfaces: { base: 'silver' }, envPreset: 1 }),
		];
		const url = await call<string>('sheet', scenes, 4);
		writeFileSync(process.env.THREE_D_SHEET!, Buffer.from(url.split(',')[1]!, 'base64'));
	});

	it('determinism: the same scene twice is byte-identical', async () => {
		const s = {
			...gold,
			envColor: [2, 2, 2],
			glint: { threshold: 2, intensity: 200, radius: 8, rays: 4, length: 40, angle: 45 },
		} as TitleScene;
		expect(await render(s)).toEqual(await render(s));
	});
});
