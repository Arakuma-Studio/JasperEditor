// Development aid: shader compile+link time of each pass of fx effects in headless Chrome (SwiftShader).
//   pnpm tsx packages/compositions/test/fx-psdg/compile-times.ts jasper.mirror jasper.roughen-edges …
//   (no ids: every effect of the premiere-stylize-distort-generate family)

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FX_FAMILIES } from '@jasper/project';
import { bundleForBrowser } from '@jasper/testkit/browser';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const ids = process.argv.slice(2).length
	? process.argv.slice(2)
	: FX_FAMILIES.find((f) => f.file === 'premiere-stylize-distort-generate')!.effects.map((s) => s.id);
const code = await bundleForBrowser(join(here, 'compile-entry.ts'));
const CHROME = [process.env.JASPER_BROWSER_EXECUTABLE, '/usr/bin/google-chrome'].find(
	(p): p is string => !!p && existsSync(p),
);
const browser = await chromium.launch({
	executablePath: CHROME,
	args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
	const page = await browser.newPage();
	await page.setContent('<!doctype html><html><body></body></html>');
	await page.addScriptTag({ content: code });
	if (process.env.PSDG_SRC) {
		// Raw fragment sources (files), compiled as-is: PSDG_SRC=a.glsl,b.glsl
		for (const f of process.env.PSDG_SRC.split(',')) {
			const src = (await import('node:fs')).readFileSync(f, 'utf8');
			const r = await page.evaluate(([s]) => (window as any).__c.compile('jasper.mirror', s), [src] as const);
			console.log(`${f}: ${JSON.stringify(r)}`);
		}
		process.exit(0);
	}
	if (process.env.PSDG_DUMP) {
		const [id, pass] = process.env.PSDG_DUMP.split(':');
		console.log(
			await page.evaluate(([i, p]) => (window as any).__c.source(i, Number(p)), [id, pass] as const),
		);
		process.exit(0);
	}
	for (const id of ids) {
		const r = (await page.evaluate((i) => (window as any).__c.compile(i), id)) as {
			pass: number;
			ms: number;
			ok: boolean;
			log?: string;
		}[];
		console.log(`${id}: ${r.map((p) => `${p.ms}${p.ok ? '' : '!'}`).join(' ')} ms`);
	}
} finally {
	await browser.close();
}
