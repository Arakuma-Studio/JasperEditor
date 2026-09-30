// ffprobe → the S01 MediaProbe shape (S01:AST-001) plus kind, container and browserPlayable (S04:PB-001…006).
// Rotation comes from the display matrix; VFR when average and nominal rates differ by more than 0.1 %.
import { type MediaKind, type MediaProbe, type MediaStream, secondsToFlicks } from '@jasper/project';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import type { SpawnOptions } from '../tools/process.ts';
import { ToolError } from '../tools/process.ts';

export type BrowserPlayable = 'yes' | 'no' | 'unknown';

export type ProbeResult = {
	kind: MediaKind;
	container: string;
	probe: MediaProbe;
	browserPlayable: BrowserPlayable;
	durationSec: number | null;
	/** Container frame count of the first video stream (metadata only, S04:PB-006). */
	frameCount: number | null;
	interlaced: boolean;
	hasVideo: boolean;
	hasAudio: boolean;
	/** Display size after rotation (null without video). */
	display: { width: number; height: number } | null;
};

export type FfStream = {
	index: number;
	codec_type?: string;
	codec_name?: string;
	profile?: string;
	width?: number;
	height?: number;
	pix_fmt?: string;
	sample_aspect_ratio?: string;
	r_frame_rate?: string;
	avg_frame_rate?: string;
	bits_per_raw_sample?: string;
	color_primaries?: string;
	color_transfer?: string;
	color_space?: string;
	color_range?: string;
	field_order?: string;
	sample_rate?: string;
	channels?: number;
	channel_layout?: string;
	nb_frames?: string;
	duration?: string;
	disposition?: { attached_pic?: number };
	tags?: Record<string, string>;
	side_data_list?: { side_data_type?: string; rotation?: number }[];
};
type FfFormat = { format_name?: string; duration?: string; tags?: Record<string, string> };

const IMAGE_CODECS = new Set([
	'png',
	'mjpeg',
	'jpegls',
	'webp',
	'bmp',
	'tiff',
	'svg',
	'avif',
	'jpeg2000',
	'qoi',
	'ppm',
	'pgm',
]);
const IMAGE_FORMAT = /(^|,)(image2|[a-z0-9]+_pipe|png|apng|webp)(,|$)/;
const BROWSER_AUDIO = /^(aac|mp3|opus|vorbis|flac|pcm_(s16le|s24le|s32le|f32le|u8|s16be))$/;
const BROWSER_CONTAINERS = /(mov|mp4|m4a|webm|matroska|ogg|wav|mp3|flac|aac|image2|_pipe|gif|png|webp)/;

export function parseRational(s: string | undefined): { num: number; den: number } | null {
	if (!s) return null;
	const [a, b] = s.split('/');
	const num = Number(a);
	const den = b === undefined ? 1 : Number(b);
	if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
	if (!Number.isInteger(num) || !Number.isInteger(den)) {
		// e.g. "29.97": express with a 1000 denominator
		return { num: Math.round((num / den) * 1000), den: 1000 };
	}
	return { num, den };
}

const rate = (r: { num: number; den: number }) => r.num / r.den;

/** Display-matrix rotation normalized to 0/90/180/270 (ffmpeg convention: counter-clockwise degrees). */
export function rotationOf(s: FfStream): 0 | 90 | 180 | 270 {
	let raw: number | null = null;
	for (const sd of s.side_data_list ?? []) if (typeof sd.rotation === 'number') raw = sd.rotation;
	if (raw === null && s.tags?.rotate !== undefined) raw = -Number(s.tags.rotate); // legacy tag is clockwise
	if (raw === null || !Number.isFinite(raw)) return 0;
	const n = (((Math.round(raw / 90) * 90) % 360) + 360) % 360;
	return n as 0 | 90 | 180 | 270;
}

function bitDepthOf(s: FfStream): number {
	const b = Number(s.bits_per_raw_sample);
	if (Number.isInteger(b) && b > 0) return b;
	const m = /(\d{2})(le|be)?$/.exec(s.pix_fmt ?? '');
	if (m && Number(m[1]) >= 9 && Number(m[1]) <= 16) return Number(m[1]);
	return 8;
}

function hasAlphaFmt(pix: string | undefined): boolean {
	return /^(yuva|rgba|bgra|argb|abgr|gbrap|ya\d|rgba64|bgra64)/.test(pix ?? '');
}

/**
 * True when the stream carries an alpha channel. VP8/VP9 in WebM store alpha as Matroska BlockAdditions:
 * ffprobe's native decoders report plain `yuv420p` there and only the `alpha_mode` stream tag tells.
 */
export function streamHasAlpha(s: Pick<FfStream, 'pix_fmt' | 'tags'>): boolean {
	if (hasAlphaFmt(s.pix_fmt)) return true;
	for (const [k, v] of Object.entries(s.tags ?? {})) if (k.toLowerCase() === 'alpha_mode') return v === '1';
	return false;
}

/** First guess of WebCodecs/`<video>` decodability (S04:PB-004); null = depends on the client (HEVC). */
export function browserDecodable(s: FfStream, interlaced: boolean): boolean | null {
	if (interlaced) return false;
	const codec = s.codec_name ?? '';
	const pix = s.pix_fmt ?? '';
	if (IMAGE_CODECS.has(codec) || codec === 'gif' || codec === 'apng') return codec !== 'tiff';
	if (codec === 'h264') return (pix === 'yuv420p' || pix === 'yuvj420p') && bitDepthOf(s) === 8;
	if (codec === 'vp8' || codec === 'vp9' || codec === 'av1') return /^yuva?420p/.test(pix);
	if (codec === 'hevc') return null;
	return false;
}

function isInterlaced(s: FfStream): boolean {
	return ['tt', 'bb', 'tb', 'bt'].includes(s.field_order ?? '');
}

/** Maps raw ffprobe JSON to a ProbeResult. Pure; exported for tests. */
export function mapProbe(json: { streams?: FfStream[]; format?: FfFormat }): ProbeResult {
	const format = json.format ?? {};
	const container = format.format_name ?? 'unknown';
	const all = json.streams ?? [];
	const videos = all.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
	const audios = all.filter((s) => s.codec_type === 'audio');
	const subs = all.filter((s) => s.codec_type === 'subtitle');
	if (videos.length === 0 && audios.length === 0) {
		throw new ToolError('UNSUPPORTED_MEDIA', 'No video or audio stream found');
	}
	const v0 = videos[0];
	const durationSecRaw = Number(format.duration ?? v0?.duration ?? audios[0]?.duration);
	const hasDuration = Number.isFinite(durationSecRaw) && durationSecRaw > 0;

	let kind: MediaKind;
	if (!v0) kind = 'audio';
	else if (v0.codec_name === 'gif' || v0.codec_name === 'apng') {
		const frames = Number(v0.nb_frames);
		kind =
			(Number.isFinite(frames) && frames > 1) || (hasDuration && durationSecRaw > 0.11)
				? 'animated-image'
				: 'image';
	} else if (IMAGE_CODECS.has(v0.codec_name ?? '') && (IMAGE_FORMAT.test(container) || !hasDuration))
		kind = 'image';
	else kind = 'video';

	let variableFrameRate = false;
	const streams: MediaStream[] = [];
	for (const s of all) {
		if (s.codec_type === 'video' && !s.disposition?.attached_pic) {
			const avg = parseRational(s.avg_frame_rate);
			const nominal = parseRational(s.r_frame_rate);
			if (kind === 'video' && avg && nominal && Math.abs(rate(avg) - rate(nominal)) / rate(nominal) > 0.001) {
				variableFrameRate = true;
			}
			const frameRate = (kind === 'video' ? (avg ?? nominal) : (nominal ?? avg)) ?? { num: 25, den: 1 };
			const interlaced = isInterlaced(s);
			streams.push({
				index: s.index,
				type: 'video',
				codec: s.codec_name ?? 'unknown',
				width: Math.max(1, s.width ?? 1),
				height: Math.max(1, s.height ?? 1),
				pixelAspect: parseRational(s.sample_aspect_ratio?.replace(':', '/')) ?? { num: 1, den: 1 },
				frameRate,
				pixelFormat: s.pix_fmt ?? 'unknown',
				bitDepth: bitDepthOf(s),
				color: {
					primaries: s.color_primaries ?? 'unknown',
					transfer: s.color_transfer ?? 'unknown',
					matrix: s.color_space ?? 'unknown',
					range: s.color_range === 'pc' || s.color_range === 'jpeg' ? 'pc' : 'tv',
				},
				browserDecodable: browserDecodable(s, interlaced),
			});
		} else if (s.codec_type === 'audio') {
			streams.push({
				index: s.index,
				type: 'audio',
				codec: s.codec_name ?? 'unknown',
				sampleRate: Math.max(1, Number(s.sample_rate) || 48000),
				channels: Math.max(1, s.channels ?? 1),
				channelLayout:
					s.channel_layout ?? (s.channels === 1 ? 'mono' : s.channels === 2 ? 'stereo' : 'unknown'),
			});
		} else if (s.codec_type === 'subtitle') {
			streams.push({
				index: s.index,
				type: 'subtitle',
				codec: s.codec_name ?? 'unknown',
				language: s.tags?.language ?? null,
			});
		}
	}
	void subs;

	const rotationDegrees = v0 ? rotationOf(v0) : 0;
	const timecode =
		format.tags?.timecode ??
		all.map((s) => s.tags?.timecode).find((t): t is string => typeof t === 'string') ??
		null;
	const probe: MediaProbe = {
		durationFlicks: kind === 'image' || !hasDuration ? null : secondsToFlicks(durationSecRaw),
		startTimecode: timecode,
		streams,
		rotationDegrees,
		hasAlpha: v0 ? streamHasAlpha(v0) : false,
		variableFrameRate,
	};

	const interlaced = v0 ? isInterlaced(v0) : false;
	let browserPlayable: BrowserPlayable;
	const audioOk = audios.every((a) => BROWSER_AUDIO.test(a.codec_name ?? ''));
	if (v0) {
		const vd = browserDecodable(v0, interlaced);
		if (vd === false || !BROWSER_CONTAINERS.test(container) || /(^|,)(avi|mxf|mpegts)(,|$)/.test(container))
			browserPlayable = 'no';
		else if (vd === null || !audioOk) browserPlayable = 'unknown';
		else browserPlayable = 'yes';
	} else browserPlayable = audioOk ? 'yes' : 'unknown';

	let display: ProbeResult['display'] = null;
	if (v0?.width && v0.height) {
		const swap = rotationDegrees === 90 || rotationDegrees === 270;
		display = swap ? { width: v0.height, height: v0.width } : { width: v0.width, height: v0.height };
	}
	const frames = Number(v0?.nb_frames);
	return {
		kind,
		container,
		probe,
		browserPlayable,
		durationSec: kind === 'image' || !hasDuration ? null : durationSecRaw,
		frameCount: Number.isInteger(frames) && frames > 0 ? frames : null,
		interlaced,
		hasVideo: !!v0,
		hasAudio: audios.length > 0,
		display,
	};
}

/** Runs ffprobe on a file and maps the result (no full decode, S04:PB-006). */
export async function probeFile(ff: Ffmpeg, file: string, opts: SpawnOptions = {}): Promise<ProbeResult> {
	let json: Record<string, unknown>;
	try {
		json = await ff.probeJson(['-show_format', '-show_streams', file], opts);
	} catch (e) {
		if (e instanceof ToolError && e.code === 'TOOL_FAILED') {
			throw new ToolError('UNSUPPORTED_MEDIA', `ffprobe cannot read this file: ${e.message.slice(0, 300)}`);
		}
		throw e;
	}
	return mapProbe(json as { streams?: FfStream[]; format?: FfFormat });
}
