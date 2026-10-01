// Inspection, motion-graphics and export tools: get_timeline, render_frame, get_playhead, set_playhead,
// list_motion_templates, render_motion_graphic_preview, list_export_presets, start_export, get_job,
// cancel_job, wait_for_job.
import { isAbsolute } from 'node:path';
import type { ExportSettings } from '@jasper/api';
import { makeEnvelope, sequenceTimecode } from '@jasper/project';
import { z } from 'zod';
import {
	defineTool,
	frameOf,
	isTerminal,
	jobBody,
	loadDoc,
	READ_ONLY,
	type ToolContext,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import {
	buildExportSettings,
	DEFAULT_EXPORT_PRESET,
	EXPORT_PRESETS,
	findExportPreset,
} from '../export-presets.ts';
import { pickSequence, timelineTable } from '../format.ts';
import { timeArg } from './editing.ts';
import { ProjectIdArg } from './projects.ts';
// wp-m2-anime-templates (S11:ANA-003, ANA-005): template summaries, anime previews and render-failure hints.
import {
	animeTemplatePreview,
	failedJobError,
	findTemplate,
	renderErrorHint,
	renderToolError,
	templateSummary,
} from './templates.ts';

const SequenceIdArg = z
	.string()
	.optional()
	.describe('Sequence id ("seq_…"); default: the project\'s first sequence');
const JobIdArg = z.string().min(1).describe('Job id from start_export / render tools');

function pickSeq(doc: Parameters<typeof pickSequence>[0], sequenceId?: string) {
	try {
		return pickSequence(doc, sequenceId);
	} catch (e) {
		throw new ToolError('E_NOT_FOUND', (e as Error).message, 'Call get_project for sequence ids.');
	}
}

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
			const seq = pickSeq(doc, sequenceId);
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
		async ({ projectId, at, width, sequenceId }) => {
			const q = await ctx
				.engine((c) =>
					c.agentQuery({
						projectId,
						query: 'frame.capture',
						args: { frame: at, width: width ?? 640, ...(sequenceId ? { sequenceId } : {}) },
					}),
				)
				.catch((e) => renderToolError(ctx, e)); // wp-m2-anime-templates (S11:ANA-005): actionable hints
			const r = q.result as { url?: string; frame?: number; sequenceId?: string; renderPath?: string };
			if (!r?.url) throw new ToolError('INTERNAL', 'The engine returned no image');
			const { bytes, contentType } = await ctx.engine((c) => c.fetchBytes(r.url!));
			const { doc } = await loadDoc(ctx, projectId).catch(() => ({ doc: null }));
			const seq = doc && r.sequenceId ? doc.sequences[r.sequenceId] : undefined;
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							sequenceId: r.sequenceId,
							frame: r.frame,
							...(seq && typeof r.frame === 'number' ? { timecode: sequenceTimecode(seq, r.frame) } : {}),
							width: width ?? 640,
							...(r.renderPath ? { renderedBy: r.renderPath } : {}),
						}),
					},
					{
						type: 'image',
						data: Buffer.from(bytes).toString('base64'),
						mimeType: contentType.startsWith('image/') ? contentType : 'image/png',
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
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ projectId, at }) => {
			const q = await ctx.engine((c) =>
				c.agentQuery({ projectId, query: 'playhead.set', args: { frame: at } }),
			);
			return jsonResult(q.result);
		},
	);

	// ------------------------------------------------------------ motion graphics

	defineTool(
		ctx,
		'list_motion_templates',
		{
			title: 'List motion-graphic templates',
			description:
				'Motion-graphic templates available to add_motion_graphic: id, version, name, description, default length, renderer ("fframes" = the native jasper-mg renderer; "anime" = drawn by Remotion, previewable and exportable without the fframes renderer), native (rendered by jasper-mg), a compact params list (type with range or options, default, keyframable = numeric/colour params of anime templates, animatable with set_motion_graphic_params), the defaults and the full JSON Schema of the params. Also reports whether the native fframes renderer is ready.',
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
				template: z.string().min(1).describe('Template id, optionally "@version" ("lower-third@1")'),
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
			const t = findTemplate(cat, a.template);
			// wp-m2-anime-templates (S11:ANA-003): anime templates are drawn by Remotion (engine still path).
			if (t.renderer === 'anime') return animeTemplatePreview(ctx, t, a, extra);
			if (cat.renderer.status !== 'ready')
				throw new ToolError(
					'RENDERER_UNAVAILABLE',
					`The native motion-graphics renderer is unavailable${cat.renderer.reason ? `: ${cat.renderer.reason}` : ''}`,
					'Build it with `pnpm mg:build`; add_motion_graphic still works (the editor previews with its SVG twin). Use render_frame on a timeline with the graphic instead. Anime templates (renderer "anime" in list_motion_templates) preview without it.',
				);
			const fps = a.fps ?? 30;
			const job = await ctx.engine((c) =>
				c.mgRender({
					quality: 'preview',
					spec: {
						template: { id: t.id, version: t.version },
						params: { ...t.defaults, ...(a.params ?? {}) },
						width: a.width ?? 960,
						height: a.height ?? 540,
						fps: { num: fps, den: 1 },
						durationFrames: Math.max(
							1,
							Math.round((a.durationSeconds ?? t.defaultDurationSeconds ?? 5) * fps),
						),
					},
				}),
			);
			const { job: done } = await waitJob(ctx, job.id, 120_000, extra);
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'RENDER_FAILED',
					done.error?.message ?? `The render ${done.state}`,
					'Check the params against the template paramsSchema (list_motion_templates).',
				);
			const result = done.result as { key: string; url: string };
			const base = ctx.link.target?.url ?? '';
			const poster = await ctx
				.engine((c) => c.fetchBytes(c.mgFileUrl(result.key, 'poster.png')))
				.catch(() => null);
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							template: `${t.id}@${t.version}`,
							jobId: done.id,
							previewUrl: `${base}${result.url}`,
						}),
					},
					...(poster
						? [
								{
									type: 'image' as const,
									data: Buffer.from(poster.bytes).toString('base64'),
									mimeType: 'image/png',
								},
							]
						: []),
				],
			};
		},
	);

	// ------------------------------------------------------------ export

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
				'Starts rendering a sequence to a video file and returns a job id at once; follow it with wait_for_job (or get_job). The engine picks the fastest path that can render everything (native ffmpeg for footage-only cuts, Remotion when there are text/effects). Uses the live editor state when the project is open. With outputPath the file is written there (existing files are never overwritten: the engine then writes "name (2).mp4" and the job result gives the real path); otherwise it is downloadable from the job result URL.',
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
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ projectId, sequenceId, preset, range, engine, outputPath, crf, videoBitrateKbps }) => {
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
			const seq = pickSeq(doc, sequenceId);
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
			});
			const envelope = makeEnvelope(doc, {
				revision: revision ?? 0,
				savedAt: new Date().toISOString(),
				platform: 'mcp',
			}) as never;
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
			const remotionWarnings = plan.warnings.filter(
				(w) => w.code === 'REMOTION_UNAVAILABLE' || w.code.startsWith('BROWSER_'),
			);
			const hint = remotionWarnings.length
				? await renderErrorHint(ctx, remotionWarnings[0]!.code, remotionWarnings[0]!.message)
				: undefined;
			return jsonResult({
				jobId: job.id,
				state: job.state,
				preset: p.id,
				plan: {
					path: plan.path,
					...(plan.blockers.length
						? { why: [...new Set(plan.blockers.map((b) => b.reason))].slice(0, 5) }
						: {}),
					...(plan.encoder ? { encoder: plan.encoder.label } : {}),
					...(plan.warnings.length ? { warnings: plan.warnings.slice(0, 5).map((w) => w.message) } : {}),
				},
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
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
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
				'Waits until a job finishes (or timeoutSeconds passes, default 120, max 900) and returns its final state and result: for exports the output file path (when outputPath was given), download URL, frame count and duration. Sends progress notifications while waiting. On timeout returns the current state with timedOut: true; call it again to keep waiting.',
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
