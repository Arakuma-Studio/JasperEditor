// @vitest-environment node
// Sapphire Time + Flicker family in a real WebGL2 (headless Chrome, SwiftShader without a GPU): characteristic
// pixels of every effect group — remaps, recursive trails/feedback, sample windows, cut dissolve, repaired and
// retimed (motion-compensated) in-betweens, field removal, flicker add/remove/match — plus alpha and determinism.
// Runs when a Chrome is found (JASPER_BROWSER_EXECUTABLE or the usual paths); FX_GL=0 skips it.
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
const near = (a: Px, b: Px, tol = 4) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire Time + Flicker in WebGL2 (headless Chrome)',
	{ timeout: 60_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string): Promise<T> =>
			page.evaluate(
				(n) => (window as unknown as { __stf: Record<string, () => unknown> }).__stf[n]!(),
				name,
			) as Promise<T>;

		beforeAll(async () => {
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'fx-sapphire-time-flicker-gl', 'entry.ts')],
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

		it('remaps draw the remapped input; Swap Fields Yes Up1 moves it up one pixel', async () => {
			const r = await call<Record<string, Px>>('remaps');
			expect(near(r.freeze!, [255, 0, 0, 255])).toBe(true);
			expect(near(r.reverse!, [0, 255, 0, 255])).toBe(true);
			expect(near(r.up1Above!, [255, 255, 255, 255])).toBe(true);
			expect(r.up1Edge![3]).toBe(0);
		});

		it('S_GetFrame blends towards the next frame by the fraction of Get Frame', async () => {
			const r = await call<{ blend: Px }>('getFrame');
			expect(near(r.blend, [64, 64, 64, 255], 3)).toBe(true);
		});

		it('S_Trails: Max keeps old and new, Ave weights by Prev Brightness, transparent stays transparent', async () => {
			const r = await call<{ maxLeft: Px; maxRight: Px; ave: Px; transparent: Px; same: boolean }>('trails');
			expect(near(r.maxLeft, [255, 0, 0, 255])).toBe(true);
			expect(near(r.maxRight, [0, 255, 0, 255])).toBe(true);
			expect(near(r.ave, [128, 128, 128, 255], 3)).toBe(true);
			expect(r.transparent).toEqual([0, 0, 0, 0]);
			expect(r.same).toBe(true);
		});

		it('S_Feedback zooms the previous output (Z Dist); S_FeedbackBubble depends on Bubble Seed', async () => {
			const r = await call<{ grown: Px; outside: Px; bubbleDiffers: number }>('feedback');
			expect(near(r.grown, [255, 255, 255, 255])).toBe(true);
			expect(r.outside[0]).toBeLessThan(5);
			expect(r.bubbleDiffers).toBeGreaterThan(0);
		});

		it('S_TimeAverage averages the window; S_TimeWarpRGB takes each channel from its own frame', async () => {
			expect(near((await call<{ mean: Px }>('timeAverage')).mean, [85, 85, 85, 255], 3)).toBe(true);
			expect(near((await call<{ pixel: Px }>('timeWarpRgb')).pixel, [255, 0, 0, 255])).toBe(true);
		});

		it('S_MotionDetect is black without motion and shows the difference with it', async () => {
			const r = await call<{ same: Px; moved: Px }>('motionDetect');
			expect(near(r.same, [0, 0, 0, 255])).toBe(true);
			expect(near(r.moved, [255, 0, 255, 255])).toBe(true);
		});

		it('S_NearestColor keeps the colour nearest to Match Color (blue)', async () => {
			expect(near((await call<{ pixel: Px }>('nearestColor')).pixel, [0, 0, 255, 255])).toBe(true);
		});

		it('S_TimeSlice / S_TimeDisplace pick each region’s frame', async () => {
			const s = await call<{ top: Px; bottom: Px }>('timeSlice');
			expect(near(s.top, [0, 255, 0, 255])).toBe(true);
			expect(near(s.bottom, [255, 0, 0, 255])).toBe(true);
			const d = await call<{ white: Px; black: Px }>('timeDisplace');
			expect(near(d.white, [0, 0, 255, 255])).toBe(true);
			expect(near(d.black, [0, 255, 0, 255])).toBe(true);
		});

		it('S_CutToDissolve mixes the two sides inside the window and passes through outside', async () => {
			const r = await call<{ mid: Px; outside: Px }>('cutToDissolve');
			expect(near(r.mid, [149, 149, 149, 255], 4)).toBe(true);
			expect(near(r.outside, [0, 255, 0, 255])).toBe(true);
		});

		it('S_RepairFrames replaces the bad frame by the in-between of its neighbours', async () => {
			const r = await call<{ repaired: Px; good: Px }>('repairFrames');
			expect(near(r.repaired, [128, 128, 128, 255], 4)).toBe(true);
			expect(near(r.good, [255, 0, 0, 255])).toBe(true);
		});

		it('S_Retime interpolates along the motion (not a cross-fade) and can show the flow vectors', async () => {
			const r = await call<{ leading: Px; trailing: Px; centre: Px; vectorAtEdge: Px }>('retime');
			expect(r.centre[0]).toBeGreaterThan(245);
			expect(r.leading[0]).toBeGreaterThan(180); // a cross-fade would give 128
			expect(r.trailing[0]).toBeLessThan(76);
			const v = r.vectorAtEdge;
			expect(Math.max(...v.slice(0, 3)) - Math.min(...v.slice(0, 3))).toBeGreaterThan(20); // coloured = moving
		});

		it('S_FieldRemove deinterlaces combs only', async () => {
			const r = await call<Record<string, Px>>('fieldRemove');
			expect(near(r.combFixed!, [128, 128, 128, 255], 6)).toBe(true);
			expect(near(r.flat!, [128, 128, 128, 255], 3)).toBe(true);
			expect(r.matteComb![0]).toBeGreaterThan(240);
			expect(r.matteFlat![0]).toBeLessThan(5);
		});

		it('S_Flicker scales the colours per frame; the seed changes the pattern', async () => {
			const r = await call<{ doubled: Px; seeds: number[] }>('flicker');
			expect(near(r.doubled, [120, 120, 120, 255], 2)).toBe(true);
			expect(r.seeds[0]).not.toBe(r.seeds[1]);
		});

		it('flicker remove/match tools hold or copy the measured level', async () => {
			const r = await call<Record<string, Px>>('flickerTools');
			expect(near(r.remove!, [128, 128, 128, 255], 3)).toBe(true);
			expect(near(r.removeColor!, [128, 128, 128, 255], 3)).toBe(true);
			expect(near(r.removeMatte!, [128, 128, 128, 255], 3)).toBe(true);
			expect(near(r.rmMatteColor!, [128, 128, 128, 255], 3)).toBe(true);
			expect(near(r.ref!, [32, 32, 32, 255], 3)).toBe(true);
			expect(near(r.noMatch!, [100, 100, 100, 255], 2)).toBe(true);
			expect(near(r.match!, [50, 50, 50, 255], 3)).toBe(true);
			expect(near(r.matchColor!, [100, 50, 200, 255], 4)).toBe(true);
		});
	},
);
