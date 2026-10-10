// @vitest-environment node
// Time Interpolation on the GPU (workstream `time`) in a real WebGL2 (headless Chrome, SwiftShader without a GPU):
// src/retime/flow-gl.ts against the CPU reference used by the native export (@jasper/project time-remap/flow.ts) on
// the same 8-bit frames — the same block vectors, the same pictures within rounding, and both closer to the true
// in-between frame than a frame mix. Runs when a Chrome is found; RETIME_GL=0 skips it.
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

		it('has WebGL2 with float render targets', async () => {
			expect(await call('info')).toEqual({ webgl2: true, floats: true });
		});

		it('Frame Sampling and Frame Blending match the CPU exactly (±1 rounding)', async () => {
			const r = await call<{ blend: Stats; sampling: Stats }>('blend');
			expect(r.sampling.max).toBe(0);
			expect(r.blend.max).toBeLessThanOrEqual(1);
		});

		for (const w of [0.25, 0.5, 0.8])
			it(`Optical Flow at w = ${w}: same vectors and picture as the CPU reference`, async () => {
				const r = await call<{
					gpuVsCpu: Stats;
					gpuVsTruth: Stats;
					cpuVsTruth: Stats;
					mixVsTruth: Stats;
					vecMax: number;
					vecSame: number;
				}>('flow', JSON.stringify({ w }));
				if (process.env.RETIME_GL_LOG) console.info(JSON.stringify({ w, ...r }));
				// Integer search + parabola in float32 vs float64: the same vectors up to rounding.
				// Measured: every vector equal within 4e-6 px, pictures within 1 code value (mean ≤ 0.01).
				expect(r.vecSame).toBeGreaterThan(0.97);
				expect(r.gpuVsCpu.mean).toBeLessThan(0.1);
				expect(r.gpuVsCpu.within).toBeGreaterThan(0.995);
				// Both beat a frame mix against the true in-between frame.
				expect(r.gpuVsTruth.mean).toBeLessThan(r.mixVsTruth.mean * 0.5);
				expect(r.cpuVsTruth.mean).toBeLessThan(r.mixVsTruth.mean * 0.5);
			});
	},
);
