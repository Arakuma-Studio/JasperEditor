// wp-lgpl (ARCHITECTURE D-13): binaries directory resolution for Remotion and the native ffmpeg, strict
// (packaged) refusal, and the Remotion two-phase export plan.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EncoderChoice } from '@jasper/api';
import { describe, expect, it } from 'vitest';
import {
	appendEncoderArgs,
	planRemotionExport,
	type RemotionFfmpegInfo,
} from '../src/remotion/export-plan.ts';
import { RemotionService } from '../src/remotion/service.ts';
import { LEGACY_X264_CHOICE, vp9Crf } from '../src/tools/encoders.ts';
import { resolveBinaries } from '../src/tools/ffmpeg.ts';
import {
	BUNDLED_GPL_WARNING,
	findVendorDir,
	isBinariesDir,
	platformKey,
	REMOTION_BIN_DIR_ENV,
	REMOTION_BIN_DIR_ENV_LEGACY,
	resolveRemotionBinaries,
	STRICT_MISSING_MESSAGE,
} from '../src/tools/lgpl.ts';

const files = (...dirs: string[]) => {
	const set = new Set<string>();
	for (const d of dirs) for (const n of ['remotion', 'ffmpeg', 'ffprobe']) set.add(join(d, n));
	return (p: string) => set.has(p);
};

describe('resolveRemotionBinaries', () => {
	const env = '/opt/lgpl';
	const res = '/app/resources';
	const vendor = '/repo/vendor/ffmpeg-lgpl/linux-x64';
	const all = files(env, join(res, 'ffmpeg-lgpl'), vendor);
	const base = { platform: 'linux' as const, resourcesDir: res, vendorDir: vendor };

	it('prefers env → packaged resources → vendor', () => {
		expect(
			resolveRemotionBinaries({ ...base, env: { [REMOTION_BIN_DIR_ENV]: env }, strict: true, exists: all }),
		).toEqual({ dir: env, source: 'env', lgpl: true, allowed: true });
		expect(
			resolveRemotionBinaries({
				...base,
				env: { [REMOTION_BIN_DIR_ENV_LEGACY]: env },
				strict: true,
				exists: all,
			}).source,
		).toBe('env');
		expect(resolveRemotionBinaries({ ...base, env: {}, strict: true, exists: all })).toMatchObject({
			dir: join(res, 'ffmpeg-lgpl'),
			source: 'resources',
			allowed: true,
		});
		expect(
			resolveRemotionBinaries({ ...base, resourcesDir: null, env: {}, strict: false, exists: all }),
		).toMatchObject({ dir: vendor, source: 'vendor', lgpl: true });
	});

	it('dev without a directory: Remotion bundled FFmpeg with the loud GPL warning', () => {
		const r = resolveRemotionBinaries({ env: {}, strict: false, platform: 'linux', exists: () => false });
		expect(r).toMatchObject({ dir: null, source: 'bundled', lgpl: false, allowed: true });
		expect(r.message).toContain(BUNDLED_GPL_WARNING);
		expect(r.message).toContain('pnpm ffmpeg:lgpl');
	});

	it('packaged (strict) without a directory refuses the Remotion path', () => {
		const r = resolveRemotionBinaries({ env: {}, strict: true, platform: 'linux', exists: () => false });
		expect(r).toEqual({
			dir: null,
			source: 'missing',
			lgpl: false,
			allowed: false,
			message: STRICT_MISSING_MESSAGE,
		});
	});

	it('a configured but incomplete directory never silently falls back', () => {
		const partial = (p: string) => p === join(env, 'ffmpeg');
		const strict = resolveRemotionBinaries({
			...base,
			env: { [REMOTION_BIN_DIR_ENV]: env },
			strict: true,
			exists: partial,
		});
		expect(strict).toMatchObject({ source: 'missing', allowed: false });
		expect(strict.message).toContain(`${REMOTION_BIN_DIR_ENV}=${env}`);
		const dev = resolveRemotionBinaries({
			...base,
			env: { [REMOTION_BIN_DIR_ENV]: env },
			strict: false,
			exists: all,
		});
		expect(dev.source).toBe('env');
		const devBroken = resolveRemotionBinaries({
			...base,
			env: { [REMOTION_BIN_DIR_ENV]: env },
			strict: false,
			exists: partial,
		});
		expect(devBroken).toMatchObject({ source: 'bundled', allowed: true });
		expect(devBroken.message).toContain(BUNDLED_GPL_WARNING);
	});

	it('uses .exe names on Windows', () => {
		const win = (p: string) => /remotion\.exe$|ffmpeg\.exe$|ffprobe\.exe$/.test(p);
		expect(isBinariesDir('C:/lgpl', 'win32', win)).toBe(true);
		expect(isBinariesDir('C:/lgpl', 'linux', win)).toBe(false);
	});
});

describe('findVendorDir', () => {
	it('walks up to vendor/ffmpeg-lgpl/<platform> with a BUILDINFO.json', () => {
		const root = mkdtempSync(join(tmpdir(), 'vendor-'));
		const key = platformKey();
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
		const r = svc(resolveRemotionBinaries({ env: {}, strict: true, exists: () => false }));
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
			expect(strict.binaries.message).toMatch(/gpl FFmpeg build, not LGPL: Remotion rendering is disabled/);
			expect(strict.state()).toBe('unavailable');
			const dev = svc({ dir: gplDir, source: 'env', lgpl: true, allowed: true });
			await dev.init(false);
			expect(dev.binaries).toMatchObject({ license: 'gpl', lgpl: false, allowed: true });
			expect(dev.ffmpegInfo.lgpl).toBe(false);
			expect(dev.ffmpegInfo.encoders).toContain('libx264');
		},
	);
});

// ---------------------------------------------------------------- two-phase export plan

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
		expect(p.phases.map((x) => x.id)).toEqual(['render', 'encode']);
		expect(p.phases[0]!.weight + p.phases[1]!.weight).toBeCloseTo(0.98);
		expect(p.phases[1]!.label).toContain('OpenH264');
	});

	it('hardware H.264 gives the render phase a larger share; AV1 a smaller one', () => {
		const hw = planRemotionExport({
			...common,
			encoder: choice({ encoder: 'h264_nvenc', hardware: true }),
			remotion: LGPL,
		});
		const av1 = planRemotionExport({
			...common,
			encoder: choice({ codec: 'av1', encoder: 'libsvtav1' }),
			remotion: LGPL,
		});
		if (hw.mode !== 'intermediate' || av1.mode !== 'intermediate') throw new Error('expected intermediate');
		expect(hw.phases[0]!.weight).toBeGreaterThan(av1.phases[0]!.weight);
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
			crf: vp9Crf(23),
			colorSpace: 'bt709',
		});
		if (p.mode !== 'direct') throw new Error('unreachable');
		expect(p.extraVideoArgs).toEqual(['-deadline', 'good', '-cpu-used', '3', '-row-mt', '1', '-g', '60']);
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

describe('appendEncoderArgs', () => {
	it('adds encoder options before the output file of the command that encodes with that encoder', () => {
		const f = appendEncoderArgs('libvpx-vp9', ['-row-mt', '1']);
		expect(
			f({ type: 'stitcher', args: ['-i', 'a', '-c:v', 'libvpx-vp9', '-crf', '38', 'out.webm'] }),
		).toEqual(['-i', 'a', '-c:v', 'libvpx-vp9', '-crf', '38', '-row-mt', '1', 'out.webm']);
		const copy = ['-i', 'a', '-c:v', 'copy', 'out.webm'];
		expect(f({ type: 'stitcher', args: copy })).toBe(copy);
	});
});
