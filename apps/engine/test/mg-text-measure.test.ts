// Engine-side text measuring (wp-m3-mgtext, S08:MGC-037): the private loopback server the engine's own headless
// browser opens a bundle through — the host bootstrap (with the text probe) injected into index.html, files
// under a random path prefix only, no traversal. The browser part runs in mg-bundles.test.ts (MG_E2E=1).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
		} finally {
			await s.close();
		}
	});
});
