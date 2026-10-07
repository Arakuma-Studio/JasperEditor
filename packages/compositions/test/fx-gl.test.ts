// @vitest-environment node
// The fx GPU host in a real WebGL2 (wave-1 fx framework): headless Chrome (Playwright, SwiftShader when there is no
// GPU) runs src/fx/host.ts bundled with esbuild. Compiles the whole GLSL library and EVERY registered GPU effect
// (the fx catalogue: wave-2 families get this check for free) and checks the host contract: orientation, alpha,
// multi-pass + downscaled blur + padding (glow), generator, padded drop shadow, time samples, media textures, LUT
// pass, half-float intermediates, compile errors. Runs when a Chrome is found (JASPER_BROWSER_EXECUTABLE or the
// usual paths); FX_GL=0 skips it.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FX_FAMILIES } from '@jasper/project';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

type Px = [number, number, number, number];
const near = (a: Px, b: Px, tol = 3) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'fx GPU host in WebGL2 (headless Chrome)',
	{ timeout: 60_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string, arg?: string): Promise<T> =>
			page.evaluate(
				([n, a]) => (window as unknown as { __fx: Record<string, (a?: string) => unknown> }).__fx[n]!(a),
				[name, arg] as const,
			) as Promise<T>;

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'fx-gl', 'entry.ts')));
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

		it('compiles and runs every registered GPU effect outside the families and the test effects', async () => {
			const r = await call<{ count: number; errors: string[] }>('catalogue');
			expect(r.errors).toEqual([]);
			expect(r.count).toBeGreaterThanOrEqual(5);
		});

		// One test per fx family: SwiftShader compiles slowly, so the whole catalogue does not fit one timeout.
		for (const family of FX_FAMILIES.map((f) => f.file))
			it(`compiles and runs every GPU effect of ${family}`, { timeout: 240_000 }, async () => {
				const r = await call<{ count: number; errors: string[] }>('catalogue', family);
				expect(r.errors).toEqual([]);
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

		describe('framework follow-ups', () => {
			it('the faster library helpers return bit-identical values to the wave-1 sources', async () => {
				expect(await call<Record<string, number>>('libraryIdentical')).toEqual({
					hashes: 0,
					noise2d: 0,
					noise3d: 0,
				});
			});

			it('ping-pong outputs: update passes read the previous contents under the same name', async () => {
				const p = await call<Px>('pingPong');
				expect(near(p, [255, 255, 255, 102], 3)).toBe(true); // premultiplied 0.1 + 3 × 0.1, read back straight
			});

			it('absolute pass sizes (a 1×1 lookup pass)', async () => {
				const r = await call<{ left: Px; right: Px; size: number[] }>('absoluteSize');
				expect(r.size).toEqual([1, 1]);
				expect(near(r.left, [255, 0, 0, 255])).toBe(true);
				expect(near(r.right, [255, 0, 0, 255])).toBe(true);
			});

			it('mipmapped outputs and source: textureLod at a coarse level averages', async () => {
				const r = await call<{ output: Px; source: Px }>('mipmaps');
				expect(near(r.output, [128, 0, 128, 255], 4)).toBe(true);
				expect(near(r.source, [128, 0, 128, 255], 4)).toBe(true);
			});

			it('ivec2 uniforms', async () => {
				expect(near(await call<Px>('ivec2'), [51, 102, 0, 255], 1)).toBe(true);
			});

			it('lut media params bind .cube LUTs as 3D textures (identity when none)', async () => {
				const r = await call<{ bound: Px; none: Px }>('lut3d');
				expect(near(r.bound, [0, 191, 255, 255], 3)).toBe(true);
				expect(near(r.none, [255, 64, 0, 255], 2)).toBe(true);
			});

			it('u_sampleCount / u_sampleOffsets / u_sampleValid are bound in passes that do not sample', async () => {
				const p = await call<Px>('sampleBindings');
				expect(near(p, [64, 1, 128, 255], 2)).toBe(true);
			});

			it('time samples are uploaded once per key', async () => {
				const r = await call<{ first: Px; sameKey: Px; newKey: Px }>('samplesOnce');
				expect(near(r.first, [255, 0, 0, 255])).toBe(true);
				expect(near(r.sameKey, [255, 0, 0, 255])).toBe(true); // same key: not re-uploaded
				expect(near(r.newKey, [0, 255, 0, 255])).toBe(true);
			});

			it('one-direction Gaussian Blur runs as a GPU stand-in in the chain (vertical only)', async () => {
				const r = await call<{ onLine: Px; above: Px; padding: number; equalSigmas: boolean }>('blurStandIn');
				expect(r.padding).toBe(9);
				// A 1-px line under σ = 3: peak ≈ 1 / (√(2π)·3) ≈ 0.13, spread vertically.
				expect(Math.abs(r.onLine[3] - 34)).toBeLessThan(6);
				expect(r.above[3]).toBeGreaterThan(15);
				expect(r.above[3]).toBeLessThan(r.onLine[3]);
				expect(r.equalSigmas).toBe(true); // equal sigmas keep the 2D canvas blur()
			});

			it('Transform: Shutter Angle motion blur from the params at sub-frame times', async () => {
				const r = await call<{ sharpEdge: Px; blurredEdge: Px; blurredMid: Px }>('transformBlur');
				expect(r.sharpEdge[3]).toBe(255);
				expect(r.blurredEdge[3]).toBeGreaterThan(100);
				expect(r.blurredEdge[3]).toBeLessThan(250);
				expect(r.blurredMid[3]).toBeGreaterThan(250);
			});
		});

		it('a shader that does not compile throws FxShaderError with the driver log', async () => {
			const e = await call<{ thrown: boolean; message: string }>('error');
			expect(e.thrown).toBe(true);
			expect(e.message).toMatch(/FX_SHADER_ERROR: test\.broken pass 0: .*undefinedThing/s);
		});
	},
);
