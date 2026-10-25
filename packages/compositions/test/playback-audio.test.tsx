// @vitest-environment node
// Real preview consumption of undecodable audio: no simulated Remotion media component or private stream sentinel.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRenderSnapshot, FLICKS_PER_SECOND, type MediaHandle } from '@jasper/project';
import { bundleForBrowser, findChrome } from '@jasper/testkit/browser';
import { pixel } from '@jasper/testkit/image';
import { oraclesAvailable } from '@jasper/testkit/oracle';
import { decodePng } from '@jasper/testkit/png';
import { type Browser, type BrowserContext, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, videoAsset } from '../../project/test/helpers.ts';
import { type FxMedia, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = findChrome();
const artifacts = join(
	process.env.JASPER_TEST_RESULTS ?? join(here, '../../..', 'test-results'),
	'playback-audio',
);

describe.runIf(!!CHROME && oraclesAvailable('ffmpeg'))(
	'Playback audio in actual Source and Program previews',
	{ timeout: 30_000 },
	() => {
		let media: FxMedia;
		let browser: Browser;
		let context: BrowserContext;
		let playback: MediaHandle;
		beforeAll(async () => {
			media = await startFxMedia('playback-audio-');
			mkdirSync(artifacts, { recursive: true });
			const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
			ff([
				'-f',
				'lavfi',
				'-i',
				'color=red:s=64x36:r=30:d=0.5',
				'-f',
				'lavfi',
				'-i',
				'color=blue:s=64x36:r=30:d=0.5',
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=110:sample_rate=48000:duration=1',
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=220:sample_rate=48000:duration=1',
				'-filter_complex',
				'[0:v][1:v]concat=n=2:v=1:a=0[v]',
				'-map',
				'[v]',
				'-map',
				'2:a',
				'-map',
				'3:a',
				'-c:v',
				'libvpx-vp9',
				'-lossless',
				'1',
				'-pix_fmt',
				'yuv420p',
				'-c:a',
				'ac3',
				'-ac',
				'2',
				join(media.dir, 'original.mkv'),
			]);
			ff([
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=220:sample_rate=48000:duration=1',
				'-c:a',
				'wmav2',
				join(media.dir, 'original.wma'),
			]);
			for (const [name, stream] of [
				['one.wav', 1],
				['two.wav', 2],
			] as const)
				ff([
					'-i',
					join(media.dir, 'original.mkv'),
					'-map',
					`0:${stream}`,
					'-vn',
					'-c:a',
					'pcm_f32le',
					join(media.dir, name),
				]);
			ff([
				'-i',
				join(media.dir, 'original.wma'),
				'-ac',
				'2',
				'-c:a',
				'pcm_f32le',
				join(media.dir, 'wma.wav'),
			]);
			const [entry, worklet] = await Promise.all([
				bundleForBrowser(join(here, 'playback-audio', 'entry.tsx')),
				bundleForBrowser(join(here, '..', 'src', 'audio', 'worklet.ts')),
			]);
			media.page('bundle.js', 'text/javascript', entry);
			media.page('worklet.js', 'text/javascript', worklet);
			playback = {
				url: `${media.base}/original.mkv`,
				proxyUrl: null,
				kind: 'video',
				width: 64,
				height: 36,
				durationFlicks: FLICKS_PER_SECOND,
				hasAudio: true,
				rotation: 0,
				playbackAudio: { '1': `${media.base}/one.wav`, '2': `${media.base}/two.wav` },
			};
			browser = await chromium.launch({
				executablePath: CHROME!,
				args: ['--autoplay-policy=no-user-gesture-required'],
			});
			context = await browser.newContext({ viewport: { width: 64, height: 36 } });
		}, 120_000);
		afterAll(async () => {
			await browser?.close();
			media?.close();
			if (media) rmSync(media.dir, { recursive: true, force: true });
		});

		function document(handle: MediaHandle) {
			const h = new Harness();
			const asset = videoAsset({ seconds: 1, width: 64, height: 36, fps: { num: 30, den: 1 } });
			const video = asset.probe.streams.find((s) => s.type === 'video')!;
			const audio = asset.probe.streams.find((s) => s.type === 'audio')!;
			video.codec = 'vp9';
			audio.codec = 'ac3';
			asset.probe.streams.push({ ...audio, index: 2 });
			asset.container = 'matroska,webm';
			const r = h.ok([
				{
					type: 'sequence.updateSettings',
					settings: { width: 64, height: 36, frameRate: { num: 30, den: 1 } },
				},
				{ type: 'media.register', asset, ref: '$media' },
				{
					type: 'clip.place',
					source: { mediaId: '$media' },
					at: 0,
					video: handle.kind === 'video',
					tracks: { video: 'V1', audio: 'A1' },
				},
			]);
			h.ok([
				{
					type: 'clip.setAudioChannels',
					clipIds: [h.clips('A1')[0]!.id],
					channels: [{ streamIndex: 2, map: [0, 1] }],
				},
			]);
			return buildRenderSnapshot(h.doc, h.seqId, {
				resolveMedia: (m) => (m.id === r.refs.$media ? handle : null),
				resolveFont: () => null,
			});
		}

		async function played(
			mode: 'source' | 'program',
			handle: MediaHandle,
			band: readonly [number, number] | null,
		) {
			const page = await context.newPage();
			const picture = handle.kind === 'video';
			const errors: string[] = [];
			const requests = new Set<string>();
			page.on('pageerror', (e) => errors.push(e.message));
			page.on('request', (r) => {
				if (r.url().endsWith('.wav')) requests.add(new URL(r.url()).pathname);
			});
			const name = `index-${mode}-${handle.kind}-${band ? 'ready' : 'pending'}.html`;
			media.page(
				name,
				'text/html',
				`<!doctype html><html><body style="margin:0"><div id="player"></div><script>window.__config=${JSON.stringify(mode === 'source' ? { mode, media: handle } : { mode, doc: document(handle) })}</script><script src="/bundle.js"></script></body></html>`,
			);
			try {
				await page.goto(`${media.base}/${name}`);
				await page.waitForFunction(
					() =>
						(window as unknown as { __playback?: { frame(): number | null } }).__playback?.frame() != null,
					undefined,
					{ timeout: 5000 },
				);
				if (picture) {
					await expect.poll(async () => near(await centre(page), [255, 0, 0])).toBe(true);
					await page.evaluate(() =>
						(window as unknown as { __playback: { seek(frame: number): void } }).__playback.seek(20),
					);
					await expect.poll(async () => near(await centre(page), [0, 0, 255])).toBe(true);
					await page.locator('#player').screenshot({
						path: join(artifacts, `${mode}-${handle.kind}-${band ? 'ready' : 'pending'}-blue.png`),
					});
					await page.evaluate(() =>
						(window as unknown as { __playback: { seek(frame: number): void } }).__playback.seek(0),
					);
				}
				await page.evaluate(() => (window as unknown as { __playback: { play(): void } }).__playback.play());
				await page.waitForFunction(
					() => (window as unknown as { __playback: { ended(): boolean } }).__playback.ended(),
					undefined,
					{ timeout: 5000 },
				);
				const signal = await page.evaluate(() =>
					(
						window as unknown as { __playback: { signal(): { rms: number; hz: number } } }
					).__playback.signal(),
				);
				console.info(
					'[playback-audio]',
					JSON.stringify({ mode, band, picture, signal, requests: [...requests] }),
				);
				expect(errors).toEqual([]);
				if (band) {
					expect(signal.rms).toBeGreaterThan(0.04);
					expect(signal.hz).toBeGreaterThanOrEqual(band[0]);
					expect(signal.hz).toBeLessThanOrEqual(band[1]);
				} else expect(signal.rms).toBe(0);
			} finally {
				await page.close();
			}
		}
		async function centre(page: Page) {
			return pixel(decodePng(await page.locator('#player').screenshot()), 32, 18).slice(0, 3);
		}
		const near = (got: number[], wanted: number[]) => got.every((v, i) => Math.abs(v - wanted[i]!) <= 5);

		it('Program decodes its selected playback stream and video frames; pending audio stays silent', async () => {
			await played('program', playback, [200, 240]);
			await played('program', { ...playback, playbackAudio: null }, null);
		});
		it('Source decodes video frames and its first playback stream; pending video/audio sources stay silent', async () => {
			await played('source', playback, [100, 130]);
			await played('source', { ...playback, playbackAudio: null }, null);
			const audio: MediaHandle = {
				...playback,
				kind: 'audio',
				url: `${media.base}/original.wma`,
				playbackAudio: { '0': `${media.base}/wma.wav` },
				width: null,
				height: null,
			};
			await played('source', audio, [200, 240]);
			await played('source', { ...audio, playbackAudio: null }, null);
		});
	},
);
