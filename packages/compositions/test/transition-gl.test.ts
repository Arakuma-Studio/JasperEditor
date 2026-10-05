// @vitest-environment node
// GPU transitions on the fx GPU host in a real WebGL2 (wave-2 transition framework): headless Chrome (Playwright,
// SwiftShader when there is no GPU) runs the stage planning + host (test/transition-gl/entry.ts, bundled with
// esbuild). Compiles the whole transition GLSL library and EVERY registered GPU transition (wave-3 families get this
// check for free): two-sided, one-sided (in / out) and reversed; at progress 0 the stage shows A and at 1 B (the
// contract every transition keeps); placement of scaled / moved / half-transparent sides; a transition that reads
// both sides (S_DissolveLuma). Runs when a Chrome is found (JASPER_BROWSER_EXECUTABLE or the usual paths); FX_GL=0
// skips it.
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

type Px = [number, number, number, number];
const near = (a: Px, b: Px, tol = 4) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'GPU transitions in WebGL2 (headless Chrome)',
	{ timeout: 60_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string): Promise<T> =>
			page.evaluate(
				(n) => (window as unknown as { __tr: Record<string, () => unknown> }).__tr[n]!(),
				name,
			) as Promise<T>;

		beforeAll(async () => {
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'transition-gl', 'entry.ts')],
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

		it('has WebGL2 and compiles the whole transition GLSL library', async () => {
			expect((await call<{ webgl2: boolean }>('info')).webgl2).toBe(true);
			expect(await call<{ ok: boolean; error?: string }>('library')).toEqual({ ok: true });
		});

		it('compiles and runs every registered GPU transition (two-sided, one-sided, reversed)', async () => {
			const r = await call<{ count: number; errors: string[] }>('catalogue');
			expect(r.errors).toEqual([]);
			expect(r.count).toBeGreaterThanOrEqual(4);
		});

		it('shows A at progress 0 and B at progress 1', async () => {
			const r = await call<Record<string, { first: Px; last: Px }>>('ends');
			const bad = Object.entries(r)
				.filter(([, v]) => !near(v.first, [255, 0, 0, 255], 6) || !near(v.last, [0, 0, 255, 255], 6))
				.map(([id, v]) => `${id}: ${v.first.join(',')} → ${v.last.join(',')}`);
			expect(bad).toEqual([]);
		});

		it('places the side pictures through their matrices and opacity', async () => {
			const r = await call<{ left: Px; right: Px; outside: Px; inside: Px }>('placement');
			expect(near(r.left, [255, 0, 0, 128], 3)).toBe(true); // scaled ×2, half opacity (premultiplied out)
			expect(near(r.right, [0, 0, 255, 128], 3)).toBe(true);
			expect(r.outside[3]).toBe(0); // left of the moved picture: transparent
			expect(near(r.inside, [255, 0, 0, 255])).toBe(true);
		});

		it('reads both sides in one shader (S_DissolveLuma)', async () => {
			const r = await call<{ white: Px; black: Px }>('luma');
			expect(near(r.white, [0, 255, 0, 255])).toBe(true);
			expect(near(r.black, [0, 0, 0, 255])).toBe(true);
		});
	},
);
