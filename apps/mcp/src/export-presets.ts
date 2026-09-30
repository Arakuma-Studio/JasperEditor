// Export presets for agents: a few named recipes turned into the engine's ExportSettings (S04 §10.2 M1
// subset). "match-sequence-h264" is the same recipe as Export mode's default preset in the web app.
import type { ExportSettings, VideoCodec } from '@jasper/api';
import type { Sequence } from '@jasper/project';

export type ExportPreset = {
	id: string;
	label: string;
	description: string;
	container: 'mp4' | 'webm';
	codec: VideoCodec;
	crf: number;
	speed: 'fast' | 'balanced' | 'best';
	/** Output width (height follows the sequence aspect); null = sequence size. */
	maxWidth: number | null;
	audioKbps: number;
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
	},
): ExportSettings {
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
			quality: { mode: 'crf', value: preset.crf },
			encoderSpeed: preset.speed,
			colorTags: 'rec709',
		},
		audio: {
			codec: preset.container === 'webm' ? 'opus' : 'aac',
			sampleRate: 48000,
			channels: 2,
			bitrateKbps: preset.audioKbps,
		},
		engine: opts.engine,
		destination: opts.outputPath ? { type: 'path', path: opts.outputPath } : { type: 'download' },
	};
}
