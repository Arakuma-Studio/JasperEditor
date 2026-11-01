import { DELIVERY_TARGET_IDS, OUTPUT_SPACE_IDS } from '@jasper/project';
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

/**
 * spec 18 AF-EXP: what an export writes. Video containers hold the picture (and the mix unless `videoOnly`); `gif` is
 * an animated GIF of the rendered picture (no sound); `wav` / `flac` / `m4a` hold the sequence mix only.
 */
export const VIDEO_CONTAINERS = ['mp4', 'webm', 'mov'] as const;
export const AUDIO_ONLY_CONTAINERS = ['wav', 'flac', 'm4a'] as const;
export const EXPORT_CONTAINERS = [...VIDEO_CONTAINERS, 'gif', ...AUDIO_ONLY_CONTAINERS] as const;
export type ExportContainer = (typeof EXPORT_CONTAINERS)[number];
export type AudioOnlyContainer = (typeof AUDIO_ONLY_CONTAINERS)[number];
export function isAudioOnlyContainer(c: string): c is AudioOnlyContainer {
	return (AUDIO_ONLY_CONTAINERS as readonly string[]).includes(c);
}

/** GIF dithering (`paletteuse` `dither`): error diffusion (Sierra-2-4A, Sierra-2, Floyd–Steinberg), ordered, none. */
export const GIF_DITHERS = ['sierra2_4a', 'sierra2', 'floyd_steinberg', 'bayer', 'none'] as const;
/**
 * GIF palettes (`palettegen` `stats_mode`): `full` = one palette from every frame, `diff` = one palette weighted to what
 * moves (static backgrounds get fewer colours), `single` = a new palette per frame (largest files, best colour).
 */
export const GIF_PALETTES = ['full', 'diff', 'single'] as const;
/** GIF limits (spec 18 AF-EXP-001): browsers clamp frame delays under 2 cs (50 fps) to 10 cs. */
export const GIF_LIMITS = {
	defaultFps: 15,
	maxFps: 50,
	minFps: 1,
	/** Default width: the sequence width capped at this. */
	defaultMaxWidth: 1080,
	minWidth: 16,
	maxWidth: 4096,
	/** Plays of a loop count (`loop`): 0 = forever, else 1…this. */
	maxPlays: 65536,
} as const;

export const ExportGifSchema = z.object({
	/** Frames per second (default 15, at most 50). Frames are the sequence frames nearest each GIF frame time. */
	fps: z.number().min(GIF_LIMITS.minFps).max(GIF_LIMITS.maxFps).optional(),
	/** Width in pixels (default: the sequence width capped at 1080); the height keeps the sequence aspect (even). */
	width: z.number().int().min(GIF_LIMITS.minWidth).max(GIF_LIMITS.maxWidth).optional(),
	/** How many times the animation plays: 0 = forever (default), 1 = once, n = n times. */
	loop: z.number().int().min(0).max(GIF_LIMITS.maxPlays).optional(),
	/** Dithering (default `sierra2_4a`). */
	dither: z.enum(GIF_DITHERS).optional(),
	/** Bayer pattern scale 0–5 (`bayer` only; default 2: higher = less visible pattern, more banding). */
	bayerScale: z.number().int().min(0).max(5).optional(),
	/** Palette statistics (default `full`). */
	palette: z.enum(GIF_PALETTES).optional(),
});
export type ExportGif = z.infer<typeof ExportGifSchema>;

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
	/**
	 * `mp4` / `webm` / `mov`: video (`video` + `audio`); `gif`: an animated GIF (`gif`; no `video`, no `audio`: the plan
	 * warns that the sound is left out); `wav` / `flac` / `m4a`: the sequence mix only (`audio` with codec `pcm`, `flac`,
	 * `aac`; no `video`).
	 */
	container: z.enum(EXPORT_CONTAINERS),
	/** spec 18 AF-EXP-001: the GIF's rate, width, loop count, dithering and palette (`container: 'gif'`). */
	gif: ExportGifSchema.optional(),
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
			/**
			 * `pcm` is 24-bit and requires MOV in a video export; WAV exports write 16 or 24 bits (`bitDepth`). `flac` is for
			 * FLAC files only, `aac` in M4A files.
			 */
			codec: z.enum(['aac', 'opus', 'pcm', 'flac']),
			/** spec 18 AF-EXP-002: bits per sample of a WAV or FLAC file (default 24). */
			bitDepth: z.union([z.literal(16), z.literal(24)]).optional(),
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
export const ExportWarningParamsSchema = z.record(
	z.string().max(64),
	z.union([z.string().max(2000), z.number(), z.boolean()]),
);
export type ExportWarningParams = z.infer<typeof ExportWarningParamsSchema>;

export const RenderPlanSchema = z.object({
	planId: z.string().optional(),
	documentRevision: z.number().int().optional(),
	/** `audio` = an audio-only export: the mixdown alone, no picture path. */
	path: z.union([
		z.enum(['copy', 'native', 'hybrid', 'remotion', 'browser', 'audio']),
		z.string().regex(/^cloud:/),
	]),
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
		/**
		 * The loudness target, and the true-peak limiter's ceiling in front of the encoder: the target less the codec's
		 * headroom (`codecHeadroomDb`: 0 for PCM; lossy codecs by bit rate). The export then checks the decoded audio and
		 * corrects where the codec still overshoots (result `audioLoudness`).
		 */
		normalize: z
			.object({
				targetLufs: z.number(),
				truePeakDb: z.number().optional(),
				limiterCeilingDb: z.number().optional(),
				codecHeadroomDb: z.number().optional(),
			})
			.optional(),
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
	/**
	 * spec 18 AF-EXP: the file of a GIF or audio-only export. A GIF renders the picture on `path` into a ProRes
	 * intermediate (`encoder`) and converts it (palette + dither) to `frames` GIF frames; an audio-only export writes the
	 * mix with `codec`.
	 */
	deliverable: z
		.discriminatedUnion('kind', [
			z.object({
				kind: z.literal('gif'),
				fps: z.number(),
				width: z.number().int(),
				height: z.number().int(),
				frames: z.number().int(),
				/** 0 = forever, else how many times it plays. */
				loop: z.number().int(),
				dither: z.enum(GIF_DITHERS),
				bayerScale: z.number().int().optional(),
				palette: z.enum(GIF_PALETTES),
			}),
			z.object({
				kind: z.literal('audio'),
				container: z.enum(AUDIO_ONLY_CONTAINERS),
				/** ffmpeg encoder: `pcm_s16le`, `pcm_s24le`, `flac` or `aac`. */
				codec: z.string(),
				sampleRate: z.number().int(),
				channels: z.number().int(),
				bitDepth: z.number().int().optional(),
				bitrateKbps: z.number().int().optional(),
			}),
		])
		.optional(),
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
	container: z.enum(EXPORT_CONTAINERS).optional(),
	/** FFmpeg audio encoder actually used (`aac`, `libopus`, `pcm_s16le`, `pcm_s24le`, `flac`); absent without audio. */
	audioCodec: z.string().optional(),
	/**
	 * Remotion path only (D-13): `intermediate` = Remotion rendered ProRes and the engine encoded the
	 * deliverable; `direct` = Remotion encoded it (VP9/Opus, or H.264 in a GPL dev setup).
	 */
	remotionOutput: z.enum(['direct', 'intermediate']).optional(),
	/** The path that produced the file (`hybrid` = native with baked layers; `audio` = audio-only, no picture). */
	renderPath: z.enum(['copy', 'native', 'hybrid', 'remotion', 'audio']).optional(),
	/** spec 18 AF-EXP-001: a GIF's rate, size, frame count and loop count as written. */
	gif: z
		.object({
			fps: z.number(),
			width: z.number().int(),
			height: z.number().int(),
			frames: z.number().int(),
			loop: z.number().int(),
		})
		.optional(),
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
	/**
	 * Loudness of the delivered audio (BS.1770-4): of a normalised lossy (or resampled) export the file's own audio,
	 * decoded (`measuredOn: 'decoded-file'`, the PCM it was encoded from in `pcm`); else the PCM mix. With normalisation:
	 * the gain, the target, the limiter ceiling in front of the encoder (target − the codec's headroom), how many
	 * loudness passes and encodes it took, the local corrections where the codec still overshot, and whether the target
	 * was met (`AUDIO_TRUE_PEAK_OVER` / `AUDIO_LOUDNESS_CEILING` warnings when not).
	 */
	audioLoudness: z
		.object({
			integratedLufs: z.number().nullable(),
			truePeakDbtp: z.number().nullable(),
			lra: z.number().nullable(),
			measuredOn: z.enum(['pcm', 'decoded-file']).optional(),
			pcm: z
				.object({ integratedLufs: z.number().nullable(), truePeakDbtp: z.number().nullable() })
				.optional(),
			normalizedGainDb: z.number().optional(),
			targetLufs: z.number().optional(),
			truePeakTargetDbtp: z.number().optional(),
			limiterCeilingDbtp: z.number().optional(),
			codecHeadroomDb: z.number().optional(),
			loudnessPasses: z.number().int().optional(),
			encodePasses: z.number().int().optional(),
			localCorrections: z.object({ count: z.number().int(), maxDb: z.number() }).optional(),
			ceilingLimited: z.boolean().optional(),
			truePeakMet: z.boolean().optional(),
			/**
			 * The delivery started from the parameters of an earlier delivery of the same mix to the same target and codec
			 * (a Sound Check with this export's encoding, an earlier export): one pass and one encode, still checked.
			 */
			deliveryReused: z.boolean().optional(),
			/** The file's audio stream is the checked encode itself (muxed by stream copy, not encoded again). */
			streamCopied: z.boolean().optional(),
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

// ---------------------------------------------------------------------------------------------------------------
// Export verification (spec 18 §2.5 AF-VER-001…003; docs/wp-notes/agent-footage-verify.md).

/**
 * `format` rows check what a file is (codec, size, duration, peaks a platform rejects): an agent may fix them unasked
 * by exporting again. `judgement` rows check what the cut does (black or flash frames and clicks at cuts, loudness,
 * silences, platform recommendations): ask the user.
 */
export const VERIFY_ROW_KINDS = ['format', 'judgement'] as const;
export const VERIFY_ROW_STATUSES = ['pass', 'warn', 'fail', 'unverified'] as const;
export const VERIFY_CHECK_IDS = [
	'decode',
	'streams',
	'duration',
	'av-skew',
	'cut-black',
	'cut-flash',
	'cut-click',
	'loudness',
	'true-peak',
	'silence',
	'target-container',
	'target-aspect',
	'target-duration',
	'target-resolution',
	'target-frame-rate',
	'target-size',
	'target-loudness',
] as const;
export type VerifyCheckId = (typeof VERIFY_CHECK_IDS)[number];

const VerifyValueSchema = z.union([z.number(), z.string().max(400), z.null()]);

/** Where a row points: file time, the sequence frame it shows and that frame's timecode. */
export const VerifyAtSchema = z.object({
	sec: z.number(),
	frame: z.number().int(),
	timecode: z.string().max(32),
});
export type VerifyAt = z.infer<typeof VerifyAtSchema>;

export const VerifyRowSchema = z.object({
	id: z.enum(VERIFY_CHECK_IDS),
	kind: z.enum(VERIFY_ROW_KINDS),
	status: z.enum(VERIFY_ROW_STATUSES),
	measured: VerifyValueSchema,
	expected: VerifyValueSchema,
	tolerance: VerifyValueSchema,
	at: VerifyAtSchema.optional(),
	message: z.string().max(2000),
});
export type VerifyRow = z.infer<typeof VerifyRowSchema>;

/** One stream of the exported file as ffprobe reports it. */
export const ExportOutputStreamSchema = z.object({
	index: z.number().int(),
	type: z.enum(['video', 'audio', 'subtitle', 'data', 'attachment', 'unknown']),
	codec: z.string(),
	width: z.number().int().optional(),
	height: z.number().int().optional(),
	/** Average frame rate (frames per second). */
	frameRate: z.number().optional(),
	pixFmt: z.string().optional(),
	sampleRate: z.number().int().optional(),
	channels: z.number().int().optional(),
	/** Audio bits per sample (PCM, FLAC) when the file says. */
	bitDepth: z.number().int().optional(),
	/** Frames (packets) of a GIF. */
	frames: z.number().int().optional(),
	/** Stream end (s): the last packet's end time. */
	endSec: z.number().optional(),
});
export type ExportOutputStream = z.infer<typeof ExportOutputStreamSchema>;

/** What the exported file is (AF-VER-002 `output`). */
export const ExportOutputInfoSchema = z.object({
	container: z.string(),
	durationSec: z.number().nullable(),
	sizeBytes: z.number().int(),
	streams: z.array(ExportOutputStreamSchema),
});
export type ExportOutputInfo = z.infer<typeof ExportOutputInfoSchema>;

/** `fast` = streams, duration and A/V skew (probe only); `full` = every check (decodes the whole file). */
export const VERIFY_CHECK_SETS = ['fast', 'full'] as const;

export const ExportVerifyRequestSchema = z.strictObject({
	/** A delivery target (`DELIVERY_TARGETS` id): adds the `target-*` rows. */
	target: z.enum(DELIVERY_TARGET_IDS).optional(),
	checks: z.enum(VERIFY_CHECK_SETS).optional(),
});
export type ExportVerifyRequest = z.infer<typeof ExportVerifyRequestSchema>;

/** `EngineJob.result` of an `export-verify` job. */
export const ExportVerifyResultSchema = z.object({
	exportId: z.string(),
	checks: z.enum(VERIFY_CHECK_SETS),
	target: z.enum(DELIVERY_TARGET_IDS).optional(),
	sequenceId: z.string().optional(),
	/** What the export wrote: a video file, a GIF (picture only) or an audio-only file (AF-EXP); absent = not known. */
	deliverable: z.enum(['video', 'gif', 'audio']).optional(),
	/** The sequence range the export rendered (frames `[start, end)`), when known. */
	range: z.object({ start: z.number().int(), end: z.number().int() }).optional(),
	output: ExportOutputInfoSchema,
	rows: z.array(VerifyRowSchema),
	/** No `fail` row and no `unverified` format row. */
	verified: z.boolean(),
	counts: z.object({
		pass: z.number().int(),
		warn: z.number().int(),
		fail: z.number().int(),
		unverified: z.number().int(),
	}),
});
export type ExportVerifyResult = z.infer<typeof ExportVerifyResultSchema>;
