import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ProcessingSettings, ProcessResult, RegisteredMedia } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import {
	type MediaLocator,
	mediaFrameCount,
	mediaFrameRate,
	ProcessStepSchema,
	type ProjectDocument,
	processRangeForClips,
	type Rational,
	rootFrameSpan,
	type SourceRange,
	sourceRangeFromSidecar,
} from '@jasper/project';
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
import { LOCAL_ENGINE_ID, mediaRegisterCommand } from '../media.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (EDITING_GUIDE). */
export const PROCESSING_GUIDE = `Clip processing (processed versions of media): process_clip runs restoration on the engine and makes a new media version — steps (in this order in the UI): deblock {filter: weak|strong}, denoise {method: atadenoise (fast, temporal) | fftdnoiz (medium) | nlmeans (slow, strongest), strength 0..1}, dejudder {mode: auto|force} (evens out 2-2-1 cadence of 50→30 fps footage without changing the frame count; auto skips footage without such a cadence; put it before stabilize), stabilize {method: auto|vidstab|deshake|smoothpath, smoothing frames (vid.stab: 15 = steady handheld, 8 = mild), borders: crop|keep} — vid.stab (default) removes handheld jitter and keeps intended moves; smoothpath turns one sudden reframe/jerk or a slow uneven drift into a single even move with ONE static zoom for the whole shot (tracks the background, ignores people moving through it): smoothing = Gaussian sigma in frames (30 is a good start), lockVertical / lockRotation make y / roll a straight line (static-position shots), maxZoom = zoom cap in percent (default 112; when the smoothing needs more the largest smoothing that fits is used and the job notes say so, with the zoom used and the raw vs smoothed peak camera speed), upscale {model (list_processing_models), scale 2|4, size?: {width, height}, mix?}. Every step keeps the frame count and rate, so the clip's timing never changes; the export reads the processed ProRes file (no render-time cost). Use replace: true to swap the clip to the result (framing is compensated automatically when the size changes); use_media_version switches clips between the original and any processed version. To process only what a clip uses, pass handles: N (the clip's frames plus N frames each side; much faster than the whole file) or an explicit range {startFrame, endFrame}: the version records the source range it holds, and swapping keeps the clip on exactly the same source frames (its in-point is remapped, timeline position and duration stay; trims and transitions see the version's real handles). A version that does not cover a clip is refused unless fit: "trim" | "skip". Renders made outside the editor (graded files with a source-range sidecar "first_src_frame") become versions of their source at import_media; replace_footage swaps a media's file keeping source timing; set_media_source_range declares a range by hand. Heavy jobs take minutes on a CPU: start with wait: false and poll with wait_for_job, then call process_clip again with the same arguments and wait: true to commit (the finished file is reused). A remote GPU executor can be configured in Preferences ▸ Processing (set_processing_settings needs the user's approval).`;

const StepsArg = z
	.array(ProcessStepSchema)
	.min(1)
	.describe(
		'Processing steps, e.g. [{"op":"denoise","method":"fftdnoiz","strength":0.5},{"op":"upscale","model":"span-2x-nomosuni-multijpg","scale":2}] or, to even out an operator reframe: [{"op":"dejudder","mode":"auto"},{"op":"stabilize","method":"smoothpath","smoothing":30,"borders":"crop","lockVertical":true,"lockRotation":true,"maxZoom":112}]',
	);

function mediaKeyOf(doc: ProjectDocument, mediaId: string): string {
	const asset = doc.media[mediaId];
	if (!asset)
		throw new ToolError(
			'E_NOT_FOUND',
			`No media ${mediaId} in this project`,
			'Call list_media for valid ids.',
		);
	const loc = asset.locators.find((l) => l.type === 'engine-store');
	if (!loc)
		throw new ToolError(
			'E_INVALID_PARAM',
			`Media ${mediaId} is not known to the engine`,
			'Re-import it with import_media.',
		);
	return loc.key;
}

type ClipRef = {
	mediaId: string;
	seqRate: Rational;
	clip: { sourceIn: number; duration: number; speed: { rate: number; reverse: boolean }; mediaId: string };
};

function clipMedia(doc: ProjectDocument, clipId: string): ClipRef {
	for (const seq of Object.values(doc.sequences)) {
		const clip = seq.clips[clipId] as
			| {
					kind?: string;
					mediaId?: string;
					sourceIn: number;
					duration: number;
					speed: { rate: number; reverse: boolean };
			  }
			| undefined;
		if (!clip) continue;
		if (clip.kind !== 'video' || !clip.mediaId)
			throw new ToolError(
				'E_INVALID_PARAM',
				`Clip ${clipId} is not a video clip`,
				'Pass a video clip id or a mediaId.',
			);
		return {
			mediaId: clip.mediaId,
			seqRate: seq.settings.frameRate,
			clip: { sourceIn: clip.sourceIn, duration: clip.duration, speed: clip.speed, mediaId: clip.mediaId },
		};
	}
	throw new ToolError('E_NOT_FOUND', `No clip ${clipId}`, 'Call get_timeline for clip ids.');
}

/** `media.derive` for a finished process job (the asset = the engine's RegisteredMedia of the output). */
function mediaDeriveCommand(
	fromMediaId: string,
	steps: unknown[],
	res: ProcessResult,
	replaceInClips: string[] = [],
	fit?: 'refuse' | 'trim' | 'skip',
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
		...(res.range ? { range: res.range } : {}),
		...(fit ? { fit } : {}),
		ref: '$processed',
	};
}

const FitArg = z
	.enum(['refuse', 'trim', 'skip'])
	.optional()
	.describe(
		'When the target version does not hold every source frame a clip shows: refuse (default, error naming the frames), trim (trim the clip and linked clips sharing the edge to the covered frames) or skip (leave that clip as it is)',
	);

async function engineCall<T>(ctx: ToolContext, fn: (client: EngineClient) => Promise<T>): Promise<T> {
	try {
		return await ctx.engine(fn);
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
			const r = await engineCall(ctx, (c) => c.call('processingModels'));
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
			const job = await engineCall(ctx, (c) => c.call('processingModelInstall', { params: { modelId } }));
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
				handles: z
					.number()
					.int()
					.min(0)
					.max(10_000)
					.optional()
					.describe(
						'Process only the frames the clip (clipId) shows plus this many frames of handles on each side (instead of the whole media)',
					),
				range: z
					.object({ startFrame: z.number().int().min(0), endFrame: z.number().int().min(1) })
					.optional()
					.describe('Process only these source frames [startFrame, endFrame) of the media that is processed'),
				replace: z
					.boolean()
					.optional()
					.describe('Swap the clip (clipId) to the processed version when done (needs wait: true)'),
				fit: FitArg,
				wait: z.boolean().optional().describe('Wait for the job and commit the result (default false)'),
				timeoutSeconds: z.number().int().min(1).max(900).optional(),
			},
			annotations: EDIT,
		},
		async (
			{ projectId, clipId, mediaId, steps, executor, handles, range, replace, fit, wait, timeoutSeconds },
			extra,
		) => {
			if (!clipId && !mediaId)
				throw new ToolError('E_INVALID_PARAM', 'Give clipId or mediaId', 'get_timeline lists clip ids.');
			if (replace && !clipId)
				throw new ToolError('E_INVALID_PARAM', 'replace needs clipId', 'Pass the clip to swap.');
			if (handles !== undefined && !clipId)
				throw new ToolError(
					'E_INVALID_PARAM',
					'handles needs clipId',
					'Pass the clip whose frames are processed.',
				);
			if (handles !== undefined && range)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give handles or range, not both',
					'handles derives the range from the clip.',
				);
			const { doc } = await loadDoc(ctx, projectId);
			const ref = clipId ? clipMedia(doc, clipId) : null;
			const source = ref ? ref.mediaId : (mediaId as string);
			// Process the original when the clip already uses a processed version.
			const asset = doc.media[source];
			const derivation = asset?.derivation as
				| { fromMediaId?: string; recipe?: { op?: string } }
				| null
				| undefined;
			const fromMediaId =
				derivation?.recipe?.op === 'process' && derivation.fromMediaId ? derivation.fromMediaId : source;
			const key = mediaKeyOf(doc, fromMediaId);
			// S07:PRC-015: the clip's frames (mapped into the processed media) plus handles.
			let processRange = range;
			if (handles !== undefined && ref) {
				const r = processRangeForClips(doc, [{ clip: ref.clip, seqRate: ref.seqRate }], fromMediaId, handles);
				if (!r)
					throw new ToolError(
						'E_INVALID_PARAM',
						`The frames of clip ${clipId} cannot be located in media ${fromMediaId}`,
						'Process the whole media (omit handles) or pass range.',
					);
				processRange = r;
			}
			const job = await engineCall(ctx, (c) =>
				c.call('mediaProcess', {
					params: { key },
					body: {
						steps,
						executor: executor ?? 'auto',
						projectId,
						...(processRange ? { range: processRange } : {}),
					},
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
					commands: [mediaDeriveCommand(fromMediaId, steps, res, replace && clipId ? [clipId] : [], fit)],
				},
				extra,
			);
			const ok = requireOk(res2);
			const derived = ok.results[0] as
				| { mediaId?: string; clipIds?: string[]; skippedClipIds?: string[]; trimmedClipIds?: string[] }
				| undefined;
			const processedMediaId = ok.refs.$processed ?? derived?.mediaId;
			const after = processedMediaId ? (await loadDoc(ctx, projectId).catch(() => null))?.doc : null;
			const span = processedMediaId && after ? rootFrameSpan(after, processedMediaId) : null;
			return jsonResult({
				jobId: done.id,
				state: done.state,
				processedMediaId,
				fromMediaId,
				...(res.range ? { range: res.range } : {}),
				...(span ? { sourceFrames: { of: span.rootId, start: span.start, end: span.end } } : {}),
				executor: res.executor,
				notes: res.notes,
				replacedClips: derived?.clipIds ?? [],
				...(derived?.skippedClipIds?.length ? { skippedClips: derived.skippedClipIds } : {}),
				...(derived?.trimmedClipIds?.length ? { trimmedClips: derived.trimmedClipIds } : {}),
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
				"Switches video clips to another version of the same media: the original, any processed version or a render declaring a source range of it (media ids from get_media_info → versions, with the source frames each holds). The clips keep showing exactly the same source frames at the same timeline place: the in-point (and keyframes, markers, tracker data) is remapped from the versions' source ranges; timing, effects and keyframes stay; Motion is compensated when the pixel size differs; handles become what the new file holds. A version that does not cover a clip is refused unless fit says otherwise. One undoable step.",
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(z.string().min(1)).min(1).describe('Video clip ids'),
				mediaId: z.string().min(1).describe('Target media id (original or processed version)'),
				fit: FitArg,
			},
			annotations: EDIT,
		},
		async ({ projectId, clipIds, mediaId, fit }, extra) => {
			const res = await transact(
				ctx,
				projectId,
				{
					label: 'Use Media Version',
					commands: clipIds.map((clipId) => ({
						type: 'clip.replaceSource',
						clipId,
						mediaId,
						...(fit ? { fit } : {}),
					})),
				},
				extra,
			);
			const ok = requireOk(res);
			const results = ok.results as {
				clipId: string;
				changed: boolean;
				shiftFrames?: number;
				trimmed?: unknown;
				skipped?: string;
			}[];
			return jsonResult({ ...txBody(res, ok), clips: results });
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
		async () => jsonResult(await engineCall(ctx, (c) => c.call('processingSettingsGet'))),
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
			const current = await engineCall(ctx, (c) => c.call('processingSettingsGet'));
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
			const saved = await engineCall(ctx, (c) =>
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
		async () => jsonResult(await engineCall(ctx, (c) => c.call('processingRemoteProbe'))),
	);

	defineTool(
		ctx,
		'replace_footage',
		{
			title: 'Replace footage',
			description:
				'Replaces the file behind a media item for every clip that uses it (Project panel ▸ Replace Footage…), e.g. the raw camera file by a graded render of part of it, or back. keepSourceTiming (default true): every clip keeps showing the same source frames at the same timeline place — the in-points (keyframes, markers, source marks) move by the offset between the two files, taken from source ranges (a sidecar next to the new file such as <name>.json with "first_src_frame", or the range the media already records) or else from the files\' start timecodes; refused when neither says where the files sit (pass keepSourceTiming: false to keep the in-points as they are). Clips the new file does not hold are refused unless fit: "trim". The new file is registered in place (absolute path on this machine). One undoable step "Replace Footage".',
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().min(1).describe('Media id ("med_…") whose file is replaced'),
				path: z.string().min(1).describe('Absolute path of the new file'),
				keepSourceTiming: z
					.boolean()
					.optional()
					.describe('Keep the clips on the same source frames (default true)'),
				fit: z
					.enum(['refuse', 'trim'])
					.optional()
					.describe('Clips the new file does not cover: refuse (default) or trim them to the covered frames'),
				copyIntoProject: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, mediaId, path, keepSourceTiming, fit, copyIntoProject }, extra) => {
			if (!isAbsolute(path))
				throw new ToolError('NOT_ABSOLUTE', 'Use an absolute path', 'e.g. /home/me/grade/T02.mov');
			if (!existsSync(path) || !statSync(path).isFile())
				throw new ToolError(
					'FILE_NOT_FOUND',
					`No such file: ${path}`,
					'Pass an existing file on this machine.',
				);
			const { doc } = await loadDoc(ctx, projectId);
			const asset = doc.media[mediaId];
			if (!asset)
				throw new ToolError(
					'E_NOT_FOUND',
					`No media ${mediaId} in this project`,
					'Call list_media for valid ids.',
				);
			if (asset.derivation?.recipe.op === 'process')
				throw new ToolError(
					'E_INVALID_PARAM',
					`Media ${mediaId} is a processed version`,
					'Replace the original instead, or process it again.',
				);
			const reg = await ctx.engine((c) =>
				c.registerMedia({ projectId, paths: [path], ...(copyIntoProject ? { copyIntoProject: true } : {}) }),
			);
			const item = reg.items[0];
			if (!item) {
				const e = reg.errors[0];
				throw new ToolError(e?.code ?? 'UNSUPPORTED_MEDIA', e?.message ?? 'The file could not be registered');
			}
			if (item.kind !== asset.kind)
				throw new ToolError(
					'E_INVALID_PARAM',
					`The new file is ${item.kind}, the media is ${asset.kind}`,
					'Replace footage with a file of the same kind.',
				);
			const reg0 = mediaRegisterCommand(item, '$unused', '$unused').asset;
			const sourceRange: SourceRange | null = item.sourceHint
				? sourceRangeFromSidecar(doc, item.sourceHint, {
						probe: item.probe,
						id: mediaId,
						fingerprint: item.fingerprint,
					})
				: null;
			const res = await transact(
				ctx,
				projectId,
				{
					label: 'Replace Footage',
					commands: [
						{
							type: 'media.relink',
							mediaId,
							replace: true,
							locator: reg0.locators[0],
							locators: reg0.locators,
							fingerprint: item.fingerprint,
							probe: item.probe,
							sizeBytes: item.sizeBytes,
							originalName: item.originalName,
							container: item.container,
							sourceRange,
							keepSourceTiming: keepSourceTiming ?? true,
							...(fit ? { fit } : {}),
						},
					],
				},
				extra,
			);
			const ok = requireOk(res);
			return jsonResult({
				...(ok.results[0] as Record<string, unknown>),
				sourceRange,
				...(item.sourceHint ? { sidecar: item.sourceHint.sidecar } : {}),
				transaction: txBody(res, ok),
			});
		},
	);

	defineTool(
		ctx,
		'set_media_source_range',
		{
			title: 'Set media source range',
			description:
				'Declares which source frames a media file holds: file frame 0 is frame firstFrame of sourceMediaId (same frame rate; frames counted one to one). The file then becomes a version of that source (use_media_version can switch clips to it, keeping the same source frames). Pass sourceMediaId: null with sourceName for a source that is not in the project (used by replace_footage to keep timing), or clear: true to remove the declaration. Does not move any clip. One undoable step.',
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().min(1).describe("The rendered file's media id"),
				sourceMediaId: z.string().min(1).nullable().optional().describe('The source media id, or null'),
				sourceName: z.string().optional().describe('Source file name (when sourceMediaId is null)'),
				firstFrame: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe("Source frame shown by the file's first frame"),
				frames: z.number().int().min(1).optional().describe('Frames in the file (default: from its probe)'),
				clear: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, mediaId, sourceMediaId, sourceName, firstFrame, frames, clear }, extra) => {
			let sourceRange: SourceRange | null = null;
			if (!clear) {
				const { doc } = await loadDoc(ctx, projectId);
				const asset = doc.media[mediaId];
				if (!asset)
					throw new ToolError(
						'E_NOT_FOUND',
						`No media ${mediaId} in this project`,
						'Call list_media for valid ids.',
					);
				if (firstFrame === undefined)
					throw new ToolError('E_INVALID_PARAM', 'firstFrame is required', 'Or pass clear: true.');
				const src = sourceMediaId ? doc.media[sourceMediaId] : undefined;
				if (sourceMediaId && !src)
					throw new ToolError('E_NOT_FOUND', `No media ${sourceMediaId} in this project`, 'Call list_media.');
				const rate = mediaFrameRate(src) ?? mediaFrameRate(asset);
				const n = frames ?? mediaFrameCount(asset);
				if (!rate || !n)
					throw new ToolError(
						'E_INVALID_PARAM',
						'The media has no video frame rate or duration',
						'Pass frames.',
					);
				sourceRange = {
					mediaId: sourceMediaId ?? null,
					sourceName: sourceName ?? src?.originalName ?? null,
					firstFrame,
					frames: n,
					frameRate: rate,
					origin: 'manual',
				};
			}
			const res = await transact(
				ctx,
				projectId,
				{ label: 'Set Source Range', commands: [{ type: 'media.setSourceRange', mediaId, sourceRange }] },
				extra,
			);
			return jsonResult({ sourceRange, ...txBody(res, requireOk(res)) });
		},
	);
}
