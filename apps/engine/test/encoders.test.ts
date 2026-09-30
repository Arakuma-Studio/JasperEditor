// Encoder selection (ARCHITECTURE D-13) with mocked encoder lists: LGPL-only build, OpenH264-only,
// hardware-only, full GPL build; argument mapping per encoder; parsing; hardware test encodes against a
// fake ffmpeg.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncodingCapabilitiesSchema } from '@jasper/api';
import { describe, expect, it } from 'vitest';
import {
	av1Crf,
	bitrateForCrf,
	type EncoderInventory,
	EncoderService,
	encodingCapabilities,
	GPL_ENCODERS,
	HW_H264,
	hwFailureReason,
	hwTestArgs,
	parseBuildLicense,
	parseHwaccels,
	probeHardwareEncoders,
	selectVideoEncoder,
	usableByCodec,
	videoEncodeArgs,
	vp9Crf,
} from '../src/tools/encoders.ts';

const BASE = ['aac', 'prores_ks', 'png', 'mjpeg', 'pcm_s16le', 'flac'];
/** A typical LGPL build (no --enable-gpl): libvpx, SVT-AV1, libaom, libopus, NVENC/QSV/VAAPI wrappers. */
const LGPL_LIST = [
	...BASE,
	'libvpx-vp9',
	'libsvtav1',
	'libaom-av1',
	'libopus',
	'h264_nvenc',
	'h264_qsv',
	'h264_vaapi',
];
/** An LGPL build with only Cisco's OpenH264 for video. */
const OPENH264_ONLY = [...BASE, 'libopenh264'];
/** A build whose only video encoders are hardware H.264 ones. */
const HW_ONLY = [...BASE, 'h264_videotoolbox', 'h264_nvenc', 'h264_amf', 'h264_vaapi'];
/** The system GPL build (x264/x265) plus OpenH264. */
const FULL_GPL = [...LGPL_LIST, 'libx264', 'libx264rgb', 'libx265', 'libopenh264', 'libfdk_aac'];

function inv(
	encoders: string[],
	opts: { lgplOnly?: boolean; usable?: string[]; license?: EncoderInventory['license'] } = {},
): EncoderInventory {
	return {
		encoders,
		hwaccels: [],
		license: opts.license ?? 'lgpl',
		lgplOnly: opts.lgplOnly ?? false,
		hardware: HW_H264.filter((h) => encoders.includes(h.encoder)).map((h) => ({
			encoder: h.encoder,
			usable: (opts.usable ?? []).includes(h.encoder),
			...((opts.usable ?? []).includes(h.encoder) ? {} : { reason: 'no device' }),
		})),
	};
}

const P = { crf: 18, speed: 'balanced' as const, width: 1920, height: 1080, fps: { num: 30, den: 1 } };

describe('selectVideoEncoder (D-13)', () => {
	it('LGPL-only list without usable hardware: exports AV1 (SVT-AV1, MP4), proxies VP9, with a message', () => {
		const i = inv(LGPL_LIST);
		const exp = selectVideoEncoder(i, { purpose: 'export' })!;
		expect(exp).toMatchObject({
			codec: 'av1',
			encoder: 'libsvtav1',
			container: 'mp4',
			audioEncoder: 'aac',
			hardware: false,
			gpl: false,
			rateControl: 'crf',
		});
		expect(exp.message).toMatch(/H\.264 is unavailable.*AV1 \(MP4\)/);
		const proxy = selectVideoEncoder(i, { purpose: 'proxy' })!;
		expect(proxy).toMatchObject({ codec: 'vp9', encoder: 'libvpx-vp9', container: 'mp4' });
		// Listed but unusable hardware encoders never count.
		expect(usableByCodec(i).h264).toEqual([]);
	});

	it('VP9 exports go to WebM + Opus when libopus exists, else MP4 + AAC', () => {
		const vp9Only = [...BASE, 'libvpx-vp9', 'libopus'];
		expect(selectVideoEncoder(inv(vp9Only), { purpose: 'export' })).toMatchObject({
			codec: 'vp9',
			container: 'webm',
			audioEncoder: 'libopus',
		});
		expect(selectVideoEncoder(inv([...BASE, 'libvpx-vp9']), { purpose: 'export' })).toMatchObject({
			codec: 'vp9',
			container: 'mp4',
			audioEncoder: 'aac',
		});
		// Proxies always stay MP4.
		expect(selectVideoEncoder(inv(vp9Only), { purpose: 'proxy' })).toMatchObject({ container: 'mp4' });
	});

	it('OpenH264-only: H.264 via libopenh264 with bitrate rate control (no CRF)', () => {
		const c = selectVideoEncoder(inv(OPENH264_ONLY), { purpose: 'export' })!;
		expect(c).toMatchObject({ codec: 'h264', encoder: 'libopenh264', rateControl: 'bitrate', gpl: false });
		expect(c.message).toBeUndefined();
		const a = videoEncodeArgs(c, P);
		expect(a.video).not.toContain('-crf');
		const kbps = bitrateForCrf(18, 1920, 1080, 30, 1.3);
		expect(a.video).toEqual(
			expect.arrayContaining(['-c:v', 'libopenh264', '-b:v', `${kbps}k`, '-rc_mode', 'bitrate', '-g', '60']),
		);
		expect(a.video.join(' ')).toContain('-allow_skip_frames 0');
		expect(a.video.join(' ')).toContain('-pix_fmt yuv420p');
		// Lower quality → lower bitrate.
		expect(bitrateForCrf(28, 1920, 1080, 30)).toBeLessThan(bitrateForCrf(18, 1920, 1080, 30));
	});

	it('hardware-only: the first usable encoder in preference order wins (test encodes decide)', () => {
		expect(selectVideoEncoder(inv(HW_ONLY), { purpose: 'export' })).toBeNull();
		const some = inv(HW_ONLY, { usable: ['h264_vaapi', 'h264_nvenc'] });
		expect(usableByCodec(some).h264).toEqual(['h264_nvenc', 'h264_vaapi']);
		const c = selectVideoEncoder(some, { purpose: 'export' })!;
		expect(c).toMatchObject({
			encoder: 'h264_nvenc',
			hardware: true,
			rateControl: 'cq',
			label: 'H.264 · NVIDIA NVENC (hardware)',
		});
		const all = inv(HW_ONLY, { usable: ['h264_videotoolbox', 'h264_nvenc', 'h264_amf', 'h264_vaapi'] });
		expect(selectVideoEncoder(all, { purpose: 'proxy' })?.encoder).toBe('h264_videotoolbox');
		// Hardware beats OpenH264 and libx264.
		const mixed = inv([...FULL_GPL], { usable: ['h264_qsv'], license: 'gpl' });
		expect(selectVideoEncoder(mixed, { purpose: 'export' })?.encoder).toBe('h264_qsv');
	});

	it('full GPL build: OpenH264 before libx264; libx264 only as dev convenience; LGPL-only ignores GPL', () => {
		const gpl = inv(FULL_GPL, { license: 'gpl' });
		expect(usableByCodec(gpl).h264).toEqual(['libopenh264', 'libx264']);
		expect(selectVideoEncoder(gpl, { purpose: 'export' })?.encoder).toBe('libopenh264');
		const x264Only = inv(
			FULL_GPL.filter((e) => e !== 'libopenh264'),
			{ license: 'gpl' },
		);
		expect(selectVideoEncoder(x264Only, { purpose: 'export' })).toMatchObject({
			encoder: 'libx264',
			gpl: true,
			rateControl: 'crf',
		});
		const lgplMode = inv(
			FULL_GPL.filter((e) => e !== 'libopenh264'),
			{ license: 'gpl', lgplOnly: true },
		);
		const c = selectVideoEncoder(lgplMode, { purpose: 'export' })!;
		expect(c.encoder).toBe('libsvtav1');
		expect(c.message).toMatch(/LGPL-only/);
		for (const enc of Object.values(usableByCodec(lgplMode)).flat())
			expect(GPL_ENCODERS.has(enc)).toBe(false);
	});

	it('honours an explicit encoder only when it is usable', () => {
		const gpl = inv(FULL_GPL, { license: 'gpl' });
		expect(selectVideoEncoder(gpl, { purpose: 'export', encoder: 'libx264' })?.encoder).toBe('libx264');
		expect(selectVideoEncoder(gpl, { purpose: 'export', encoder: 'libvpx-vp9' })).toMatchObject({
			codec: 'vp9',
		});
		const lgpl = inv(FULL_GPL, { license: 'gpl', lgplOnly: true });
		const c = selectVideoEncoder(lgpl, { purpose: 'export', encoder: 'libx264' })!;
		expect(c.encoder).toBe('libopenh264');
		expect(c.message).toMatch(/libx264 is not available \(LGPL-only mode\)/);
		// Unusable hardware encoder requested → best available instead.
		expect(selectVideoEncoder(inv(LGPL_LIST), { purpose: 'export', encoder: 'h264_nvenc' })?.encoder).toBe(
			'libsvtav1',
		);
		// A preferred codec other than H.264.
		expect(selectVideoEncoder(gpl, { purpose: 'export', codec: 'av1' })?.encoder).toBe('libsvtav1');
	});

	it('nothing usable → null and a capability message', () => {
		const none = inv(BASE);
		expect(selectVideoEncoder(none, { purpose: 'export' })).toBeNull();
		const caps = EncodingCapabilitiesSchema.parse(encodingCapabilities(none));
		expect(caps.export).toBeNull();
		expect(caps.proxy).toBeNull();
		expect(caps.message).toMatch(/No usable video encoder/);
	});

	it('capabilities report codecs, audio and ProRes (schema-valid)', () => {
		const caps = EncodingCapabilitiesSchema.parse(
			encodingCapabilities({ ...inv(FULL_GPL, { license: 'gpl', lgplOnly: true }), hwaccels: ['vaapi'] }),
		);
		expect(caps).toMatchObject({
			license: 'gpl',
			lgplOnly: true,
			hwaccels: ['vaapi'],
			codecs: { h264: ['libopenh264'], vp9: ['libvpx-vp9'], av1: ['libsvtav1', 'libaom-av1'] },
			audio: { aac: true, opus: true },
			prores: true,
			export: { encoder: 'libopenh264' },
		});
		expect(caps.hardware.map((h) => h.encoder)).toEqual(['h264_nvenc', 'h264_qsv', 'h264_vaapi']);
	});
});

describe('videoEncodeArgs (quality/speed per encoder)', () => {
	it('libx264 keeps the historical preset/CRF mapping and GOP params for proxies', () => {
		expect(videoEncodeArgs({ encoder: 'libx264' }, P).video).toEqual([
			'-c:v',
			'libx264',
			'-preset',
			'medium',
			'-crf',
			'18',
			'-pix_fmt',
			'yuv420p',
		]);
		const proxy = videoEncodeArgs(
			{ encoder: 'libx264' },
			{ ...P, crf: 26, speed: 'fast', gop: 15, realtime: true, threads: 4 },
		).video.join(' ');
		expect(proxy).toBe(
			'-c:v libx264 -preset ultrafast -crf 26 -x264-params keyint=15:min-keyint=15:scenecut=0 -pix_fmt yuv420p -threads 4',
		);
	});

	it('maps CRF to VP9/AV1 scales', () => {
		expect([vp9Crf(18), vp9Crf(23), vp9Crf(26)]).toEqual([32, 38, 42]);
		expect([av1Crf(18), av1Crf(23), av1Crf(26)]).toEqual([28, 35, 39]);
		expect(videoEncodeArgs({ encoder: 'libvpx-vp9' }, P).video.join(' ')).toContain(
			'-b:v 0 -crf 32 -deadline good',
		);
		expect(videoEncodeArgs({ encoder: 'libsvtav1' }, { ...P, speed: 'fast' }).video.join(' ')).toContain(
			'-crf 28 -preset 10',
		);
		expect(videoEncodeArgs({ encoder: 'libaom-av1' }, P).video.join(' ')).toContain('-crf 28 -cpu-used 6');
	});

	it('hardware encoders: pixel formats, device setup and quality knobs', () => {
		const qsv = videoEncodeArgs({ encoder: 'h264_qsv' }, P);
		expect(qsv.filters).toEqual(['format=nv12']);
		expect(qsv.video.join(' ')).toContain('-global_quality 18');
		expect(qsv.video.join(' ')).toContain('-pix_fmt nv12');
		const vaapi = videoEncodeArgs({ encoder: 'h264_vaapi' }, P);
		expect(vaapi.pre).toEqual(['-vaapi_device', '/dev/dri/renderD128']);
		expect(vaapi.filters).toEqual(['format=nv12', 'hwupload']);
		expect(vaapi.video).not.toContain('-pix_fmt');
		expect(videoEncodeArgs({ encoder: 'h264_nvenc' }, P).video.join(' ')).toContain('-rc vbr -cq 18 -b:v 0');
		expect(videoEncodeArgs({ encoder: 'h264_amf' }, P).video.join(' ')).toContain('-rc cqp -qp_i 18');
		expect(videoEncodeArgs({ encoder: 'h264_videotoolbox' }, P).video.join(' ')).toMatch(/-b:v \d+k/);
		// Software encoders get -threads, hardware ones do not.
		expect(videoEncodeArgs({ encoder: 'h264_nvenc' }, { ...P, threads: 8 }).video).not.toContain('-threads');
	});
});

describe('masters and bitrate overrides', () => {
	it('selects prores_ks for ProRes masters: MOV with PCM, never a substitute codec', () => {
		const pr = selectVideoEncoder(inv(OPENH264_ONLY), { purpose: 'export', codec: 'prores' })!;
		expect(pr).toMatchObject({
			codec: 'prores',
			encoder: 'prores_ks',
			container: 'mov',
			audioEncoder: 'pcm_s16le',
			rateControl: 'profile',
			gpl: false,
		});
		expect(usableByCodec(inv(OPENH264_ONLY)).prores).toEqual(['prores_ks']);
		expect(
			selectVideoEncoder(inv(['aac', 'libopenh264']), { purpose: 'export', codec: 'prores' }),
		).toBeNull();
		expect(EncodingCapabilitiesSchema.parse(encodingCapabilities(inv(LGPL_LIST))).codecs.prores).toEqual([
			'prores_ks',
		]);
	});

	it('writes ProRes 422 HQ (10-bit 4:2:2) or 4444 (4:4:4)', () => {
		const hq = videoEncodeArgs({ encoder: 'prores_ks' }, P);
		expect(hq.filters).toEqual(['format=yuv422p10le']);
		expect(hq.video).toEqual([
			'-c:v',
			'prores_ks',
			'-profile:v',
			'3',
			'-vendor',
			'apl0',
			'-pix_fmt',
			'yuv422p10le',
		]);
		const x = videoEncodeArgs({ encoder: 'prores_ks' }, { ...P, proresProfile: '4444' });
		expect(x.filters).toEqual(['format=yuv444p10le']);
		expect(x.video.join(' ')).toContain('-profile:v 4');
	});

	it('uses an explicit bitrate as the OpenH264 target and as the x264 VBV ceiling', () => {
		expect(
			videoEncodeArgs({ encoder: 'libopenh264' }, { ...P, bitrateKbps: 16000 }).video.join(' '),
		).toContain('-b:v 16000k -maxrate 24000k -bufsize 32000k');
		expect(
			videoEncodeArgs({ encoder: 'libx264' }, { ...P, crf: 14, bitrateKbps: 20000 }).video.join(' '),
		).toBe('-c:v libx264 -preset medium -crf 14 -maxrate 20000k -bufsize 40000k -pix_fmt yuv420p');
	});
});

describe('parsing and hardware probing', () => {
	it('parses the build license and hwaccels', () => {
		expect(parseBuildLicense('ffmpeg version 6.1\nconfiguration: --enable-gpl --enable-libx264')).toBe('gpl');
		expect(parseBuildLicense('configuration: --enable-shared --enable-libopenh264 --enable-libvpx')).toBe(
			'lgpl',
		);
		expect(parseBuildLicense('configuration: --enable-gpl --enable-nonfree --enable-libfdk-aac')).toBe(
			'nonfree',
		);
		expect(parseBuildLicense('')).toBe('unknown');
		expect(parseHwaccels('Hardware acceleration methods:\nvdpau\ncuda\nvaapi\n\n')).toEqual([
			'vdpau',
			'cuda',
			'vaapi',
		]);
		expect(
			hwFailureReason('/usr/bin/ffmpeg exited 255: [h264_nvenc @ 0x5581] Cannot load libcuda.so.1\nmore'),
		).toBe('Cannot load libcuda.so.1');
	});

	it('test-encodes listed hardware encoders with a fake ffmpeg and caches per binary', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-fake-ffmpeg-'));
		const log = join(dir, 'calls.log');
		const fake = join(dir, 'ffmpeg');
		// Succeeds only for h264_nvenc; records every call.
		writeFileSync(
			fake,
			`#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in *h264_nvenc*) exit 0;; esac\necho "[h264_qsv @ 0x1] Error creating a MFX session" >&2\nexit 1\n`,
		);
		chmodSync(fake, 0o755);
		const listed = ['h264_nvenc', 'h264_qsv', 'h264_videotoolbox', 'libx264'];
		const r = await probeHardwareEncoders(fake, listed, { platform: 'linux' });
		expect(r).toEqual([
			{ encoder: 'h264_videotoolbox', usable: false, reason: 'not supported on linux' },
			{ encoder: 'h264_nvenc', usable: true },
			{ encoder: 'h264_qsv', usable: false, reason: 'Error creating a MFX session' },
		]);
		const again = await probeHardwareEncoders(fake, listed, { platform: 'linux' });
		expect(again).toBe(r); // cached promise result
		const { readFileSync } = await import('node:fs');
		expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
		expect(hwTestArgs(HW_H264.find((h) => h.encoder === 'h264_vaapi')!).join(' ')).toContain(
			'-vaapi_device /dev/dri/renderD128',
		);

		const svc = await EncoderService.create({
			ffmpeg: fake,
			encoders: [...listed, 'aac', 'libx264'],
			hwaccels: ['cuda'],
			license: 'gpl',
			env: { JASPER_FFMPEG_LGPL_ONLY: '1' },
			platform: 'linux',
		});
		expect(svc.inventory.lgplOnly).toBe(true);
		expect(svc.select({ purpose: 'export' })?.encoder).toBe('h264_nvenc');
		expect(svc.has('libx264')).toBe(false);
		expect(svc.has('aac')).toBe(true);

		const off = await probeHardwareEncoders(fake, listed, { platform: 'linux', disabled: true });
		expect(off.every((h) => !h.usable)).toBe(true);
	});
});
