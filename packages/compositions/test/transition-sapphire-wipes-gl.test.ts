// @vitest-environment node
// Sapphire wipes (family sapphire-wipes-other) in a real WebGL2 (headless Chrome, SwiftShader): every S_Wipe* moves
// monotonically from A to B; the characteristic geometry of each shape mid-way (line side, circle / rectangle / star
// in vs out, clock sweep direction, wedges, the four wedges' X), Sapphire's border colour and border glow, Reverse,
// one-sided fades, Grad Add, Grow / Shrink, tile shapes, and determinism of the random ones (same seed → same
// pixels, other seed → different). Entry: test/transition-sapphire-wipes-gl/entry.ts. FX_GL=0 skips it.
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
const near = (a: Px, b: Px, tol = 6) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire wipes in WebGL2 (headless Chrome)',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string, ...args: unknown[]): Promise<T> =>
			page.evaluate(
				([n, a]) =>
					(window as unknown as { __sw: Record<string, (...x: unknown[]) => unknown> }).__sw[n as string]!(
						...(a as unknown[]),
					),
				[name, args] as const,
			) as Promise<T>;
		const pixel = (label: string, p: number, x: number, y: number, over: Record<string, unknown> = {}) =>
			call<Px>('pixel', label, p, x, y, over);
		const hash = (label: string, p: number, over: Record<string, unknown> = {}, frame = 4) =>
			call<number>('hash', label, p, over, frame);

		beforeAll(async () => {
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'transition-sapphire-wipes-gl', 'entry.ts')],
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

		it('runs all 24 wipes, each moving monotonically from A to B', async () => {
			const info = await call<{ webgl2: boolean; labels: string[] }>('info');
			expect(info.webgl2).toBe(true);
			expect(info.labels).toHaveLength(24);
			const r = await call<Record<string, number[]>>('shares');
			const bad = Object.entries(r)
				.filter(([, [a, b, c]]) => !(a! < b! && b! < c!) || b! < 0.05 || b! > 0.95)
				.map(([k, v]) => `${k}: ${v.map((x) => x.toFixed(2)).join(' → ')}`);
			expect(bad).toEqual([]);
		});

		it('S_WipeLine: B enters along Angle, with a centred border and a glow', async () => {
			const o = { angle: 0 };
			expect(near(await pixel('S_WipeLine', 0.5, 0.1, 0.5, o), BLUE)).toBe(true);
			expect(near(await pixel('S_WipeLine', 0.5, 0.9, 0.5, o), RED)).toBe(true);
			// Border Width 8 in green: the band straddles the edge (x = 64 of 128 mid-way).
			const border = { ...o, borderWidth: 8, borderColor: [0, 1, 0, 1] };
			expect(near(await pixel('S_WipeLine', 0.5, 63.5 / 128, 0.5, border), [0, 255, 0, 255])).toBe(true);
			expect(near(await pixel('S_WipeLine', 0.5, 66.5 / 128, 0.5, border), [0, 255, 0, 255])).toBe(true);
			expect(near(await pixel('S_WipeLine', 0.5, 0.3, 0.5, border), BLUE)).toBe(true);
			// Border Glow (white, no noise) lights both sides near the edge.
			const glow = { ...o, borderGlow: 1, glowWidth: 6, noiseAmp: 0 };
			const g = await pixel('S_WipeLine', 0.5, 60.5 / 128, 0.5, glow);
			expect(g[1]).toBeGreaterThan(60);
			expect(near(await pixel('S_WipeLine', 0.5, 0.1, 0.5, glow), BLUE)).toBe(true);
		});

		it('shape wipes: In shrinks the outgoing clip, Out grows the incoming clip', async () => {
			for (const [label, dir] of [
				['S_WipeCircle', 'circle'],
				['S_WipeRectangle', 'rect'],
				['S_WipeStar', 'star'],
			] as const) {
				expect(near(await pixel(label, 0.5, 0.5, 0.5, { wipeDirection: `${dir}In` }), RED), label).toBe(true);
				expect(near(await pixel(label, 0.5, 0.02, 0.03, { wipeDirection: `${dir}In` }), BLUE), label).toBe(
					true,
				);
				expect(near(await pixel(label, 0.5, 0.5, 0.5, { wipeDirection: `${dir}Out` }), BLUE), label).toBe(
					true,
				);
				expect(near(await pixel(label, 0.5, 0.02, 0.03, { wipeDirection: `${dir}Out` }), RED), label).toBe(
					true,
				);
			}
			// Center moves the shape.
			const off = { wipeDirection: 'circleOut', center: [0.2, 0.5] };
			expect(near(await pixel('S_WipeCircle', 0.2, 0.2, 0.5, off), BLUE)).toBe(true);
			expect(near(await pixel('S_WipeCircle', 0.2, 0.8, 0.5, off), RED)).toBe(true);
		});

		it('S_WipeClock sweeps from Angle Open clockwise or counter-clockwise', async () => {
			expect(near(await pixel('S_WipeClock', 0.5, 0.9, 0.5), BLUE)).toBe(true);
			expect(near(await pixel('S_WipeClock', 0.5, 0.1, 0.5), RED)).toBe(true);
			const ccw = { direction: 'counterClockwise' };
			expect(near(await pixel('S_WipeClock', 0.5, 0.9, 0.5, ccw), RED)).toBe(true);
			expect(near(await pixel('S_WipeClock', 0.5, 0.1, 0.5, ccw), BLUE)).toBe(true);
			// A quarter turn from 12 o'clock: the upper right quadrant only.
			expect(near(await pixel('S_WipeClock', 0.3, 0.8, 0.2), BLUE)).toBe(true);
			expect(near(await pixel('S_WipeClock', 0.3, 0.8, 0.8), RED)).toBe(true);
		});

		it('wedges: one from the side, two meeting in the middle, four merging into an X', async () => {
			expect(near(await pixel('S_WipeWedge', 0.3, 0.03, 0.5), BLUE)).toBe(true);
			expect(near(await pixel('S_WipeWedge', 0.3, 0.97, 0.5), RED)).toBe(true);
			expect(near(await pixel('S_WipeDoubleWedge', 0.3, 0.03, 0.5), BLUE)).toBe(true);
			expect(near(await pixel('S_WipeDoubleWedge', 0.3, 0.97, 0.5), BLUE)).toBe(true);
			expect(near(await pixel('S_WipeDoubleWedge', 0.3, 0.5, 0.5), RED)).toBe(true);
			for (const [x, y] of [
				[0.5, 0.03],
				[0.03, 0.5],
			])
				expect(near(await pixel('S_WipeFourWedges', 0.6, x!, y!), BLUE)).toBe(true);
			// The X along the diagonals is the last of A.
			expect(near(await pixel('S_WipeFourWedges', 0.6, 0.02, 0.03), RED)).toBe(true);
			expect(near(await pixel('S_WipeFourWedges', 0.6, 0.5, 0.5), RED)).toBe(true);
		});

		it('Reverse plays the wipe backwards (B enters from the other side)', async () => {
			const o = { angle: 0, reverse: true };
			expect(near(await pixel('S_WipeLine', 0.3, 0.95, 0.5, o), BLUE)).toBe(true);
			expect(near(await pixel('S_WipeLine', 0.3, 0.05, 0.5, o), RED)).toBe(true);
		});

		it('is transparent where a missing side shows (one-sided fade)', async () => {
			// Fade at the head of B (no A): Circle In shrinks the (transparent) outgoing side around the centre.
			expect(near(await call<Px>('oneSided', 'S_WipeCircle', 0.5, 0.02, 0.03), BLUE)).toBe(true);
			const centre = await call<Px>('oneSided', 'S_WipeCircle', 0.5, 0.5, 0.5);
			expect(centre[3]).toBe(0);
		});

		it('Grad Add makes a pattern travel across the frame along Grad Angle', async () => {
			const o = { gradAdd: 10, gradAngle: 0 };
			expect(near(await pixel('S_WipeBlobs', 0.5, 0.05, 0.5, o), BLUE)).toBe(true);
			expect(near(await pixel('S_WipeBlobs', 0.5, 0.95, 0.5, o), RED)).toBe(true);
			// −90°: the pattern travels upwards (the bottom switches first).
			const up = { gradAdd: 10, gradAngle: -90 };
			expect(near(await pixel('S_WipeDots', 0.5, 0.5, 0.95, up), BLUE)).toBe(true);
			expect(near(await pixel('S_WipeDots', 0.5, 0.5, 0.05, up), RED)).toBe(true);
		});

		it('Grow and Shrink differ; every tile shape draws its own pattern', async () => {
			for (const [label, name] of [
				['S_WipeDots', 'dots'],
				['S_WipeChecker', 'checkers'],
				['S_WipeCells', 'cells'],
				['S_WipeWeave', 'strands'],
			] as const)
				expect(await hash(label, 0.4, { [name]: 'grow' }), label).not.toBe(
					await hash(label, 0.4, { [name]: 'shrink' }),
				);
			const tiles = await Promise.all(
				['hexagons', 'triangles', 'diamonds', 'stars'].map((s) =>
					hash('S_WipeTiles', 0.4, { tileShapes: s }),
				),
			);
			expect(new Set(tiles).size).toBe(4);
			for (const s of ['hexagons', 'triangles', 'diamonds', 'stars']) {
				const share = await call<number>('share', 'S_WipeTiles', 0.5, { tileShapes: s });
				expect(share, s).toBeGreaterThan(0.1);
				expect(share, s).toBeLessThan(0.9);
			}
			// Checker mid-way: a checkerboard (the black cells full, the white ones not yet).
			const checker = await call<number>('share', 'S_WipeChecker', 0.5, { angle: 0 });
			expect(checker).toBeGreaterThan(0.35);
			expect(checker).toBeLessThan(0.65);
		});

		it('random wipes are deterministic per seed and change with Seed', async () => {
			for (const label of [
				'S_WipeBlobs',
				'S_WipeCells',
				'S_WipeFlux',
				'S_WipePixelate',
				'S_WipePointalize',
			]) {
				const a = await hash(label, 0.5, { seed: 3 });
				expect(await hash(label, 0.5, { seed: 3 }), label).toBe(a);
				expect(await hash(label, 0.5, { seed: 4 }), label).not.toBe(a);
			}
			// S_WipeDiffuse scatters anew every frame (a pure function of the frame).
			const f4 = await hash('S_WipeDiffuse', 0.5, {}, 4);
			expect(await hash('S_WipeDiffuse', 0.5, {}, 4)).toBe(f4);
			expect(await hash('S_WipeDiffuse', 0.5, {}, 5)).not.toBe(f4);
		});
	},
);
