// @vitest-environment node
// TemplateImage in a real headless Chrome render (REMOTION_E2E=1; C1, docs/wp-notes/social-comments.md "Template
// media params"): the still waits for a slow, cross-origin (CORS) picture and shows it; a picture that fails to load
// renders the visible placeholder instead of failing the render.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
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
	let r: typeof import('@remotion/renderer');
	const browserOpts = CHROME ? { browserExecutable: CHROME, chromeMode: 'chrome-for-testing' as const } : {};

	beforeAll(async () => {
		server = createServer((req, res) => {
			if (req.url?.startsWith('/slow.png'))
				setTimeout(() => {
					res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' });
					res.end(RED);
				}, 1500);
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

	async function still(src: string): Promise<Buffer> {
		const inputProps = { src };
		const composition = await r.selectComposition({
			serveUrl,
			id: 'TemplateImage',
			inputProps,
			...browserOpts,
		});
		const { buffer } = await r.renderStill({
			composition,
			serveUrl,
			frame: 0,
			inputProps,
			imageFormat: 'png',
			output: null,
			...browserOpts,
		});
		return buffer!;
	}

	it('waits for a slow cross-origin picture and draws it', async () => {
		const png = await still(`${origin}/slow.png`);
		expect(pixel(png, 32, 32, 64)).toEqual([255, 0, 0, 255]);
	});

	it('a missing picture renders the placeholder (not black, not a failed render)', async () => {
		const png = await still(`${origin}/missing.png`);
		const [rr, g, b] = pixel(png, 32, 32, 64);
		expect(rr).toBeGreaterThan(40);
		expect(Math.abs(rr! - g!)).toBeLessThan(8);
		expect(Math.abs(rr! - b!)).toBeLessThan(8);
	});
});
