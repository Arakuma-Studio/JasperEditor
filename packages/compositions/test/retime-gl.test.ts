// @vitest-environment node
// Time Interpolation on the GPU (workstream `time`) in a real WebGL2 (headless Chrome, SwiftShader without a GPU):
// src/retime/flow-gl.ts against the CPU reference used by the native export (@jasper/project time-remap/flow.ts) on
// the same 8-bit frames — the same block vectors, the same pictures within rounding, and both closer to the true
// in-between frame than a frame mix. Runs when a Chrome is found; RETIME_GL=0 skips it.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

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
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'retime-gl', 'entry.ts')],
				bundle: true,
				write: false,
				format: 'iife',
				platform: 'browser',
				target: 'es2022',
				define: { 'process.env.NODE_ENV': '"production"' },
				logLevel: 'silent',
			});
			browser = await chromium.launch({
				executablePath: CHROME,
				args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
			});
			page = await browser.newPage();
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(e.message));
			await page.setContent('<!doctype html><html><body></body></html>');
			await page.addScriptTag({ content: out.outputFiles[0]!.text });
			if (errors.length) throw new Error(errors.join('\n'));
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
