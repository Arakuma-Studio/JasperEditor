// @vitest-environment node
// three-d: the Classic 3D GL renderer (WebGL2 in headless Chrome, SwiftShader) against the CPU reference of
// @jasper/project on the same pictures: plane intersection and blend modes in depth order, a moved perspective camera,
// an orthographic view, lights (spot cone + falloff, coloured point light, parallel) with ray-cast and coloured
// shadows and specular, Dissolve, and the bokeh depth of field (prefix-sum span gather = the CPU progressive blur).
// Runs when a Chrome is found (JASPER_BROWSER_EXECUTABLE or the usual paths); FX_GL=0 skips it.
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

describe.runIf(!!CHROME && process.env.FX_GL !== '0')('Classic 3D on the GPU = the CPU reference', { timeout: 180_000 }, () => {
	let browser: Browser;
	let page: Page;
	const call = <T>(name: string, arg?: unknown): Promise<T> =>
		page.evaluate(
			([n, a]) => (window as unknown as { __3d: Record<string, (a?: unknown) => unknown> }).__3d[n]!(a),
			[name, arg] as const,
		) as Promise<T>;

	beforeAll(async () => {
		const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
		const esbuild = req('esbuild') as {
			build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
		};
		const out = await esbuild.build({
			entryPoints: [join(here, 'three-d-gl', 'entry.ts')],
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
		page = await browser.newPage({ viewport: { width: 64, height: 64 } });
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.setContent('<!doctype html><html><body></body></html>');
		await page.addScriptTag({ content: out.outputFiles[0]!.text });
		if (errors.length) throw new Error(errors.join('\n'));
	}, 120_000);

	afterAll(async () => {
		await browser?.close();
	});

	it('has WebGL2', async () => {
		expect((await call<{ webgl2: boolean }>('info')).webgl2).toBe(true);
	});

	it.each([
		['flat', 0],
		['intersect', 0.002],
		['orbit', 0.003],
		['ortho', 0.002],
		['lights', 0.003],
		['dissolve', 0],
		['dof', 0.004],
	] as const)('%s', async (name, allowedBad) => {
		const r = await call<{ gl: number[]; cpu: number[]; W: number; H: number }>('render', name);
		let bad = 0;
		let worst = 0;
		let drawn = 0;
		for (let i = 0; i < r.W * r.H; i++) {
			const a = r.cpu[i * 4 + 3]!;
			if (a > 0) drawn++;
			let e = Math.abs(a - r.gl[i * 4 + 3]!);
			// Compared premultiplied (straight bytes of translucent edges amplify the 8-bit storage of the canvas).
			const ga = r.gl[i * 4 + 3]!;
			for (let c = 0; c < 3; c++)
				e = Math.max(e, Math.abs((r.cpu[i * 4 + c]! * a) / 255 - (r.gl[i * 4 + c]! * ga) / 255));
			worst = Math.max(worst, e);
			// Pixels on an edge (a sample exactly on a texel or a plane border) may round to the other side.
			if (e > 3) {
				bad++;
				if (process.env.THREE_D_DEBUG)
					console.log(name, i % r.W, Math.floor(i / r.W), r.cpu.slice(i * 4, i * 4 + 4), r.gl.slice(i * 4, i * 4 + 4));
			}
		}
		expect(drawn, 'the scene draws something').toBeGreaterThan(100);
		expect(bad / (r.W * r.H), `${name}: worst ${worst}`).toBeLessThanOrEqual(allowedBad);
	});
});
