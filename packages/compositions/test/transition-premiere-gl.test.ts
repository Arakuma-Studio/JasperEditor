// @vitest-environment node
// The Premiere transition family (packages/project/src/registry/transitions/premiere-transitions.ts + premiere/*)
// in a real WebGL2 (headless Chrome, SwiftShader when there is no GPU; entry: test/transition-premiere-gl/entry.ts):
// a characteristic pixel of every transition at a fixed progress (Start = End), directions, Reverse, borders,
// one-sided use, determinism of the random ones and the Morph Cut warp. Runs when a Chrome is found
// (JASPER_BROWSER_EXECUTABLE or the usual paths); FX_GL=0 skips it.
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
const RED: Px = [255, 0, 0, 255];
const BLUE: Px = [0, 0, 255, 255];
const near = (a: Px, b: Px, tol = 8) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Premiere transitions in WebGL2 (headless Chrome)',
	{ timeout: 600_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string): Promise<T> =>
			page.evaluate(
				(n) => (window as unknown as { __pr: Record<string, () => unknown> }).__pr[n]!(),
				name,
			) as Promise<T>;

		beforeAll(async () => {
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'transition-premiere-gl', 'entry.ts')],
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
			if (process.env.PREMIERE_TIMINGS === '1') page.on('console', (m) => process.stdout.write(`${m.text()}\n`));
			await page.setContent('<!doctype html><html><body></body></html>');
			await page.addScriptTag({ content: out.outputFiles[0]!.text });
			if (errors.length) throw new Error(errors.join('\n'));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it('draws the characteristic pixels of every Premiere transition', async () => {
			const r = await call<Record<string, Px>>('pixels');
			const expectations: Record<string, Px | ((p: Px) => boolean)> = {
				wipeLeft: BLUE,
				wipeRight: RED,
				wipeDiagNW: BLUE,
				wipeDiagSE: RED,
				wipeBorder: [255, 255, 255, 255],
				wipeReverseRight: BLUE,
				wipeReverseLeft: RED,
				wipeInLeft: BLUE,
				wipeInRight: [0, 0, 0, 0],
				bandTopW: BLUE,
				bandTopE: RED,
				bandBottomE: BLUE,
				bandBottomW: RED,
				barnCenter: BLUE,
				barnEdge: RED,
				barnVertCenter: BLUE,
				barnVertEdge: RED,
				blindsTop1: BLUE,
				blindsBottom1: RED,
				blindsTop2: BLUE,
				boardEven: BLUE,
				boardOdd: RED,
				boardOdd2: RED,
				checkerEven: BLUE,
				checkerOdd: RED,
				checkerFar: RED,
				clockTR: BLUE,
				clockTL: RED,
				clockReverseTL: BLUE,
				clockReverseTR: RED,
				wedgeTop: BLUE,
				wedgeBottom: RED,
				pinIn: BLUE,
				pinOut: RED,
				radialTop: BLUE,
				radialLeft: RED,
				insetIn: BLUE,
				insetOut: RED,
				insetSE: BLUE,
				spiralFirst: BLUE,
				spiralCenter: RED,
				spiralSecondRing: BLUE,
				spiralInnerLate: RED,
				zigFirst: BLUE,
				zigLast: RED,
				zigRow2End: BLUE,
				zigRow2Start: RED,
				randomWipeTop: BLUE,
				randomWipeBottom: RED,
				gradLeft: BLUE,
				gradRight: RED,
				gradInvert: RED,
				gradLumaDark: BLUE,
				gradLumaBright: [255, 255, 255, 255],
				boxIn: BLUE,
				boxOut: RED,
				diamondIn: BLUE,
				diamondOut: RED,
				crossArmH: BLUE,
				crossArmV: BLUE,
				crossBetween: RED,
				boxCenterOff: BLUE,
				boxCenterOffFar: RED,
				cubeLeft: (p) => p[2] > 150 && p[0] < 40,
				cubeRight: (p) => p[0] > 150 && p[2] < 40,
				cubeNSTop: (p) => p[2] > 150 && p[0] < 40,
				cubeNSBottom: (p) => p[0] > 150 && p[2] < 40,
				flipEarly: RED,
				flipLate: BLUE,
				flipMid: [128, 128, 128, 255],
				flipBandsLate: BLUE,
				peelCorner: (p) => p[2] > 100 && p[0] < 30,
				peelFar: RED,
				turnCorner: (p) => p[2] > 100 && p[0] < 30,
				turnFar: RED,
				// The back of the turned page: A (red) seen through paper, lighter.
				turnFlap: (p) => p[0] > 180 && p[1] > 30 && p[1] < 120 && p[2] < 120,
				turnFlapColor: (p) => p[1] > 150 && p[0] < 60,
				slideB: BLUE,
				slideA: RED,
				slideBorder: [255, 255, 255, 255],
				bandSlideTopW: BLUE,
				bandSlideTopE: RED,
				bandSlideBottomE: BLUE,
				bandSlideBottomW: RED,
				centerSplitCenter: BLUE,
				centerSplitCorner: RED,
				splitCenter: BLUE,
				splitEdge: RED,
				splitMovesA: [0, 255, 0, 255],
				whipEarly: (p) => p[0] > 200 && p[2] < 60,
				whipLate: (p) => p[2] > 200 && p[0] < 60,
				additive: [255, 0, 255, 255],
				dipWhite: [255, 255, 255, 255],
				dipWhiteQuarter: [255, 128, 128, 255],
				// Linear-light mix of red and blue: brighter than the 128 of a gamma dissolve.
				film: (p) => p[0] > 170 && p[2] > 170 && p[1] < 10,
				// B (green, brighter) wins as soon as its faded luma passes A's: no mix of the two.
				nonAdditive: [0, 128, 0, 255],
				nonAdditiveDark: [0, 128, 0, 255],
			};
			const bad = Object.entries(expectations)
				.filter(([k, e]) => {
					const v = r[k];
					if (!v) return true;
					return typeof e === 'function' ? !e(v) : !near(v, e, 10);
				})
				.map(([k]) => `${k}: ${r[k]?.join(',')}`);
			expect(bad).toEqual([]);
		});

		it('keeps the random transitions deterministic per instance', async () => {
			const r = await call<Record<string, { blue: number; same: boolean; differs: boolean }>>('random');
			for (const [id, v] of Object.entries(r)) {
				expect(v.same, id).toBe(true);
				expect(v.differs, id).toBe(true);
				expect(v.blue, id).toBeGreaterThan(0.2);
				expect(v.blue, id).toBeLessThan(0.8);
			}
		});

		it('morphs a moved square instead of cross-fading it (Morph Cut)', async () => {
			const r = await call<{ aOnly: Px; bOnly: Px; both: Px }>('morph');
			expect(r.aOnly[0]).toBeLessThan(90);
			expect(r.bOnly[0]).toBeGreaterThan(170);
			expect(r.both[0]).toBeGreaterThan(200);
		});

		it.runIf(process.env.PREMIERE_TIMINGS === '1')('reports run times', async () => {
			console.log(await call<Record<string, number>>('timings'));
		});
	},
);
