// @vitest-environment node
// "Sapphire other stylize" family (fx catalogue, wave 2) in a real WebGL2 (headless Chrome, SwiftShader without a
// GPU): characteristic pixels of every effect, alpha handling, determinism of the seeded ones, the media inputs
// (Mask, ZBuffer, Background, LUT image) and the time samples of S_PixelMosh. Pattern of fx-gl.test.ts.
// FX_SSO_DUMP=<dir> [FX_SSO_IMAGE=<photo>] also writes one PNG per effect (visual review / contact sheet).
// FX_GL=0 skips it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RenderOpts } from './fx-sapphire-stylize-other-gl/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

type Px = [number, number, number, number];
type Result = {
	canvas: number[];
	box: number[];
	offsets: number[];
	hash: number;
	probes: Px[];
	png?: string;
};
const near = (a: Px, b: Px, tol = 3) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const luma = (p: Px) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

/** One showcase render per effect (the contact sheet): defaults unless a look needs a setting or input. */
const SHOWCASE: { id: string; params?: Record<string, unknown>; extra?: Partial<RenderOpts> }[] = [
	{ id: 'jasper.s.band-pass' },
	{ id: 'jasper.s.color-fuse', params: { lut1Strength: 1, lut2: 'faded', lut2Strength: 0.5 } },
	{ id: 'jasper.s.dog-vision' },
	{ id: 'jasper.s.mosaic' },
	{
		id: 'jasper.s.pixel-mosh',
		params: { frameInterval: 30, varyFrameInterval: 0 },
		// The held frame (12 frames back) pushed by the outward motion of a zoom (this frame vs the previous one).
		extra: {
			frame: 12,
			scene: { kind: 'photo', zoom: 1.6 },
			samples: [{ kind: 'photo', zoom: 1.55 }, { kind: 'photo' }],
		},
	},
	{ id: 'jasper.s.pixel-sort' },
	{ id: 'jasper.s.prism-lens' },
	{ id: 'jasper.s.pseudo-color' },
	{ id: 'jasper.s.psyko-blobs' },
	{ id: 'jasper.s.psyko-stripes' },
	{ id: 'jasper.s.roman-tile' },
	{ id: 'jasper.s.solarize' },
	{ id: 'jasper.s.strip-slide' },
	{ id: 'jasper.s.zebrafy' },
	{ id: 'jasper.s.zebrafy-color' },
	{ id: 'jasper.s.z-fog-exponential', params: { fogColor: [0.75, 0.8, 0.9, 1] } },
	{ id: 'jasper.s.z-fog-linear', params: { fogColor: [0.75, 0.8, 0.9, 1] } },
];

/** Other modes, dumped as extra-<n>.png (visual review only). */
const EXTRAS: { id: string; params: Record<string, unknown> }[] = [
	{ id: 'jasper.s.pixel-sort', params: { mode: 'radial', threshold: 0.2 } },
	{ id: 'jasper.s.pixel-sort', params: { mode: 'circular', threshold: 0.2, randomlyRestartSort: 20 } },
	{
		id: 'jasper.s.pixel-sort',
		params: { downsample: true, sortResolution: 90, reverseSortDirection: true, sortAngle: 0 },
	},
	{ id: 'jasper.s.prism-lens', params: { mode: 'linear', size: 0.3, position: [0.5, 0.5] } },
	{
		id: 'jasper.s.prism-lens',
		params: { mode: 'radial', size: 0.25, rows: 2, position: [0.5, 0.5], geometry: 'ellipse' },
	},
	{ id: 'jasper.s.roman-tile', params: { tileShape: 'hexagon', varyShape: 0.6, crackedTiles: 1 } },
	{
		id: 'jasper.s.strip-slide',
		params: { order: 'random', stripAngle: 30, randomizeSize: 0.8, amount: 0.4 },
	},
	{ id: 'jasper.s.dog-vision', params: { channels: 'cyanRed', blurChannel2: 0.3 } },
	{ id: 'jasper.s.mosaic', params: { pixelFrequency: 20, pixelRelHeight: 0.5, smoothColors: 0.3 } },
	{ id: 'jasper.s.color-fuse', params: { lut1: 'bleachBypass', lut1Strength: 1, lut2: 'crossProcess' } },
];

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire other-stylize effects in WebGL2 (headless Chrome)',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const render = (o: RenderOpts): Promise<Result> =>
			page.evaluate(
				(opts) => (window as unknown as { __sso: { render(o: RenderOpts): Result } }).__sso.render(opts),
				o,
			);

		beforeAll(async () => {
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'fx-sapphire-stylize-other-gl', 'entry.ts')],
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

		it.runIf(!!process.env.FX_SSO_DUMP)(
			'dumps one PNG per effect (FX_SSO_DUMP)',
			async () => {
				const dir = process.env.FX_SSO_DUMP!;
				mkdirSync(dir, { recursive: true });
				const image = process.env.FX_SSO_IMAGE;
				if (image) {
					const url = `data:image/${image.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(image).toString('base64')}`;
					await page.evaluate(
						(u) => (window as unknown as { __sso: { setPhoto(u: string): Promise<void> } }).__sso.setPhoto(u),
						url,
					);
				}
				const w = Number(process.env.FX_SSO_W ?? 480);
				const h = Math.round((w * 9) / 16);
				const only = process.env.FX_SSO_ONLY?.split(',');
				for (const s of SHOWCASE) {
					if (only && !only.some((o) => s.id.includes(o))) continue;
					const r = await render({
						id: s.id,
						params: s.params,
						w,
						h,
						scene: { kind: image ? 'photo' : 'quad' },
						png: true,
						...s.extra,
					});
					writeFileSync(
						join(dir, `${s.id.replace('jasper.s.', '')}.png`),
						Buffer.from(r.png!.split(',')[1]!, 'base64'),
					);
				}
				if (image) {
					const r = await render({
						id: 'jasper.s.solarize',
						params: { mixWithOriginal: 1 },
						w,
						h,
						scene: { kind: 'photo' },
						png: true,
					});
					writeFileSync(join(dir, '_original.png'), Buffer.from(r.png!.split(',')[1]!, 'base64'));
				}
				if (process.env.FX_SSO_EXTRAS) {
					for (const [i, s] of EXTRAS.entries()) {
						const r = await render({
							id: s.id,
							params: s.params,
							w,
							h,
							scene: { kind: image ? 'photo' : 'quad' },
							png: true,
						});
						writeFileSync(join(dir, `extra-${i}.png`), Buffer.from(r.png!.split(',')[1]!, 'base64'));
					}
				}
			},
			600_000,
		);
	},
);
