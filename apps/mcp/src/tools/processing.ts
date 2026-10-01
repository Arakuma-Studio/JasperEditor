// M2 MCP tools: clip processing (S07:PRA-001) — list_processing_models, install_processing_model, process_clip,
// use_media_version, get_processing_settings, set_processing_settings, test_remote_executor. Owner:
// wp-m2-process (ARCHITECTURE §19.9).
import type {
	EngineJob,
	ProcessingModel,
	ProcessingSettings,
	ProcessResult,
	RegisteredMedia,
	RemoteProbeResult,
} from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import { type MediaLocator, ProcessStepSchema, type ProjectDocument } from '@jasper/project';
import { z } from 'zod';
import {
	DESTRUCTIVE,
	defineTool,
	EDIT,
	jobBody,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { LOCAL_ENGINE_ID } from '../media.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (EDITING_GUIDE). */
export const PROCESSING_GUIDE = `Clip processing (processed versions of media): process_clip runs restoration on the engine and makes a new media version — steps (in this order in the UI): deblock {filter: weak|strong}, denoise {method: atadenoise (fast, temporal) | fftdnoiz (medium) | nlmeans (slow, strongest), strength 0..1}, dejudder {mode: auto|force} (evens out 2-2-1 cadence of 50→30 fps footage without changing the frame count; auto skips footage without such a cadence; put it before stabilize), stabilize {method: auto|vidstab|deshake, smoothing frames (15 = steady handheld, 8 = mild), borders: crop|keep}, upscale {model (list_processing_models), scale 2|4, size?: {width, height}, mix?}. Every step keeps the frame count and rate, so the clip's timing never changes; the export reads the processed ProRes file (no render-time cost). Use replace: true to swap the clip to the result (framing is compensated automatically when the size changes); use_media_version switches clips between the original and any processed version. Heavy jobs take minutes on a CPU: start with wait: false and poll with wait_for_job, then call process_clip again with the same arguments and wait: true to commit (the finished file is reused). A remote GPU executor can be configured in Preferences ▸ Processing (set_processing_settings needs the user's approval).`;

const StepsArg = z
	.array(ProcessStepSchema)
	.min(1)
	.describe(
		'Processing steps, e.g. [{"op":"denoise","method":"fftdnoiz","strength":0.5},{"op":"upscale","model":"span-2x-nomosuni-multijpg","scale":2}]',
	);

type Doc = ProjectDocument;

function mediaKeyOf(doc: Doc, mediaId: string): string {
	const asset = doc.media[mediaId];
	if (!asset)
		throw new ToolError(
			'E_NOT_FOUND',
			`No media ${mediaId} in this project`,
			'Call list_media for valid ids.',
		);
	const loc = asset.locators.find((l) => l.type === 'engine-store');
	if (!loc || loc.type !== 'engine-store')
		throw new ToolError(
			'E_INVALID_PARAM',
			`Media ${mediaId} is not known to the engine`,
			'Re-import it with import_media.',
		);
	return loc.key;
}

function clipMedia(doc: Doc, clipId: string): { clipId: string; mediaId: string } {
	for (const seq of Object.values(doc.sequences)) {
		const clip = seq.clips[clipId] as { kind?: string; mediaId?: string } | undefined;
		if (!clip) continue;
		if (clip.kind !== 'video' || !clip.mediaId)
			throw new ToolError(
				'E_INVALID_PARAM',
				`Clip ${clipId} is not a video clip`,
				'Pass a video clip id or a mediaId.',
			);
		return { clipId, mediaId: clip.mediaId };
	}
	throw new ToolError('E_NOT_FOUND', `No clip ${clipId}`, 'Call get_timeline for clip ids.');
}

/** `media.derive` for a finished process job (the asset = the engine's RegisteredMedia of the output). */
export function mediaDeriveCommand(
	fromMediaId: string,
	steps: unknown[],
	res: ProcessResult,
	replaceInClips: string[] = [],
) {
	const reg: RegisteredMedia = res.registered;
	const locators: MediaLocator[] = [{ type: 'engine-store', engineId: LOCAL_ENGINE_ID, key: reg.mediaKey }];
	for (const l of reg.locators) if (l.type === 'path') locators.push(l);
	return {
		type: 'media.derive',
		fromMediaId,
		recipe: { op: 'process', steps },
		asset: {
			fingerprint: reg.fingerprint,
			originalName: reg.originalName,
			sizeBytes: reg.sizeBytes,
			container: reg.container,
			probe: reg.probe,
			locators,
			recipeVersion: res.recipeVersion,
			recipeHash: res.recipeHash,
		},
		...(replaceInClips.length ? { replaceInClips } : {}),
		ref: '$processed',
	};
}

async function engineCall<T>(ctx: ToolContext, fn: Parameters<ToolContext['engine']>[0]): Promise<T> {
	try {
		return (await ctx.engine(fn)) as T;
	} catch (e) {
		const code =
			e instanceof EngineError ? ((e.detail as { code?: string } | undefined)?.code ?? e.code) : null;
		if (code === 'REMOTE_NOT_CONFIGURED')
			throw new ToolError(
				code,
				'The remote executor is not configured',
				'Configure one in Preferences ▸ Processing (or set_processing_settings); processing runs locally without it.',
			);
		throw e;
	}
}

export function registerProcessingTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_processing_models',
		{
			title: 'List processing models',
			description:
				'The super-resolution models the engine can run for the upscale step: id, name, scale, weights licence and attribution, size and whether it is installed.',
			input: {},
			annotations: READ_ONLY,
		},
		async () => {
			const r = await engineCall<{ models: ProcessingModel[] }>(ctx, (c) => c.call('processingModels'));
			return jsonResult(r);
		},
	);

	defineTool(
		ctx,
		'install_processing_model',
		{
			title: 'Install processing model',
			description:
				'Downloads and verifies (sha256) a super-resolution model so upscale steps can use it. Returns a job id; follow it with wait_for_job. Bundled models are already installed.',
			input: { modelId: z.string().min(1).describe('Model id from list_processing_models') },
			annotations: EDIT,
		},
		async ({ modelId }) => {
			const job = await engineCall<EngineJob>(ctx, (c) =>
				c.call('processingModelInstall', { params: { modelId } }),
			);
			return jsonResult({
				...jobBody(job, ctx.link.target?.url ?? ''),
				next: 'Call wait_for_job with this jobId.',
			});
		},
	);

	defineTool(
		ctx,
		'process_clip',
		{
			title: 'Process clip',
			description:
				'Runs clip processing (deblock, denoise, stabilize, dejudder, upscale) on the engine and produces a processed version of the media (ProRes, same frame count and rate). Give clipId (its media is processed) or mediaId. Returns the job at once; with wait: true it waits (up to timeoutSeconds, default 600) and then adds the processed version to the project (bin "Processed") — and with replace: true swaps the clip(s) to it in the same undoable step. executor: auto (remote when configured and useful), local or remote.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().optional().describe('Video clip id ("clp_…") whose media is processed'),
				mediaId: z.string().optional().describe('Media id ("med_…") to process (instead of clipId)'),
				steps: StepsArg,
				executor: z.enum(['auto', 'local', 'remote']).optional(),
				replace: z
					.boolean()
					.optional()
					.describe('Swap the clip (clipId) to the processed version when done (needs wait: true)'),
				wait: z.boolean().optional().describe('Wait for the job and commit the result (default false)'),
				timeoutSeconds: z.number().int().min(1).max(900).optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, clipId, mediaId, steps, executor, replace, wait, timeoutSeconds }, extra) => {
			if (!clipId && !mediaId)
				throw new ToolError('E_INVALID_PARAM', 'Give clipId or mediaId', 'get_timeline lists clip ids.');
			if (replace && !clipId)
				throw new ToolError('E_INVALID_PARAM', 'replace needs clipId', 'Pass the clip to swap.');
			const { doc } = await loadDoc(ctx, projectId);
			const source = clipId ? clipMedia(doc, clipId).mediaId : (mediaId as string);
			// Process the original when the clip already uses a processed version.
			const asset = doc.media[source];
			const derivation = asset?.derivation as
				| { fromMediaId?: string; recipe?: { op?: string } }
				| null
				| undefined;
			const fromMediaId =
				derivation?.recipe?.op === 'process' && derivation.fromMediaId ? derivation.fromMediaId : source;
			const key = mediaKeyOf(doc, fromMediaId);
			const job = await engineCall<EngineJob>(ctx, (c) =>
				c.call('mediaProcess', {
					params: { key },
					body: { steps, executor: executor ?? 'auto', projectId },
				}),
			);
			const base = ctx.link.target?.url ?? '';
			if (!wait)
				return jsonResult({
					...jobBody(job, base),
					next: 'Call wait_for_job with this jobId, then process_clip again with the same arguments and wait: true to add (and swap to) the result.',
				});
			const { job: done, timedOut } = await waitJob(ctx, job.id, (timeoutSeconds ?? 600) * 1000, extra);
			if (timedOut)
				return jsonResult({
					...jobBody(done, base),
					timedOut: true,
					next: 'Call process_clip again with wait: true to keep waiting.',
				});
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? `JOB_${done.state.toUpperCase()}`,
					done.error?.message ?? `The job ${done.state}`,
					done.error?.code === 'REMOTE_CONNECTION_LOST'
						? 'The remote host is unreachable; retry, or use executor: "local".'
						: undefined,
					jobBody(done, base),
				);
			const res = done.result as ProcessResult;
			const res2 = await transact(
				ctx,
				projectId,
				{
					label: 'Process Clip',
					commands: [mediaDeriveCommand(fromMediaId, steps, res, replace && clipId ? [clipId] : [])],
				},
				extra,
			);
			const ok = requireOk(res2);
			const processedMediaId =
				ok.refs.$processed ?? (ok.results[0] as { mediaId?: string } | undefined)?.mediaId;
			return jsonResult({
				jobId: done.id,
				state: done.state,
				processedMediaId,
				fromMediaId,
				executor: res.executor,
				notes: res.notes,
				replacedClips: replace && clipId ? [clipId] : [],
				transaction: txBody(res2, ok),
			});
		},
	);

	defineTool(
		ctx,
		'use_media_version',
		{
			title: 'Use media version',
			description:
				'Switches video clips to another version of the same media: the original or any processed version (media ids from get_media_info → processedVersions). Timing, effects and keyframes stay; Motion is compensated when the pixel size differs. One undoable step.',
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(z.string().min(1)).min(1).describe('Video clip ids'),
				mediaId: z.string().min(1).describe('Target media id (original or processed version)'),
			},
			annotations: EDIT,
		},
		async ({ projectId, clipIds, mediaId }, extra) => {
			const res = await transact(
				ctx,
				projectId,
				{
					label: 'Use Media Version',
					commands: clipIds.map((clipId) => ({ type: 'clip.replaceSource', clipId, mediaId })),
				},
				extra,
			);
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	defineTool(
		ctx,
		'get_processing_settings',
		{
			title: 'Get processing settings',
			description:
				'The clip-processing settings: the remote executor over SSH (host, port, user, remote dir, which steps run remotely) and local CPU slots.',
			input: {},
			annotations: READ_ONLY,
		},
		async () => jsonResult(await engineCall<ProcessingSettings>(ctx, (c) => c.call('processingSettingsGet'))),
	);

	defineTool(
		ctx,
		'set_processing_settings',
		{
			title: 'Set processing settings',
			description:
				"Changes the remote executor (where media is sent for processing) and/or local CPU slots. Because it changes where the user's media goes, the user must approve it in an open JasperEditor window of `projectId` (up to 60 s). Key-based SSH only: no passwords.",
			input: {
				projectId: ProjectIdArg.describe('A project open in the editor, where the user approves the change'),
				remote: z
					.object({
						enabled: z.boolean(),
						host: z.string().min(1),
						port: z.number().int().min(1).max(65535).optional(),
						user: z.string().min(1),
						identityFile: z.string().nullable().optional(),
						remoteDir: z.string().min(1),
						useFor: z.array(z.enum(['upscale', 'dejudder', 'denoise', 'stabilize', 'deblock'])).optional(),
						strictHostKeyChecking: z.enum(['yes', 'accept-new']).optional(),
					})
					.nullable()
					.optional()
					.describe('null removes the remote executor; omit to keep it'),
				localSlots: z.number().int().min(1).optional(),
			},
			annotations: DESTRUCTIVE,
		},
		async ({ projectId, remote, localSlots }) => {
			const current = await engineCall<ProcessingSettings>(ctx, (c) => c.call('processingSettingsGet'));
			const next: ProcessingSettings = {
				remote:
					remote === undefined
						? current.remote
						: remote === null
							? null
							: {
									enabled: remote.enabled,
									host: remote.host,
									port: remote.port ?? 22,
									user: remote.user,
									identityFile: remote.identityFile ?? null,
									remoteDir: remote.remoteDir,
									useFor: remote.useFor ?? ['upscale', 'dejudder'],
									strictHostKeyChecking: remote.strictHostKeyChecking ?? 'accept-new',
								},
				...(localSlots !== undefined
					? { localSlots }
					: current.localSlots
						? { localSlots: current.localSlots }
						: {}),
			};
			const saved = await engineCall<ProcessingSettings>(ctx, (c) =>
				c.call('processingSettingsPut', {
					body: next,
					query: { approvalProjectId: projectId, agent: ctx.agentName() },
				}),
			);
			return jsonResult({
				ok: true,
				settings: saved,
				next: 'Call test_remote_executor to check the connection.',
			});
		},
	);

	defineTool(
		ctx,
		'test_remote_executor',
		{
			title: 'Test remote executor',
			description:
				'Connects to the configured remote executor over SSH and reports Node, ffmpeg, the GPU (if any), ONNX execution providers and whether the processing runtime is installed (Preferences ▸ Processing ▸ Set up installs it).',
			input: {},
			annotations: READ_ONLY,
		},
		async () => jsonResult(await engineCall<RemoteProbeResult>(ctx, (c) => c.call('processingRemoteProbe'))),
	);
}
