// @vitest-environment node
// compositor: the flat compositor in the Remotion Player (preview path) in headless Chrome with HTML-in-Canvas
// (bundled from fx-player/entry.tsx): stacks whose scopes used to nest draw in the Program monitor — an adjustment
// layer over a GL blend over video (decoded frames reach the compositor), a nest drawn as a canvas source, a 3D run
// under an adjustment layer — and the HDR display transform keeps running while a scope draws inside it (it used to
// step aside with a chip). Gated by REMOTION_E2E=1; COMPOSITOR_ELECTRON=1 (under xvfb-run) runs the same Players in the
// desktop app's Electron.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blendPixel, type Command, type Rgba } from '@jasper/project';
import { _electron, type Browser, chromium, type ElectronApplication, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FX_H, FX_W, type FxMedia, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
/** COMPOSITOR_ELECTRON=1: run the Players in the desktop app's Electron instead (under xvfb-run). */
const ELECTRON =
	process.env.COMPOSITOR_ELECTRON === '1'
		? (createRequire(join(here, '..', '..', '..', 'apps', 'desktop', 'package.json'))('electron') as string)
		: null;
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);

type Rgb = [number, number, number];
const close = (a: Rgb, b: Rgb, tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const to8 = (c: Rgba): Rgb => [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
const invert = (c: Rgba): Rgba => [1 - c[0], 1 - c[1], 1 - c[2], c[3]];

const solid = (track: string, color: Rgba, ref: string): Command =>
	({ type: 'clip.addSolid', at: 0, duration: 60, track, color, ref }) as Command;
const mode = (ref: string, blendMode: string): Command =>
	({ type: 'clip.update', clipId: ref, patch: { blendMode } }) as Command;
const adjustment = (track: string, ref: string): Command =>
	({ type: 'clip.addAdjustment', at: 0, duration: 60, track, ref }) as Command;
const effect = (ref: string, effectId: string): Command =>
	({ type: 'effect.add', target: { clipId: ref }, effectId }) as Command;

describe.runIf(enabled && !!CHROME)(
	'flat compositor in the Player (REMOTION_E2E=1)',
	{ timeout: 120_000 },
	() => {
		let media: FxMedia;
		let browser: Browser | undefined;
		let electronApp: ElectronApplication | undefined;
		let page: Page;
		let docs: Record<string, ReturnType<typeof fxSnapshot>>;
		const base: Rgba = [0.8, 0.4, 0.2, 1];
		const mid: Rgba = [0.3, 0.6, 0.9, 1];

		beforeAll(async () => {
			media = await startFxMedia('compositor-player-');
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
			docs = {
				video: fxSnapshot(fxCmd.video(media, 2)),
				videoFlat: fxSnapshot([
					...fxCmd.video(media, 2),
					adjustment('V2', '$adj'),
					effect('$adj', 'jasper.invert'),
					solid('V3', [1, 1, 1, 1], '$w'),
					mode('$w', 'linear-burn'),
				]),
				nest: fxSnapshot([
					{
						type: 'sequence.create',
						name: 'Nest',
						preset: 'hd-720p-30',
						settings: { width: FX_W, height: FX_H },
						tracks: { video: 3, audio: 1 },
						ref: '$seq',
					} as Command,
					{ ...solid('V1', base, '$na'), sequenceId: '$seq' } as Command,
					{ ...solid('V2', mid, '$nb'), sequenceId: '$seq' } as Command,
					mode('$nb', 'linear-burn'),
					{ ...adjustment('V3', '$nadj'), sequenceId: '$seq' } as Command,
					effect('$nadj', 'jasper.invert'),
					{
						type: 'clip.place',
						source: { sequenceId: '$seq' },
						at: 0,
						tracks: { video: 'V1' },
						ref: '$nest',
					} as unknown as Command,
					effect('$nest', 'jasper.invert'),
				]),
				run: fxSnapshot([
					solid('V1', base, '$a'),
					solid('V2', [1, 0, 0, 1], '$c'),
					{ type: 'param.set', target: ['clip', '$c', 'transform', 'scale'], value: 30 } as Command,
					{ type: 'clip.set3d', clipIds: ['$c'], enabled: true } as Command,
					adjustment('V3', '$adj'),
					effect('$adj', 'jasper.invert'),
				]),
				pq: fxSnapshot([
					{ type: 'sequence.updateSettings', settings: { workingColorSpace: 'rec2100-pq' } } as Command,
					solid('V1', [1, 1, 1, 1], '$a'),
					// Linear Dodge (Add) of black: a GL blend scope that leaves the graphics white as it is.
					solid('V2', [0, 0, 0, 1], '$b'),
					mode('$b', 'add'),
				]),
			};
			media.page('bundle.js', 'text/javascript; charset=utf-8', out.outputFiles[0]!.text);
			media.page(
				'index.html',
				'text/html',
				`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#000"><script>window.__docs = ${JSON.stringify(docs)};</script><script src="/bundle.js"></script></body></html>`,
			);
			if (ELECTRON) {
				// The desktop app's Electron (apps/desktop: same feature switch), under xvfb.
				const main = join(media.dir, 'electron-main.cjs');
				writeFileSync(
					main,
					`const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('enable-features', 'CanvasDrawElement');
// xvfb has no GPU: WebGL2 through SwiftShader (a desktop with a GPU has it natively).
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: ${FX_W}, height: ${FX_H * 6}, useContentSize: true, show: true });
  w.loadURL(process.argv[process.argv.length - 1]);
});`,
				);
				electronApp = await _electron.launch({
					executablePath: ELECTRON,
					args: [main, `${media.base}/index.html`],
					env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
				});
				page = await electronApp.firstWindow();
				await page.waitForLoadState();
			} else {
				browser = await chromium.launch({
					executablePath: CHROME!,
					args: [
						'--enable-features=CanvasDrawElement',
						'--use-angle=swiftshader',
						'--enable-unsafe-swiftshader',
					],
				});
				page = await browser.newPage({ viewport: { width: FX_W, height: FX_H * 6 } });
			}
			page.on('pageerror', (e) => console.log('[pageerror]', e.message));
			page.on('console', (m) => {
				if (m.type() === 'error') console.log('[page]', m.text());
			});
			if (!ELECTRON) await page.goto(`${media.base}/index.html`);
		}, 180_000);

		afterAll(async () => {
			await page?.screenshot({ path: join(media.dir, 'page.png'), fullPage: true }).catch(() => undefined);
			console.info(`[compositor-player] screenshot ${join(media.dir, 'page.png')}`);
			await browser?.close();
			await electronApp?.close();
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
		async function until(name: string, ok: (raw: Buffer) => boolean, ms = 20_000): Promise<Buffer> {
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
		const has = (name: string, selector: string) =>
			page.evaluate(
				([n, s]) => !!document.getElementById(n as string)?.querySelector(s as string),
				[name, selector],
			);

		it('video under an adjustment layer and a GL blend: the decoded frames reach the compositor', async () => {
			for (const f of [10, 25]) {
				await seek('video', f);
				await seek('videoFlat', f);
				const plain = await until('video', (r) => at(r, 100, 100).some((v) => v > 40));
				await page.waitForTimeout(800);
				const ref = await pixels('video');
				let worst = 255;
				await until('videoFlat', (r) => {
					worst = 0;
					for (let y = 20; y < FX_H; y += 40)
						for (let x = 20; x < FX_W; x += 40) {
							const p = at(ref, x, y);
							const q = at(r, x, y);
							// invert, then linear burn with white (identity)
							for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(q[k]! - (255 - p[k]!)));
						}
					return worst < 12;
				});
				expect(plain.length).toBe(ref.length);
				expect(worst, `frame ${f}`).toBeLessThan(12);
			}
			expect(await has('videoFlat', '[data-flat-compositor]')).toBe(true);
			expect(await has('videoFlat', '[data-canvas-scope-nested]')).toBe(false);
		});

		it('a nest with effects whose nested sequence nests scopes draws as a canvas source', async () => {
			await seek('nest', 5);
			const want = to8(blendPixel('linear-burn', base, mid, 0));
			const raw = await until('nest', (r) => close(at(r, FX_W / 2, FX_H / 2), want, 4));
			expect(close(at(raw, FX_W / 2, FX_H / 2), want, 4), `${at(raw, FX_W / 2, FX_H / 2)} want ${want}`).toBe(
				true,
			);
			expect(await has('nest', '[data-nest-source="canvas"]')).toBe(true);
		});

		it('an adjustment layer over a 3D run', async () => {
			await seek('run', 5);
			const raw = await until(
				'run',
				(r) =>
					close(at(r, 10, 10), to8(invert(base)), 4) && close(at(r, FX_W / 2, FX_H / 2), [0, 255, 255], 6),
			);
			expect(close(at(raw, 10, 10), to8(invert(base)), 4), `corner ${at(raw, 10, 10)}`).toBe(true);
			expect(
				close(at(raw, FX_W / 2, FX_H / 2), [0, 255, 255], 6),
				`centre ${at(raw, FX_W / 2, FX_H / 2)}`,
			).toBe(true);
		});

		it('the HDR display transform keeps running while a GL blend scope draws inside it', async () => {
			await seek('pq', 5);

			// Graphics white of a PQ sequence: 58 % PQ signal (148) shown tone mapped (≈ 230).
			const raw = await until('pq', (r) => at(r, FX_W / 2, FX_H / 2)[0] > 220);
			expect(at(raw, FX_W / 2, FX_H / 2)[0], `${at(raw, FX_W / 2, FX_H / 2)}`).toBeGreaterThan(220);
			expect(await has('pq', '[data-display-chip]')).toBe(false);
			expect(await has('pq', '[data-flat-compositor]')).toBe(true);
		});
	},
);
