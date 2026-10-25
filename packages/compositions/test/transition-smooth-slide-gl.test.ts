// @vitest-environment node
// Smooth Slide in real WebGL2 (headless Chrome, SwiftShader): whole frames against the CPU reference of
// @jasper/project (`smoothSlidePoses` × `smoothSlideContributions`) for directions, easings, dolly, reflection,
// motion blur, edge smoothing, one-sided spans and Reverse; plus the reflection blur and the ends contract.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	SMOOTH_SLIDE,
	smoothSlideContributions,
	smoothSlidePoses,
	type TransitionSides,
	transitionLinearProgress,
	transitionProgress,
} from '@jasper/project';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openGlPage } from './gl-browser.ts';
import type { RunOpts } from './transition-smooth-slide-gl/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const W = 64;
const H = 36;

const defaults = () => Object.fromEntries(SMOOTH_SLIDE.params.map((p) => [p.name, p.default]));

/** The entry's gradient pictures, bilinearly sampled (texel centres, clamp to edge), premultiplied 0…255. */
function picture(name: 'gradA' | 'gradB', uv: [number, number]): [number, number, number, number] {
	const tx = Math.min(W - 1, Math.max(0, uv[0] * W - 0.5));
	const ty = Math.min(H - 1, Math.max(0, uv[1] * H - 0.5));
	const rx = (255 * tx) / (W - 1);
	const ry = (255 * ty) / (H - 1);
	return name === 'gradA' ? [rx, ry, 40, 255] : [40, ry, rx, 255];
}

/** The CPU reference frame (straight RGBA bytes, as the canvas reads them back) for a run. */
function reference(o: RunOpts): number[] {
	const params = { ...defaults(), ...(o.params ?? {}) };
	const sides: TransitionSides = o.sides ?? 'both';
	const linear = transitionLinearProgress(o.frame, o.duration, sides);
	const { progress, swapped } = transitionProgress(SMOOTH_SLIDE.gpu, params as never, linear);
	const out = sides === 'in' ? null : 'gradA';
	const inn = sides === 'out' ? null : 'gradB';
	const fromPic = swapped ? inn : out;
	const toPic = swapped ? out : inn;
	const poses = smoothSlidePoses(params as never, {
		progress,
		duration: o.duration,
		hasFrom: !!fromPic,
		hasTo: !!toPic,
	});
	const px: number[] = [];
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const acc = [0, 0, 0, 0];
			for (const pose of poses)
				for (const c of smoothSlideContributions([x + 0.5, y + 0.5], pose, params as never, {
					width: W,
					height: H,
				})) {
					const pic = c.side === 'from' ? fromPic : toPic;
					if (!pic) continue;
					const v = picture(pic as 'gradA' | 'gradB', c.uv);
					for (let k = 0; k < 4; k++) acc[k]! += (c.weight * v[k]!) / poses.length;
				}
			const a = Math.min(255, acc[3]!);
			const un = (v: number) => (a > 0 ? Math.min(255, (v * 255) / a) : 0);
			px.push(un(acc[0]!), un(acc[1]!), un(acc[2]!), a);
		}
	return px;
}

/** Share of pixels within tol (alpha everywhere; colour where alpha ≥ 64) and the mean colour error there. */
function compare(got: number[], want: number[], tol = 4) {
	let okCount = 0;
	let err = 0;
	let n = 0;
	for (let i = 0; i < got.length; i += 4) {
		const a = Math.abs(got[i + 3]! - want[i + 3]!);
		let ok = a <= tol;
		if (want[i + 3]! >= 64 && got[i + 3]! >= 64)
			for (let k = 0; k < 3; k++) {
				const e = Math.abs(got[i + k]! - want[i + k]!);
				err += e;
				n++;
				if (e > tol) ok = false;
			}
		if (ok) okCount++;
	}
	return { share: okCount / (got.length / 4), mean: n ? err / n : 0 };
}

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Smooth Slide in WebGL2 (headless Chrome)',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const frame = (o: RunOpts) =>
			page.evaluate(
				(x) => (window as unknown as { __slide: { frame(o: RunOpts): number[] } }).__slide.frame(x),
				o,
			);

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'transition-smooth-slide-gl', 'entry.ts')));
		}, 120_000);
		afterAll(async () => {
			await browser?.close();
		});

		const cases: [string, RunOpts][] = [
			[
				'Left, linear, no blur, hard edges, half-way',
				{
					params: { animation: 'linear', motionBlur: 'off', startPercent: 50, endPercent: 50 },
					frame: 0,
					duration: 10,
				},
			],
			[
				'Down, In Out Cubic, dolly 0.8, High blur, Medium smoothing',
				{
					params: { direction: 'down', animation: 'easeInOutCubic', dolly: 0.8, edgeSmoothing: 'medium' },
					frame: 7,
					duration: 15,
				},
			],
			[
				'Up, Out Expo, dolly 1.2, reflection (sharp, Falloff 0.3, Aspect 1.5), Medium blur at 720°',
				{
					params: {
						direction: 'up',
						animation: 'easeOutExpo',
						dolly: 1.2,
						reflection: true,
						blurriness: 0,
						falloff: 0.3,
						aspect: 1.5,
						motionBlur: 'medium',
						shutterAngle: 720,
					},
					frame: 5,
					duration: 15,
				},
			],
			[
				'Right, one-sided head, dolly 1, reflection (Aspect 0.5), High smoothing',
				{
					params: {
						direction: 'right',
						dolly: 1,
						reflection: true,
						blurriness: 0,
						falloff: 0,
						aspect: 0.5,
						edgeSmoothing: 'high',
					},
					frame: 6,
					duration: 12,
					sides: 'in',
				},
			],
			[
				'Left, one-sided tail, Reverse, dolly 0.5 + reflection, Low blur at 90°',
				{
					params: {
						reverse: true,
						dolly: 0.5,
						reflection: true,
						blurriness: 0,
						motionBlur: 'low',
						shutterAngle: 90,
					},
					frame: 4,
					duration: 12,
					sides: 'out',
				},
			],
		];

		for (const [name, o] of cases)
			it(`matches the CPU reference: ${name}`, async () => {
				const got = await frame(o);
				const r = compare(got, reference(o));
				expect(r.share, `${name}: ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(0.98);
				expect(r.mean).toBeLessThan(1.5);
			});

		it('ends: progress 0 is exactly A and 1 exactly B, even with dolly, reflection and High smoothing', async () => {
			const heavy = { dolly: 1.2, reflection: true, edgeSmoothing: 'high', motionBlur: 'high' };
			for (const direction of ['left', 'right', 'up', 'down']) {
				const a = await frame({
					params: { ...heavy, direction, startPercent: 0, endPercent: 0 },
					frame: 0,
					duration: 10,
				});
				const b = await frame({
					params: { ...heavy, direction, startPercent: 100, endPercent: 100 },
					frame: 0,
					duration: 10,
				});
				const all = (f: number[], pic: 'gradA' | 'gradB') => {
					let worst = 0;
					for (let y = 0; y < H; y++)
						for (let x = 0; x < W; x++) {
							const v = picture(pic, [(x + 0.5) / W, (y + 0.5) / H]);
							for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(f[(y * W + x) * 4 + k]! - v[k]!));
						}
					return worst;
				};
				expect(all(a, 'gradA'), direction).toBeLessThanOrEqual(3);
				expect(all(b, 'gradB'), direction).toBeLessThanOrEqual(3);
			}
		});

		it('motion blur smears the seam; a wider shutter smears more; Off is sharp', async () => {
			const base = { animation: 'linear', from: 'red', to: 'blue' } as const;
			const seamWidth = async (params: Record<string, unknown>) => {
				const f = await frame({
					params: { ...params },
					frame: 7,
					duration: 15,
					from: base.from,
					to: base.to,
				});
				let mixed = 0;
				for (let x = 0; x < W; x++) {
					const o = (18 * W + x) * 4;
					if (f[o]! > 20 && f[o + 2]! > 20) mixed++;
				}
				return mixed;
			};
			const off = await seamWidth({ animation: 'linear', motionBlur: 'off' });
			const mid = await seamWidth({ animation: 'linear', motionBlur: 'high', shutterAngle: 180 });
			const wide = await seamWidth({ animation: 'linear', motionBlur: 'high', shutterAngle: 720 });
			expect(off).toBe(0);
			expect(mid).toBeGreaterThanOrEqual(1);
			expect(wide).toBeGreaterThan(mid);
		});

		it('Blurriness softens only the reflection', async () => {
			const o = (blurriness: number): RunOpts => ({
				params: {
					dolly: 1,
					reflection: true,
					falloff: 0,
					blurriness,
					motionBlur: 'off',
					startPercent: 30,
					endPercent: 30,
				},
				frame: 0,
				duration: 10,
				from: 'stripes',
			});
			const sharp = await frame(o(0));
			const soft = await frame(o(100));
			let reflDiff = 0;
			let pictureDiff = 0;
			const ref = reference(o(0));
			for (let i = 0; i < sharp.length; i += 4) {
				const d = Math.abs(sharp[i]! - soft[i]!) + Math.abs(sharp[i + 1]! - soft[i + 1]!);
				// Reflection pixels: partially transparent (opacity 0.6) in the reference.
				if (ref[i + 3]! > 100 && ref[i + 3]! < 200) reflDiff += d;
				else if (ref[i + 3]! >= 250) pictureDiff += d;
			}
			expect(reflDiff).toBeGreaterThan(50);
			expect(pictureDiff).toBe(0);
		});
	},
);
