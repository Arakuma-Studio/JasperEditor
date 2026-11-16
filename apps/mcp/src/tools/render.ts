import { isAbsolute } from 'node:path';
import type { ExportSettings } from '@jasper/api';
import { GIF_DITHERS, GIF_LIMITS, GIF_PALETTES, MAX_EXPORT_RANGES } from '@jasper/api';
import { defaultCreditsSidecar, sequenceTimecode } from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, TimeArgSchema, timeArg } from '../arguments.ts';
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
	buildDeliverableSettings,
	buildExportSettings,
	DEFAULT_EXPORT_PRESET,
	deliveryPresetRefusal,
	EXPORT_FORMATS,
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
import { fastVerification } from './verify.ts';

const JobIdArg = z.string().min(1);

// (times as the instructions say: frames, "3s", "00:03" or timecode)
const RangeArg = z.strictObject({ from: TimeArgSchema, to: TimeArgSchema });

/** A `{from, to}` range as sequence frames, refused by name when empty or before the start. */
function rangeFrames(seq: Parameters<typeof frameOf>[0], r: z.infer<typeof RangeArg>, which = '') {
	const startFrame = frameOf(seq, r.from);
	const endFrame = frameOf(seq, r.to);
	if (startFrame < 0) throw new ToolError('E_INVALID_PARAM', `${which}\`from\` is before the sequence start`);
	if (endFrame <= startFrame) throw new ToolError('E_INVALID_PARAM', `${which}\`to\` must be after \`from\``);
	return { startFrame, endFrame };
}

/** What an export writes and reports: the `export` guide, reference an agent reads when it needs a detail. */
export const EXPORT_GUIDE =
	'Exporting: starts rendering a sequence to a video file (or, with format, an animated GIF or an audio-only WAV / FLAC / M4A file) and returns a job id at once; format "gif" renders the picture on the same path as a video (nothing the timeline shows is dropped) and converts it with a palette and dithering (gif: fps default 15 max 50, width default the sequence width capped at 1080, loop 0 = forever / 1 = once / n plays, dither, palette); a GIF has no sound and the plan warns GIF_NO_AUDIO; result.gif gives the frames written. Formats "wav" (16/24-bit PCM, audioBitDepth), "flac" (16/24-bit) and "m4a" (AAC, audioBitrateKbps) write the sequence mix through the same mixer as every export (range, audioChannels, audioSampleRate, normalizeLufs apply); plan.deliverable says what the file will be. Video: follow it with wait_for_job (or get_job), or pass wait: true to block until it is written. Cancelling the MCP request (notifications/cancelled) during wait cancels the export and deletes the partial file. The engine picks the fastest path that can render everything (native ffmpeg for footage-only cuts, Remotion when there are text/effects). Uses the live editor state when the project is open. With outputPath the file is written there (existing files are never overwritten: the engine then writes "name (2).mp4" and the job result gives the real path); otherwise it is downloadable from the job result URL. Sound credits: a credits file goes next to the output (credits; result.credits {format, count, url, path}); soundWarnings (and result.warnings) name W_SOUND_CREDITS when a sound heard in the export needs a credit and no credits file is written, W_SOUND_LICENSE_NC for non-commercial sounds, W_SOUND_SHARE_ALIKE for CC BY-SA sounds (the video must then be shared under CC BY-SA), and W_SOUND_CHECK_STALE (level info) when the stored Sound Check is out of date or failed — tell the user. result.container / result.audioCodec are what the file holds; OUTPUT_CONTAINER_CHANGED / AUDIO_CODEC_CHANGED (plan and result warnings) say when that is not what was requested (e.g. PCM needs MOV, ProRes masters carry PCM) — tell the user. Loudness normalisation (the Mix\'s, or normalizeLufs): plan.loudness gives the target and the true-peak limiter ceiling in front of the encoder (target less the codec\'s headroom: 0 for PCM, 0.5–2 dB for AAC / Opus by bit rate); the engine encodes the audio, decodes it and turns the moments the codec still pushes over the target down, then result.audioLoudness reports the delivered file\'s own audio decoded (measuredOn "decoded-file"; pcm = the mix it encoded): integratedLufs, truePeakDbtp, limiterCeilingDbtp, codecHeadroomDb, loudnessPasses, encodePasses, localCorrections, ceilingLimited, truePeakMet. AUDIO_TRUE_PEAK_OVER / AUDIO_LOUDNESS_CEILING (result warnings) say when the delivered file misses the target — tell the user. A finished export (wait: true, or wait_for_job) also returns output (container, duration, streams, size) and the fast verification rows (streams, duration, av-skew) with verified; run verify_export {exportId: jobId} for the full checks (black / flash frames and clicks at cuts, loudness, true peak, silences) and verify_export {target} for a platform. Platform presets (delivery-youtube, delivery-youtube-shorts, delivery-instagram-reels, delivery-tiktok, delivery-x, delivery-linkedin; list_export_presets) export at the platform\'s size, rate and loudness; a sequence of another shape (a horizontal sequence for a vertical platform) is refused with a hint to auto_reframe_sequence — it is never cropped.';

/**
 * Why the plan is not all native: `why` = the first five distinct reasons (and how many more); `details.blockers` =
 * every reason with the items it names, when there are more than five.
 */
function whyOf(blockers: readonly { itemId?: string; reason: string }[]): {
	why?: string[];
	details?: { blockers: { reason: string; itemIds: string[] }[] };
} {
	if (blockers.length === 0) return {};
	const byReason = new Map<string, string[]>();
	for (const b of blockers) {
		const ids = byReason.get(b.reason) ?? [];
		if (b.itemId) ids.push(b.itemId);
		byReason.set(b.reason, ids);
	}
	const reasons = [...byReason.keys()];
	if (reasons.length <= 5) return { why: reasons };
	return {
		why: [...reasons.slice(0, 5), `and ${reasons.length - 5} more (details.blockers)`],
		details: { blockers: [...byReason].map(([reason, itemIds]) => ({ reason, itemIds })) },
	};
}

export function registerRenderTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'get_timeline',
		{
			title: 'Get timeline',
			description:
				'One sequence as a text table: clips with ids, times and sources, then transitions and markers. `from`, `to`: only that range.',
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
			description: 'Render the Program output at one time as a PNG.',
			input: {
				projectId: ProjectIdArg,
				at: timeArg('Time of the frame'),
				width: z.number().int().min(64).max(1280).optional().describe('Default 640.'),
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
			description: 'Motion-graphic templates for `add_motion_graphic`, with their params.',
			details:
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
				'Render a motion-graphic template with given params as PNG frames, to check them before adding it.',
			details:
				'Renders a motion-graphic template with the given params and returns frames as PNG images, to check params before adding the graphic. Params that reference project media (an avatar {mediaId}) need projectId: the still draws that project\'s media. fframes templates use the native renderer (the middle frame plus the URL of the animated WebM-with-alpha preview). Anime templates (renderer "anime") are drawn by Remotion in a headless Chrome from a one-clip sequence of width×height: by default the middle of the hold (the settled design); frames: 2 adds the middle of the intro, frames: 3 the middle of the outro, more frames go to the intro and outro; renderedBy tells which still path drew them (native, hybrid or remotion). Invalid params fail with E_INVALID_PARAM listing the issues.',
			input: {
				template: z
					.string()
					.min(1)
					.describe(
						'Template id, optionally "@version" and ":preset" ("lower-third@1", "counter:percentage"; presets in list_motion_templates)',
					),
				projectId: ProjectIdArg.optional().describe(
					'The project whose media the params reference (media params such as an avatar {mediaId}); needed only then',
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
			const { projectId, ...args } = a;
			const project = projectId ? (await loadDoc(ctx, projectId)).doc : undefined;
			return templatePreview(ctx, cat, t, { ...args, params: given, ...(project ? { project } : {}) }, extra);
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
				presets: EXPORT_PRESETS.map((p) => ({
					id: p.id,
					label: p.label,
					description: p.description,
					...(p.target ? { target: p.target } : {}),
				})),
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
				'Render a sequence to a file: a video `preset`, or `format` gif, wav, flac or m4a. Returns a job id; `wait: true` blocks until it is written, else `wait_for_job`. Platform presets are `delivery-youtube`, `delivery-tiktok`… (`list_export_presets`). Never overwrites a file unless `overwrite: true`. Tell the user any warning in the result. A finished export returns fast checks; `verify_export` runs the full ones.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				format: z
					.enum(EXPORT_FORMATS)
					.optional()
					.describe('Default video. gif has no sound; wav, flac and m4a write the mix only.'),
				preset: z
					.string()
					.optional()
					.describe(`From \`list_export_presets\`. Default ${DEFAULT_EXPORT_PRESET}.`),
				gif: z
					.strictObject({
						fps: z
							.number()
							.min(GIF_LIMITS.minFps)
							.max(GIF_LIMITS.maxFps)
							.optional()
							.describe(`Frames per second (default ${GIF_LIMITS.defaultFps}, at most ${GIF_LIMITS.maxFps})`),
						width: z
							.number()
							.int()
							.min(GIF_LIMITS.minWidth)
							.max(GIF_LIMITS.maxWidth)
							.optional()
							.describe(
								`Width in pixels (default: the sequence width capped at ${GIF_LIMITS.defaultMaxWidth}); the height keeps the aspect`,
							),
						loop: z
							.number()
							.int()
							.min(0)
							.max(GIF_LIMITS.maxPlays)
							.optional()
							.describe('How many times it plays: 0 = forever (default), 1 = once, n = n times'),
						dither: z
							.enum(GIF_DITHERS)
							.optional()
							.describe('Dithering (default sierra2_4a; bayer = ordered pattern; none = banding)'),
						bayerScale: z
							.number()
							.int()
							.min(0)
							.max(5)
							.optional()
							.describe('Bayer pattern scale 0–5 (default 2)'),
						palette: z
							.enum(GIF_PALETTES)
							.optional()
							.describe(
								'Palette: full (one for the clip, default), diff (weighted to what moves), single (one per frame, larger)',
							),
					})
					.optional()
					.describe('With format gif.'),
				audioBitDepth: z
					.union([z.literal(16), z.literal(24)])
					.optional()
					.describe('WAV or FLAC. Default 24.'),
				audioBitrateKbps: z
					.number()
					.int()
					.min(32)
					.max(512)
					.optional()
					.describe('M4A. Default 192, or 384 for 5.1.'),
				range: z
					.union([z.enum(['entire', 'in-out']), RangeArg, z.array(RangeArg).max(MAX_EXPORT_RANGES)])
					.optional()
					.describe('Default entire; in-out = marks; {from, to} or a list: one file in order.'),
				engine: z.enum(['auto', 'native', 'remotion']).optional().describe('Default auto.'),
				crf: z
					.number()
					.int()
					.min(0)
					.max(51)
					.optional()
					.describe('Lower is better; 14-16 is visually lossless.'),
				videoBitrateKbps: z
					.number()
					.int()
					.min(500)
					.max(200_000)
					.optional()
					.describe('Target of bitrate-driven encoders, a ceiling for x264; ignored by ProRes.'),
				outputPath: z.string().optional().describe('Absolute. The extension follows the container.'),
				overwrite: z
					.boolean()
					.optional()
					.describe('Replace an existing file at outputPath. Default false: a new name.'),
				wait: z.boolean().optional(),
				timeoutSeconds: z.number().int().min(1).max(3600).optional().describe('With `wait`. Default 900.'),
				// audio-mix
				audioChannels: z
					.union([z.literal(1), z.literal(2), z.literal(6)])
					.optional()
					.describe('Default 2, or 6 for a 5.1 Mix.'),
				audioSampleRate: z
					.union([z.literal(44100), z.literal(48000), z.literal(96000)])
					.optional()
					.describe('Default: the sequence rate.'),
				normalizeLufs: z
					.number()
					.min(-60)
					.max(0)
					.nullable()
					.optional()
					.describe('Target, e.g. -14. null: off.'),
				truePeakDb: z.number().min(-20).max(0).optional().describe('Default -1.'),
				videoOnly: z
					.boolean()
					.optional()
					.describe('No audio stream (default: silence when nothing is heard).'),
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
					.describe('Default: burn in visible caption tracks.'),
				usePreviews: z.boolean().optional().describe('Take frames from render previews.'),
				smartRender: z
					.boolean()
					.optional()
					.describe('Stream-copy untouched H.264 stretches; false always encodes.'),
				draftUseProxies: z.boolean().optional().describe('Render proxies, as a draft.'),
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
						'Sound credits file next to the output: md, txt, csv or {sidecar, scope}; null for none.',
					),
			},
			annotations: EDIT,
		},
		async (
			{
				projectId,
				sequenceId,
				format,
				preset,
				gif,
				audioBitDepth,
				audioBitrateKbps,
				range,
				engine,
				outputPath,
				overwrite,
				crf,
				videoBitrateKbps,
				audioChannels,
				audioSampleRate,
				normalizeLufs,
				truePeakDb,
				videoOnly,
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
			const kind = format ?? 'video';
			// options of another format are refused by name, never ignored
			const misplaced = [
				...(kind !== 'video' && preset !== undefined ? ['preset'] : []),
				...(kind !== 'video' && crf !== undefined ? ['crf'] : []),
				...(kind !== 'video' && videoBitrateKbps !== undefined ? ['videoBitrateKbps'] : []),
				...(kind !== 'gif' && gif !== undefined ? ['gif'] : []),
				...(kind === 'gif' && audioChannels !== undefined ? ['audioChannels'] : []),
				...(kind === 'gif' && audioSampleRate !== undefined ? ['audioSampleRate'] : []),
				...(kind === 'gif' && normalizeLufs !== undefined ? ['normalizeLufs'] : []),
				...(kind !== 'wav' && kind !== 'flac' && audioBitDepth !== undefined ? ['audioBitDepth'] : []),
				...(kind !== 'm4a' && audioBitrateKbps !== undefined ? ['audioBitrateKbps'] : []),
				...(kind !== 'video' && videoOnly !== undefined ? ['videoOnly'] : []),
			];
			if (misplaced.length)
				throw new ToolError(
					'E_INVALID_PARAM',
					`${misplaced.join(', ')} ${misplaced.length === 1 ? 'does' : 'do'} not apply to format "${kind}"`,
					'preset / crf / videoBitrateKbps are for "video", gif for "gif", audioBitDepth for "wav" / "flac", audioBitrateKbps for "m4a"; a GIF has no sound.',
				);
			// a picture-only file has no sound to shape: its audio options are refused by name, never ignored
			const soundless = videoOnly
				? [
						...(audioChannels !== undefined ? ['audioChannels'] : []),
						...(audioSampleRate !== undefined ? ['audioSampleRate'] : []),
						...(normalizeLufs !== undefined ? ['normalizeLufs'] : []),
						...(truePeakDb !== undefined ? ['truePeakDb'] : []),
						...(credits ? ['credits'] : []),
					]
				: [];
			if (soundless.length)
				throw new ToolError(
					'E_INVALID_PARAM',
					`videoOnly writes no audio stream; ${soundless.join(', ')} ${soundless.length === 1 ? 'is' : 'are'} for the sound`,
					'Leave out videoOnly to export the sound, or the audio options.',
				);
			const p = findExportPreset(kind === 'video' ? preset : undefined);
			if (!p)
				throw new ToolError(
					'E_NOT_FOUND',
					`Unknown export preset "${preset}"`,
					`Use one of ${EXPORT_PRESETS.map((x) => x.id).join(', ')}.`,
				);
			if (overwrite && !outputPath)
				throw new ToolError(
					'E_INVALID_PARAM',
					'overwrite needs outputPath',
					'Pass the absolute outputPath of the file to replace.',
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
			} else if (Array.isArray(range)) {
				if (!range.length)
					throw new ToolError('E_INVALID_PARAM', 'range is an empty list', 'Give at least one {from, to}.');
				// several ranges: one file, joined in this order by the engine (each rendered as its own range export)
				const ranges = range.map((x, i) => rangeFrames(seq, x, range.length > 1 ? `range[${i}]: ` : ''));
				r = ranges.length === 1 ? { type: 'custom', ...ranges[0]! } : { type: 'ranges', ranges };
			} else if (range && typeof range === 'object') r = { type: 'custom', ...rangeFrames(seq, range) };
			// spec 18 AF-VER-004: a platform preset never crops a sequence of another shape
			const refusal = kind === 'video' ? deliveryPresetRefusal(seq, p) : null;
			if (refusal)
				throw new ToolError(
					refusal.code,
					refusal.message,
					`Run ${refusal.hint} {projectId, sequenceId, aspect: "${refusal.aspect}"} and export the new sequence with preset "${p.id}".`,
					{
						hint: refusal.hint,
						aspect: refusal.aspect,
					},
				);
			const normalize =
				normalizeLufs !== undefined
					? {
							normalize:
								normalizeLufs === null ? null : { targetLufs: normalizeLufs, truePeakDb: truePeakDb ?? -1 },
						}
					: {};
			const settings =
				kind === 'video'
					? buildExportSettings(seq, p, {
							range: r,
							engine: engine ?? 'auto',
							outputPath,
							...(overwrite ? { overwrite } : {}),
							...(crf !== undefined ? { crf } : {}),
							...(videoBitrateKbps !== undefined ? { videoBitrateKbps } : {}),
							...(audioChannels !== undefined ? { audioChannels } : {}),
							...(audioSampleRate !== undefined ? { audioSampleRate } : {}),
							...normalize,
						})
					: buildDeliverableSettings(seq, kind, {
							range: r,
							engine: engine ?? 'auto',
							outputPath,
							...(overwrite ? { overwrite } : {}),
							...(gif ? { gif } : {}),
							...(audioChannels !== undefined ? { audioChannels } : {}),
							...(audioSampleRate !== undefined ? { audioSampleRate } : {}),
							...(audioBitDepth !== undefined ? { audioBitDepth } : {}),
							...(audioBitrateKbps !== undefined ? { audioBitrateKbps } : {}),
							...normalize,
						});
			if (captions) settings.captions = captions;
			if (usePreviews) settings.usePreviews = true;
			if (smartRender !== undefined) settings.smartRender = smartRender;
			if (draftUseProxies) settings.draftUseProxies = true;
			if (videoOnly) settings.videoOnly = true;
			// spec 12 §2.11: the sound credits sidecar (default: the sequence's setting / CC BY sounds used)
			const creditsDefaulted = credits === undefined;
			const sidecar =
				credits === undefined
					? defaultCreditsSidecar(doc, seq.id)
					: credits === null || typeof credits === 'string'
						? credits
						: credits.sidecar;
			if (sidecar && !videoOnly)
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
				...whyOf(plan.blockers),
				// per-span routing: frames on each path and the Remotion spans (warning REMOTION_SPANS says which, why)
				...(plan.paths ? { paths: plan.paths } : {}),
				...(plan.encoder ? { encoder: plan.encoder.label } : {}),
				...(plan.warnings.length ? { warnings: plan.warnings.slice(0, 5).map((w) => w.message) } : {}),
				...(plan.smart ? { smartRender: plan.smart } : {}),
				// loudness normalisation: the target and the limiter ceiling in front of the encoder (the codec's headroom)
				...(plan.audio.normalize ? { loudness: plan.audio.normalize } : {}),
				// spec 18 AF-EXP: the GIF (rate, size, frames, loop, dither) or audio-only file (codec, rate, channels)
				...(plan.deliverable ? { deliverable: plan.deliverable } : {}),
				// how the composite is expected to run (decode, composite, segments, overlays); the result's is what ran
				...(plan.pipeline ? { pipeline: plan.pipeline } : {}),
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
				// spec 18 AF-VER-002: the output's probe and the fast rows
				const verification = done.state === 'succeeded' ? await fastVerification(ctx, done.id, extra) : null;
				return jsonResult({
					...body,
					...(verification ?? {}),
					...(kind === 'video' ? { preset: p.id } : { format: kind }),
					plan: planBody,
					...creditsBody,
					...(hint ? { hint } : {}),
					...(timedOut ? { timedOut: true, next: 'Call wait_for_job with this jobId.' } : {}),
				});
			}
			return jsonResult({
				jobId: job.id,
				state: job.state,
				...(kind === 'video' ? { preset: p.id } : { format: kind }),
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
				'Wait for a job and return its result. On `timedOut: true` call again. Cancelling this request cancels the job.',
			input: {
				jobId: JobIdArg,
				timeoutSeconds: z.number().int().min(1).max(900).optional().describe('Default 120, max 900.'),
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
			// spec 18 AF-VER-002: a finished export returns the output's probe and the fast rows
			const verification =
				job.kind === 'export' && job.state === 'succeeded'
					? await fastVerification(ctx, job.id, extra)
					: null;
			return jsonResult({ ...body, ...(verification ?? {}), ...(timedOut ? { timedOut: true } : {}) });
		},
	);
}
