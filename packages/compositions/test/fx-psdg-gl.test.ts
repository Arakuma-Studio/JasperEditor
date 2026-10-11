// @vitest-environment node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPsdgPage, type PsdgPage, psdgGlEnabled } from './fx-psdg/gl-suite.ts';

type Px = [number, number, number, number];
const here = dirname(fileURLToPath(import.meta.url));
const near = (a: Px, b: Px, tol = 6) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe.runIf(psdgGlEnabled)(
	'Premiere stylize/distort/generate effects (WebGL2)',
	{ timeout: 300_000 },
	() => {
		let page: PsdgPage;
		beforeAll(async () => {
			page = await openPsdgPage(join(here, 'fx-psdg', 'family.entry.ts'));
		}, 300_000);
		afterAll(() => page?.close());

		it('neutral defaults leave the picture untouched', async () => {
			const r = await page.call<Record<string, number>>('identities');
			for (const [id, diff] of Object.entries(r)) expect(diff, id).toBeLessThanOrEqual(2);
		});

		it('Distort', async () => {
			const d = await page.call<Record<string, any>>('distort');
			expect(near(d.mirrorRight, [255, 0, 0, 255])).toBe(true); // 0°: the right side mirrors the left
			expect(near(d.mirrorLeft, [255, 0, 0, 255])).toBe(true);
			expect(near(d.offsetLeft, [0, 0, 255, 255])).toBe(true); // shifted by half a layer, wrapping
			expect(d.ldCorner[3]).toBe(0); // barrel: no source in the corners
			expect(near(d.ldFillCorner, [0, 255, 0, 255])).toBe(true); // … unless Fill Alpha
			expect(near(d.magLeft, [255, 0, 0, 255])).toBe(true); // 400 %: the centre seam stays at the centre
			expect(near(d.magRight, [0, 0, 255, 255])).toBe(true);
			expect(d.sphere).toBeGreaterThan(20);
			expect(d.twirl).toBeGreaterThan(40);
			expect(d.waveCanvas).toEqual([64 + 22, 36 + 22]); // padded by the wave height (10 + 1)
			expect(d.waveMoves).toBeGreaterThan(20); // waves travel over time
			expect(d.turb).toBeGreaterThan(20);
			expect(d.turbDet).toBe(0);
			expect(d.turbSeed).toBeGreaterThan(10);
		});

		it('Generate', async () => {
			const g = await page.call<Record<string, any>>('generate');
			expect(g.g4TopLeft[0]).toBeGreaterThan(200); // yellow corner
			expect(g.g4TopLeft[2]).toBeLessThan(80);
			expect(g.g4BottomRight[2]).toBeGreaterThan(200); // blue corner
			expect(near(g.circleIn, [255, 255, 255, 255])).toBe(true);
			expect(g.circleOut[3]).toBe(0); // Blending Mode None: only the circle
			expect(near(g.stencilIn, [0, 0, 255, 255])).toBe(true); // Stencil Alpha keeps the layer inside
			expect(g.stencilOut[3]).toBe(0);
			expect(g.checkerA[3] + g.checkerB[3]).toBeGreaterThan(240); // alternating squares
			expect(Math.abs(g.checkerA[3] - g.checkerB[3])).toBeGreaterThan(240);
			expect(g.gridLine[3]).toBeGreaterThan(200);
			expect(g.gridCell[3]).toBe(0);
			expect(g.rampTop[0]).toBeLessThan(10);
			expect(g.rampBottom[0]).toBeGreaterThan(245);
			expect(near(g.eyeRight, [255, 0, 0, 255])).toBe(true); // the whole layer takes the sampled red
			expect(g.cellSeed).toBeGreaterThan(30);
			expect(g.cellMean[3]).toBe(255);
			expect(g.ellipseRing[3]).toBeGreaterThan(200);
			expect(g.ellipseCentre[3]).toBe(0);
			expect(g.flareCanvas[0]).toBeGreaterThan(64);
			expect(g.flareCentre[0]).toBeGreaterThan(240);
			expect(g.boltOn[3]).toBeGreaterThan(200);
			expect(g.boltOff[0]).toBeLessThan(40);
			expect(g.boltDet).toBe(0);
			expect(g.boltAnim).toBeGreaterThan(30);
			expect(near(g.bucketLeft, [255, 0, 0, 255])).toBe(true);
			expect(near(g.bucketRight, [255, 255, 255, 255])).toBe(true); // same colour, other room: untouched
			expect(near(g.writeCentre, [255, 0, 0, 255])).toBe(true);
			expect(near(g.writeEdge, [0, 0, 0, 255])).toBe(true);
		});

		it('Noise & Grain', async () => {
			const n = await page.call<Record<string, any>>('noise');
			expect(n.dustSpeck[0]).toBeLessThan(140);
			expect(n.medianSpeck[0]).toBeLessThan(140);
			expect(n.noiseAnim).toBeGreaterThan(30);
			expect(Math.abs(n.noiseMean[0] - 128)).toBeLessThan(10);
			expect(n.noiseAlpha).toBeLessThan(250);
			expect(n.noiseAlphaVar).toBeGreaterThan(30);
			expect(n.hls).toBeGreaterThan(20);
			expect(n.hlsAuto).toBeGreaterThan(10);
		});

		it('Stylize', async () => {
			const s = await page.call<Record<string, any>>('stylize');
			expect(s.glowOutside[3]).toBeGreaterThan(40); // glow around the shape's alpha edge
			expect(s.glowFar[3]).toBe(0);
			expect(near(s.glowInside, [200, 120, 60, 255])).toBe(true);
			expect(s.glowCanvas[0]).toBeGreaterThan(64);
			expect(s.brushDiff).toBeGreaterThan(20);
			for (let k = 0; k < 3; k++) expect(Math.abs(s.brushMean[k] - s.pictureMean[k])).toBeLessThan(25);
			expect(near(s.emboss, [128, 128, 128, 255], 2)).toBe(true); // flat areas are mid grey
			expect(near(s.colorEmboss, [90, 160, 30, 255], 2)).toBe(true);
			expect(near(s.findEdgesFlat, [255, 255, 255, 255], 2)).toBe(true);
			expect(s.findEdgesEdge[0] + s.findEdgesEdge[2]).toBeLessThan(400);
			expect(near(s.mosaicA, s.mosaicB, 1)).toBe(true);
			expect(near(s.mosaicA, s.mosaicC, 1)).toBe(false);
			expect(near(s.posterize, [255, 0, 255, 255], 1)).toBe(true);
			// Replicate 2: each half of the layer holds a full copy (red | blue twice).
			expect(near(s.replicate[0], [255, 0, 0, 255])).toBe(true);
			expect(near(s.replicate[1], [0, 0, 255, 255])).toBe(true);
			expect(near(s.replicate[2], [255, 0, 0, 255])).toBe(true);
			expect(near(s.replicate[3], [0, 0, 255, 255])).toBe(true);
			expect(near(s.roughCentre, [200, 120, 60, 255])).toBe(true);
			expect(s.roughEdgeAlpha).toBeLessThan(250);
			expect(near(s.solarize, [55, 60, 115, 255], 2)).toBe(true);
			expect(near(s.strobe, [255, 255, 255, 255], 1)).toBe(true); // frame 0: the strobe fires
			expect(s.strobeTransparent[3]).toBe(0);
			expect(s.texturize[0][0]).not.toBe(s.texturize[1][0]); // relief at the texture's edge
			expect(near(s.texturize[2], [128, 128, 128, 255], 2)).toBe(true); // flat texture: unchanged
			expect(near(s.threshold[0], [0, 0, 0, 255], 1)).toBe(true); // red luma 54 < 128
			expect(near(s.threshold[1], [0, 0, 0, 255], 1)).toBe(true);
		});

		it('Transition bin', async () => {
			const t = await page.call<Record<string, any>>('transitions');
			for (const a of t.done) expect(a).toBe(0); // 100 % = fully transparent
			expect(t.blockHalf).toBeGreaterThan(90);
			expect(t.blockHalf).toBeLessThan(165);
			expect(t.linearLeft).toBe(0); // 90°: wipes from the left
			expect(t.linearRight).toBe(255);
			expect(t.radialUpperRight).toBe(0); // clockwise from 12 o'clock
			expect(t.radialUpperLeft).toBe(255);
			expect(t.blinds).toBeGreaterThan(100);
			expect(t.blinds).toBeLessThan(155);
			// Own luminance at 15 %: blue (luma 0.07) is gone, red (0.21) remains — dark areas go first.
			expect(t.gradientRed).toBe(255);
			expect(t.gradientBlue).toBe(0);
		});

		it('Time: Echo combines the current frame with earlier frames', async () => {
			const e = await page.call<Record<string, Px>>('time');
			expect(e.current[1]).toBeGreaterThan(190);
			expect(e.echo1[1]).toBeGreaterThan(190); // frame −1 (bar 10 px to the left)
			expect(e.echo2[1]).toBeGreaterThan(190); // frame −2
			expect(e.nothing[1]).toBeLessThan(10);
			expect(near(e.composite, [255, 0, 0, 255])).toBe(true);
		});

		it('Video: text burn-ins', async () => {
			const v = await page.call<Record<string, any>>('video');
			expect(v.timecodeChanges).toBeGreaterThan(100);
			expect(v.timecodeAbove).toEqual([128, 128, 128, 255]);
			expect(v.textWhitePixels).toBeGreaterThan(40);
			expect(v.textCorner).toEqual([0, 0, 0, 255]);
			expect(v.clipName).toBeGreaterThan(100);
		});
	},
);
