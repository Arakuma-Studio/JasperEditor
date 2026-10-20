// @vitest-environment node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

type Stats = { mean: number; max: number; within: number };

describe.runIf(!!CHROME && process.env.RETIME_GL !== '0')(
	'retime GPU (WebGL2, headless Chrome)',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string, arg?: string): Promise<T> =>
			page.evaluate(
				([n, a]) =>
					(window as unknown as { __retime: Record<string, (a?: string) => unknown> }).__retime[n]!(a),
				[name, arg] as const,
			) as Promise<T>;

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'retime-gl', 'entry.ts')));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it('Frame Sampling and Frame Blending match the CPU exactly (±1 rounding)', async () => {
			const r = await call<{ blend: Stats; sampling: Stats }>('blend');
			expect(r.sampling.max).toBe(0);
			expect(r.blend.max).toBeLessThanOrEqual(1);
		});

		for (const w of [0.25, 0.5, 0.8])
			it(`Optical Flow at w = ${w}: picture matches the CPU reference and moving-scene truth`, async () => {
				const r = await call<{
					gpuVsCpu: Stats;
					gpuVsTruth: Stats;
					cpuVsTruth: Stats;
					mixVsTruth: Stats;
				}>('flow', JSON.stringify({ w }));
				if (process.env.RETIME_GL_LOG) console.info(JSON.stringify({ w, ...r }));
				expect(r.gpuVsCpu.mean).toBeLessThan(0.1);
				expect(r.gpuVsCpu.within).toBeGreaterThan(0.995);
				expect(r.gpuVsTruth.mean).toBeLessThan(r.mixVsTruth.mean * 0.5);
				expect(r.cpuVsTruth.mean).toBeLessThan(r.mixVsTruth.mean * 0.5);
			});
	},
);
