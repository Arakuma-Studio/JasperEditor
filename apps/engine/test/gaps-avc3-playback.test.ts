// @vitest-environment node
// avc3 copied GOPs retain source SPS/PPS while encoded GOPs carry the encoder's; Chrome must decode both across joins.
// A browser with proprietary codecs is required; H264_PLAYBACK=0 disables the probe.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
	ROOT,
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
const ELECTRON = (() => {
	try {
		const p = createRequire(join(ROOT, 'apps', 'desktop', 'package.json'))('electron') as unknown;
		return typeof p === 'string' && existsSync(p) ? p : null;
	} catch {
		return null;
	}
})();

let app: TestApp;
let browser: Browser;
let smartFile: string | null = null;

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
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'auto',
	smartRender: true,
});

/**
 * In the page: plays the video from `from` (seconds) to the end at half speed, reading the frame code burnt into every
 * presented frame (frame-code.mp4: 6 bits at x = 40 + 30 + 70·b, y = 70 — as smart-render.test.ts reads them).
 * Playback callbacks trigger immutable snapshots whose own timestamps identify the pixels being read.
 * Callbacks may skip frames. Exact join/seek frames are checked separately while paused, after seeked:
 * drawImage(video) reads the current playback frame, independently of presentation-callback delivery.
 */
const probe = async ({
	src,
	from,
	seekFrames = [],
}: {
	src: string | number[];
	from: number;
	seekFrames?: number[];
}) => {
	const v = document.createElement('video');
	v.muted = true;
	v.src =
		typeof src === 'string'
			? src
			: URL.createObjectURL(new Blob([Uint8Array.from(src)], { type: 'video/mp4' }));
	document.body.appendChild(v);
	await new Promise<void>((res, rej) => {
		v.onloadeddata = () => res();
		v.onerror = () => rej(new Error(`media error ${v.error?.code} ${v.error?.message}`));
	});
	if (from > 0)
		await new Promise<void>((res) => {
			v.onseeked = () => res();
			v.currentTime = from;
		});
	const startTime = v.currentTime;
	const c = document.createElement('canvas');
	c.width = v.videoWidth;
	c.height = v.videoHeight;
	const g = c.getContext('2d', { willReadFrequently: true })!;
	const readCode = (source: CanvasImageSource = v) => {
		g.drawImage(source, 0, 0);
		let code = 0;
		for (let b = 0; b < 6; b++) if (g.getImageData(40 + 30 + 70 * b, 70, 1, 1).data[0]! > 127) code |= 1 << b;
		return code;
	};
	const seen: [number, number][] = [];
	let callback = 0;
	await new Promise<void>((res, rej) => {
		const tick = () => {
			try {
				const frame = new VideoFrame(v);
				try {
					seen.push([Math.round((frame.timestamp / 1e6) * 30), readCode(frame)]);
				} finally {
					frame.close();
				}
			} catch (error) {
				clearTimeout(timer);
				rej(error);
				return;
			}
			if (!v.ended) callback = v.requestVideoFrameCallback(tick);
		};
		callback = v.requestVideoFrameCallback(tick);
		v.onended = () => {
			clearTimeout(timer);
			v.cancelVideoFrameCallback(callback);
			res();
		};
		v.onerror = () => rej(new Error(`media error ${v.error?.code} ${v.error?.message}`));
		v.playbackRate = 0.5;
		void v.play().catch(rej);
		const timer = setTimeout(() => rej(new Error(`playback stalled at ${v.currentTime}`)), 30_000);
	});
	const ended = v.ended;
	const sought: { currentTime: number; code: number; seeking: boolean; readyState: number }[] = [];
	for (const frame of seekFrames) {
		v.pause();
		await new Promise<void>((res, rej) => {
			const timer = setTimeout(
				() =>
					rej(
						new Error(`seek frame ${frame} stalled at ${v.currentTime}; samples ${JSON.stringify(sought)}`),
					),
				30_000,
			);
			v.onseeked = () => {
				clearTimeout(timer);
				res();
			};
			v.onerror = () => rej(new Error(`media error ${v.error?.code} ${v.error?.message}`));
			v.currentTime = (frame + 0.5) / 30;
		});
		sought.push({
			currentTime: v.currentTime,
			code: readCode(),
			seeking: v.seeking,
			readyState: v.readyState,
		});
	}
	const result = { duration: v.duration, startTime, ended, error: v.error?.code ?? null, seen, sought };
	v.remove();
	if (typeof src !== 'string') URL.revokeObjectURL(v.src);
	return result;
};

function expectSeekFrames(sought: Awaited<ReturnType<typeof probe>>['sought']): void {
	expect(sought.map(({ currentTime, code }) => [Math.floor(currentTime * 30), code])).toEqual([
		[19, 29],
		[20, 30],
		[30, 40],
		[5, 15],
	]);
	for (const frame of sought) {
		expect(frame.seeking).toBe(false);
		expect(frame.readyState).toBeGreaterThanOrEqual(2);
	}
}

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

	it('plays to the end with correct frame codes and seeks across the copy / encode joins', async () => {
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
		smartFile = file;
		// Materialize the MP4 so Chrome can seek without an HTTP range fixture.
		const bytes = Array.from(readFileSync(file));
		if (process.env.GAPS_DUMP) copyFileSync(file, process.env.GAPS_DUMP);
		const page = await browser.newPage();
		await page.route('**/index.html', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' }),
		);
		await page.goto('http://localhost/index.html');
		// From the start: the encoded GOPs (frames 0–19), the join, the copied source GOPs (20–53).
		const all = await page.evaluate(probe, { src: bytes, from: 0, seekFrames: [19, 20, 30, 5] });
		writeFileSync(`${file}.chrome.json`, JSON.stringify({ all }, null, 2));
		expect(all.error).toBeNull();
		expect(all.ended).toBe(true);
		expect(all.duration).toBeCloseTo(54 / 30, 1);
		expect(all.seen.length).toBeGreaterThan(0);
		for (const [n, code] of all.seen) expect(code, `frame ${n}`).toBe(n + 10);
		expectSeekFrames(all.sought);
		// Seeking into a copied GOP (its SPS/PPS are in band) and back into the encoded part.
		for (const from of [30 / 30, 5 / 30]) {
			await page.reload();
			const r = await page.evaluate(probe, { src: bytes, from: from + 0.5 / 30 });
			writeFileSync(`${file}.chrome-seek-${from * 30}.json`, JSON.stringify(r, null, 2));
			expect(r.error).toBeNull();
			expect(Math.floor(r.startTime * 30)).toBe(from * 30);
			expect(r.ended).toBe(true);
			expect(r.seen.length).toBeGreaterThan(0);
			for (const [n, code] of r.seen) expect(code, `frame ${n} after a seek to ${from * 30}`).toBe(n + 10);
		}
	}, 300_000);

	it.runIf(!!ELECTRON)(
		'plays in Electron with correct frame codes and seeks across the joins',
		() => {
			expect(smartFile).toBeTruthy();
			const dir = mkdtempSync(join(tmpdir(), 'jasper-avc3-electron-'));
			copyFileSync(smartFile!, join(dir, 'smart.mp4'));
			writeFileSync(join(dir, 'page.html'), '<!doctype html><body></body>');
			writeFileSync(
				join(dir, 'main.cjs'),
				`const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, 'page.html'));
  const r = await win.webContents.executeJavaScript(${JSON.stringify(`(${probe.toString()})({ src: 'smart.mp4', from: 0, seekFrames: [19, 20, 30, 5] })`)});
  console.log('RESULT ' + JSON.stringify(r));
  app.quit();
}).catch((e) => { console.log('RESULT ' + JSON.stringify({ fail: String(e) })); app.quit(); });
`,
			);
			const r = spawnSync(ELECTRON!, ['--no-sandbox', '--ozone-platform=headless', join(dir, 'main.cjs')], {
				env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', ELECTRON_RUN_AS_NODE: '' },
				timeout: 120_000,
				encoding: 'utf8',
			});
			const line = `${r.stdout}`.split('\n').find((l) => l.startsWith('RESULT '));
			expect(line, r.stderr?.slice(-2000)).toBeTruthy();
			const res = JSON.parse(line!.slice(7)) as Awaited<ReturnType<typeof probe>>;
			writeFileSync(join(dir, 'result.json'), JSON.stringify(res, null, 2));
			expect(res.error).toBeNull();
			expect(res.ended).toBe(true);
			expect(res.duration).toBeCloseTo(54 / 30, 1);
			expect(res.seen.length).toBeGreaterThan(0);
			for (const [n, code] of res.seen) expect(code, `frame ${n}`).toBe(n + 10);
			expectSeekFrames(res.sought);
		},
		180_000,
	);
});
