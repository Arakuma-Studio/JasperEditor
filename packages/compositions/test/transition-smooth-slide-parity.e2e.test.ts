// @vitest-environment node
// Smooth Slide: Program preview (the Remotion Player in preview mode) against the export render (Remotion
// renderStill, the same frames the Remotion export path and the hybrid span bakes encode), per pixel, over a
// two-sided cut with dolly + reflection + High motion blur and a one-sided head (REMOTION_E2E=1).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@jasper/project';
import { bundleForBrowser } from '@jasper/testkit/browser';
import { decodePng } from '@jasper/testkit/png';
import { type Browser, chromium, type Page } from '@playwright/test';
import type { HeadlessBrowser } from '@remotion/renderer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxAsset, fxSnapshot, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);

const HEAVY = {
	direction: 'left',
	dolly: 0.8,
	reflection: true,
	blurriness: 10,
	falloff: 0.2,
	motionBlur: 'high',
	shutterAngle: 360,
	edgeSmoothing: 'low',
};

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
	'Smooth Slide: preview = export (REMOTION_E2E=1)',
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
			media = await startFxMedia('smooth-slide-parity-');
			const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
			ff(['-f', 'lavfi', '-i', `testsrc2=s=${FX_W}x${FX_H}`, '-frames:v', '1', join(media.dir, 'a.png')]);
			ff(['-f', 'lavfi', '-i', `smptehdbars=s=${FX_W}x${FX_H}`, '-frames:v', '1', join(media.dir, 'b.png')]);
			const image = (ref: string, name: string, at: number, track = 'V1'): Command[] => [
				{
					type: 'media.register',
					ref: `$m${ref}`,
					asset: fxAsset(media, 'image', name, FX_W, FX_H),
				} as Command,
				{
					type: 'clip.place',
					source: { mediaId: `$m${ref}` },
					at,
					sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
					tracks: { video: track },
					ref: `$${ref}`,
				} as unknown as Command,
			];
			docs.cut = fxSnapshot([
				...image('a', 'a.png', 0),
				...image('b', 'b.png', 30),
				{
					type: 'transition.add',
					trackId: 'V1',
					at: 30,
					effectId: 'jasper.smooth-slide',
					duration: 20,
					params: HEAVY,
				} as Command,
			]);
			docs.head = fxSnapshot([
				...image('b', 'b.png', 0),
				{
					type: 'transition.add',
					clipId: '$b',
					edge: 'in',
					effectId: 'jasper.smooth-slide',
					duration: 15,
					params: { direction: 'down', animation: 'easeOutExpo', dolly: 0.5, edgeSmoothing: 'high' },
				} as Command,
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
			await page.waitForFunction(() => {
				const player = (window as unknown as { __fxPlayer?: { frame(n: string): number | null } }).__fxPlayer;
				return player?.frame('cut') != null && player.frame('head') != null;
			});
		}, 300_000);

		afterAll(async () => {
			await browser?.close();
			await renderBrowser?.close({ silent: false });
			media?.close();
		});

		// Decode PNGs in process, retaining exactly the original RGB24 comparison channels and tolerances.
		const raw = (png: Buffer | string) => {
			const image = decodePng(typeof png === 'string' ? readFileSync(png) : png);
			const out = Buffer.alloc(image.width * image.height * 3);
			for (let p = 0, i = 0; p < image.data.length; p += 4, i += 3) {
				out[i] = image.data[p]!;
				out[i + 1] = image.data[p + 1]!;
				out[i + 2] = image.data[p + 2]!;
			}
			return out;
		};

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

		/** The Player frame once it is stable (two identical screenshots in a row after the seek). */
		async function previewed(name: string, frame: number): Promise<Buffer> {
			await page.evaluate(
				([n, f]) =>
					(window as never as { __fxPlayer: { seek(a: string, b: number): void } }).__fxPlayer.seek(
						n as string,
						f as number,
					),
				[name, frame] as const,
			);
			await page.waitForFunction(
				([n, f]) =>
					(window as unknown as { __fxPlayer: { frame(n: string): number | null } }).__fxPlayer.frame(
						n as string,
					) === f,
				[name, frame],
			);
			await page.evaluate(async () => {
				await Promise.all([...document.images].map((image) => image.decode()));
			});
			const t0 = Date.now();
			let prev = raw(await page.locator(`#${name}`).screenshot());
			while (Date.now() - t0 < 20_000) {
				await page.evaluate(
					() =>
						new Promise<void>((resolve) =>
							requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
						),
				);
				const png = await page.locator(`#${name}`).screenshot();
				const cur = raw(png);
				if (cur.equals(prev)) {
					writeFileSync(join(media.dir, `${name}-${frame}-preview.png`), png);
					return cur;
				}
				prev = cur;
			}
			throw new Error(`Player frame did not settle: ${name} at ${frame}`);
		}

		for (const [name, frames] of [
			['cut', [30]],
			['head', [7]],
		] as const)
			it(`${name}: the Player matches the export render at every checked frame`, async () => {
				const lines: string[] = [];
				for (const f of frames) {
					const ref = await exported(name, f);
					const got = await previewed(name, f);
					const r = compare(got, ref, 4);
					lines.push(`f${f} ${r.share.toFixed(4)}/${r.mean.toFixed(3)}`);
					expect(r.share, `${name} frame ${f}`).toBeGreaterThanOrEqual(0.98);
					expect(r.mean, `${name} frame ${f}`).toBeLessThan(1.5);
				}
				console.info(
					`[smooth-slide parity] ${name}: share within 4/255 / mean |Δ|: ${lines.join(' ')}; artifacts ${media.dir}`,
				);
			});
	},
);
