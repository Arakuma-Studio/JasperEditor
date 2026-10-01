// How a Remotion export produces the requested file (ARCHITECTURE D-13, docs/wp-notes/wp-lgpl.md).
//
// Remotion's `h264` codec always asks its FFmpeg for libx264 and its `aac` audio for libfdk_aac — neither
// exists in an LGPL build. So with our LGPL binaries directory an H.264/AV1 export is two phases:
//   1. render: Remotion writes a ProRes 422 HQ (prores_ks) + PCM `.mov` intermediate;
//   2. encode: the engine's own ffmpeg encodes it with the encoder the D-13 selector chose
//      (hardware H.264 → OpenH264 → AV1/VP9), exactly like the native path.
// Codecs Remotion can encode with LGPL components go straight to the output ("direct"): VP9 (libvpx-vp9) in
// WebM with Opus. Only a dev setup where both FFmpegs are GPL builds lets Remotion encode H.264 itself.
// Pure: unit-tested in test/lgpl-binaries.test.ts.
import type { EncoderChoice } from '@jasper/api';
import { vp9Crf } from '../tools/encoders.ts';

/** What we know about the FFmpeg Remotion will use (its binaries directory). */
export type RemotionFfmpegInfo = {
	/** Our LGPL directory (true) or Remotion's bundled GPL build (false). */
	lgpl: boolean;
	/** `ffmpeg -encoders` of that build; null when it could not be probed. */
	encoders: readonly string[] | null;
	/** `ffmpeg -filters` of that build; null when unknown. */
	filters: readonly string[] | null;
};

type RemotionPhase = { id: 'render' | 'encode'; label: string; weight: number };

type RemotionExportPlan =
	| {
			mode: 'direct';
			/** Remotion `codec` / `audioCodec`. */
			codec: 'h264' | 'vp9';
			audioCodec: 'aac' | 'opus';
			/** Remotion `crf` in the codec's own scale. */
			crf: number;
			/** Tag BT.709 (Remotion adds a zscale filter: only when the build has it). */
			colorSpace: 'bt709' | null;
			/** Extra encoder arguments appended through Remotion's `ffmpegOverride` (speed/row-mt/GOP). */
			extraVideoArgs: string[];
			phases: RemotionPhase[];
			reason: string;
	  }
	| {
			mode: 'intermediate';
			codec: 'prores';
			proResProfile: 'hq';
			audioCodec: 'pcm-16';
			encoder: EncoderChoice;
			phases: RemotionPhase[];
			reason: string;
	  }
	| { mode: 'unavailable'; code: 'ENCODER_UNAVAILABLE'; reason: string };

const has = (list: readonly string[] | null, name: string) => list === null || list.includes(name);

export function planRemotionExport(input: {
	/** The export encoder the D-13 selector chose for the engine's own ffmpeg (null/undefined: none usable). */
	encoder: EncoderChoice | null | undefined;
	remotion: RemotionFfmpegInfo;
	/** `JASPER_FFMPEG_LGPL_ONLY=1`: never let a GPL encoder produce the deliverable. */
	lgplOnly: boolean;
	/** x264-style CRF of the export settings. */
	crf: number;
	speed: 'fast' | 'balanced' | 'best';
	fps: { num: number; den: number };
}): RemotionExportPlan {
	const { encoder, remotion } = input;
	const gplDirectH264 = (): RemotionExportPlan => ({
		mode: 'direct',
		codec: 'h264',
		audioCodec: 'aac',
		crf: input.crf,
		colorSpace: null,
		extraVideoArgs: [],
		phases: [{ id: 'render', label: 'Remotion', weight: 0.98 }],
		reason: "dev: Remotion's bundled GPL FFmpeg encodes H.264 itself",
	});

	if (!encoder) {
		// Only Remotion's own GPL build could still encode something (dev convenience, never shipped).
		if (!remotion.lgpl && !input.lgplOnly && has(remotion.encoders, 'libx264')) return gplDirectH264();
		return {
			mode: 'unavailable',
			code: 'ENCODER_UNAVAILABLE',
			reason: 'No usable video encoder for the Remotion export (the LGPL build has no H.264/AV1/VP9 encoder)',
		};
	}
	// Dev with GPL builds on both sides and libx264 selected: unchanged behaviour (one pass in Remotion).
	if (encoder.encoder === 'libx264' && !remotion.lgpl && !input.lgplOnly && has(remotion.encoders, 'libx264'))
		return gplDirectH264();

	// VP9 in WebM + Opus: Remotion encodes it directly with LGPL components.
	if (
		encoder.encoder === 'libvpx-vp9' &&
		encoder.container === 'webm' &&
		encoder.audioEncoder === 'libopus' &&
		has(remotion.encoders, 'libvpx-vp9') &&
		has(remotion.encoders, 'libopus')
	) {
		const fps = input.fps.num / input.fps.den;
		const gop = Math.max(1, Math.round(fps * 2));
		return {
			mode: 'direct',
			codec: 'vp9',
			audioCodec: 'opus',
			crf: vp9Crf(input.crf),
			colorSpace: remotion.filters?.includes('zscale') ? 'bt709' : null,
			extraVideoArgs: [
				'-deadline',
				'good',
				'-cpu-used',
				String(input.speed === 'fast' ? 5 : input.speed === 'best' ? 1 : 3),
				'-row-mt',
				'1',
				'-g',
				String(gop),
			],
			phases: [{ id: 'render', label: 'Remotion → VP9', weight: 0.98 }],
			reason: 'VP9/Opus WebM is encoded by Remotion directly (libvpx-vp9 + libopus are LGPL-compatible)',
		};
	}

	// Software AV1/VP9 encodes take more time than the ProRes render; H.264 is quicker.
	const w = encoder.codec === 'h264' ? (encoder.hardware ? 0.85 : 0.75) : 0.6;
	return {
		mode: 'intermediate',
		codec: 'prores',
		proResProfile: 'hq',
		audioCodec: 'pcm-16',
		encoder,
		phases: [
			{ id: 'render', label: 'Step 1/2 · Remotion → ProRes', weight: w },
			{ id: 'encode', label: `Step 2/2 · ${encoder.label}`, weight: 0.98 - w },
		],
		reason: remotion.lgpl
			? `Remotion renders a ProRes 422 HQ intermediate; the engine encodes ${encoder.label}`
			: `Remotion renders a ProRes 422 HQ intermediate so that its bundled GPL encoders are not used; the engine encodes ${encoder.label}`,
	};
}

/**
 * Remotion `ffmpegOverride` that appends encoder arguments to the command that encodes video with
 * `encoderName` (the pre-stitcher when Remotion encodes in parallel, otherwise the stitcher). The output
 * file is the last argument, so the extra ones go right before it.
 */
export function appendEncoderArgs(
	encoderName: string,
	extra: readonly string[],
): (info: { type: 'pre-stitcher' | 'stitcher'; args: string[] }) => string[] {
	return ({ args }) => {
		if (extra.length === 0) return args;
		const i = args.findIndex((a, k) => a === '-c:v' && args[k + 1] === encoderName);
		if (i < 0 || args.length < 2) return args;
		return [...args.slice(0, -1), ...extra, args[args.length - 1]!];
	};
}
