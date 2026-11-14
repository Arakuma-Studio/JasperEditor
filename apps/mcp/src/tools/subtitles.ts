// spec 13 AS-041 (+ the agent surfaces of AS-005 / AS-012 / AS-020): automatic subtitles as text clips — the subtitle
// groups (list_caption_groups), alignment to the picture cuts after edits, conversion to / from caption tracks,
// regeneration from the transcript, and subtitle templates (built-ins, project copies and the user's library).
// captions_from_transcript (tools/captions.ts) creates the subtitles; export_captions {groupId} writes SRT / VTT.
import { type FontCatalog, resolveCatalogFont, type SubtitleTemplateLibraryResponse } from '@jasper/api';
import {
	BUILTIN_SUBTITLE_TEMPLATES,
	CutAwareSchema,
	captionGroupMembers,
	captionGroupsOf,
	captionOf,
	groupClips,
	type ProjectDocument,
	projectSubtitleTemplates,
	type Sequence,
	SubtitleRulesSchema,
	type SubtitleTemplate,
	SubtitleTextSchema,
	sequenceTimecode,
	trackLabel,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, timeArg } from '../arguments.ts';
import {
	DESTRUCTIVE,
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	type Extra,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';

export const SUBTITLES_GUIDE = `Automatic subtitles (spec 13):
- Recommended flow: transcribe (speech to text) → clean up the transcript and the cut (remove_fillers / remove_pauses, spec 14) → captions_from_transcript {template: "builtin:pixel-pop"} (subtitles as ordinary text clips on a new top video track "Subtitles", one subtitle group, ONE undo step; dryRun: true first shows the statistics and the first subtitles) → after later picture edits, align_captions_to_cuts {groupId} → restyle with style_text {groupId} or apply_subtitle_template {groupId} → export_captions {groupId, format: "srt"} (or start_export captions.sidecar with sidecarTracks [groupId]).
- Each subtitle text clip keeps its words with their timing: a razor cut divides the words between the pieces (each keeps its own text), a text edit re-times only the words that changed, ripple edits move subtitles like any clip. regenerate_captions rebuilds a group from the current transcript, keeping clips whose text still matches (their manual style stays).
- Rules (captions_from_transcript / regenerate_captions "rules"): maxChars per line 7–72 (42), lines 1–3 (2), maxWords 1–20 or null (off), minSeconds 0.1–10 (1), maxSeconds (7), gapFrames 0–30 (0), breakPauseSeconds (1), holdSeconds (null = off: hold a subtitle until the next one, up to this long, never past a cut), punctuation never | half | always. A template brings its own defaults (Pixel Pop: 13 / 1 / 3 words / 0.2 / 2 / 0 / 0.3 / hold 0.5 / always). "text": case as-spoken | upper | lower | sentence, stripTrailingPunctuation, replaceGlyphs (… → ..., “ ” → ") with missingGlyphs, profanity {words, mask}. Spanish ("es") and English never end a line on an article / preposition when the next line can take it.
- Cut awareness ("cutAware", default on): subtitles never run across a picture cut (list_cuts: the visible picture below the subtitles' track, nests included); a subtitle whose words all follow a cut starts on it, one starting up to lookBackSeconds (0.5) after a cut starts on the cut, a hold never continues past a cut; two-sided transitions are cut zones (a subtitle started before may run through; boundaries inside snap to the edit point, or "transitions": "avoid"); cuts closer than the minimum duration merge into one zone. Statistics: count, snappedToCuts (starts moved onto cuts), splitAtCuts (pieces added), belowMinimum (too short, no room), merged (cuts merged into zones), dropped, crossing (should be 0), warnings.
- Templates (list_subtitle_templates): built-ins Pixel Pop (pixel font "Pixel12x10" — the user must install it, else the default family renders and a notice shows; white, purple outline, soft shadow, pop-in 75 → 108 → 100 %, S_Shake), Pixel Pop Classic, Subtitles (caption-track default), Bold Pop, Word Highlight, Karaoke, Minimal, Lower Third; templates saved in the project and in the user's library. A template's style becomes a linked project text style (update_text_style restyles every subtitle); its animation keys are anchored to each subtitle's In and follow trims. save_subtitle_template turns a styled text clip into a template (project + library); apply_subtitle_template restyles a group in one step (parts: style, layout, animation, highlight).
- convert_captions turns a group into a caption track (reports what a caption track cannot show: effects, animations…) or a caption track into a text-clip group.`;

const TemplateArg = z
	.union([z.string().min(1).max(80), z.record(z.string(), z.unknown())])
	.describe('A template id ("builtin:pixel-pop", a project or library template id) or a template object');
const ClipIdsArg = z
	.union([z.array(z.string().min(1)).min(1).max(20_000), z.literal('$selection')])
	.describe('Subtitle text clip ids ("clp_…"), or "$selection"');
const GroupIdArg = z.string().min(1).describe('A subtitle group id ("cgp_…", from list_caption_groups)');
export const RangeArg = z.strictObject({ from: timeArg('Start'), to: timeArg('End (exclusive)') });
export const CutAwareArg = z
	.union([z.boolean(), CutAwareSchema])
	.describe(
		'Cut-aware timing: true / false, or {enabled, lookBackSeconds, lookAheadSeconds, trackIds, overlayCoverage, includeJumpCuts, includeOverlays, transitions snap|avoid}',
	);

/** The template argument as the command takes it: an id it knows (built-in, project), else the library's object. */
export async function templateForCommand(
	ctx: ToolContext,
	doc: ProjectDocument,
	t: string | Record<string, unknown> | undefined,
): Promise<string | Record<string, unknown> | undefined> {
	if (t === undefined || typeof t !== 'string') return t;
	if (t.startsWith('builtin:') || projectSubtitleTemplates(doc)[t]) return t;
	const lib = await libraryOf(ctx);
	const found = lib?.templates.find((x) => x.id === t);
	if (!found)
		throw new ToolError(
			'E_NOT_FOUND',
			`Subtitle template not found: ${t}`,
			'list_subtitle_templates lists the built-in, project and library templates.',
		);
	return found as unknown as Record<string, unknown>;
}

async function libraryOf(ctx: ToolContext): Promise<SubtitleTemplateLibraryResponse | null> {
	try {
		return (await ctx.engine((c) => c.call('subtitleTemplatesList'))) as SubtitleTemplateLibraryResponse;
	} catch {
		return null;
	}
}

/** Runs one command and returns its first result with the transaction body. */
export async function runOne(
	ctx: ToolContext,
	projectId: string,
	label: string,
	command: Record<string, unknown>,
	extra: Extra | undefined,
	sequenceId?: string,
) {
	const res = await transact(
		ctx,
		projectId,
		{ label, commands: [command], ...(sequenceId ? { sequenceId } : {}) },
		extra,
	);
	const ok = requireOk(res);
	return { body: txBody(res, ok), result: (ok.results[0] ?? {}) as Record<string, unknown> };
}

const defined = (o: Record<string, unknown>) =>
	Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Adds timecodes to a dry run's subtitle list. */
export function withTimecodes(seq: Sequence, list: unknown): unknown {
	if (!Array.isArray(list)) return list;
	return (list as { start: number; end: number; text: string }[]).map((c) => ({
		text: c.text,
		in: { frame: c.start, timecode: sequenceTimecode(seq, c.start) },
		out: { frame: c.end, timecode: sequenceTimecode(seq, c.end) },
	}));
}

function groupRow(seq: Sequence, id: string, clips: number) {
	const g = captionGroupsOf(seq)[id]!;
	return {
		groupId: id,
		name: g.name,
		templateId: g.templateId,
		language: g.language,
		clips,
		track: g.trackId ? trackLabel(seq, g.trackId) : null,
		trackId: g.trackId ?? null,
		highlight: g.highlight?.mode ?? 'none',
		rules: g.rules,
		text: g.text,
		cutAware: g.cutAware,
		source: g.sourceRef,
		range: g.range,
	};
}

function templateRow(
	t: SubtitleTemplate,
	source: 'built-in' | 'project' | 'library',
	catalog: FontCatalog | null,
) {
	const font = catalog ? resolveCatalogFont(catalog, t.fontFamily, t.style.weight, t.style.italic) : null;
	const fontStatus = !catalog
		? 'unknown'
		: !font
			? 'missing'
			: font.family.source === 'custom'
				? 'installed'
				: 'bundled';
	return {
		templateId: t.id,
		name: t.name,
		source,
		...(t.description ? { description: t.description } : {}),
		output: t.output ?? 'text-clips',
		fontFamily: t.fontFamily,
		fontStatus,
		...(fontStatus === 'missing'
			? { notice: `Install the font "${t.fontFamily}" (install_font) or the default family renders` }
			: {}),
		highlight: t.highlight?.mode ?? 'none',
		animation: {
			textAnimation: [t.animation?.textAnimation?.in?.preset, t.animation?.textAnimation?.out?.preset].filter(
				Boolean,
			),
			effects: (t.animation?.preset?.effects ?? []).map((e) => e.effectId),
		},
		...(t.rules ? { rules: t.rules } : {}),
	};
}

export function registerSubtitleTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_caption_groups',
		{
			title: 'List subtitle groups',
			description:
				"The sequence's subtitle groups (text-clip subtitles made by captions_from_transcript): name, template, language, number of clips, track, highlight and the stored rules / text transforms / cut awareness. With groupId, a page of its subtitles (clip id, in / out frames and timecodes, track, text, words, locked, linked text style).",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				groupId: GroupIdArg.optional(),
				offset: z.number().int().min(0).optional().describe('First subtitle of the page (default 0)'),
				limit: z.number().int().min(1).max(2000).optional().describe('Subtitles per page (default 200)'),
			},
			annotations: READ_ONLY,
		},
		async (a) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const members = captionGroupMembers(seq);
			const groups = [...members.entries()]
				.filter(([id]) => captionGroupsOf(seq)[id])
				.map(([id, ids]) => groupRow(seq, id, ids.length));
			if (!a.groupId) return jsonResult({ sequenceId: seq.id, groups });
			if (!captionGroupsOf(seq)[a.groupId])
				throw new ToolError(
					'E_NOT_FOUND',
					`Subtitle group not found: ${a.groupId}`,
					'Call list_caption_groups without groupId.',
				);
			const clips = groupClips(seq, a.groupId);
			const offset = a.offset ?? 0;
			const limit = a.limit ?? 200;
			const page = clips.slice(offset, offset + limit).map((c) => ({
				clipId: c.id,
				in: { frame: c.start, timecode: sequenceTimecode(seq, c.start) },
				out: { frame: c.start + c.duration, timecode: sequenceTimecode(seq, c.start + c.duration) },
				track: trackLabel(seq, c.trackId),
				text: c.kind === 'text' ? c.content.text : '',
				words: captionOf(c)?.words.length ?? 0,
				...(captionOf(c)?.locked ? { locked: true } : {}),
				...((c as { styleId?: string }).styleId ? { styleId: (c as { styleId?: string }).styleId } : {}),
				...(c.enabled ? {} : { enabled: false }),
			}));
			return jsonResult({
				sequenceId: seq.id,
				group: groupRow(seq, a.groupId, clips.length),
				total: clips.length,
				offset,
				clips: page,
				...(offset + limit < clips.length ? { nextOffset: offset + limit } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'align_captions_to_cuts',
		{
			title: 'Align subtitles to cuts',
			description:
				"Re-runs the cut-aware steps on existing subtitles after picture edits (one undo step): splits subtitles that now run across a cut (words by midpoint), starts subtitles on a cut up to lookBackSeconds before their first word, ends them on cuts, snaps boundaries inside transitions to the edit point, extends pieces made too short away from the cut. Options default to the group's. Returns the statistics; dryRun only reports them.",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				groupId: GroupIdArg.optional(),
				clipIds: ClipIdsArg.optional(),
				options: CutAwareSchema.optional(),
				dryRun: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if ((a.groupId === undefined) === (a.clipIds === undefined))
				throw new ToolError('E_INVALID_PARAM', 'Give groupId or clipIds (one of them)');
			const { body, result } = await runOne(
				ctx,
				a.projectId,
				'Align Subtitles to Cuts',
				defined({
					type: 'captions.alignToCuts',
					groupId: a.groupId,
					clipIds: a.clipIds,
					options: a.options,
					dryRun: a.dryRun,
				}),
				extra,
				a.sequenceId,
			);
			return jsonResult({ ...body, report: result });
		},
	);

	defineTool(
		ctx,
		'convert_captions',
		{
			title: 'Convert subtitles',
			description:
				'Turns a text-clip subtitle group (or text clips) into a caption track (to: "caption-track"; words, timing, text and style kept where a caption track can show them; the report names what it cannot: effects, animations, keyframes, masks, styled runs…), or a caption track / caption clips into a text-clip subtitle group (to: "text-clips"; optional template). The source is replaced unless keepSource. One undo step.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				groupId: GroupIdArg.optional(),
				clipIds: ClipIdsArg.optional(),
				captionTrack: z.string().optional().describe('Caption track to convert to text clips: "C1"… or id'),
				to: z.enum(['text-clips', 'caption-track']),
				keepSource: z.boolean().optional(),
				template: TemplateArg.optional(),
				trackName: z.string().min(1).max(120).optional(),
			},
			annotations: DESTRUCTIVE,
		},
		async (a, extra) => {
			const n = [a.groupId, a.clipIds, a.captionTrack].filter((x) => x !== undefined).length;
			if (n !== 1)
				throw new ToolError('E_INVALID_PARAM', 'Give exactly one of groupId, clipIds, captionTrack');
			const { doc } = await loadDoc(ctx, a.projectId);
			const template = await templateForCommand(ctx, doc, a.template);
			const { body, result } = await runOne(
				ctx,
				a.projectId,
				'Convert Subtitles',
				defined({
					type: 'captions.convert',
					groupId: a.groupId,
					clipIds: a.clipIds,
					captionTrackId: a.captionTrack,
					to: a.to,
					keepSource: a.keepSource,
					template,
					trackName: a.trackName,
				}),
				extra,
				a.sequenceId,
			);
			return jsonResult({ ...body, report: result });
		},
	);

	defineTool(
		ctx,
		'regenerate_captions',
		{
			title: 'Regenerate subtitles',
			description:
				"Rebuilds a subtitle group (or a range) from the current transcript with the group's stored rules (or changed ones), keeping the clips whose text still matches (their style, effects and position stay) and replacing the others from the group's template. Locked subtitles (edited by hand) stay as they are. One undo step; dryRun reports kept / created / removed.",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				groupId: GroupIdArg,
				range: RangeArg.optional(),
				rules: SubtitleRulesSchema.optional(),
				text: SubtitleTextSchema.optional(),
				cutAware: CutAwareArg.optional(),
				// bounds: the command's schema
				lock: z.array(z.string()).optional().describe('Clip ids to keep as they are (stay locked)'),
				unlock: z.array(z.string()).optional().describe('Locked clip ids to rebuild'),
				dryRun: z.boolean().optional(),
			},
			annotations: DESTRUCTIVE,
		},
		async (a, extra) => {
			const { body, result } = await runOne(
				ctx,
				a.projectId,
				'Regenerate Subtitles',
				defined({
					type: 'captions.regenerate',
					groupId: a.groupId,
					range: a.range ? { start: a.range.from, end: a.range.to } : undefined,
					rules: a.rules,
					text: a.text,
					cutAware: a.cutAware,
					lock: a.lock,
					unlock: a.unlock,
					dryRun: a.dryRun,
				}),
				extra,
				a.sequenceId,
			);
			return jsonResult({ ...body, report: result });
		},
	);

	defineTool(
		ctx,
		'list_subtitle_templates',
		{
			title: 'List subtitle templates',
			description:
				"Subtitle templates: the built-ins, the user's library and (with projectId) the copies saved in the project — id, name, default output, font family and whether it is bundled, installed or missing (Pixel Pop's Pixel12x10 must be installed by the user), highlight, animation and default rules.",
			input: { projectId: ProjectIdArg.optional() },
			annotations: READ_ONLY,
		},
		async (a) => {
			const [lib, catalog] = await Promise.all([
				libraryOf(ctx),
				ctx.engine((c) => c.listFonts()).catch(() => null) as Promise<FontCatalog | null>,
			]);
			const project = a.projectId ? projectSubtitleTemplates((await loadDoc(ctx, a.projectId)).doc) : {};
			const builtIn = BUILTIN_SUBTITLE_TEMPLATES.map((t) => templateRow(t, 'built-in', catalog));
			const library = (lib?.templates ?? []).map((t) =>
				templateRow(t as SubtitleTemplate, 'library', catalog),
			);
			const inProject = Object.values(project)
				.filter((t) => !t.id.startsWith('builtin:'))
				.map((t) => templateRow(t, 'project', catalog));
			return jsonResult({
				templates: [...builtIn, ...library, ...inProject],
				...(lib ? { libraryRevision: lib.revision } : { libraryUnavailable: true }),
			});
		},
	);

	defineTool(
		ctx,
		'save_subtitle_template',
		{
			title: 'Save subtitle template',
			description:
				"Saves a styled text clip as a subtitle template (Save as Template…): its text style (font by family, sizes at a 1080-line reference), box width, position for the sequence's aspect, text animations, effects with keys anchored to the In (effects: false leaves them out), and, for a subtitle, its group's rules, text transforms and highlight. Stored in the project and (toLibrary, default true) in the user's template library.",
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				name: z.string().trim().min(1).max(120),
				description: z.string().max(2000).optional(),
				effects: z.boolean().optional(),
				toLibrary: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { body, result } = await runOne(
				ctx,
				a.projectId,
				'Save as Template',
				defined({
					type: 'subtitleTemplate.save',
					clipId: a.clipId,
					name: a.name,
					description: a.description,
					effects: a.effects,
				}),
				extra,
			);
			const template = result.template as SubtitleTemplate;
			let library: unknown = null;
			if (a.toLibrary !== false) {
				library = await ctx
					.engine((c) =>
						c.call('subtitleTemplateSave', {
							params: { templateId: template.id },
							body: { template } as never,
						}),
					)
					.then(() => ({ saved: true }))
					.catch((e: Error) => ({ saved: false, error: e.message }));
			}
			return jsonResult({ ...body, templateId: template.id, ...(library ? { library } : {}) });
		},
	);

	defineTool(
		ctx,
		'apply_subtitle_template',
		{
			title: 'Apply subtitle template',
			description:
				"Applies a template to a subtitle group (groupId; the group remembers it) or to text clips, in one undo step: the style (linked to the template's project text style), the layout (box width and position for the frame's aspect), the animation (the template's text animations and effects replace the ones a template added before; keys anchored to each clip's In) and the highlight. parts chooses which (default all).",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				template: TemplateArg,
				groupId: GroupIdArg.optional(),
				clipIds: ClipIdsArg.optional(),
				parts: z
					.strictObject({
						style: z.boolean().optional(),
						layout: z.boolean().optional(),
						animation: z.boolean().optional(),
						highlight: z.boolean().optional(),
					})
					.optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if ((a.groupId === undefined) === (a.clipIds === undefined))
				throw new ToolError('E_INVALID_PARAM', 'Give groupId or clipIds (one of them)');
			const { doc } = await loadDoc(ctx, a.projectId);
			const template = await templateForCommand(ctx, doc, a.template);
			const { body, result } = await runOne(
				ctx,
				a.projectId,
				'Apply Subtitle Template',
				defined({
					type: 'subtitleTemplate.apply',
					template,
					groupId: a.groupId,
					clipIds: a.clipIds,
					parts: a.parts,
				}),
				extra,
				a.sequenceId,
			);
			return jsonResult({ ...body, report: result });
		},
	);

	defineTool(
		ctx,
		'delete_subtitle_template',
		{
			title: 'Delete subtitle template',
			description:
				'Deletes a subtitle template from the project (from: "project", undoable; groups using it keep their look) or from the user\'s library (from: "library": not undoable, only when the user asks — it needs their approval in an open JasperEditor window). Built-ins cannot be deleted.',
			input: {
				projectId: ProjectIdArg.optional(),
				templateId: z.string().min(1),
				from: z.enum(['project', 'library']),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			if (a.templateId.startsWith('builtin:') && a.from === 'library')
				throw new ToolError(
					'E_INVALID_PARAM',
					'Built-in templates are read-only',
					'Only your own templates can be deleted.',
				);
			if (a.from === 'project') {
				if (!a.projectId)
					throw new ToolError('E_INVALID_PARAM', 'projectId is required with from: "project"');
				const { body } = await runOne(
					ctx,
					a.projectId,
					'Delete Subtitle Template',
					{ type: 'subtitleTemplate.delete', templateId: a.templateId },
					extra,
				);
				return jsonResult(body);
			}
			const r = await ctx.engine((c) =>
				c.call('subtitleTemplateDelete', { params: { templateId: a.templateId } }),
			);
			return jsonResult({ ok: true, removed: r.removed });
		},
	);
}
