// Export presets for agents: a few named recipes turned into the engine's ExportSettings (S04 §10.2 M1
// subset). "match-sequence-h264" is the same recipe as Export mode's default preset in the web app.
import type { ExportSettings, VideoCodec } from '@jasper/api';
import type { Sequence } from '@jasper/project';

type ExportPreset = {
	id: string;
	label: string;
	description: string;
	container: 'mp4' | 'webm' | 'mov';
	codec: VideoCodec;
	crf: number;
	speed: 'fast' | 'balanced' | 'best';
	/** Output width (height follows the sequence aspect); null = sequence size. */
	maxWidth: number | null;
	audioKbps: number;
	/** Average video bitrate (kbit/s) for bitrate-driven encoders (OpenH264); a ceiling for x264. */
	videoKbps?: number;
	/** gaps (EX-2): bits per component (HEVC Main10). */
	bitDepth?: 10;
	/** social-comment §7.11: a transparent background — straight-alpha ProRes 4444, no audio (Remotion path). */
	alpha?: true;
};

export const EXPORT_PRESETS: readonly ExportPreset[] = [
	{
		id: 'match-sequence-h264',
		label: 'Match Sequence – H.264',
		description: 'Sequence frame size and rate, H.264 CRF 18 + AAC 256 kb/s in MP4 (the editor default).',
		container: 'mp4',
		codec: 'h264',
		crf: 18,
		speed: 'balanced',
		maxWidth: null,
		audioKbps: 256,
	},
	{
		id: 'draft-720p-h264',
		label: 'Draft 720p – H.264',
		description: 'Quick review copy: at most 1280 px wide, CRF 28, fast encoder settings.',
		container: 'mp4',
		codec: 'h264',
		crf: 28,
		speed: 'fast',
		maxWidth: 1280,
		audioKbps: 128,
	},
	{
		id: 'high-quality-h264',
		label: 'High Quality – H.264',
		description: 'Sequence size, CRF 14, slowest encoder settings (bigger files, best quality).',
		container: 'mp4',
		codec: 'h264',
		crf: 14,
		speed: 'best',
		maxWidth: null,
		audioKbps: 320,
	},
	{
		id: 'master-h264-high',
		label: 'Master – H.264 high bitrate',
		description:
			'Delivery master: sequence size, CRF 14 with x264, 20 Mbit/s average with OpenH264 / VideoToolbox (bitrate-driven encoders), AAC 320 kb/s.',
		container: 'mp4',
		codec: 'h264',
		crf: 14,
		speed: 'best',
		maxWidth: null,
		audioKbps: 320,
		videoKbps: 20000,
	},
	{
		id: 'master-prores-422hq',
		label: 'Master – ProRes 422 HQ',
		description:
			'Mastering copy: ProRes 422 HQ (10-bit 4:2:2, ~220 Mbit/s at 1080p30) in MOV with 24-bit PCM audio.',
		container: 'mov',
		codec: 'prores',
		crf: 0,
		speed: 'best',
		maxWidth: null,
		audioKbps: 1536,
	},
	{
		id: 'overlay-prores-4444-alpha',
		label: 'Overlay – ProRes 4444 with alpha',
		description:
			'Transparent background: straight-alpha ProRes 4444 in MOV at the sequence size, no audio (graphics such as social comments or titles to lay over footage in another editor; disable the footage clips you do not want in it). Rendered on the Remotion path.',
		container: 'mov',
		codec: 'prores',
		crf: 0,
		speed: 'best',
		maxWidth: null,
		audioKbps: 1536,
		alpha: true,
	},
	{
		id: 'match-sequence-hevc',
		label: 'Match Sequence – HEVC (H.265)',
		description:
			'Sequence size and rate, HEVC Main (Kvazaar, 8-bit; a hardware encoder when one works) + AAC 256 kb/s in MP4 (hvc1).',
		container: 'mp4',
		codec: 'hevc',
		crf: 20,
		speed: 'balanced',
		maxWidth: null,
		audioKbps: 256,
	},
	{
		id: 'hevc-main10-hdr',
		label: 'HEVC Main10 – HDR10 / HLG',
		description:
			'Sequence size, HEVC Main10 in MP4 tagged with the sequence colour space (HDR sequences: PQ or HLG with mastering metadata). Needs a hardware HEVC encoder: the LGPL build’s Kvazaar is 8-bit only (the plan refuses with the reason).',
		container: 'mp4',
		codec: 'hevc',
		crf: 18,
		speed: 'best',
		maxWidth: null,
		audioKbps: 320,
		bitDepth: 10,
	},
	{
		id: 'web-vp9',
		label: 'Web – VP9 WebM',
		description: 'Royalty-free VP9 + Opus in WebM at the sequence size (CRF 32).',
		container: 'webm',
		codec: 'vp9',
		crf: 32,
		speed: 'balanced',
		maxWidth: null,
		audioKbps: 160,
	},
];

export const DEFAULT_EXPORT_PRESET = 'match-sequence-h264';

export function findExportPreset(id: string | undefined): ExportPreset | undefined {
	return EXPORT_PRESETS.find((p) => p.id === (id ?? DEFAULT_EXPORT_PRESET));
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function buildExportSettings(
	seq: Sequence,
	preset: ExportPreset,
	opts: {
		range: ExportSettings['range'];
		engine: ExportSettings['engine'];
		outputPath?: string;
		/** Overrides of the preset's quality. */
		crf?: number;
		videoBitrateKbps?: number;
		/** audio-mix: channels (default: 6 for a 5.1 Mix, else 2), rate (default: the sequence rate), loudness. */
		audioChannels?: 1 | 2 | 6;
		audioSampleRate?: 44100 | 48000 | 96000;
		normalize?: { targetLufs: number; truePeakDb: number } | null;
	},
): ExportSettings {
	const videoKbps = opts.videoBitrateKbps ?? preset.videoKbps;
	const s = seq.settings;
	const scale = preset.maxWidth && s.width > preset.maxWidth ? preset.maxWidth / s.width : 1;
	return {
		sequenceId: seq.id,
		range: opts.range,
		presetId: preset.id,
		container: preset.container,
		video: {
			codec: preset.codec,
			width: even(s.width * scale),
			height: even(s.height * scale),
			frameRate: { num: s.frameRate.num, den: s.frameRate.den },
			scaling: 'fit',
			quality: { mode: 'crf', value: opts.crf ?? preset.crf },
			encoderSpeed: preset.speed,
			...(videoKbps ? { bitrateKbps: videoKbps } : {}),
			...(preset.bitDepth ? { bitDepth: preset.bitDepth } : {}),
			...(preset.alpha ? { proresProfile: '4444' as const, alpha: true } : {}),
		},
		audio: {
			// The container's audio: Opus in WebM, 24-bit PCM in MOV, AAC in MP4 (the engine names any change it has to
			// make in the plan and job warnings, OUTPUT_CONTAINER_CHANGED / AUDIO_CODEC_CHANGED).
			codec: preset.container === 'webm' ? 'opus' : preset.container === 'mov' ? 'pcm' : 'aac',
			sampleRate:
				preset.container === 'webm'
					? 48000
					: (opts.audioSampleRate ?? (s.audioSampleRate as 44100 | 48000 | 96000 | undefined) ?? 48000),
			channels: opts.audioChannels ?? (s.masterLayout === '5.1' ? 6 : 2),
			...(opts.audioChannels === 6 || (opts.audioChannels === undefined && s.masterLayout === '5.1')
				? { bitrateKbps: Math.max(preset.audioKbps ?? 0, 384) }
				: { bitrateKbps: preset.audioKbps }),
			...(opts.normalize !== undefined ? { normalize: opts.normalize } : {}),
		},
		engine: opts.engine,
		destination: opts.outputPath ? { type: 'path', path: opts.outputPath } : { type: 'download' },
		...(preset.alpha ? { videoOnly: true } : {}),
	};
}

/**
 * spec 18 AF-EXP: what start_export writes (`format`): a video file from a preset (default), an animated GIF of the
 * picture (no sound), or the sequence mix alone as WAV, FLAC or M4A (AAC).
 */
export const EXPORT_FORMATS = ['video', 'gif', 'wav', 'flac', 'm4a'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The settings of a GIF or audio-only export (no preset: their own fields). */
export function buildDeliverableSettings(
	seq: Sequence,
	format: Exclude<ExportFormat, 'video'>,
	opts: {
		range: ExportSettings['range'];
		engine: ExportSettings['engine'];
		outputPath?: string;
		gif?: ExportSettings['gif'];
		audioChannels?: 1 | 2 | 6;
		audioSampleRate?: 44100 | 48000 | 96000;
		/** WAV / FLAC bits per sample (default 24). */
		audioBitDepth?: 16 | 24;
		/** M4A (AAC) bit rate (default 192 kb/s stereo, 384 for 5.1). */
		audioBitrateKbps?: number;
		normalize?: { targetLufs: number; truePeakDb: number } | null;
	},
): ExportSettings {
	const s = seq.settings;
	const base = {
		sequenceId: seq.id,
		range: opts.range,
		presetId: format === 'gif' ? 'animated-gif' : `audio-${format}`,
		engine: opts.engine,
		destination: opts.outputPath
			? { type: 'path' as const, path: opts.outputPath }
			: { type: 'download' as const },
	};
	if (format === 'gif') return { ...base, container: 'gif', ...(opts.gif ? { gif: opts.gif } : {}) };
	const channels = opts.audioChannels ?? (s.masterLayout === '5.1' ? 6 : 2);
	return {
		...base,
		container: format,
		audio: {
			codec: format === 'wav' ? 'pcm' : format === 'flac' ? 'flac' : 'aac',
			sampleRate: opts.audioSampleRate ?? (s.audioSampleRate as 44100 | 48000 | 96000 | undefined) ?? 48000,
			channels,
			...(format === 'm4a'
				? { bitrateKbps: opts.audioBitrateKbps ?? (channels === 6 ? 384 : 192) }
				: { bitDepth: opts.audioBitDepth ?? 24 }),
			...(opts.normalize !== undefined ? { normalize: opts.normalize } : {}),
		},
	};
}
