// Shared setup of the compositions GL suites: the Chrome they run on, the IIFE bundle of a test entry and a fresh
// SwiftShader page with it loaded. Chrome discovery, flags and bundling are @jasper/testkit's (golden-fuzz).
import { bundleForBrowser, findChrome, SWIFTSHADER_ARGS } from '@jasper/testkit/browser';
import { type Browser, type BrowserContextOptions, chromium, type Page } from '@playwright/test';

export const CHROME = findChrome() ?? undefined;

/** Bundles a GL test entry (production IIFE) for `page.addScriptTag`. */
export const bundleGlEntry = (entry: string): Promise<string> => bundleForBrowser(entry);

/** Bundles a GL test entry and loads it in a fresh SwiftShader browser. */
export async function openGlPage(
	entry: string,
	opts: { logConsole?: boolean; page?: BrowserContextOptions } = {},
): Promise<{ browser: Browser; page: Page }> {
	const script = await bundleGlEntry(entry);
	const browser = await chromium.launch({ executablePath: CHROME, args: SWIFTSHADER_ARGS });
	try {
		const page = await browser.newPage(opts.page);
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		if (opts.logConsole) page.on('console', (m) => process.stdout.write(`${m.text()}\n`));
		await page.setContent('<!doctype html><html><body></body></html>');
		await page.addScriptTag({ content: script });
		if (errors.length) throw new Error(errors.join('\n'));
		return { browser, page };
	} catch (error) {
		await browser.close();
		throw error;
	}
}
