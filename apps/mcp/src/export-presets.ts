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
			'Mastering copy: ProRes 422 HQ (10-bit 4:2:2, ~220 Mbit/s at 1080p30) in MOV with 16-bit PCM audio.',
		container: 'mov',
		codec: 'prores',
		crf: 0,
		speed: 'best',
		maxWidth: null,
		audioKbps: 1536,
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
			colorTags: 'rec709',
			...(videoKbps ? { bitrateKbps: videoKbps } : {}),
			...(preset.bitDepth ? { bitDepth: preset.bitDepth } : {}),
		},
		audio: {
			// The engine pairs the audio encoder with the container (PCM in MOV); this is the request.
			codec: preset.container === 'webm' ? 'opus' : 'aac',
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
	};
}
