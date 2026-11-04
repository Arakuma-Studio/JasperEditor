// @vitest-environment node
// TemplateImage in a real headless Chrome render (REMOTION_E2E=1; C1, docs/wp-notes/social-comments.md "Template
// media params"): the still waits for a slow, cross-origin (CORS) picture and shows it; a picture that fails to load
// fails the render by name (`TemplateImageError`), never a silent placeholder in an export (AGENTS §4).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.REMOTION_E2E === '1';
const here = dirname(fileURLToPath(import.meta.url));
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const ffmpeg = process.env.JASPER_FFMPEG ?? 'ffmpeg';

/** A 4×4 opaque red PNG. */
const RED = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC',
	'base64',
);

/** RGBA of the pixel at (x, y) of a PNG. */
function pixel(png: Buffer, x: number, y: number, width: number): number[] {
	const r = spawnSync(
		ffmpeg,
		['-v', 'error', '-f', 'png_pipe', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
		{
			input: png,
			maxBuffer: 1 << 26,
		},
	);
	if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr.toString()}`);
	const i = (y * width + x) * 4;
	return [...r.stdout.subarray(i, i + 4)];
}

describe.runIf(enabled)('TemplateImage render (REMOTION_E2E=1)', { timeout: 600_000 }, () => {
	let server: Server;
	let origin = '';
	let serveUrl = '';
	let slowPicture: ((response: ServerResponse) => void) | undefined;
	let r: typeof import('@remotion/renderer');
	const browserOpts = CHROME ? { browserExecutable: CHROME, chromeMode: 'chrome-for-testing' as const } : {};

	beforeAll(async () => {
		server = createServer((req, res) => {
			if (req.url?.startsWith('/slow.png') && slowPicture) slowPicture(res);
			else {
				res.writeHead(404, { 'access-control-allow-origin': '*' });
				res.end();
			}
		});
		await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		r = await import('@remotion/renderer');
		const { bundle } = await import('@remotion/bundler');
		serveUrl = await bundle({ entryPoint: join(here, 'template-image-render', 'entry.tsx') });
	}, 600_000);
	afterAll(() => new Promise<void>((ok) => (server ? server.close(() => ok()) : ok())));

	async function still(src: string, onBrowserLog?: (text: string) => void): Promise<Buffer> {
		const inputProps = { src };
		const log = onBrowserLog ? { onBrowserLog: (entry: { text: string }) => onBrowserLog(entry.text) } : {};
		const composition = await r.selectComposition({
			serveUrl,
			id: 'TemplateImage',
			inputProps,
			...log,
			...browserOpts,
		});
		const { buffer } = await r.renderStill({
			composition,
			serveUrl,
			frame: 0,
			inputProps,
			imageFormat: 'png',
			output: null,
			...log,
			...browserOpts,
		});
		return buffer!;
	}

	it('waits for a slow cross-origin picture and draws it', async () => {
		let requested!: () => void;
		const request = new Promise<void>((resolve) => {
			requested = resolve;
		});
		let observed!: (state: string) => void;
		const ready = new Promise<string>((resolve) => {
			observed = resolve;
		});
		const responses = new Set<ServerResponse>();
		let released = false;
		const send = (response: ServerResponse) => {
			if (response.destroyed || response.writableEnded) return;
			response.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' });
			response.end(RED);
		};
		slowPicture = (response) => {
			responses.add(response);
			requested();
			if (released) send(response);
		};
		const release = () => {
			released = true;
			for (const response of responses) send(response);
		};
		const rendered = still(`${origin}/slow.png`, (text) => {
			if (text.startsWith('template-image-ready:')) observed(text.slice('template-image-ready:'.length));
		});
		try {
			await Promise.race([
				request,
				rendered.then(() => {
					throw new Error('Render completed before the picture request');
				}),
			]);
			expect(await Promise.race([ready, rendered.then(() => 'completed')])).toBe('false');
			release();
			expect(pixel(await rendered, 32, 32, 64)).toEqual([255, 0, 0, 255]);
		} finally {
			release();
			await rendered.catch(() => undefined);
			slowPicture = undefined;
		}
	});

	it('a missing picture fails the render, naming the picture (never a silent placeholder)', async () => {
		const url = `${origin}/missing.png`;
		await expect(still(url)).rejects.toThrow(`Template picture could not be loaded from ${url}`);
	});
});
