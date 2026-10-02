// Text layout of a composition measured in the engine (M3, wp-m3-mgtext, S08:MGC-037): the layout warnings agents
// get from list_composition_texts / set_composition_text. The engine's own headless browser (the Remotion one,
// same executable and options as renders) opens the bundle's host page — the bundle directory served by a private
// loopback server for the duration of the measurement (random port, unguessable path prefix; nothing goes through
// the authenticated engine routes) with the host bootstrap injected, so the page's text probe renders the
// composition through the renderer-page protocol at each frame and locates the texts.
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import type { MgTextMeasureRequest, MgTextMeasureResult } from '@jasper/api';
import { injectHostBootstrap } from '@jasper/compositions/mg-host';

const CONTENT_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.map': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mov': 'video/quicktime',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
};

/** A loopback static server for one bundle directory, under `/<random>/`; `index.html` gets the host bootstrap. */
export async function serveBundleForMeasuring(dir: string): Promise<{ url: string; close(): Promise<void> }> {
	const prefix = `/${randomBytes(16).toString('hex')}/`;
	const root = normalize(dir);
	const server: Server = createServer((req, res) => {
		const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
		if (!path.startsWith(prefix)) {
			res.writeHead(404).end();
			return;
		}
		const rel = path.slice(prefix.length) || 'index.html';
		const file = normalize(join(root, rel));
		if (!(file === root || file.startsWith(root + sep)) || !existsSync(file) || !statSync(file).isFile()) {
			res.writeHead(404).end();
			return;
		}
		if (rel === 'index.html') {
			void readFile(file, 'utf8').then(
				(html) =>
					res.writeHead(200, { 'content-type': CONTENT_TYPES['.html']! }).end(injectHostBootstrap(html)),
				() => res.writeHead(500).end(),
			);
			return;
		}
		res.writeHead(200, {
			'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
			'content-length': statSync(file).size,
		});
		createReadStream(file).pipe(res);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}${prefix}index.html`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

type RendererModule = typeof import('@remotion/renderer');

export type MeasureBrowserOptions = {
	browserExecutable?: string;
	chromeMode: 'headless-shell' | 'chrome-for-testing';
	chromiumOptions?: Record<string, unknown>;
};

/** Measures the texts of `req` in a fresh page of the engine's headless browser (closed afterwards). */
export async function measureBundleTexts(
	r: RendererModule,
	bundleDir: string,
	req: MgTextMeasureRequest,
	browser: MeasureBrowserOptions,
	opts: { timeoutMs?: number } = {},
): Promise<MgTextMeasureResult> {
	const timeout = opts.timeoutMs ?? 60_000;
	const served = await serveBundleForMeasuring(bundleDir);
	let instance: Awaited<ReturnType<RendererModule['openBrowser']>> | null = null;
	try {
		instance = await r.openBrowser('chrome', {
			...(browser.browserExecutable ? { browserExecutable: browser.browserExecutable } : {}),
			chromeMode: browser.chromeMode,
			...(browser.chromiumOptions ? { chromiumOptions: browser.chromiumOptions as never } : {}),
			logLevel: 'error',
		});
		const page = await instance.newPage({
			context: () => null,
			logLevel: 'error',
			indent: false,
			pageIndex: 0,
			onBrowserLog: null,
			onLog: () => undefined,
		});
		await page.setViewport({ width: req.width, height: req.height, deviceScaleFactor: 1 });
		await page.goto({ url: served.url, timeout });
		const result = (await page.evaluate(
			(cfg: unknown) => {
				const w = window as unknown as {
					__jasperTexts?: { measure(c: unknown): Promise<unknown> };
				};
				if (!w.__jasperTexts) throw new Error('The text probe is not installed in the bundle page');
				return w.__jasperTexts.measure(cfg);
			},
			{ ...req, timeoutMs: timeout } as never,
		)) as MgTextMeasureResult;
		return result;
	} finally {
		await instance?.close({ silent: true }).catch(() => undefined);
		await served.close();
	}
}
