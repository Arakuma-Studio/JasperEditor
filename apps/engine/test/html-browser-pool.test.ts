// HTML composition pages render in the engine's warm browsers (mg-bundles/html.ts through
// `RemotionService.openBrowserWith`, wp-note html-compositions "Warm browsers"): a second still reuses the browser,
// a browser that died is replaced, every page a still opened is closed even when it fails, and browsers launched with
// other options are not handed out. The browser is a stand-in for `@remotion/renderer`'s.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHtmlStill } from '../src/mg-bundles/html.ts';
import { RemotionService } from '../src/remotion/service.ts';

type FakePage = { closed: boolean };
type FakeBrowser = { id: number; alive: boolean; closed: boolean; pages: FakePage[]; options: unknown };
const chrome = vi.hoisted(() => ({ launched: [] as FakeBrowser[] }));
vi.mock('@remotion/renderer', () => ({
	openBrowser: async (_name: string, options: unknown) => {
		const b: FakeBrowser = { id: chrome.launched.length + 1, alive: true, closed: false, pages: [], options };
		chrome.launched.push(b);
		return {
			fake: b,
			connection: {
				send: async () => {
					if (!b.alive) throw new Error('Target closed');
					return {};
				},
			},
			pages: async () =>
				b.pages.filter((p) => !p.closed).map((p) => ({ close: async () => void (p.closed = true) })),
			newPage: async () => {
				const page: FakePage = { closed: false };
				b.pages.push(page);
				return {
					setViewport: async () => undefined,
					_client: () => ({ send: async () => ({}) }),
					// the page cannot be loaded: the still fails after its page was opened
					goto: async () => {
						throw new Error('net::ERR_FAILED');
					},
					close: async () => void (page.closed = true),
				};
			},
			close: async () => {
				b.closed = true;
			},
		};
	},
}));

const dir = mkdtempSync(join(tmpdir(), 'jasper-html-pool-'));
writeFileSync(join(dir, 'index.html'), '<html></html>');
writeFileSync(join(dir, 'page.html'), '<html><body></body></html>');
writeFileSync(join(dir, 'chrome'), '');
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
	chrome.launched.length = 0;
});

const service = () =>
	new RemotionService({
		bundleCacheDir: dir,
		prebuiltBundleDir: dir,
		usageLog: null,
		env: { JASPER_REMOTION_GL: 'off', JASPER_BROWSER_EXECUTABLE: join(dir, 'chrome') },
	});
const HTML = { browserExecutable: join(dir, 'chrome'), chromeMode: 'headless-shell' as const };
const still = (svc: RemotionService) =>
	renderHtmlStill(
		{ open: () => svc.openBrowserWith(HTML) },
		{ dir, entry: 'page.html', query: '', width: 64, height: 64, fps: 30, totalFrames: 30, frame: 0 },
		{ timeoutMs: 1000 },
	);

describe('HTML composition stills in warm browsers', () => {
	it('a second still reuses the first one’s browser, and every page each opened is closed', async () => {
		const svc = service();
		await expect(still(svc)).rejects.toThrow(/ERR_FAILED/);
		await expect(still(svc)).rejects.toThrow(/ERR_FAILED/);
		expect(chrome.launched).toHaveLength(1);
		expect(chrome.launched[0]!.pages).toHaveLength(2);
		expect(chrome.launched[0]!.pages.every((p) => p.closed)).toBe(true);
		expect(svc.browserPoolStats).toMatchObject({ launched: 1, reused: 1, idle: 1 });
		await svc.stop();
		expect(chrome.launched[0]!.closed).toBe(true);
	});

	it('a browser that died while idle is replaced by a new launch', async () => {
		const svc = service();
		await expect(still(svc)).rejects.toThrow(/ERR_FAILED/);
		chrome.launched[0]!.alive = false;
		await expect(still(svc)).rejects.toThrow(/ERR_FAILED/);
		expect(chrome.launched).toHaveLength(2);
		expect(chrome.launched[0]!.closed).toBe(true);
		expect(svc.browserPoolStats).toMatchObject({ launched: 2, replaced: 1 });
		await svc.stop();
	});

	it('launches the HTML pages’ browser with their own options, not a render browser’s', async () => {
		const svc = service();
		const render = await svc.openBrowserWith({ ...HTML, chromiumOptions: { gl: 'angle-egl' } });
		await render.close();
		await expect(still(svc)).rejects.toThrow(/ERR_FAILED/);
		expect(chrome.launched.map((b) => b.options)).toEqual([
			expect.objectContaining({ chromiumOptions: { gl: 'angle-egl' } }),
			expect.not.objectContaining({ chromiumOptions: expect.anything() }),
		]);
		await svc.stop();
	});
});
