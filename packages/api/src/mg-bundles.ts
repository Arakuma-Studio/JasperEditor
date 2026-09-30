// Motion-graphics bundle contracts (M2, S08, ARCHITECTURE §19.3). Owner: wp-m2-mg.
// Bundles are served under `/mg/bundles/:key/*`; pre-render masters reuse `/mg/:renderKey/:file`.
import { z } from 'zod';

/**
 * `POST /api/mg-bundles/import` → RegisteredMedia (kind `mg-bundle`). Local mode: `path` = a Remotion project
 * directory (built with its own `remotion bundle`) or an already built bundle directory. Web: upload a zip of a
 * built bundle through the uploads flow with `purpose: 'mg-bundle'`, then call this with `uploadId`.
 */
export const MgBundleImportRequestSchema = z
	.object({
		projectId: z.string().optional(),
		path: z.string().min(1).optional(),
		uploadId: z.string().min(1).optional(),
		/** Rebuild automatically when the project's sources change (local project directories only). */
		watch: z.boolean().optional(),
	})
	.refine((v) => !!v.path !== !!v.uploadId, { message: 'Give exactly one of path or uploadId' });
export type MgBundleImportRequest = z.infer<typeof MgBundleImportRequestSchema>;

/** `POST /api/mg-bundles/prerender` → EngineJob (kind `mg-prerender`). */
export const MgPrerenderRequestSchema = z.object({
	projectId: z.string().optional(),
	mediaKey: z.string(),
	compositionId: z.string(),
	props: z.record(z.string(), z.unknown()),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	fps: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }),
	/** Composition frame of the master's frame 0, and the number of frames. */
	startFrame: z.number().int().min(0),
	durationFrames: z.number().int().positive(),
	quality: z.enum(['preview', 'master']),
});
export type MgPrerenderRequest = z.infer<typeof MgPrerenderRequestSchema>;

/** `EngineJob.result` of `mg-prerender` (and `GET /api/mg-bundles/prerender/:renderKey` when cached). */
export const MgPrerenderResultSchema = z.object({
	renderKey: z.string(),
	/** ProRes 4444 straight alpha (quality master). */
	masterUrl: z.string().nullable(),
	/** VP9 alpha WebM for the preview (both qualities produce it). */
	previewUrl: z.string(),
});
export type MgPrerenderResult = z.infer<typeof MgPrerenderResultSchema>;
