// Text layout of a composition measured in the engine (M3, wp-m3-mgtext, S08:MGC-037): the layout warnings agents
// get from list_composition_texts / set_composition_text. The engine's own headless browser (the Remotion one,
// same executable and options as renders) opens the bundle's host page — the bundle directory served by a private
// loopback server for the duration of the measurement (random port, unguessable path prefix; nothing goes through
// the authenticated engine routes) with the host bootstrap injected, so the page's text probe renders the
// composition through the renderer-page protocol at each frame and locates the texts.
import { randomBytes } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { type MgTextMeasureRequest, type MgTextMeasureResult, MgTextMeasureResultSchema } from '@jasper/api';
import { injectHostBootstrap } from '@jasper/compositions/mg-host';
import type { ChromiumOptions } from '@remotion/renderer';

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

/**
 * A loopback static server for one bundle directory, under `/<random>/`; `index.html` gets the host bootstrap
 * (unless `bootstrap: false`). `files` serves extra files by their path under the prefix (spec 13 SH-004: the
 * text measurer's font faces). `immutable`: the files never change while the server runs (a content-addressed
 * bundle), so they are sent cacheable — a browser that loads the bundle again (another render page) reuses its HTTP
 * cache and V8's code cache instead of downloading and compiling 12 MB of script (wp-note export-performance §13).
 */
export async function serveBundleForMeasuring(
	dir: string,
	opts: { bootstrap?: boolean; files?: ReadonlyMap<string, string>; immutable?: boolean } = {},
): Promise<{ url: string; base: string; close(): Promise<void> }> {
	const prefix = `/${randomBytes(16).toString('hex')}/`;
	const root = await realpath(dir);
	const bootstrap = opts.bootstrap ?? true;
	const caching = opts.immutable ? { 'cache-control': 'public, max-age=31536000, immutable' } : {};
	const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
		if (!path.startsWith(prefix)) {
			res.writeHead(404).end();
			return;
		}
		const rel = path.slice(prefix.length) || 'index.html';
		const extra = opts.files?.get(rel);
		const file = extra ?? normalize(join(root, rel));
		if ((!extra && !file.startsWith(root + sep)) || !(await stat(file)).isFile()) {
			res.writeHead(404).end();
			return;
		}
		const handle = await open(file, 'r');
		try {
			const info = await handle.stat();
			if (!info.isFile()) {
				res.writeHead(404).end();
				return;
			}
			if (rel === 'index.html' && !extra) {
				const html = await handle.readFile('utf8');
				res
					.writeHead(200, { 'content-type': CONTENT_TYPES['.html']!, ...caching })
					.end(bootstrap ? injectHostBootstrap(html) : html);
				return;
			}
			res.writeHead(200, {
				'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
				'content-length': info.size,
				...caching,
			});
			await pipeline(handle.createReadStream({ autoClose: false }), res);
		} finally {
			await handle.close();
		}
	};
	const server = createServer((req, res) => {
		void serve(req, res).catch((error: unknown) => {
			if (res.headersSent || res.destroyed) {
				res.destroy();
				return;
			}
			const missing =
				error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
			const malformed = error instanceof URIError;
			res.writeHead(malformed ? 400 : missing ? 404 : 500, { 'content-type': 'application/json' }).end(
				JSON.stringify({
					code: malformed ? 'E_INVALID' : missing ? 'E_NOT_FOUND' : 'E_IO',
					message: malformed
						? 'Invalid bundle URL encoding'
						: missing
							? 'Bundle file not found'
							: 'Could not read bundle file',
					retryable: false,
				}),
			);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
	// A server kept for the process's lifetime (the renders' bundle) does not keep the process alive.
	if (opts.immutable) server.unref();
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}${prefix}index.html`,
		base: `http://127.0.0.1:${port}${prefix}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

type RendererModule = typeof import('@remotion/renderer');

type MeasureBrowserOptions = {
	browserExecutable?: string;
	chromeMode: 'headless-shell' | 'chrome-for-testing';
	chromiumOptions?: ChromiumOptions;
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
			...(browser.chromiumOptions ? { chromiumOptions: browser.chromiumOptions } : {}),
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
		const result = await page.evaluate(
			(serialized: string) => {
				const cfg: MgTextMeasureRequest & { timeoutMs: number } = JSON.parse(serialized);
				const w = window as Window & {
					__jasperTexts?: {
						measure(c: MgTextMeasureRequest & { timeoutMs: number }): Promise<MgTextMeasureResult>;
					};
				};
				if (!w.__jasperTexts) throw new Error('The text probe is not installed in the bundle page');
				return w.__jasperTexts.measure(cfg);
			},
			JSON.stringify({ ...req, timeoutMs: timeout }),
		);
		return MgTextMeasureResultSchema.parse(result);
	} finally {
		await instance?.close({ silent: true }).catch(() => undefined);
		await served.close();
	}
}
