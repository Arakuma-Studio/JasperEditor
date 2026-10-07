// M2 capability blocks (ARCHITECTURE §19.7): each work package fills its block through a capability provider
// (`core.registerCapabilityProvider`). All optional: absent = the feature is not built into this engine.
import { z } from 'zod';

export const M2FeaturesSchema = z.object({
	/** wp-m2-color: colour grading on the native path. */
	color: z
		.object({
			/** `lut3d` present in the engine's FFmpeg (native path for colour effects). */
			lut3d: z.boolean(),
			/** WebGL2 available to the Remotion render path (headless) — needed for colour on that path. */
			remotionWebgl: z.enum(['ok', 'unavailable', 'unknown']),
		})
		.optional(),
	/** wp-m2-process: clip processing (S07). */
	processing: z
		.object({
			stabilize: z.enum(['vidstab', 'deshake', 'none']),
			/**
			 * wp-m3-stabpath (S07:PST-005): the smooth-path stabiliser (OpenCV.js tracking + the vid.stab WASM warp
			 * kernel). Absent on older engines = unavailable.
			 */
			smoothPath: z.enum(['ready', 'unavailable']).optional(),
			denoise: z.array(z.enum(['atadenoise', 'fftdnoiz', 'nlmeans'])),
			deblock: z.boolean(),
			dejudder: z.enum(['ready', 'unavailable']),
			upscale: z.object({
				runtime: z.enum(['onnxruntime', 'none']),
				/** Execution providers available locally, e.g. ['cpu'] or ['cuda', 'cpu']. */
				providers: z.array(z.string()),
				modelsInstalled: z.number().int().min(0),
			}),
			remote: z.object({
				configured: z.boolean(),
				/** Result of the last probe (null = never probed). */
				lastProbe: z
					.object({ ok: z.boolean(), at: z.string(), gpu: z.string().nullable(), message: z.string() })
					.nullable(),
			}),
		})
		.optional(),
	/** wp-m2-mg: Remotion bundles as clips (S08). */
	mgBundles: z
		.object({
			status: z.enum(['ready', 'unavailable']),
			reason: z.string().optional(),
			/** Import from a project directory on the engine host (local mode only). */
			projectImport: z.boolean(),
		})
		.optional(),
	/** wp-m2-track: tracking jobs (S09). */
	tracking: z
		.object({
			status: z.enum(['ready', 'unavailable']),
			engine: z.string(),
			reason: z.string().optional(),
			/** The native warp stage (corner pin / animated Motion) is available. */
			warpStage: z.boolean(),
		})
		.optional(),
	/** M2 animation (S11:LBK-030, filled by routes/anime.ts): the anime.js runtime and its catalogues. */
	anime: z
		.object({
			/** anime.js version bundled with the compositions (pinned exactly, S11:ANM-011). */
			animejs: z.string(),
			/** Text animator presets (TEXT_ANIMATION_SPECS). */
			textPresets: z.number().int().min(0),
			/** Motion-graphic templates with `renderer: 'anime'`. */
			templates: z.number().int().min(0),
		})
		.optional(),
	/** wp-m2-layer-bake (S11:LBK-030): native export of DOM layers (text, shapes, anime templates). */
	/** wp speech: local speech-to-text (Whisper on ONNX Runtime). */
	speech: z
		.object({
			status: z.enum(['ready', 'unavailable']),
			reason: z.string().optional(),
			runtime: z.literal('onnxruntime'),
			modelsInstalled: z.number().int().min(0),
			defaultModel: z.string(),
		})
		.optional(),
	layerBake: z
		.object({
			state: z.enum(['ready', 'unavailable']),
			reason: z.string().optional(),
			/** Size of `<appdir>/cache/layers`. */
			cacheBytes: z.number().int().min(0),
		})
		.optional(),
	/** wp-multicam: `POST /api/sync/audio` (Synchronize / Merge Clips / multi-camera by audio). */
	audioSync: z
		.object({
			state: z.enum(['ready', 'unavailable']),
			/** Two-pass GCC-PHAT (8 kHz coarse, 48 kHz refinement). */
			method: z.string(),
			/** Longest stretch of each recording analysed (seconds). */
			maxSeconds: z.number(),
		})
		.optional(),
});
export type M2Features = z.infer<typeof M2FeaturesSchema>;
