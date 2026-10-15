// @vitest-environment node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BezierPath, ellipsePath, polygonPath, type ResolvedMask, rectPath } from '@jasper/project';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

function rm(path: BezierPath, o: Partial<ResolvedMask> = {}): ResolvedMask {
	return {
		id: 'm',
		mode: 'add',
		inverted: false,
		path,
		feather: 0,
		opacity: 100,
		expansion: 0,
		falloff: 'smooth',
		...o,
	};
}

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'GL mask rasteriser (headless Chrome)',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string, arg?: string): Promise<T> =>
			page.evaluate(
				([n, a]) =>
					(window as unknown as { __masks: Record<string, (a?: string) => unknown> }).__masks[n]!(a),
				[name, arg] as const,
			) as Promise<T>;

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'masks-gl', 'entry.ts')));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		const cases: [
			string,
			ResolvedMask[],
			{ w: number; h: number; box: [number, number, number, number]; s: number },
		][] = [
			[
				'hard ellipse',
				[rm(ellipsePath([0.5, 0.5], [0.3, 0.35]))],
				{ w: 160, h: 120, box: [0, 0, 160, 120], s: 1 },
			],
			[
				'feathered, expanded, inverted polygon in a padded canvas',
				[
					rm(
						polygonPath([
							[0.1, 0.1],
							[0.9, 0.2],
							[0.6, 0.9],
							[0.2, 0.7],
						]),
						{ feather: 14, expansion: -3, inverted: true, opacity: 70 },
					),
				],
				{ w: 180, h: 140, box: [10, 12, 160, 116], s: 1 },
			],
			[
				'every mode stacked, linear falloff, half preview scale',
				[
					rm(rectPath(0.1, 0.1, 0.7, 0.8), { feather: 6 }),
					rm(ellipsePath([0.6, 0.5], [0.25, 0.3]), { mode: 'subtract', feather: 20 }),
					rm(ellipsePath([0.3, 0.4], [0.2, 0.2]), { mode: 'lighten', falloff: 'linear', feather: 9 }),
					rm(rectPath(0.2, 0.2, 0.9, 0.9), { mode: 'intersect', expansion: 4 }),
					rm(ellipsePath([0.5, 0.5], [0.1, 0.4]), { mode: 'difference', opacity: 60 }),
					rm(rectPath(0, 0, 1, 0.5), { mode: 'darken', feather: 30 }),
				],
				{ w: 200, h: 150, box: [0, 0, 200, 150], s: 0.5 },
			],
			[
				'variable feather points',
				[
					rm({
						...rectPath(0.25, 0.25, 0.75, 0.75),
						feather: [
							{ segment: 0, t: 0.5, radius: 25, tension: 0 },
							{ segment: 2, t: 0.5, radius: -25, tension: 1 },
						],
					}),
				],
				{ w: 200, h: 200, box: [0, 0, 200, 200], s: 1 },
			],
		];

		for (const [name, masks, c] of cases)
			it(`GL coverage equals the CPU rasteriser: ${name}`, async () => {
				const r = await call<{ gl: number[]; cpu: number[]; ms: number }>(
					'coverage',
					JSON.stringify({
						masks,
						width: c.w,
						height: c.h,
						box: { x: c.box[0], y: c.box[1], w: c.box[2], h: c.box[3] },
						pxScale: c.s,
					}),
				);
				expect(r.gl.length).toBe(r.cpu.length);
				let worst = 0;
				for (let i = 0; i < r.gl.length; i++)
					worst = Math.max(worst, Math.abs(r.gl[i]! - Math.round(r.cpu[i]! * 255)));
				// 8-bit output of the same float maths: at most one code value apart.
				expect(worst).toBeLessThanOrEqual(1);
				expect(r.gl.some((v) => v > 150)).toBe(true);
			});

		it('Opacity masks and a masked effect inside the effect chain', async () => {
			// Mask: the right-hand 60 % of the frame (hard edge at x = 40).
			const job = {
				masks: [rm(rectPath(0.4, -1, 2, 2))],
				width: 100,
				height: 40,
				box: { x: 0, y: 0, w: 100, h: 40 },
				pxScale: 1,
			};
			const r = await call<{ applied: number[]; masked: number[] }>('chain', JSON.stringify(job));
			const at = (a: number[], x: number, y: number) => a.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4);
			// Opacity mask: transparent left of the edge, the picture right of it.
			expect(at(r.applied, 10, 20)[3]).toBe(0);
			expect(at(r.applied, 45, 20)).toEqual([255, 0, 0, 255]);
			expect(at(r.applied, 80, 20)).toEqual([0, 0, 255, 255]);
			// Masked invert: original left of the edge, inverted inside the mask.
			expect(at(r.masked, 10, 20)).toEqual([255, 0, 0, 255]);
			expect(at(r.masked, 45, 20)).toEqual([0, 255, 255, 255]);
			expect(at(r.masked, 80, 20)).toEqual([255, 255, 0, 255]);
		});
	},
);
