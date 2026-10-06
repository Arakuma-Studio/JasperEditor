// @vitest-environment node
// Sapphire Render family (lightning, gradients/grid/shape, other render generators) in real WebGL2: headless Chrome
// (SwiftShader without a GPU) runs the family's effects on the GPU host (fx-sapphire-render-gl/entry.ts). Checks a
// characteristic pixel per effect, determinism (same seed/frame → same pixels; another seed or frame → different
// lightning), animation over frames, padding, and alpha. `FX_DUMP=<dir>` additionally writes PNG stills of every
// effect (on `FX_DUMP_IMAGE`, a photo, when set) for visual review. FX_GL=0 skips it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunOpts } from './fx-sapphire-render-gl/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

type Px = [number, number, number, number];
const W = 160;
const H = 90;

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire Render effects in WebGL2 (headless Chrome)',
	{ timeout: Number(process.env.FX_TIMEOUT ?? 120_000) },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string, arg?: unknown): Promise<T> =>
			page.evaluate(
				([n, a]) =>
					(window as unknown as { __srt: Record<string, (x: unknown) => unknown> }).__srt[n as string]!(a),
				[name, arg] as const,
			) as Promise<T>;
		const solid = { kind: 'solid', color: '#204060' } as const;
		const pixels = (o: RunOpts, at: [number, number][]) =>
			call<{ canvas: number[]; box: number[]; px: Px[] }>('pixels', { ...o, at });
		const stats = (o: RunOpts) =>
			call<{ hash: number; luma: number; alpha: number; canvas: number[] }>('stats', o);

		beforeAll(async () => {
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'fx-sapphire-render-gl', 'entry.ts')],
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

		it('registers the family', async () => {
			const ids = await call<string[]>('ids');
			expect(ids).toEqual(expect.arrayContaining(['jasper.s.zap', 'jasper.s.ultra-zap']));
		});

		it('every effect runs with default params on a solid, a transparent layer and frame 20', async () => {
			const ids = await call<string[]>('ids');
			for (const id of ids) {
				for (const o of [
					{ id, width: W, height: H, paint: solid },
					{ id, width: W, height: H, paint: { kind: 'none' } as const, frame: 20 },
				]) {
					const s = await stats(o);
					expect(Number.isFinite(s.luma), id).toBe(true);
				}
			}
		});

		it('S_Zap: a bright bolt over the source, deterministic, animated by Wiggle and re-drawn by Seed', async () => {
			const base: RunOpts = { id: 'jasper.s.zap', width: W, height: H, paint: solid };
			const a = await stats(base);
			const b = await stats(base);
			expect(a.hash).toBe(b.hash); // re-render → identical pixels
			const c = await stats({ ...base, frame: 9 });
			expect(c.hash).not.toBe(a.hash); // wiggles over time
			const d = await stats({ ...base, params: { seed: 7 } });
			expect(d.hash).not.toBe(a.hash);
			// The bolt passes through Control Point 3 (0.7, 0.5) region: somewhere on that row it is near white.
			const row: [number, number][] = Array.from({ length: 60 }, (_, i) => [70 + i, H / 2]);
			const px = (await pixels(base, row)).px;
			expect(Math.max(...px.map((p) => p[0] + p[1] + p[2]))).toBeGreaterThan(600);
			// Zap Only: black where there is no lightning (corner far from the path)
			const only = await pixels({ ...base, params: { combine: 'only' } }, [[2, H - 2]]);
			expect(only.px[0]![0]).toBeLessThan(40);
		});

		it('S_Zap: Jitter Frames re-draws the bolt each period, constant inside a period without wiggle', async () => {
			const base: RunOpts = {
				id: 'jasper.s.zap',
				width: W,
				height: H,
				paint: solid,
				params: { wiggleSpeed: 0, jitterFrames: 4 },
			};
			const f0 = await stats({ ...base, frame: 0 });
			const f3 = await stats({ ...base, frame: 3 });
			const f4 = await stats({ ...base, frame: 4 });
			expect(f3.hash).toBe(f0.hash);
			expect(f4.hash).not.toBe(f0.hash);
		});

		it('S_ZapFrom: bolts leave the edges of the layer into the padding', async () => {
			const o: RunOpts = {
				id: 'jasper.s.zap-from',
				width: 80,
				height: 80,
				paint: { kind: 'solid', color: '#fff' },
			};
			const s = await stats(o);
			expect(s.canvas[0]).toBeGreaterThan(80);
			const r = await pixels(o, [[40, 40]]);
			expect(r.px[0]![3]).toBe(255);
		});

		it.runIf(!!process.env.FX_COMPILE)('compile times (FX_COMPILE=id,id)', async () => {
			for (const id of process.env.FX_COMPILE!.split(','))
				writeFileSync(
					`/tmp/fx-compile-${id}.json`,
					JSON.stringify({
						compile: await call('compileTimes', { id, width: 160, height: 90, paint: solid }),
						run: await call('passTimes', { id, width: 160, height: 90, paint: solid }),
					}),
				);
		});

		it.runIf(!!process.env.FX_DUMP)('dumps PNG stills (FX_DUMP)', async () => {
			const dir = process.env.FX_DUMP!;
			mkdirSync(dir, { recursive: true });
			const img = process.env.FX_DUMP_IMAGE;
			if (img)
				await call('loadImage', ['photo', `data:image/jpeg;base64,${readFileSync(img).toString('base64')}`]);
			const only = process.env.FX_DUMP_IDS?.split(',');
			const ids = (await call<string[]>('ids')).filter((id) => !only || only.includes(id));
			const frames = (process.env.FX_DUMP_FRAMES ?? '0,15').split(',').map(Number);
			const extra = process.env.FX_DUMP_PARAMS ? JSON.parse(process.env.FX_DUMP_PARAMS) : {};
			const w = Number(process.env.FX_DUMP_W ?? 640);
			const h = Number(process.env.FX_DUMP_H ?? 360);
			for (const id of ids)
				for (const frame of frames) {
					const r = await page.evaluate(
						([o]) => (window as never as { __srt: { png(x: unknown): unknown } }).__srt.png(o),
						[
							{
								id,
								width: w,
								height: h,
								frame,
								params: extra,
								paint: img ? { kind: 'image', key: 'photo' } : { kind: 'solid', color: '#223344' },
							},
						],
					);
					const { url, ms } = r as { url: string; ms: number };
					writeFileSync(
						join(dir, `${id.replace('jasper.s.', '')}-f${frame}.png`),
						Buffer.from(url.split(',')[1]!, 'base64'),
					);
					console.info(`[dump] ${id} f${frame} ${ms.toFixed(0)} ms`);
				}
		});
	},
);
