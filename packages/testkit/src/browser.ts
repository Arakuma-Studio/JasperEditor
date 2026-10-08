// Headless Chrome for WebGL2 / page-level tests: find a Chrome, launch it on ANGLE/SwiftShader (deterministic
// software GL without a GPU), and load an esbuild bundle of a test entry into a blank page.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Chrome used by the GL tests: `JASPER_BROWSER_EXECUTABLE`, else the usual system paths; null when none. */
export function findChrome(): string | null {
	return (
		[
			process.env.JASPER_BROWSER_EXECUTABLE,
			'/usr/bin/google-chrome',
			'/usr/bin/google-chrome-stable',
			'/usr/bin/chromium',
			'/usr/bin/chromium-browser',
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		].find((p): p is string => !!p && existsSync(p)) ?? null
	);
}

/** Chrome flags of every GL test: SwiftShader through ANGLE even where a GPU exists (same pixels everywhere). */
export const SWIFTSHADER_ARGS = [
	'--use-angle=swiftshader',
	'--enable-unsafe-swiftshader',
	'--ignore-gpu-blocklist',
];

type Esbuild = {
	build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};

/** Bundles a browser entry (TypeScript/TSX) into one IIFE script with esbuild (the one that comes with tsx). */
export async function bundleForBrowser(entry: string, define: Record<string, string> = {}): Promise<string> {
	const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
	const esbuild = req('esbuild') as Esbuild;
	const out = await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		jsx: 'automatic',
		define: { 'process.env.NODE_ENV': '"production"', ...define },
		logLevel: 'silent',
	});
	return out.outputFiles[0]!.text;
}

export type GlPage = {
	page: import('@playwright/test').Page;
	/** Calls `window.<global>[name](arg)` in the page and returns its (JSON) result. */
	call<T>(name: string, arg?: unknown): Promise<T>;
	close(): Promise<void>;
};

/**
 * Launches Chrome (SwiftShader), opens a blank page and adds the bundled `entry`; `global` is the window property
 * the entry installs its functions on. Page errors during load fail the launch.
 */
export async function openGlPage(entry: string, global: string, chrome = findChrome()): Promise<GlPage> {
	if (!chrome) throw new Error('no Chrome found (set JASPER_BROWSER_EXECUTABLE)');
	const [{ chromium }, script] = await Promise.all([import('@playwright/test'), bundleForBrowser(entry)]);
	const browser = await chromium.launch({ executablePath: chrome, args: SWIFTSHADER_ARGS });
	try {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.setContent('<!doctype html><html><body style="margin:0"></body></html>');
		await page.addScriptTag({ content: script });
		if (errors.length) throw new Error(errors.join('\n'));
		return {
			page,
			call: <T>(name: string, arg?: unknown) =>
				page.evaluate(
					([g, n, a]) =>
						(window as unknown as Record<string, Record<string, (a?: unknown) => unknown>>)[g as string]![
							n as string
						]!(a),
					[global, name, arg] as const,
				) as Promise<T>,
			close: () => browser.close(),
		};
	} catch (e) {
		await browser.close();
		throw e;
	}
}
