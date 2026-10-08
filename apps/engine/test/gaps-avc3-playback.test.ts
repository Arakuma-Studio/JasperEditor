// @vitest-environment node
// Workstream gaps (EX-3): the smart-rendered H.264 export (`avc3`: copied GOPs keep the source's SPS/PPS, encoded
// ones carry the encoder's) must play in a browser `<video>` — the Program monitor's Player and the desktop app
// (Electron) use Chrome's media stack. Plays the file in a real Google Chrome / Chromium with proprietary codecs:
// no media error, every frame presented in order to the end, and seeks across the copy / encode joins show the
// right frames (the fixture burns the frame number into each frame). Runs when such a browser is found
// (JASPER_BROWSER_EXECUTABLE or the usual Google Chrome paths); H264_PLAYBACK=0 skips it.
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
/** The desktop app's Electron binary (apps/desktop's dependency), when installed. */
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
		colorTags: 'rec709',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'auto',
	smartRender: true,
});

/**
 * In the page: plays the video from `from` (seconds) to the end at half speed, reading the frame code burnt into every
 * presented frame (frame-code.mp4: 6 bits at x = 40 + 30 + 70·b, y = 70 — as smart-render.test.ts reads them).
 * Returns [presented frame index, code] pairs. (Headless Chrome does not repaint a paused video after a seek, so the
 * codes are read while playing.)
 */
const probe = async (from: number) => {
	const v = document.createElement('video');
	v.muted = true;
	v.src = '/smart.mp4';
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
	const c = document.createElement('canvas');
	c.width = v.videoWidth;
	c.height = v.videoHeight;
	const g = c.getContext('2d', { willReadFrequently: true })!;
	const seen: [number, number][] = [];
	await new Promise<void>((res, rej) => {
		const tick = (_now: number, meta: { mediaTime: number }) => {
			g.drawImage(v, 0, 0);
			let code = 0;
			for (let b = 0; b < 6; b++)
				if (g.getImageData(40 + 30 + 70 * b, 70, 1, 1).data[0]! > 127) code |= 1 << b;
			seen.push([Math.round(meta.mediaTime * 30), code]);
			if (!v.ended) v.requestVideoFrameCallback(tick as never);
		};
		v.requestVideoFrameCallback(tick as never);
		v.onended = () => res();
		v.onerror = () => rej(new Error(`media error ${v.error?.code} ${v.error?.message}`));
		v.playbackRate = 0.5;
		void v.play().catch(rej);
		setTimeout(() => rej(new Error(`playback stalled at ${v.currentTime}`)), 30_000);
	});
	return { duration: v.duration, error: v.error?.code ?? null, seen };
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
		smartFile = file;
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
		// From the start: the encoded GOPs (frames 0–19), the join, the copied source GOPs (20–53).
		const all = await page.evaluate(probe, 0);
		expect(all.error).toBeNull();
		expect(all.duration).toBeCloseTo(54 / 30, 1);
		expect(all.seen.length).toBeGreaterThanOrEqual(45);
		for (const [n, code] of all.seen) expect(code, `frame ${n}`).toBe(n + 10);
		expect(all.seen.some(([n]) => n === 19) && all.seen.some(([n]) => n === 20)).toBe(true);
		// Seeking into a copied GOP (its SPS/PPS are in band) and back into the encoded part.
		for (const from of [30 / 30, 5 / 30]) {
			await page.reload();
			const r = await page.evaluate(probe, from + 0.5 / 30);
			expect(r.error).toBeNull();
			expect(r.seen.length).toBeGreaterThan(10);
			for (const [n, code] of r.seen) expect(code, `frame ${n} after a seek to ${from * 30}`).toBe(n + 10);
		}
	}, 300_000);

	// The desktop app: Electron's own Chromium (with its proprietary codecs), headless (Ozone), the same probe.
	it.runIf(!!ELECTRON)(
		'plays in Electron with every frame code right',
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
  const r = await win.webContents.executeJavaScript(\`(async () => {
    const v = document.createElement('video'); v.muted = true; v.src = 'smart.mp4'; document.body.appendChild(v);
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('media error ' + v.error?.code)); });
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext('2d', { willReadFrequently: true }); const seen = [];
    const tick = (_t, meta) => { g.drawImage(v, 0, 0); let code = 0;
      for (let b = 0; b < 6; b++) if (g.getImageData(40 + 30 + 70 * b, 70, 1, 1).data[0] > 127) code |= 1 << b;
      seen.push([Math.round(meta.mediaTime * 30), code]); if (!v.ended) v.requestVideoFrameCallback(tick); };
    v.requestVideoFrameCallback(tick); v.playbackRate = 0.5; await v.play();
    await new Promise((res) => { v.onended = res; setTimeout(res, 30000); });
    return { ended: v.ended, error: v.error ? v.error.code : null, seen };
  })()\`);
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
			const res = JSON.parse(line!.slice(7)) as {
				ended: boolean;
				error: number | null;
				seen: [number, number][];
			};
			expect(res.error).toBeNull();
			expect(res.ended).toBe(true);
			expect(res.seen.length).toBeGreaterThanOrEqual(45);
			for (const [n, code] of res.seen) expect(code, `frame ${n}`).toBe(n + 10);
		},
		180_000,
	);
});
