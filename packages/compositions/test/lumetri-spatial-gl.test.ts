// @vitest-environment node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addColorToKey, keyFromColor, removeColorFromKey } from '@jasper/project';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openGlPage } from './gl-browser.ts';
import type { RunOptions } from './lumetri-spatial-gl/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));

type Px = [number, number, number, number];
type Result = { probes: Px[] };

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Lumetri spatial stage in WebGL2 (headless Chrome)',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const run = (o: RunOptions) =>
			page.evaluate(
				(opts) => (window as unknown as { __lms: { run(o: unknown): Promise<unknown> } }).__lms.run(opts),
				o,
			) as Promise<Result>;

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'lumetri-spatial-gl', 'entry.ts')));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		const colorMask = (params: Record<string, unknown>, colors: [number, number, number][]) =>
			run({
				width: colors.length * 16,
				height: 8,
				scene: 'colors',
				colors,
				params: { secShowMask: true, secMaskStyle: 'whiteBlack', ...params },
				probes: colors.map((_, i) => [i * 16 + 8, 4]),
			});

		it('HSL Secondary corrects only the selected colors and supports Invert', async () => {
			const base = { secHueCenter: 0, secHueRange: 20, secSaturation: 0 };
			for (const [invert, expected] of [
				[
					false,
					[
						[69, 69, 69, 255],
						[32, 48, 208, 255],
					],
				],
				[
					true,
					[
						[208, 32, 32, 255],
						[56, 56, 56, 255],
					],
				],
			] as const) {
				const r = await run({
					width: 64,
					height: 16,
					scene: 'split',
					params: { ...base, secInvert: invert },
					probes: [
						[8, 8],
						[56, 8],
					],
				});
				// Rec.709 luma of the hand-painted red/blue is 69/56 code values.
				for (const [i, pixel] of r.probes.entries())
					for (const [channel, value] of pixel.entries())
						expect(Math.abs(value - expected[i]![channel]!)).toBeLessThanOrEqual(1);
			}
		});

		it('HSL key softness covers half of the hue and lightness transition bands', async () => {
			// RGB (224,94,16) is exactly hue 22.5°, half way between range 15° and range + softness 30°.
			const hue = await colorMask({ secHueCenter: 0, secHueRange: 15, secHueSoft: 15 }, [
				[224, 16, 16],
				[224, 94, 16],
				[16, 16, 224],
				[128, 128, 128],
			]);
			for (const [i, expected] of [255, 128, 0, 0].entries())
				expect(Math.abs(hue.probes[i]![0] - expected)).toBeLessThanOrEqual(1);
			const luma = await colorMask({ secLumaLow: 60, secLumaHigh: 100, secLumaSoft: 10 }, [
				[204, 204, 204],
				[140, 140, 140],
				[51, 51, 51],
			]);
			// 140/255 approximates 55% lightness; it lies half way through the 50..60% soft band.
			for (const [i, expected] of [255, 128, 0].entries())
				expect(Math.abs(luma.probes[i]![0] - expected)).toBeLessThanOrEqual(3);
		});

		it('Show Mask preserves selected color or white and marks excluded pixels gray or black', async () => {
			for (const style of ['colorGray', 'colorBlack', 'whiteBlack']) {
				const r = await run({
					width: 64,
					height: 16,
					scene: 'split',
					params: { secHueCenter: 0, secHueRange: 20, secShowMask: true, secMaskStyle: style },
					probes: [
						[8, 8],
						[56, 8],
					],
				});
				expect(r.probes[0]).toEqual(style === 'whiteBlack' ? [255, 255, 255, 255] : [208, 32, 32, 255]);
				if (style === 'colorGray') {
					const [red, green, blue, alpha] = r.probes[1]!;
					expect(red).toBe(green);
					expect(green).toBe(blue);
					expect(red).toBeGreaterThan(0);
					expect(red).toBeLessThan(255);
					expect(alpha).toBe(255);
				} else expect(r.probes[1]).toEqual([0, 0, 0, 255]);
			}
		});

		it('three-way highlight level brightens neutral midgray by the documented gain', async () => {
			const r = await run({
				width: 16,
				height: 8,
				scene: 'grey',
				params: { secWheelMode: 'three', secHighlightsLevel: 50 },
				probes: [[8, 4]],
			});
			// Highlight level 50 means gain 1.25: the fixture's gray 160 becomes 200.
			expect(r.probes[0]).toEqual([200, 200, 200, 255]);
		});

		it('HSL eyedroppers select the picked colors through the rendered mask', async () => {
			const orange: [number, number, number] = [0.9, 0.5, 0.1];
			const red: [number, number, number] = [0.85, 0.1, 0.1];
			const set = keyFromColor(orange);
			const added = addColorToKey(set, red);
			for (const [params, expected] of [
				[set, [255, 0, 0]],
				[added, [255, 255, 0]],
				[removeColorFromKey(added, red), [255, 0, 0]],
			] as const) {
				const r = await colorMask(params, [
					[230, 128, 26],
					[217, 26, 26],
					[26, 51, 230],
				]);
				expect(r.probes.map((p) => p[0])).toEqual(expected);
			}
			const gray = await colorMask(keyFromColor([0.5, 0.5, 0.5]), [
				[133, 128, 128],
				[242, 242, 242],
			]);
			expect(gray.probes.map((p) => p[0])).toEqual([255, 0]);
		});

		it('vignette darkens or lightens corners, keeps the center and follows roundness', async () => {
			const base = {
				width: 160,
				height: 90,
				scene: 'grey',
				probes: [
					[80, 45],
					[1, 1],
					[3, 45],
				] as [number, number][],
			};
			const dark = await run({ ...base, params: { vignetteAmount: -5, vignetteFeather: 0 } });
			const light = await run({ ...base, params: { vignetteAmount: 5, vignetteFeather: 0 } });
			expect(dark.probes[0]).toEqual([160, 160, 160, 255]);
			expect(light.probes[0]).toEqual([160, 160, 160, 255]);
			expect(dark.probes[1]).toEqual([0, 0, 0, 255]);
			expect(light.probes[1]).toEqual([255, 255, 255, 255]);
			const ellipse = await run({ ...base, params: { vignetteAmount: -3 } });
			const circle = await run({ ...base, params: { vignetteAmount: -3, vignetteRoundness: 100 } });
			expect(circle.probes[2]![0]).toBeLessThan(ellipse.probes[2]![0]);
		});

		it('Denoise fills speckle holes of the key; Blur softens its edge', async () => {
			const base = { secHueCenter: 0, secHueRange: 20, secShowMask: true, secMaskStyle: 'whiteBlack' };
			// The speck at (3, 3) is a hole in the key without Denoise, filled with it.
			const raw = await run({ width: 64, height: 64, scene: 'speckle', params: base, probes: [[3, 3]] });
			expect(raw.probes[0]![0]).toBeLessThan(10);
			const dn = await run({
				width: 64,
				height: 64,
				scene: 'speckle',
				params: { ...base, secDenoise: 100 },
				probes: [[3, 3]],
			});
			expect(dn.probes[0]![0]).toBeGreaterThan(245);
			const hard = await run({ width: 200, height: 8, scene: 'split', params: base, probes: [[96, 4]] });
			expect(hard.probes[0]![0]).toBeGreaterThan(250);
			const soft = await run({
				width: 200,
				height: 8,
				scene: 'split',
				params: { ...base, secBlur: 50 },
				probes: [
					[96, 4],
					[100, 4],
					[104, 4],
				],
			});
			const v = soft.probes.map((p) => p[0]);
			expect(v[0]).toBeLessThan(250);
			expect(v[0]).toBeGreaterThan(v[1]!);
			expect(v[1]).toBeGreaterThan(v[2]!);
		});

		it('Sharpen raises edge contrast, negative Sharpen softens; HSL Sharpen only inside the key', async () => {
			const probes: [number, number][] = [
				[98, 4],
				[101, 4],
			];
			const plain = await run({ width: 200, height: 8, scene: 'edge', probes });
			const sharp = await run({ width: 200, height: 8, scene: 'edge', params: { sharpen: 80 }, probes });
			expect(sharp.probes[0]![0]).toBeGreaterThan(plain.probes[0]![0] + 10);
			expect(sharp.probes[1]![0]).toBeLessThan(plain.probes[1]![0] - 10);
			const soft = await run({ width: 200, height: 8, scene: 'edge', params: { sharpen: -100 }, probes });
			expect(soft.probes[0]![0]).toBeLessThan(plain.probes[0]![0]);
			// A key that excludes greys: the secondary sharpen does nothing on the grey edge.
			const sec = await run({
				width: 200,
				height: 8,
				scene: 'edge',
				params: { secHueCenter: 0, secHueRange: 10, secSharpen: 100 },
				probes,
			});
			expect(sec.probes).toEqual(plain.probes);
		});

		it('transparent pixels stay transparent', async () => {
			const r = await run({
				width: 64,
				height: 16,
				scene: 'alpha',
				params: { vignetteAmount: 3, sharpen: 50, secSaturation: 0 },
				probes: [
					[10, 8],
					[50, 8],
				],
			});
			expect(r.probes[0]![3]).toBe(255);
			expect(r.probes[1]).toEqual([0, 0, 0, 0]);
		});
	},
);
