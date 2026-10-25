import { isAbsolute } from 'node:path';
import type { ExportSettings } from '@jasper/api';
import { defaultCreditsSidecar, sequenceTimecode } from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, timeArg } from '../arguments.ts';
import {
	cancelIfAborted,
	captureStill,
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	frameOf,
	isTerminal,
	jobBody,
	loadDoc,
	READ_ONLY,
	type ToolContext,
	waitJob,
} from '../context.ts';
import { toolEnvelope } from '../envelope.ts';
import { jsonResult, ToolError } from '../errors.ts';
import {
	buildExportSettings,
	DEFAULT_EXPORT_PRESET,
	EXPORT_PRESETS,
	findExportPreset,
} from '../export-presets.ts';
import { pickSequence, timelineTable } from '../format.ts';

import {
	failedJobError,
	renderErrorHint,
	renderToolError,
	resolveTemplateRef,
	templatePreview,
	templateSummary,
} from './templates.ts';

const JobIdArg = z.string().min(1).describe('Job id from start_export / render tools');

export function registerRenderTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'get_timeline',
		{
			title: 'Get timeline',
			description:
				'The timeline of one sequence as a compact text table: one row per clip with track, clip id, kind, name, start–end timecode and frames, source (media file and in/out seconds, text, or template) and linked partners; then transitions per track (id, type, span, alignment or fade in/out, duration), markers and In/Out. Optionally only what overlaps [from, to).',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				from: timeArg('Only clips ending after this time').optional(),
				to: timeArg('Only clips starting before this time').optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, from, to }) => {
			const { doc, revision, live } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			return {
				content: [
					{
						type: 'text',
						text: timelineTable(doc, seq, {
							revision,
							live,
							...(from !== undefined ? { from: frameOf(seq, from) } : {}),
							...(to !== undefined ? { to: frameOf(seq, to) } : {}),
						}),
					},
				],
			};
		},
	);

	defineTool(
		ctx,
		'render_frame',
		{
			title: 'Render frame',
			description:
				'Renders the Program output (what the viewer sees: all tracks composited, titles and graphics included) at one time and returns it as a PNG image, downscaled to `width` (default 640 px). Use it to check framing, titles and cuts visually. Uses the live editor state when the project is open.',
			input: {
				projectId: ProjectIdArg,
				at: timeArg('Time of the frame'),
				width: z.number().int().min(64).max(1280).optional().describe('Image width in pixels (default 640)'),
				sequenceId: SequenceIdArg,
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, at, width, sequenceId }, extra) => {
			const loaded = await loadDoc(ctx, projectId);
			// wp-m2-anime-templates (S11:ANA-005): actionable hints; a cancelled request cancels the still job.
			const r = await captureStill(
				ctx,
				{ projectId, frame: at, width: width ?? 640, ...(sequenceId ? { sequenceId } : {}) },
				extra,
				loaded,
				(job) => failedJobError(ctx, job, 'Check get_timeline; engine_status shows the render setup.'),
			).catch((e) => renderToolError(ctx, e));
			const seq = loaded.doc.sequences[r.sequenceId];
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							sequenceId: r.sequenceId,
							frame: r.frame,
							...(seq ? { timecode: sequenceTimecode(seq, r.frame) } : {}),
							width: r.width,
							...(r.renderPath ? { renderedBy: r.renderPath } : {}),
						}),
					},
					{
						type: 'image',
						data: Buffer.from(r.bytes).toString('base64'),
						mimeType: r.contentType.startsWith('image/') ? r.contentType : 'image/png',
					},
				],
			};
		},
	);

	defineTool(
		ctx,
		'get_playhead',
		{
			title: 'Get playhead',
			description:
				'The playhead position (frame + timecode) and play state of the editor window that has the project open. Needs an open editor (open_project_in_editor).',
			input: { projectId: ProjectIdArg },
			annotations: READ_ONLY,
		},
		async ({ projectId }) => {
			const q = await ctx.engine((c) => c.agentQuery({ projectId, query: 'playhead.get', args: {} }));
			return jsonResult(q.result);
		},
	);

	defineTool(
		ctx,
		'set_playhead',
		{
			title: 'Set playhead',
			description:
				'Moves the playhead of the open editor (pauses playback) so the user sees that frame in the Program monitor. A view change, not an edit (no History entry). Needs an open editor.',
			input: { projectId: ProjectIdArg, at: timeArg('Where to put the playhead') },
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, at }) => {
			const q = await ctx.engine((c) =>
				c.agentQuery({ projectId, query: 'playhead.set', args: { frame: at } }),
			);
			return jsonResult(q.result);
		},
	);

	defineTool(
		ctx,
		'list_motion_templates',
		{
			title: 'List motion-graphic templates',
			description:
				'Motion-graphic templates available to add_motion_graphic: id, version, name, description, default length, renderer ("fframes" = the native jasper-mg renderer; "anime" = drawn by Remotion, previewable and exportable without the fframes renderer), native (rendered by jasper-mg), a compact params list (type with range or options, default, keyframable = numeric/colour params of anime templates, animatable with set_motion_graphic_params; label, group and visibleWhen = how the editor shows it), presets (named param sets; pass their ref, e.g. "counter:percentage", as template to add_motion_graphic), the defaults and the full JSON Schema of the params. Also reports whether the native fframes renderer is ready.',
			input: {},
			annotations: READ_ONLY,
		},
		async () => {
			const r = await ctx.engine((c) => c.mgTemplates());
			// wp-m2-anime-templates (S11:ANA-003): renderer, native and a compact params summary per template.
			return jsonResult({ renderer: r.renderer, templates: r.templates.map(templateSummary) });
		},
	);

	defineTool(
		ctx,
		'render_motion_graphic_preview',
		{
			title: 'Preview motion graphic',
			description:
				'Renders a motion-graphic template with the given params and returns frames as PNG images, to check params before adding the graphic. fframes templates use the native renderer (the middle frame plus the URL of the animated WebM-with-alpha preview). Anime templates (renderer "anime") are drawn by Remotion in a headless Chrome from a one-clip sequence of width×height: by default the middle of the hold (the settled design); frames: 2 adds the middle of the intro, frames: 3 the middle of the outro, more frames go to the intro and outro; renderedBy tells which still path drew them (native, hybrid or remotion). Invalid params fail with E_INVALID_PARAM listing the issues.',
			input: {
				template: z
					.string()
					.min(1)
					.describe(
						'Template id, optionally "@version" and ":preset" ("lower-third@1", "counter:percentage"; presets in list_motion_templates)',
					),
				params: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(
						'Template parameters (paramsSchema in list_motion_templates); omitted ones use the defaults',
					),
				width: z.number().int().min(64).max(1920).optional().describe('Canvas width (default 960)'),
				height: z.number().int().min(64).max(1920).optional().describe('Canvas height (default 540)'),
				durationSeconds: z
					.number()
					.positive()
					.max(30)
					.optional()
					.describe('Length (default: template default)'),
				fps: z.number().int().min(1).max(60).optional().describe('Frame rate (default 30)'),
				frames: z
					.number()
					.int()
					.min(1)
					.max(6)
					.optional()
					.describe(
						'Anime templates: how many frames to return, sampled from the intro, hold and outro (default 1 = middle of the hold; 3 = intro, hold, outro middles)',
					),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			const cat = await ctx.engine((c) => c.mgTemplates());
			const { template: t, preset } = resolveTemplateRef(cat, a.template);
			// A preset's params apply over the defaults, the given params over the preset.
			const given = preset || a.params ? { ...(preset?.params ?? {}), ...(a.params ?? {}) } : undefined;
			return templatePreview(ctx, cat, t, { ...a, params: given }, extra);
		},
	);

	defineTool(
		ctx,
		'list_export_presets',
		{
			title: 'List export presets',
			description:
				'Export presets for start_export, and which video encoder the engine will actually use (it substitutes when H.264 is unavailable in this ffmpeg build).',
			input: {},
			annotations: READ_ONLY,
		},
		async () => {
			const caps = await ctx.engine((c) => c.capabilities());
			return jsonResult({
				default: DEFAULT_EXPORT_PRESET,
				presets: EXPORT_PRESETS.map((p) => ({ id: p.id, label: p.label, description: p.description })),
				engine: {
					defaultEncoder: caps.media.encoding?.export?.label ?? null,
					...(caps.media.encoding?.message ? { note: caps.media.encoding.message } : {}),
					nativeExport: caps.render.native,
					remotion: caps.render.remotionLocal,
					motionGraphics: caps.render.fframes,
				},
			});
		},
	);

	defineTool(
		ctx,
		'start_export',
		{
			title: 'Start export',
			description:
				'Starts rendering a sequence to a video file and returns a job id at once; follow it with wait_for_job (or get_job), or pass wait: true to block until it is written. Cancelling the MCP request (notifications/cancelled) during wait cancels the export and deletes the partial file. The engine picks the fastest path that can render everything (native ffmpeg for footage-only cuts, Remotion when there are text/effects). Uses the live editor state when the project is open. With outputPath the file is written there (existing files are never overwritten: the engine then writes "name (2).mp4" and the job result gives the real path); otherwise it is downloadable from the job result URL. Sound credits: a credits file goes next to the output (credits; result.credits {format, count, url, path}); soundWarnings (and result.warnings) name W_SOUND_CREDITS when a sound heard in the export needs a credit and no credits file is written, W_SOUND_LICENSE_NC for non-commercial sounds, W_SOUND_SHARE_ALIKE for CC BY-SA sounds (the video must then be shared under CC BY-SA), and W_SOUND_CHECK_STALE (level info) when the stored Sound Check is out of date or failed — tell the user. result.container / result.audioCodec are what the file holds; OUTPUT_CONTAINER_CHANGED / AUDIO_CODEC_CHANGED (plan and result warnings) say when that is not what was requested (e.g. PCM needs MOV, ProRes masters carry PCM) — tell the user. Loudness normalisation (the Mix\'s, or normalizeLufs): plan.loudness gives the target and the true-peak limiter ceiling in front of the encoder (target less the codec\'s headroom: 0 for PCM, 0.5–2 dB for AAC / Opus by bit rate); the engine encodes the audio, decodes it and turns the moments the codec still pushes over the target down, then result.audioLoudness reports the delivered file\'s own audio decoded (measuredOn "decoded-file"; pcm = the mix it encoded): integratedLufs, truePeakDbtp, limiterCeilingDbtp, codecHeadroomDb, loudnessPasses, encodePasses, localCorrections, ceilingLimited, truePeakMet. AUDIO_TRUE_PEAK_OVER / AUDIO_LOUDNESS_CEILING (result warnings) say when the delivered file misses the target — tell the user.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				preset: z
					.string()
					.optional()
					.describe(`Preset id from list_export_presets (default ${DEFAULT_EXPORT_PRESET})`),
				range: z
					.union([
						z.enum(['entire', 'in-out']),
						z.strictObject({
							from: timeArg('Start of the range'),
							to: timeArg('End of the range (exclusive)'),
						}),
					])
					.optional()
					.describe('"entire" (default), "in-out" (sequence In/Out marks) or {"from": time, "to": time}'),
				engine: z.enum(['auto', 'native', 'remotion']).optional().describe('Render path (default auto)'),
				crf: z
					.number()
					.int()
					.min(0)
					.max(51)
					.optional()
					.describe('Quality override, x264-style CRF (lower = better; 14–16 is visually lossless)'),
				videoBitrateKbps: z
					.number()
					.int()
					.min(500)
					.max(200_000)
					.optional()
					.describe(
						'Average video bitrate in kbit/s (e.g. 16000): the target of bitrate-driven encoders such as OpenH264, a ceiling for x264; ignored by ProRes',
					),
				outputPath: z
					.string()
					.optional()
					.describe(
						"Absolute path of the output file; the extension is replaced by the container's (.mp4 / .webm / .mov). Never overwrites: see result.path",
					),
				wait: z
					.boolean()
					.optional()
					.describe(
						'Block until the export finishes (progress notifications with a progressToken; cancelling the request cancels the export and deletes the partial file). Default false: return the job id at once',
					),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(3600)
					.optional()
					.describe('With wait: how long to block before returning timedOut: true (default 900)'),
				// audio-mix
				audioChannels: z
					.union([z.literal(1), z.literal(2), z.literal(6)])
					.optional()
					.describe(
						'Audio channels: 2 (stereo; a 5.1 Mix is folded with ITU-R BS.775), 1, or 6 (discrete 5.1). Default: 6 for a 5.1 Mix, else 2',
					),
				audioSampleRate: z
					.union([z.literal(44100), z.literal(48000), z.literal(96000)])
					.optional()
					.describe('Audio sample rate (default: the sequence rate; Opus is always 48 kHz)'),
				normalizeLufs: z
					.number()
					.min(-60)
					.max(0)
					.nullable()
					.optional()
					.describe(
						'Two-pass loudness normalisation of the final mix to this target (e.g. -14, -16, -23); null = off even when the sequence normalises',
					),
				truePeakDb: z
					.number()
					.min(-20)
					.max(0)
					.optional()
					.describe('True-peak ceiling of the normalisation (default -1 dBTP)'),
				captions: z
					.object({
						burnIn: z
							.union([z.boolean(), z.array(z.string())])
							.optional()
							.describe(
								'Burn captions into the picture: true (default) = visible caption tracks, false, or ["C1", …]',
							),
						embed: z
							.union([z.boolean(), z.array(z.string())])
							.optional()
							.describe(
								'Embedded subtitle streams (mov_text in MP4/MOV, WebVTT in WebM): true = all caption tracks',
							),
						sidecar: z
							.array(z.enum(['srt', 'vtt', 'scc', 'mcc', 'stl', 'ttml', 'dfxp']))
							.optional()
							.describe('Sidecar caption files written next to the output (result.captions.sidecars)'),
						sidecarTracks: z.union([z.enum(['active', 'all']), z.array(z.string())]).optional(),
						dropFrame: z.boolean().optional(),
					})
					.optional()
					.describe('Caption output (wp captions)'),
				usePreviews: z
					.boolean()
					.optional()
					.describe('Take the frames of rendered segments from their render previews (render_previews)'),
				smartRender: z
					.boolean()
					.optional()
					.describe(
						'Stream-copy untouched stretches of H.264 sources into an H.264 export (ProRes copies automatically; false = always encode)',
					),
				draftUseProxies: z
					.boolean()
					.optional()
					.describe(
						'Use Proxies: render attached proxies instead of full-resolution media (a draft; never the default)',
					),
				credits: z
					.union([
						z.enum(['txt', 'md', 'csv']),
						z.null(),
						z.strictObject({
							sidecar: z.enum(['txt', 'md', 'csv']).nullable(),
							scope: z.enum(['all', 'attribution']).optional(),
						}),
					])
					.optional()
					.describe(
						'Sound credits file written next to the output as <name>.credits.<txt|md|csv> (result.credits): the credit lines of the library sounds heard in the exported range (nested sequences included; muted tracks and disabled clips are not heard). "md" / "txt" / "csv", {sidecar, scope: "all" (default) | "attribution" (only sounds whose licence asks for a credit)}, or null = none. Default: the sequence\'s sound design credits setting, else "md" when a sound it uses needs a credit (CC BY…), else none',
					),
			},
			annotations: EDIT,
		},
		async (
			{
				projectId,
				sequenceId,
				preset,
				range,
				engine,
				outputPath,
				crf,
				videoBitrateKbps,
				audioChannels,
				audioSampleRate,
				normalizeLufs,
				truePeakDb,
				captions,
				usePreviews,
				smartRender,
				draftUseProxies,
				credits,
				wait,
				timeoutSeconds,
			},
			extra,
		) => {
			const p = findExportPreset(preset);
			if (!p)
				throw new ToolError(
					'E_NOT_FOUND',
					`Unknown export preset "${preset}"`,
					`Use one of ${EXPORT_PRESETS.map((x) => x.id).join(', ')}.`,
				);
			if (outputPath && !isAbsolute(outputPath))
				throw new ToolError(
					'E_INVALID_PARAM',
					'outputPath must be absolute',
					'Pass a full path such as /tmp/cut.mp4.',
				);
			const { doc, revision } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			let r: ExportSettings['range'] = { type: 'entire' };
			if (range === 'in-out') {
				if (seq.inPoint === null || seq.outPoint === null)
					throw new ToolError(
						'E_INVALID_PARAM',
						'The sequence has no In/Out marks',
						'Set them with apply_commands sequence.setInOut, or export "entire".',
					);
				r = { type: 'in-out' };
			} else if (range && typeof range === 'object') {
				const startFrame = frameOf(seq, range.from);
				const endFrame = frameOf(seq, range.to);
				if (endFrame <= startFrame) throw new ToolError('E_INVALID_PARAM', '`to` must be after `from`');
				r = { type: 'custom', startFrame, endFrame };
			}
			const settings = buildExportSettings(seq, p, {
				range: r,
				engine: engine ?? 'auto',
				outputPath,
				...(crf !== undefined ? { crf } : {}),
				...(videoBitrateKbps !== undefined ? { videoBitrateKbps } : {}),
				...(audioChannels !== undefined ? { audioChannels } : {}),
				...(audioSampleRate !== undefined ? { audioSampleRate } : {}),
				...(normalizeLufs !== undefined
					? {
							normalize:
								normalizeLufs === null ? null : { targetLufs: normalizeLufs, truePeakDb: truePeakDb ?? -1 },
						}
					: {}),
			});
			if (captions) settings.captions = captions;
			if (usePreviews) settings.usePreviews = true;
			if (smartRender !== undefined) settings.smartRender = smartRender;
			if (draftUseProxies) settings.draftUseProxies = true;
			// spec 12 §2.11: the sound credits sidecar (default: the sequence's setting / CC BY sounds used)
			const creditsDefaulted = credits === undefined;
			const sidecar =
				credits === undefined
					? defaultCreditsSidecar(doc, seq.id)
					: credits === null || typeof credits === 'string'
						? credits
						: credits.sidecar;
			if (sidecar)
				settings.credits = {
					sidecar,
					...(credits && typeof credits === 'object' && credits.scope ? { scope: credits.scope } : {}),
				};
			const envelope = toolEnvelope(doc, revision);
			// wp-m2-anime-templates (S11:ANA-005): plan/start failures and Remotion warnings carry actionable hints.
			const plan = await ctx
				.engine((c) => c.planExport({ envelope, sequenceId: seq.id, settings }))
				.catch((e) => renderToolError(ctx, e));
			const job = await ctx
				.engine((c) =>
					c.startExport({
						envelope,
						sequenceId: seq.id,
						settings,
						...(plan.planId ? { planId: plan.planId } : {}),
					}),
				)
				.catch((e) => renderToolError(ctx, e));
			await cancelIfAborted(ctx, extra, job.id);
			const remotionWarnings = plan.warnings.filter(
				(w) => w.code === 'REMOTION_UNAVAILABLE' || w.code.startsWith('BROWSER_'),
			);
			const hint = remotionWarnings.length
				? await renderErrorHint(ctx, remotionWarnings[0]!.code, remotionWarnings[0]!.message)
				: undefined;
			const planBody = {
				path: plan.path,
				...(plan.blockers.length
					? { why: [...new Set(plan.blockers.map((b) => b.reason))].slice(0, 5) }
					: {}),
				...(plan.encoder ? { encoder: plan.encoder.label } : {}),
				...(plan.warnings.length ? { warnings: plan.warnings.slice(0, 5).map((w) => w.message) } : {}),
				...(plan.smart ? { smartRender: plan.smart } : {}),
				// loudness normalisation: the target and the limiter ceiling in front of the encoder (the codec's headroom)
				...(plan.audio.normalize ? { loudness: plan.audio.normalize } : {}),
			};
			// spec 12 §2.11: W_SOUND_CREDITS / W_SOUND_CHECK_STALE (info) / W_SOUND_LICENSE_NC, with their codes
			const soundWarnings = plan.warnings
				.filter((w) => w.code.startsWith('W_SOUND_'))
				.map((w) => ({ code: w.code, message: w.message, ...(w.level ? { level: w.level } : {}) }));
			const creditsBody = {
				credits: {
					sidecar: settings.credits?.sidecar ?? null,
					...(settings.credits?.scope ? { scope: settings.credits.scope } : {}),
					defaulted: creditsDefaulted,
				},
				...(soundWarnings.length ? { soundWarnings } : {}),
			};
			if (wait) {
				const { job: done, timedOut } = await waitJob(ctx, job.id, (timeoutSeconds ?? 900) * 1000, extra);
				const body = jobBody(done, ctx.link.target?.url ?? '');
				if (isTerminal(done) && done.state !== 'succeeded')
					throw await failedJobError(ctx, done, 'Check the job error; engine_status may help.', body);
				return jsonResult({
					...body,
					preset: p.id,
					plan: planBody,
					...creditsBody,
					...(hint ? { hint } : {}),
					...(timedOut ? { timedOut: true, next: 'Call wait_for_job with this jobId.' } : {}),
				});
			}
			return jsonResult({
				jobId: job.id,
				state: job.state,
				preset: p.id,
				plan: planBody,
				...creditsBody,
				...(hint ? { hint } : {}),
				next: 'Call wait_for_job with this jobId.',
			});
		},
	);

	defineTool(
		ctx,
		'get_job',
		{
			title: 'Get job',
			description:
				'State, progress (percent), stage and result (output path / download URL) of an engine job.',
			input: { jobId: JobIdArg },
			annotations: READ_ONLY,
		},
		async ({ jobId }) => {
			const job = await ctx.engine((c) => c.getJob(jobId));
			return jsonResult(jobBody(job, ctx.link.target?.url ?? ''));
		},
	);

	defineTool(
		ctx,
		'cancel_job',
		{
			title: 'Cancel job',
			description: 'Cancels a queued or running engine job (e.g. an export); partial output is deleted.',
			input: { jobId: JobIdArg },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ jobId }) => {
			const job = await ctx.engine((c) => c.cancelJob(jobId));
			return jsonResult(jobBody(job, ctx.link.target?.url ?? ''));
		},
	);

	defineTool(
		ctx,
		'wait_for_job',
		{
			title: 'Wait for job',
			description:
				'Waits until a job finishes (or timeoutSeconds passes, default 120, max 900) and returns its final state and result: for exports the output file path (when outputPath was given), download URL, frame count and duration, the sound credits file (result.credits) and warnings (result.warnings: W_SOUND_CREDITS, W_SOUND_CHECK_STALE…). Sends progress notifications (at most one every 100 ms) while waiting. On timeout returns the current state with timedOut: true; call it again to keep waiting. Cancelling this request (notifications/cancelled) cancels the job itself and the engine deletes its partial output.',
			input: {
				jobId: JobIdArg,
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(900)
					.optional()
					.describe('How long to wait before returning timedOut: true (default 120, max 900)'),
			},
			annotations: READ_ONLY,
		},
		async ({ jobId, timeoutSeconds }, extra) => {
			const { job, timedOut } = await waitJob(ctx, jobId, (timeoutSeconds ?? 120) * 1000, extra);
			const body = jobBody(job, ctx.link.target?.url ?? '');
			// wp-m2-anime-templates (S11:ANA-005): render failures (Remotion/Chrome, missing templates) get hints.
			if (isTerminal(job) && job.state !== 'succeeded')
				throw await failedJobError(
					ctx,
					job,
					'Check the job error; get_project / engine_status may help.',
					body,
				);
			return jsonResult({ ...body, ...(timedOut ? { timedOut: true } : {}) });
		},
	);
}
