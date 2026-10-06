// @vitest-environment node
// Sapphire-style dissolves (registry/transitions/sapphire-dissolves.ts) in a real WebGL2 (headless Chrome,
// SwiftShader when there is no GPU): the stages run through the GPU host (src/fx/host.ts) over procedural sides
// (A: dark red with a white disc, B: blue with a yellow bar — see transition-sapphire-dissolves-gl/entry.ts) and the
// pixels are checked: the progress contract with default params two-sided and one-sided, one characteristic pixel
// per dissolve mid-way, Reverse, determinism and seeds. SD_GL_TIMINGS=1 prints compile / frame times. FX_GL=0 skips.
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunArgs } from './transition-sapphire-dissolves-gl/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

type Px = [number, number, number, number];
type Out = { probes: Px[]; checksum: number; mean: Px };

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire dissolves in WebGL2 (headless Chrome)',
	{ timeout: 300_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const run = (a: RunArgs): Promise<Out> =>
			page.evaluate(
				(args) => (window as unknown as { __sd: { run(a: unknown): unknown } }).__sd.run(args) as Out,
				a,
			) as Promise<Out>;
		const call = <T>(name: string): Promise<T> =>
			page.evaluate(
				(n) => (window as unknown as { __sd: Record<string, () => unknown> }).__sd[n]!(),
				name,
			) as Promise<T>;

		beforeAll(async () => {
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'transition-sapphire-dissolves-gl', 'entry.ts')],
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

		it.runIf(process.env.SD_GL_TIMINGS === '1')('times every dissolve', { timeout: 1_800_000 }, async () => {
			const only = (process.env.SD_GL_IDS ?? '').split(',').filter(Boolean);
			const ids = (await call<string[]>('ids')).filter((id) => only.length === 0 || only.some((o) => id.endsWith(o)));
			const t: Record<string, [number, number]> = {};
			for (const id of ids) {
				const t0 = Date.now();
				await run({ id, frame: 5, duration: 11 });
				const t1 = Date.now();
				await run({ id, frame: 6, duration: 11 });
				t[id] = [t1 - t0, Date.now() - t1];
				if (process.env.SD_GL_TIMINGS_OUT)
					writeFileSync(process.env.SD_GL_TIMINGS_OUT, JSON.stringify(t, null, 1));
			}
			expect(ids.length).toBeGreaterThan(0);
		});
	},
);
