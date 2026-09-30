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
});
export type M2Features = z.infer<typeof M2FeaturesSchema>;
