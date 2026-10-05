// Fingerprint vectors, signed URLs, event replay, peak reduction and media probe contracts.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UrlSigner } from '../src/auth/signed-url.ts';
import { createPeakReducer } from '../src/derivatives/peaks.ts';
import { Broadcaster } from '../src/events/broadcaster.ts';
import { fingerprintFile, mediaKeyFor } from '../src/media/fingerprint.ts';
import { probeFile } from '../src/media/probe.ts';
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
		it(`${name}: file agrees with the vector`, async () => {
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
	it('reports incomplete replay when the bounded event buffer overflows', () => {
		const b = new Broadcaster(3);
		for (let i = 0; i < 4; i++) b.publish('capabilities.changed', {});
		expect(b.since(0)).toMatchObject({ complete: false });
		expect(b.since(1)).toMatchObject({ complete: true });
		expect(b.since(0).events.map((event) => event.id)).toEqual([2, 3, 4]);
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

describe('probe mapping (S04:PB-001…004)', () => {
	// Feed captured ffprobe-shaped data through the same entry point used by media registration.
	// The stub supplies external tool output; it does not implement any probe behavior.
	const probeFrom = (json: unknown) =>
		probeFile({ probeJson: async () => json } as unknown as Parameters<typeof probeFile>[0], 'source.mov');
	it('reads legacy rotation tags when the display matrix is absent', async () => {
		const result = await probeFrom({
			format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1' },
			streams: [
				{
					index: 0,
					codec_type: 'video',
					codec_name: 'h264',
					width: 1920,
					height: 1080,
					tags: { rotate: '90' },
				},
			],
		});
		expect(result.probe.rotationDegrees).toBe(270);
		expect(result.display).toEqual({ width: 1080, height: 1920 });
	});
	it('detects VFR and VP9 alpha metadata', async () => {
		const vfr = await probeFrom({
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
		// VP8/VP9 alpha lives in Matroska BlockAdditions: the pixel format says yuv420p, the stream tag tells.
		const vp9Alpha = await probeFrom({
			format: { format_name: 'matroska,webm', duration: '3' },
			streams: [
				{
					index: 0,
					codec_type: 'video',
					codec_name: 'vp9',
					width: 1920,
					height: 1080,
					pix_fmt: 'yuv420p',
					r_frame_rate: '30/1',
					avg_frame_rate: '30/1',
					tags: { alpha_mode: '1' },
				},
			],
		});
		expect(vp9Alpha.probe.hasAlpha).toBe(true);
		expect(vp9Alpha.browserPlayable).toBe('yes');
		const vp9Opaque = await probeFrom({
			format: { format_name: 'matroska,webm', duration: '3' },
			streams: [
				{ index: 0, codec_type: 'video', codec_name: 'vp9', width: 8, height: 8, pix_fmt: 'yuv420p' },
			],
		});
		expect(vp9Opaque.probe.hasAlpha).toBe(false);
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

	it('resolves a relative JASPER_WEB_DIR against the working directory (@fastify/static needs an absolute root)', async () => {
		const { engineConfig } = await import('../src/index.ts');
		const { resolve } = await import('node:path');
		const base = { appdir: '/tmp/jasper-x', port: 48121, dev: false } as const;
		const rel = engineConfig({ ...base, env: { JASPER_WEB_DIR: 'apps/web/dist' } }).webDir;
		expect(rel).toBe(resolve('apps/web/dist'));
		expect(engineConfig({ ...base, webDir: '/srv/web', env: {} }).webDir).toBe('/srv/web');
		expect(engineConfig({ ...base, env: {} }).webDir).toBeNull();
	});
});
