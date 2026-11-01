// LGPL-safe encoder selection (ARCHITECTURE D-13). The product must work with an LGPL FFmpeg that has
// no libx264/libx265: H.264 comes from a hardware encoder (confirmed by a tiny test encode) or Cisco's
// OpenH264; libx264 is only a dev convenience when the build happens to have it; without any H.264
// encoder exports fall back to AV1 (MP4) or VP9 (WebM) with a capability message. Audio: native `aac`,
// Opus via `libopus`. Alpha intermediates: `prores_ks`.
import { existsSync } from 'node:fs';
import type { EncoderChoice, EncodingCapabilities, VideoCodec } from '@jasper/api';
import { runTool } from './process.ts';
import { restrictInputs } from './protocols.ts';

/** Env switch: ignore GPL/nonfree encoders even when the build has them (tests, license audits). */
const LGPL_ONLY_ENV = 'JASPER_FFMPEG_LGPL_ONLY';
/** Env switch: `0`/`off` skips hardware encoder test encodes (all hardware encoders count as unusable). */
const HW_ENCODERS_ENV = 'JASPER_HW_ENCODERS';

/** Encoders that make an FFmpeg build GPL (or nonfree). Never selected in LGPL-only mode. */
const GPL_ENCODERS = new Set([
	'libx264',
	'libx264rgb',
	'libx265',
	'libxvid',
	'libxavs',
	'libxavs2',
	'libfdk_aac', // nonfree with GPL, LGPL-compatible only without --enable-gpl; treated as excluded
]);

type HwEncoderSpec = {
	encoder: string;
	label: string;
	/** Platforms where the encoder can work at all (others are skipped without a test). */
	platforms: NodeJS.Platform[];
	/** Pixel format handed to the encoder (after the filter graph). */
	pixFmt: string;
	/** Needs `-vaapi_device` + `hwupload` (VAAPI). */
	vaapi?: boolean;
};

/** Hardware H.264 encoders in preference order (D-13). */
const HW_H264: readonly HwEncoderSpec[] = [
	{ encoder: 'h264_videotoolbox', label: 'Apple VideoToolbox', platforms: ['darwin'], pixFmt: 'yuv420p' },
	{ encoder: 'h264_nvenc', label: 'NVIDIA NVENC', platforms: ['linux', 'win32'], pixFmt: 'yuv420p' },
	{ encoder: 'h264_qsv', label: 'Intel Quick Sync', platforms: ['linux', 'win32'], pixFmt: 'nv12' },
	{ encoder: 'h264_amf', label: 'AMD AMF', platforms: ['win32', 'linux'], pixFmt: 'yuv420p' },
	{ encoder: 'h264_vaapi', label: 'VA-API', platforms: ['linux'], pixFmt: 'nv12', vaapi: true },
];

/**
 * gaps (EX-2): hardware HEVC encoders in preference order (Main and Main10; `pixFmt10` = their 10-bit input). The
 * software HEVC encoder of the LGPL build is libkvazaar (BSD-3-Clause), 8-bit (Main) only.
 */
const HW_HEVC: readonly (HwEncoderSpec & { pixFmt10: string })[] = [
	{
		encoder: 'hevc_videotoolbox',
		label: 'Apple VideoToolbox',
		platforms: ['darwin'],
		pixFmt: 'yuv420p',
		pixFmt10: 'p010le',
	},
	{
		encoder: 'hevc_nvenc',
		label: 'NVIDIA NVENC',
		platforms: ['linux', 'win32'],
		pixFmt: 'yuv420p',
		pixFmt10: 'p010le',
	},
	{
		encoder: 'hevc_qsv',
		label: 'Intel Quick Sync',
		platforms: ['linux', 'win32'],
		pixFmt: 'nv12',
		pixFmt10: 'p010le',
	},
	{
		encoder: 'hevc_amf',
		label: 'AMD AMF',
		platforms: ['win32', 'linux'],
		pixFmt: 'yuv420p',
		pixFmt10: 'p010le',
	},
	{
		encoder: 'hevc_vaapi',
		label: 'VA-API',
		platforms: ['linux'],
		pixFmt: 'nv12',
		pixFmt10: 'p010le',
		vaapi: true,
	},
];
const HW_ALL: readonly HwEncoderSpec[] = [...HW_H264, ...HW_HEVC];

const VAAPI_DEVICE = '/dev/dri/renderD128';

const SOFTWARE_LABELS: Record<string, string> = {
	libopenh264: 'OpenH264',
	libx264: 'x264',
	'libvpx-vp9': 'libvpx',
	libsvtav1: 'SVT-AV1',
	'libaom-av1': 'libaom',
	libkvazaar: 'Kvazaar',
};

/** AV1/VP9 fallback order for exports (quality/speed) and for proxies (cheap browser decode). */
const EXPORT_FALLBACK: readonly [VideoCodec, string][] = [
	['av1', 'libsvtav1'],
	['vp9', 'libvpx-vp9'],
	['av1', 'libaom-av1'],
];
const PROXY_FALLBACK: readonly [VideoCodec, string][] = [
	['vp9', 'libvpx-vp9'],
	['av1', 'libsvtav1'],
	['av1', 'libaom-av1'],
];

type HwTestResult = { encoder: string; usable: boolean; reason?: string };

export type EncoderInventory = {
	/** `ffmpeg -encoders` names as listed by the build. */
	encoders: readonly string[];
	/** `ffmpeg -hwaccels`. */
	hwaccels: readonly string[];
	license: EncodingCapabilities['license'];
	lgplOnly: boolean;
	/** Test-encode results for the hardware encoders the build lists. */
	hardware: readonly HwTestResult[];
};

type EncoderPurpose = 'export' | 'proxy';

export type EncoderRequest = {
	purpose: EncoderPurpose;
	/** Preferred codec (default h264). */
	codec?: VideoCodec;
	/** Explicit encoder; ignored (with a message) when it is not usable. */
	encoder?: string;
	/**
	 * The container an export asked for (`ExportSettings.container`): written when the codec fits it
	 * (`CONTAINER_VIDEO_CODECS`), else the codec's own container — the planner reports the change (AGENTS §4).
	 */
	container?: EncoderChoice['container'];
	/** The audio codec an export asked for: written when the container carries it (`CONTAINER_AUDIO_CODECS`). */
	audio?: ExportAudioCodec;
};

export type ExportAudioCodec = 'aac' | 'opus' | 'pcm';

/**
 * Video codecs each export container carries here (ffmpeg's mp4 / mov / webm muxers; WP6.5a). ProRes is MOV only, WebM
 * is VP9 / AV1 only.
 */
export const CONTAINER_VIDEO_CODECS: Record<EncoderChoice['container'], readonly VideoCodec[]> = {
	mp4: ['h264', 'hevc', 'av1', 'vp9'],
	mov: ['h264', 'hevc', 'prores'],
	webm: ['vp9', 'av1'],
};

/** Audio codecs each container carries here: PCM needs MOV, Opus WebM (MP4 / MOV take AAC). */
export const CONTAINER_AUDIO_CODECS: Record<EncoderChoice['container'], readonly ExportAudioCodec[]> = {
	mp4: ['aac'],
	mov: ['pcm', 'aac'],
	webm: ['opus'],
};

/** The audio codec an ffmpeg audio encoder name stands for. */
export function audioCodecFamily(encoder: string): ExportAudioCodec {
	return encoder === 'libopus' ? 'opus' : encoder.startsWith('pcm_') ? 'pcm' : 'aac';
}

/**
 * The container and audio encoder of an export: the codec's own (ProRes → MOV + PCM, VP9 → WebM + Opus when this
 * ffmpeg has Opus, else MP4 + AAC) unless the request asks for another container the codec fits, and the requested
 * audio codec when that container carries it. ProRes masters always carry PCM (Premiere's QuickTime ProRes presets
 * use uncompressed audio); what the request did not get is reported by the planner, never silently.
 */
export function fitOutputFormat(
	codec: VideoCodec,
	purpose: EncoderPurpose,
	opus: boolean,
	want: { container?: EncoderChoice['container']; audio?: ExportAudioCodec } = {},
): { container: EncoderChoice['container']; audioEncoder: string } {
	// Proxies stay MP4 whatever the codec (Chrome plays VP9/AV1 in MP4; one proxy URL/content type).
	let container: EncoderChoice['container'] =
		codec === 'prores' ? 'mov' : purpose === 'export' && codec === 'vp9' && opus ? 'webm' : 'mp4';
	if (
		purpose === 'export' &&
		want.container &&
		CONTAINER_VIDEO_CODECS[want.container].includes(codec) &&
		(want.container !== 'webm' || opus)
	)
		container = want.container;
	let audioEncoder = container === 'webm' ? 'libopus' : container === 'mov' ? 'pcm_s16le' : 'aac';
	const a = want.audio;
	if (
		purpose === 'export' &&
		a &&
		CONTAINER_AUDIO_CODECS[container].includes(a) &&
		(a !== 'opus' || opus) &&
		(codec !== 'prores' || a === 'pcm')
	)
		audioEncoder = a === 'aac' ? 'aac' : a === 'opus' ? 'libopus' : 'pcm_s16le';
	return { container, audioEncoder };
}

/**
 * Why an export is not written as asked (null: it is): the container and / or the audio codec the request named and
 * what the file gets instead, in words (plan warnings OUTPUT_CONTAINER_CHANGED / AUDIO_CODEC_CHANGED, AGENTS §4).
 */
export function outputFormatChanges(
	choice: Pick<EncoderChoice, 'codec' | 'container' | 'audioEncoder'>,
	want: { container?: EncoderChoice['container']; audio?: ExportAudioCodec },
): {
	code: 'OUTPUT_CONTAINER_CHANGED' | 'AUDIO_CODEC_CHANGED';
	message: string;
	/** The values for editors that say it in their language (`ExportWarningParamsSchema`). */
	params: Record<string, string>;
}[] {
	const out: ReturnType<typeof outputFormatChanges> = [];
	const name = codecName(choice.codec);
	const C = (c: string) => c.toUpperCase();
	if (want.container && want.container !== choice.container) {
		const reason = !CONTAINER_VIDEO_CODECS[want.container].includes(choice.codec)
			? 'codec'
			: want.container === 'webm'
				? 'opus'
				: 'muxer';
		const accepts = CONTAINER_VIDEO_CODECS[want.container].map(codecName).join(', ');
		const why =
			reason === 'codec'
				? `${C(want.container)} does not carry ${name} (${C(want.container)} takes ${accepts})`
				: reason === 'opus'
					? 'WebM needs Opus audio, which this ffmpeg build lacks'
					: `${name} is written as ${C(choice.container)} here`;
		out.push({
			code: 'OUTPUT_CONTAINER_CHANGED',
			message: `${C(want.container)} was requested but ${why}: the file is ${C(choice.container)}`,
			params: {
				requested: C(want.container),
				written: C(choice.container),
				why: reason,
				codec: name,
				...(reason === 'codec' ? { accepts } : {}),
			},
		});
	}
	const got = audioCodecFamily(choice.audioEncoder);
	if (want.audio && want.audio !== got) {
		const A = { aac: 'AAC', opus: 'Opus', pcm: 'PCM' } as const;
		const reason =
			choice.codec === 'prores' && CONTAINER_AUDIO_CODECS[choice.container].includes(want.audio)
				? 'prores'
				: !CONTAINER_AUDIO_CODECS[choice.container].includes(want.audio)
					? 'container'
					: 'no-opus';
		const why =
			reason === 'prores'
				? 'ProRes masters carry PCM audio'
				: reason === 'container'
					? `${C(choice.container)} does not carry ${A[want.audio]} audio${want.audio === 'pcm' ? ' (PCM needs MOV)' : want.audio === 'opus' ? ' (Opus needs WebM)' : ''}`
					: 'this ffmpeg build has no Opus encoder';
		out.push({
			code: 'AUDIO_CODEC_CHANGED',
			message: `${A[want.audio]} audio was requested but ${why}: the audio is ${A[got]}`,
			params: { requested: A[want.audio], written: A[got], container: C(choice.container), why: reason },
		});
	}
	return out;
}

/** The pre-D-13 behaviour (libx264 + AAC in MP4) for callers without an EncoderService (unit tests). */
export const LEGACY_X264_CHOICE: EncoderChoice = {
	codec: 'h264',
	encoder: 'libx264',
	label: 'H.264 · x264 (software)',
	hardware: false,
	container: 'mp4',
	audioEncoder: 'aac',
	rateControl: 'crf',
	gpl: true,
};

/** Build license from `ffmpeg -version` / `-buildconf` output. */
export function parseBuildLicense(versionOut: string): EncodingCapabilities['license'] {
	const m = /configuration:(.*)/.exec(versionOut);
	if (!m) {
		if (/--enable-/.test(versionOut)) return licenseOfFlags(versionOut);
		return 'unknown';
	}
	return licenseOfFlags(m[1]!);
}

function licenseOfFlags(flags: string): EncodingCapabilities['license'] {
	if (/--enable-nonfree\b/.test(flags)) return 'nonfree';
	if (/--enable-gpl\b/.test(flags)) return 'gpl';
	return 'lgpl';
}

/** `ffmpeg -hwaccels`: names after the "Hardware acceleration methods:" line. */
export function parseHwaccels(out: string): string[] {
	const names: string[] = [];
	let started = false;
	for (const line of out.split('\n')) {
		if (!started) {
			if (/acceleration methods/i.test(line)) started = true;
			continue;
		}
		const t = line.trim();
		if (/^[a-z0-9_]+$/i.test(t)) names.push(t);
	}
	return names;
}

/** Encoders the selector may use: GPL/nonfree ones removed in LGPL-only mode. */
function effectiveEncoders(inv: Pick<EncoderInventory, 'encoders' | 'lgplOnly'>): string[] {
	return inv.encoders.filter((e) => !(inv.lgplOnly && GPL_ENCODERS.has(e)));
}

/** Usable encoders per codec in preference order. */
export function usableByCodec(inv: EncoderInventory): Record<VideoCodec, string[]> {
	const have = new Set(effectiveEncoders(inv));
	const hwOk = new Set(inv.hardware.filter((h) => h.usable).map((h) => h.encoder));
	const h264 = [
		...HW_H264.filter((h) => have.has(h.encoder) && hwOk.has(h.encoder)).map((h) => h.encoder),
		...['libopenh264', 'libx264'].filter((e) => have.has(e)),
	];
	return {
		h264,
		vp9: ['libvpx-vp9'].filter((e) => have.has(e)),
		av1: ['libsvtav1', 'libaom-av1'].filter((e) => have.has(e)),
		prores: ['prores_ks'].filter((e) => have.has(e)),
		hevc: [
			...HW_HEVC.filter((h) => have.has(h.encoder) && hwOk.has(h.encoder)).map((h) => h.encoder),
			...['libkvazaar'].filter((e) => have.has(e)),
		],
	};
}

function codecName(c: VideoCodec): string {
	return c === 'h264'
		? 'H.264'
		: c === 'vp9'
			? 'VP9'
			: c === 'prores'
				? 'ProRes'
				: c === 'hevc'
					? 'HEVC'
					: 'AV1';
}

function encoderLabel(codec: VideoCodec, encoder: string): string {
	const hw = HW_ALL.find((h) => h.encoder === encoder);
	if (hw) return `${codecName(codec)} · ${hw.label} (hardware)`;
	return `${codecName(codec)} · ${SOFTWARE_LABELS[encoder] ?? encoder} (software)`;
}

function rateControlOf(encoder: string): EncoderChoice['rateControl'] {
	switch (encoder) {
		case 'libx264':
		case 'libvpx-vp9':
		case 'libsvtav1':
		case 'libaom-av1':
			return 'crf';
		case 'h264_nvenc':
		case 'h264_qsv':
		case 'hevc_nvenc':
		case 'hevc_qsv':
			return 'cq';
		case 'h264_amf':
		case 'h264_vaapi':
		case 'hevc_amf':
		case 'hevc_vaapi':
		case 'libkvazaar':
			return 'qp';
		case 'prores_ks':
			return 'profile';
		default:
			// libopenh264 has no CRF; VideoToolbox is driven by bitrate for portability.
			return 'bitrate';
	}
}

function makeChoice(
	inv: EncoderInventory,
	codec: VideoCodec,
	encoder: string,
	purpose: EncoderPurpose,
	message?: string,
	want: Pick<EncoderRequest, 'container' | 'audio'> = {},
): EncoderChoice {
	const opus = effectiveEncoders(inv).includes('libopus');
	// ProRes masters are MOV with PCM audio; a requested container / audio codec is honoured where it fits.
	const { container, audioEncoder } = fitOutputFormat(codec, purpose, opus, want);
	return {
		codec,
		encoder,
		label: encoderLabel(codec, encoder),
		hardware: HW_ALL.some((h) => h.encoder === encoder),
		container,
		audioEncoder,
		rateControl: rateControlOf(encoder),
		gpl: GPL_ENCODERS.has(encoder),
		...(message ? { message } : {}),
	};
}

/**
 * Picks the video encoder for an export or proxies (D-13). Order for H.264: usable hardware
 * (VideoToolbox, NVENC, QSV, AMF, VAAPI) → libopenh264 → libx264 (only when present and not LGPL-only);
 * without H.264, exports fall back to AV1 (SVT-AV1) / VP9 / AV1 (libaom), proxies to VP9 / AV1.
 * Returns null when nothing can encode video.
 */
export function selectVideoEncoder(inv: EncoderInventory, req: EncoderRequest): EncoderChoice | null {
	const byCodec = usableByCodec(inv);
	const want: VideoCodec = req.codec ?? 'h264';
	let note: string | undefined;
	if (req.encoder) {
		const codec = (Object.keys(byCodec) as VideoCodec[]).find((c) => byCodec[c].includes(req.encoder!));
		if (codec) return makeChoice(inv, codec, req.encoder, req.purpose, undefined, req);
		note = `Encoder ${req.encoder} is not available${inv.lgplOnly && GPL_ENCODERS.has(req.encoder) ? ' (LGPL-only mode)' : ''}`;
	}
	const first = byCodec[want][0];
	if (first) return makeChoice(inv, want, first, req.purpose, note, req);
	if (want === 'prores') return null; // a master must be ProRes: no silent substitution
	const order = req.purpose === 'proxy' ? PROXY_FALLBACK : EXPORT_FALLBACK;
	for (const [codec, enc] of order) {
		if (byCodec[codec].includes(enc)) {
			const choice = makeChoice(inv, codec, enc, req.purpose, undefined, req);
			const why =
				want === 'h264'
					? `H.264 is unavailable (no usable hardware encoder, no OpenH264${inv.lgplOnly ? ', libx264 ignored in LGPL-only mode' : ''})`
					: `${codecName(want)} is unavailable`;
			const what =
				req.purpose === 'proxy'
					? `proxies use ${codecName(codec)} (MP4)`
					: `exporting ${codecName(codec)} (${choice.container.toUpperCase()})`;
			choice.message = [note, `${why}: ${what}`].filter(Boolean).join('. ');
			return choice;
		}
	}
	return null;
}

/** `media.encoding` of `GET /api/capabilities`. */
export function encodingCapabilities(inv: EncoderInventory): EncodingCapabilities {
	const have = new Set(effectiveEncoders(inv));
	const exp = selectVideoEncoder(inv, { purpose: 'export' });
	const proxy = selectVideoEncoder(inv, { purpose: 'proxy' });
	const message = exp
		? exp.message
		: 'No usable video encoder: native exports and proxies are unavailable (install an FFmpeg with OpenH264, libvpx or SVT-AV1)';
	return {
		license: inv.license,
		lgplOnly: inv.lgplOnly,
		hwaccels: [...inv.hwaccels],
		hardware: inv.hardware.map((h) => ({ ...h })),
		codecs: usableByCodec(inv),
		audio: { aac: have.has('aac'), opus: have.has('libopus') },
		prores: have.has('prores_ks'),
		export: exp,
		proxy,
		...(message ? { message } : {}),
	};
}

type EncodeParams = {
	/** x264-style CRF 0–51 (the export quality setting); mapped per encoder. */
	crf: number;
	speed: 'fast' | 'balanced' | 'best';
	width: number;
	height: number;
	fps: { num: number; den: number };
	/** Fixed GOP (proxies: 15 for scrubbing); default ≈ 2 s. */
	gop?: number;
	/** Proxy/realtime tuning (fast presets, no B-frame lookahead). */
	realtime?: boolean;
	/** No B-frames (smart-rendering pieces: joined as one raw H.264 stream without timestamps). */
	noBFrames?: boolean;
	threads?: number;
	/**
	 * Average bitrate (kbit/s): the target of bitrate-driven encoders instead of the CRF mapping, and a VBV
	 * ceiling for x264. ProRes and the CQ/QP encoders ignore it.
	 */
	bitrateKbps?: number;
	/** ProRes profile (`prores_ks`): 422 HQ (default) or 4444. */
	proresProfile?: 'hq' | '4444';
	/** color-mgmt: bits per component (default 8; ProRes is always 10). */
	bitDepth?: 8 | 10 | 12;
	/** color-mgmt: H.273 code points of the output colour (default BT.709) for encoders that need them explicitly. */
	colorCodes?: { primaries: number; trc: number; matrix: number };
	/** color-mgmt: SVT-AV1 HDR metadata parameters (`mastering-display=…:content-light=…`). */
	svtHdr?: string | null;
};

type EncodeArgs = {
	/** Global options placed before the inputs (hardware device init). */
	pre: string[];
	/** Filters appended to the end of the video chain (pixel format, hardware upload). */
	filters: string[];
	/** Output video options (`-c:v …`), without the output file. */
	video: string[];
};

/** Average bitrate (kbit/s) that roughly matches an x264 CRF, for bitrate-only encoders. */
function bitrateForCrf(crf: number, width: number, height: number, fps: number, factor = 1): number {
	// Bits per pixel: 0.15 at CRF 18, halving every 6 CRF steps.
	const bpp = 0.15 * 2 ** ((18 - crf) / 6);
	return Math.max(200, Math.round((width * height * fps * bpp * factor) / 1000));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
/** Kvazaar's intra period must be a multiple of its 8-frame B-GOP (1 = intra only). */
export const kvazaarPeriod = (gop: number) => (gop <= 1 ? 1 : Math.ceil(gop / 8) * 8);
/** H.273 code points → Kvazaar's VUI names (`--colorprim`, `--transfer`, `--colormatrix`). */
const KVZ_PRIMARIES: Record<number, string> = {
	1: 'bt709',
	5: 'bt470bg',
	6: 'smpte170m',
	9: 'bt2020',
	11: 'smpte431',
	12: 'smpte432',
};
const KVZ_TRANSFER: Record<number, string> = {
	1: 'bt709',
	6: 'smpte170m',
	8: 'linear',
	13: 'srgb',
	14: 'bt2020-10',
	15: 'bt2020-12',
	16: 'smpte2084',
	18: 'arib-std-b67',
};
const KVZ_MATRIX: Record<number, string> = {
	0: 'GBR',
	1: 'bt709',
	5: 'bt470bg',
	6: 'smpte170m',
	9: 'bt2020nc',
	10: 'bt2020c',
};
/** x264 CRF → libvpx-vp9 CRF (0–63): 18 → 32, 23 → 38, 26 → 42. */
export const vp9Crf = (crf: number) => clamp(crf * 1.25 + 9.5, 4, 63);
/** x264 CRF → AV1 CRF (SVT-AV1/libaom 0–63): 18 → 28, 23 → 35, 26 → 39. */
const av1Crf = (crf: number) => clamp(crf * 1.35 + 3.7, 1, 63);

/** Pixel format the encoder receives from the filter graph (color-mgmt: 10/12-bit 4:2:0 for AV1/VP9; export verification). */
export function pixFmtFor(
	encoder: string,
	proresProfile: 'hq' | '4444' = 'hq',
	bitDepth: 8 | 10 | 12 = 8,
): string {
	if (encoder === 'prores_ks') return proresProfile === '4444' ? 'yuv444p10le' : 'yuv422p10le';
	if (bitDepth > 8 && (encoder === 'libsvtav1' || encoder === 'libaom-av1' || encoder === 'libvpx-vp9'))
		return bitDepth === 12 && encoder !== 'libsvtav1' ? 'yuv420p12le' : 'yuv420p10le';
	const hevc = HW_HEVC.find((h) => h.encoder === encoder);
	if (hevc) return bitDepth > 8 ? hevc.pixFmt10 : hevc.pixFmt;
	return HW_H264.find((h) => h.encoder === encoder)?.pixFmt ?? 'yuv420p';
}

/** ffmpeg arguments for a chosen encoder (quality/speed mapped per encoder, D-13). */
export function videoEncodeArgs(choice: Pick<EncoderChoice, 'encoder'>, p: EncodeParams): EncodeArgs {
	const fps = p.fps.num / p.fps.den;
	const gop = p.gop ?? Math.max(1, Math.round(fps * 2));
	const crf = clamp(p.crf, 0, 51);
	const rate = (factor: number) => {
		const b = p.bitrateKbps ?? bitrateForCrf(crf, p.width, p.height, fps, factor);
		return ['-b:v', `${b}k`, '-maxrate', `${Math.round(b * 1.5)}k`, '-bufsize', `${b * 2}k`];
	};
	const enc = choice.encoder;
	const pix = pixFmtFor(enc, p.proresProfile, p.bitDepth);
	const pre: string[] = [];
	let filters = [`format=${pix}`];
	const video: string[] = ['-c:v', enc];
	switch (enc) {
		case 'libx264':
			video.push(
				'-preset',
				p.realtime
					? p.speed === 'fast'
						? 'ultrafast'
						: 'veryfast'
					: p.speed === 'fast'
						? 'veryfast'
						: p.speed === 'best'
							? 'slow'
							: 'medium',
				'-crf',
				String(crf),
			);
			if (p.gop) video.push('-x264-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0`);
			if (p.bitrateKbps) video.push('-maxrate', `${p.bitrateKbps}k`, '-bufsize', `${p.bitrateKbps * 2}k`);
			break;
		case 'prores_ks':
			// 422 HQ ≈ 220 Mbit/s and 4444 ≈ 330 Mbit/s at 1080p30 (prores_ks picks the quantizer per frame).
			video.push('-profile:v', p.proresProfile === '4444' ? '4' : '3', '-vendor', 'apl0');
			break;
		case 'libopenh264':
			// No CRF: average bitrate with a VBV cap; frame skipping off so the frame count is exact.
			video.push(...rate(1.3), '-rc_mode', 'bitrate', '-allow_skip_frames', '0', '-g', String(gop));
			// FFmpeg 7.1's OpenH264 wrapper writes only the matrix into the VUI: set primaries/transfer too (BT.709
			// unless the export's colour space says otherwise, color-mgmt), like x264 does from -color_primaries/-color_trc.
			video.push(
				'-bsf:v',
				`h264_metadata=colour_primaries=${p.colorCodes?.primaries ?? 1}:transfer_characteristics=${p.colorCodes?.trc ?? 1}:matrix_coefficients=${p.colorCodes?.matrix ?? 1}`,
			);
			break;
		case 'h264_videotoolbox':
			video.push(...rate(1.2), '-profile:v', 'high', '-g', String(gop));
			break;
		case 'h264_nvenc':
			video.push(
				'-preset',
				p.realtime || p.speed === 'fast' ? 'p2' : p.speed === 'best' ? 'p6' : 'p4',
				'-rc',
				'vbr',
				'-cq',
				String(Math.max(1, crf)),
				'-b:v',
				'0',
				'-profile:v',
				'high',
				'-g',
				String(gop),
			);
			break;
		case 'h264_qsv':
			video.push(
				'-preset',
				p.realtime || p.speed === 'fast' ? 'veryfast' : p.speed === 'best' ? 'slow' : 'medium',
				'-global_quality',
				String(Math.max(1, crf)),
				'-profile:v',
				'high',
				'-g',
				String(gop),
			);
			break;
		case 'h264_amf':
			video.push(
				'-quality',
				p.realtime || p.speed === 'fast' ? 'speed' : p.speed === 'best' ? 'quality' : 'balanced',
				'-rc',
				'cqp',
				'-qp_i',
				String(crf),
				'-qp_p',
				String(crf),
				'-qp_b',
				String(crf),
				'-g',
				String(gop),
			);
			break;
		case 'h264_vaapi':
			pre.push('-vaapi_device', VAAPI_DEVICE);
			filters = ['format=nv12', 'hwupload'];
			video.push('-rc_mode', 'CQP', '-qp', String(Math.max(1, crf)), '-g', String(gop));
			break;
		// gaps (EX-2): HEVC. Kvazaar: constant QP (x264 CRF + 3 ≈ the same visual quality at ≈ 60 % of the size),
		// presets by speed, intra period = the GOP, VUI colour description from the export colour space; `hvc1` so
		// QuickTime / Apple players accept the file.
		case 'libkvazaar': {
			const preset = p.realtime || p.speed === 'fast' ? 'ultrafast' : p.speed === 'best' ? 'slow' : 'medium';
			const vui = p.colorCodes
				? [
						`colorprim=${KVZ_PRIMARIES[p.colorCodes.primaries] ?? 'bt709'}`,
						`transfer=${KVZ_TRANSFER[p.colorCodes.trc] ?? 'bt709'}`,
						`colormatrix=${KVZ_MATRIX[p.colorCodes.matrix] ?? 'bt709'}`,
					]
				: ['colorprim=bt709', 'transfer=bt709', 'colormatrix=bt709'];
			video.push(
				'-kvazaar-params',
				[`preset=${preset}`, `qp=${clamp(crf + 3, 0, 51)}`, `period=${kvazaarPeriod(gop)}`, ...vui].join(','),
				'-tag:v',
				'hvc1',
			);
			break;
		}
		case 'hevc_videotoolbox':
			video.push(
				...rate(0.8),
				'-profile:v',
				p.bitDepth && p.bitDepth > 8 ? 'main10' : 'main',
				'-g',
				String(gop),
				'-tag:v',
				'hvc1',
			);
			break;
		case 'hevc_nvenc':
			video.push(
				'-preset',
				p.realtime || p.speed === 'fast' ? 'p2' : p.speed === 'best' ? 'p6' : 'p4',
				'-rc',
				'vbr',
				'-cq',
				String(Math.max(1, crf + 3)),
				'-b:v',
				'0',
				'-profile:v',
				p.bitDepth && p.bitDepth > 8 ? 'main10' : 'main',
				'-g',
				String(gop),
				'-tag:v',
				'hvc1',
			);
			break;
		case 'hevc_qsv':
			video.push(
				'-global_quality',
				String(Math.max(1, crf + 3)),
				'-profile:v',
				p.bitDepth && p.bitDepth > 8 ? 'main10' : 'main',
				'-g',
				String(gop),
				'-tag:v',
				'hvc1',
			);
			break;
		case 'hevc_amf':
			video.push(
				'-rc',
				'cqp',
				'-qp_i',
				String(crf + 3),
				'-qp_p',
				String(crf + 3),
				'-profile:v',
				p.bitDepth && p.bitDepth > 8 ? 'main10' : 'main',
				'-g',
				String(gop),
				'-tag:v',
				'hvc1',
			);
			break;
		case 'hevc_vaapi':
			pre.push('-vaapi_device', VAAPI_DEVICE);
			filters = [`format=${p.bitDepth && p.bitDepth > 8 ? 'p010' : 'nv12'}`, 'hwupload'];
			video.push(
				'-rc_mode',
				'CQP',
				'-qp',
				String(Math.max(1, crf + 3)),
				'-profile:v',
				p.bitDepth && p.bitDepth > 8 ? 'main10' : 'main',
				'-g',
				String(gop),
				'-tag:v',
				'hvc1',
			);
			break;
		case 'libvpx-vp9':
			video.push(
				'-b:v',
				'0',
				'-crf',
				String(vp9Crf(crf)),
				'-deadline',
				p.realtime ? 'realtime' : 'good',
				'-cpu-used',
				String(p.realtime ? 8 : p.speed === 'fast' ? 5 : p.speed === 'best' ? 1 : 3),
				'-row-mt',
				'1',
				'-g',
				String(gop),
			);
			break;
		case 'libsvtav1':
			video.push(
				'-crf',
				String(av1Crf(crf)),
				'-preset',
				String(p.realtime ? 12 : p.speed === 'fast' ? 10 : p.speed === 'best' ? 5 : 8),
				'-g',
				String(gop),
				// color-mgmt: HDR10 static metadata as AV1 metadata OBUs.
				...(p.svtHdr ? ['-svtav1-params', p.svtHdr] : []),
			);
			break;
		case 'libaom-av1':
			video.push(
				'-b:v',
				'0',
				'-crf',
				String(av1Crf(crf)),
				'-cpu-used',
				String(p.realtime || p.speed === 'fast' ? 8 : p.speed === 'best' ? 4 : 6),
				...(p.realtime || p.speed === 'fast' ? ['-usage', 'realtime'] : []),
				'-row-mt',
				'1',
				'-g',
				String(gop),
			);
			break;
		default:
			video.push(...rate(1.2), '-g', String(gop));
	}
	// B-frames can lose frames at joins with copied GOPs. OpenH264 never produces B-frames.
	if (p.noBFrames && (enc === 'libx264' || HW_H264.some((h) => h.encoder === enc))) video.push('-bf', '0');
	if (!filters.includes('hwupload')) video.push('-pix_fmt', pix);
	if (p.threads && !HW_ALL.some((h) => h.encoder === enc)) video.push('-threads', String(p.threads));
	return { pre, filters, video };
}

/** Audio encoder arguments for a container (`aac` in MP4, `libopus` in WebM). */
export function audioEncodeArgs(audioEncoder: string, kbps: number, channels = 2, bits?: 16 | 24): string[] {
	// spec 18 AF-EXP-002: FLAC files at 16 or 24 bits (the encoder writes 24-bit from s32 samples)
	if (audioEncoder === 'flac') return ['-c:a', 'flac', '-sample_fmt', bits === 16 ? 's16' : 's32'];
	// audio-mix: Opus needs the Vorbis channel mapping (family 1) above two channels (discrete 5.1).
	if (audioEncoder === 'libopus')
		return [
			'-c:a',
			'libopus',
			'-b:a',
			`${Math.min(510 * Math.max(1, channels / 2), kbps)}k`,
			...(channels > 2 ? ['-mapping_family', '1'] : []),
		];
	if (audioEncoder === 'pcm_s16le' || audioEncoder === 'pcm_s24le') return ['-c:a', audioEncoder];
	return ['-c:a', 'aac', '-b:a', `${kbps}k`];
}

const hwCache = new Map<string, Promise<HwTestResult[]>>();

/** Test-encode arguments for a hardware encoder (a few black frames to the null muxer). */
function hwTestArgs(spec: HwEncoderSpec): string[] {
	const pre = spec.vaapi ? ['-vaapi_device', VAAPI_DEVICE] : [];
	const vf = spec.vaapi ? 'format=nv12,hwupload' : `format=${spec.pixFmt}`;
	return [
		'-hide_banner',
		'-nostdin',
		'-loglevel',
		'error',
		...pre,
		'-f',
		'lavfi',
		'-i',
		'color=c=black:s=256x144:r=30:d=0.2',
		'-frames:v',
		'3',
		'-vf',
		vf,
		'-c:v',
		spec.encoder,
		'-f',
		'null',
		'-',
	];
}

/**
 * Confirms which listed hardware H.264 encoders actually work (a listed encoder often has no device or
 * driver). Test encodes run in parallel with a timeout; results are cached per ffmpeg binary.
 */
export function probeHardwareEncoders(
	ffmpeg: string | null,
	listed: readonly string[],
	opts: { platform?: NodeJS.Platform; timeoutMs?: number; disabled?: boolean } = {},
): Promise<HwTestResult[]> {
	const platform = opts.platform ?? process.platform;
	const specs = HW_ALL.filter((h) => listed.includes(h.encoder));
	if (!ffmpeg || specs.length === 0) return Promise.resolve([]);
	if (opts.disabled)
		return Promise.resolve(
			specs.map((s) => ({ encoder: s.encoder, usable: false, reason: `disabled by ${HW_ENCODERS_ENV}` })),
		);
	const key = `${ffmpeg}|${platform}|${specs.map((s) => s.encoder).join(',')}`;
	let p = hwCache.get(key);
	if (!p) {
		p = Promise.all(specs.map((s) => testOne(ffmpeg, s, platform, opts.timeoutMs ?? 10_000)));
		hwCache.set(key, p);
	}
	return p;
}

async function testOne(
	ffmpeg: string,
	spec: HwEncoderSpec,
	platform: NodeJS.Platform,
	timeoutMs: number,
): Promise<HwTestResult> {
	if (!spec.platforms.includes(platform))
		return { encoder: spec.encoder, usable: false, reason: `not supported on ${platform}` };
	if (spec.vaapi && !existsSync(VAAPI_DEVICE))
		return { encoder: spec.encoder, usable: false, reason: `${VAAPI_DEVICE} not present` };
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	try {
		await runTool(ffmpeg, restrictInputs(hwTestArgs(spec)), { signal: ac.signal });
		return { encoder: spec.encoder, usable: true };
	} catch (e) {
		const msg = ac.signal.aborted ? 'test encode timed out' : hwFailureReason((e as Error).message);
		return { encoder: spec.encoder, usable: false, reason: msg };
	} finally {
		clearTimeout(t);
	}
}

/** A short, stable reason from a failed test encode ("Cannot load libcuda.so.1"). */
function hwFailureReason(msg: string): string {
	const lines = msg
		.split('\n')
		.map((l) =>
			l
				.replace(/^.*? exited \S+: /, '')
				.replace(/\[[^\]]* @ 0x[0-9a-f]+\]\s*/gi, '')
				.trim(),
		)
		.filter(Boolean);
	return (
		lines.find((l) => /error|cannot|failed|not|no /i.test(l)) ??
		lines[0] ??
		'test encode failed'
	).slice(0, 200);
}

/** Truthy env flag (`1`, `true`, `yes`, `on`). */
function envFlag(v: string | undefined): boolean {
	return !!v && /^(1|true|yes|on)$/i.test(v.trim());
}

/** `JASPER_HW_ENCODERS=0|off|false|no` disables hardware probing. */
function hwProbingDisabled(env: Record<string, string | undefined>): boolean {
	const v = env[HW_ENCODERS_ENV];
	return !!v && /^(0|false|no|off)$/i.test(v.trim());
}

/**
 * The engine's encoder inventory: built once at startup from the self-check (`-encoders`, `-hwaccels`,
 * `-version`) plus hardware test encodes, then consulted by exports, proxies and `/api/capabilities`.
 */
export class EncoderService {
	constructor(readonly inventory: EncoderInventory) {}

	static async create(opts: {
		ffmpeg: string | null;
		encoders: readonly string[];
		hwaccels: readonly string[];
		license: EncodingCapabilities['license'];
		env: Record<string, string | undefined>;
		platform?: NodeJS.Platform;
	}): Promise<EncoderService> {
		const hardware = await probeHardwareEncoders(opts.ffmpeg, opts.encoders, {
			disabled: hwProbingDisabled(opts.env),
			...(opts.platform ? { platform: opts.platform } : {}),
		});
		return new EncoderService({
			encoders: [...opts.encoders],
			hwaccels: [...opts.hwaccels],
			license: opts.license,
			lgplOnly: envFlag(opts.env[LGPL_ONLY_ENV]),
			hardware,
		});
	}

	select(req: EncoderRequest): EncoderChoice | null {
		return selectVideoEncoder(this.inventory, req);
	}

	/** True when the (effective) build has an encoder (`aac`, `prores_ks`, `libopus`…). */
	has(encoder: string): boolean {
		return effectiveEncoders(this.inventory).includes(encoder);
	}

	capabilities(): EncodingCapabilities {
		return encodingCapabilities(this.inventory);
	}
}
