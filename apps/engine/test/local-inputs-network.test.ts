// AF-SEC-002 (spec 18 §2.1): a media file that points FFmpeg at the network is refused with a coded error, and the
// network is never contacted — at probe (registration), by a derivative and by a native export. The playlists name
// a local HTTP listener that counts requests.
//
// Variants: an HLS playlist with an http:// segment (refused by -protocol_whitelist), a DASH manifest with an
// http:// BaseURL and a local ffconcat list naming such a manifest (FFmpeg 6.1's DASH demuxer opens http:// itself,
// ignoring -protocol_whitelist; probes refuse the demuxer with -format_whitelist, which nested demuxers inherit).
// FFmpeg 7.1's HLS demuxer refuses a DASH "segment" by itself (extension_picky), hence the concat list.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, TEST_FFMPEG, type TestApp } from './helpers.ts';

let app: TestApp;
let server: Server;
let base: string;
let dir: string;
const requests: string[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		requests.push(req.url ?? '');
		res.statusCode = 404;
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	dir = mkdtempSync(join(tmpdir(), 'jasper-netref-'));
	// A 2 s 320×180 MPEG-2 transport stream segment (an LGPL encoder), no audio.
	const r = spawnSync(TEST_FFMPEG, [
		...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=d=2:s=320x180:r=30'],
		...['-c:v', 'mpeg2video', '-q:v', '4', '-f', 'mpegts', join(dir, 'seg0.ts')],
	]);
	if (r.status !== 0) throw new Error(`segment: ${r.stderr}`);
	app = await makeApp();
}, 120_000);

afterAll(async () => {
	await closeApps();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(dir, { recursive: true, force: true });
});

const hls = (segment: string) =>
	`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\n${segment}\n#EXT-X-ENDLIST\n`;
const dash = (url: string) =>
	`<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">\n<Period><AdaptationSet mimeType="video/mp2t"><Representation id="1" bandwidth="1000"><BaseURL>${url}</BaseURL></Representation></AdaptationSet></Period></MPD>\n`;

function write(name: string, text: string): string {
	const p = join(dir, name);
	writeFileSync(p, text);
	return p;
}

async function registerErrors(path: string) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/media/register',
		headers: JSON_H,
		payload: { projectId: 'prj_0000000000000001', paths: [path] },
	});
	expect(r.statusCode).toBe(200);
	return r.json() as { items: unknown[]; errors: { code: string; message: string }[] };
}

/**
 * A local HLS playlist registered while it was harmless, then rewritten (same size and modification time, so the
 * registry still trusts it) to name `remote` instead: what a derivative or an export later reads.
 */
async function swappedPlaylist(name: string, remote: string) {
	const local = hls('seg0.ts');
	const swapped = hls(remote);
	const pad = (s: string, n: number) => `${s}${'#'.repeat(n - s.length)}\n`;
	const size = Math.max(local.length, swapped.length) + 2;
	const path = write(name, pad(local, size - 1));
	const media = await register(app, path);
	const core = coreServices(app);
	// The automatic derivatives of the harmless version finish first.
	for (const j of core.queue.list().filter((x) => x.state === 'queued' || x.state === 'running'))
		await core.queue.wait(j.id);
	const st = statSync(path);
	writeFileSync(path, pad(swapped, size - 1));
	utimesSync(path, st.atime, st.mtime);
	expect(statSync(path).size).toBe(st.size);
	return media;
}

describe('AF-SEC-002: network references in media files are refused without contacting the network', () => {
	it('probe: an HLS playlist with an http:// segment is refused with REMOTE_REFERENCE_BLOCKED', async () => {
		requests.length = 0;
		const body = await registerErrors(write('remote.m3u8', hls(`${base}/seg0.ts`)));
		expect(body.items).toEqual([]);
		expect(body.errors.map((e) => e.code)).toEqual(['REMOTE_REFERENCE_BLOCKED']);
		expect(body.errors[0]!.message).toMatch(/http/);
		expect(requests).toEqual([]);
	});

	it('probe: a DASH manifest, alone or named by a local concat list, is refused the same way', async () => {
		requests.length = 0;
		const top = await registerErrors(write('remote.mpd', dash(`${base}/seg0.ts`)));
		write('nested.mpd', dash(`${base}/seg1.ts`));
		const nested = await registerErrors(write('nested.ffconcat', 'ffconcat version 1.0\nfile nested.mpd\n'));
		expect(requests).toEqual([]);
		expect(top.errors.map((e) => e.code)).toEqual(['REMOTE_REFERENCE_BLOCKED']);
		expect(nested.errors.map((e) => e.code)).toEqual(['REMOTE_REFERENCE_BLOCKED']);
	});

	it('derivative: a poster of a playlist that now names an http:// segment fails with REMOTE_REFERENCE_BLOCKED', async () => {
		const media = await swappedPlaylist('swapped-derivative.m3u8', `${base}/seg0.ts`);
		requests.length = 0;
		const core = coreServices(app);
		const record = core.registry.get(media.mediaKey)!;
		rmSync(core.derivatives.paths(record.fingerprint, 'poster').main, { force: true });
		const [job] = core.derivatives.request(record, ['poster']);
		expect(job).toBeDefined();
		const done = await core.queue.wait(job!.id);
		expect(done.state).toBe('failed');
		expect(done.error?.code).toBe('REMOTE_REFERENCE_BLOCKED');
		expect(done.error?.retryable).toBe(false);
		expect(requests).toEqual([]);
	}, 60_000);

	it('native export: a sequence using that playlist fails with REMOTE_REFERENCE_BLOCKED', async () => {
		const media = await swappedPlaylist('swapped-export.m3u8', `${base}/seg0.ts`);
		requests.length = 0;
		const d = new DocBuilder();
		const m = d.addMedia(media);
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 30 } },
			},
		]);
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					sequenceId: d.seqId,
					range: { type: 'entire' },
					container: 'mp4',
					video: {
						codec: 'h264',
						width: 320,
						height: 180,
						frameRate: { num: 30, den: 1 },
						scaling: 'fit',
						quality: { mode: 'crf', value: 23 },
						encoderSpeed: 'fast',
					},
					audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
					engine: 'native',
				},
			},
		});
		expect(start.statusCode, start.body).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.state).toBe('failed');
		expect(done.error?.code).toBe('REMOTE_REFERENCE_BLOCKED');
		expect(requests).toEqual([]);
	}, 120_000);
});
