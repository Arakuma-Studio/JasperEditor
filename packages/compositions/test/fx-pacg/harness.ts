// Node side of the Premiere Adjust/Color/Keying family GL tests: bundles ./entry.ts with esbuild, opens it in headless
// Chrome (WebGL2 via SwiftShader) and exposes `pixels(request, points)`. Shared by the family's *-gl.test.ts files.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import type { RunRequest } from './entry.ts';

const here = dirname(fileURLToPath(import.meta.url));

export const PACG_CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

/** Whether the GL tests can run (a Chrome exists and FX_GL is not 0). */
export const PACG_GL = !!PACG_CHROME && process.env.FX_GL !== '0';

export type Px = [number, number, number, number];
export type PacgRequest = RunRequest;

export const near = (a: Px, b: Px, tol = 3) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

export type PacgSession = {
	/** Runs `req` and returns the pixels at layer-px points (relative to the layer box) and the canvas size. */
	pixels(req: PacgRequest, at: [number, number][]): Promise<{ canvas: [number, number]; pixels: Px[] }>;
	/** One pixel. */
	px(req: PacgRequest, x: number, y: number): Promise<Px>;
	close(): Promise<void>;
};

export async function startPacg(): Promise<PacgSession> {
	const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
	const esbuild = req('esbuild') as {
		build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
	};
	const out = await esbuild.build({
		entryPoints: [join(here, 'entry.ts')],
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		define: { 'process.env.NODE_ENV': '"production"' },
		logLevel: 'silent',
	});
	const browser: Browser = await chromium.launch({
		executablePath: PACG_CHROME,
		args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
	});
	const page: Page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.setContent('<!doctype html><html><body></body></html>');
	await page.addScriptTag({ content: out.outputFiles[0]!.text });
	if (errors.length) throw new Error(errors.join('\n'));
	const pixels = (r: PacgRequest, at: [number, number][]) =>
		page.evaluate(
			([q, a]) =>
				(
					window as unknown as {
						__pacg: { pixels(q: unknown, a: unknown): Promise<{ canvas: [number, number]; pixels: Px[] }> };
					}
				).__pacg.pixels(q, a),
			[r, at] as const,
		) as Promise<{ canvas: [number, number]; pixels: Px[] }>;
	return {
		pixels,
		px: async (r, x, y) => (await pixels(r, [[x, y]])).pixels[0]!,
		close: () => browser.close(),
	};
}
