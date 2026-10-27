// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultEffectRegistry, FX_FAMILIES } from '@jasper/project';
import { expectFingerprints } from '@jasper/testkit/golden';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_FX } from './fx-examples.ts';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Golden fingerprints of every GPU effect (4×4 mean RGB at defaults on the test card; ±FP_TOL levels). */
const FX_FINGERPRINTS = join(here, 'goldens', 'fx-fingerprints.json');
const FP_TOL = 4;
const inFamily = new Set(FX_FAMILIES.flatMap((f) => f.effects.map((s) => s.id)));
const fingerprintGroups = [
	{
		family: undefined,
		ids: [...defaultEffectRegistry.list().filter((s) => s.gpu && !inFamily.has(s.id)), ...TEST_FX].map(
			(s) => s.id,
		),
		timeout: 60_000,
	},
	...FX_FAMILIES.map((f) => ({
		family: f.file,
		ids: f.effects.filter((s) => s.gpu).map((s) => s.id),
		timeout: 240_000,
	})),
];
// Pinned effects must still run (and fail lookup) if they disappear from the current catalogue.
const pinnedIds = new Set(
	Object.keys(JSON.parse(readFileSync(FX_FINGERPRINTS, 'utf8'))).map((id) => id.replace(/@perturbed$/, '')),
);
const listedIds = new Set(fingerprintGroups.flatMap((g) => g.ids));
fingerprintGroups.push({
	family: undefined,
	ids: [...pinnedIds].filter((id) => !listedIds.has(id)),
	timeout: 60_000,
});

type Px = [number, number, number, number];
const near = (a: Px, b: Px, tol = 3) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'fx GPU host in WebGL2 (headless Chrome)',
	{ timeout: 60_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string, arg?: { family?: string; id: string }): Promise<T> =>
			page.evaluate(
				([n, a]) =>
					(window as unknown as { __fx: Record<string, (a?: { family?: string; id: string }) => unknown> })
						.__fx[n]!(a),
				[name, arg] as const,
			) as Promise<T>;

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'fx-gl', 'entry.ts')));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		for (const { family, ids, timeout } of fingerprintGroups)
			for (const id of ids)
				it(`matches golden pixels for ${id} at default and perturbed settings`, { timeout }, async () => {
					expectFingerprints(
						FX_FINGERPRINTS,
						await call<Record<string, number[]>>('fingerprints', { family, id }),
						FP_TOL,
					);
				});

		it('the gallery card fills its poster and keeps missing-asset warnings on the card', async () => {
			type Rect = { left: number; top: number; right: number; bottom: number; width: number };
			const { poster, card, warning } = await call<{ poster: Rect; card: Rect; warning: Rect }>(
				'templatePreview',
			);
			expect(card.width).toBeGreaterThan(poster.width * 0.65);
			expect(card.width).toBeLessThan(poster.width);
			expect(warning.width).toBeGreaterThan(0);
			expect(warning.left).toBeGreaterThanOrEqual(card.left);
			expect(warning.right).toBeLessThanOrEqual(card.right);
			expect(warning.top).toBeGreaterThanOrEqual(Math.max(poster.top, card.top));
			expect(warning.bottom).toBeLessThanOrEqual(Math.min(poster.bottom, card.bottom));
		});

		it('lowered text moves its paint at full and reduced resolution, with shutter blur while moving', async () => {
			type Sample = { empty: Px; text: Px; shadow: Px };
			const result = await call<{
				samples: Sample[];
				transformedSamples: Sample[];
				blurred: Px;
			}>('lowered');
			for (const sample of [...result.samples, ...result.transformedSamples]) {
				expect(sample.empty).toEqual([0, 0, 0, 0]);
				expect(sample.text).toEqual([255, 0, 0, 255]);
				expect(sample.shadow).toEqual([0, 0, 255, 255]);
			}
			expect(result.blurred[3]).toBeGreaterThan(50);
			expect(result.blurred[3]).toBeLessThan(200);
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
				centre: Px;
				nearOutside: Px;
				farCorner: Px;
			}>('glow');
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
			const s = await call<{ right: Px; left: Px; inside: Px }>('shadow');
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
			it('ping-pong outputs: update passes read the previous contents under the same name', async () => {
				const p = await call<Px>('pingPong');
				expect(near(p, [255, 255, 255, 102], 3)).toBe(true); // premultiplied 0.1 + 3 × 0.1, read back straight
			});

			it('absolute pass sizes (a 1×1 lookup pass)', async () => {
				const r = await call<{ left: Px; right: Px; top: Px; bottom: Px }>('absoluteSize');
				expect(near(r.left, [255, 0, 0, 255])).toBe(true);
				expect(near(r.right, [255, 0, 0, 255])).toBe(true);
				expect(near(r.top, [255, 0, 0, 255])).toBe(true);
				expect(near(r.bottom, [255, 0, 0, 255])).toBe(true);
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

			it('one-direction Gaussian Blur runs as a GPU stand-in in the chain (vertical only)', async () => {
				const r = await call<{ onLine: Px; above: Px }>('blurStandIn');
				// A 1-px line under σ = 3: peak ≈ 1 / (√(2π)·3) ≈ 0.13, spread vertically.
				expect(Math.abs(r.onLine[3] - 34)).toBeLessThan(6);
				expect(r.above[3]).toBeGreaterThan(15);
				expect(r.above[3]).toBeLessThan(r.onLine[3]);
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
