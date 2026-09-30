// Pure units: fingerprint vectors (S01:AST-003), Range parsing, signed URLs, broadcaster ring buffer,
// peak reducer, atempo chain, ffprobe mapping.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UrlSigner } from '../src/auth/signed-url.ts';
import { createPeakReducer } from '../src/derivatives/peaks.ts';
import { Broadcaster } from '../src/events/broadcaster.ts';
import { atempoChain } from '../src/export/native.ts';
import { fingerprintBuffer, fingerprintFile, mediaKeyFor } from '../src/media/fingerprint.ts';
import { mapProbe, rotationOf } from '../src/media/probe.ts';
import { createProgressParser } from '../src/tools/ffmpeg.ts';
import { parseRange } from '../src/tools/http.ts';
import { tempAppdir } from './helpers.ts';

const pattern = (n: number) => {
	const b = Buffer.alloc(n);
	for (let i = 0; i < n; i++) b[i] = (i * 7 + 3) % 251;
	return b;
};

describe('fingerprint (S01:AST-003)', () => {
	// Vectors computed independently (Python hashlib) from the spec formula.
	const vectors: [string, Buffer, string][] = [
		['empty', Buffer.alloc(0), 'af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc'],
		['abc', Buffer.from('abc'), 'c3494ca1a2cf8eeb8a11ded316fb55b83c3bbbedb6313cd50415251e5d09e12f'],
		[
			'8 MiB (whole file)',
			pattern(8 * 1024 * 1024),
			'c80eac89a708b079bb2ac19e4c8c4b1ff648296e60f4917217df1ec4a9f1d36b',
		],
		[
			'9 MiB (first+last 4 MiB)',
			pattern(9 * 1024 * 1024),
			'95fc91d867f59c3a9e0ccfdbffc4fe95dab4917f425f9e915ab15abead37739d',
		],
	];
	for (const [name, buf, hex] of vectors) {
		it(`${name}: buffer and file agree with the vector`, async () => {
			expect(fingerprintBuffer(buf)).toBe(`q1:${hex}`);
			const file = join(tempAppdir('jasper-fp-'), 'f.bin');
			writeFileSync(file, buf);
			const r = await fingerprintFile(file);
			expect(r).toEqual({ fingerprint: `q1:${hex}`, sizeBytes: buf.length });
		});
	}
	it('media keys are mk_ + 24 hex of the fingerprint', () => {
		expect(mediaKeyFor(`q1:${'ab'.repeat(32)}`)).toBe(`mk_${'ab'.repeat(12)}`);
		expect(() => mediaKeyFor('q1:nothex')).toThrow();
	});
});

describe('Range parsing (S04:MS-002)', () => {
	it('handles start-end, open-ended, suffix, clamping and invalid ranges', () => {
		expect(parseRange(undefined, 100)).toBeNull();
		expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
		expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
		expect(parseRange('bytes=50-1000', 100)).toEqual({ start: 50, end: 99 });
		expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
		expect(parseRange('bytes=9-3', 100)).toBe('unsatisfiable');
		expect(parseRange('bytes=0-1,5-6', 100)).toBeNull(); // multi-range → full body
		expect(parseRange('items=0-1', 100)).toBeNull();
	});
});

describe('signed URLs (S04:MS-003)', () => {
	it('verifies path + expiry and rejects tampering', () => {
		const s = new UrlSigner('secret');
		const url = s.signUrl('http://127.0.0.1:1', '/media/mk_1');
		const path = url.slice('http://127.0.0.1:1'.length);
		expect(s.verify(path)).toBe(true);
		expect(s.verify(path.replace('mk_1', 'mk_2'))).toBe(false);
		expect(s.verify(path.replace(/sig=[^&]+/, 'sig=AAAA'))).toBe(false);
		expect(new UrlSigner('other').verify(path)).toBe(false);
		expect(s.verify(path, Date.now() + 7 * 3600 * 1000)).toBe(false); // expired
		expect(s.verify(`/api/projects?${s.signQuery('/api/projects')}`)).toBe(false); // not signable
	});
});

describe('Broadcaster (S04:ENG-023)', () => {
	it('assigns monotonic ids, replays since an id and filters by project', () => {
		const b = new Broadcaster(3);
		const seen: number[] = [];
		const off = b.subscribe((e) => seen.push(e.id), { projectId: 'p1' });
		b.publish('capabilities.changed', {});
		b.publish('media.updated', { mediaKey: 'mk_x', status: 'online' }, 'p1');
		b.publish('media.updated', { mediaKey: 'mk_y', status: 'online' }, 'p2');
		b.publish('capabilities.changed', {});
		off();
		expect(seen).toEqual([1, 2, 4]);
		expect(b.lastId).toBe(4);
		const since1 = b.since(1);
		expect(since1.events.map((e) => e.id)).toEqual([2, 3, 4]);
		expect(since1.complete).toBe(true);
		expect(b.since(0).complete).toBe(false); // event 1 fell out of the ring
		expect(b.since(1, { projectId: 'p2' }).events.map((e) => e.id)).toEqual([3, 4]);
		expect(b.heartbeat()).toMatchObject({ id: 4, type: 'engine.heartbeat' });
	});
});

describe('peak reducer (S04:WF-001)', () => {
	it('computes max-abs per channel and per window across chunk boundaries', () => {
		const frames = 250; // 2 channels, 100 samples per peak → 3 peaks (last partial)
		const pcm = new Float32Array(frames * 2);
		for (let i = 0; i < frames; i++) {
			pcm[i * 2] = i === 42 ? -0.75 : 0.1;
			pcm[i * 2 + 1] = i === 180 ? 0.5 : -0.2;
		}
		const bytes = new Uint8Array(pcm.buffer);
		const r = createPeakReducer(2, 100);
		// Odd chunk sizes split floats and frames.
		for (let off = 0; off < bytes.length; off += 7)
			r.push(bytes.subarray(off, Math.min(bytes.length, off + 7)));
		const out = r.finish();
		expect(out.frames).toBe(frames);
		expect([...out.channels[0]!].map((x) => Number(x.toFixed(3)))).toEqual([0.75, 0.1, 0.1]);
		expect([...out.channels[1]!].map((x) => Number(x.toFixed(3)))).toEqual([0.2, 0.5, 0.2]);
	});
});

describe('native helpers', () => {
	it('builds atempo chains within 0.5…100 per instance', () => {
		expect(atempoChain(1)).toEqual([]);
		expect(atempoChain(2)).toEqual(['atempo=2']);
		expect(atempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5']);
		expect(atempoChain(0.4)).toEqual(['atempo=0.5', 'atempo=0.8']);
	});
	it('parses -progress blocks', () => {
		const got: { outTimeUs: number; frame: number | null; done: boolean }[] = [];
		const parse = createProgressParser((p) => got.push(p));
		parse('frame=10\nout_time_us=333333\nspeed=1.5x\nprogress=continue\nframe=2');
		parse('0\nout_time_us=666666\nprogress=end\n');
		expect(got).toEqual([
			{ outTimeUs: 333333, frame: 10, speed: 1.5, done: false },
			{ outTimeUs: 666666, frame: 20, speed: 1.5, done: true },
		]);
	});
});

describe('probe mapping (S04:PB-001…004)', () => {
	it('reads rotation from the display matrix and legacy tags', () => {
		expect(rotationOf({ index: 0, side_data_list: [{ rotation: 90 }] })).toBe(90);
		expect(rotationOf({ index: 0, side_data_list: [{ rotation: -90 }] })).toBe(270);
		expect(rotationOf({ index: 0, tags: { rotate: '90' } })).toBe(270);
		expect(rotationOf({ index: 0 })).toBe(0);
	});
	it('detects VFR, kinds and browser playability', () => {
		const vfr = mapProbe({
			format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.0' },
			streams: [
				{
					index: 0,
					codec_type: 'video',
					codec_name: 'h264',
					width: 1280,
					height: 720,
					pix_fmt: 'yuv420p',
					r_frame_rate: '30/1',
					avg_frame_rate: '2997/100',
				},
			],
		});
		expect(vfr.kind).toBe('video');
		expect(vfr.probe.variableFrameRate).toBe(true);
		expect(vfr.browserPlayable).toBe('yes');
		const prores = mapProbe({
			format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1' },
			streams: [
				{
					index: 0,
					codec_type: 'video',
					codec_name: 'prores',
					width: 1920,
					height: 1080,
					pix_fmt: 'yuva444p10le',
					r_frame_rate: '25/1',
					avg_frame_rate: '25/1',
				},
			],
		});
		expect(prores.browserPlayable).toBe('no');
		expect(prores.probe.hasAlpha).toBe(true);
		expect(prores.probe.streams[0]).toMatchObject({ bitDepth: 10, browserDecodable: false });
		const png = mapProbe({
			format: { format_name: 'png_pipe' },
			streams: [
				{
					index: 0,
					codec_type: 'video',
					codec_name: 'png',
					width: 10,
					height: 10,
					pix_fmt: 'rgba',
					r_frame_rate: '25/1',
				},
			],
		});
		expect(png.kind).toBe('image');
		expect(png.probe.durationFlicks).toBeNull();
		const audio = mapProbe({
			format: { format_name: 'mp3', duration: '3' },
			streams: [
				{ index: 0, codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 },
				{
					index: 1,
					codec_type: 'video',
					codec_name: 'mjpeg',
					width: 300,
					height: 300,
					disposition: { attached_pic: 1 },
				},
			],
		});
		expect(audio.kind).toBe('audio');
		expect(audio.probe.streams.map((s) => s.type)).toEqual(['audio']);
		expect(() => mapProbe({ format: {}, streams: [] })).toThrow(/No video or audio/);
	});
});

describe('system errors → ENG-022 codes (WP-3I)', () => {
	it('maps ENOSPC to DISK_FULL, ENOENT to NOT_FOUND and other fs errors to INTERNAL without paths', async () => {
		const { default: Fastify } = await import('fastify');
		const { readFile } = await import('node:fs/promises');
		const { guarded } = await import('../src/tools/reply.ts');
		const app = Fastify();
		const enospc = Object.assign(new Error("ENOSPC: no space left on device, write '/secret/x'"), {
			code: 'ENOSPC',
			errno: -28,
			syscall: 'write',
		});
		const eacces = Object.assign(new Error("EACCES: permission denied, open '/secret/y'"), {
			code: 'EACCES',
			errno: -13,
			syscall: 'open',
		});
		app.get(
			'/full',
			guarded(async () => {
				throw enospc;
			}),
		);
		app.get(
			'/missing',
			guarded(async () => readFile('/definitely/not/here/jasper.json', 'utf8')),
		);
		app.get(
			'/denied',
			guarded(async () => {
				throw eacces;
			}),
		);
		const full = await app.inject({ method: 'GET', url: '/full' });
		expect(full.statusCode).toBe(507);
		expect(full.json()).toMatchObject({ code: 'DISK_FULL', retryable: true, detail: { errno: 'ENOSPC' } });
		const missing = await app.inject({ method: 'GET', url: '/missing' });
		expect(missing.statusCode).toBe(404);
		expect(missing.json().code).toBe('NOT_FOUND');
		expect(missing.body).not.toContain('/definitely');
		const denied = await app.inject({ method: 'GET', url: '/denied' });
		expect(denied.statusCode).toBe(500);
		expect(denied.json()).toMatchObject({ code: 'INTERNAL', detail: { errno: 'EACCES', syscall: 'open' } });
		expect(denied.body).not.toContain('/secret');
		await app.close();
	});
});

describe('dev web port (WP-3I)', () => {
	it('the dev engine accepts the Vite host given by JASPER_DEV_WEB_PORT (default 5173)', async () => {
		const { engineConfig } = await import('../src/index.ts');
		const base = { appdir: '/tmp/jasper-x', port: 48121, dev: true } as const;
		expect(engineConfig({ ...base, env: {} }).extraHosts).toContain('127.0.0.1:5173');
		const custom = engineConfig({ ...base, env: { JASPER_DEV_WEB_PORT: '48130' } }).extraHosts;
		expect(custom).toEqual(['127.0.0.1:48130', 'localhost:48130']);
		expect(engineConfig({ ...base, dev: false, env: { JASPER_DEV_WEB_PORT: '48130' } }).extraHosts).toEqual(
			[],
		);
	});
});

describe('H.264 encoder choice (ARCHITECTURE D-13, WP-3I)', () => {
	// Encoder selection and per-encoder arguments are covered in encoders.test.ts (WP-3L).
	it('the native export graph uses the chosen encoder', async () => {
		const { buildNativeGraph } = await import('../src/export/native.ts');
		const snapshot = {
			settings: { width: 320, height: 180, fps: { num: 30, den: 1 }, backgroundColor: [0, 0, 0, 1] },
			range: { start: 0, end: 30 },
			videoTracks: [],
			audioClips: [],
			master: { gainDb: 0 },
		};
		const output = {
			width: 320,
			height: 180,
			fps: { num: 30, den: 1 },
			frames: 30,
			durationSec: 1,
			scaling: 'fit',
			crf: 18,
			x264Preset: 'veryfast',
			audioChannels: 2,
			audioBitrateKbps: 192,
		};
		const base = {
			snapshot,
			output,
			outputFile: '/tmp/x.mp4',
			sources: { media: () => null, mgMaster: () => null },
			threads: 2,
		};
		const openh264 = {
			codec: 'h264',
			encoder: 'libopenh264',
			label: 'H.264 · OpenH264',
			hardware: false,
			container: 'mp4',
			audioEncoder: 'aac',
			rateControl: 'bitrate',
			gpl: false,
		};
		const g = buildNativeGraph({ ...base, output: { ...output, encoder: openh264 } } as never);
		expect(g.args).toContain('libopenh264');
		expect(g.args).not.toContain('libx264');
		expect(buildNativeGraph(base as never).args).toContain('libx264');
	});
});
