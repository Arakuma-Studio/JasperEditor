// Warm render browsers and the document's composition against the real bundle and Chrome (wp-note
// export-performance §13). Opt-in: REMOTION_E2E=1 (bundles the compositions, opens headless Chrome).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sequenceComposition } from '@jasper/compositions/render-host';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemotionService } from '../src/remotion/service.ts';

const enabled = process.env.REMOTION_E2E === '1';

const doc = (width: number, height: number, fps: { num: number; den: number }, durationFrames: number) => ({
	version: 1,
	sequenceId: 'seq_WARM0000000000',
	settings: { width, height, fps, backgroundColor: [0, 0, 0, 1], sampleRate: 48000 },
	range: { start: 0, end: durationFrames },
	durationFrames,
	videoTracks: [],
	audioClips: [],
	media: {},
	fonts: [],
	master: { volumeDb: { value: 0, keyframes: [] } },
	warnings: [],
});

describe.runIf(enabled)('warm render browsers (REMOTION_E2E=1)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'jasper-warm-'));
	let svc: RemotionService;

	beforeAll(async () => {
		svc = new RemotionService({
			bundleCacheDir: join(dir, 'bundle'),
			usageLog: null,
			prebuiltBundleDir: null,
			env: { ...process.env, JASPER_RENDER_BROWSERS_IDLE: '2' },
		});
		await svc.serveUrl();
	}, 240_000);

	afterAll(async () => {
		await svc?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it('resolves the sequence composition exactly as the bundle does', async () => {
		const r = await import('@remotion/renderer');
		const serveUrl = await svc.renderServeUrl();
		expect(serveUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
		const shared = await svc.openSharedBrowser();
		try {
			for (const inputProps of [
				{
					doc: doc(1080, 1350, { num: 30, den: 1 }, 180),
					options: { isPreview: false, transparentBackground: true },
				},
				{
					doc: doc(1920, 1080, { num: 30000, den: 1001 }, 0),
					options: { isPreview: false, useProxies: true },
				},
			]) {
				const selected = await r.selectComposition({
					serveUrl,
					id: 'JasperSequence',
					inputProps,
					logLevel: 'error',
					puppeteerInstance: shared.instance,
					...(svc.binariesDirectory ? { binariesDirectory: svc.binariesDirectory } : {}),
				});
				expect(sequenceComposition(inputProps)).toEqual(selected);
			}
		} finally {
			await shared.close();
		}
	}, 240_000);

	it('hands the browser of one render to the next, and replaces one that died while idle', async () => {
		const before = svc.browserPoolStats;
		const first = await svc.openSharedBrowser();
		const instance = first.instance;
		await first.close();
		const second = await svc.openSharedBrowser();
		expect(second.instance).toBe(instance);
		await second.close();
		// The idle browser's process goes away (a crash): the next holder gets a new, working browser.
		await instance.close({ silent: true });
		const third = await svc.openSharedBrowser();
		expect(third.instance).not.toBe(instance);
		const page = await third.instance.newPage({
			context: () => null,
			logLevel: 'error',
			indent: false,
			pageIndex: 0,
			onBrowserLog: null,
			onLog: () => undefined,
		});
		await page.close();
		await third.close();
		const after = svc.browserPoolStats;
		expect(after.replaced - before.replaced).toBe(1);
		expect(after.launched - before.launched).toBe(1);
	}, 240_000);
});
