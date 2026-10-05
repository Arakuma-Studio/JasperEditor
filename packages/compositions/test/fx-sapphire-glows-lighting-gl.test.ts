// @vitest-environment node
// Sapphire Glows + Lighting family in a real WebGL2 (headless Chrome, SwiftShader): every effect compiles and runs
// with default params on two scenes (opaque night street, transparent logo), plus the characteristic pixel of each
// effect, padding (light drawn outside the layer box), alpha, Show views, and seeded/time determinism.
// FX_GL=0 skips it; needs a Chrome (JASPER_BROWSER_EXECUTABLE or the usual paths). Visual review: ./dump.ts.
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openSglPage, sgl } from './fx-sapphire-glows-lighting/browser.ts';

type Px = [number, number, number, number];
type Pixels = { canvas: number[]; box: number[]; out: Px[]; src: Px[] };
type Opts = {
	scene?: string;
	width?: number;
	height?: number;
	frame?: number;
	depth?: boolean;
	seed?: number;
};

const lum = (p: Px) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
const S = { width: 160, height: 90 };
/** Points of the dot scene (white dot at 70 % / 30 % of the 160 × 90 box). */
const DOT: [number, number] = [112, 27];

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire Glows + Lighting in WebGL2',
	{ timeout: 300_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const pixels = (id: string, params: Record<string, unknown>, opts: Opts, pts: [number, number][]) =>
			sgl<Pixels>(page, 'pixels', id, params, { ...S, ...opts }, pts);
		const checksum = (id: string, params: Record<string, unknown>, opts: Opts = {}) =>
			sgl<number>(page, 'checksum', id, params, { ...S, ...opts });

		beforeAll(async () => {
			({ browser, page } = await openSglPage());
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it('compiles and runs every effect of the family with default params (opaque and transparent input)', async () => {
			const r = await sgl<{ count: number; errors: string[] }>(page, 'allDefaults');
			expect(r.errors).toEqual([]);
			expect(r.count).toBe(25);
		});

		it('light effects add light next to a bright source and leave far black alone', async () => {
			const near: [number, number] = [DOT[0] - 9, DOT[1]];
			const cases: [string, Record<string, unknown>][] = [
				['jasper.s.glow', {}],
				['jasper.s.glow-noise', { noiseAmplitude: 0 }],
				['jasper.s.glow-edges', {}],
				['jasper.s.glow-dist', { glowWidth: 0.3 }],
				['jasper.s.glow-rainbow', {}],
				['jasper.s.ultra-glow', {}],
				['jasper.s.zglow', {}],
				['jasper.s.glint', { threshold: 0.5, sizeRed: 1, sizeBlue: 1 }],
				['jasper.s.glare', { style: 'roundCoin', size: 3 }],
			];
			for (const [id, params] of cases) {
				const r = await pixels(id, params, { scene: 'dot' }, [near, [5, 85]]);
				expect(lum(r.out[0]!), `${id} near the dot`).toBeGreaterThan(lum(r.src[0]!) + 8);
				expect(lum(r.out[1]!), `${id} far corner`).toBeLessThan(6);
			}
		});

		it('S_Glow: Width X stretches the glow horizontally; Show Threshold shows the threshold image', async () => {
			const h = await pixels('jasper.s.glow', { widthY: 0.05 }, { scene: 'dot' }, [
				[DOT[0] - 14, DOT[1]],
				[DOT[0], DOT[1] + 14],
			]);
			expect(lum(h.out[0]!)).toBeGreaterThan(lum(h.out[1]!) + 5);
			const t = await pixels('jasper.s.glow', { show: 'threshold' }, { scene: 'night' }, [[2, 2]]);
			expect(t.out[0]).toEqual([0, 0, 0, 255]);
		});

		it('S_Glow pads the canvas and lights transparent pixels outside the layer box (Expand Borders)', async () => {
			const r = await pixels('jasper.s.glow', { glowWidth: 1, threshold: 0.2 }, { scene: 'logo' }, [
				[-4, 30],
			]);
			expect(r.canvas[0]).toBeGreaterThan(S.width);
			const clipped = await pixels(
				'jasper.s.glow',
				{ glowWidth: 1, threshold: 0.2, expandBorders: false },
				{ scene: 'logo' },
				[[-4, 30]],
			);
			expect(clipped.out[0]![3]).toBe(0);
		});

		it('S_GlowDarks and S_GlowOrthicon darken (around) their sources', async () => {
			const d = await pixels('jasper.s.glow-darks', {}, { scene: 'day' }, [[100, 60]]);
			expect(lum(d.out[0]!)).toBeLessThan(lum(d.src[0]!) - 3);
			const o = await pixels('jasper.s.glow-orthicon', { threshold: 0.5 }, { scene: 'dot', depth: false }, [
				[DOT[0], DOT[1]],
			]);
			expect(lum(o.out[0]!)).toBeGreaterThan(200); // the bright source itself is protected
		});

		it('S_Rays casts light away from Center; S_Streaks smears the brights', async () => {
			// Center at the left: the dot's rays go right (outwards), not left.
			const r = await pixels(
				'jasper.s.rays',
				{ center: [0, 0.3], raysLength: 0.5, shimmerAmp: 0 },
				{ scene: 'dot' },
				[
					[DOT[0] + 20, DOT[1]],
					[DOT[0] - 20, DOT[1]],
				],
			);
			expect(lum(r.out[0]!)).toBeGreaterThan(lum(r.out[1]!) + 5);
			const s = await pixels('jasper.s.streaks', { center: [0, 0.3], toZDist: 0.5 }, { scene: 'dot' }, [
				[DOT[0] + 15, DOT[1]],
			]);
			expect(lum(s.out[0]!)).toBeGreaterThan(5);
		});

		it('S_LensFlare draws its hotspot at the Hotspot point; S_LensFlareAutoTrack finds the bright dot', async () => {
			const f = await pixels('jasper.s.lens-flare', { hotspot: [0.25, 0.5] }, { scene: 'black' }, [
				[40, 45],
				[150, 5],
			]);
			expect(lum(f.out[0]!)).toBeGreaterThan(200);
			const a = await pixels('jasper.s.lens-flare-auto-track', {}, { scene: 'dot' }, [
				[DOT[0] + 6, DOT[1] + 6],
			]);
			const off = await pixels('jasper.s.lens-flare-auto-track', { hotspotThreshold: 1 }, { scene: 'dot' }, [
				[DOT[0] + 6, DOT[1] + 6],
			]);
			expect(lum(a.out[0]!)).toBeGreaterThan(lum(off.out[0]!) + 40);
		});

		it('S_DropShadow draws the shifted shadow outside the layer box, under the layer', async () => {
			const r = await pixels(
				'jasper.s.drop-shadow',
				{ shadowBlur: 0, shift: [0.1, -0.1] },
				{ scene: 'logo' },
				[
					[80 + 16, 70 + 16],
					[80, 70],
				],
			);
			expect(r.out[0]![3]).toBeGreaterThan(150); // shadow (black, opaque) below-right of the orange dot
			expect(lum(r.out[0]!)).toBeLessThan(20);
			expect(r.out[1]).toEqual(r.src[1]); // the layer stays on top
		});

		it('S_SpotLight lights the aim point and leaves the rest at the ambient level', async () => {
			const r = await pixels(
				'jasper.s.spot-light',
				{ aim1: [0.5, 0.5], light1: [0.5, 0.2] },
				{ scene: 'day' },
				[
					[80, 45],
					[2, 88],
				],
			);
			expect(lum(r.out[0]!) / Math.max(1, lum(r.src[0]!))).toBeGreaterThan(0.6);
			expect(lum(r.out[1]!) / Math.max(1, lum(r.src[1]!))).toBeLessThan(0.35);
		});

		it('S_Light3D relights the relief of the image (no Normals clip)', async () => {
			const r = await pixels('jasper.s.light-3d', { hilightBright: 0 }, { scene: 'day' }, [[40, 20]]);
			expect(lum(r.out[0]!)).toBeLessThan(lum(r.src[0]!));
			expect(r.out[0]![3]).toBe(255);
		});

		it('is deterministic; seeds and frames change the random effects', async () => {
			const a = await checksum('jasper.s.bokeh-lights', {}, { scene: 'night' });
			expect(await checksum('jasper.s.bokeh-lights', {}, { scene: 'night' })).toBe(a);
			expect(await checksum('jasper.s.bokeh-lights', {}, { scene: 'night', seed: 0.75 })).not.toBe(a);
			const f3 = await checksum('jasper.s.flashbulbs', { flashes: 8 }, { scene: 'night', frame: 3 });
			expect(await checksum('jasper.s.flashbulbs', { flashes: 8 }, { scene: 'night', frame: 3 })).toBe(f3);
			expect(await checksum('jasper.s.flashbulbs', { flashes: 8 }, { scene: 'night', frame: 4 })).not.toBe(
				f3,
			);
			const l = await checksum('jasper.s.light-leak', {}, { scene: 'night', frame: 0 });
			expect(await checksum('jasper.s.light-leak', {}, { scene: 'night', frame: 40 })).not.toBe(l);
		});
	},
);
