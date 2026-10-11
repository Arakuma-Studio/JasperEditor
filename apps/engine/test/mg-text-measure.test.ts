import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { serveBundleForMeasuring } from '../src/mg-bundles/text-measure.ts';

const root = mkdtempSync(join(tmpdir(), 'jasper-measure-'));
const dir = join(root, 'bundle');
mkdirSync(dir);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('bundle server for text measuring', () => {
	it('serves bundle files under its loopback prefix and refuses existing files outside it', async () => {
		writeFileSync(join(dir, 'index.html'), '<html><head><title>b</title></head><body></body></html>');
		writeFileSync(join(dir, 'bundle.js'), 'window.x = 1;');
		mkdirSync(join(dir, 'public', 'fonts'), { recursive: true });
		writeFileSync(join(dir, 'public', 'fonts', 'a.woff2'), 'font');
		writeFileSync(join(root, 'secret.txt'), 'no');
		const s = await serveBundleForMeasuring(dir);
		try {
			expect(new URL(s.url).hostname).toBe('127.0.0.1');
			expect((await fetch(s.url)).status).toBe(200);
			const base = s.url.replace(/index\.html$/, '');
			const js = await fetch(`${base}bundle.js`);
			expect(js.headers.get('content-type')).toMatch(/javascript/);
			expect(await js.text()).toBe('window.x = 1;');
			expect((await fetch(`${base}public/fonts/a.woff2`)).headers.get('content-type')).toBe('font/woff2');
			expect((await fetch(`${base}..%2Fsecret.txt`)).status).toBe(404);
			expect((await fetch(new URL('/bundle.js', s.url))).status).toBe(404);
			expect((await fetch(`${base}missing.js`)).status).toBe(404);
			expect((await fetch(`${base}public`)).status).toBe(404);
		} finally {
			await s.close();
		}
	});
	it('rejects malformed URL encodings and continues serving requests', async () => {
		writeFileSync(join(dir, 'index.html'), '<html></html>');
		const server = await serveBundleForMeasuring(dir);
		try {
			const base = server.url.replace(/index\.html$/, '');
			await fc.assert(
				fc.asyncProperty(
					fc.constantFrom('%', '%GG', '%FF', '%C0%AF', '%E0%A4'),
					fc.string(),
					async (invalid, suffix) => {
						const result = await fetch(`${base}${invalid}/${encodeURIComponent(suffix)}`);
						expect(result.status).toBe(400);
						expect(await result.json()).toMatchObject({ code: 'E_INVALID', retryable: false });
					},
				),
				{ numRuns: 25 },
			);
			expect((await fetch(server.url)).status).toBe(200);
		} finally {
			await server.close();
		}
	});
});
