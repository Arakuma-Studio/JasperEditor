import { type DeriveRecipe, ProcessStepSchema } from '@jasper/project';
import { z } from 'zod';
import { RegisteredMediaSchema } from './media.ts';

const SourceFrameRangeSchema = z.object({
	startFrame: z.number().int().min(0),
	endFrame: z.number().int().min(1),
});

/** `POST /api/media/:key/process` → EngineJob (kind `process`). */
export const ProcessRequestSchema = z.object({
	projectId: z.string().optional(),
	steps: z.array(ProcessStepSchema).min(1),
	/** `auto` = remote when configured and the steps benefit (upscale, dejudder), else local. */
	executor: z.enum(['auto', 'local', 'remote']).default('auto'),
	/**
	 * Process only the source frames `[startFrame, endFrame)` (at the media's rate), e.g. the part a clip uses plus
	 * handles (S07:PRC-015); the result is a shorter version whose `sourceRange` records the range.
	 */
	range: SourceFrameRangeSchema.optional(),
});
export type ProcessRequest = z.infer<typeof ProcessRequestSchema>;

/** `EngineJob.result` of a `process` job: the processed version, ready for `media.derive`. */
export const ProcessResultSchema = z.object({
	registered: RegisteredMediaSchema,
	/** The source's media key and the recipe (the client commits `media.derive` with these). */
	fromMediaKey: z.string(),
	recipeVersion: z.number().int(),
	recipeHash: z.string(),
	executor: z.enum(['local', 'remote']),
	/** Per-step notes, e.g. `dejudder: no cadence found, frames copied`. */
	notes: z.array(z.string()),
	/**
	 * the source frames `[startFrame, endFrame)` that were processed (absent = the whole
	 * source); the client passes it to `media.derive {range}` so the version records its source range.
	 */
	range: SourceFrameRangeSchema.optional(),
});
export type ProcessResult = z.infer<typeof ProcessResultSchema>;

/**
 * spec 18 AF-OPS-001: one derivation op (`POST /api/media/:key/derive`) — the `NativeRecipe` ops conform-cfr,
 * reverse, denoise-audio, extract-audio, time-stretch and range with their field bounds. Unknown keys are refused so
 * the recipe hash covers exactly what ran. Rates and ranges outside the media are refused by the engine with coded
 * errors (`UNSUPPORTED_RATE`, `OUT_OF_RANGE`, `EMPTY_RANGE`, `NO_AUDIO`, `NO_VIDEO`; `deriveProblems`).
 */
const DeriveRateSchema = z.strictObject({
	num: z.number().int().min(1).max(1_000_000),
	den: z.number().int().min(1).max(1_000_000),
});
const FlicksSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const DeriveRecipeSchema = z.discriminatedUnion('op', [
	z.strictObject({ op: z.literal('conform-cfr'), frameRate: DeriveRateSchema }),
	z.strictObject({ op: z.literal('reverse') }),
	z.strictObject({ op: z.literal('denoise-audio'), strength: z.number().min(0).max(1) }),
	z.strictObject({
		op: z.literal('extract-audio'),
		streamIndex: z.number().int().min(0).max(4096),
		format: z.enum(['wav', 'flac']),
	}),
	z.strictObject({ op: z.literal('time-stretch'), rate: z.number().positive(), preservePitch: z.boolean() }),
	z.strictObject({ op: z.literal('range'), inFlicks: FlicksSchema, outFlicks: FlicksSchema }),
]);
// Every derive recipe is a NativeRecipe the project stores as the derivation (compile-time check).
const _deriveRecipeIsNative = (r: z.infer<typeof DeriveRecipeSchema>): DeriveRecipe => r;
void _deriveRecipeIsNative;

/** `POST /api/media/:key/derive` → EngineJob (kind `derive`). */
export const DeriveRequestSchema = z.object({
	projectId: z.string().optional(),
	recipe: DeriveRecipeSchema,
});
export type DeriveRequest = z.infer<typeof DeriveRequestSchema>;

/** `EngineJob.result` of a `derive` job: the derived file, ready for `media.derive`. */
export const DeriveResultSchema = z.object({
	registered: RegisteredMediaSchema,
	fromMediaKey: z.string(),
	/** The recipe as run (commit it as `media.derive.recipe`). */
	recipe: DeriveRecipeSchema,
	recipeVersion: z.number().int(),
	recipeHash: z.string(),
	/** True when an existing output of the same source and recipe was reused (content-addressed). */
	reused: z.boolean(),
	/** `range` of a constant-frame-rate video: the source frames `[startFrame, endFrame)` the file holds. */
	range: SourceFrameRangeSchema.optional(),
	/** What the op did, e.g. `reversed in 4 segments of ≤ 61 frames`. */
	notes: z.array(z.string()),
});
export type DeriveResult = z.infer<typeof DeriveResultSchema>;

/** One super-resolution model the engine can run (catalogue + install state). */
export const ProcessingModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	scale: z.union([z.literal(2), z.literal(4)]),
	architecture: z.string(),
	/** SPDX id or licence name of the WEIGHTS, and whether attribution must be shown (e.g. CC-BY-4.0). */
	license: z.string(),
	attribution: z.string().nullable(),
	sourceUrl: z.string(),
	downloadUrl: z.string().nullable(),
	sha256: z.string(),
	sizeBytes: z.number().int().min(0),
	installed: z.boolean(),
});
export type ProcessingModel = z.infer<typeof ProcessingModelSchema>;
export const ProcessingModelsResponseSchema = z.object({ models: z.array(ProcessingModelSchema) });

/** Remote executor over SSH (S07:PRC-080…). Key-based auth only; no passwords are stored. */
export const RemoteExecutorSettingsSchema = z.object({
	enabled: z.boolean(),
	host: z.string().min(1),
	port: z.number().int().min(1).max(65535).default(22),
	user: z.string().min(1),
	/** Private key file on the engine host; null = the ssh agent / default keys. */
	identityFile: z.string().nullable(),
	/** Working directory on the remote (created by setup). */
	remoteDir: z.string().min(1),
	/** Steps that run remotely when `executor` is `auto`. */
	useFor: z.array(z.enum(['upscale', 'dejudder', 'denoise', 'stabilize', 'deblock'])),
	/** `accept-new` pins the host key on first use; `yes` requires it in known_hosts already. */
	strictHostKeyChecking: z.enum(['yes', 'accept-new']).default('accept-new'),
});
export type RemoteExecutorSettings = z.infer<typeof RemoteExecutorSettingsSchema>;

/** `GET/PUT /api/settings/processing` (stored in `<appdir>/engine/engine.json` → `processing`). */
export const ProcessingSettingsSchema = z.object({
	remote: RemoteExecutorSettingsSchema.nullable(),
	/** Max CPU slots a local processing job may take (default: half the cores). */
	localSlots: z.number().int().min(1).optional(),
});
export type ProcessingSettings = z.infer<typeof ProcessingSettingsSchema>;

/** `POST /api/processing/remote/probe` → what the remote can do (also the connection test). */
export const RemoteProbeResultSchema = z.object({
	ok: z.boolean(),
	message: z.string(),
	node: z.string().nullable(),
	ffmpeg: z.string().nullable(),
	/** E.g. 'NVIDIA GeForce RTX 5070 Ti' or null without a CUDA GPU. */
	gpu: z.string().nullable(),
	onnxProviders: z.array(z.string()),
	/** The remote runtime (jasper-proc bundle, onnxruntime) is installed and current. */
	runtimeReady: z.boolean(),
});
export type RemoteProbeResult = z.infer<typeof RemoteProbeResultSchema>;
