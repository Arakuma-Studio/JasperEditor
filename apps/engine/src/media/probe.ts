// ffprobe → the S01 MediaProbe shape (S01:AST-001) plus kind, container and browserPlayable (S04:PB-001…006).
// Rotation comes from the display matrix; VFR when average and nominal rates differ by more than 0.1 %.
import {
	browserDecodesAudio,
	type ColorConfigInfo,
	type ImageSequenceInfo,
	type LayeredInfo,
	type LottieInfo,
	type LutInfo,
	type MediaKind,
	type MediaProbe,
	type MediaStream,
	secondsToFlicks,
	type VectorInfo,
	type VideoStream,
} from '@jasper/project';
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
	lut?: LutInfo;
	colorConfig?: ColorConfigInfo;
	vector?: VectorInfo;
	lottie?: LottieInfo;
	layered?: LayeredInfo;
	imageSequence?: ImageSequenceInfo;
};

/**
 * Probers for files ffprobe does not understand (M2, ARCHITECTURE §19.7): the first prober whose `matches`
 * accepts the file path handles it (e.g. `.cube` LUTs, wp-m2-color). Register at service start-up.
 */
export type AssetProber = {
	id: string;
	matches(file: string): boolean;
	probe(file: string, opts: SpawnOptions): Promise<ProbeResult>;
};
const ASSET_PROBERS: AssetProber[] = [];
export function registerAssetProber(p: AssetProber): () => void {
	ASSET_PROBERS.push(p);
	return () => {
		const i = ASSET_PROBERS.indexOf(p);
		if (i >= 0) ASSET_PROBERS.splice(i, 1);
	};
}

type FfStream = {
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
	side_data_list?: {
		side_data_type?: string;
		rotation?: number;
		/** color-mgmt: "Mastering display metadata" (rationals, cd/m²) and "Content light level metadata". */
		max_luminance?: string | number;
		min_luminance?: string | number;
		max_content?: string | number;
		max_average?: string | number;
	}[];
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
	'exr',
	'dpx',
	'targa',
	'hdr',
	'jpegxl',
	'psd',
	'sgi',
	'pcx',
	'pbm',
	'pam',
	'pfm',
	'phm',
	'xbm',
	'xpm',
	'xwd',
	'sunrast',
	'dds',
	'pictor',
	'photocd',
	'gem',
]);
/** Still codecs Chromium shows in an `<img>` (everything else gets a PNG display picture from the engine). */
const BROWSER_IMAGE_CODECS = new Set(['png', 'mjpeg', 'webp', 'bmp', 'avif', 'gif', 'apng', 'svg']);
const IMAGE_FORMAT = /(^|,)(image2|[a-z0-9]+_pipe|png|apng|webp)(,|$)/;
const BROWSER_CONTAINERS = /(mov|mp4|m4a|webm|matroska|ogg|wav|mp3|flac|aac|image2|_pipe|gif|png|webp)/;

function parseRational(s: string | undefined): { num: number; den: number } | null {
	if (!s) return null;
	const [a, b] = s.split('/');
	const num = Number(a);
	const den = b === undefined ? 1 : Number(b);
	if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
	// Hostile input (golden-fuzz / verify): integers beyond 2^53 are not rationals the media schema accepts.
	const safe = (r: { num: number; den: number }) =>
		Number.isSafeInteger(r.num) && Number.isSafeInteger(r.den) && r.num > 0 && r.den > 0 ? r : null;
	if (!Number.isInteger(num) || !Number.isInteger(den)) {
		// e.g. "29.97": express with a 1000 denominator
		return safe({ num: Math.round((num / den) * 1000), den: 1000 });
	}
	return safe({ num, den });
}

const rate = (r: { num: number; den: number }) => r.num / r.den;

/** A positive integer sample rate (48 kHz when ffprobe reports none or garbage). */
function sampleRateOf(v: unknown): number {
	const n = Math.round(Number(v));
	return Number.isSafeInteger(n) && n > 0 ? n : 48000;
}

/** Display-matrix rotation normalized to 0/90/180/270 (ffmpeg convention: counter-clockwise degrees). */
function rotationOf(s: FfStream): 0 | 90 | 180 | 270 {
	let raw: number | null = null;
	for (const sd of s.side_data_list ?? []) if (typeof sd.rotation === 'number') raw = sd.rotation;
	if (raw === null && s.tags?.rotate !== undefined) raw = -Number(s.tags.rotate); // legacy tag is clockwise
	if (raw === null || !Number.isFinite(raw)) return 0;
	// Quarter turns modulo 4, then degrees: exact for any finite input (degrees modulo 360 of a huge value are not a
	// multiple of 90 in floating point).
	const q = ((Math.round(raw / 90) % 4) + 4) % 4;
	return ([0, 90, 180, 270] as const)[q] ?? 0;
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
function streamHasAlpha(s: Pick<FfStream, 'pix_fmt' | 'tags'>): boolean {
	if (hasAlphaFmt(s.pix_fmt)) return true;
	for (const [k, v] of Object.entries(s.tags ?? {})) if (k.toLowerCase() === 'alpha_mode') return v === '1';
	return false;
}

/** First guess of WebCodecs/`<video>` decodability (S04:PB-004); null = depends on the client (HEVC). */
/** A number or an ffprobe rational ("10000000/10000"); null when absent or not finite. */
function ffNumber(v: string | number | undefined): number | null {
	if (v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const [a, b] = v.split('/').map(Number);
	const x = b === undefined ? a! : a! / b;
	return Number.isFinite(x) ? x : null;
}

/** color-mgmt: HDR static metadata of a video stream (mastering display luminance, MaxCLL / MaxFALL). */
export function hdrOf(s: Pick<FfStream, 'side_data_list'>): { hdr?: NonNullable<VideoStream['hdr']> } {
	const hdr: NonNullable<VideoStream['hdr']> = {};
	for (const sd of s.side_data_list ?? []) {
		const t = sd.side_data_type ?? '';
		if (/mastering display/i.test(t)) {
			const max = ffNumber(sd.max_luminance);
			const min = ffNumber(sd.min_luminance);
			if (max !== null && max > 0) hdr.masteringMaxNits = max;
			if (min !== null && min >= 0) hdr.masteringMinNits = min;
		} else if (/content light level/i.test(t)) {
			const cll = ffNumber(sd.max_content);
			const fall = ffNumber(sd.max_average);
			if (cll !== null && cll > 0) hdr.maxCll = cll;
			if (fall !== null && fall > 0) hdr.maxFall = fall;
		}
	}
	return Object.keys(hdr).length ? { hdr } : {};
}

/**
 * color-mgmt: video whose tags make a browser convert colours while decoding (HDR transfer functions, wide-gamut
 * primaries, the BT.2020 matrix). Previews play a signal proxy instead (BT.709-tagged, same R'G'B' signal), so the
 * colour input transform sees the file's own signal, as the native path does.
 */
export function browserConvertsColor(
	s: Pick<FfStream, 'color_primaries' | 'color_transfer' | 'color_space'>,
): boolean {
	const t = s.color_transfer ?? '';
	const p = s.color_primaries ?? '';
	const m = s.color_space ?? '';
	return (
		['smpte2084', 'arib-std-b67', 'linear', 'log100', 'log316', 'smpte428'].includes(t) ||
		['bt2020', 'smpte431', 'smpte432', 'film', 'smpte428'].includes(p) ||
		m === 'bt2020nc' ||
		m === 'bt2020c'
	);
}

function browserDecodable(s: FfStream, interlaced: boolean): boolean | null {
	if (interlaced) return false;
	const codec = s.codec_name ?? '';
	const pix = s.pix_fmt ?? '';
	if (IMAGE_CODECS.has(codec) || codec === 'gif' || codec === 'apng') return BROWSER_IMAGE_CODECS.has(codec);
	if (browserConvertsColor(s)) return false;
	if (codec === 'h264') return (pix === 'yuv420p' || pix === 'yuvj420p') && bitDepthOf(s) === 8;
	if (codec === 'vp8' || codec === 'vp9' || codec === 'av1') return /^yuva?420p/.test(pix);
	if (codec === 'hevc') return null;
	return false;
}

/** imports: ffprobe's field order (`tt`/`tb` = top first, `bb`/`bt` = bottom first, `progressive`). */
function fieldOrderOf(s: FfStream): { fieldOrder?: 'progressive' | 'tt' | 'bb' | 'tb' | 'bt' } {
	const fo = s.field_order;
	return fo === 'progressive' || fo === 'tt' || fo === 'bb' || fo === 'tb' || fo === 'bt'
		? { fieldOrder: fo }
		: {};
}

function isInterlaced(s: FfStream): boolean {
	return ['tt', 'bb', 'tb', 'bt'].includes(s.field_order ?? '');
}

const HEIF_BRANDS = /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/;

/** imports: an ISO BMFF HEIF image (not a movie): its major brand is a HEIF image brand. */
function isHeifImage(format: FfFormat): boolean {
	const brand = format.tags?.major_brand?.trim().toLowerCase() ?? '';
	return /(^|,)mov(,|$)/.test(format.format_name ?? '') && HEIF_BRANDS.test(brand);
}

/** Maps raw ffprobe JSON to a ProbeResult. */
const STRING_FIELDS = [
	'codec_type',
	'codec_name',
	'profile',
	'pix_fmt',
	'sample_aspect_ratio',
	'r_frame_rate',
	'avg_frame_rate',
	'bits_per_raw_sample',
	'color_primaries',
	'color_transfer',
	'color_space',
	'color_range',
	'field_order',
	'sample_rate',
	'channel_layout',
	'nb_frames',
	'duration',
] as const;

/** Numbers ffprobe prints as numbers; strings of digits are accepted, anything else dropped. */
function finiteOrUndefined(v: unknown): number | undefined {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
	return Number.isFinite(n) ? n : undefined;
}
/** A numeric duration must be 0…1e7 s (~115 days); non-numeric text (e.g. "N/A") is left to the mapper (no duration). */
const plausibleSeconds = (v: unknown) => {
	const n = finiteOrUndefined(v);
	return n === undefined || (n >= 0 && n <= 1e7);
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const stringTags = (v: unknown): Record<string, string> | undefined =>
	isObj(v)
		? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'))
		: undefined;

/**
 * ffprobe JSON coerced into the shapes `mapProbe` reads (golden-fuzz): a field of the wrong type (a number where a
 * string belongs, an object instead of a list…) is dropped or converted instead of crashing the mapping, and sizes
 * and channel counts must be positive integers. ffprobe itself never prints such values, but a damaged file, an
 * unusual ffprobe build or a remote executor's output must not take the probe job down with a TypeError.
 */
export function sanitizeProbeJson(raw: unknown): { streams: FfStream[]; format: FfFormat } {
	const j = isObj(raw) ? raw : {};
	const streams: FfStream[] = [];
	for (const [i, x] of (Array.isArray(j.streams) ? j.streams : []).entries()) {
		if (!isObj(x)) continue;
		const s: Record<string, unknown> = {
			index: Number.isSafeInteger(x.index) && (x.index as number) >= 0 ? x.index : i,
		};
		for (const k of STRING_FIELDS) {
			const v = x[k];
			if (typeof v === 'string') s[k] = v;
			else if (typeof v === 'number' && Number.isFinite(v)) s[k] = String(v);
		}
		// Plausible ranges: a duration up to ~115 days, a bit depth of 1…32.
		if (s.duration !== undefined && !plausibleSeconds(s.duration)) delete s.duration;
		const bits = finiteOrUndefined(s.bits_per_raw_sample);
		if (
			s.bits_per_raw_sample !== undefined &&
			!(bits !== undefined && Number.isInteger(bits) && bits >= 1 && bits <= 32)
		)
			delete s.bits_per_raw_sample;
		for (const k of ['width', 'height', 'channels'] as const) {
			const n = finiteOrUndefined(x[k]);
			if (n !== undefined && Number.isInteger(n) && n > 0 && n <= 1_000_000) s[k] = n;
		}
		if (isObj(x.disposition)) {
			const ap = finiteOrUndefined(x.disposition.attached_pic);
			s.disposition = ap === undefined ? {} : { attached_pic: ap };
		}
		const tags = stringTags(x.tags);
		if (tags) s.tags = tags;
		if (Array.isArray(x.side_data_list))
			s.side_data_list = x.side_data_list.filter(isObj).map((d) => {
				const out: Record<string, unknown> = {};
				if (typeof d.side_data_type === 'string') out.side_data_type = d.side_data_type;
				const rot = finiteOrUndefined(d.rotation);
				if (rot !== undefined) out.rotation = rot;
				for (const k of ['max_luminance', 'min_luminance', 'max_content', 'max_average'] as const)
					if (typeof d[k] === 'string' || (typeof d[k] === 'number' && Number.isFinite(d[k]))) out[k] = d[k];
				return out;
			});
		streams.push(s as FfStream);
	}
	const f = isObj(j.format) ? j.format : {};
	const format: FfFormat = {};
	if (typeof f.format_name === 'string') format.format_name = f.format_name;
	if (
		(typeof f.duration === 'string' || typeof f.duration === 'number') &&
		plausibleSeconds(String(f.duration))
	)
		format.duration = String(f.duration);
	const ftags = stringTags(f.tags);
	if (ftags) format.tags = ftags;
	return { streams, format };
}

/** Maps `ffprobe -show_format -show_streams` JSON to a probe result (input sanitized first; exported for tests). */
export function mapProbe(input: unknown): ProbeResult {
	const json = sanitizeProbeJson(input);
	const format = json.format ?? {};
	const container = format.format_name ?? 'unknown';
	const all = json.streams ?? [];
	const videos = all.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
	const audios = all.filter((s) => s.codec_type === 'audio');
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
	// imports: HEIF / HEIC stills (ISO BMFF image items: brand heic, mif1…; tiled grids are several streams).
	else if (isHeifImage(format)) kind = 'image';
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
				browserDecodable: kind === 'image' && isHeifImage(format) ? false : browserDecodable(s, interlaced),
				...fieldOrderOf(s),
				...hdrOf(s),
			});
		} else if (s.codec_type === 'audio') {
			streams.push({
				index: s.index,
				type: 'audio',
				codec: s.codec_name ?? 'unknown',
				sampleRate: sampleRateOf(s.sample_rate),
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
	// pp-wma-preview: one table decides (`browserDecodesAudio`, @jasper/project); audio the page cannot decode plays from
	// the engine's playback audio, so an audio file with such a stream is not playable in the browser as it is.
	const audioOk = audios.every((a) => browserDecodesAudio(container, a.codec_name ?? 'unknown'));
	if (v0) {
		const vd = browserDecodable(v0, interlaced);
		if (
			vd === false ||
			(kind === 'image' && isHeifImage(format)) ||
			!BROWSER_CONTAINERS.test(container) ||
			/(^|,)(avi|mxf|mpegts)(,|$)/.test(container)
		)
			browserPlayable = 'no';
		else if (vd === null || !audioOk) browserPlayable = 'unknown';
		else browserPlayable = 'yes';
	} else browserPlayable = audioOk ? 'yes' : 'no';

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
	const prober = ASSET_PROBERS.find((p) => p.matches(file));
	if (prober) return prober.probe(file, opts);
	return probeWithFfprobe(ff, file, opts);
}

/** ffprobe only (no asset prober): what a prober falls back to for files it cannot read itself. */
export async function probeWithFfprobe(
	ff: Ffmpeg,
	file: string,
	opts: SpawnOptions = {},
): Promise<ProbeResult> {
	let json: Record<string, unknown>;
	try {
		json = await ff.probeJson(['-show_format', '-show_streams', file], opts);
	} catch (e) {
		if (e instanceof ToolError && e.code === 'TOOL_FAILED') {
			throw new ToolError('UNSUPPORTED_MEDIA', `ffprobe cannot read this file: ${e.message.slice(0, 300)}`);
		}
		throw e;
	}
	return mapProbe(json);
}
