// @vitest-environment node
// The retime decoder (src/retime/frames.ts) in headless Chrome on real H.264 files: every requested media time shows
// the frame whose timestamp is at or before it — forwards, backwards (GOP cache), random order, and on variable-frame-
// rate media by the real timestamps. Runs when a Chrome is found; RETIME_GL=0 skips it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleGlEntry, CHROME } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MEDIA = join(here, '../../../fixtures/media');
const have =
	existsSync(join(MEDIA, 'frame-code.mp4')) &&
	existsSync(join(MEDIA, 'frame-code-aac.mp4')) &&
	existsSync(join(MEDIA, 'vfr-code.mp4'));

describe.runIf(!!CHROME && have && process.env.RETIME_GL !== '0')(
	'retime frame source (headless Chrome)',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string, arg: unknown): Promise<T> =>
			page.evaluate(
				([n, a]) =>
					(window as unknown as { __frames: Record<string, (a?: string) => unknown> }).__frames[n]!(a),
				[name, JSON.stringify(arg)] as const,
			) as Promise<T>;

		beforeAll(async () => {
			const script = await bundleGlEntry(join(here, 'retime-frames', 'entry.ts'));
			browser = await chromium.launch({
				executablePath: CHROME,
				args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
			});
			page = await browser.newPage({ ignoreHTTPSErrors: true });
			await page.route('https://media.test/**', async (route) => {
				const name = new URL(route.request().url()).pathname.slice(1);
				if (name === 'index.html')
					return route.fulfill({
						status: 200,
						contentType: 'text/html',
						body: '<!doctype html><html><body></body></html>',
					});
				const body = readFileSync(join(MEDIA, name));
				const range = route.request().headers().range;
				if (range) {
					const m = /bytes=(\d+)-(\d*)/.exec(range)!;
					const a = Number(m[1]);
					const b = m[2] ? Number(m[2]) : body.length - 1;
					await route.fulfill({
						status: 206,
						headers: {
							'content-type': 'video/mp4',
							'accept-ranges': 'bytes',
							'content-range': `bytes ${a}-${b}/${body.length}`,
							'access-control-allow-origin': '*',
						},
						body: body.subarray(a, b + 1),
					});
				} else
					await route.fulfill({
						status: 200,
						headers: {
							'content-type': 'video/mp4',
							'accept-ranges': 'bytes',
							'access-control-allow-origin': '*',
						},
						body,
					});
			});
			await page.goto('https://media.test/index.html');
			await page.addScriptTag({ content: script });
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it('CFR: forward, backward and random access show the right frame', async () => {
			const times = [
				0,
				0.5,
				1 / 30,
				39 / 30 + 0.001,
				38 / 30,
				30 / 30,
				29 / 30 + 0.0001,
				12 / 30,
				63 / 30,
				2.5,
			].map((t) => t);
			const r = await call<{ out: { t: number; code: number }[] }>('codes', {
				src: 'https://media.test/frame-code.mp4',
				w: 960,
				h: 540,
				scale: 0.5,
				times,
			});
			expect(r.out.map((o) => o.code)).toEqual([0, 15, 1, 39, 38, 30, 29, 12, 63, 63]);
			const rev = Array.from({ length: 40 }, (_, k) => (39 - k) / 30 + 0.001);
			const r2 = await call<{ out: { code: number }[] }>('codes', {
				src: 'https://media.test/frame-code.mp4',
				w: 960,
				h: 540,
				scale: 0.5,
				times: rev,
			});
			expect(r2.out.map((o) => o.code)).toEqual(Array.from({ length: 40 }, (_, k) => 39 - k));
		});

		it('full-size decode, reverse across GOPs', async () => {
			const rev = Array.from({ length: 40 }, (_, k) => (39 - k) / 30 + 0.001);
			const r = await call<{ out: { code: number; time: number }[] }>('codes', {
				src: 'https://media.test/frame-code.mp4',
				w: 1920,
				h: 1080,
				scale: 1,
				times: rev,
			});
			expect(r.out.map((o) => o.code)).toEqual(Array.from({ length: 40 }, (_, k) => 39 - k));
		});

		it('an AAC track with encoder priming does not shift the frames (media time 0 = ffmpeg start_time)', async () => {
			// Regression (verify workstream): the audio's first packet is at -0.0213 s (priming hidden by the MP4 edit list,
			// ffmpeg's start_time 0). Taken as the file origin, every frame was 21 ms late and a time exactly on frame n
			// showed frame n − 1 — remapped clips rendered one frame early in Remotion against the native export.
			const times = [0, 1 / 30, 5 / 30, 12 / 30, 30 / 30, 39 / 30, 63 / 30];
			const r = await call<{ out: { code: number; time: number }[] }>('codes', {
				src: 'https://media.test/frame-code-aac.mp4',
				w: 960,
				h: 540,
				scale: 0.5,
				times,
			});
			expect(r.out.map((o) => o.code)).toEqual([0, 1, 5, 12, 30, 39, 63]);
			expect(r.out[2]!.time).toBeCloseTo(5 / 30, 3);
		});

		it('VFR: frames by their real timestamps', async () => {
			// Frame n of vfr-code.mp4 is at n/30 + 0.01·(n mod 3).
			const t = (n: number) => n / 30 + 0.01 * (n % 3);
			const times = [0.04, 0.05, t(5) - 0.001, t(5), t(20) + 0.005, 0.1];
			const r = await call<{ out: { code: number }[]; next: number }>('codes', {
				src: 'https://media.test/vfr-code.mp4',
				w: 640,
				h: 360,
				scale: 1,
				times,
			});
			expect(r.out.map((o) => o.code)).toEqual([0, 1, 4, 5, 20, 3]);
			expect(r.next).toBeCloseTo(t(1), 3);
		});
	},
);
