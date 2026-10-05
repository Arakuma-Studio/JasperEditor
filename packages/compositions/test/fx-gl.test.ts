// @vitest-environment node
// The fx GPU host in a real WebGL2 (wave-1 fx framework): headless Chrome (Playwright, SwiftShader when there is no
// GPU) runs src/fx/host.ts bundled with esbuild. Compiles the whole GLSL library and EVERY registered GPU effect
// (the fx catalogue: wave-2 families get this check for free) and checks the host contract: orientation, alpha,
// multi-pass + downscaled blur + padding (glow), generator, padded drop shadow, time samples, media textures, LUT
// pass, half-float intermediates, compile errors. Runs when a Chrome is found (JASPER_BROWSER_EXECUTABLE or the
// usual paths); FX_GL=0 skips it.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

type Px = [number, number, number, number];
const near = (a: Px, b: Px, tol = 3) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'fx GPU host in WebGL2 (headless Chrome)',
	{ timeout: 60_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string): Promise<T> =>
			page.evaluate(
				(n) => (window as unknown as { __fx: Record<string, () => unknown> }).__fx[n]!(),
				name,
			) as Promise<T>;

		beforeAll(async () => {
			// esbuild comes with tsx (root devDependency); no extra dependency for this test.
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'fx-gl', 'entry.ts')],
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

		it('has WebGL2', async () => {
			const info = await call<{ webgl2: boolean; renderer?: string }>('info');
			expect(info.webgl2).toBe(true);
		});

		it('compiles the whole GLSL library', async () => {
			expect(await call<{ ok: boolean; error?: string }>('library')).toEqual({ ok: true });
		});

		it('compiles and runs every registered GPU effect and the test effects', async () => {
			const r = await call<{ count: number; errors: string[] }>('catalogue');
			expect(r.errors).toEqual([]);
			expect(r.count).toBeGreaterThanOrEqual(5);
		});

		it('keeps the picture upright and premultiplied alpha intact', async () => {
			const o = await call<{ top: Px; bottom: Px }>('orientation');
			expect(near(o.top, [255, 0, 0, 255])).toBe(true);
			expect(near(o.bottom, [0, 0, 255, 255])).toBe(true);
			const a = await call<{ pixel: Px }>('alpha');
			expect(near(a.pixel, [255, 0, 0, 128], 2)).toBe(true);
		});

		it('glow: threshold → half-res blur → light, drawn into the padding', async () => {
			const g = await call<{
				canvas: number[];
				box: number[];
				centre: Px;
				nearOutside: Px;
				farCorner: Px;
				passes: [string | null, number, number][];
			}>('glow');
			expect(g.canvas).toEqual([44, 44]); // 20 + 2 × 3 × radius
			expect(g.box).toEqual([12, 12, 20, 20]);
			// bright, blurH, blur (half size), final
			expect(g.passes).toEqual([
				['bright', 44, 44],
				['glowH', 22, 22],
				['glow', 22, 22],
				[null, 44, 44],
			]);
			expect(g.centre[0]).toBeGreaterThan(250);
			expect(g.nearOutside[3]).toBeGreaterThan(0); // light outside the layer box
			expect(g.farCorner[3]).toBe(0);
		});

		it('generator: a gradient over the layer box', async () => {
			const g = await call<{ left: Px; mid: Px; right: Px }>('gradient');
			expect(g.left[0]).toBeLessThan(8);
			expect(g.right[0]).toBeGreaterThan(247);
			expect(Math.abs(g.mid[0] - 128)).toBeLessThan(8);
			expect(g.mid[3]).toBe(255);
		});

		it('drop shadow: offset into the padding, under the layer', async () => {
			const s = await call<{ canvas: number[]; right: Px; left: Px; inside: Px }>('shadow');
			expect(s.canvas).toEqual([32, 32]); // 20 + 2 × distance
			expect(near(s.right, [0, 0, 0, 128], 2)).toBe(true);
			expect(s.left[3]).toBe(0);
			expect(near(s.inside, [255, 255, 255, 255])).toBe(true);
		});

		it('time samples: the source over earlier frames', async () => {
			const s = await call<{ source: Px; sample: Px }>('samples');
			expect(near(s.source, [255, 0, 0, 255])).toBe(true);
			expect(near(s.sample, [0, 255, 0, 255])).toBe(true); // the nearest sample (offset −1) is on top
		});

		it('media params are bound with their size; missing media read as size 0', async () => {
			const m = await call<{ bound: Px; missing: Px }>('media');
			expect(near(m.bound, [0, 200, 100, 255])).toBe(true);
			expect(near(m.missing, [255, 0, 255, 255])).toBe(true);
		});

		it('colour runs on the shared host match the LUT (tetrahedral, the colour stage shader)', async () => {
			const l = await call<{ pixel: Px }>('lut');
			expect(near(l.pixel, [0, 191, 255, 255], 2)).toBe(true);
		});

		it('half-float intermediates keep values above 1', async () => {
			const h = await call<{ pixel: Px }>('halfFloat');
			expect(near(h.pixel, [200, 100, 40, 255], 3)).toBe(true);
		});

		it('a shader that does not compile throws FxShaderError with the driver log', async () => {
			const e = await call<{ thrown: boolean; message: string }>('error');
			expect(e.thrown).toBe(true);
			expect(e.message).toMatch(/FX_SHADER_ERROR: test\.broken pass 0: .*undefinedThing/s);
		});
	},
);
