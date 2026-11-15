import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowseList, browseCategoryOf } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, engineConfig } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	ensureFixtures,
	FIXTURES,
	fixture,
	H,
	makeApp,
	TEST_PORT,
	tempAppdir,
} from './helpers.ts';

beforeAll(() => ensureFixtures(), 180_000);
afterAll(() => closeApps());

const q = (path: string) => encodeURIComponent(path);

describe('Media Browser listing', () => {
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

	it('lists importable files and folders, hides the rest unless asked, follows symlinks', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-browse-'));
		const app = await makeApp();
		mkdirSync(join(dir, 'Sub'));
		mkdirSync(join(dir, 'A'));
		mkdirSync(join(dir, 'b'));
		mkdirSync(join(dir, '.hidden'));
		writeFileSync(join(dir, 'a.mp4'), 'x');
		writeFileSync(join(dir, 'clip 10.mp4'), 'x');
		writeFileSync(join(dir, 'clip 2.mp4'), 'x');
		writeFileSync(join(dir, 'notes.txt'), 'x');
		writeFileSync(join(dir, '.secret.mov'), 'x');
		symlinkSync(join(dir, 'a.mp4'), join(dir, 'link.mp4'));
		symlinkSync(join(dir, 'missing.mp4'), join(dir, 'broken.mp4'));
		const response = await app.inject({
			method: 'GET',
			url: `/api/browse/list?path=${q(`${dir}/Sub/..`)}`,
			headers: H,
		});
		expect(response.statusCode).toBe(200);
		const some = response.json<BrowseList>();
		expect(some.path).toBe(dir);
		expect(some.entries.map((e) => e.name)).toEqual([
			'A',
			'b',
			'Sub',
			'a.mp4',
			'clip 2.mp4',
			'clip 10.mp4',
			'link.mp4',
		]);
		expect(some.entries[3]).toMatchObject({ kind: 'file', size: 1, category: 'video', hidden: false });
		expect(some.entries[0]).toMatchObject({ kind: 'folder', size: null, category: null });
		const responseAll = await app.inject({
			method: 'GET',
			url: `/api/browse/list?path=${q(dir)}&all=1`,
			headers: H,
		});
		expect(responseAll.statusCode).toBe(200);
		const all = responseAll.json<BrowseList>();
		expect(all.entries.map((e) => e.name)).toEqual([
			'.hidden',
			'A',
			'b',
			'Sub',
			'.secret.mov',
			'a.mp4',
			'clip 2.mp4',
			'clip 10.mp4',
			'link.mp4',
			'notes.txt',
		]);
		expect(all.truncated).toBe(false);
	});

	it('caps huge folders and says so', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-browse-big-'));
		for (let i = 0; i < 2005; i++) writeFileSync(join(dir, `f${i}.wav`), '');
		const app = await makeApp();
		const response = await app.inject({ method: 'GET', url: `/api/browse/list?path=${q(dir)}`, headers: H });
		expect(response.statusCode).toBe(200);
		const r = response.json<BrowseList>();
		expect(r.entries).toHaveLength(2000);
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
		const nul = await app.inject({ method: 'GET', url: `/api/browse/list?path=${q('/a\0b')}`, headers: H });
		expect(nul.statusCode).toBe(400);
		expect(nul.json().code).toBe('BAD_PATH');
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
		// Keep the unforced route scenario; explicit HLS parsing also exercises the local-input policy.
		const builds: Record<string, string>[] = [{}];
		if (existsSync('/usr/bin/ffmpeg') && existsSync('/usr/bin/ffprobe'))
			builds.push({ JASPER_FFMPEG: '/usr/bin/ffmpeg', JASPER_FFPROBE: '/usr/bin/ffprobe' });
		const hits: string[] = [];
		const server = createHttpServer((req, res) => {
			hits.push(req.url ?? '');
			res.statusCode = 404;
			res.end();
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const port = (server.address() as { port: number }).port;
		try {
			for (const env of builds) {
				const app = await makeApp({ env });
				for (const forceHls of [false, true]) {
					if (forceHls) {
						const ffmpeg = coreServices(app).ffmpeg;
						const probe = ffmpeg.probeJson.bind(ffmpeg);
						ffmpeg.probeJson = (args, opts) => probe(['-f', 'hls', ...args], opts);
						const run = ffmpeg.run.bind(ffmpeg);
						ffmpeg.run = (args, opts) => run(['-f', 'hls', ...args], opts);
					}
					const dir = mkdtempSync(join(tmpdir(), 'jasper-browse-hls-'));
					const file = join(dir, 'trailer.mp4');
					writeFileSync(
						file,
						`#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nhttp://127.0.0.1:${port}/segment0.ts\n#EXT-X-ENDLIST\n`,
					);
					const info = await app.inject({
						method: 'GET',
						url: `/api/browse/info?path=${q(file)}`,
						headers: H,
					});
					expect(info.statusCode).toBe(200);
					const thumb = await app.inject({
						method: 'GET',
						url: `/api/browse/thumbnail?path=${q(file)}`,
						headers: H,
					});
					expect(thumb.statusCode).toBe(404);
					expect(hits).toEqual([]);
				}
			}
		} finally {
			await new Promise((r) => server.close(r));
		}
	});

	it('does not fetch the segments of a DASH manifest named like a video for its thumbnail (AF-SEC-001)', async () => {
		// FFmpeg 6.1's DASH demuxer opens http:// itself despite -protocol_whitelist: the thumbnail run must refuse the
		// demuxer (-format_whitelist). Checked with the engine's default build and, when present, the system 6.1 build.
		const builds: Record<string, string>[] = [{}];
		if (existsSync('/usr/bin/ffmpeg') && existsSync('/usr/bin/ffprobe'))
			builds.push({ JASPER_FFMPEG: '/usr/bin/ffmpeg', JASPER_FFPROBE: '/usr/bin/ffprobe' });
		const hits: string[] = [];
		const server = createHttpServer((req, res) => {
			hits.push(req.url ?? '');
			res.statusCode = 404;
			res.end();
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const port = (server.address() as { port: number }).port;
		try {
			for (const env of builds) {
				const app = await makeApp({ env });
				const dir = mkdtempSync(join(tmpdir(), 'jasper-browse-dash-'));
				const file = join(dir, 'trailer.mp4');
				writeFileSync(
					file,
					`<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">\n<Period><AdaptationSet mimeType="video/mp2t"><Representation id="1" bandwidth="1000"><BaseURL>http://127.0.0.1:${port}/segment0.ts</BaseURL></Representation></AdaptationSet></Period></MPD>\n`,
				);
				const thumb = await app.inject({
					method: 'GET',
					url: `/api/browse/thumbnail?path=${q(file)}`,
					headers: H,
				});
				expect(thumb.statusCode, JSON.stringify(env)).toBe(404);
				expect(hits, JSON.stringify(env)).toEqual([]);
			}
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
			port: TEST_PORT,
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
