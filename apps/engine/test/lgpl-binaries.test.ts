import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EncoderChoice } from '@jasper/api';
import { describe, expect, it } from 'vitest';
import { planRemotionExport, type RemotionFfmpegInfo } from '../src/remotion/export-plan.ts';
import { RemotionService } from '../src/remotion/service.ts';
import { LEGACY_X264_CHOICE } from '../src/tools/encoders.ts';
import { resolveBinaries } from '../src/tools/ffmpeg.ts';
import { findVendorDir, resolveRemotionBinaries } from '../src/tools/lgpl.ts';
import { ffmpegLicense } from '../src/tools/licenses.ts';

function binaries(dir: string, suffix = ''): string {
	mkdirSync(dir, { recursive: true });
	for (const name of ['remotion', 'ffmpeg', 'ffprobe']) writeFileSync(join(dir, name + suffix), '');
	return dir;
}

describe('resolveRemotionBinaries', () => {
	const root = mkdtempSync(join(tmpdir(), 'remotion-bins-'));
	const env = binaries(join(root, 'explicit'));
	const res = join(root, 'resources');
	binaries(join(res, 'ffmpeg-lgpl'));
	const vendor = binaries(join(root, 'vendor'));
	const base = { platform: 'linux' as const, resourcesDir: res, vendorDir: vendor };

	it('prefers env → packaged resources → vendor', () => {
		expect(resolveRemotionBinaries({ ...base, env: { JASPER_REMOTION_BIN_DIR: env }, strict: true })).toEqual(
			{ dir: env, source: 'env', lgpl: true, allowed: true },
		);
		expect(
			resolveRemotionBinaries({
				...base,
				env: { JASPER_REMOTION_BINARIES_DIR: env },
				strict: true,
			}).source,
		).toBe('env');
		expect(resolveRemotionBinaries({ ...base, env: {}, strict: true })).toMatchObject({
			dir: join(res, 'ffmpeg-lgpl'),
			source: 'resources',
			allowed: true,
		});
		expect(resolveRemotionBinaries({ ...base, resourcesDir: null, env: {}, strict: false })).toMatchObject({
			dir: vendor,
			source: 'vendor',
			lgpl: true,
		});
	});

	it('dev without a directory: Remotion bundled FFmpeg with the loud GPL warning', () => {
		const r = resolveRemotionBinaries({ env: {}, strict: false, platform: 'linux' });
		expect(r).toMatchObject({ dir: null, source: 'bundled', lgpl: false, allowed: true });
		expect(r.message).toBeTruthy();
	});

	it('packaged (strict) without a directory refuses the Remotion path', () => {
		const r = resolveRemotionBinaries({ env: {}, strict: true, platform: 'linux' });
		expect(r).toEqual({
			dir: null,
			source: 'missing',
			lgpl: false,
			allowed: false,
			message: expect.any(String),
		});
	});

	it('a configured but incomplete directory never silently falls back', () => {
		const partial = join(root, 'incomplete');
		mkdirSync(partial);
		writeFileSync(join(partial, 'ffmpeg'), '');
		const strict = resolveRemotionBinaries({
			...base,
			env: { JASPER_REMOTION_BIN_DIR: partial },
			strict: true,
		});
		expect(strict).toMatchObject({ source: 'missing', allowed: false });
		expect(strict.message).toBeTruthy();
		const dev = resolveRemotionBinaries({
			...base,
			env: { JASPER_REMOTION_BIN_DIR: env },
			strict: false,
		});
		expect(dev.source).toBe('env');
		const devBroken = resolveRemotionBinaries({
			...base,
			env: { JASPER_REMOTION_BIN_DIR: partial },
			strict: false,
		});
		expect(devBroken).toMatchObject({ source: 'bundled', allowed: true });
		expect(devBroken.message).toBeTruthy();
	});

	it('uses .exe names on Windows', () => {
		const dir = binaries(join(root, 'windows'), '.exe');
		const options = { env: { JASPER_REMOTION_BIN_DIR: dir }, strict: true };
		expect(resolveRemotionBinaries({ ...options, platform: 'win32' }).allowed).toBe(true);
		expect(resolveRemotionBinaries({ ...options, platform: 'linux' }).allowed).toBe(false);
	});
});

describe('findVendorDir', () => {
	it('walks up to vendor/ffmpeg-lgpl/<platform> with a BUILDINFO.json', () => {
		const root = mkdtempSync(join(tmpdir(), 'vendor-'));
		const key = 'linux-x64';
		const dir = join(root, 'vendor', 'ffmpeg-lgpl', key);
		mkdirSync(dir, { recursive: true });
		const deep = join(root, 'apps', 'engine', 'dist');
		mkdirSync(deep, { recursive: true });
		expect(findVendorDir({ from: deep, key, env: {} })).toBeNull();
		writeFileSync(join(dir, 'BUILDINFO.json'), '{}');
		expect(findVendorDir({ from: deep, key, env: {} })).toBe(dir);
		expect(findVendorDir({ from: deep, key, env: { JASPER_FFMPEG_VENDOR: '0' } })).toBeNull();
	});
});

describe('resolveBinaries (native ffmpeg, D-13 order)', () => {
	const exe = (n: string) => (process.platform === 'win32' ? `${n}.exe` : n);
	const mk = (dir: string) => {
		mkdirSync(dir, { recursive: true });
		for (const n of ['ffmpeg', 'ffprobe']) {
			writeFileSync(join(dir, exe(n)), '#!/bin/sh\n');
			chmodSync(join(dir, exe(n)), 0o755);
		}
		return dir;
	};

	it('env → <resources>/bin → <resources>/ffmpeg-lgpl → vendor → PATH', () => {
		const root = mkdtempSync(join(tmpdir(), 'bins-'));
		const pathDir = mk(join(root, 'path'));
		const vendor = mk(join(root, 'vendor'));
		const resources = join(root, 'resources');
		const lgpl = mk(join(resources, 'ffmpeg-lgpl'));
		const env = { PATH: pathDir };
		expect(resolveBinaries({ env, vendorDir: null })).toMatchObject({
			ffmpeg: join(pathDir, exe('ffmpeg')),
			source: 'path',
		});
		expect(resolveBinaries({ env, vendorDir: vendor })).toMatchObject({
			ffmpeg: join(vendor, exe('ffmpeg')),
			ffprobe: join(vendor, exe('ffprobe')),
			source: 'vendor',
		});
		expect(resolveBinaries({ env, vendorDir: vendor, resourcesDir: resources })).toMatchObject({
			ffmpeg: join(lgpl, exe('ffmpeg')),
			source: 'resources',
		});
		const bin = mk(join(resources, 'bin'));
		expect(resolveBinaries({ env, vendorDir: vendor, resourcesDir: resources }).ffmpeg).toBe(
			join(bin, exe('ffmpeg')),
		);
		const explicit = join(pathDir, exe('ffmpeg'));
		expect(
			resolveBinaries({
				env: { ...env, JASPER_FFMPEG: explicit },
				vendorDir: vendor,
				resourcesDir: resources,
			}),
		).toMatchObject({ ffmpeg: explicit, source: 'env' });
		expect(resolveBinaries({ env: { PATH: '' }, vendorDir: null })).toMatchObject({
			ffmpeg: null,
			source: 'missing',
		});
	});
});

describe('RemotionService binaries policy', () => {
	const svc = (binaries: ConstructorParameters<typeof RemotionService>[0]['binaries']) =>
		new RemotionService({ bundleCacheDir: tmpdir(), usageLog: null, env: {}, binaries });

	it('strict without the LGPL directory: remotionLocal unavailable and renders refuse to start', async () => {
		const r = svc(resolveRemotionBinaries({ env: {}, strict: true }));
		await r.init(true);
		expect(r.state()).toBe('unavailable');
		expect(r.binaries).toMatchObject({ source: 'missing', allowed: false });
		await expect(
			r.renderMedia({
				inputProps: {},
				output: join(tmpdir(), 'x.mp4'),
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'BINARY_MISSING' });
	});

	// Remotion's own compositor package is a complete binaries directory with a GPL FFmpeg: the license probe
	// must reject it in strict mode and flag it in dev.
	let gplDir: string | null = null;
	try {
		const req = createRequire(createRequire(import.meta.url).resolve('@remotion/renderer/package.json'));
		const pkg = `@remotion/compositor-${process.platform === 'win32' ? 'win32-x64-msvc' : process.platform === 'darwin' ? `darwin-${process.arch}` : `linux-${process.arch}-gnu`}`;
		gplDir = dirname(req.resolve(`${pkg}/package.json`));
	} catch {
		gplDir = null;
	}

	it.runIf(gplDir !== null)(
		'a directory with a GPL FFmpeg is refused in strict mode (license probe)',
		async () => {
			const strict = svc({ dir: gplDir, source: 'env', lgpl: true, allowed: true });
			await strict.init(true);
			expect(strict.binaries).toMatchObject({ license: 'gpl', lgpl: false, allowed: false });
			expect(strict.state()).toBe('unavailable');
			const dev = svc({ dir: gplDir, source: 'env', lgpl: true, allowed: true });
			await dev.init(false);
			expect(dev.binaries).toMatchObject({ license: 'gpl', lgpl: false, allowed: true });
			expect(dev.ffmpegInfo.lgpl).toBe(false);
			expect(dev.ffmpegInfo.encoders).toContain('libx264');
		},
	);
});

describe('third-party licenses (About dialog, D-13)', () => {
	const bundle = (license: string, gpl3: boolean) => {
		const dir = mkdtempSync(join(tmpdir(), 'lic-'));
		writeFileSync(join(dir, 'ffmpeg'), '');
		writeFileSync(
			join(dir, 'BUILDINFO.json'),
			JSON.stringify({
				ffmpeg: {
					version: 'n7.1.5',
					license,
					sourceUrl: 'https://github.com/FFmpeg/FFmpeg/tree/abc',
					origin: { kind: gpl3 ? 'btbn' : 'source', release: 'autobuild-x' },
				},
			}),
		);
		writeFileSync(join(dir, 'LICENSE-FFmpeg.txt'), 'GNU LESSER GENERAL PUBLIC LICENSE …');
		writeFileSync(join(dir, 'NOTICE-FFmpeg.txt'), 'FFmpeg source: …');
		if (gpl3) writeFileSync(join(dir, 'COPYING.GPLv3.txt'), 'GNU GENERAL PUBLIC LICENSE …');
		return join(dir, 'ffmpeg');
	};

	it('a bundled LGPL 3 build: SPDX id, exact source, build link, LGPL text and the GPL 3 text it refers to', async () => {
		const c = await ffmpegLicense({
			ffmpegPath: bundle('LGPL-3.0-or-later', true),
			ffmpegVersion: 'n7.1.5-12',
			license: 'lgpl',
		});
		expect(c).toMatchObject({
			id: 'ffmpeg',
			version: 'n7.1.5-12',
			license: 'LGPL-3.0-or-later',
			bundled: true,
			sourceUrl: 'https://github.com/FFmpeg/FFmpeg/tree/abc',
			buildUrl: 'https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-x',
			notice: 'FFmpeg source: …',
		});
		expect(c!.texts.map((t) => t.text)).toEqual([
			'GNU LESSER GENERAL PUBLIC LICENSE …',
			'GNU GENERAL PUBLIC LICENSE …',
		]);
	});

	it('a bundled LGPL 2.1 source build has one license text and no prebuilt link', async () => {
		const c = await ffmpegLicense({
			ffmpegPath: bundle('LGPL-2.1-or-later', false),
			ffmpegVersion: '7.1.5',
			license: 'lgpl',
		});
		expect(c).toMatchObject({ license: 'LGPL-2.1-or-later', bundled: true });
		expect(c!.buildUrl).toBeUndefined();
		expect(c!.texts.map((t) => t.text)).toEqual(['GNU LESSER GENERAL PUBLIC LICENSE …']);
	});

	it('a system ffmpeg, or a directory whose ffmpeg is not LGPL, is never presented as our bundled build', async () => {
		const system = await ffmpegLicense({
			ffmpegPath: '/usr/bin/ffmpeg',
			ffmpegVersion: '6.1.1',
			license: 'gpl',
		});
		expect(system).toMatchObject({
			bundled: false,
			sourceUrl: 'https://ffmpeg.org/download.html',
			texts: [],
		});
		const swapped = await ffmpegLicense({
			ffmpegPath: bundle('LGPL-3.0-or-later', true),
			ffmpegVersion: 'x',
			license: 'gpl',
		});
		expect(swapped).toMatchObject({ bundled: false, texts: [] });
	});

	const vendor = findVendorDir();
	it.runIf(vendor !== null)('the vendored directory (pnpm ffmpeg:lgpl) yields a complete entry', async () => {
		const c = await ffmpegLicense({
			ffmpegPath: join(vendor!, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
			ffmpegVersion: null,
			license: 'lgpl',
		});
		expect(c).toMatchObject({ bundled: true, license: expect.stringMatching(/^LGPL-(2\.1|3\.0)-or-later$/) });
		expect(c!.sourceUrl).toMatch(/^https:\/\/(github\.com\/FFmpeg|ffmpeg\.org)/);
		expect(c!.texts[0]!.text).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
		expect(c!.notice).toContain('FFmpeg source:');
	});
});

const choice = (over: Partial<EncoderChoice>): EncoderChoice => ({
	codec: 'h264',
	encoder: 'libopenh264',
	label: 'H.264 · OpenH264 (software)',
	hardware: false,
	container: 'mp4',
	audioEncoder: 'aac',
	rateControl: 'bitrate',
	gpl: false,
	...over,
});
const LGPL: RemotionFfmpegInfo = {
	lgpl: true,
	encoders: ['libopenh264', 'libvpx', 'libvpx-vp9', 'libopus', 'prores_ks', 'aac', 'pcm_s16le', 'libsvtav1'],
	filters: ['scale', 'zscale'],
};
const BUNDLED: RemotionFfmpegInfo = { lgpl: false, encoders: null, filters: null };
const common = { lgplOnly: false, crf: 23, speed: 'balanced' as const, fps: { num: 30, den: 1 } };

describe('planRemotionExport', () => {
	it('H.264 with the LGPL directory: ProRes intermediate, then our encoder (two phases)', () => {
		const p = planRemotionExport({ ...common, encoder: choice({}), remotion: LGPL });
		expect(p).toMatchObject({
			mode: 'intermediate',
			codec: 'prores',
			proResProfile: 'hq',
			audioCodec: 'pcm-16',
		});
		if (p.mode !== 'intermediate') throw new Error('unreachable');
		expect(p.encoder.encoder).toBe('libopenh264');
	});

	it('dev with GPL builds on both sides and libx264: Remotion encodes H.264 itself (unchanged)', () => {
		expect(planRemotionExport({ ...common, encoder: LEGACY_X264_CHOICE, remotion: BUNDLED })).toMatchObject({
			mode: 'direct',
			codec: 'h264',
			audioCodec: 'aac',
		});
	});

	it('libx264 selected but Remotion uses the LGPL directory (no x264 there): intermediate', () => {
		expect(planRemotionExport({ ...common, encoder: LEGACY_X264_CHOICE, remotion: LGPL }).mode).toBe(
			'intermediate',
		);
		expect(
			planRemotionExport({ ...common, lgplOnly: true, encoder: LEGACY_X264_CHOICE, remotion: BUNDLED }).mode,
		).toBe('intermediate');
	});

	it('VP9 WebM + Opus goes direct through Remotion with mapped CRF and speed args', () => {
		const p = planRemotionExport({
			...common,
			encoder: choice({ codec: 'vp9', encoder: 'libvpx-vp9', container: 'webm', audioEncoder: 'libopus' }),
			remotion: LGPL,
		});
		expect(p).toMatchObject({
			mode: 'direct',
			codec: 'vp9',
			audioCodec: 'opus',
			colorSpace: 'bt709',
		});
		if (p.mode !== 'direct') throw new Error('unreachable');
		// Without zscale (a source build without zimg) no colour conversion filter is requested.
		const noZ = planRemotionExport({
			...common,
			encoder: choice({ codec: 'vp9', encoder: 'libvpx-vp9', container: 'webm', audioEncoder: 'libopus' }),
			remotion: { ...LGPL, filters: ['scale'] },
		});
		expect(noZ).toMatchObject({ mode: 'direct', colorSpace: null });
	});

	it('VP9 in MP4 (no Opus) or a Remotion build without libvpx-vp9: intermediate', () => {
		expect(
			planRemotionExport({
				...common,
				encoder: choice({ codec: 'vp9', encoder: 'libvpx-vp9', container: 'mp4', audioEncoder: 'aac' }),
				remotion: LGPL,
			}).mode,
		).toBe('intermediate');
		expect(
			planRemotionExport({
				...common,
				encoder: choice({ codec: 'vp9', encoder: 'libvpx-vp9', container: 'webm', audioEncoder: 'libopus' }),
				remotion: { ...LGPL, encoders: ['prores_ks', 'libopus'] },
			}).mode,
		).toBe('intermediate');
	});

	it('no usable encoder: unavailable with LGPL (or LGPL-only), Remotion GPL H.264 only in plain dev', () => {
		expect(planRemotionExport({ ...common, encoder: null, remotion: LGPL })).toMatchObject({
			mode: 'unavailable',
			code: 'ENCODER_UNAVAILABLE',
		});
		expect(planRemotionExport({ ...common, lgplOnly: true, encoder: null, remotion: BUNDLED }).mode).toBe(
			'unavailable',
		);
		expect(planRemotionExport({ ...common, encoder: null, remotion: BUNDLED }).mode).toBe('direct');
	});
});
