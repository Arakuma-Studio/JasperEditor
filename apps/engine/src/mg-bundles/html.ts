// HTML compositions in the engine (docs/wp-notes/html-compositions.md): a self-contained HTML page that implements
// `window.__duration` (seconds), `window.__ready` (a Promise: fonts and images loaded) and `window.__seek(t)` (puts
// the page at time t, pure and deterministic) becomes an `mg-bundle` whose one composition is the page.
//
// Everything runs in the Remotion headless browser the engine already uses for compositions (same executable, chrome
// mode and window handling as `renderMedia`; a warm browser of the engine's pool, wp-note export-performance §16:
// every page this module opens is closed before the browser goes back), on pages served by a private loopback server (random port, unguessable
// prefix) with the same sandboxing Content-Security-Policy as the editor's live host and the HTML host agent
// (`@jasper/compositions/mg-host` html-agent.ts) injected before the page's scripts — so the Program monitor's live
// host, `render_frame` and exports drive the page identically:
//  - probe (import): load the page, check the contract, read the duration, seek a few frames, and record every file
//    of its folder the page loaded (they are copied into the content-addressed bundle store);
//  - render: N pages in parallel, each one a contiguous range of frames: `__seek(frame / fps)`, two animation frames,
//    a PNG screenshot with a transparent default background (alpha), piped into its own LGPL FFmpeg ProRes 4444
//    encoder; the segments are joined losslessly (concat, stream copy);
//  - still: one frame as a PNG (posters).
import type { ChildProcess } from 'node:child_process';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { htmlHostPageUrl, injectHtmlHostBootstrap } from '@jasper/compositions/mg-host';
import type { ChromiumOptions } from '@remotion/renderer';
import { z } from 'zod';
import { JobError } from '../jobs/types.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { mgHostCsp } from './csp.ts';
import { MgBundleError } from './project.ts';
import { serveBundleForMeasuring } from './text-measure.ts';

type RendererModule = typeof import('@remotion/renderer');
type Browser = Awaited<ReturnType<RendererModule['openBrowser']>>;
type Page = Awaited<ReturnType<Browser['newPage']>>;

export type HtmlBrowserOptions = {
	browserExecutable?: string;
	chromeMode: 'headless-shell' | 'chrome-for-testing';
	chromiumOptions?: ChromiumOptions;
};

/**
 * Where the pages' browser comes from: `open()` hands out a browser launched with the HTML pages' options (the
 * engine's warm pool: `RemotionService.openBrowserWith`, Chrome for Testing pages in their own windows) for one
 * render, still or probe; its `close()` gives it back.
 */
export type HtmlBrowsers = { open(): Promise<{ readonly instance: Browser; close(): Promise<void> }> };

/** The pages a render opened: closed when it ends, fails or is cancelled (a pooled browser keeps no page of it). */
function pageSet() {
	const pages: Page[] = [];
	return {
		add: (page: Page) => {
			pages.push(page);
		},
		close: () => Promise.all(pages.splice(0).map((p) => p.close().catch(() => undefined))),
	};
}

/** The page and its render settings. `fps` is a number (seeks) and `rate` its exact rational (encoders). */
export type HtmlPageRender = {
	/** Folder served as the page's origin (the bundle directory, or the page's own folder when probing). */
	dir: string;
	entry: string;
	query: string;
	width: number;
	height: number;
	fps: number;
	rate: { num: number; den: number };
};

/** `window.__ready`, `__seek` and page loads each get this long. */
export const HTML_PAGE_TIMEOUT_MS = 30_000;
/** Files and bytes an import may copy from the page's folder. */
export const HTML_MAX_FILES = 20_000;
export const HTML_MAX_BYTES = 2 * 1024 ** 3;

/** Actionable next steps for the contract errors (S08:MGA-002 style hints). */
export const HTML_ERROR_HINTS: Record<string, string> = {
	HTML_CONTRACT_MISSING:
		'Define, in the page: window.__duration = <length in seconds>; window.__ready = <a Promise that resolves once fonts and images are loaded>; window.__seek = (t) => { /* put the whole page at t seconds, e.g. timeline.seek(t) on a paused GSAP timeline */ }.',
	HTML_DURATION_INVALID: 'Set window.__duration to the length in seconds, e.g. window.__duration = 6.',
	HTML_READY_FAILED:
		'Fix what window.__ready waits for (a missing font or image?) so the Promise resolves; the page errors are in the detail.',
	HTML_READY_TIMEOUT: `Make window.__ready resolve once fonts and images are loaded (within ${HTML_PAGE_TIMEOUT_MS / 1000} s).`,
	HTML_SEEK_FAILED: 'window.__seek(t) must accept every t from 0 to window.__duration and must not throw.',
};

const HostResultSchema = z.union([
	z.object({ ok: z.literal(true), value: z.unknown() }),
	z.object({
		ok: z.literal(false),
		code: z.string().max(64),
		message: z.string().max(2000),
		detail: z.unknown().optional(),
	}),
]);

const MetaSchema = z.object({
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	fps: z.number().positive(),
	durationInFrames: z.number().int().positive().max(100_000_000),
	durationSec: z.number().positive().finite(),
});
export type HtmlPageMeta = z.infer<typeof MetaSchema>;

/** A failure of the page itself (contract, ready, seek): never retryable, with the hint. */
export function htmlPageError(code: string, message: string, detail?: unknown): MgBundleError {
	const known = code.startsWith('HTML_');
	return new MgBundleError(
		known ? code : 'MG_RENDER_FAILED',
		message,
		422,
		detail,
		HTML_ERROR_HINTS[code] ??
			'Open the page in a browser and check its console; it must define window.__duration, __ready and __seek.',
	);
}

/** The headers of every file of a served page: the live host's sandboxing policy (preview == render). */
function pageHeaders(base: string): Record<string, string> {
	return {
		'content-security-policy': mgHostCsp({ base, ancestors: [], remoteScripts: true }),
		// The sandboxed document has an opaque origin: its font and fetch requests are cross-origin.
		'access-control-allow-origin': '*',
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff',
		'cache-control': 'no-store',
	};
}

/** Serves a page folder on loopback (bootstrap injected into the entry); `onServe` sees every file request. */
export function serveHtmlPage(
	dir: string,
	entry: string,
	onServe?: (rel: string, served: boolean) => void,
): ReturnType<typeof serveBundleForMeasuring> {
	return serveBundleForMeasuring(dir, {
		entry,
		inject: injectHtmlHostBootstrap,
		headers: pageHeaders,
		...(onServe ? { onServe } : {}),
	});
}

type Cdp = { send(method: string, params?: Record<string, unknown>): Promise<unknown> };
const cdp = (page: Page): Cdp => page._client() as unknown as Cdp;

/** A host result of `window.__jasperHtmlHost` (validated: the page shares the agent's realm). */
function hostValue(raw: unknown, what: string): unknown {
	const r = HostResultSchema.safeParse(raw);
	if (!r.success)
		throw htmlPageError(
			'MG_HOST_PROTOCOL',
			`The page broke the HTML host agent (${what} returned an unexpected value)`,
		);
	if (!r.data.ok) throw htmlPageError(r.data.code, r.data.message, r.data.detail);
	return r.data.value;
}

/** Opens the page, waits for `__ready` and configures the agent (`durationInFrames` omitted: from `__duration`). */
async function openPage(
	browser: Browser,
	url: string,
	p: Pick<HtmlPageRender, 'width' | 'height' | 'fps'> & { durationInFrames?: number },
	index: number,
	timeoutMs: number,
	pages: ReturnType<typeof pageSet>,
): Promise<{ page: Page; meta: HtmlPageMeta }> {
	const page = await browser.newPage({
		context: () => null,
		logLevel: 'error',
		indent: false,
		pageIndex: index,
		onBrowserLog: null,
		onLog: () => undefined,
	});
	pages.add(page);
	await page.setViewport({ width: p.width, height: p.height, deviceScaleFactor: 1 });
	// Alpha: what the page does not paint stays transparent (Remotion's omitBackground).
	await cdp(page).send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
	await page.goto({ url, timeout: timeoutMs });
	const raw = await page.evaluate(
		(cfg: string, t: number) => {
			const host = (
				window as Window & { __jasperHtmlHost?: { configure(c: unknown, t: number): Promise<unknown> } }
			).__jasperHtmlHost;
			return host
				? host.configure(JSON.parse(cfg), t)
				: {
						ok: false,
						code: 'MG_HOST_PROTOCOL',
						message: 'The HTML host agent is not installed in the page',
					};
		},
		JSON.stringify({
			override: {
				width: p.width,
				height: p.height,
				fps: p.fps,
				...(p.durationInFrames ? { durationInFrames: p.durationInFrames } : {}),
			},
		}),
		timeoutMs,
	);
	const meta = MetaSchema.safeParse(hostValue(raw, 'configure'));
	if (!meta.success)
		throw htmlPageError('MG_HOST_PROTOCOL', 'The page reported invalid metadata to the HTML host agent');
	return { page, meta: meta.data };
}

async function seekPage(page: Page, frame: number, timeoutMs: number): Promise<void> {
	const raw = await page.evaluate(
		(f: number, t: number) => {
			const host = (
				window as Window & { __jasperHtmlHost?: { seek(f: number, t: number): Promise<unknown> } }
			).__jasperHtmlHost;
			return host
				? host.seek(f, t)
				: { ok: false, code: 'MG_HOST_PROTOCOL', message: 'The HTML host agent is gone from the page' };
		},
		frame,
		timeoutMs,
	);
	hostValue(raw, 'seek');
}

/** One PNG of the page as it is (Remotion's screenshot task: CDP capture of the clip, from the surface). */
async function capture(page: Page, width: number, height: number): Promise<Buffer> {
	const client = cdp(page);
	const target = (page.target() as unknown as { _targetId?: string })._targetId;
	if (target) await client.send('Target.activateTarget', { targetId: target });
	// Remotion's CDP session answers `{value: <CDP result>}`.
	const res = (await client.send('Page.captureScreenshot', {
		format: 'png',
		clip: { x: 0, y: 0, width, height, scale: 1 },
		captureBeyondViewport: true,
		optimizeForSpeed: true,
		fromSurface: true,
	})) as { value?: { data?: unknown } } | null;
	const data = res?.value?.data;
	if (typeof data !== 'string') throw new Error('Chrome returned no screenshot');
	return Buffer.from(data, 'base64');
}

export type HtmlProbe = {
	meta: HtmlPageMeta;
	/** Files of the folder the page loaded (POSIX paths relative to it), the entry included. */
	files: string[];
	/** Files of the folder the page asked for that do not exist. */
	missing: string[];
	/** Remote resources the page loaded (renders need the network for them). */
	remote: string[];
};

/**
 * Loads a page from its folder and checks the HTML composition contract: globals present, `__ready` settles,
 * `__duration` valid, `__seek` works at the first, middle and last frame. Records the files the page loaded.
 * Throws an MgBundleError with an `HTML_*` code and hint.
 */
export async function probeHtmlPage(
	browsers: HtmlBrowsers,
	p: Omit<HtmlPageRender, 'rate'>,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<HtmlProbe> {
	const timeout = opts.timeoutMs ?? HTML_PAGE_TIMEOUT_MS;
	const files = new Set<string>();
	const missing = new Set<string>();
	let lastServe = Date.now();
	const served = await serveHtmlPage(p.dir, p.entry, (rel, ok) => {
		lastServe = Date.now();
		(ok ? files : missing).add(rel);
	});
	let lease: Awaited<ReturnType<HtmlBrowsers['open']>> | null = null;
	const pages = pageSet();
	// Closing the page fails what it is waiting for (its CDP session ends).
	const onAbort = () => void pages.close();
	opts.signal?.addEventListener('abort', onAbort, { once: true });
	try {
		lease = await browsers.open();
		if (opts.signal?.aborted) throw new MgBundleError('JOB_CANCELLED', 'Cancelled', 499);
		const { page, meta } = await openPage(
			lease.instance,
			htmlHostPageUrl(served.base, p),
			p,
			0,
			timeout,
			pages,
		);
		const last = meta.durationInFrames - 1;
		for (const f of [...new Set([0, Math.floor(last / 2), last])]) await seekPage(page, f, timeout);
		// Late loads (lazy images, fetches the seeks started): until the server was idle for 300 ms, at most 3 s.
		const until = Date.now() + 3000;
		while (Date.now() < until && Date.now() - lastServe < 300)
			await new Promise((res) => setTimeout(res, 50));
		const resources = (await page.evaluate(() =>
			performance.getEntriesByType('resource').map((e) => e.name),
		)) as unknown;
		const remote = (Array.isArray(resources) ? resources : [])
			.filter((u): u is string => typeof u === 'string' && /^https:/i.test(u) && !u.startsWith(served.base))
			.slice(0, 50);
		files.add(p.entry);
		return {
			meta,
			files: [...files].sort(),
			missing: [...missing].filter((m) => !files.has(m)).sort(),
			remote: [...new Set(remote)],
		};
	} catch (e) {
		if (opts.signal?.aborted) throw new MgBundleError('JOB_CANCELLED', 'Cancelled', 499);
		if (e instanceof MgBundleError) throw e;
		throw htmlPageError(
			'MG_RENDER_FAILED',
			`Loading ${p.entry} in the headless browser failed: ${String((e as Error)?.message ?? e).split('\n')[0]}`,
		);
	} finally {
		opts.signal?.removeEventListener('abort', onAbort);
		await pages.close();
		await lease?.close();
		await served.close();
	}
}

/** Contiguous ranges `[first, first + n)` split into at most `parts` near-equal pieces. */
export function splitFrames(first: number, n: number, parts: number): { start: number; count: number }[] {
	const k = Math.max(1, Math.min(Math.floor(parts), n));
	const out: { start: number; count: number }[] = [];
	let at = first;
	for (let i = 0; i < k; i++) {
		const count = Math.floor(n / k) + (i < n % k ? 1 : 0);
		out.push({ start: at, count });
		at += count;
	}
	return out;
}

/** PNG frames on stdin → ProRes 4444 (straight alpha, 10-bit, BT.709 limited range like Remotion's masters). */
function proResArgs(rate: { num: number; den: number }, out: string): string[] {
	return [
		...['-f', 'image2pipe', '-framerate', `${rate.num}/${rate.den}`, '-c:v', 'png', '-i', 'pipe:0'],
		...[
			'-vf',
			'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuva444p10le',
		],
		...['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16'],
		...['-vendor', 'apl0', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'],
		...['-color_range', 'tv', '-video_track_timescale', '90000', '-movflags', '+write_colr', '-an', '-y'],
		...['-f', 'mov', out],
	];
}

/** One encoder fed frame by frame; `end()` resolves when the file is complete. */
function proResSink(ff: Ffmpeg, rate: { num: number; den: number }, out: string, o: SinkOptions) {
	const child: ChildProcess = ff.spawnRaw(proResArgs(rate, out), {
		stdin: 'pipe',
		...(o.signal ? { signal: o.signal } : {}),
		...(o.trackChild ? { onSpawn: o.trackChild } : {}),
	});
	let stderr = '';
	child.stdout?.resume();
	child.stderr?.setEncoding('utf8').on('data', (c: string) => {
		stderr = (stderr + c).slice(-8000);
	});
	const exited = new Promise<void>((resolve, reject) => {
		child.on('error', (e) =>
			reject(new JobError('MG_RENDER_FAILED', `Cannot run ffmpeg: ${e.message}`, true)),
		);
		child.on('close', (code, sig) =>
			code === 0
				? resolve()
				: reject(
						new JobError(
							'MG_RENDER_FAILED',
							`ffmpeg (ProRes 4444) exited ${code ?? sig}: ${stderr.trim().slice(-1200)}`,
							true,
						),
					),
		);
	});
	exited.catch(() => undefined);
	// A write never waits on an encoder that is gone: it fails with the encoder's error instead.
	const gone = exited.then(() => {
		throw new JobError('MG_RENDER_FAILED', 'ffmpeg stopped before the last frame', true);
	});
	gone.catch(() => undefined);
	const stdin = child.stdin!;
	stdin.on('error', () => undefined);
	return {
		write: (png: Buffer) =>
			Promise.race([
				new Promise<void>((resolve) => {
					if (stdin.write(png)) resolve();
					else stdin.once('drain', resolve);
				}),
				gone,
			]),
		end: () => {
			stdin.end();
			return exited;
		},
		kill: () => child.kill('SIGKILL'),
	};
}

type SinkOptions = { signal?: AbortSignal; trackChild?: (c: ChildProcess) => void };

/**
 * Renders composition frames `[startFrame, startFrame + durationFrames)` of a page (frame f = `__seek(f / fps)`)
 * into one ProRes 4444 file: `pages` browser pages in parallel, each a contiguous range with its own encoder, joined
 * by a lossless concat. `totalFrames` is the composition length at `fps` (the agent clamps seeks to it).
 */
export async function renderHtmlProRes(
	browsers: HtmlBrowsers,
	ff: Ffmpeg,
	p: HtmlPageRender & {
		totalFrames: number;
		startFrame: number;
		durationFrames: number;
		pages: number;
		out: string;
		scratch: string;
	},
	opts: SinkOptions & { onFrames?(done: number): void; timeoutMs?: number } = {},
): Promise<void> {
	const timeout = opts.timeoutMs ?? HTML_PAGE_TIMEOUT_MS;
	const ranges = splitFrames(p.startFrame, p.durationFrames, p.pages);
	const served = await serveHtmlPage(p.dir, p.entry);
	const url = htmlHostPageUrl(served.base, p);
	let lease: Awaited<ReturnType<HtmlBrowsers['open']>> | null = null;
	const pages = pageSet();
	const sinks: ReturnType<typeof proResSink>[] = [];
	let done = 0;
	const onAbort = () => {
		for (const s of sinks) s.kill();
		void pages.close();
	};
	opts.signal?.addEventListener('abort', onAbort, { once: true });
	const segments = ranges.map((_, i) => join(p.scratch, `html-segment-${i}.mov`));
	try {
		lease = await browsers.open();
		if (opts.signal?.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		const br = lease.instance;
		await Promise.all(
			ranges.map(async (range, i) => {
				const { page } = await openPage(
					br,
					url,
					{ ...p, durationInFrames: p.totalFrames },
					i,
					timeout,
					pages,
				);
				const sink = proResSink(ff, p.rate, segments[i]!, opts);
				sinks.push(sink);
				for (let f = range.start; f < range.start + range.count; f++) {
					if (opts.signal?.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
					await seekPage(page, f, timeout);
					await sink.write(await capture(page, p.width, p.height));
					done++;
					opts.onFrames?.(done);
				}
				await sink.end();
			}),
		);
	} catch (e) {
		for (const s of sinks) s.kill();
		if (opts.signal?.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		if (e instanceof MgBundleError) throw new JobError(e.code, e.message, false, e.detail);
		throw e;
	} finally {
		opts.signal?.removeEventListener('abort', onAbort);
		await pages.close();
		await lease?.close();
		await served.close();
	}
	if (segments.length === 1) {
		await rename(segments[0]!, p.out);
		return;
	}
	const list = join(p.scratch, 'html-segments.txt');
	await writeFile(list, `${segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n')}\n`);
	await ff.run(
		[
			...['-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v:0', '-c', 'copy'],
			...['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'],
			...['-movflags', '+write_colr', '-f', 'mov', p.out],
		],
		{
			...(opts.signal ? { signal: opts.signal } : {}),
			...(opts.trackChild ? { onSpawn: opts.trackChild } : {}),
		},
	);
	for (const s of segments) await rm(s, { force: true });
}

/** One frame of a page as a PNG (straight alpha). */
export async function renderHtmlStill(
	browsers: HtmlBrowsers,
	p: Omit<HtmlPageRender, 'rate'> & { totalFrames: number; frame: number },
	opts: { timeoutMs?: number } = {},
): Promise<Buffer> {
	const timeout = opts.timeoutMs ?? HTML_PAGE_TIMEOUT_MS;
	const served = await serveHtmlPage(p.dir, p.entry);
	let lease: Awaited<ReturnType<HtmlBrowsers['open']>> | null = null;
	const pages = pageSet();
	try {
		lease = await browsers.open();
		const { page } = await openPage(
			lease.instance,
			htmlHostPageUrl(served.base, p),
			{ ...p, durationInFrames: p.totalFrames },
			0,
			timeout,
			pages,
		);
		await seekPage(page, p.frame, timeout);
		return await capture(page, p.width, p.height);
	} finally {
		await pages.close();
		await lease?.close();
		await served.close();
	}
}
