// @vitest-environment node
// Corner Pin motion blur: Program preview (the Remotion Player in preview mode) against the export render (Remotion
// renderStill, the frames the Remotion export path and the layer bakes encode), per pixel, on a perspective pin
// that tracks unevenly (per-frame keys: time-warped, jittered taps) at Transform's 360° shutter (REMOTION_E2E=1).
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { bundleForBrowser } from '@jasper/testkit/browser';
import { type Browser, chromium, type Page } from '@playwright/test';
import type { HeadlessBrowser } from '@remotion/renderer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxPixels, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);

/** A tracked screen: a perspective quad that moves unevenly, one key per frame (the shape Apply Tracking writes). */
function trackedPin(f: number): Record<string, [number, number]> {
	const x = 0.012 * f + 0.06 * Math.sin(f / 2.5);
	const y = 0.02 * Math.cos(f / 3);
	return {
		topLeft: [0.15 + x, 0.12 + y],
		topRight: [0.7 + x, 0.2 + y],
		bottomRight: [0.75 + x, 0.85 + y],
		bottomLeft: [0.1 + x, 0.8 + y],
	};
}

function compare(a: Buffer, b: Buffer, tol: number) {
	expect(a.length).toBe(b.length);
	let n = 0;
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		const d = Math.abs(a[i]! - b[i]!);
		if (d <= tol) n++;
		sum += d;
	}
	return { share: n / a.length, mean: sum / a.length };
}

describe.runIf(enabled && !!CHROME)(
	'Corner Pin motion blur: preview = export (REMOTION_E2E=1)',
	{ timeout: 240_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		let browser: Browser;
		let renderBrowser: HeadlessBrowser;
		let page: Page;
		const docs: Record<string, ReturnType<typeof fxSnapshot>> = {};
		const browserOpts = { browserExecutable: CHROME!, chromeMode: 'chrome-for-testing' as const };

		beforeAll(async () => {
			media = await startFxMedia('corner-pin-blur-parity-');
			execFileSync('ffmpeg', [
				...['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${FX_W}x${FX_H}`],
				...['-frames:v', '1', join(media.dir, 'a.png')],
			]);
			docs.pin = fxSnapshot([
				{ type: 'media.register', ref: '$m', asset: fxAsset(media, 'image', 'a.png', FX_W, FX_H) } as Command,
				{
					type: 'clip.place',
					source: { mediaId: '$m' },
					at: 0,
					sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
					tracks: { video: 'V1' },
					ref: '$a',
				} as unknown as Command,
				{
					type: 'effect.add',
					target: { clipId: '$a' },
					effectId: 'jasper.corner-pin',
					params: { useCompShutterAngle: false, shutterAngle: 360 },
					ref: '$fx',
				} as Command,
				...Array.from({ length: 21 }, (_, f) =>
					Object.entries(trackedPin(f)).map(
						([name, value]) =>
							({
								type: 'keyframe.add',
								target: ['effect', '$fx', name],
								at: { sequenceFrame: f },
								value,
							}) as unknown as Command,
					),
				).flat(),
			]);
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, '..', 'src', 'remotion-entry.ts') });
			renderer = await import('@remotion/renderer');
			renderBrowser = await renderer.openBrowser('chrome', browserOpts);
			const code = await bundleForBrowser(join(here, 'fx-player', 'entry.tsx'));
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
			page = await browser.newPage({ viewport: { width: FX_W, height: FX_H * 3 } });
			await page.goto(`${media.base}/index.html`);
		}, 300_000);

		afterAll(async () => {
			await browser?.close();
			await renderBrowser?.close({ silent: false });
			media?.close();
		});

		const raw = (png: Buffer | string) => fxPixels(typeof png === 'string' ? readFileSync(png) : png);

		async function exported(name: string, frame: number): Promise<Buffer> {
			const inputProps = {
				doc: docs[name],
				options: { isPreview: false, useProxies: false, transparentBackground: false },
			};
			const composition = await renderer.selectComposition({
				serveUrl,
				id: SEQUENCE_COMPOSITION_ID,
				inputProps,
				...browserOpts,
				puppeteerInstance: renderBrowser,
			});
			const output = join(media.dir, `${name}-${frame}.png`);
			await renderer.renderStill({
				composition,
				serveUrl,
				inputProps,
				frame,
				output,
				...browserOpts,
				puppeteerInstance: renderBrowser,
			});
			return raw(output);
		}

		/** Capture after the Player's decoder, effect and paint receipts complete. */
		async function previewed(name: string, frame: number): Promise<Buffer> {
			await page.evaluate(
				([n, f]) =>
					(window as never as { __fxPlayer: { seek(a: string, b: number): Promise<void> } }).__fxPlayer.seek(
						n,
						f,
					),
				[name, frame] as const,
			);
			const png = await page.locator(`#${name}`).screenshot();
			writeFileSync(join(media.dir, `${name}-${frame}-preview.png`), png);
			return raw(png);
		}

		it('the Player matches the export render on blurred tracked frames', async () => {
			const lines: string[] = [];
			for (const f of [4, 9, 15]) {
				const ref = await exported('pin', f);
				const got = await previewed('pin', f);
				const r = compare(got, ref, 4);
				lines.push(`f${f} ${r.share.toFixed(4)}/${r.mean.toFixed(3)}`);
				expect(r.share, `frame ${f}`).toBeGreaterThanOrEqual(0.98);
				expect(r.mean, `frame ${f}`).toBeLessThan(1.5);
			}
			const line = `[corner-pin-blur parity] share within 4/255 / mean |Δ|: ${lines.join(' ')}; artifacts ${media.dir}`;
			console.info(line);
			appendFileSync(join(tmpdir(), 'corner-pin-blur-parity.txt'), `${new Date().toISOString()} ${line}\n`);
		});
	},
);
