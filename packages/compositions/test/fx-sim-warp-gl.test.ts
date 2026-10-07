// @vitest-environment node
// The simulation-warp family in real WebGL2 (headless Chrome, SwiftShader without a GPU): every effect compiles and
// runs at several frames, characteristic pixels per effect, determinism (same frame → same pixels), seed stability
// (another seed → another pattern) and motion. FX_GL=0 skips.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPsdgPage, type PsdgPage, psdgGlEnabled } from './fx-psdg/gl-suite.ts';

const here = dirname(fileURLToPath(import.meta.url));
/** SIM_GALLERY=<dir> (and optionally SIM_GALLERY_IDS=a,b): writes a PNG per effect setting for a visual check. */
const GALLERY = process.env.SIM_GALLERY;
const GALLERY_CASES: { name: string; id: string; over?: Record<string, unknown>; frame?: number; bg?: string }[] = [
	{ name: 'particle-world', id: 'jasper.particle-world', over: { birthRate: 2, animation: 'fire', particleType: 'fadedSphere' }, frame: 60, bg: '#000' },
	{ name: 'particle-world-cubes', id: 'jasper.particle-world', over: { birthRate: 1, particleType: 'cube', birthSize: 0.4, deathSize: 0.3, showGrid: true, floorAction: 'bounce', floorPosition: 0.3, gravity: 1.5 }, frame: 60, bg: '#000' },
	{ name: 'particle-systems', id: 'jasper.particle-systems', over: { particleType: 'star' }, frame: 40, bg: '#000' },
	{ name: 'mercury', id: 'jasper.mercury', over: { birthRate: 3 }, frame: 60 },
	{ name: 'rainfall', id: 'jasper.rainfall', frame: 20 },
	{ name: 'snowfall', id: 'jasper.snowfall', bg: '#203040' },
	{ name: 'bubbles', id: 'jasper.bubbles', over: { bubbleAmount: 60, bubbleSize: 2 } },
	{ name: 'drizzle', id: 'jasper.drizzle', over: { dripRate: 20, rippleHeight: 80 } },
	{ name: 'star-burst', id: 'jasper.star-burst', over: { gridSpacing: 6 } },
];

describe.runIf(psdgGlEnabled)('simulation-warp effects (WebGL2)', { timeout: 300_000 }, () => {
	let page: PsdgPage;
	beforeAll(async () => {
		page = await openPsdgPage(join(here, 'fx-sim-warp', 'entry.ts'));
	}, 300_000);
	afterAll(() => page?.close());

	it.runIf(!!GALLERY)('gallery (SIM_GALLERY)', { timeout: 600_000 }, async () => {
		mkdirSync(GALLERY!, { recursive: true });
		const only = process.env.SIM_GALLERY_IDS?.split(',');
		for (const c of GALLERY_CASES) {
			if (only && !only.includes(c.name)) continue;
			const r = await page.call<{ url: string; ms: number }>('png', c);
			writeFileSync(join(GALLERY!, `${c.name}.png`), Buffer.from(r.url.split(',')[1]!, 'base64'));
		}
	});

	it('compiles and runs every effect of the family', { timeout: 600_000 }, async () => {
		const r = await page.call<{ count: number; errors: string[] }>('catalogue');
		expect(r.errors).toEqual([]);
		expect(r.count).toBeGreaterThanOrEqual(5);
	});

	it('weather: rain, snow, bubbles, drizzle, star burst', async () => {
		const w = await page.call<Record<string, any>>('weather');
		expect(w.rainVisible).toBeGreaterThan(20);
		expect(w.noRain).toBe(0);
		expect(w.rainOnlyAlpha).toBeLessThan(80); // without the original: drops over transparency
		expect(w.snowVisible).toBeGreaterThan(20);
		expect(w.bubblesAlpha).toBeGreaterThan(1);
		expect(w.noBubblesAlpha).toBe(0); // bubbles replace the layer
		expect(w.bubbleY[1]).toBeLessThan(w.bubbleY[0]); // bubbles rise
		expect(w.drizzle).toBeGreaterThan(1);
		expect(w.noDrizzle).toBe(0);
		expect(w.starAlpha).toBeGreaterThan(1);
		expect(w.starMoves).toBeGreaterThan(10);
		expect(w.starFull).toBeLessThanOrEqual(1);
	});

	it('particles: types, seek = play, gravity, floor, guides, 2D direction, mercury', async () => {
		const r = await page.call<Record<string, any>>('particles');
		expect(r.typeErrors).toEqual([]);
		expect(r.seek).toBe(0); // frame 60 directly equals 30 → 45 → 60 (checkpoint resume)
		expect(r.startAlpha).toBeLessThan(0.01); // nothing born at frame 0 (black matte only)
		expect(r.gravityY[1]).toBeGreaterThan(r.gravityY[0] + 2);
		expect(r.floorY).toBeGreaterThan(0);
		expect(r.floorY).toBeLessThan(64 / 2 + 96 * 0.1 * 1.3 + 2); // glued on the floor plane, not below
		expect(r.gridAlpha).toBeGreaterThan(1);
		expect(r.psUp).toBeLessThan(32); // 0° = up
		expect(r.psRight).toBeGreaterThan(48); // 90° = right
		expect(r.mercuryAlpha).toBeGreaterThan(1);
		expect(r.noMercuryAlpha).toBe(0);
	});

	for (const id of ['jasper.particle-world', 'jasper.particle-systems', 'jasper.mercury', 'jasper.rainfall', 'jasper.snowfall', 'jasper.bubbles', 'jasper.drizzle', 'jasper.star-burst'])
		it(`${id}: deterministic, seeded, animated`, async () => {
			const r = await page.call<{ same: number; seed: number; moves: number }>('determinism', { id });
			expect(r.same).toBe(0);
			expect(r.seed).toBeGreaterThan(1);
			expect(r.moves).toBeGreaterThan(1);
		});
});
