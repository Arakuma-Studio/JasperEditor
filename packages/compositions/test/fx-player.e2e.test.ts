// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleForBrowser } from '@jasper/testkit/browser';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FX_H, FX_W, type FxMedia, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);

type Rgb = [number, number, number];
const close = (a: Rgb, b: Rgb, tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe.runIf(enabled && !!CHROME)(
	'GPU shader effects in the Player (REMOTION_E2E=1)',
	{ timeout: 120_000 },
	() => {
		let media: FxMedia;
		let browser: Browser;
		let page: Page;
		let docs: Record<string, ReturnType<typeof fxSnapshot>>;

		const shadow = (color: number[]) => ({
			shadowColor: color,
			opacity: 100,
			direction: 0,
			distance: 40,
			softness: 0,
		});

		beforeAll(async () => {
			media = await startFxMedia('fx-player-');
			const code = await bundleForBrowser(join(here, 'fx-player', 'entry.tsx'));
			docs = {
				plain: fxSnapshot(fxCmd.video(media, 2)),
				halved: fxSnapshot([
					...fxCmd.video(media, 2),
					fxCmd.effect('test.s.gradient', { startColor: [0, 0, 0, 1], endColor: [0, 0, 0, 1], opacity: 50 }),
				]),
				frozen: fxSnapshot([...fxCmd.video(media, 2), fxCmd.effect('test.s.freeze-frame', { at: 5 })]),
				still: fxSnapshot([...fxCmd.still(media), fxCmd.effect('test.drop-shadow', shadow([0, 1, 0, 1]))]),
				mblur: fxSnapshot([...fxCmd.still(media), ...fxCmd.movingTransform(false)]),
				shape: fxSnapshot([
					...fxCmd.shape(),
					fxCmd.effect('test.drop-shadow', { ...shadow([0, 1, 0, 1]), direction: 90, distance: 30 }),
				]),
			};
			media.page('bundle.js', 'text/javascript', code);
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
			page = await browser.newPage({ viewport: { width: FX_W, height: FX_H * 7 } });
			await page.goto(`${media.base}/index.html`);
		}, 180_000);

		afterAll(async () => {
			await page?.screenshot({ path: join(media.dir, 'page.png'), fullPage: true }).catch(() => undefined);
			console.info(`[fx-player] screenshot ${join(media.dir, 'page.png')}`);
			await browser?.close();
			media?.close();
		});

		async function pixels(name: string): Promise<Buffer> {
			const png = await page.locator(`#${name}`).screenshot();
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
		/** Polls until `ok` holds for the player's pixels (decoders and redraws are asynchronous in the Player). */
		async function until(name: string, ok: (raw: Buffer) => boolean, ms = 15_000): Promise<Buffer> {
			const t0 = Date.now();
			let raw = await pixels(name);
			while (!ok(raw) && Date.now() - t0 < ms) {
				await page.waitForTimeout(250);
				raw = await pixels(name);
			}
			return raw;
		}
		const seek = (name: string, frame: number) =>
			page.evaluate(
				([n, f]) =>
					(window as never as { __fxPlayer: { seek(a: string, b: number): void } }).__fxPlayer.seek(
						n as string,
						f as number,
					),
				[name, frame],
			);

		it('a paused video frame goes through the shader chain (headless <Video> → FxPicture)', async () => {
			await seek('plain', 10);
			await seek('halved', 10);
			const plain = await until('plain', (r) => at(r, 100, 100).some((v) => v > 40));
			let worst = 255;
			await until('halved', (r) => {
				worst = 0;
				for (let y = 20; y < FX_H; y += 40)
					for (let x = 20; x < FX_W; x += 40) {
						const p = at(plain, x, y);
						const q = at(r, x, y);
						for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(q[k]! - p[k]! / 2));
					}
				return worst < 14;
			});
			expect(worst).toBeLessThan(14);
		});

		it('a freeze frame shows the frozen source frame', async () => {
			await seek('plain', 5);
			const frame5 = await until('plain', () => true);
			await page.waitForTimeout(1500);
			const ref = await pixels('plain');
			await seek('frozen', 25);
			let d = 255;
			await until('frozen', (r) => {
				d = 0;
				for (let i = 0; i < r.length; i += 97) d = Math.max(d, Math.abs(r[i]! - ref[i]!));
				return d < 16;
			});
			expect(frame5.length).toBe(ref.length);
			expect(d).toBeLessThan(16);
		});

		it('a still with a padded drop shadow, and a paused param edit redraws it', async () => {
			let raw = await until('still', (r) => close(at(r, 440, FX_H / 2), [0, 255, 0], 12));
			expect(close(at(raw, FX_W / 2, FX_H / 2), [255, 0, 0], 12)).toBe(true);
			expect(close(at(raw, 440, FX_H / 2), [0, 255, 0], 12)).toBe(true);
			const blue = fxSnapshot([
				...fxCmd.still(media),
				fxCmd.effect('test.drop-shadow', shadow([0, 0, 1, 1])),
			]);
			await page.evaluate(
				(d) =>
					(window as never as { __fxPlayer: { setDoc(a: string, b: unknown): void } }).__fxPlayer.setDoc(
						'still',
						d,
					),
				blue,
			);
			raw = await until('still', (r) => close(at(r, 440, FX_H / 2), [0, 0, 255], 12));
			expect(close(at(raw, 440, FX_H / 2), [0, 0, 255], 12)).toBe(true);
		});

		it('Transform Shutter Angle motion blur from the keyframes, as in renders', async () => {
			await seek('mblur', 5);
			const raw = await until('mblur', (r) => Math.abs(at(r, 222, FX_H / 2)[0] - 153) < 30);
			expect(Math.abs(at(raw, 222, FX_H / 2)[0] - 153)).toBeLessThan(30);
			expect(at(raw, FX_W / 2, FX_H / 2)[0]).toBeGreaterThan(235);
		});

		it('a shape (DOM layer) runs its shader effects through HTML-in-Canvas', async () => {
			const raw = await until('shape', (r) => close(at(r, FX_W / 2, 245), [0, 255, 0], 16));
			expect(close(at(raw, FX_W / 2, FX_H / 2), [255, 255, 255], 12)).toBe(true);
			expect(close(at(raw, FX_W / 2, 245), [0, 255, 0], 16)).toBe(true);
		});

		it('without HTML-in-Canvas the DOM layer shows a chip and draws unprocessed', async () => {
			const plainChrome = await chromium.launch({
				executablePath: CHROME!,
				args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
			});
			try {
				const p = await plainChrome.newPage({ viewport: { width: FX_W, height: FX_H * 7 } });
				await p.goto(`${media.base}/index.html`);
				await p.waitForSelector('#shape [data-grade-chip]', { timeout: 15_000 });
				const chip = await p.evaluate(() =>
					(window as never as { __fxPlayer: { chip(n: string): string | null } }).__fxPlayer.chip('shape'),
				);
				expect(chip).toMatch(/HTML-in-Canvas/);
			} finally {
				await plainChrome.close();
			}
		});
	},
);
