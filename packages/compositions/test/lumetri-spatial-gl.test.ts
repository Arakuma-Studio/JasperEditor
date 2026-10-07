// @vitest-environment node
// color-grade: Lumetri's spatial GPU stage (`jasper.lumetri-spatial`) in a real WebGL2 (headless Chrome, SwiftShader).
// Pointwise settings (HSL Secondary key + correction, Show Mask, Invert, Vignette) match the CPU reference
// (color/lumetri-spatial.ts) on every pixel within 1 code value; Refine (Denoise, Blur) and Sharpen show their
// characteristic behaviour; alpha is kept. Harness: test/lumetri-spatial-gl/entry.ts. FX_GL=0 skips it.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunOptions } from './lumetri-spatial-gl/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

type Px = [number, number, number, number];
type Result = { passes: (string | null)[]; probes: Px[]; maxDiff: number; worst: unknown };

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
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'lumetri-spatial-gl', 'entry.ts')],
				bundle: true,
				write: false,
				format: 'iife',
				platform: 'browser',
				target: 'es2022',
				define: { 'process.env.NODE_ENV': '"production"' },
				logLevel: 'silent',
			});
			browser = await chromium.launch({
				executablePath: CHROME,
				args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
			});
			page = await browser.newPage();
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(e.message));
			await page.setContent('<!doctype html><html><body></body></html>');
			await page.addScriptTag({ content: out.outputFiles[0]!.text });
			if (errors.length) throw new Error(errors.join('\n'));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it('default params are the identity (one pass)', async () => {
			const r = await run({ width: 96, height: 32, scene: 'hues', reference: true });
			expect(r.passes.length).toBe(1);
			expect(r.maxDiff).toBeLessThanOrEqual(1);
		});

		it('HSL Secondary key + correction equals the CPU reference on every pixel', async () => {
			for (const params of [
				{ secHueCenter: 0, secHueRange: 20, secHueSoft: 25, secSaturation: 0 },
				{ secHueCenter: 120, secHueRange: 30, secHueSoft: 10, secTemperature: 60, secTint: -30, secContrast: 40 },
				{ secLumaLow: 40, secLumaHigh: 70, secLumaSoft: 15, secWheel: [0.5, 0.3], secWheelLevel: 20 },
				{
					secSatLow: 30,
					secSatHigh: 100,
					secSatSoft: 10,
					secWheelMode: 'three',
					secShadowsWheel: [0.3, 0.1],
					secMidtonesLevel: 30,
					secHighlightsWheel: [-0.2, 0.4],
				},
				{ secHueCenter: 230, secHueRange: 25, secInvert: true, secSaturation: 30 },
			]) {
				const r = await run({ width: 120, height: 24, scene: 'hues', params, reference: true });
				expect(r.passes.length, JSON.stringify(params)).toBe(1);
				expect(r.maxDiff, `${JSON.stringify(params)} worst ${JSON.stringify(r.worst)}`).toBeLessThanOrEqual(1);
			}
		});

		it('Show Mask (Color/Gray, Color/Black, White/Black) equals the reference', async () => {
			for (const style of ['colorGray', 'colorBlack', 'whiteBlack']) {
				const r = await run({
					width: 120,
					height: 24,
					scene: 'hues',
					params: { secHueCenter: 0, secHueRange: 20, secShowMask: true, secMaskStyle: style },
					reference: true,
				});
				expect(r.maxDiff, `${style} worst ${JSON.stringify(r.worst)}`).toBeLessThanOrEqual(1);
			}
		});

		it('the vignette equals the reference for every roundness and feather', async () => {
			for (const params of [
				{ vignetteAmount: -3 },
				{ vignetteAmount: 2.5, vignetteMidpoint: 30, vignetteFeather: 10 },
				{ vignetteAmount: -5, vignetteRoundness: 100, vignetteFeather: 80 },
				{ vignetteAmount: -2, vignetteRoundness: -100, vignetteMidpoint: 70 },
			]) {
				const r = await run({ width: 160, height: 90, scene: 'grey', params, reference: true });
				expect(r.maxDiff, `${JSON.stringify(params)} worst ${JSON.stringify(r.worst)}`).toBeLessThanOrEqual(1);
				expect(r.probes).toEqual([]);
			}
			const r = await run({
				width: 160,
				height: 90,
				scene: 'grey',
				params: { vignetteAmount: -4 },
				probes: [
					[80, 45],
					[1, 1],
				],
			});
			expect(r.probes[0]![0]).toBe(160);
			expect(r.probes[1]![0]).toBeLessThan(80);
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
			expect(dn.passes).toContain('keyDenoised');
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
			expect(soft.passes).toContain('keyBlurred');
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
			expect(sharp.passes).toContain('soft');
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
