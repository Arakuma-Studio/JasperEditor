// @vitest-environment node
// Smooth Slide in real WebGL2: independent pixel witnesses for the documented push, dolly and reflection,
// plus observable motion blur, reflection-only blurring and exact endpoints. No production CPU mirror is an oracle.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openGlPage } from './gl-browser.ts';
import type { RunOpts } from './transition-smooth-slide-gl/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const W = 64;
const H = 36;

/** The entry's gradient pictures, bilinearly sampled (texel centres, clamp to edge), premultiplied 0…255. */
function picture(name: 'gradA' | 'gradB', uv: [number, number]): [number, number, number, number] {
	const tx = Math.min(W - 1, Math.max(0, uv[0] * W - 0.5));
	const ty = Math.min(H - 1, Math.max(0, uv[1] * H - 0.5));
	const rx = (255 * tx) / (W - 1);
	const ry = (255 * ty) / (H - 1);
	return name === 'gradA' ? [rx, ry, 40, 255] : [40, ry, rx, 255];
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

		it('pushes both pictures in the requested direction; missing sides are transparent and Reverse swaps them', async () => {
			const red = [255, 0, 0, 255];
			const blue = [0, 0, 255, 255];
			const clear = [0, 0, 0, 0];
			const at = (f: number[], x: number, y: number) => f.slice((y * W + x) * 4, (y * W + x) * 4 + 4);
			const half = (params: Record<string, unknown>, sides?: RunOpts['sides']) =>
				frame({
					params: { animation: 'linear', motionBlur: 'off', startPercent: 50, endPercent: 50, ...params },
					frame: 0,
					duration: 10,
					from: 'red',
					to: 'blue',
					sides,
				});
			// At half completion each picture fills half the frame. A moves in Direction; B enters opposite it.
			for (const [direction, p, q, expected] of [
				['left', [16, 18], [48, 18], [red, blue]],
				['right', [16, 18], [48, 18], [blue, red]],
				['up', [32, 9], [32, 27], [red, blue]],
				['down', [32, 9], [32, 27], [blue, red]],
			] as const) {
				const f = await half({ direction });
				expect([at(f, p[0], p[1]), at(f, q[0], q[1])], direction).toEqual(expected);
			}
			// High smoothing is a documented 3 px box: at the seam, adjacent pixels mix 2/3:1/3 and 1/3:2/3.
			const smooth = await half({ direction: 'left', edgeSmoothing: 'high' });
			expect([at(smooth, 31, 18), at(smooth, 32, 18)]).toEqual([
				[170, 0, 85, 255],
				[85, 0, 170, 255],
			]);
			for (const [sides, expected] of [
				['in', [clear, blue]],
				['out', [red, clear]],
			] as const) {
				const f = await half({ direction: 'left' }, sides);
				expect([at(f, 16, 18), at(f, 48, 18)], sides).toEqual(expected);
			}
			const reverse = await half({ direction: 'left', reverse: true });
			expect([at(reverse, 16, 18), at(reverse, 48, 18)]).toEqual([blue, red]);
			const quarter = (animation: string) =>
				half({ direction: 'left', animation, startPercent: 25, endPercent: 25 });
			// Penner's In Quad travels 1/16 of the width at t=1/4; Linear travels 1/4. Pixel 54 separates them.
			expect(at(await quarter('linear'), 54, 18)).toEqual(blue);
			expect(at(await quarter('easeInQuad'), 54, 18)).toEqual(red);
		});

		it('dolly pulls the pictures back and Reflection fills the floor below them', async () => {
			const run = (reflection: boolean) =>
				frame({
					params: {
						animation: 'linear',
						motionBlur: 'off',
						startPercent: 50,
						endPercent: 50,
						dolly: 1,
						reflection,
						blurriness: 0,
						falloff: 0,
					},
					frame: 0,
					duration: 10,
					from: 'red',
					to: 'blue',
				});
			const plain = await run(false);
			const reflected = await run(true);
			const at = (f: number[], x: number, y: number) => f.slice((y * W + x) * 4, (y * W + x) * 4 + 4);
			// The documented midpoint scale at Dolly 1 is 1/2: the pictures occupy the middle half-height.
			expect(at(plain, 16, 4)).toEqual([0, 0, 0, 0]);
			expect(at(plain, 16, 18)).toEqual([255, 0, 0, 255]);
			expect(at(plain, 48, 18)).toEqual([0, 0, 255, 255]);
			expect(at(plain, 16, 32)).toEqual([0, 0, 0, 0]);
			// Falloff zero keeps the documented 0.6 reflection opacity, below rather than above the pictures.
			expect(at(reflected, 16, 4)).toEqual([0, 0, 0, 0]);
			expect(at(reflected, 16, 32)).toEqual([255, 0, 0, 153]);
			expect(at(reflected, 48, 32)).toEqual([0, 0, 255, 153]);
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
			let reflectionPixels = 0;
			let picturePixels = 0;
			for (let i = 0; i < sharp.length; i += 4) {
				const d = Math.abs(sharp[i]! - soft[i]!) + Math.abs(sharp[i + 1]! - soft[i + 1]!);
				// With hard edges, no motion blur and zero Falloff, reflections have alpha 0.6 and pictures alpha 1.
				if (sharp[i + 3] === 153) {
					reflDiff += d;
					reflectionPixels++;
				} else if (sharp[i + 3] === 255) {
					pictureDiff += d;
					picturePixels++;
				}
			}
			expect(reflectionPixels).toBeGreaterThan(0);
			expect(picturePixels).toBeGreaterThan(0);
			expect(reflDiff).toBeGreaterThan(50);
			expect(pictureDiff).toBe(0);
		});
	},
);
