// Shared launcher of the Sapphire Glows + Lighting browser checks: bundles ./entry.ts with esbuild (from tsx) and
// opens it in headless Chrome (SwiftShader WebGL2). Used by the GL test and by the visual dump script (dump.ts).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));

export const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

let bundled: Promise<string> | null = null;

/** The entry bundled once per process (esbuild from tsx). */
function bundle(): Promise<string> {
	bundled ??= (async () => {
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
		return out.outputFiles[0]!.text;
	})();
	return bundled;
}

/** Launches Chrome (SwiftShader WebGL2); `page()` opens a fresh page with the bundle (a new GL context). */
export async function openSglBrowser(): Promise<{ browser: Browser; page(): Promise<Page> }> {
	const code = await bundle();
	const browser = await chromium.launch({
		executablePath: CHROME,
		// No GPU watchdog / crash limit: on a loaded machine a long SwiftShader draw would otherwise get the GPU
		// process killed and, after a few crashes, WebGL disabled for the rest of the run.
		args: [
			'--use-angle=swiftshader',
			'--enable-unsafe-swiftshader',
			'--ignore-gpu-blocklist',
			'--disable-gpu-watchdog',
			'--disable-gpu-process-crash-limit',
		],
	});
	return {
		browser,
		async page() {
			const page = await browser.newPage();
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(e.message));
			await page.setContent('<!doctype html><html><body></body></html>');
			await page.addScriptTag({ content: code });
			if (errors.length) throw new Error(errors.join('\n'));
			return page;
		},
	};
}

export async function openSglPage(): Promise<{ browser: Browser; page: Page }> {
	const b = await openSglBrowser();
	return { browser: b.browser, page: await b.page() };
}

/** Calls `window.__sgl[name](...args)` in the page. */
export function sgl<T>(page: Page, name: string, ...args: unknown[]): Promise<T> {
	return page.evaluate(
		({ n, a }) =>
			(window as unknown as { __sgl: Record<string, (...x: unknown[]) => unknown> }).__sgl[n]!(...a),
		{ n: name, a: args },
	) as Promise<T>;
}
