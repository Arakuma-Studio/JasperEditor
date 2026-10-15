// @vitest-environment node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RenderOpts } from './fx-sapphire-stylize-other-gl/entry.ts';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

type Px = [number, number, number, number];
type Result = {
	hash: number;
	probes: Px[];
};
const near = (a: Px, b: Px, tol = 3) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const luma = (p: Px) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

const EFFECTS = [
	'jasper.s.band-pass',
	'jasper.s.color-fuse',
	'jasper.s.dog-vision',
	'jasper.s.mosaic',
	'jasper.s.pixel-mosh',
	'jasper.s.pixel-sort',
	'jasper.s.prism-lens',
	'jasper.s.pseudo-color',
	'jasper.s.psyko-blobs',
	'jasper.s.psyko-stripes',
	'jasper.s.roman-tile',
	'jasper.s.solarize',
	'jasper.s.strip-slide',
	'jasper.s.zebrafy',
	'jasper.s.zebrafy-color',
	'jasper.s.z-fog-exponential',
	'jasper.s.z-fog-linear',
];

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire other-stylize effects in WebGL2 (headless Chrome)',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const render = (o: RenderOpts): Promise<Result> =>
			page.evaluate(
				(opts) => (window as unknown as { __sso: { render(o: RenderOpts): Result } }).__sso.render(opts),
				o,
			);

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'fx-sapphire-stylize-other-gl', 'entry.ts')));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		const W = 64;
		const H = 36;
		const QUAD: Px[] = [
			[224, 32, 32, 255],
			[32, 192, 64, 255],
			[32, 64, 224, 255],
			[240, 224, 32, 255],
		];
		const QUAD_PROBES: [number, number][] = [
			[16, 9],
			[48, 9],
			[16, 27],
			[48, 27],
		];
		const grey = (v: number, a = 1) => ({ kind: 'solid' as const, color: `rgba(${v},${v},${v},${a})` });
		const one = async (id: string, params: Record<string, unknown>, extra: Partial<RenderOpts> = {}) =>
			(await render({ id, params, w: W, h: H, scene: grey(128), probes: [[32, 18]], ...extra })).probes[0]!;

		it('transparent input stays transparent', async () => {
			for (const id of EFFECTS) {
				const params = id === 'jasper.s.roman-tile' ? { cropToAlpha: true } : {};
				const r = await render({
					id,
					params,
					w: W,
					h: H,
					scene: { kind: 'transparent' },
					probes: QUAD_PROBES,
				});
				for (const p of r.probes) expect([id, p[3]]).toEqual([id, 0]);
			}
		});

		it('colour effects keep the alpha of a half-transparent input', async () => {
			const ids = EFFECTS.filter((id) =>
				/band-pass|color-fuse|dog-vision|pseudo-color|psyko|solarize|zebrafy|z-fog/.test(id),
			);
			for (const id of ids) {
				const p = await one(id, {}, { scene: { kind: 'solid', color: 'rgba(200,100,50,0.5)' } });
				expect([id, Math.abs(p[3] - 128) <= 2]).toEqual([id, true]);
			}
		});

		it('Mix with Orig = 1 returns the input', async () => {
			for (const id of EFFECTS) {
				if (id === 'jasper.s.dog-vision') continue; // has its own Mix Original (below)
				const r = await render({
					id,
					params: { mixWithOriginal: 1 },
					w: W,
					h: H,
					scene: { kind: 'quad' },
					probes: QUAD_PROBES,
				});
				r.probes.forEach((p, i) => {
					expect([id, i, near(p, QUAD[i]!, 3)]).toEqual([id, i, true]);
				});
			}
			const d = await render({
				id: 'jasper.s.dog-vision',
				params: { mixOriginal: 1 },
				w: W,
				h: H,
				scene: { kind: 'quad' },
				probes: QUAD_PROBES,
			});
			d.probes.forEach((p, i) => {
				expect(near(p, QUAD[i]!, 3)).toBe(true);
			});
		});

		it('S_BandPass: a flat picture becomes the Offset Darks grey; edges stand out', async () => {
			expect(near(await one('jasper.s.band-pass', {}), [128, 128, 128, 255], 2)).toBe(true);
			const r = await render({
				id: 'jasper.s.band-pass',
				w: W,
				h: H,
				scene: { kind: 'quad' },
				probes: [
					[31, 9],
					[8, 9],
				],
			});
			expect(Math.abs(luma(r.probes[0]!) - 128)).toBeGreaterThan(10); // at the red|green edge
			expect(near(r.probes[1]!, [128, 128, 128, 255], 3)).toBe(true); // flat inside a quadrant
		});

		it('S_ColorFuse: no LUT = identity, a built-in look, and a 2D LUT image (strip) inverting colours', async () => {
			const src = { kind: 'solid' as const, color: 'rgb(200,100,50)' };
			expect(
				near(await one('jasper.s.color-fuse', { lut1: 'none' }, { scene: src }), [200, 100, 50, 255], 2),
			).toBe(true);
			const sepia = await one(
				'jasper.s.color-fuse',
				{ lut1: 'sepia', lut1Strength: 1 },
				{ scene: grey(255) },
			);
			expect(near(sepia, [255, 255, 239, 255], 3)).toBe(true);
			const inv = await one(
				'jasper.s.color-fuse',
				{ lut1Strength: 1, lut1Image: { mediaId: 'lut' } },
				{ scene: src, media: { lut1Image: { kind: 'invertStrip', w: 16, h: 4 } } },
			);
			expect(near(inv, [55, 155, 205, 255], 4)).toBe(true);
		});

		it('S_DogVision: red seen yellow-blue is a dark yellow', async () => {
			const p = await one('jasper.s.dog-vision', {}, { scene: { kind: 'solid', color: '#f00' } });
			expect(near(p, [128, 128, 0, 255], 3)).toBe(true);
			const c = await one(
				'jasper.s.dog-vision',
				{ channels: 'cyanRed' },
				{ scene: { kind: 'solid', color: '#f00' } },
			);
			expect(near(c, [255, 0, 0, 255], 3)).toBe(true);
		});

		it('S_Mosaic: blocks of the average colour', async () => {
			const r = await render({
				id: 'jasper.s.mosaic',
				params: { pixelFrequency: 4 },
				w: W,
				h: H,
				scene: { kind: 'ramp' },
				probes: [
					[1, 18],
					[14, 18],
					[17, 18],
					[1, 2],
				],
			});
			const [a, b, c, d] = r.probes as [Px, Px, Px, Px];
			expect(near(a, b, 1)).toBe(true);
			expect(near(a, d, 1)).toBe(true);
			expect(Math.abs(a[0] - 32)).toBeLessThan(10); // the mean of the ramp over x 0…16
			expect(c[0] - a[0]).toBeGreaterThan(40);
		});

		it('S_PixelMosh: the hold frame pushed by the block motion; without samples the source', async () => {
			const params = { frameInterval: 30, varyFrameInterval: 0 };
			const moshed = await render({
				id: 'jasper.s.pixel-mosh',
				params,
				w: W,
				h: H,
				frame: 12,
				scene: grey(128),
				samples: [grey(128), { kind: 'quad' }],
				probes: QUAD_PROBES,
			});
			moshed.probes.forEach((p, i) => {
				expect(near(p, QUAD[i]!, 3)).toBe(true);
			}); // no motion: the held quad
			const start = await render({
				id: 'jasper.s.pixel-mosh',
				params,
				w: W,
				h: H,
				frame: 0,
				scene: grey(128),
				probes: [[32, 18]],
			});
			expect(near(start.probes[0]!, [128, 128, 128, 255], 2)).toBe(true);
		});

		it('S_PixelSort: columns sorted dark → bright downwards (reversed on request), threshold matte', async () => {
			const ys = Array.from({ length: 8 }, (_, i) => (i + 0.5) * (H / 8));
			const sorted = async (reverse: boolean) =>
				(
					await render({
						id: 'jasper.s.pixel-sort',
						params: {
							threshold: -1,
							randomlyRestartSort: 0,
							softenThresholdMask: 0,
							reverseSortDirection: reverse,
						},
						w: W,
						h: H,
						scene: { kind: 'bars' },
						probes: ys.map((y) => [20, y] as [number, number]),
					})
				).probes.map(luma);
			const up = await sorted(false);
			for (let i = 1; i < up.length; i++) expect(up[i]!).toBeGreaterThanOrEqual(up[i - 1]! - 1);
			expect(up[0]!).toBeLessThan(20);
			expect(up[7]!).toBeGreaterThan(235);
			const down = await sorted(true);
			for (let i = 1; i < down.length; i++) expect(down[i]!).toBeLessThanOrEqual(down[i - 1]! + 1);
			const matte = await render({
				id: 'jasper.s.pixel-sort',
				params: { threshold: 0.5, show: 'matte' },
				w: W,
				h: H,
				scene: { kind: 'bars' },
				probes: [
					[20, ys[0]!],
					[20, ys[3]!],
				],
			});
			expect(matte.probes[0]![0]).toBeLessThan(5); // black bar: not sorted
			expect(matte.probes[1]![0]).toBeGreaterThan(250); // white bar: sorted
		});

		it('S_PseudoColor: black stays black, mid tones turn saturated', async () => {
			const r = await render({
				id: 'jasper.s.pseudo-color',
				w: W,
				h: H,
				scene: { kind: 'ramp' },
				probes: [
					[0, 18],
					[40, 18],
				],
			});
			expect(luma(r.probes[0]!)).toBeLessThan(10);
			const p = r.probes[1]!;
			expect(Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2])).toBeGreaterThan(100);
		});

		it('seeded and animated effects are deterministic; the seed and Phase Speed change them', async () => {
			for (const id of ['jasper.s.psyko-blobs', 'jasper.s.roman-tile', 'jasper.s.strip-slide']) {
				const base = {
					id,
					params: id.includes('strip') ? { order: 'random', randomizeSize: 0.8 } : {},
					w: W,
					h: H,
					scene: { kind: 'quad' as const },
				};
				const a = await render({ ...base, seed: 0.25 });
				const b = await render({ ...base, seed: 0.25 });
				const c = await render({ ...base, seed: 0.6 });
				expect([id, a.hash === b.hash, a.hash === c.hash]).toEqual([id, true, false]);
			}
			for (const id of ['jasper.s.psyko-blobs', 'jasper.s.psyko-stripes', 'jasper.s.zebrafy-color']) {
				const base = { id, params: { phaseSpeed: 1 }, w: W, h: H, scene: { kind: 'ramp' as const } };
				const f0 = await render({ ...base, frame: 0 });
				const f9 = await render({ ...base, frame: 9 });
				const still = await render({ ...base, params: { phaseSpeed: 0 }, frame: 9 });
				const still0 = await render({ ...base, params: { phaseSpeed: 0 }, frame: 0 });
				expect([id, f0.hash !== f9.hash, still.hash === still0.hash]).toEqual([id, true, true]);
			}
		});

		it('S_RomanTile: tiles of the picture set in grout of the Grout Color', async () => {
			const probes = Array.from(
				{ length: 48 },
				(_, i) => [(i % 8) * 8 + 3, Math.floor(i / 8) * 6 + 2] as [number, number],
			);
			const r = await render({
				id: 'jasper.s.roman-tile',
				params: {
					groutColor: [0, 1, 0, 1],
					groutWidth: 0.8,
					lightBrightness: 0,
					groutRoughness: 0,
					tileSize: 1,
				},
				w: W,
				h: H,
				scene: { kind: 'solid', color: '#f00' },
				probes,
			});
			const green = r.probes.filter((p) => p[1] > 150 && p[0] < 100).length;
			const red = r.probes.filter((p) => p[0] > 150 && p[1] < 100).length;
			expect(green).toBeGreaterThan(0);
			expect(red).toBeGreaterThan(0);
		});

		it('S_Solarize: colours above the threshold are inverted', async () => {
			expect(
				near(await one('jasper.s.solarize', { brightness: 1 }, { scene: grey(204) }), [51, 51, 51, 255], 2),
			).toBe(true);
			expect(
				near(await one('jasper.s.solarize', { brightness: 1 }, { scene: grey(77) }), [77, 77, 77, 255], 2),
			).toBe(true);
			expect(near(await one('jasper.s.solarize', {}, { scene: grey(77) }), [154, 154, 154, 255], 2)).toBe(
				true,
			);
		});

		it('S_StripSlide: Amount 0 = the picture, 1 = the Background (transparent without one)', async () => {
			const start = await render({
				id: 'jasper.s.strip-slide',
				params: { amount: 0 },
				w: W,
				h: H,
				scene: { kind: 'quad' },
				probes: QUAD_PROBES,
			});
			start.probes.forEach((p, i) => {
				expect(near(p, QUAD[i]!, 3)).toBe(true);
			});
			const end = await render({
				id: 'jasper.s.strip-slide',
				params: { amount: 1 },
				w: W,
				h: H,
				scene: { kind: 'quad' },
				probes: QUAD_PROBES,
			});
			for (const p of end.probes) expect(p[3]).toBe(0);
			const bg = await one(
				'jasper.s.strip-slide',
				{ amount: 1, background: { mediaId: 'bg' } },
				{ media: { background: { kind: 'solid', color: '#00f' } } },
			);
			expect(near(bg, [0, 0, 255, 255], 2)).toBe(true);
		});

		it('S_Zebrafy: black stays black, 1/(2·Frequency) luminance turns white', async () => {
			expect(luma(await one('jasper.s.zebrafy', {}, { scene: grey(0) }))).toBeLessThan(3);
			expect(luma(await one('jasper.s.zebrafy', {}, { scene: grey(32) }))).toBeGreaterThan(245);
		});

		it('S_ZFog: depth from the ZBuffer (type/use) or the fallback; exponential density', async () => {
			const fog = { fogColor: [1, 1, 1, 1] };
			const lin = await render({
				id: 'jasper.s.z-fog-linear',
				params: fog,
				w: W,
				h: H,
				scene: grey(0),
				probes: [
					[32, 0],
					[32, 35],
				],
			});
			expect(Math.abs(lin.probes[0]![0] - 201)).toBeLessThan(6); // top = far: Fog Far 0.8
			expect(lin.probes[1]![0]).toBeLessThan(8); // bottom = near: Fog Near 0
			const white = { media: { zBuffer: grey(255) } };
			const z = { ...fog, zBuffer: { mediaId: 'z' } };
			expect(
				near(await one('jasper.s.z-fog-linear', z, { scene: grey(0), ...white }), [0, 0, 0, 255], 2),
			).toBe(true);
			expect(
				near(
					await one(
						'jasper.s.z-fog-linear',
						{ ...z, zBufferType: 'blackIsNear' },
						{ scene: grey(0), ...white },
					),
					[204, 204, 204, 255],
					2,
				),
			).toBe(true);
			const alphaUse = await one(
				'jasper.s.z-fog-linear',
				{ ...z, zBufferUse: 'alpha' },
				{ scene: grey(0), media: { zBuffer: grey(0, 1) } },
			);
			expect(near(alphaUse, [0, 0, 0, 255], 2)).toBe(true); // opaque black = near by alpha
			const exp = await one(
				'jasper.s.z-fog-exponential',
				{ ...fog, depthFallback: 'black' },
				{ scene: grey(0) },
			);
			expect(near(exp, [179, 179, 179, 255], 3)).toBe(true); // far everywhere: 1 − (1 − 0.7)^1
			const dense = await one(
				'jasper.s.z-fog-exponential',
				{ ...fog, depthFallback: 'black', fogDensity: 1 },
				{ scene: grey(0) },
			);
			expect(near(dense, [255, 255, 255, 255], 2)).toBe(true);
		});

		it('the Mask input restricts the effect (and inverts)', async () => {
			const m = { mask: { mediaId: 'm' }, brightness: 1 };
			const black = { scene: grey(204), media: { mask: grey(0) } };
			expect(near(await one('jasper.s.solarize', m, black), [204, 204, 204, 255], 2)).toBe(true);
			expect(
				near(await one('jasper.s.solarize', { ...m, invertMask: true }, black), [51, 51, 51, 255], 2),
			).toBe(true);
			expect(near(await one('jasper.s.solarize', { ...m, show: 'matte' }, black), [0, 0, 0, 255], 2)).toBe(
				true,
			);
		});
	},
);
