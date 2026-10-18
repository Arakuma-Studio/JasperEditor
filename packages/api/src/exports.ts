import { OUTPUT_SPACE_IDS } from '@jasper/project';
import { z } from 'zod';
import { EncoderChoiceSchema, VideoCodecSchema } from './capabilities.ts';
import { RationalSchema } from './common.ts';
import { EnvelopeSchema } from './projects.ts';

/** Caption output of an export (S04:TR-061/062). Track lists take ids or `C1`-style labels. */
export const CAPTION_SIDECAR_FORMATS = ['srt', 'vtt', 'scc', 'mcc', 'stl', 'ttml', 'dfxp'] as const;
export const ExportCaptionsSchema = z.object({
	/** Burn captions into the picture: `true` (default) = the visible caption tracks, `false` = none, or a list. */
	burnIn: z.union([z.boolean(), z.array(z.string())]).optional(),
	/**
	 * Embedded caption streams: `mov_text` in MP4/MOV, WebVTT in WebM. `true` = every caption track with captions
	 * (the active track first, flagged default), `false` (default) = none, or a list.
	 */
	embed: z.union([z.boolean(), z.array(z.string())]).optional(),
	/** Sidecar caption files written next to the output. */
	sidecar: z.array(z.enum(CAPTION_SIDECAR_FORMATS)).optional(),
	/** Tracks written as sidecars: `active` (default), `all`, or a list. */
	sidecarTracks: z.union([z.enum(['active', 'all']), z.array(z.string())]).optional(),
	/** SCC / MCC sidecars: drop-frame timecode (default: the sequence's drop-frame setting, else true). */
	dropFrame: z.boolean().optional(),
});
export type ExportCaptions = z.infer<typeof ExportCaptionsSchema>;

/** Sound credits sidecar formats of an export (spec 12 §2.11). */
export const CREDITS_SIDECAR_FORMATS = ['txt', 'md', 'csv'] as const;
/**
 * The sound credits written next to the output (spec 12 §2.11): `<output>.credits.<ext>` with the credit lines of the
 * library sounds audible in the exported range (nested sequences included; muted tracks and disabled clips are not
 * heard, so not credited). `sidecar: null` = none. `scope`: `all` sounds (default) or only those whose licence asks for
 * a credit (`attribution`: CC BY, CC BY-SA…).
 */
export const ExportCreditsSchema = z.object({
	sidecar: z.enum(CREDITS_SIDECAR_FORMATS).nullable(),
	scope: z.enum(['all', 'attribution']).optional(),
});
export type ExportCredits = z.infer<typeof ExportCreditsSchema>;

/** If H.264 is unavailable, the render plan names the codec and container the engine will use. */
export const ExportSettingsSchema = z.object({
	sequenceId: z.string(),
	range: z.discriminatedUnion('type', [
		z.object({ type: z.literal('entire') }),
		z.object({ type: z.literal('in-out') }),
		z.object({ type: z.literal('work-area') }),
		z.object({
			type: z.literal('custom'),
			startFrame: z.number().int().min(0),
			endFrame: z.number().int().min(1),
		}),
	]),
	presetId: z.string().optional(),
	container: z.enum(['mp4', 'webm', 'mov']),
	video: z
		.object({
			codec: VideoCodecSchema,
			/** Explicit ffmpeg encoder (must be usable, see capabilities `media.encoding`); default = best. */
			encoder: z.string().optional(),
			width: z.number().int().positive(),
			height: z.number().int().positive(),
			frameRate: RationalSchema,
			scaling: z.enum(['fit', 'fill', 'stretch']).default('fit'),
			quality: z.object({ mode: z.literal('crf'), value: z.number().int().min(0).max(51) }),
			/**
			 * Average video bitrate (kbit/s). Bitrate-driven encoders (OpenH264, VideoToolbox) aim at it instead
			 * of the CRF mapping; CRF encoders (x264) keep the CRF and use it as a VBV ceiling; ProRes ignores it.
			 */
			bitrateKbps: z.number().int().min(100).max(500_000).optional(),
			/** ProRes profile of a `prores` export: 422 HQ (default) or 4444 (4:4:4, 12-bit class). */
			proresProfile: z.enum(['hq', '4444']).optional(),
			/**
			 * a straight-alpha ProRes 4444 (`yuva444p10le`) movie on a transparent background,
			 * no audio — pre-renders of clips an interchange format cannot represent. Needs `codec: 'prores'`,
			 * `proresProfile: '4444'`, `container: 'mov'`; renders on the Remotion path (the same compositions as the
			 * preview).
			 */
			alpha: z.boolean().optional(),
			encoderSpeed: z.enum(['fast', 'balanced', 'best']),
			/**
			 * frames between keyframes (1 = every frame is a keyframe). Absent = the encoder default
			 * (≈ 2 s). Render previews use short intervals so the Program monitor seeks inside them quickly.
			 */
			keyframeInterval: z.number().int().min(1).max(600).optional(),
			/**
			 * color-mgmt: the colour space written (pixels converted from the working space, tags set): `working`
			 * (default: the sequence's working space) or an output space (rec709, srgb, rec2020, p3d65, displayp3,
			 * rec2100-pq, rec2100-hlg). An HDR sequence exported as Rec. 709 is tone mapped (BT.2390).
			 */
			colorSpace: z.enum(['working', ...OUTPUT_SPACE_IDS]).optional(),
			/**
			 * color-mgmt: bits per component of the encoded video. Default: 10 for HDR outputs and ProRes, else 8.
			 * 10/12-bit needs ProRes (10), AV1 (libsvtav1 10, libaom 10/12) or VP9 (10/12); H.264 encoders are 8-bit.
			 */
			bitDepth: z.union([z.literal(8), z.literal(10), z.literal(12)]).optional(),
			/**
			 * color-mgmt: HDR static metadata written with PQ/HLG outputs (MP4/MOV `mdcv`/`clli` boxes, AV1 metadata OBUs):
			 * the mastering display (default: the output primaries, peak = the sequence's HDR mastering peak, black
			 * 0.0001 cd/m²) and MaxCLL / MaxFALL in cd/m² (absent = not written, i.e. unknown).
			 */
			hdrMetadata: z
				.object({
					masteringDisplay: z
						.object({
							primaries: z.enum(['bt2020', 'p3d65', 'bt709']),
							maxNits: z.number().min(1).max(10000),
							minNits: z.number().min(0).max(1),
						})
						.optional(),
					maxCll: z.number().int().min(0).max(10000).optional(),
					maxFall: z.number().int().min(0).max(10000).optional(),
				})
				.optional(),
		})
		.optional(),
	audio: z
		.object({
			/** `pcm` is 24-bit and requires MOV. */
			codec: z.enum(['aac', 'opus', 'pcm']),
			/** 44.1 / 48 / 96 kHz (default: the sequence rate). AAC and Opus encode at 48 kHz max 96. */
			sampleRate: z.union([z.literal(44100), z.literal(48000), z.literal(96000)]),
			/** 6 = discrete 5.1 (L R C LFE Ls Rs); a 5.1 Mix exported as 2/1 channels is folded (BS.775). */
			channels: z.union([z.literal(1), z.literal(2), z.literal(6)]),
			bitrateKbps: z.number().int().positive().optional(),
			/**
			 * two-pass loudness normalisation of the final mix (S04:RN-032) with a true-peak ceiling. Absent =
			 * the sequence's Mix setting (`master.loudness` when enabled); null = off.
			 */
			normalize: z
				.object({
					targetLufs: z.number().min(-60).max(0),
					truePeakDb: z.number().min(-20).max(0).default(-1),
				})
				.nullable()
				.optional(),
		})
		.optional(),
	engine: z.enum(['auto', 'native', 'remotion']),
	draftUseProxies: z.boolean().optional(),
	destination: z
		.discriminatedUnion('type', [
			z.object({ type: z.literal('download') }),
			z.object({ type: z.literal('path'), path: z.string() }),
		])
		.default({ type: 'download' }),
	/** Burn-in, embedded streams and sidecar files (absent = burn in the visible tracks). */
	captions: ExportCaptionsSchema.optional(),
	/** Sound credits sidecar (spec 12 §2.11); absent = none. */
	credits: ExportCreditsSchema.optional(),
	/** Picture only — no audio stream and no mixdown (render previews of the picture). */
	videoOnly: z.boolean().optional(),
	/**
	 * use the sequence's valid render previews for the segments they cover (Premiere "Use
	 * Previews"). Segments without a preview render as usual. Ignored for alpha masters.
	 */
	usePreviews: z.boolean().optional(),
	/**
	 * with the `auto` engine and an H.264 or ProRes export matching its sources,
	 * stretches that show a source untouched are stream-copied (whole closed GOPs; ProRes frame by frame) and only the
	 * rest is rendered. Absent = on for ProRes (lossless), off for H.264 (opt-in: the copies keep the sources' bitrate
	 * and profile); true = on; false = off. The plan's `smart` says what is copied or why nothing can be.
	 */
	smartRender: z.boolean().optional(),
});
export type ExportSettings = z.infer<typeof ExportSettingsSchema>;

/** Render plan (S04:RP-010) plus the plan id and document revision it was computed for (RP-011). */
/**
 * The structured part of an engine-composed export warning: what the message says, as values, so an editor can say it
 * in its own language (final carry-over cleanup, item 6; the pattern for every engine-composed message: a stable
 * `code`, `params` with the values, `message` in English for agents, logs and older clients). Codes with params:
 * - `W_SOUND_CREDITS`: `count`, `licences` (", "-joined SPDX ids), `titles` (the first three, quoted, ", "-joined),
 *   `more` (more than three);
 * - `W_SOUND_LICENSE_NC`: `count`, `licences`;
 * - `W_SOUND_SHARE_ALIKE`: `count`, `licences`, `titles`, `more`;
 * - `W_SOUND_CHECK_STALE`: `state` (`stale`: `reason` `mix` | `preset` | `settings`; `failed`: `errors`, a count, absent
 *   when unknown);
 * - `OUTPUT_CONTAINER_CHANGED`: `requested`, `written` (container names, upper case), `why` (`codec`: `codec` is not
 *   carried, `accepts` lists what is; `opus`: WebM needs Opus; `muxer`: the codec is written as `written` here);
 * - `AUDIO_CODEC_CHANGED`: `requested`, `written` (AAC | Opus | PCM), `container`, `why` (`prores` | `container` |
 *   `no-opus`).
 */
export const ExportWarningParamsSchema = z.record(z.string().max(64), z.union([z.string().max(2000), z.number(), z.boolean()]));
export type ExportWarningParams = z.infer<typeof ExportWarningParamsSchema>;

export const RenderPlanSchema = z.object({
	planId: z.string().optional(),
	documentRevision: z.number().int().optional(),
	path: z.union([z.enum(['copy', 'native', 'hybrid', 'remotion', 'browser']), z.string().regex(/^cloud:/)]),
	segments: z.array(
		z.object({
			startFrame: z.number().int(),
			endFrame: z.number().int(),
			mode: z.enum(['copy', 'native', 'mixed', 'remotion']),
			graphicsGroups: z.array(
				z.object({ id: z.string(), engine: z.enum(['remotion', 'fframes']), itemIds: z.array(z.string()) }),
			),
		}),
	),
	audio: z.object({
		mode: z.enum(['native-mix', 'remotion', 'browser']),
		normalize: z.object({ targetLufs: z.number(), truePeakDb: z.number().optional() }).optional(),
		/** What the delivered audio is: rate, channels and codec. */
		sampleRate: z.number().int().optional(),
		channels: z.number().int().optional(),
		codec: z.string().optional(),
	}),
	blockers: z.array(
		z.object({
			itemId: z.string().optional(),
			path: z.enum(['copy', 'native', 'hybrid']),
			reason: z.string(),
		}),
	),
	warnings: z.array(
		z.object({
			code: z.string(),
			/** English, for agents and logs; editors show `code` + `params` in their language (`EXPORT_WARNING_PARAMS`). */
			message: z.string(),
			itemIds: z.array(z.string()).optional(),
			/** `info` = for the user's information (W_SOUND_CHECK_STALE); absent = a warning. */
			level: z.enum(['warning', 'info']).optional(),
			params: ExportWarningParamsSchema.optional(),
		}),
	),
	estimate: z.object({ seconds: z.number().min(0), bytes: z.number().min(0) }),
	/** Whether stream copy is used, how many frames are copied, and why not. */
	smart: z
		.object({ used: z.boolean(), copiedFrames: z.number().int(), reasons: z.array(z.string()) })
		.optional(),
	/** Encoder that will write the file (D-13); absent when the engine cannot encode at all. */
	encoder: EncoderChoiceSchema.optional(),
});
export type RenderPlan = z.infer<typeof RenderPlanSchema>;

export const ExportPlanRequestSchema = z.object({
	envelope: EnvelopeSchema,
	sequenceId: z.string(),
	settings: ExportSettingsSchema,
});
export type ExportPlanRequest = z.infer<typeof ExportPlanRequestSchema>;
export const ExportStartRequestSchema = ExportPlanRequestSchema.extend({ planId: z.string().optional() });
export type ExportStartRequest = z.infer<typeof ExportStartRequestSchema>;
/** `EngineJob.result` of a finished export. */
export const ExportResultSchema = z.object({
	downloadUrl: z.string(),
	byteSize: z.number().int(),
	durationSec: z.number(),
	frames: z.number().int(),
	path: z.string().optional(),
	/** FFmpeg video encoder and container actually used (D-13). */
	encoder: z.string().optional(),
	container: z.enum(['mp4', 'webm', 'mov']).optional(),
	/** FFmpeg audio encoder actually used (`aac`, `libopus`, `pcm_s16le`, `pcm_s24le`); absent without audio. */
	audioCodec: z.string().optional(),
	/**
	 * Remotion path only (D-13): `intermediate` = Remotion rendered ProRes and the engine encoded the
	 * deliverable; `direct` = Remotion encoded it (VP9/Opus, or H.264 in a GPL dev setup).
	 */
	remotionOutput: z.enum(['direct', 'intermediate']).optional(),
	/** The path that produced the file (`hybrid` = native with baked layers). */
	renderPath: z.enum(['copy', 'native', 'hybrid', 'remotion']).optional(),
	/**
	 * run-time warnings, e.g. `NATIVE_FALLBACK` when a native preparation step failed
	 * and an `auto` export was rendered on the Remotion path instead; also the plan's sound warnings
	 * (`W_SOUND_CREDITS`, `W_SOUND_CHECK_STALE` with `level: 'info'`) and, when the file is not in the requested
	 * container or audio codec, `OUTPUT_CONTAINER_CHANGED` / `AUDIO_CODEC_CHANGED` (WP6.5a, AGENTS §4).
	 */
	warnings: z
		.array(
			z.object({
				code: z.string(),
				message: z.string(),
				level: z.enum(['warning', 'info']).optional(),
				params: ExportWarningParamsSchema.optional(),
			}),
		)
		.optional(),
	/**
	 * The sound credits sidecar (spec 12 §2.11): its format and scope, how many sounds it credits (0 = no file: no
	 * library sound is heard in the range), and the file (`/renders/:jobId/credits/:name`; `path` with a destination).
	 */
	credits: z
		.object({
			format: z.enum(CREDITS_SIDECAR_FORMATS),
			scope: z.enum(['all', 'attribution']),
			count: z.number().int(),
			name: z.string().optional(),
			url: z.string().optional(),
			path: z.string().optional(),
		})
		.optional(),
	/** Loudness of the delivered audio (BS.1770-4), and the normalisation gain when it was normalised. */
	audioLoudness: z
		.object({
			integratedLufs: z.number().nullable(),
			truePeakDbtp: z.number().nullable(),
			lra: z.number().nullable(),
			normalizedGainDb: z.number().optional(),
		})
		.optional(),
	/** Caption streams embedded in the file and sidecar files written. */
	captions: z
		.object({
			embedded: z.array(
				z.object({
					trackId: z.string(),
					name: z.string(),
					language: z.string(),
					codec: z.string(),
					cues: z.number(),
				}),
			),
			sidecars: z.array(
				z.object({
					trackId: z.string(),
					format: z.string(),
					name: z.string(),
					url: z.string(),
					path: z.string().optional(),
					cues: z.number(),
				}),
			),
		})
		.optional(),
});
export type ExportResult = z.infer<typeof ExportResultSchema>;

/**
 * still file formats. `exr` holds linear light (the working space's transfer
 * inverted, half float); `dpx` is 10-bit RGB; `jpeg` takes `jpegQuality`; the others are 8-bit RGB.
 */
export const STILL_FORMATS = ['png', 'jpeg', 'tiff', 'dpx', 'exr', 'bmp', 'tga'] as const;
export type StillFormat = (typeof STILL_FORMATS)[number];
export const STILL_FORMAT_EXTENSIONS: Record<StillFormat, string> = {
	png: 'png',
	jpeg: 'jpg',
	tiff: 'tif',
	dpx: 'dpx',
	exr: 'exr',
	bmp: 'bmp',
	tga: 'tga',
};

export const StillRequestSchema = z.object({
	envelope: EnvelopeSchema,
	sequenceId: z.string(),
	frame: z.number().int().min(0),
	width: z.number().int().positive().optional(),
	/** the file format (default PNG). */
	format: z.enum(STILL_FORMATS).optional(),
	/** JPEG quality 1–100 (default 90). */
	jpegQuality: z.number().int().min(1).max(100).optional(),
	/**
	 * also copy the frame to `<folder>/<name>.<ext>` on the engine host (local engines; never
	 * overwrites: " (2)" is appended). The result's `path` is the file written.
	 */
	destination: z
		.object({
			folder: z.string().min(1).max(4096),
			name: z
				.string()
				.min(1)
				.max(200)
				.refine((n) => !/[\\/\0]/.test(n) && n !== '.' && n !== '..', 'A file name, not a path'),
		})
		.optional(),
});
export type StillRequest = z.infer<typeof StillRequestSchema>;
export const StillResultSchema = z.object({
	url: z.string(),
	/** the file written at the destination, its format and pixel size. */
	path: z.string().optional(),
	format: z.enum(STILL_FORMATS).optional(),
});
