// Media registration, probe, derivatives and byte serving with real ffmpeg on the fixtures
// (S04 §5–§8, ARCHITECTURE §9.4).
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PeaksHeaderSchema, SpriteIndexSchema } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	register,
	type TestApp,
	tempAppdir,
	until,
} from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 180_000); // a clean checkout generates the fixture media first (ffmpeg, ~10–30 s)
afterAll(closeApps);

describe('probe (S04:PB-001…004, S01:AST-001)', () => {
	it('clip-a: 10 s 1080p30 H.264 + stereo AAC, browser playable', async () => {
		const m = await register(app, fixture('clip-a.mp4'));
		expect(m.mediaKey).toMatch(/^mk_[0-9a-f]{24}$/);
		expect(m).toMatchObject({
			originalName: 'clip-a.mp4',
			sizeBytes: statSync(fixture('clip-a.mp4')).size,
			kind: 'video',
			browserPlayable: 'yes',
			probe: {
				durationFlicks: 10 * 705_600_000,
				startTimecode: null,
				rotationDegrees: 0,
				hasAlpha: false,
				variableFrameRate: false,
				streams: [
					{
						index: 0,
						type: 'video',
						codec: 'h264',
						width: 1920,
						height: 1080,
						pixelAspect: { num: 1, den: 1 },
						frameRate: { num: 30, den: 1 },
						pixelFormat: 'yuv420p',
						bitDepth: 8,
						browserDecodable: true,
					},
					{ index: 1, type: 'audio', codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' },
				],
			},
		});
		expect(m.container).toContain('mp4');
		expect(m.locators[0]).toMatchObject({ type: 'engine-store', key: m.mediaKey });
		expect(m.locators[1]).toMatchObject({ type: 'path', path: fixture('clip-a.mp4') });
	});

	it('phone-rot90: display-matrix rotation 90, 5 s, stored landscape', async () => {
		const m = await register(app, fixture('phone-rot90.mp4'));
		expect(m.probe.rotationDegrees).toBe(90);
		expect(m.probe.durationFlicks).toBe(5 * 705_600_000);
		expect(m.probe.streams[0]).toMatchObject({
			type: 'video',
			width: 1920,
			height: 1080,
			frameRate: { num: 30, den: 1 },
		});
		const rec = coreServices(app).registry.get(m.mediaKey)!;
		expect(rec.display).toEqual({ width: 1080, height: 1920 });
	});

	it('still.png is an image without duration; tone.wav is audio', async () => {
		const still = await register(app, fixture('still.png'));
		expect(still).toMatchObject({ kind: 'image', browserPlayable: 'yes', probe: { durationFlicks: null } });
		const tone = await register(app, fixture('tone.wav'));
		expect(tone).toMatchObject({ kind: 'audio', browserPlayable: 'yes' });
		expect(tone.probe.streams).toEqual([
			expect.objectContaining({ type: 'audio', codec: 'pcm_s16le', sampleRate: 48000, channels: 2 }),
		]);
	});

	it('re-registering the same file returns the same key (dedupe by fingerprint) and bad paths error per file', async () => {
		const a = await register(app, fixture('clip-a.mp4'));
		const r = await app.inject({
			method: 'POST',
			url: '/api/media/register',
			headers: JSON_H,
			payload: {
				projectId: 'prj_0000000000000001',
				paths: [fixture('clip-a.mp4'), '/nope/missing.mov', 'relative.mp4'],
			},
		});
		expect(r.statusCode).toBe(200);
		const body = r.json();
		expect(body.items.map((i: { mediaKey: string }) => i.mediaKey)).toEqual([a.mediaKey]);
		expect(body.errors.map((e: { code: string }) => e.code).sort()).toEqual([
			'ASSET_NOT_FOUND',
			'BAD_REQUEST',
		]);
	});
});

describe('derivatives (ARCHITECTURE §9.4, S04:TH-002, WF-001)', () => {
	it('poster, sprite + index and peaks are produced and parseable', async () => {
		const m = await register(app, fixture('clip-a.mp4'));
		const status = await until(async () => {
			const s = (await app.inject({ method: 'GET', url: `/api/media/${m.mediaKey}`, headers: H })).json();
			const d = s.derivatives;
			return ['keyframes', 'poster', 'sprite', 'peaks'].every((k) => d[k].state === 'ready') ? s : null;
		}, 60_000);
		expect(status.status).toBe('online');
		expect(status.derivatives['proxy-720'].state).toBe('none'); // browser playable → no mandatory proxy

		const poster = await app.inject({ method: 'GET', url: status.derivatives.poster.url, headers: H });
		expect(poster.statusCode).toBe(200);
		expect(poster.headers['content-type']).toBe('image/jpeg');
		expect(poster.headers['cache-control']).toContain('immutable');

		const sprite = SpriteIndexSchema.parse(
			(await app.inject({ method: 'GET', url: `/media/${m.mediaKey}/sprite.json`, headers: H })).json(),
		);
		expect(sprite.tileWidth).toBe(160);
		expect(sprite.tileHeight).toBe(90);
		expect(sprite.tiles.length).toBe(10); // one per second for a 10 s clip (max(1 s, d/200))
		expect(sprite.tiles[3]).toEqual({ sheet: 0, index: 3, timeSec: 3 });
		const sheet = await app.inject({ method: 'GET', url: `/media/${m.mediaKey}/sprite/0.jpg`, headers: H });
		expect(sheet.statusCode).toBe(200);
		expect(sheet.rawPayload.subarray(0, 2).toString('hex')).toBe('ffd8'); // JPEG SOI

		const header = PeaksHeaderSchema.parse(
			(await app.inject({ method: 'GET', url: `/media/${m.mediaKey}/peaks.json`, headers: H })).json(),
		);
		expect(header).toMatchObject({ peaksPerSecond: 100, channels: 2 });
		expect(Math.abs(header.sampleCount - 1000)).toBeLessThanOrEqual(2);
		expect(header.durationSec).toBeCloseTo(10, 1);
		// Keyed by the container stream index (video is stream 0, audio stream 1), like `channels.streamIndex`.
		expect(header.streams![0]!.index).toBe(1);
		expect(header.streams![0]!.url).toContain('/peaks/1.bin');
		const bin = await app.inject({ method: 'GET', url: header.streams![0]!.url, headers: H });
		expect(bin.statusCode).toBe(200);
		expect(bin.rawPayload.length).toBe(header.sampleCount * header.channels * 4);
		const floats = new Float32Array(
			bin.rawPayload.buffer.slice(
				bin.rawPayload.byteOffset,
				bin.rawPayload.byteOffset + bin.rawPayload.length,
			),
		);
		// A 440 Hz tone (its level changes over time, so check the loudest peak of the first channel).
		const loudest = Math.max(...floats.subarray(0, header.sampleCount));
		expect(loudest).toBeGreaterThan(0.05);
		expect(loudest).toBeLessThanOrEqual(1);
	}, 90_000);

	it('forces a 720p proxy for a non-browser-playable source', async () => {
		const dir = tempAppdir('jasper-src-');
		const src = join(dir, 'legacy.avi');
		const r = spawnSync('ffmpeg', [
			'-hide_banner',
			'-loglevel',
			'error',
			'-f',
			'lavfi',
			'-i',
			'testsrc2=size=1280x960:rate=25:duration=2',
			'-c:v',
			'mpeg4',
			'-q:v',
			'5',
			src,
		]);
		expect(r.status).toBe(0);
		const m = await register(app, src);
		expect(m.browserPlayable).toBe('no');
		const status = await until(async () => {
			const s = (await app.inject({ method: 'GET', url: `/api/media/${m.mediaKey}`, headers: H })).json();
			return s.derivatives['proxy-720'].state === 'ready'
				? s
				: s.derivatives['proxy-720'].state === 'failed'
					? s
					: null;
		}, 60_000);
		expect(status.derivatives['proxy-720'].state).toBe('ready');
		const proxyUrl = status.derivatives['proxy-720'].url as string;
		expect(proxyUrl).toMatch(new RegExp(`^/media/${m.mediaKey}/proxy/720\\?v=`));
		const rec = coreServices(app).registry.get(m.mediaKey)!;
		const file = coreServices(app).derivatives.paths(rec.fingerprint, 'proxy-720').main;
		const probe = spawnSync('ffprobe', [
			'-v',
			'error',
			'-select_streams',
			'v:0',
			'-show_entries',
			'stream=codec_name,width,height,pix_fmt',
			'-of',
			'json',
			file,
		]);
		const stream = JSON.parse(probe.stdout.toString()).streams[0];
		expect(stream).toMatchObject({ codec_name: 'h264', width: 960, height: 720, pix_fmt: 'yuv420p' });
		// moov atom first (+faststart)
		const head = readFileSync(file).subarray(0, 64).toString('latin1');
		expect(head.indexOf('moov')).toBeGreaterThan(-1);
	}, 90_000);
});

describe('proxies of sources with alpha', () => {
	it('makes a VP9 WebM proxy that keeps the alpha channel of a ProRes 4444 overlay', async () => {
		const m = await register(app, fixture('overlay-alpha.mov'));
		expect(m.browserPlayable).toBe('no'); // ProRes: the preview needs the proxy
		expect(m.probe.hasAlpha).toBe(true);
		const status = await until(async () => {
			const s = (await app.inject({ method: 'GET', url: `/api/media/${m.mediaKey}`, headers: H })).json();
			return ['ready', 'failed'].includes(s.derivatives['proxy-720'].state) ? s : null;
		}, 300_000);
		expect(status.derivatives['proxy-720'].state).toBe('ready');
		const core = coreServices(app);
		const rec = core.registry.get(m.mediaKey)!;
		const file = core.derivatives.paths(rec.fingerprint, 'proxy-720', rec).main;
		const probe = spawnSync('ffprobe', [
			'-v',
			'error',
			'-select_streams',
			'v:0',
			'-show_entries',
			'stream=codec_name,width,height:stream_tags=alpha_mode',
			'-of',
			'json',
			file,
		]);
		const stream = JSON.parse(probe.stdout.toString()).streams[0];
		expect(stream).toMatchObject({ codec_name: 'vp9', width: 1280, height: 720, tags: { alpha_mode: '1' } });
		const res = await app.inject({
			method: 'GET',
			url: status.derivatives['proxy-720'].url,
			headers: { ...H, range: 'bytes=0-3' },
		});
		expect(res.statusCode).toBe(206);
		expect(res.headers['content-type']).toBe('video/webm');
		// Decoded with libvpx the proxy is transparent outside the boxes and half-transparent inside the green one.
		const px = (x: number, y: number) =>
			spawnSync('ffmpeg', [
				...['-v', 'error', '-c:v', 'libvpx-vp9', '-i', file],
				...['-vf', `format=rgba,crop=1:1:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'],
			]).stdout;
		expect(px(1200, 650)[3]).toBeLessThan(8);
		expect(Math.abs(px(640, 360)[3]! - 128)).toBeLessThan(12);
		expect(px(133, 133)[3]).toBeGreaterThan(247);
	}, 360_000);
});

describe('media serving (S04:MS-002)', () => {
	it('supports HEAD, single Range → 206, suffix ranges, 416, ETag/304 and If-Range', async () => {
		const m = await register(app, fixture('clip-b.mp4'));
		const size = statSync(fixture('clip-b.mp4')).size;
		const bytes = readFileSync(fixture('clip-b.mp4'));
		const url = `/media/${m.mediaKey}`;

		const head = await app.inject({ method: 'HEAD', url, headers: H });
		expect(head.statusCode).toBe(200);
		expect(head.headers['content-length']).toBe(String(size));
		expect(head.headers['accept-ranges']).toBe('bytes');
		expect(head.headers['content-type']).toBe('video/mp4');
		expect(head.headers['cache-control']).toBe('private, no-cache');
		expect(head.body).toBe('');
		const etag = head.headers.etag as string;
		expect(etag).toBeTruthy();
		expect(head.headers['last-modified']).toBeTruthy();

		const full = await app.inject({ method: 'GET', url, headers: H });
		expect(full.statusCode).toBe(200);
		expect(full.rawPayload.equals(bytes)).toBe(true);

		const part = await app.inject({ method: 'GET', url, headers: { ...H, range: 'bytes=100-199' } });
		expect(part.statusCode).toBe(206);
		expect(part.headers['content-range']).toBe(`bytes 100-199/${size}`);
		expect(part.headers['content-length']).toBe('100');
		expect(part.rawPayload.equals(bytes.subarray(100, 200))).toBe(true);

		const tail = await app.inject({ method: 'GET', url, headers: { ...H, range: 'bytes=-16' } });
		expect(tail.statusCode).toBe(206);
		expect(tail.headers['content-range']).toBe(`bytes ${size - 16}-${size - 1}/${size}`);
		expect(tail.rawPayload.equals(bytes.subarray(size - 16))).toBe(true);

		const open = await app.inject({ method: 'GET', url, headers: { ...H, range: `bytes=${size - 10}-` } });
		expect(open.statusCode).toBe(206);
		expect(open.rawPayload.length).toBe(10);

		const headRange = await app.inject({ method: 'HEAD', url, headers: { ...H, range: 'bytes=0-9' } });
		expect(headRange.statusCode).toBe(206);
		expect(headRange.headers['content-length']).toBe('10');

		const bad = await app.inject({ method: 'GET', url, headers: { ...H, range: `bytes=${size}-` } });
		expect(bad.statusCode).toBe(416);
		expect(bad.headers['content-range']).toBe(`bytes */${size}`);

		const cached = await app.inject({ method: 'GET', url, headers: { ...H, 'if-none-match': etag } });
		expect(cached.statusCode).toBe(304);

		const staleIfRange = await app.inject({
			method: 'GET',
			url,
			headers: { ...H, range: 'bytes=0-9', 'if-range': '"stale"' },
		});
		expect(staleIfRange.statusCode).toBe(200);
		const goodIfRange = await app.inject({
			method: 'GET',
			url,
			headers: { ...H, range: 'bytes=0-9', 'if-range': etag },
		});
		expect(goodIfRange.statusCode).toBe(206);
	});

	it('rejects unknown or malformed keys, and reports derivatives that are not ready as 404', async () => {
		expect(
			(await app.inject({ method: 'GET', url: '/media/mk_000000000000000000000000', headers: H })).json(),
		).toMatchObject({
			code: 'ASSET_NOT_FOUND',
		});
		expect(
			(await app.inject({ method: 'GET', url: '/media/..%2F..%2Fetc%2Fpasswd', headers: H })).statusCode,
		).toBe(404);
		const tone = await register(app, fixture('tone.wav'));
		const poster = await app.inject({ method: 'GET', url: `/media/${tone.mediaKey}/poster.jpg`, headers: H });
		expect(poster.statusCode).toBe(404);
		expect(
			(await app.inject({ method: 'GET', url: `/media/${tone.mediaKey}/proxy/999`, headers: H })).statusCode,
		).toBe(404);
	});

	it('serves signed URLs to cookie-less consumers in token mode (S04:MS-003) with CORS for the headless browser', async () => {
		const secured = await makeApp({ token: 's3cret', dev: false });
		const m = await register(secured, fixture('clip-b.mp4'), { authorization: 'Bearer s3cret' });
		const path = `/media/${m.mediaKey}`;
		expect((await secured.inject({ method: 'GET', url: path, headers: H })).statusCode).toBe(401);
		const signed = coreServices(secured).signer.signUrl('', path);
		const ok = await secured.inject({
			method: 'GET',
			url: signed,
			headers: { ...H, origin: 'http://localhost:3000', range: 'bytes=0-3' },
		});
		expect(ok.statusCode).toBe(206);
		expect(ok.headers['access-control-allow-origin']).toBe('*');
		const pre = await secured.inject({
			method: 'OPTIONS',
			url: signed,
			headers: { ...H, origin: 'http://localhost:3000' },
		});
		expect(pre.statusCode).toBe(204);
		const other = coreServices(secured)
			.signer.signUrl('', '/media/mk_000000000000000000000000')
			.replace('mk_000000000000000000000000', m.mediaKey);
		expect((await secured.inject({ method: 'GET', url: other, headers: H })).statusCode).toBe(401);
		// A signature only authorizes reads.
		expect((await secured.inject({ method: 'POST', url: signed, headers: H })).statusCode).toBe(401);
	});
});
