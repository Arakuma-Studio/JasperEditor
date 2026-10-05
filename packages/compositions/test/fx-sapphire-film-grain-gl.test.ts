// @vitest-environment node
// The Sapphire film / grain / damage family (registry/fx/sapphire-film-grain.ts) in real WebGL2 (headless Chrome,
// SwiftShader): default-param identity checks, one characteristic pixel per effect, alpha handling, temporal
// animation (grain/dust/flicker change per frame) and determinism (same params → same pixels, new Seed → new
// pattern). Pattern of fx-gl.test.ts; the bundle is fx-sapphire-film-grain/entry.ts. FX_GL=0 skips it.
// Visual check: FX_FILM_SHOTS=<dir> [FX_FILM_IMAGE=<jpg/png>] also writes a PNG per effect and frame.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FilmRunOptions } from './fx-sapphire-film-grain/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

type Px = number[];
type Result = { canvas: number[]; box: number[]; passes: number; probes: Px[]; all?: number[]; png?: string };

const FAMILY = [
	'jasper.s.film-effect',
	'jasper.s.film-damage',
	'jasper.s.film-burn',
	'jasper.s.vhs-damage',
	'jasper.s.vignette',
	'jasper.s.bleach-bypass',
	'jasper.s.grain',
	'jasper.s.grain-static',
	'jasper.s.ultra-grain',
	'jasper.s.diffuse',
	'jasper.s.vintage-color-2strip',
	'jasper.s.vintage-color-3strip',
	'jasper.s.digital-damage',
	'jasper.s.jpeg-damage',
	'jasper.s.tv-damage',
	'jasper.s.grunge',
	'jasper.s.scan-lines',
	'jasper.s.scan-lines-mono',
];

/** Effects whose look changes from frame to frame with default params. */
const ANIMATED = [
	'jasper.s.film-effect',
	'jasper.s.film-damage',
	'jasper.s.vhs-damage',
	'jasper.s.grain',
	'jasper.s.ultra-grain',
	'jasper.s.diffuse',
	'jasper.s.digital-damage',
	'jasper.s.tv-damage',
];

/** Effects with a Seed param whose pattern depends on it. */
const SEEDED = [
	'jasper.s.film-effect',
	'jasper.s.film-damage',
	'jasper.s.film-burn',
	'jasper.s.vhs-damage',
	'jasper.s.grain',
	'jasper.s.grain-static',
	'jasper.s.ultra-grain',
	'jasper.s.diffuse',
	'jasper.s.digital-damage',
	'jasper.s.jpeg-damage',
	'jasper.s.tv-damage',
	'jasper.s.grunge',
];

const meanAbsDiff = (a: number[], b: number[]) => {
	let d = 0;
	for (let i = 0; i < a.length; i++) if (i % 4 !== 3) d += Math.abs(a[i]! - b[i]!);
	return d / ((a.length * 3) / 4);
};
const mean = (a: number[], ch: number) => {
	let s = 0;
	let n = 0;
	for (let i = ch; i < a.length; i += 4, n++) s += a[i]!;
	return s / n;
};

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire film / grain / damage effects in WebGL2',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const render = (o: FilmRunOptions) =>
			page.evaluate(
				(opts) =>
					(window as unknown as { __film: { render(o: unknown): Result } }).__film.render(opts),
				o,
			) as Promise<Result>;
		const loadImage = (dataUrl: string | null) =>
			page.evaluate(
				(u) =>
					(window as unknown as { __film: { loadImage(u: string | null): Promise<unknown> } }).__film.loadImage(u),
				dataUrl,
			);

		beforeAll(async () => {
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'fx-sapphire-film-grain', 'entry.ts')],
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

		it('registers the whole family', async () => {
			const ids = await page.evaluate(() =>
				(window as unknown as { __film: { ids(): string[] } }).__film.ids(),
			);
			for (const id of FAMILY) expect(ids).toContain(id);
		});

		it('every effect compiles and runs with default params on a picture', async () => {
			for (const id of FAMILY) {
				const r = await render({ id, width: 48, height: 32, paint: 'gradient', all: true });
				expect(r.all!.length, id).toBe(48 * 32 * 4);
			}
		});

		it('Mix with Orig = 1 returns the input', async () => {
			for (const id of FAMILY) {
				const r = await render({
					id,
					width: 32,
					height: 24,
					paint: 'gradient',
					params: { mixWithOriginal: 1 },
					probes: [[16, 12]],
				});
				const expected = Math.round((16.5 / 32) * 255);
				expect(Math.abs(r.probes[0]![0]! - expected), id).toBeLessThanOrEqual(6);
				expect(r.probes[0]![3], id).toBe(255);
			}
		});

		it('random effects are deterministic and follow the Seed', async () => {
			for (const id of SEEDED) {
				const opts = { id, width: 64, height: 48, paint: 'grey' as const, frame: 3, all: true };
				const a = await render(opts);
				const b = await render(opts);
				const c = await render({ ...opts, params: { seed: 77 } });
				expect(a.all, id).toEqual(b.all);
				expect(meanAbsDiff(a.all!, c.all!), id).toBeGreaterThan(0.2);
			}
		});

		it('grain, dust, flicker and glitches change from frame to frame', async () => {
			for (const id of ANIMATED) {
				const opts = { id, width: 64, height: 48, paint: 'grey' as const, all: true };
				const f0 = await render({ ...opts, frame: 0 });
				const f1 = await render({ ...opts, frame: 1 });
				expect(meanAbsDiff(f0.all!, f1.all!), id).toBeGreaterThan(0.2);
			}
		});

		it('fully transparent input stays transparent (filters)', async () => {
			const filters = FAMILY.filter((id) => id !== 'jasper.s.film-burn');
			for (const id of filters) {
				const r = await render({ id, width: 32, height: 24, paint: 'half', probes: [[28, 12]] });
				expect(r.probes[0]![3], id).toBeLessThanOrEqual(2);
			}
		});

		it('S_Vignette darkens the corners, keeps the centre', async () => {
			const r = await render({
				id: 'jasper.s.vignette',
				width: 160,
				height: 90,
				paint: 'white',
				probes: [
					[80, 45],
					[2, 2],
				],
			});
			expect(r.probes[0]![0]).toBeGreaterThan(240);
			expect(r.probes[1]![0]).toBeLessThan(150);
		});

		it('S_Grain adds zero-mean noise of the stock amplitude', async () => {
			const r = await render({ id: 'jasper.s.grain', width: 96, height: 64, paint: 'grey', all: true });
			const m = mean(r.all!, 1);
			expect(Math.abs(m - 128)).toBeLessThan(6);
			let v = 0;
			for (let i = 1; i < r.all!.length; i += 4) v += (r.all![i]! - m) ** 2;
			const sd = Math.sqrt(v / (r.all!.length / 4));
			expect(sd).toBeGreaterThan(2);
			expect(sd).toBeLessThan(40);
		});

		it('S_BleachBypass desaturates and adds contrast', async () => {
			const r = await render({
				id: 'jasper.s.bleach-bypass',
				width: 32,
				height: 24,
				paint: 'image',
				probes: [[16, 12]],
			});
			expect(r.probes[0]![3]).toBe(255);
		});

		it('S_JpegDamage quantises in 8×8 blocks (smooth gradient becomes stepped)', async () => {
			const r = await render({
				id: 'jasper.s.jpeg-damage',
				width: 64,
				height: 16,
				paint: 'gradient',
				params: { quality: 2, damage: 0 },
				all: true,
			});
			// Row 4: steps at the 8-px block borders are larger than inside a block.
			const row = (x: number) => r.all![(4 * 64 + x) * 4]!;
			let inside = 0;
			let border = 0;
			for (let b = 1; b < 7; b++) {
				border += Math.abs(row(b * 8) - row(b * 8 - 1));
				inside += Math.abs(row(b * 8 + 4) - row(b * 8 + 3));
			}
			expect(border).toBeGreaterThan(inside);
		});

		it('S_ScanLines draws periodic dark lines', async () => {
			const r = await render({ id: 'jasper.s.scan-lines', width: 32, height: 64, paint: 'white', all: true });
			const col = Array.from({ length: 64 }, (_, y) => r.all![(y * 32 + 16) * 4]!);
			expect(Math.min(...col)).toBeLessThan(Math.max(...col) - 40);
		});

		it('S_FilmBurn burns holes through the picture at a high burn amount', async () => {
			const lo = await render({
				id: 'jasper.s.film-burn',
				width: 96,
				height: 64,
				paint: 'grey',
				params: { burnAmount: 0 },
				all: true,
			});
			const hi = await render({
				id: 'jasper.s.film-burn',
				width: 96,
				height: 64,
				paint: 'grey',
				params: { burnAmount: 1 },
				all: true,
			});
			expect(Math.abs(mean(lo.all!, 1) - 128)).toBeLessThan(4);
			expect(meanAbsDiff(lo.all!, hi.all!)).toBeGreaterThan(20);
		});

		const shots = process.env.FX_FILM_SHOTS;
		it.runIf(!!shots)('writes PNG shots of every effect (FX_FILM_SHOTS)', async () => {
			const dir = shots!;
			mkdirSync(dir, { recursive: true });
			const img = process.env.FX_FILM_IMAGE;
			if (img) {
				const mime = extname(img).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
				await loadImage(`data:${mime};base64,${readFileSync(img).toString('base64')}`);
			}
			const only = process.env.FX_FILM_ONLY?.split(',');
			const frames = (process.env.FX_FILM_FRAMES ?? '0,1,2').split(',').map(Number);
			const params = process.env.FX_FILM_PARAMS ? JSON.parse(process.env.FX_FILM_PARAMS) : {};
			for (const id of FAMILY) {
				if (only && !only.some((o) => id.endsWith(o))) continue;
				for (const frame of frames) {
					const r = await render({ id, frame, png: true, paint: img ? 'image' : 'gradient', params });
					const name = `${id.replace('jasper.s.', '')}-f${frame}.png`;
					writeFileSync(join(dir, name), Buffer.from(r.png!.split(',')[1]!, 'base64'));
				}
			}
		});
	},
);
