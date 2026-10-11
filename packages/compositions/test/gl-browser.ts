import { bundleForBrowser, findChrome, SWIFTSHADER_ARGS } from '@jasper/testkit/browser';
import { type Browser, type BrowserContextOptions, chromium, type Page } from '@playwright/test';

export const CHROME = findChrome() ?? undefined;

export const bundleGlEntry = (entry: string): Promise<string> => bundleForBrowser(entry);

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
