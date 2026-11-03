// Spec 19 TL-087: a poster drawn for real, over HTTP, through Remotion: the look's colour reaches the PNG, a second ask
// comes from disk, and a client that leaves cancels the render. `REMOTION_E2E=1`, the bundle is built on first use.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { lookPosterKey } from '../src/title-looks/posters.ts';
import { tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const recipe = {
	palette: { face: [1, 0, 0, 1], keyline: [0, 0, 1, 1] },
	layers: [
		{ type: 'rim', params: { width: 12 } },
		{ type: 'face', params: {} },
	],
};
const body = { recipe, text: 'POSTER', width: 240 };

/** RGB of every pixel of a PNG. */
function pixels(png: Uint8Array, w: number, h: number): Buffer {
	const r = spawnSync(
		'ffmpeg',
		['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, 'pipe:1'],
		{ input: png, maxBuffer: w * h * 4 },
	);
	if (r.status !== 0) throw new Error(String(r.stderr));
	return r.stdout;
}

function count(px: Buffer, pred: (r: number, g: number, b: number) => boolean): number {
	let n = 0;
	for (let i = 0; i + 2 < px.length; i += 3) if (pred(px[i]!, px[i + 1]!, px[i + 2]!)) n++;
	return n;
}

describe.runIf(enabled)('look posters through Remotion (TL-087)', { timeout: 300_000 }, () => {
	let engine: RunningEngine;
	let url = '';
	let appdir = '';

	beforeAll(async () => {
		appdir = tempAppdir('jasper-poster-e2e-');
		engine = await startEngine({
			appdir,
			port: 0,
			// These tests drive the render path, not authentication (server.test.ts covers that).
			insecure: true,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
		url = `http://127.0.0.1:${engine.port}/api/title-looks/poster`;
	}, 120_000);
	afterAll(() => engine?.app.close());

	const ask = (b: unknown, signal?: AbortSignal) =>
		fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(b),
			...(signal ? { signal } : {}),
		});

	it('draws the look, caches it on disk and answers a second ask from the cache', async () => {
		const t0 = performance.now();
		const res = await ask(body);
		expect(res.status, await res.clone().text()).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('x-jasper-poster')).toBe('rendered');
		const png = new Uint8Array(await res.arrayBuffer());
		console.info(`poster first render ${Math.round(performance.now() - t0)} ms, ${png.length} bytes`);
		const px = pixels(png, 240, 136);
		// The face and the rim of the look, not the plain white text it was typed in.
		expect(count(px, (r, g, b) => r > 200 && g < 60 && b < 60)).toBeGreaterThan(100);
		expect(count(px, (r, g, b) => b > 200 && r < 60 && g < 60)).toBeGreaterThan(100);
		expect(count(px, (r, g, b) => r > 240 && g > 240 && b > 240)).toBe(0);
		const key = lookPosterKey({ ...body, width: 240 } as never);
		expect(existsSync(join(appdir, 'mg', 'posters', key, 'poster.png'))).toBe(true);
		const t1 = performance.now();
		const again = await ask(body);
		expect(again.headers.get('x-jasper-poster')).toBe('cached');
		await again.arrayBuffer();
		expect(performance.now() - t1).toBeLessThan(500);
	});

	it('takes a colourway over the look', async () => {
		const res = await ask({ ...body, palette: { face: [0, 1, 0, 1] } });
		expect(res.status).toBe(200);
		const px = pixels(new Uint8Array(await res.arrayBuffer()), 240, 136);
		expect(count(px, (r, g, b) => g > 200 && r < 60 && b < 60)).toBeGreaterThan(100);
		expect(count(px, (r, g, b) => r > 200 && g < 60 && b < 60)).toBe(0);
	});

	it('leaves no poster when the client leaves mid-render', async () => {
		const ac = new AbortController();
		const b = { ...body, text: 'LEFT' };
		const p = ask(b, ac.signal);
		await new Promise((r) => setTimeout(r, 300));
		ac.abort();
		await expect(p).rejects.toThrow();
		const key = lookPosterKey({ ...b, width: 240 } as never);
		await new Promise((r) => setTimeout(r, 1500));
		expect(existsSync(join(appdir, 'mg', 'posters', key, 'poster.png'))).toBe(false);
	});

	it('answers a refusal as an error reply, not as a picture', async () => {
		const res = await ask({ ...body, recipe: { layers: [{ type: 'nope' }] } });
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain('E_INVALID_PARAM');
	});
});
