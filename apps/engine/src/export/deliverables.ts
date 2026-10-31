// spec 18 AF-EXP: GIF and audio-only exports (wp-note agent-footage-export).
// - GIF (AF-EXP-001): the planner plans the picture as a ProRes 4444 intermediate (10-bit 4:4:4: no chroma
//   subsampling before the palette) at the GIF's size and the
//   sequence rate, on whichever path renders everything (native, hybrid or Remotion — nothing the timeline shows is
//   dropped); the service then converts it with `palettegen` + `paletteuse` (LGPL filters) at the GIF rate, in the
//   display rendition the Program monitor shows (the still path's display LUT). The sound is left out and the plan
//   says so (GIF_NO_AUDIO).
// - Audio only (AF-EXP-002): the offline mixer's output (the one DSP of preview and every export path, with the
//   export's range, rate, channels and loudness normalisation) written as WAV (16/24-bit PCM), FLAC or M4A (AAC).
import {
	type AudioOnlyContainer,
	type ExportSettings,
	GIF_LIMITS,
	isAudioOnlyContainer,
	type RenderPlan,
} from '@jasper/api';

export type GifSpec = Omit<Extract<NonNullable<RenderPlan['deliverable']>, { kind: 'gif' }>, 'kind'>;
export type AudioOnlySpec = {
	container: AudioOnlyContainer;
	/** ffmpeg encoder: `pcm_s16le`, `pcm_s24le`, `flac` or `aac`. */
	codec: string;
	/** WAV / FLAC bits per sample. */
	bitDepth?: 16 | 24;
};

export type Deliverable =
	| { kind: 'video' }
	| {
			kind: 'gif';
			/** The GIF without its frame count (the range sets it: `gifFrames`). */
			gif: Omit<GifSpec, 'frames'>;
			/** The settings the picture is planned and rendered with: the ProRes intermediate. */
			render: ExportSettings;
	  }
	| { kind: 'audio'; audio: AudioOnlySpec };

/** Settings that contradict the chosen container (`VALIDATION_FAILED`, never silently ignored: AGENTS §4). */
export class DeliverableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DeliverableError';
	}
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Whether caption streams are asked for (`true` or a non-empty track list). */
const embedsCaptions = (s: ExportSettings) => {
	const e = s.captions?.embed;
	return e === true || (Array.isArray(e) && e.length > 0);
};

/** The GIF's size: `width` (default: the sequence width capped at 1080), even, the height at the sequence aspect. */
export function gifSize(
	seq: { width: number; height: number },
	width: number | undefined,
): { width: number; height: number } {
	const w = even(width ?? Math.min(seq.width, GIF_LIMITS.defaultMaxWidth));
	const h = even((w * seq.height) / seq.width);
	return { width: w, height: h };
}

/**
 * GIF frames of a range: ffmpeg's `fps` filter (round to nearest, the last frame kept to the range end) writes
 * round(duration × fps) frames, at least one (measured: 7 frames at 30 fps → 4 at 15 fps; 45 → 19 at 12.5).
 */
export function gifFrames(durationSec: number, fps: number): number {
	if (!Number.isFinite(durationSec) || !Number.isFinite(fps) || durationSec <= 0 || fps <= 0) return 1;
	return Math.max(1, Math.floor(durationSec * fps + 0.5 + 1e-9));
}

/** ffmpeg gif muxer `-loop`: −1 = play once, 0 = forever, n = n repeats after the first play. */
export function gifMuxLoop(plays: number): number {
	return plays === 0 ? 0 : plays === 1 ? -1 : plays - 1;
}

/** The rate as an exact ffmpeg rational (fractional rates such as 12.5 or 7.5 allowed). */
export function fpsRational(fps: number): string {
	const n = Math.round(fps * 1000);
	return `${n}/1000`;
}

/**
 * What the settings ask for: a video file, a GIF (with the intermediate's render settings) or an audio-only file.
 * Settings that make no sense for the container are refused by name.
 */
export function deliverableOf(
	settings: ExportSettings,
	seq: { width: number; height: number; frameRate: { num: number; den: number } },
): Deliverable {
	const c = settings.container;
	if (c === 'gif') {
		if (settings.video)
			throw new DeliverableError(
				'GIF exports take their size and rate from `gif` (fps, width); leave `video` out',
			);
		if (settings.audio)
			throw new DeliverableError('GIF files have no sound; leave `audio` out (or export audio only)');
		if (embedsCaptions(settings))
			throw new DeliverableError(
				'GIF files cannot carry caption streams; burn the captions in or write a sidecar',
			);
		const g = settings.gif ?? {};
		const size = gifSize(seq, g.width);
		const dither = g.dither ?? 'sierra2_4a';
		const gif: Omit<GifSpec, 'frames'> = {
			fps: g.fps ?? GIF_LIMITS.defaultFps,
			width: size.width,
			height: size.height,
			loop: g.loop ?? 0,
			dither,
			...(dither === 'bayer' ? { bayerScale: g.bayerScale ?? 2 } : {}),
			palette: g.palette ?? 'full',
		};
		const { gif: _gif, ...rest } = settings;
		return {
			kind: 'gif',
			gif,
			render: {
				...rest,
				container: 'mov',
				video: {
					codec: 'prores',
					proresProfile: '4444',
					width: size.width,
					height: size.height,
					frameRate: { num: seq.frameRate.num, den: seq.frameRate.den },
					scaling: 'fit',
					quality: { mode: 'crf', value: 10 },
					encoderSpeed: 'fast',
				},
				videoOnly: true,
				smartRender: false,
			},
		};
	}
	if (settings.gif) throw new DeliverableError('`gif` settings need `container: "gif"`');
	if (isAudioOnlyContainer(c)) {
		if (settings.video)
			throw new DeliverableError(`${c.toUpperCase()} files hold sound only; leave \`video\` out`);
		if (settings.videoOnly)
			throw new DeliverableError(`${c.toUpperCase()} files hold sound only; \`videoOnly\` contradicts them`);
		if (embedsCaptions(settings))
			throw new DeliverableError(
				`${c.toUpperCase()} files cannot carry caption streams; write a sidecar instead`,
			);
		const a = settings.audio;
		const want = c === 'wav' ? 'pcm' : c === 'flac' ? 'flac' : 'aac';
		if (a && a.codec !== want)
			throw new DeliverableError(
				`${c.toUpperCase()} files hold ${want === 'pcm' ? 'PCM' : want.toUpperCase()} audio, not ${a.codec.toUpperCase()}`,
			);
		if (a?.bitDepth && c === 'm4a')
			throw new DeliverableError('M4A (AAC) has no bit depth; choose a bit rate (`audio.bitrateKbps`)');
		const bits = a?.bitDepth ?? 24;
		const audio: AudioOnlySpec =
			c === 'wav'
				? { container: c, codec: bits === 16 ? 'pcm_s16le' : 'pcm_s24le', bitDepth: bits }
				: c === 'flac'
					? { container: c, codec: 'flac', bitDepth: bits }
					: { container: c, codec: 'aac' };
		return { kind: 'audio', audio };
	}
	if (settings.audio?.codec === 'flac')
		throw new DeliverableError(
			'FLAC audio is written in FLAC files (`container: "flac"`), not in video files',
		);
	if (settings.audio?.bitDepth) throw new DeliverableError('`audio.bitDepth` applies to WAV and FLAC files');
	return { kind: 'video' };
}

/** The muxer arguments of an audio-only file (RF64 when a WAV passes 4 GiB; M4A with the index in front). */
export function audioOnlyMuxArgs(container: AudioOnlyContainer): string[] {
	if (container === 'wav') return ['-rf64', 'auto', '-f', 'wav'];
	if (container === 'flac') return ['-f', 'flac'];
	return ['-movflags', '+faststart', '-f', 'ipod'];
}

/** Estimated bytes of an audio-only file (FLAC ≈ 60 % of PCM, an assumption for typical programme material). */
export function audioOnlyBytes(
	spec: AudioOnlySpec,
	o: { sampleRate: number; channels: number; bitrateKbps: number; durationSec: number },
): number {
	const pcm = o.sampleRate * o.channels * ((spec.bitDepth ?? 16) / 8) * o.durationSec;
	if (spec.container === 'wav') return Math.round(pcm + 44);
	if (spec.container === 'flac') return Math.round(pcm * 0.6);
	return Math.round((o.bitrateKbps * 1000 * o.durationSec) / 8);
}

/**
 * The palette and conversion filtergraphs of a GIF (input 0: the intermediate; input 1: the palette for the two-pass
 * modes). `toRgb` turns the intermediate's YUV into the display rendition (matrix, range, display LUT).
 * - `full` / `diff`: pass 1 writes one palette (`palettegen`), pass 2 maps every frame to it (`paletteuse`); two
 *   passes so no frame is buffered (a split graph would hold every frame until the palette is known).
 * - `single`: one pass, a palette per frame (`stats_mode=single` + `paletteuse new=1`).
 */
export function gifGraphs(
	gif: Pick<GifSpec, 'fps' | 'width' | 'height' | 'dither' | 'bayerScale' | 'palette'>,
	toRgb: string,
): { palette: string | null; encode: string } {
	const pre = `fps=${fpsRational(gif.fps)},${toRgb}`;
	const use = [
		`dither=${gif.dither}`,
		...(gif.dither === 'bayer' ? [`bayer_scale=${gif.bayerScale ?? 2}`] : []),
		...(gif.palette === 'diff' ? ['diff_mode=rectangle'] : []),
	];
	if (gif.palette === 'single')
		return {
			palette: null,
			encode: `[0:v]${pre},split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1:${use.join(':')}[out]`,
		};
	return {
		palette: `[0:v]${pre},palettegen=stats_mode=${gif.palette}[out]`,
		encode: `[0:v]${pre}[x];[x][1:v]paletteuse=${use.join(':')}[out]`,
	};
}

/**
 * YUV → RGB of the intermediate at the GIF size: its matrix (BT.709, or BT.2020 for BT.2020 / HDR working spaces),
 * limited range, then the display LUT of the working space (identity for Rec. 709 / sRGB: none), as stills do.
 */
export function gifToRgb(
	size: { width: number; height: number },
	matrix: 'bt709' | 'bt2020',
	displayLut: string | null,
	swsFlags: string,
): string {
	const scale = `scale=${size.width}:${size.height}:${swsFlags}:in_color_matrix=${matrix}:in_range=tv:out_range=pc`;
	return displayLut ? `${scale},format=rgba,${displayLut},format=rgb24` : `${scale},format=rgb24`;
}

/** Estimated GIF bytes: ≈ 0.25 byte per pixel and frame after LZW (an assumption for camera footage, wp-note). */
export function gifBytes(gif: Pick<GifSpec, 'width' | 'height' | 'frames'>): number {
	return Math.round(gif.width * gif.height * gif.frames * 0.25);
}
