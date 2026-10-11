import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browseCategoryOf } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, engineConfig } from '../src/index.ts';
import {
	BROWSE_LIST_LIMIT,
	browseRoots,
	checkBrowsePath,
	listFolder,
	sortEntries,
} from '../src/routes/browse.ts';
import { closeApps, ensureFixtures, FIXTURES, fixture, H, makeApp, tempAppdir } from './helpers.ts';

beforeAll(() => ensureFixtures(), 180_000);
afterAll(() => closeApps());

const q = (path: string) => encodeURIComponent(path);

describe('Media Browser helpers', () => {
	it('classifies files by extension, case-insensitively', () => {
		expect(browseCategoryOf('a.MP4')).toBe('video');
		expect(browseCategoryOf('tone.wav')).toBe('audio');
		expect(browseCategoryOf('x.Exr')).toBe('image');
		expect(browseCategoryOf('logo.svg')).toBe('graphics');
		expect(browseCategoryOf('subs.srt')).toBe('captions');
		expect(browseCategoryOf('cut.fcpxml')).toBe('timeline');
		expect(browseCategoryOf('look.cube')).toBe('lut');
		expect(browseCategoryOf('notes.txt')).toBeNull();
		expect(browseCategoryOf('.mp4')).toBeNull();
		expect(browseCategoryOf('noext')).toBeNull();
		expect(browseCategoryOf('trailing.')).toBeNull();
	});

	it('validates and normalises paths', () => {
		expect(checkBrowsePath('/a/b/../c')).toBe('/a/c');
		expect(() => checkBrowsePath('relative/x')).toThrow(/absolute/);
		expect(() => checkBrowsePath('/a\0b')).toThrow(/NUL/);
	});

	it('sorts folders first, then names in natural order', () => {
		const r = sortEntries([
			{ kind: 'file', name: 'clip 10.mp4' },
			{ kind: 'folder', name: 'b' },
			{ kind: 'file', name: 'clip 2.mp4' },
			{ kind: 'folder', name: 'A' },
		] as { kind: 'folder' | 'file'; name: string }[]);
		expect(r.map((e) => e.name)).toEqual(['A', 'b', 'clip 2.mp4', 'clip 10.mp4']);
	});

	it('offers Home, existing media folders, volumes and the root', () => {
		const have = new Set(['/home/u/Videos', '/home/u/Music']);
		const roots = browseRoots(
			'/home/u',
			'linux',
			(p) => have.has(p),
			(d) => (d === '/mnt' ? ['usb'] : []),
		);
		expect(roots.map((r) => r.path)).toEqual(['/home/u', '/home/u/Videos', '/home/u/Music', '/mnt/usb', '/']);
		const win = browseRoots('C:\\Users\\u', 'win32', (p) => p === 'C:\\' || p === 'D:\\');
		expect(win.filter((r) => r.kind === 'root').map((r) => r.label)).toEqual(['C:', 'D:']);
	});

	it('lists importable files and folders, hides the rest unless asked, follows symlinks', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-browse-'));
		mkdirSync(join(dir, 'Sub'));
		mkdirSync(join(dir, '.hidden'));
		writeFileSync(join(dir, 'a.mp4'), 'x');
		writeFileSync(join(dir, 'notes.txt'), 'x');
		writeFileSync(join(dir, '.secret.mov'), 'x');
		symlinkSync(join(dir, 'a.mp4'), join(dir, 'link.mp4'));
		symlinkSync(join(dir, 'missing.mp4'), join(dir, 'broken.mp4'));
		const some = await listFolder(dir, false);
		expect(some.entries.map((e) => e.name)).toEqual(['Sub', 'a.mp4', 'link.mp4']);
		expect(some.entries[1]).toMatchObject({ kind: 'file', size: 1, category: 'video', hidden: false });
		expect(some.entries[0]).toMatchObject({ kind: 'folder', size: null, category: null });
		const all = await listFolder(dir, true);
		expect(all.entries.map((e) => e.name)).toEqual([
			'.hidden',
			'Sub',
			'.secret.mov',
			'a.mp4',
			'link.mp4',
			'notes.txt',
		]);
		expect(all.truncated).toBe(false);
	});

	it('caps huge folders and says so', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-browse-big-'));
		for (let i = 0; i < BROWSE_LIST_LIMIT + 5; i++) writeFileSync(join(dir, `f${i}.wav`), '');
		const r = await listFolder(dir, false);
		expect(r.entries).toHaveLength(BROWSE_LIST_LIMIT);
		expect(r.truncated).toBe(true);
		expect(r.entries[0]!.name).toBe('f0.wav');
	});
});

describe('Media Browser routes', () => {
	it('lists the fixtures folder, probes a clip, makes a thumbnail and serves preview bytes', async () => {
		const app = await makeApp();
		const roots = await app.inject({ method: 'GET', url: '/api/browse/roots', headers: H });
		expect(roots.statusCode).toBe(200);
		expect(roots.json().roots.at(-1)).toMatchObject({ path: '/', kind: 'root' });

		const list = await app.inject({ method: 'GET', url: `/api/browse/list?path=${q(FIXTURES)}`, headers: H });
		expect(list.statusCode).toBe(200);
		const names = (list.json().entries as { name: string }[]).map((e) => e.name);
		expect(names).toContain('clip-a.mp4');
		expect(names).toContain('tone.wav');
		expect(list.json().parent).toBe(join(FIXTURES, '..'));

		const info = await app.inject({
			method: 'GET',
			url: `/api/browse/info?path=${q(fixture('clip-a.mp4'))}`,
			headers: H,
		});
		expect(info.statusCode).toBe(200);
		expect(info.json()).toMatchObject({
			name: 'clip-a.mp4',
			category: 'video',
			media: { width: 1920, height: 1080, videoCodec: 'h264', browserPlayable: 'yes' },
		});
		expect(info.json().media.durationSec).toBeGreaterThan(5);

		const thumb = await app.inject({
			method: 'GET',
			url: `/api/browse/thumbnail?path=${q(fixture('clip-a.mp4'))}&width=96`,
			headers: H,
		});
		expect(thumb.statusCode).toBe(200);
		expect(thumb.headers['content-type']).toBe('image/jpeg');
		expect(thumb.rawPayload.subarray(0, 2).toString('hex')).toBe('ffd8');
		const again = await app.inject({
			method: 'GET',
			url: `/api/browse/thumbnail?path=${q(fixture('clip-a.mp4'))}&width=96`,
			headers: H,
		});
		expect(again.headers.etag).toBe(thumb.headers.etag);
		const stillThumb = await app.inject({
			method: 'GET',
			url: `/api/browse/thumbnail?path=${q(fixture('still.png'))}`,
			headers: H,
		});
		expect(stillThumb.statusCode).toBe(200);

		const range = await app.inject({
			method: 'GET',
			url: `/api/browse/file?path=${q(fixture('tone.wav'))}`,
			headers: { ...H, range: 'bytes=0-3' },
		});
		expect(range.statusCode).toBe(206);
		expect(range.body).toBe('RIFF');
	});

	it('refuses bad paths, non-media files and missing folders with typed errors', async () => {
		const app = await makeApp();
		const rel = await app.inject({ method: 'GET', url: '/api/browse/list?path=fixtures', headers: H });
		expect(rel.statusCode).toBe(400);
		expect(rel.json().code).toBe('BAD_PATH');
		const missing = await app.inject({
			method: 'GET',
			url: `/api/browse/list?path=${q('/definitely/not/here')}`,
			headers: H,
		});
		expect(missing.statusCode).toBe(404);
		const notDir = await app.inject({
			method: 'GET',
			url: `/api/browse/list?path=${q(fixture('clip-a.mp4'))}`,
			headers: H,
		});
		expect(notDir.statusCode).toBe(400);
		const dir = mkdtempSync(join(tmpdir(), 'jasper-browse-txt-'));
		writeFileSync(join(dir, 'secret.txt'), 'top secret');
		const txt = await app.inject({
			method: 'GET',
			url: `/api/browse/file?path=${q(join(dir, 'secret.txt'))}`,
			headers: H,
		});
		expect(txt.statusCode).toBe(403);
		expect(txt.body).not.toContain('top secret');
		const cube = await app.inject({
			method: 'GET',
			url: `/api/browse/thumbnail?path=${q(fixture('look-33.cube'))}`,
			headers: H,
		});
		expect(cube.statusCode).toBe(404);
		const corrupt = join(dir, 'broken.mp4');
		writeFileSync(corrupt, 'not a video');
		const info = await app.inject({ method: 'GET', url: `/api/browse/info?path=${q(corrupt)}`, headers: H });
		expect(info.statusCode).toBe(200);
		expect(info.json().media).toBeNull();
		expect(info.json().error).toBeTruthy();
		const noThumb = await app.inject({
			method: 'GET',
			url: `/api/browse/thumbnail?path=${q(corrupt)}`,
			headers: H,
		});
		expect(noThumb.statusCode).toBe(404);
	});

	it('serves bytes by what a path resolves to: a media-named symlink to another file is refused', async () => {
		const app = await makeApp();
		const dir = mkdtempSync(join(tmpdir(), 'jasper-browse-link-'));
		writeFileSync(join(dir, 'id_rsa'), 'PRIVATE KEY');
		symlinkSync(join(dir, 'id_rsa'), join(dir, 'holiday.mp4'));
		symlinkSync(fixture('clip-a.mp4'), join(dir, 'real.mp4'));
		for (const route of ['file', 'thumbnail']) {
			const r = await app.inject({
				method: 'GET',
				url: `/api/browse/${route}?path=${q(join(dir, 'holiday.mp4'))}`,
				headers: H,
			});
			expect(r.statusCode, route).toBe(403);
			expect(r.json().code).toBe('NOT_PREVIEWABLE');
			expect(r.body).not.toContain('PRIVATE KEY');
		}
		const info = await app.inject({
			method: 'GET',
			url: `/api/browse/info?path=${q(join(dir, 'holiday.mp4'))}`,
			headers: H,
		});
		expect(info.json().media).toBeNull();
		expect(info.body).not.toContain('PRIVATE KEY');
		const ok = await app.inject({
			method: 'GET',
			url: `/api/browse/file?path=${q(join(dir, 'real.mp4'))}`,
			headers: { ...H, range: 'bytes=0-7' },
		});
		expect(ok.statusCode).toBe(206);
		expect(ok.headers['content-type']).toBe('video/mp4');
		expect(ok.headers['x-content-type-options']).toBe('nosniff');
		expect(String(ok.headers['content-security-policy'])).toContain('sandbox');
	});

	it('refuses requests a browser makes for another site (no embedding of local files by path)', async () => {
		const app = await makeApp();
		const url = `/api/browse/file?path=${q(fixture('still.png'))}`;
		for (const site of ['cross-site', 'same-site']) {
			for (const u of [url, `/api/browse/list?path=${q(FIXTURES)}`, '/api/browse/roots']) {
				const r = await app.inject({ method: 'GET', url: u, headers: { ...H, 'sec-fetch-site': site } });
				expect(r.statusCode, `${site} ${u}`).toBe(403);
				expect(r.json().code).toBe('FORBIDDEN_ORIGIN');
			}
		}
		for (const site of ['same-origin', 'none']) {
			const r = await app.inject({ method: 'GET', url, headers: { ...H, 'sec-fetch-site': site } });
			expect(r.statusCode, site).toBe(200);
		}
	});

	it('does not follow a playlist-like file to the network when it is only looked at', async () => {
		const hits: string[] = [];
		const server = createHttpServer((req, res) => {
			hits.push(req.url ?? '');
			res.statusCode = 404;
			res.end();
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const port = (server.address() as { port: number }).port;
		try {
			const app = await makeApp();
			const dir = mkdtempSync(join(tmpdir(), 'jasper-browse-hls-'));
			const file = join(dir, 'trailer.mp4');
			writeFileSync(
				file,
				`#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nhttp://127.0.0.1:${port}/segment0.ts\n#EXT-X-ENDLIST\n`,
			);
			const info = await app.inject({ method: 'GET', url: `/api/browse/info?path=${q(file)}`, headers: H });
			expect(info.statusCode).toBe(200);
			const thumb = await app.inject({
				method: 'GET',
				url: `/api/browse/thumbnail?path=${q(file)}`,
				headers: H,
			});
			expect(thumb.statusCode).toBe(404);
			expect(hits).toEqual([]);
		} finally {
			await new Promise((r) => server.close(r));
		}
	});

	it('is refused by a non-local engine', async () => {
		const appdir = tempAppdir();
		const { prepareAppdir } = await import('../src/index.ts');
		prepareAppdir(appdir);
		const config = engineConfig({
			appdir,
			port: 47900,
			host: '0.0.0.0',
			dev: false,
			token: 'tok',
			webDir: null,
			env: {},
		});
		const app = await createServer(config, { env: { PATH: process.env.PATH } });
		await app.ready();
		try {
			const r = await app.inject({
				method: 'GET',
				url: `/api/browse/list?path=${q(FIXTURES)}`,
				headers: { ...H, authorization: 'Bearer tok' },
			});
			expect(r.statusCode).toBe(403);
			expect(r.json().code).toBe('LOCAL_MODE_ONLY');
		} finally {
			await app.close();
		}
	});
});
