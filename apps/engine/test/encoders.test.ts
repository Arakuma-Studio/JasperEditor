import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncodingCapabilitiesSchema } from '@jasper/api';
import { describe, expect, it } from 'vitest';
import {
	type EncoderInventory,
	EncoderService,
	encodingCapabilities,
	parseBuildLicense,
	parseHwaccels,
	probeHardwareEncoders,
	selectVideoEncoder,
	usableByCodec,
	videoEncodeArgs,
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
		hardware: encoders
			.filter((encoder) => encoder.startsWith('h264_'))
			.map((encoder) => ({
				encoder,
				usable: (opts.usable ?? []).includes(encoder),
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
		expect(exp.message).toBeTruthy();
		const proxy = selectVideoEncoder(i, { purpose: 'proxy' })!;
		expect(proxy).toMatchObject({ codec: 'vp9', encoder: 'libvpx-vp9', container: 'mp4' });
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
		expect(selectVideoEncoder(inv(vp9Only), { purpose: 'proxy' })).toMatchObject({ container: 'mp4' });
	});

	it('OpenH264-only: H.264 via libopenh264 with bitrate rate control (no CRF)', () => {
		const c = selectVideoEncoder(inv(OPENH264_ONLY), { purpose: 'export' })!;
		expect(c).toMatchObject({ codec: 'h264', encoder: 'libopenh264', rateControl: 'bitrate', gpl: false });
		expect(c.message).toBeUndefined();
		const a = videoEncodeArgs(c, P);
		expect(a.video).not.toContain('-crf');
		expect(a.video).toEqual(expect.arrayContaining(['-c:v', 'libopenh264', '-rc_mode', 'bitrate']));
	});

	it('smart-rendering pieces: no B-frames for every H.264 encoder (they are joined as one raw stream)', () => {
		for (const encoder of [
			'libx264',
			'h264_nvenc',
			'h264_qsv',
			'h264_videotoolbox',
			'h264_vaapi',
			'h264_amf',
		]) {
			const a = videoEncodeArgs({ encoder }, { ...P, noBFrames: true });
			expect(a.video.join(' '), encoder).toContain('-bf 0');
			expect(videoEncodeArgs({ encoder }, P).video).not.toContain('-bf');
		}
		for (const encoder of ['libopenh264', 'prores_ks', 'libvpx-vp9'])
			expect(videoEncodeArgs({ encoder }, { ...P, noBFrames: true }).video, encoder).not.toContain('-bf');
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
		});
		const all = inv(HW_ONLY, { usable: ['h264_videotoolbox', 'h264_nvenc', 'h264_amf', 'h264_vaapi'] });
		expect(selectVideoEncoder(all, { purpose: 'proxy' })?.encoder).toBe('h264_videotoolbox');
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
		expect(c.message).toBeTruthy();
		expect(Object.values(usableByCodec(lgplMode)).flat()).not.toEqual(expect.arrayContaining(['libx264']));
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
		expect(c.message).toBeTruthy();
		expect(selectVideoEncoder(inv(LGPL_LIST), { purpose: 'export', encoder: 'h264_nvenc' })?.encoder).toBe(
			'libsvtav1',
		);
		expect(selectVideoEncoder(gpl, { purpose: 'export', codec: 'av1' })?.encoder).toBe('libsvtav1');
	});

	it('nothing usable → null and a capability message', () => {
		const none = inv(BASE);
		expect(selectVideoEncoder(none, { purpose: 'export' })).toBeNull();
		const caps = EncodingCapabilitiesSchema.parse(encodingCapabilities(none));
		expect(caps.export).toBeNull();
		expect(caps.proxy).toBeNull();
		expect(caps.message).toBeTruthy();
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
			selectVideoEncoder(inv(['aac', 'libopenh264', 'libvpx-vp9']), {
				purpose: 'export',
				codec: 'prores',
			}),
		).toBeNull();
		expect(EncodingCapabilitiesSchema.parse(encodingCapabilities(inv(LGPL_LIST))).codecs.prores).toEqual([
			'prores_ks',
		]);
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
	});

	it('excludes hardware whose external test encode fails and honors LGPL-only/disabled configuration', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-fake-ffmpeg-'));
		const fake = join(dir, 'ffmpeg');
		// External encoder success/failure is the process protocol, not a selector mock.
		writeFileSync(
			fake,
			`#!/bin/sh\ncase "$*" in *h264_nvenc*) exit 0;; esac\necho "[h264_qsv @ 0x1] Error creating a MFX session" >&2\nexit 1\n`,
		);
		chmodSync(fake, 0o755);
		const listed = ['h264_nvenc', 'h264_qsv', 'h264_videotoolbox', 'libx264'];
		const r = await probeHardwareEncoders(fake, listed, { platform: 'linux' });
		expect(r.map(({ encoder, usable }) => ({ encoder, usable }))).toEqual([
			{ encoder: 'h264_videotoolbox', usable: false },
			{ encoder: 'h264_nvenc', usable: true },
			{ encoder: 'h264_qsv', usable: false },
		]);

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
