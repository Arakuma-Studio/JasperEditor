// Clip processing contracts (M2, S07, ARCHITECTURE §19.4). Owner: wp-m2-process.
import { ProcessStepSchema } from '@jasper/project';
import { z } from 'zod';
import { RegisteredMediaSchema } from './media.ts';

/** `POST /api/media/:key/process` → EngineJob (kind `process`). */
export const ProcessRequestSchema = z.object({
	projectId: z.string().optional(),
	steps: z.array(ProcessStepSchema).min(1),
	/** `auto` = remote when configured and the steps benefit (upscale, dejudder), else local. */
	executor: z.enum(['auto', 'local', 'remote']).default('auto'),
	/**
	 * Process only the source frames `[startFrame, endFrame)` (at the media's rate), e.g. the part a clip uses plus
	 * handles (M3, S07:PRC-015); the result is a shorter version whose `sourceRange` records the range.
	 */
	range: z.object({ startFrame: z.number().int().min(0), endFrame: z.number().int().min(1) }).optional(),
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
	 * M3 (S07:PRC-015): the source frames `[startFrame, endFrame)` that were processed (absent = the whole
	 * source); the client passes it to `media.derive {range}` so the version records its source range.
	 */
	range: z.object({ startFrame: z.number().int().min(0), endFrame: z.number().int().min(1) }).optional(),
});
export type ProcessResult = z.infer<typeof ProcessResultSchema>;

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
	/** e.g. 'NVIDIA GeForce RTX 5070 Ti' or null without a CUDA GPU. */
	gpu: z.string().nullable(),
	onnxProviders: z.array(z.string()),
	/** The remote runtime (jasper-proc bundle, onnxruntime) is installed and current. */
	runtimeReady: z.boolean(),
});
export type RemoteProbeResult = z.infer<typeof RemoteProbeResultSchema>;
