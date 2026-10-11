// @vitest-environment node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPsdgPage, type PsdgPage, psdgGlEnabled } from './fx-psdg/gl-suite.ts';

type Px = [number, number, number, number];
const here = dirname(fileURLToPath(import.meta.url));

describe.runIf(psdgGlEnabled)('Premiere Vignette / Glow (WebGL2)', { timeout: 60_000 }, () => {
	let page: PsdgPage;
	beforeAll(async () => {
		page = await openPsdgPage(join(here, 'fx-psdg', 'light.entry.ts'));
	}, 120_000);
	afterAll(() => page?.close());

	it('vignette: identity at Amount 0, darkens or lightens the corners only', async () => {
		const id = await page.call<{ centre: Px; corner: Px }>('vignette', 0);
		expect(id.corner).toEqual([128, 128, 128, 255]);
		const dark = await page.call<{ centre: Px; corner: Px }>('vignette', -5);
		expect(Math.abs(dark.centre[0] - 128)).toBeLessThan(4);
		expect(dark.corner[0]).toBeLessThan(40);
		const light = await page.call<{ centre: Px; corner: Px }>('vignette', 5);
		expect(light.corner[0]).toBeGreaterThan(215);
		expect(light.corner[3]).toBe(255);
	});

	it('vignette keeps alpha (transparent stays transparent)', async () => {
		const a = await page.call<{ left: Px; right: Px }>('vignetteAlpha');
		expect(a.left[3]).toBeGreaterThan(120);
		expect(a.left[3]).toBeLessThan(136);
		expect(a.right).toEqual([0, 0, 0, 0]);
	});

	it('glow: light around bright areas, spilling into the padding', async () => {
		const g = await page.call<{ canvas: number[]; core: Px; near: Px; darkCorner: Px; outside: Px }>('glow', {
			radius: 8,
			threshold: 50,
			intensity: 2,
		});
		expect(g.canvas).toEqual([64 + 40, 36 + 40]); // 2.5 × radius each side
		expect(g.core[0]).toBeGreaterThan(250);
		expect(g.near[0]).toBeGreaterThan(20); // light next to the square (black there before)
		expect(g.darkCorner[0]).toBeLessThan(10);
		const off = await page.call<{ near: Px }>('glow', { radius: 8, threshold: 100, intensity: 2 });
		expect(off.near[0]).toBeLessThan(6); // nothing above the threshold
	});
});
