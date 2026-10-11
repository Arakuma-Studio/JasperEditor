// Shared launcher of the Sapphire Glows + Lighting browser checks: bundles ./entry.ts with esbuild (from tsx) and
// opens it in headless Chrome (SwiftShader WebGL2). Used by the GL test and by the visual dump script (dump.ts).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleForBrowser, SWIFTSHADER_ARGS } from '@jasper/testkit/browser';
import { type Browser, chromium, type Page } from '@playwright/test';
import { CHROME } from '../gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

export { CHROME } from '../gl-browser.ts';

let bundled: Promise<string> | null = null;

/** Launches Chrome (SwiftShader WebGL2); `page()` opens a fresh page with the bundle (a new GL context). */
export async function openSglBrowser(): Promise<{ browser: Browser; page(): Promise<Page> }> {
	const code = await (bundled ??= bundleForBrowser(join(here, 'entry.ts')));
	const browser = await chromium.launch({
		executablePath: CHROME,
		// No GPU watchdog / crash limit: on a loaded machine a long SwiftShader draw would otherwise get the GPU
		// process killed and, after a few crashes, WebGL disabled for the rest of the run.
		args: [...SWIFTSHADER_ARGS, '--disable-gpu-watchdog', '--disable-gpu-process-crash-limit'],
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

/** Calls `window.__sgl[name](...args)` in the page. */
export function sgl<T>(page: Page, name: string, ...args: unknown[]): Promise<T> {
	return page.evaluate(
		({ n, a }) =>
			(window as unknown as { __sgl: Record<string, (...x: unknown[]) => unknown> }).__sgl[n]!(...a),
		{ n: name, a: args },
	) as Promise<T>;
}
