import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type Browser, chromium, type Page } from '@playwright/test';

export const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

/** Bundles a GL test entry and loads it in a fresh SwiftShader browser. */
export async function openGlPage(
	entry: string,
	opts: { logConsole?: boolean } = {},
): Promise<{ browser: Browser; page: Page }> {
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
	const browser = await chromium.launch({
		executablePath: CHROME,
		args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
	});
	try {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		if (opts.logConsole) page.on('console', (m) => process.stdout.write(`${m.text()}\n`));
		await page.setContent('<!doctype html><html><body></body></html>');
		await page.addScriptTag({ content: out.outputFiles[0]!.text });
		if (errors.length) throw new Error(errors.join('\n'));
		return { browser, page };
	} catch (error) {
		await browser.close();
		throw error;
	}
}
