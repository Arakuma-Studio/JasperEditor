// GET /health and GET /api/capabilities (ARCHITECTURE §9.2, S04:RT-002 subset).
import { z } from 'zod';
import { M2FeaturesSchema } from './m2-capabilities.ts';

export const HealthSchema = z.object({
	ok: z.literal(true),
	version: z.string(),
	apiVersion: z.number().int(),
});
export type Health = z.infer<typeof HealthSchema>;

/**
 * Video codecs the engine can encode (ARCHITECTURE D-13). `prores` is the mastering codec: ProRes 422 HQ
 * (or 4444) in MOV with PCM audio, written by `prores_ks` (LGPL).
 */
/** gaps (EX-2): `hevc` = H.265 Main (libkvazaar, 8-bit) or Main / Main10 (hardware encoders). */
export const VideoCodecSchema = z.enum(['h264', 'vp9', 'av1', 'prores', 'hevc']);
export type VideoCodec = z.infer<typeof VideoCodecSchema>;

/**
 * The encoder an export or proxy uses (ARCHITECTURE D-13): hardware H.264 → OpenH264 → libx264 (dev
 * only, never required) → AV1/VP9 fallback. `rateControl` says how the CRF-style quality is mapped.
 */
export const EncoderChoiceSchema = z.object({
	codec: VideoCodecSchema,
	/** ffmpeg encoder name, e.g. `h264_nvenc`, `libopenh264`, `libx264`, `libsvtav1`. */
	encoder: z.string(),
	/** Human label, e.g. "H.264 · NVIDIA NVENC (hardware)". */
	label: z.string(),
	hardware: z.boolean(),
	container: z.enum(['mp4', 'webm', 'mov']),
	/** Audio encoder paired with the container (`aac` for MP4, `libopus` for WebM, `pcm_s16le` for MOV). */
	audioEncoder: z.string(),
	/** How the quality setting maps (`profile`: ProRes, whose quality is set by its profile). */
	rateControl: z.enum(['crf', 'cq', 'qp', 'bitrate', 'profile']),
	/** The encoder is GPL-licensed (libx264): acceptable in dev, never shipped (D-13). */
	gpl: z.boolean(),
	/** Why this is not the preferred choice (e.g. H.264 unavailable in an LGPL build). */
	message: z.string().optional(),
});
export type EncoderChoice = z.infer<typeof EncoderChoiceSchema>;

/** Encoder inventory of the resolved ffmpeg (`GET /api/capabilities` → `media.encoding`, D-13). */
export const EncodingCapabilitiesSchema = z.object({
	/** Build license from `ffmpeg -version` configuration (`--enable-gpl` / `--enable-nonfree`). */
	license: z.enum(['lgpl', 'gpl', 'nonfree', 'unknown']),
	/** `JASPER_FFMPEG_LGPL_ONLY=1`: GPL/nonfree encoders are ignored even when the build has them. */
	lgplOnly: z.boolean(),
	/** `ffmpeg -hwaccels`. */
	hwaccels: z.array(z.string()),
	/** Hardware H.264 encoders listed by the build and whether a test encode succeeded. */
	hardware: z.array(z.object({ encoder: z.string(), usable: z.boolean(), reason: z.string().optional() })),
	/** Usable encoders per codec, in preference order (GPL ones removed in LGPL-only mode). */
	codecs: z.object({
		h264: z.array(z.string()),
		vp9: z.array(z.string()),
		av1: z.array(z.string()),
		/** ProRes master encoders (`prores_ks`); absent on engines that predate it. */
		prores: z.array(z.string()).optional(),
		/** gaps: HEVC encoders (usable hardware, then libkvazaar); absent on engines that predate it. */
		hevc: z.array(z.string()).optional(),
	}),
	audio: z.object({ aac: z.boolean(), opus: z.boolean() }),
	/** `prores_ks` for alpha intermediates (motion-graphic masters). */
	prores: z.boolean(),
	/** Default export encoder (null: nothing usable). */
	export: EncoderChoiceSchema.nullable(),
	/** Proxy encoder (null: proxies unavailable). */
	proxy: EncoderChoiceSchema.nullable(),
	/** Capability message for the UI (e.g. "H.264 is unavailable: exporting AV1 (MP4)"). */
	message: z.string().optional(),
});
export type EncodingCapabilities = z.infer<typeof EncodingCapabilitiesSchema>;

/**
 * FFmpeg used by the Remotion render path (`render.remotionBinaries`, D-13): our LGPL binaries directory
 * (env `JASPER_REMOTION_BIN_DIR` → packaged `<resources>/ffmpeg-lgpl` → dev `vendor/ffmpeg-lgpl/<platform>`)
 * or, in dev only, Remotion's bundled GPL build. Packaged engines without the directory report `missing`
 * and `remotionLocal: 'unavailable'`.
 */
export const RemotionBinariesSchema = z.object({
	source: z.enum(['env', 'resources', 'vendor', 'bundled', 'missing']),
	lgpl: z.boolean(),
	/** License of the directory's ffmpeg (`-version` configuration); null for the bundled/missing build. */
	license: z.enum(['lgpl', 'gpl', 'nonfree', 'unknown']).nullable(),
	ffmpegVersion: z.string().nullable(),
	/** Warning or refusal, e.g. "Remotion is using its bundled GPL FFmpeg (dev only)". */
	message: z.string().optional(),
});
export type RemotionBinariesInfo = z.infer<typeof RemotionBinariesSchema>;

export const EngineCapabilitiesSchema = z.object({
	engine: z.object({
		version: z.string(),
		apiVersion: z.number().int(),
		mode: z.enum(['local', 'remote', 'dev']),
		/** Registering engine-side file paths is allowed (desktop/dev only, S04:SC-002). */
		pathRegistration: z.boolean(),
	}),
	media: z.object({
		ffmpegVersion: z.string().nullable(),
		ffprobeVersion: z.string().nullable(),
		encoders: z.array(z.string()),
		filters: z.array(z.string()),
		/** Encoder selection (D-13); additive, absent on older engines. */
		encoding: EncodingCapabilitiesSchema.optional(),
		/** Where the engine's ffmpeg came from (D-13 order: env → resources → vendor → PATH); additive. */
		ffmpegSource: z.enum(['env', 'resources', 'vendor', 'path', 'missing']).optional(),
	}),
	render: z.object({
		native: z.boolean(),
		remotionLocal: z.enum(['ready', 'needs-browser-download', 'unavailable']),
		/** FFmpeg of the Remotion path (D-13, wp-lgpl); additive. */
		remotionBinaries: RemotionBinariesSchema.optional(),
		fframes: z.enum(['ready', 'unavailable']),
		fframesReason: z.string().optional(),
	}),
	fonts: z.object({ bundledCatalog: z.boolean(), systemFonts: z.boolean(), customUpload: z.boolean() }),
	/** M2 feature blocks (ARCHITECTURE §19.7); additive. */
	features: M2FeaturesSchema.optional(),
	limits: z.object({
		maxUploadBytes: z.number().nullable(),
		freeDiskBytes: z.number().nullable(),
		cpuCount: z.number().int(),
		maxJsonBodyBytes: z.number().int(),
	}),
});
export type EngineCapabilities = z.infer<typeof EngineCapabilitiesSchema>;

/**
 * A third-party component the engine runs or ships, for the About / Licenses screen (D-13: FFmpeg's license
 * text and the link to its exact source must be offered with the app).
 */
export const LicenseComponentSchema = z.object({
	id: z.string(),
	name: z.string(),
	version: z.string().nullable(),
	/** SPDX id for a bundled build (`LGPL-3.0-or-later`), otherwise a description of what was found. */
	license: z.string(),
	/** Shipped with JasperEditor (the LGPL binaries directory) rather than found on the system. */
	bundled: z.boolean(),
	/** Corresponding source (the exact commit for a bundled build). */
	sourceUrl: z.string(),
	/** How it was built: build scripts or the pinned prebuilt release. */
	buildUrl: z.string().optional(),
	notice: z.string().optional(),
	/** Full license text(s). */
	texts: z.array(z.object({ title: z.string(), text: z.string() })),
});
export type LicenseComponent = z.infer<typeof LicenseComponentSchema>;

export const LicensesResponseSchema = z.object({ components: z.array(LicenseComponentSchema) });
export type LicensesResponse = z.infer<typeof LicensesResponseSchema>;
