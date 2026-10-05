// @vitest-environment node
// Sapphire Blur+Sharpen family in a real WebGL2 (headless Chrome, SwiftShader): every effect compiles and runs with
// default params, and each effect's characteristic behaviour shows in the pixels — blur profiles, iris point-spread
// functions (circle vs polygon, prism rings), soft-border padding, alpha, sharpening, median, deband, motion
// streaks, depth-of-field from a Z buffer, skin key, kernel convolution, determinism of the random parts.
// Harness: test/fx-sapphire-blur-sharpen-gl/entry.ts (same host contract as fx-gl). FX_GL=0 skips it.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunOptions } from './fx-sapphire-blur-sharpen-gl/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

type Px = [number, number, number, number];
type Result = { canvas: number[]; box: number[]; probes: Px[]; canvasProbes: Px[]; passes: unknown[] };

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire Blur+Sharpen in WebGL2 (headless Chrome)',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const run = (o: RunOptions) =>
			page.evaluate(
				(opts) => (window as unknown as { __sbs: { run(o: unknown): Promise<unknown> } }).__sbs.run(opts),
				o,
			) as Promise<Result>;

		beforeAll(async () => {
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'fx-sapphire-blur-sharpen-gl', 'entry.ts')],
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

		it('compiles and runs all 24 effects with default params', async () => {
			const r = (await page.evaluate(() =>
				(window as unknown as { __sbs: { smoke(): Promise<unknown> } }).__sbs.smoke(),
			)) as { count: number; errors: string[] };
			expect(r.errors).toEqual([]);
			expect(r.count).toBe(24);
		});

		it('S_Blur: identity at 0, a smooth ramp across an edge, Mix With Source restores the source', async () => {
			// 640 px wide: σ = 0.4 × 320 / 24 ≈ 5.3 px.
			const zero = await run({
				effectId: 'jasper.s.blur',
				params: { blurAmount: 0 },
				width: 640,
				height: 8,
				scene: 'edge',
				probes: [
					[319, 4],
					[320, 4],
				],
			});
			expect(zero.probes[0]![0]).toBeGreaterThan(250);
			expect(zero.probes[1]![0]).toBeLessThan(5);
			const b = await run({
				effectId: 'jasper.s.blur',
				params: { blurAmount: 0.4 },
				width: 640,
				height: 8,
				scene: 'edge',
				probes: [
					[200, 4],
					[316, 4],
					[320, 4],
					[324, 4],
					[500, 4],
				],
			});
			const v = b.probes.map((p) => p[0]);
			expect(v[0]).toBeGreaterThan(250);
			expect(v[1]).toBeGreaterThan(v[2]!);
			expect(v[2]).toBeGreaterThan(v[3]!);
			expect(Math.abs(v[2]! - 128)).toBeLessThan(30);
			expect(v[4]).toBeLessThan(5);
			const mix = await run({
				effectId: 'jasper.s.blur',
				params: { mixWithOriginal: 1 },
				width: 640,
				height: 8,
				scene: 'edge',
				probes: [[319, 4]],
			});
			expect(mix.probes[0]![0]).toBeGreaterThan(250);
		});

		it('transparent input stays transparent; Soft Borders draw into the padding', async () => {
			const empty = await run({
				effectId: 'jasper.s.rack-defocus',
				width: 48,
				height: 32,
				scene: 'empty',
				probes: [[24, 16]],
			});
			expect(empty.probes[0]![3]).toBe(0);
			const hard = await run({
				effectId: 'jasper.s.blur',
				params: { blurAmount: 1 },
				width: 64,
				height: 64,
				scene: 'square',
			});
			expect(hard.canvas).toEqual([64, 64]);
			const soft = await run({
				effectId: 'jasper.s.blur',
				params: { blurAmount: 2, softBorders: true },
				width: 64,
				height: 64,
				scene: 'flat',
				canvasProbes: [[2, 2]],
			});
			expect(soft.canvas[0]).toBeGreaterThan(64);
			const b = soft.box;
			// The layer's colour spreads just outside the layer box.
			const r2 = await run({
				effectId: 'jasper.s.blur',
				params: { blurAmount: 2, softBorders: true },
				width: 64,
				height: 64,
				scene: 'flat',
				canvasProbes: [[b[0]! - 1, b[1]! + 32]],
			});
			expect(r2.canvasProbes[0]![3]).toBeGreaterThan(0);
		});

		it('S_RackDefocus: a bright point becomes a uniform disc (circle) or a polygon', async () => {
			// 256 px layer: radius = 0.3 × 128 / 2 = 19.2 px.
			const o = { effectId: 'jasper.s.rack-defocus', width: 256, height: 256, scene: 'dot' };
			// Use Gamma + Boost Highlights keep the point's energy: the disc is saturated inside, black outside.
			const hl = { defocusWidth: 0.3, useGamma: 3, boostHighlights: 4 };
			const c = await run({
				...o,
				params: hl,
				probes: [
					[128, 128],
					[128 + 12, 128],
					[128, 128 - 12],
					[128 - 9, 128 + 9],
					[128 + 26, 128],
				],
			});
			const lum = c.probes.map((p) => p[0]);
			for (const v of lum.slice(0, 4)) expect(v).toBeGreaterThan(200);
			expect(lum[4]).toBeLessThanOrEqual(2);
			// Square iris, Rotate 0: vertices on the axes (circumradius 19.2 px), sides at 13.6 px on the diagonals.
			const sq = await run({
				...o,
				params: { ...hl, shape: '4' },
				probes: [
					[128 + 16, 128],
					[128 + 12, 128 + 12],
				],
			});
			expect(sq.probes[0]![0]).toBeGreaterThan(200);
			// A circle reaches the diagonal point at 17 px, the square's side (13.6 px) does not.
			const circ = await run({ ...o, params: hl, probes: [[128 + 12, 128 + 12]] });
			expect(circ.probes[0]![0]).toBeGreaterThan(200);
			expect(circ.probes[0]![0] - sq.probes[1]![0]).toBeGreaterThan(80);
		});

		it('S_DefocusPrism: highlights become coloured rings (channels at different radii)', async () => {
			const r = await run({
				effectId: 'jasper.s.defocus-prism',
				params: { defocusWidth: 0.3, useGamma: 1.5, boostHighlights: 2 },
				width: 256,
				height: 256,
				scene: 'dot',
				probes: [
					[128, 128],
					[128 + 16, 128],
					[128 + 8, 128],
				],
			});
			const [centre, outer, inner] = r.probes as [Px, Px, Px];
			// Hollow centre, red on the outer ring, blue further in.
			expect(centre[0] + centre[1] + centre[2]).toBeLessThan(outer[0] + inner[2]);
			expect(outer[0]).toBeGreaterThan(outer[2]);
			expect(inner[2]).toBeGreaterThan(inner[0]);
		});

		it('S_Sharpen leaves flat areas alone; S_Median removes salt-and-pepper noise', async () => {
			const flat = await run({
				effectId: 'jasper.s.sharpen',
				width: 48,
				height: 32,
				scene: 'flat',
				probes: [[24, 16]],
			});
			expect(flat.probes[0]!.slice(0, 3).map((v) => Math.round(v / 4))).toEqual([51, 34, 17]); // #c84
			const med = await run({
				effectId: 'jasper.s.median',
				params: { size: 2 },
				width: 64,
				height: 64,
				scene: 'speckle',
				probes: [
					[10, 10],
					[20, 33],
					[40, 47],
					[57, 5],
				],
			});
			for (const p of med.probes) expect(Math.abs(p[0] - 128)).toBeLessThan(4);
		});

		it('S_Deband smooths the steps of a banded gradient but keeps real edges', async () => {
			const o = {
				width: 192,
				height: 32,
				scene: 'bands',
				probes: [
					[15, 16],
					[17, 16],
				] as [number, number][],
			};
			const src = await run({ effectId: 'jasper.s.blur', params: { blurAmount: 0 }, ...o });
			const db = await run({ effectId: 'jasper.s.deband', params: { diffuseRadius: 16 }, ...o });
			const step = (r: Result) => Math.abs(r.probes[1]![0] - r.probes[0]![0]);
			expect(step(src)).toBeGreaterThanOrEqual(3);
			expect(step(db)).toBeLessThan(step(src));
			const edges = await run({
				effectId: 'jasper.s.deband',
				params: { show: 'edges', edgeThreshold: 20 },
				width: 64,
				height: 32,
				scene: 'edge',
				probes: [
					[32, 16],
					[10, 16],
				],
			});
			expect(edges.probes[0]![0] + edges.probes.at(-1)![0]).toBeGreaterThan(0);
			expect(edges.probes[1]![0]).toBe(0);
		});

		it('S_BlurDirectional streaks along its angle only', async () => {
			const r = await run({
				effectId: 'jasper.s.blur-directional',
				params: { angle: 0, blurAmount: 0.5, edgeMode: 'transparent' },
				width: 256,
				height: 64,
				scene: 'dot',
				probes: [
					[128 + 5, 32],
					[128, 32 + 10],
				],
			});
			expect(r.probes[0]![0]).toBeGreaterThan(0);
			expect(r.probes[1]![0]).toBe(0);
		});

		it('S_BlurMotion zooms around its centre (the centre stays put)', async () => {
			const r = await run({
				effectId: 'jasper.s.blur-motion',
				width: 64,
				height: 64,
				scene: 'dot',
				probes: [
					[32, 32],
					[32, 10],
				],
			});
			expect(r.probes[0]![0]).toBeGreaterThan(20);
			expect(r.probes[1]![0]).toBe(0);
		});

		it('S_ZDefocus / S_ZBlur: only what is away from the focal depth is blurred', async () => {
			for (const effectId of ['jasper.s.z-defocus', 'jasper.s.z-blur']) {
				// depthSplit: near (white) bottom half, far (black) top half; focal depth 0 = near → bottom sharp.
				const r = await run({
					effectId,
					params: { focalDepth: 0, depthOfField: 0.1, blurWidth: 1 },
					width: 128,
					height: 128,
					scene: 'edge',
					media: { zBuffer: 'depthSplit' },
					probes: [
						[62, 110],
						[66, 110],
						[62, 16],
						[66, 16],
					],
				});
				const [bl, br, tl, tr] = r.probes.map((p) => p[0]) as [number, number, number, number];
				expect(bl - br, effectId).toBeGreaterThan(200); // sharp edge at the bottom
				expect(tl - tr, effectId).toBeLessThan(150); // blurred edge at the top
				// No Z buffer: everything sits at the focal depth (in focus).
				const none = await run({
					effectId,
					width: 128,
					height: 128,
					scene: 'edge',
					probes: [
						[62, 16],
						[66, 16],
					],
				});
				expect(none.probes[0]![0] - none.probes[1]![0]).toBeGreaterThan(200);
			}
		});

		it('S_Beauty keys skin tones (Show: Skin Detect Mask)', async () => {
			const r = await run({
				effectId: 'jasper.s.beauty',
				params: { show: 'skinMask' },
				width: 64,
				height: 32,
				scene: 'skin',
				probes: [
					[10, 16],
					[54, 16],
				],
			});
			expect(r.probes[0]![0]).toBeGreaterThan(150);
			expect(r.probes[1]![0]).toBeLessThan(10);
		});

		it('S_EdgeBlur finds edges (Show: Edges) and S_Convolve stamps its kernel', async () => {
			const e = await run({
				effectId: 'jasper.s.edge-blur',
				params: { show: 'edges' },
				width: 128,
				height: 32,
				scene: 'edge',
				probes: [
					[64, 16],
					[10, 16],
				],
			});
			expect(e.probes[0]![0]).toBeGreaterThan(100);
			expect(e.probes[1]![0]).toBeLessThan(5);
			const c = await run({
				effectId: 'jasper.s.convolve',
				params: { kernelSize: 1 },
				width: 256,
				height: 256,
				scene: 'dot',
				media: { kernel: 'disc' },
				probes: [
					[128, 128],
					[128 + 5, 128],
					[128 + 30, 128],
				],
			});
			// The disc kernel radius is 4 % of 256 = ~10 px.
			expect(c.probes[0]![0]).toBeGreaterThan(0);
			expect(c.probes[1]![0]).toBeGreaterThan(0);
			expect(c.probes[2]![0]).toBe(0);
		});

		it('random parts are deterministic: FreeLens shake and AdvancedDefocus grain', async () => {
			const shake = { xRandAmp: 3, yRandAmp: 3, tiltXRandAmp: 2 };
			const o = {
				effectId: 'jasper.s.free-lens',
				width: 96,
				height: 54,
				scene: 'night',
				params: shake,
				probes: [
					[20, 20],
					[60, 30],
					[80, 10],
				] as [number, number][],
			};
			const a = await run({ ...o, frame: 10 });
			const b = await run({ ...o, frame: 10 });
			expect(b.probes).toEqual(a.probes);
			const c = await run({ ...o, frame: 10, seed: 0.77 });
			expect(c.probes).not.toEqual(a.probes);
			const g = {
				effectId: 'jasper.s.advanced-defocus',
				width: 96,
				height: 54,
				scene: 'flat',
				params: { grainAmp: 1 },
				probes: [
					[10, 10],
					[50, 30],
					[90, 50],
				] as [number, number][],
			};
			const g1 = await run({ ...g, frame: 3 });
			expect((await run({ ...g, frame: 3 })).probes).toEqual(g1.probes);
			expect((await run({ ...g, frame: 4 })).probes).not.toEqual(g1.probes);
		});
	},
);
