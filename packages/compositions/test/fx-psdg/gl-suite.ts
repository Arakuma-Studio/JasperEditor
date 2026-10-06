// Node side of the premiere-stylize-distort-generate GL tests: bundles a browser entry (which sets
// `window.__psdgTest = { name: (arg) => result }` using ./harness.ts) with esbuild, opens it in headless Chrome
// (SwiftShader when there is no GPU, as test/fx-gl.test.ts) and calls its functions. Chrome is found like the
// framework's GL test; FX_GL=0 skips.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type Browser, chromium, type Page } from '@playwright/test';

export const PSDG_CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

export const psdgGlEnabled = !!PSDG_CHROME && process.env.FX_GL !== '0';

export type PsdgPage = {
	call<T>(name: string, arg?: unknown): Promise<T>;
	close(): Promise<void>;
};

export async function openPsdgPage(entry: string): Promise<PsdgPage> {
	const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
	const esbuild = req('esbuild') as {
		build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
	};
	const out = await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		define: { 'process.env.NODE_ENV': '"production"' },
		logLevel: 'silent',
	});
	const browser: Browser = await chromium.launch({
		executablePath: PSDG_CHROME,
		args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
	});
	const page: Page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.setContent('<!doctype html><html><body></body></html>');
	await page.addScriptTag({ content: out.outputFiles[0]!.text });
	if (errors.length) {
		await browser.close();
		throw new Error(errors.join('\n'));
	}
	return {
		call: <T>(name: string, arg?: unknown) =>
			page.evaluate(
				([n, a]) =>
					(window as unknown as { __psdgTest: Record<string, (x: unknown) => unknown> }).__psdgTest[n]!(a),
				[name, arg] as const,
			) as Promise<T>,
		close: () => browser.close(),
	};
}
