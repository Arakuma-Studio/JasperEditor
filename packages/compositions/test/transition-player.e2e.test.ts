// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FX_H, FX_W, type FxMedia, fxAsset, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);

type Rgb = [number, number, number];
const close = (a: Rgb, b: Rgb, tol = 16) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const BLUE: [number, number, number, number] = [0, 0, 1, 1];

const cut = (a: Command[], effectId: string, params?: Record<string, unknown>): Command[] => [
	...a,
	{ type: 'clip.addSolid', at: 30, duration: 30, track: 'V1', color: BLUE, ref: '$b' } as Command,
	{
		type: 'transition.add',
		trackId: 'V1',
		at: 30,
		effectId,
		duration: 20,
		...(params ? { params } : {}),
	} as Command,
];

describe.runIf(enabled && !!CHROME)(
	'GPU transitions in the Player (REMOTION_E2E=1)',
	{ timeout: 120_000 },
	() => {
		let media: FxMedia;
		let browser: Browser;
		let page: Page;

		beforeAll(async () => {
			media = await startFxMedia('transition-player-');
			execFileSync('ffmpeg', [
				'-v',
				'error',
				'-y',
				'-f',
				'lavfi',
				'-i',
				`color=white:s=${FX_W / 2}x${FX_H}[l];color=black:s=${FX_W / 2}x${FX_H}[r];[l][r]hstack`,
				'-frames:v',
				'1',
				join(media.dir, 'halves.png'),
			]);
			const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
			const esbuild = req('esbuild') as {
				build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
			};
			const out = await esbuild.build({
				entryPoints: [join(here, 'fx-player', 'entry.tsx')],
				bundle: true,
				write: false,
				format: 'iife',
				platform: 'browser',
				target: 'es2022',
				jsx: 'automatic',
				define: { 'process.env.NODE_ENV': '"production"' },
				logLevel: 'silent',
			});
			const solidA = [
				{
					type: 'clip.addSolid',
					at: 0,
					duration: 30,
					track: 'V1',
					color: [1, 0, 0, 1],
					ref: '$a',
				} as Command,
			];
			const docs = {
				push: fxSnapshot(cut(solidA, 'jasper.push')),
				iris: fxSnapshot(
					cut(
						[
							{
								type: 'media.register',
								ref: '$m',
								asset: fxAsset(media, 'video', media.video, FX_W, FX_H),
							} as Command,
							{
								type: 'clip.place',
								source: { mediaId: '$m' },
								at: 0,
								sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
								tracks: { video: 'V1' },
								ref: '$a',
							} as unknown as Command,
						],
						'jasper.iris-round',
					),
				),
				luma: fxSnapshot(
					cut(
						[
							{
								type: 'media.register',
								ref: '$m',
								asset: fxAsset(media, 'image', 'halves.png', FX_W, FX_H),
							} as Command,
							{
								type: 'clip.place',
								source: { mediaId: '$m' },
								at: 0,
								sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
								tracks: { video: 'V1' },
								ref: '$a',
							} as unknown as Command,
						],
						'jasper.s.dissolve-luma',
						// S_DissolveLuma v2 defaults to Sapphire's "Difference"; this check is about A's own luma.
						{ useLumaOf: 'foreground', invertPattern: true },
					),
				),
				shape: fxSnapshot(
					cut(
						[
							{
								type: 'clip.addShape',
								at: 0,
								duration: 30,
								track: 'V1',
								shape: { type: 'rect', size: [100, 100], fill: [1, 1, 1, 1] },
								ref: '$a',
							} as Command,
						],
						'jasper.push',
					),
				),
			};
			media.page('bundle.js', 'text/javascript', out.outputFiles[0]!.text);
			media.page(
				'index.html',
				'text/html',
				`<!doctype html><html><body style="margin:0;background:#000"><script>window.__docs = ${JSON.stringify(docs)};</script><script src="/bundle.js"></script></body></html>`,
			);
			browser = await chromium.launch({
				executablePath: CHROME!,
				args: [
					'--enable-features=CanvasDrawElement',
					'--use-angle=swiftshader',
					'--enable-unsafe-swiftshader',
				],
			});
			page = await browser.newPage({ viewport: { width: FX_W, height: FX_H * 5 } });
			await page.goto(`${media.base}/index.html`);
		}, 180_000);

		afterAll(async () => {
			await page?.screenshot({ path: join(media.dir, 'page.png'), fullPage: true }).catch(() => undefined);
			console.info(`[transition-player] screenshot ${join(media.dir, 'page.png')}`);
			await browser?.close();
			media?.close();
		});

		async function pixels(name: string, p: Page = page): Promise<Buffer> {
			const png = await p.locator(`#${name}`).screenshot();
			return execFileSync(
				'ffmpeg',
				['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
				{
					input: png,
					maxBuffer: 1 << 26,
				},
			);
		}
		const at = (raw: Buffer, x: number, y: number): Rgb => {
			const i = (Math.round(y) * FX_W + Math.round(x)) * 3;
			return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
		};
		async function until(name: string, ok: (raw: Buffer) => boolean, ms = 15_000): Promise<Buffer> {
			const t0 = Date.now();
			let raw = await pixels(name);
			while (!ok(raw) && Date.now() - t0 < ms) {
				await page.waitForTimeout(250);
				raw = await pixels(name);
			}
			return raw;
		}
		const seek = (name: string, frame: number, p: Page = page) =>
			p.evaluate(
				([n, f]) =>
					(window as never as { __fxPlayer: { seek(a: string, b: number): void } }).__fxPlayer.seek(
						n as string,
						f as number,
					),
				[name, frame],
			);

		it('Push follows the playhead while scrubbing', async () => {
			await seek('push', 30);
			let raw = await until(
				'push',
				(r) => close(at(r, 100, 100), [0, 0, 255]) && close(at(r, 540, 100), [255, 0, 0]),
			);
			expect(close(at(raw, 100, 100), [0, 0, 255])).toBe(true);
			expect(close(at(raw, 540, 100), [255, 0, 0])).toBe(true);
			await seek('push', 37); // p = 18 / 21: the seam at x ≈ 549
			raw = await until('push', (r) => close(at(r, 500, 100), [0, 0, 255]));
			expect(close(at(raw, 500, 100), [0, 0, 255])).toBe(true);
			expect(close(at(raw, 620, 100), [255, 0, 0])).toBe(true);
		});

		it('Iris Round over a video side: B in the circle, the decoded video outside', async () => {
			await seek('iris', 30);
			const raw = await until(
				'iris',
				(r) => close(at(r, FX_W / 2, FX_H / 2), [0, 0, 255]) && at(r, 20, 20).some((v) => v > 40),
			);
			expect(close(at(raw, FX_W / 2, FX_H / 2), [0, 0, 255])).toBe(true);
			expect(at(raw, 20, 20).some((v) => v > 40)).toBe(true);
		});

		it('S_DissolveLuma: the white half of A already shows B', async () => {
			await seek('luma', 30);
			const raw = await until(
				'luma',
				(r) => close(at(r, 100, 100), [0, 0, 255]) && close(at(r, 540, 100), [0, 0, 0]),
			);
			expect(close(at(raw, 100, 100), [0, 0, 255])).toBe(true);
			expect(close(at(raw, 540, 100), [0, 0, 0])).toBe(true);
		});

		it('a shape side is captured through HTML-in-Canvas', async () => {
			await seek('shape', 30);
			const raw = await until('shape', (r) => close(at(r, 620, FX_H / 2), [255, 255, 255], 24));
			expect(close(at(raw, 620, FX_H / 2), [255, 255, 255], 24)).toBe(true);
			expect(close(at(raw, 320, FX_H / 2), [0, 0, 255])).toBe(true);
		});

		it('without HTML-in-Canvas a DOM side falls back to a dissolve with a chip', async () => {
			const plain = await chromium.launch({
				executablePath: CHROME!,
				args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
			});
			try {
				const p = await plain.newPage({ viewport: { width: FX_W, height: FX_H * 5 } });
				await p.goto(`${media.base}/index.html`);
				await seek('shape', 30, p);
				await p.waitForSelector('#shape [data-transition-chip]', { timeout: 15_000 });
				const chip = await p.locator('#shape [data-transition-chip]').textContent();
				expect(chip).toMatch(/HTML-in-Canvas/);
			} finally {
				await plain.close();
			}
		});
	},
);
