// Motion-graphics bundle contracts (M2, S08, ARCHITECTURE §19.3). Owner: wp-m2-mg.
// Bundles are served under `/mg/bundles/:key/*`; pre-render masters reuse `/mg/:renderKey/:file`.
import { MgBundleInfoSchema } from '@jasper/project';
import { z } from 'zod';
import { RationalSchema } from './common.ts';

/** Error codes of the mg-bundles routes and jobs (S08:MGA-002; each comes with an actionable hint). */
export const MG_BUNDLE_ERROR_CODES = [
	/** The project pins another Remotion version (detail: {found, required}). */
	'MG_REMOTION_VERSION',
	/** `remotion bundle` failed or timed out (detail: {log}). */
	'MG_BUNDLE_FAILED',
	/** Not a Remotion project / not a built bundle / bad zip. */
	'MG_NOT_A_BUNDLE',
	/** The project's node_modules are missing (run the package manager's install). */
	'MG_NOT_INSTALLED',
	/** Metadata (getCompositions) or a pre-render failed in the headless browser. */
	'MG_RENDER_FAILED',
] as const;

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
	fps: RationalSchema,
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
	/** wp-m2-mg (additive): a PNG of the middle frame. */
	posterUrl: z.string().nullable().optional(),
	/** wp-m2-mg (additive): the rendered range (composition frames at the requested fps). */
	startFrame: z.number().int().min(0).optional(),
	durationFrames: z.number().int().positive().optional(),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional(),
});
export type MgPrerenderResult = z.infer<typeof MgPrerenderResultSchema>;

/**
 * `POST /api/mg-bundles/measure-texts` (wp-m3-mgtext, S08:MGC-037): the engine's own headless browser renders
 * the composition with `props` at each frame and its text probe locates the given texts there (layout warnings
 * for agents). `fps` is the render rate (the sequence rate), `durationInFrames` the composition length at it.
 */
export const MgTextMeasureRequestSchema = z.object({
	mediaKey: z.string(),
	compositionId: z.string(),
	props: z.record(z.string(), z.unknown()),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	fps: z.number().positive(),
	durationInFrames: z.number().int().positive(),
	frames: z
		.array(
			z.object({
				frame: z.number().int().min(0),
				items: z.array(z.object({ id: z.string(), text: z.string() })).min(1),
			}),
		)
		.min(1)
		.max(8),
});
export type MgTextMeasureRequest = z.infer<typeof MgTextMeasureRequestSchema>;

/** Result: one `MgTextMeasurement` (@jasper/project) per item, and the font families the bundle registers. */
export const MgTextMeasureResultSchema = z.object({
	measurements: z.array(z.looseObject({ id: z.string(), found: z.boolean() })),
	fonts: z.array(z.string()),
});
export type MgTextMeasureResult = z.infer<typeof MgTextMeasureResultSchema>;

/**
 * Event `mgBundle.rebuilt` (S08:MGC-013): a watched or manually rebuilt project produced a new bundle. Open
 * editors relink the asset whose engine key is `oldKey` (media.relink with the new key and header, as a system
 * transaction).
 */
export const MgBundleRebuiltEventSchema = z.object({
	oldKey: z.string(),
	newKey: z.string(),
	mgBundle: MgBundleInfoSchema,
	/** Size of the new bundle's index file (the registry size). */
	sizeBytes: z.number().int().min(0).optional(),
});
export type MgBundleRebuiltEvent = z.infer<typeof MgBundleRebuiltEventSchema>;

/** `POST /api/mg-bundles/:key/rebuild` body (optional). */
export const MgBundleRebuildRequestSchema = z
	.object({ projectId: z.string().optional(), watch: z.boolean().optional() })
	.optional();

/**
 * `POST /api/mg-bundles/scaffold` (S08:MGC-015, P1, local mode): copies the template project into `dir/name`,
 * installs its dependencies and imports it with `watch: true`.
 */
export const MgBundleScaffoldRequestSchema = z.object({
	projectId: z.string().optional(),
	/** Absolute parent directory on the engine host. */
	dir: z.string().min(1),
	/** Folder / package name: letters, digits, `-` and `_`. */
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
	/** Skip the dependency install (tests, offline); the import then fails until installed. */
	install: z.boolean().optional(),
});
export type MgBundleScaffoldRequest = z.infer<typeof MgBundleScaffoldRequestSchema>;
