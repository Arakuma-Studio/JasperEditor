// Export presets for agents: a few named recipes turned into the engine's ExportSettings (S04 §10.2 M1
// subset). "match-sequence-h264" is the same recipe as Export mode's default preset in the web app. The
// "delivery-<target>" presets (spec 18 AF-VER-004) export for a platform (`DELIVERY_TARGETS`): H.264 + AAC in MP4 through
// the engine's LGPL encoder selector, the platform's frame size, rate and loudness (`deliveryExportFormat`); a sequence
// of the wrong shape is refused with a hint to auto_reframe_sequence, never cropped.
import type { ExportSettings, VideoCodec } from '@jasper/api';
import {
	DELIVERY_AUDIO_KBPS,
	DELIVERY_CRF,
	DELIVERY_TARGETS,
	type DeliveryExportRefusal,
	type DeliveryTarget,
	type DeliveryTargetId,
	deliveryExportFormat,
	deliveryPresetId,
	deliveryTarget,
	type Sequence,
} from '@jasper/project';

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
	/** spec 18 AF-VER-004: a platform delivery preset (frame size, rate and loudness from the target). */
	target?: DeliveryTargetId;
};

const mb = (b: number) => (b >= 1e9 ? `${b / 1e9} GB` : `${b / 1e6} MB`);
const minutes = (s: number) => (s >= 3600 ? `${s / 3600} h` : s >= 60 ? `${s / 60} min` : `${s} s`);

function deliveryPreset(t: DeliveryTarget): ExportPreset {
	const l = t.limits;
	return {
		id: deliveryPresetId(t),
		label: `${t.name} – H.264`,
		description:
			`${t.name} delivery: H.264 + AAC ${DELIVERY_AUDIO_KBPS} kb/s in MP4 at up to ${l.recommendedSize.width}×${l.recommendedSize.height} (${t.aspect}; other shapes the platform takes keep theirs, fitted inside), the sequence rate when ${t.name} takes it (${l.minFrameRate ?? 0}–${l.maxFrameRate} fps, else the nearest of ${l.frameRates.join(', ')}), loudness normalised to ${l.loudnessLufs ?? -14} LUFS${l.loudnessLufs === null ? ' (the platform publishes no level)' : ''} with a ${l.truePeakDbtp} dBTP ceiling. ${t.name} takes up to ${minutes(l.maxDurationSec)} and ${mb(l.maxFileSizeBytes)}; verify_export {target: "${t.id}"} checks the file. ${t.aspect === '9:16' ? 'A horizontal sequence is refused: make a vertical copy with auto_reframe_sequence first.' : ''}`.trim(),
		container: 'mp4',
		codec: 'h264',
		crf: DELIVERY_CRF,
		speed: 'balanced',
		maxWidth: null,
		audioKbps: DELIVERY_AUDIO_KBPS,
		target: t.id,
	};
}

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
	...DELIVERY_TARGETS.map(deliveryPreset),
];

export const DEFAULT_EXPORT_PRESET = 'match-sequence-h264';

export function findExportPreset(id: string | undefined): ExportPreset | undefined {
	return EXPORT_PRESETS.find((p) => p.id === (id ?? DEFAULT_EXPORT_PRESET));
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Why a delivery preset cannot export this sequence (wrong shape: Auto Reframe first), or null. */
export function deliveryPresetRefusal(seq: Sequence, preset: ExportPreset): DeliveryExportRefusal | null {
	if (!preset.target) return null;
	const f = deliveryExportFormat(deliveryTarget(preset.target), seq.settings);
	return f.ok ? null : f.refusal;
}

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
	// a delivery preset: the target's size, rate and loudness (a refused shape keeps the sequence's: callers that export
	// check deliveryPresetRefusal first; Sound Check reads the audio only)
	const delivery = preset.target ? deliveryExportFormat(deliveryTarget(preset.target), s) : null;
	const format = delivery?.ok ? delivery.format : null;
	const normalize = opts.normalize !== undefined ? opts.normalize : format ? format.normalize : undefined;
	return {
		sequenceId: seq.id,
		range: opts.range,
		presetId: preset.id,
		container: preset.container,
		video: {
			codec: preset.codec,
			width: format ? format.width : even(s.width * scale),
			height: format ? format.height : even(s.height * scale),
			frameRate: format ? format.frameRate : { num: s.frameRate.num, den: s.frameRate.den },
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
			...(normalize !== undefined ? { normalize } : {}),
		},
		engine: opts.engine,
		destination: opts.outputPath ? { type: 'path', path: opts.outputPath } : { type: 'download' },
		...(preset.alpha ? { videoOnly: true } : {}),
	};
}
