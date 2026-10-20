// @vitest-environment node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPsdgPage, type PsdgPage, psdgGlEnabled } from './fx-psdg/gl-suite.ts';
import type { SimulationApi } from './fx-sim-warp/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
describe.runIf(psdgGlEnabled)('simulation-warp effects (WebGL2)', { timeout: 300_000 }, () => {
	let page: PsdgPage;
	beforeAll(async () => {
		page = await openPsdgPage(join(here, 'fx-sim-warp', 'entry.ts'));
	}, 300_000);
	afterAll(() => page?.close());

	it('preserves premultiplied alpha across simulation effects', { timeout: 600_000 }, async () => {
		const r = await page.call<{ errors: string[] }>('catalogue');
		if (r.errors.length) console.error(r.errors.join('\n'));
		expect(r.errors).toEqual([]);
	});

	it('weather: rain, snow, bubbles, drizzle, star burst', async () => {
		const w = await page.call<ReturnType<SimulationApi['weather']>>('weather');
		expect(w.rainVisible).toBeGreaterThan(20);
		expect(w.noRain).toBe(0);
		expect(w.rainOnlyAlpha).toBeLessThan(80); // without the original: drops over transparency
		expect(w.snowVisible).toBeGreaterThan(20);
		expect(w.bubblesAlpha).toBeGreaterThan(1);
		expect(w.noBubblesAlpha).toBe(0);
		expect(w.bubbleY[1]).toBeLessThan(w.bubbleY[0]);
		expect(w.drizzle).toBeGreaterThan(1);
		expect(w.noDrizzle).toBe(0);
		expect(w.starAlpha).toBeGreaterThan(1);
		expect(w.starMoves).toBeGreaterThan(10);
		expect(w.starFull).toBeLessThanOrEqual(1);
	});

	it('particles: types, seek = play, gravity, floor, guides, 2D direction, mercury', async () => {
		const r = await page.call<ReturnType<SimulationApi['particles']>>('particles');
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

	it('cards: Card Dance, Card Wipe, Pixel Polly', async () => {
		const r = await page.call<ReturnType<SimulationApi['cards']>>('cards');
		expect(r.cdRest).toBeLessThanOrEqual(3);
		expect(r.cdRot).toBeGreaterThan(50);
		expect(r.cdZ).toBeGreaterThan(50); // cards pulled towards the camera grow
		expect(r.cwRest).toBeLessThanOrEqual(3);
		expect(r.cwLeft).toBe(0); // left to right: the left cards have turned (no back layer: gone)
		expect(r.cwRight).toBe(255);
		expect(r.cwDone).toBe(0);
		expect(r.ppBefore).toBe(0); // before Start Time: the layer as is
		expect(r.ppAfter).toBeGreaterThan(50);
		expect(r.ppTex).toBeGreaterThan(1);
	});

	it('shatter: intact at rest for every pattern, breaks, render modes, wireframes', async () => {
		const r = await page.call<ReturnType<SimulationApi['shatter']>>('shatter');
		expect(r.rest).toBeLessThanOrEqual(3);
		for (const d of r.patterns) expect(d).toBeLessThanOrEqual(8);
		expect(r.moved).toBeGreaterThan(50);
		expect(r.wireMax).toBeGreaterThan(1);
		expect(r.wireHasGaps).toBe(1);
		expect(r.layerCentre).toBe(0); // the broken centre is removed (Render: Layer)
		expect(r.layerCorner).toBe(255);
		expect(r.piecesCorner).toBe(0); // Render: Pieces drops the unbroken layer
		expect(r.forcesRed).toBeGreaterThan(0.1);
	});

	it('pixel effects: Ball Action, Scatterize, Hair', async () => {
		const r = await page.call<ReturnType<SimulationApi['pixelFx']>>('pixelFx');
		expect(r.ballsAlpha).toBeGreaterThan(50);
		expect(r.noBalls).toBe(0);
		expect(r.scatter).toBeGreaterThan(10);
		expect(r.szIdentity).toBe(0);
		expect(r.sz).toBeGreaterThan(10);
		expect(r.tw).toBeGreaterThan(10);
		expect(r.hair).toBeGreaterThan(10);
		expect(r.noHair).toBe(0);
		expect(r.weight).toBeGreaterThan(10);
	});

	it('surfaces: Foam, Wave World, Caustics', async () => {
		const r = await page.call<ReturnType<SimulationApi['surfaces']>>('surfaces');
		expect(r.foamAlpha).toBeGreaterThan(0.5);
		expect(r.foamSeek).toBe(0);
		expect(r.foamRendered).toBeGreaterThan(1);
		expect(r.foam0).toBe(0);
		expect(r.flatSpread).toBeLessThan(1); // flat water: mid grey (Brightness 0.5)
		expect(r.wavesVary).toBeGreaterThan(5);
		expect(r.wireGreen).toBeGreaterThan(0.5);
		expect(r.dryRight).toBe(0); // dry ground rendered transparent
		expect(r.wetLeft).toBe(255);
		expect(r.wwSeek).toBe(0);
		expect(r.causticsIdentity).toBeLessThanOrEqual(3);
		expect(r.causticsWavy).toBeGreaterThan(20);
	});

	it('Particle Playground: cannon seek, gravity, wall, repel, text, layer exploder', async () => {
		const r = await page.call<ReturnType<SimulationApi['playground']>>('playground');
		expect(r.cannonAlpha).toBeGreaterThan(0.2);
		expect(r.cannonSeek).toBe(0);
		expect(r.cannonZero).toBe(0);
		expect(Math.abs(r.gridY0 - 10)).toBeLessThan(1.5);
		// ½ g t² = ½ · 100 · 0.25² ≈ 3.1 px later (half a second: 12.5 px).
		expect(r.gridY1).toBeGreaterThan(r.gridY0 + 2);
		expect(r.wallY).toBeLessThan(17); // the wall (mask 1, floor at y = 15) holds them
		expect(r.spread[1]).toBeGreaterThan(r.spread[0] + 4);
		expect(r.textAlpha).toBeGreaterThan(1);
		expect(Math.abs(r.explodeColour[1] - r.sourceColour[1])).toBeLessThan(40); // exploded particles carry the layer's colours
	});

	it('distort: Displacement Map, Optics Compensation, Polar, Bezier Warp, Reshape, Smear', async () => {
		const r = await page.call<ReturnType<SimulationApi['distort']>>('distort');
		for (const [k, v] of Object.entries(r.identities)) expect(v, k).toBeLessThanOrEqual(2);
		expect(r.optics).toBeGreaterThan(20);
		expect(r.polar).toBeGreaterThan(20);
		// Red map = +1 horizontally: each pixel shows the one 10 px to its right.
		for (let k = 0; k < 4; k++) expect(Math.abs(r.dmShift[0][k] - r.dmShift[1][k])).toBeLessThanOrEqual(3);
		expect(r.reshape).toBeGreaterThan(20);
		expect(r.reshapeOutside).toBe(0); // outside the boundary mask: untouched
		expect(r.smear).toBeGreaterThan(5);
		expect(r.bezier).toBeGreaterThan(20);
		expect(r.bezierCorner).toBe(0); // the corner moved in: transparent
	});

	it('warps: Mesh Warp, Liquify, Puppet', async () => {
		const r = await page.call<ReturnType<SimulationApi['warps']>>('warps');
		expect(r.mwRest).toBeLessThanOrEqual(3);
		expect(r.mwEmpty).toBeLessThanOrEqual(3);
		expect(r.mw).toBeGreaterThan(20);
		expect(r.lq0).toBe(0);
		expect(r.lq).toBeGreaterThan(5);
		expect(r.lqHalf).toBeLessThan(r.lq);
		expect(r.lqView).toBeGreaterThan(5);
		expect(r.pp0).toBeLessThanOrEqual(6); // pins at rest: the layer as is
		expect(r.pp).toBeGreaterThan(50);
		expect(r.ppNone).toBe(0);
	});

	const DETERMINISM: {
		id: string;
		over?: Record<string, unknown>;
		seeded?: boolean;
		animated?: boolean;
		frame?: number;
	}[] = [
		{
			id: 'jasper.card-dance',
			over: { yRotationSource: 'intensity1', yRotationMultiplier: 90 },
			seeded: false,
			animated: false,
		},
		{
			id: 'jasper.card-wipe',
			over: { transitionCompletion: 50, timingRandomness: 0.6, xRotJitterAmount: 30 },
		},
		{ id: 'jasper.pixel-polly' },
		{ id: 'jasper.particle-playground', frame: 30 },
		{ id: 'jasper.foam', over: { productionRate: 3 }, frame: 30 },
		{ id: 'jasper.wave-world', over: { gridResolution: 20, view: 'heightMap' }, seeded: false },
		{ id: 'jasper.caustics', seeded: false, animated: false },
		{ id: 'jasper.ball-action', over: { scatter: 20, instabilityState: 30 }, animated: false },
		{ id: 'jasper.scatterize', over: { scatter: 10 }, animated: false },
		{ id: 'jasper.hair', animated: false },
		{ id: 'jasper.shatter', over: { view: 'rendered', randomness: 0.5 } },
		{ id: 'jasper.particle-world' },
		{ id: 'jasper.particle-systems' },
		{ id: 'jasper.mercury' },
		{ id: 'jasper.rainfall' },
		{ id: 'jasper.snowfall' },
		{ id: 'jasper.bubbles' },
		{ id: 'jasper.drizzle' },
		{ id: 'jasper.star-burst' },
	];
	for (const c of DETERMINISM)
		it(`${c.id}: deterministic${c.seeded === false ? '' : ', seeded'}${c.animated === false ? '' : ', animated'}`, async () => {
			const r = await page.call<{ same: number; seed: number; moves: number }>('determinism', c);
			expect(r.same).toBe(0);
			if (c.seeded !== false) expect(r.seed).toBeGreaterThan(1);
			if (c.animated !== false) expect(r.moves).toBeGreaterThan(1);
		});
});
