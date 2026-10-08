// @vitest-environment node
// Workstream gaps (EX-3): the smart-rendered H.264 export (`avc3`: copied GOPs keep the source's SPS/PPS, encoded
// ones carry the encoder's) must play in a browser `<video>` — the Program monitor's Player and the desktop app
// (Electron) use Chrome's media stack. Plays the file in a real Google Chrome / Chromium with proprietary codecs:
// no media error, every frame presented in order to the end, and seeks across the copy / encode joins show the
// right frames (the fixture burns the frame number into each frame). Runs when such a browser is found
// (JASPER_BROWSER_EXECUTABLE or the usual Google Chrome paths); H264_PLAYBACK=0 skips it.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { type Browser, chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/opt/google/chrome/chrome',
].find((p): p is string => !!p && existsSync(p));
const run = !!CHROME && process.env.H264_PLAYBACK !== '0';

let app: TestApp;
let browser: Browser;

const settings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
		colorTags: 'rec709',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'auto',
	smartRender: true,
});

/** In the page: plays the video to the end counting presented frames, then seeks and reads the burnt frame codes. */
const probe = async (seeks: number[]) => {
	const v = document.createElement('video');
	v.muted = true;
	v.src = '/smart.mp4';
	document.body.appendChild(v);
	await new Promise<void>((res, rej) => {
		v.onloadeddata = () => res();
		v.onerror = () => rej(new Error(`media error ${v.error?.code} ${v.error?.message}`));
	});
	const presented: number[] = [];
	await new Promise<void>((res, rej) => {
		const tick = (_now: number, meta: { mediaTime: number }) => {
			presented.push(meta.mediaTime);
			if (!v.ended) v.requestVideoFrameCallback(tick as never);
		};
		v.requestVideoFrameCallback(tick as never);
		v.onended = () => res();
		v.onerror = () => rej(new Error(`media error ${v.error?.code} ${v.error?.message}`));
		v.playbackRate = 1;
		void v.play().catch(rej);
		setTimeout(() => rej(new Error(`playback stalled at ${v.currentTime}`)), 20_000);
	});
	const quality = v.getVideoPlaybackQuality();
	const c = document.createElement('canvas');
	c.width = v.videoWidth;
	c.height = v.videoHeight;
	const g = c.getContext('2d', { willReadFrequently: true })!;
	const codes: number[] = [];
	for (const n of seeks) {
		await new Promise<void>((res) => {
			v.onseeked = () => res();
			v.currentTime = (n + 0.5) / 30;
		});
		await new Promise((r) => v.requestVideoFrameCallback(() => r(null)));
		g.drawImage(v, 0, 0);
		// frame-code.mp4: 6 bits, cells at x = 40 + 30 + 70·b, y = 70 (as smart-render.test.ts reads them).
		let code = 0;
		for (let b = 0; b < 6; b++) {
			const px = g.getImageData(40 + 30 + 70 * b, 70, 1, 1).data;
			if (px[0]! > 127) code |= 1 << b;
		}
		codes.push(code);
	}
	return {
		duration: v.duration,
		error: v.error?.code ?? null,
		presented: presented.length,
		monotonic: presented.every((t, i) => i === 0 || t >= presented[i - 1]!),
		corrupted: quality.corruptedVideoFrames ?? 0,
		decoded: quality.totalVideoFrames,
		codes,
	};
};

describe.runIf(run)('smart-rendered H.264 (avc3) in Chrome', () => {
	beforeAll(async () => {
		ensureFixtures();
		app = await makeApp();
		browser = await chromium.launch({ executablePath: CHROME!, headless: true });
	}, 120_000);
	afterAll(async () => {
		await browser?.close();
		await closeApps();
	});

	it('plays to the end with every frame and seeks across the copy / encode joins', async () => {
		const coded = await register(app, fixture('frame-code.mp4'));
		const d = new DocBuilder();
		const m = d.addMedia(coded);
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				audio: false,
				sourceRange: { in: { sourceFrames: 10 }, out: { sourceFrames: 64 } },
			},
		]);
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(start.statusCode, start.body).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error, JSON.stringify(done.error)).toBeUndefined();
		expect((done.result as { renderPath: string }).renderPath).toBe('copy');
		const file = (await coreServices(app).exports.outputFile(start.json().id))!;
		const bytes = readFileSync(file);
		if (process.env.GAPS_DUMP) copyFileSync(file, process.env.GAPS_DUMP);
		const page = await browser.newPage();
		await page.route('**/smart.mp4', (route) =>
			route.fulfill({ status: 200, contentType: 'video/mp4', body: bytes }),
		);
		await page.route('**/index.html', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' }),
		);
		await page.goto('http://jasper.test/index.html');
		const seeks = [0, 19, 20, 21, 40, 53];
		const r = await page.evaluate(probe, seeks);
		expect(r.error).toBeNull();
		expect(r.duration).toBeCloseTo(54 / 30, 1);
		expect(r.corrupted).toBe(0);
		expect(r.monotonic).toBe(true);
		// Headless Chrome may skip presenting a frame under load, never decoding one.
		expect(r.decoded).toBeGreaterThanOrEqual(54);
		expect(r.presented).toBeGreaterThanOrEqual(48);
		expect(r.codes).toEqual(seeks.map((n) => n + 10));
	}, 300_000);
});
