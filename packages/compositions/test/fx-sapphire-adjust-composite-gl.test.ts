// @vitest-environment node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

type Px = [number, number, number, number];
const rgbNear = (a: Px | number[], b: number[], tol = 3) => b.every((v, i) => Math.abs(a[i]! - v) <= tol);
const expectRgb = (a: Px, b: number[], tol = 3) =>
	expect(rgbNear(a, b, tol), `${JSON.stringify(a)} ≈ ${JSON.stringify(b)} ±${tol}`).toBe(true);

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'sapphire-adjust-composite in WebGL2 (headless Chrome)',
	{ timeout: 60_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string): Promise<T> =>
			page.evaluate(
				(n) => (window as unknown as { __sac: Record<string, () => unknown> }).__sac[n]!(),
				name,
			) as Promise<T>;

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'fx-sapphire-adjust-composite-gl', 'entry.ts')));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it('defaults are the identity where Sapphire’s are', async () => {
			const r = await call<Record<string, Px>>('identity');
			for (const [id, p] of Object.entries(r))
				expect(rgbNear(p, [200, 120, 60, 255], 2), `${id}: ${p}`).toBe(true);
		});

		it('adjust effects: one characteristic pixel each', async () => {
			const r = await call<Record<string, Px> & { ocioExpected: number[][] }>('adjust');
			expectRgb(r.invert, [0, 255, 255, 255]);
			expectRgb(r.invertLumaOnly, [127, 127, 127]);
			expectRgb(r.invertRedOnly, [0, 100, 0]);
			expectRgb(r.channel, [200, 0, 255]);
			expectRgb(r.clampChroma, [155, 27, 27]); // chroma halved around unchanged Rec.709 luma
			expectRgb(r.duoBlack, [0, 0, 51]);
			expectRgb(r.duoWhite, [255, 230, 204]);
			expectRgb(r.duoMixed, [0, 0, 0]);
			expectRgb(r.gamma2, [128, 128, 128]);
			expectRgb(r.mono, [77, 77, 77], 2);
			expectRgb(r.hueHalf, [0, 255, 0]);
			expectRgb(r.satZero, [54, 54, 54]);
			expectRgb(r.thresholdHigh, [255, 255, 255]);
			expectRgb(r.thresholdLow, [0, 0, 0]);
			expectRgb(r.hotDark, [0, 0, 0, 255]);
			expectRgb(r.hotBright, [250, 120, 40]);
			expectRgb(r.tint, [255, 128, 0]);
			expectRgb(r.tri, [255, 1, 1]);
			expectRgb(r.quadLow, [0, 0, 255]);
			expectRgb(r.quadPoster, [0, 255, 0]);
			expectRgb(r.badHigh, [255, 0, 0]);
			expectRgb(r.badLow, [0, 0, 255]);
			expectRgb(r.badMatte, [255, 255, 255, 255]);
			// S_OCIOTransform matches the TypeScript reference of the published curves and matrices.
			expectRgb(r.ocioLogToRec709, r.ocioExpected[0]!);
			expectRgb(r.ocioSrgbToLinear, r.ocioExpected[1]!);
			expectRgb(r.ocioSwitched, r.ocioExpected[2]!);
		});

		it('alpha is kept and the Mask block blends effect and source', async () => {
			const r = await call<Record<string, Px> & { softPasses: (string | null)[] }>('alphaAndMask');
			expectRgb(r.half, [0, 255, 255, 128], 3);
			expect(r.clear).toEqual([0, 0, 0, 0]);
			expectRgb(r.invAlpha, [255, 255, 255, 255]);
			expectRgb(r.maskLeft, [0, 255, 255]);
			expectRgb(r.maskRight, [255, 0, 0]);
			expectRgb(r.invMaskLeft, [255, 0, 0]);
			expectRgb(r.invMaskRight, [0, 255, 255]);
			expect(r.softMid[0]).toBeGreaterThan(30);
			expect(r.softMid[0]).toBeLessThan(225);
			expect(r.softPasses).toEqual(['maskRaw', 'maskSoftH', 'maskSoft', null]);
		});

		it('S_Layer: blend modes, opacity, swap, matte, result controls', async () => {
			const r = await call<Record<string, Px> & { fgBlurPasses: number; dissolveRedFraction: number }>(
				'layer',
			);
			expectRgb(r.normal, [255, 0, 0]);
			expectRgb(r.multiply, [128, 64, 0]);
			expectRgb(r.screen, [128, 128, 128]);
			expectRgb(r.subtract, [64, 64, 64]);
			expectRgb(r.opacity, [128, 128, 128]);
			expectRgb(r.swap, [128, 128, 128]);
			expectRgb(r.overTransparent, [128, 128, 128]);
			expectRgb(r.luminance, [255, 255, 255]);
			expectRgb(r.resultSat, [54, 54, 54]);
			expectRgb(r.matteLeft, [255, 0, 0]);
			expectRgb(r.matteRight, [128, 128, 128]);
			expect(r.fgBlurPasses).toBe(4);
			expect(Math.abs(r.dissolveRedFraction - 0.5)).toBeLessThan(0.1); // Dissolve: opacity = probability
		});

		it('S_MathOps: per-channel operations, alpha as a channel unless All Opaque', async () => {
			const r = await call<Record<string, Px>>('mathOps');
			expectRgb(r.add, [255, 150, 255, 255]);
			expect(r.subtract[3]).toBe(0); // 1 − 1 alpha (Sapphire processes alpha as a channel)
			expectRgb(r.subtractOpaque, [100, 50, 0, 255]);
			expectRgb(r.multiply, [78, 20, 78]);
			expectRgb(r.difference, [100, 50, 100]);
			expectRgb(r.minimum, [100, 50, 100]);
			expectRgb(r.maximum, [200, 100, 200]);
			expectRgb(r.average, [150, 75, 150]);
			expectRgb(r.andBits, [64, 32, 64, 255]);
			expect(Math.abs(r.mod[2] - 100)).toBeLessThanOrEqual(2);
			expectRgb(r.swap, [0, 0, 100]);
		});

		it('S_MatteOps: shrink/grow with every filter, invert, outputs, post blur, deterministic noise', async () => {
			const r = await call<{
				identityEdge: number[];
				growOut: Record<string, number[]>;
				shrink: Record<string, number[]>;
				matteOut: Px;
				invert: number;
				postBlurEdge: number;
				noiseA: number[];
				noiseB: number[];
				noiseSeed: number[];
				noiseFrame: number[];
				noiseStatic: number[];
				noiseStatic0: number[];
			}>('matteOps');
			expect(r.identityEdge).toEqual([255, 0]);
			for (const f of ['box', 'triangle', 'gauss']) {
				expect(r.growOut[f]![0], `${f} grown edge`).toBeGreaterThan(240);
				expect(r.growOut[f]![1], `${f} beyond`).toBeLessThan(15);
				expect(r.shrink[f]![0], `${f} shrunk edge`).toBeLessThan(15);
				expect(r.shrink[f]![1], `${f} inside`).toBeGreaterThan(240);
			}
			expectRgb(r.matteOut, [0, 0, 0, 255]);
			expect(r.invert).toBe(255);
			expect(r.postBlurEdge).toBeGreaterThan(30);
			expect(r.postBlurEdge).toBeLessThan(150);
			expect(r.noiseA).toEqual(r.noiseB);
			expect(r.noiseSeed).not.toEqual(r.noiseA);
			expect(r.noiseFrame).not.toEqual(r.noiseA); // Jitter Frames 1: new noise every frame
			expect(r.noiseStatic).toEqual(r.noiseStatic0); // Jitter Frames 0: static
		});

		it('S_MatteOpsComp: the grown matte composites the layer over the Background', async () => {
			const r = await call<Record<string, Px>>('matteOpsComp');
			expectRgb(r.inside, [255, 0, 0, 255]);
			// The grown matte reveals the layer's own (black, transparent) RGB there, as in Sapphire.
			expectRgb(r.grown, [0, 0, 0, 255], 4);
			expectRgb(r.outside, [0, 0, 255, 255]);
		});

		it('S_EdgeFlash: light crosses the edge both ways, composite and outputs', async () => {
			const r = await call<Record<string, Px>>('edgeFlash');
			for (const m of ['original', 'lightWrap']) {
				expect(r[`${m}NearOut`]![0], `${m}: front light on the background`).toBeGreaterThan(
					r.plainNearOut![0] + 15,
				);
				expect(r[`${m}EdgeIn`]![2], `${m}: background light on the front edge`).toBeGreaterThan(
					r[`${m}EdgeIn`]![0] + 10,
				);
				expectRgb(r[`${m}Far`]!, [0, 0, 200], 6);
			}
			expectRgb(r.plainCentre!, [128, 128, 128]);
			expectRgb(r.plainNearOut!, [0, 0, 200]);
			expect(r.fgOnlyOutside![3]).toBe(0);
			expect(r.grownOut![2]).toBeLessThan(60); // the grown matte now covers it
		});

		it('S_ZComp: the nearer picture wins, Invert Z, anti-alias blend, no depth = A over B', async () => {
			const r = await call<Record<string, Px>>('zComp');
			expectRgb(r.aNear, [255, 0, 0]);
			expectRgb(r.bNear, [0, 0, 255]);
			expectRgb(r.inverted, [0, 0, 255]);
			expectRgb(r.blended, [128, 0, 128], 3);
			expectRgb(r.noDepth, [255, 0, 0]);
		});
	},
);
