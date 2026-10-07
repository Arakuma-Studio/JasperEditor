// wp captions MCP tools (docs/wp-notes/captions.md): caption tracks and captions (import/export in SRT, WebVTT,
// SCC, MCC, EBU STL, TTML/IMSC1, DFXP; list, add, edit, split, merge, delete, style), transcripts and text-based
// editing (import, inspect, search, select, extract, lift, insert into another sequence, remove fillers and pauses,
// rename speakers, captions from the transcript). Every edit is one transaction of document commands (also
// available through apply_commands); reads are computed from the document with the model's own functions.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import {
	activeCaptionTrack,
	BUILTIN_CAPTION_PRESETS,
	CAPTION_FILE_FORMATS,
	CAPTION_FORMAT_INFO,
	type CaptionFileFormat,
	type CaptionsClip,
	captionClipSpeaker,
	captionClipsOf,
	captionClipText,
	captionCuesForTrack,
	captionFormatFromName,
	DEFAULT_FILLERS,
	fillerRanges,
	findFillers,
	findPauses,
	mergeRanges,
	type ProjectDocument,
	paragraphs,
	resolveCaptionStyle,
	resolveTrackRef,
	type Sequence,
	type SeqWord,
	searchWords,
	sequenceTimecode,
	sequenceWords,
	supportsDropFrame,
	trackLabel,
	writeCaptionFileBytes,
} from '@jasper/project';
import { z } from 'zod';
import {
	DESTRUCTIVE,
	defineTool,
	EDIT,
	frameOf,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { timeArg } from './editing.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (EDITING_GUIDE). */
export const CAPTIONS_GUIDE = `Captions and transcripts:
- Caption tracks ("C1", "C2"… one per language) sit above the video tracks; each caption is a clip on its track, so move_clip / trim_clip / delete_clips (ripple) and sync lock work on captions too. The eye (visible) burns a track into preview and export; the active track is the one new captions go to and that exports embed first.
- import_captions reads SRT, WebVTT (cue ids, settings, voices, STYLE blocks), SCC (CEA-608 pop-on, roll-up, paint-on), MCC (CEA-608/708), EBU STL, TTML/IMSC1 and DFXP onto a new or existing caption track, snapped to frames. export_captions writes a track in any of those formats (output time; SCC/MCC at 29.97 drop-frame by default).
- list_captions shows tracks, track styles and every caption (timecodes, text, speaker). add_caption / edit_caption (text, speaker, in/out, per-caption style) / split_captions / merge_captions / delete_captions (ripple) / style_captions (track style or per-caption overrides, built-in presets: ${BUILTIN_CAPTION_PRESETS.map((p) => p.id).join(', ')}) / caption_track (add, rename, language, show/hide, lock, active).
- Caption text: lines separated by "\\n", a blank line starts a new page within one caption; <i>, <b>, <u> are kept and drawn. Word timings (for the karaoke highlight) follow the text; unchanged words keep their times.
- Transcripts: import_transcript attaches a transcript to a media item (JSON: our {words:[{text,start,end}]} in flicks, Whisper / whisper.cpp JSON, @remotion/captions Caption[] or {text,start,end} in seconds; or any caption file), so text-based editing works without speech recognition. transcript_inspect lists the sequence transcript (words heard through the audio clips, top track first, with indices, times and speakers, and paragraphs); transcript_search finds phrases (case and punctuation ignored, last word may be a prefix).
- Text-based edits take sequence word indices (inclusive): transcript_select marks In/Out around words (snapped outward to frames), transcript_extract (ripple) / transcript_lift (gap) remove them from every unlocked track, insert_transcript_selection copies them into another sequence. remove_fillers (default um, uh, umm, uhm, erm, er, ah, hmm, mm, mhm; phrases like "you know" win over single words) and remove_pauses (pauses ≥ minSeconds, keepSeconds of air on each side) ripple-delete in one undo step; dryRun lists what would go. rename_speaker renames across transcripts.
- captions_from_transcript lays the sequence transcript out as captions on a new track (Premiere defaults: 42 characters × 2 lines, 1–7 s, a new caption at a 1 s pause, a speaker change or sentence end once half full; frame-snapped, never overlapping).
- start_export captions: {burnIn, embed (mov_text in MP4/MOV, WebVTT in WebM), sidecar: ["srt", "vtt", …], sidecarTracks}.`;

const SequenceIdArg = z
	.string()
	.optional()
	.describe('Sequence id ("seq_…"); default: the project\'s first sequence');
const TrackArg = z.string().describe('Caption track: "C1", "C2"… or a track id');
const FormatArg = z.enum(CAPTION_FILE_FORMATS);
const ClipIdsArg = z
	.array(z.string().min(1))
	.min(1)
	.describe('Caption clip ids ("clp_…") from list_captions');
const StyleArg = z
	.record(z.string(), z.unknown())
	.describe(
		'Caption style fields: fontId, weight, italic, sizePx, lineHeight, trackingEm, align (left/center/right), fill [r,g,b,a 0..1], strokes [{color, widthPx, position}], background {color, paddingPx, radiusPx} | null, shadow {color, angleDeg, distancePx, blurPx} | null, allCaps, highlight {mode none|word|karaoke, color}, maxLines, maxCharsPerLine, maxSegmentMs, boxWidthPct, placement bottom|middle|top, marginPct, linePct, positionPct',
	);
const WordArg = (what: string) =>
	z.number().int().min(0).describe(`${what} (sequence word index from transcript_inspect)`);

async function run(
	ctx: ToolContext,
	projectId: string,
	label: string,
	commands: unknown[],
	extra: Parameters<typeof transact>[3],
	sequenceId?: string,
) {
	const res = await transact(
		ctx,
		projectId,
		{ label, commands, ...(sequenceId ? { sequenceId } : {}) },
		extra,
	);
	return jsonResult(txBody(res, requireOk(res)));
}

async function sequenceOf(ctx: ToolContext, projectId: string, sequenceId?: string) {
	const { doc, revision } = await loadDoc(ctx, projectId);
	let seq: Sequence;
	try {
		seq = pickSequence(doc, sequenceId);
	} catch (e) {
		throw new ToolError('E_NOT_FOUND', (e as Error).message, 'Call get_project for sequence ids.');
	}
	return { doc, seq, revision };
}

function captionTrackOf(seq: Sequence, ref: string | undefined) {
	if (ref === undefined) {
		const t = activeCaptionTrack(seq);
		if (!t)
			throw new ToolError(
				'E_NOT_FOUND',
				'The sequence has no caption track',
				'Add one with caption_track {action: "add"} or import_captions.',
			);
		return t;
	}
	const id = resolveTrackRef(seq, ref);
	const t = seq.captionTracks.find((x) => x.id === id);
	if (!t)
		throw new ToolError(
			'E_NOT_FOUND',
			`Caption track not found: ${ref}`,
			'Caption tracks are "C1", "C2"…; see list_captions.',
		);
	return t;
}

function absolutePath(p: string): string {
	if (!isAbsolute(p))
		throw new ToolError(
			'E_INVALID_PARAM',
			'Paths must be absolute',
			'Pass a full path such as /tmp/subs.srt.',
		);
	return p;
}

async function readInput(
	path: string | undefined,
	content: string | undefined,
): Promise<{ content?: string; contentBase64?: string; fileName?: string }> {
	if (path === undefined && content === undefined)
		throw new ToolError(
			'E_INVALID_PARAM',
			'Give path or content',
			'path: an absolute file path; content: the file text.',
		);
	if (path !== undefined) {
		const bytes = await readFile(absolutePath(path)).catch((e: Error) => {
			throw new ToolError('E_NOT_FOUND', `Cannot read ${path}: ${e.message}`);
		});
		if (bytes.length > 64 * 1024 * 1024) throw new ToolError('E_LIMIT', 'The file is larger than 64 MB');
		return { contentBase64: bytes.toString('base64'), fileName: basename(path) };
	}
	return { content };
}

function wordRow(seq: Sequence, w: SeqWord, i: number) {
	const F = (705_600_000 * seq.settings.frameRate.den) / seq.settings.frameRate.num;
	const frame = Math.floor(w.start / F);
	return {
		index: i,
		text: w.text,
		start: {
			seconds: Math.round((w.start / 705_600_000) * 1000) / 1000,
			frame,
			timecode: sequenceTimecode(seq, frame),
		},
		end: { seconds: Math.round((w.end / 705_600_000) * 1000) / 1000 },
		speaker: w.speaker,
		...(w.confidence !== null ? { confidence: w.confidence } : {}),
		clipId: w.clipId,
	};
}

function captionRow(doc: ProjectDocument, seq: Sequence, c: CaptionsClip) {
	const rate = seq.settings.frameRate;
	return {
		clipId: c.id,
		in: { frame: c.start, timecode: sequenceTimecode(seq, c.start) },
		out: { frame: c.start + c.duration, timecode: sequenceTimecode(seq, c.start + c.duration) },
		text: captionClipText(doc, c, rate),
		speaker: captionClipSpeaker(doc, c, rate),
		...(Object.keys(c.style).length ? { styleOverrides: c.style } : {}),
		...(c.enabled ? {} : { enabled: false }),
	};
}

/** Resolve a text-based range: explicit word indices, or the n-th match of a phrase. */
function rangeOf(
	words: SeqWord[],
	a: { fromWord?: number; toWord?: number; query?: string; occurrence?: number },
): [number, number] {
	if (a.query !== undefined) {
		const hits = searchWords(words, a.query);
		const n = (a.occurrence ?? 1) - 1;
		const hit = hits[n];
		if (!hit)
			throw new ToolError(
				'E_NOT_FOUND',
				`"${a.query}" ${hits.length ? `occurs ${hits.length} time(s)` : 'does not occur'} in the transcript`,
				'Use transcript_search to list matches.',
			);
		return [hit[0], hit[1] - 1];
	}
	if (a.fromWord === undefined || a.toWord === undefined)
		throw new ToolError(
			'E_INVALID_PARAM',
			'Give fromWord and toWord, or query',
			'Word indices come from transcript_inspect / transcript_search.',
		);
	return [a.fromWord, a.toWord];
}

const TextRangeArgs = {
	fromWord: WordArg('First word').optional(),
	toWord: WordArg('Last word (inclusive)').optional(),
	query: z
		.string()
		.min(1)
		.optional()
		.describe('Instead of indices: a phrase to find (transcript_search rules)'),
	occurrence: z.number().int().min(1).optional().describe('Which match of `query` (default 1)'),
};

export function registerCaptionTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'import_captions',
		{
			title: 'Import captions',
			description:
				'Reads a caption file (SRT, WebVTT, SCC, MCC, EBU STL, TTML/IMSC1, DFXP; detected from the content and extension) onto a caption track: a new one (default, named after the file) or an existing one. Cue times are snapped to the sequence frames; overlaps are cut. WebVTT ids/settings/voices and STYLE blocks are kept for round trips.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				path: z.string().optional().describe('Absolute path of the caption file'),
				content: z.string().optional().describe('Or the file text (not for binary EBU STL)'),
				format: FormatArg.optional().describe('Default: detected'),
				track: z.string().optional().describe('"new" (default) or a caption track ("C1"…)'),
				offset: timeArg("Sequence time of the file's 00:00:00:00 (default 0)").optional(),
				language: z.string().optional().describe('BCP-47 language of the captions ("en", "fr-CA")'),
				name: z.string().optional().describe('Track name (default: the file name)'),
				replace: z.boolean().optional().describe("Remove the track's captions first"),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const input = await readInput(a.path, a.content);
			return run(
				ctx,
				a.projectId,
				'Import Captions',
				[
					{
						type: 'caption.import',
						...input,
						...(a.format ? { format: a.format } : {}),
						...(a.track ? { track: a.track } : {}),
						...(a.offset !== undefined ? { offset: a.offset } : {}),
						...(a.language ? { language: a.language } : {}),
						...(a.name ? { name: a.name } : {}),
						...(a.replace ? { replace: true } : {}),
					},
				],
				extra,
				a.sequenceId,
			);
		},
	);

	defineTool(
		ctx,
		'export_captions',
		{
			title: 'Export captions',
			description:
				'Writes a caption track as SRT, WebVTT, SCC, MCC, EBU STL, TTML (IMSC1, exact frame times) or DFXP, in output time of the chosen range (exactly the captions the preview and burn-in show). With path the file is written there (never overwrites: " (2)" is appended); else text formats are returned inline.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				track: TrackArg.optional().describe('Caption track (default: the active one)'),
				format: FormatArg.optional().describe('Default: from the path extension, else srt'),
				path: z.string().optional().describe('Absolute output path'),
				range: z.strictObject({ from: timeArg('Start'), to: timeArg('End (exclusive)') }).optional(),
				dropFrame: z.boolean().optional().describe('SCC/MCC timecode (default drop-frame)'),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (a) => {
			const { doc, seq } = await sequenceOf(ctx, a.projectId, a.sequenceId);
			const t = captionTrackOf(seq, a.track);
			const fromPath = a.path ? captionFormatFromName(extname(a.path)) : null;
			const format: CaptionFileFormat = a.format ?? fromPath ?? 'srt';
			const range = a.range
				? { start: frameOf(seq, a.range.from), end: frameOf(seq, a.range.to) }
				: undefined;
			if (range && range.end <= range.start)
				throw new ToolError('E_INVALID_PARAM', '`to` must be after `from`');
			const cues = captionCuesForTrack(doc, seq, t.id, range);
			const bytes = writeCaptionFileBytes({ cues, blocks: [...(t.vttBlocks ?? [])], warnings: [] }, format, {
				rate: seq.settings.frameRate,
				dropFrame: a.dropFrame ?? (supportsDropFrame(seq.settings.frameRate) ? seq.settings.dropFrame : true),
				language: t.language ?? 'en',
			});
			if (a.path) {
				let dest = absolutePath(a.path);
				const ext = `.${CAPTION_FORMAT_INFO[format].extension}`;
				if (extname(dest).toLowerCase() !== ext) dest += ext;
				await mkdir(dirname(dest), { recursive: true });
				const stem = basename(dest, ext);
				for (let i = 2; existsSync(dest); i++) dest = join(dirname(dest), `${stem} (${i})${ext}`);
				await writeFile(dest, bytes);
				return jsonResult({ path: dest, format, cues: cues.length, bytes: bytes.length });
			}
			if (CAPTION_FORMAT_INFO[format].binary)
				return jsonResult({
					format,
					cues: cues.length,
					contentBase64: Buffer.from(bytes).toString('base64'),
				});
			return jsonResult({ format, cues: cues.length, content: Buffer.from(bytes).toString('utf8') });
		},
	);

	defineTool(
		ctx,
		'list_captions',
		{
			title: 'List captions',
			description:
				'Caption tracks (label, name, language, standard, visible, locked, active, track style) and their captions with in/out timecodes, text (lines "\\n", pages blank line), speaker and per-caption style overrides.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				track: TrackArg.optional().describe('Only this track'),
			},
			annotations: READ_ONLY,
		},
		async (a) => {
			const { doc, seq } = await sequenceOf(ctx, a.projectId, a.sequenceId);
			const active = activeCaptionTrack(seq);
			const tracks = a.track ? [captionTrackOf(seq, a.track)] : seq.captionTracks;
			const font = Object.values(doc.fonts)[0]?.id ?? '';
			return jsonResult({
				sequenceId: seq.id,
				tracks: tracks.map((t) => ({
					label: trackLabel(seq, t.id),
					trackId: t.id,
					name: t.name,
					language: t.language ?? null,
					standard: t.captionStandard ?? 'subtitle',
					visible: t.visible !== false,
					locked: t.locked,
					syncLock: t.syncLock,
					active: t.id === active?.id,
					style: resolveCaptionStyle(t.styleDefaults, null, font, seq.settings.height),
					captions: captionClipsOf(seq, t.id).map((c) => captionRow(doc, seq, c)),
				})),
			});
		},
	);

	defineTool(
		ctx,
		'add_caption',
		{
			title: 'Add caption',
			description:
				'Adds a caption (Premiere "Add New Caption Segment"): at a time (default 0) for a duration (default 3 s, cut short at the next caption) on a caption track (default the active one; a track is created when there is none).',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				text: z.string().describe('Caption text ("\\n" between lines)'),
				at: timeArg('Start').optional(),
				duration: timeArg('Length').optional(),
				track: TrackArg.optional(),
				speaker: z.string().optional(),
				style: StyleArg.optional().describe('Per-caption style overrides'),
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			run(
				ctx,
				a.projectId,
				'Add Caption',
				[
					{
						type: 'caption.add',
						text: a.text,
						...(a.at !== undefined ? { at: a.at } : {}),
						...(a.duration !== undefined ? { duration: a.duration } : {}),
						...(a.track ? { track: a.track } : {}),
						...(a.speaker ? { speaker: a.speaker } : {}),
						...(a.style ? { style: a.style } : {}),
					},
				],
				extra,
				a.sequenceId,
			),
	);

	defineTool(
		ctx,
		'edit_caption',
		{
			title: 'Edit caption',
			description:
				'Changes one caption: text (unchanged words keep their timing), speaker, in/out (limited by its neighbours) and per-caption style overrides (resetStyle clears them). One undo step.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				text: z.string().optional(),
				speaker: z.string().nullable().optional(),
				start: timeArg('New in point').optional(),
				end: timeArg('New out point').optional(),
				style: StyleArg.optional(),
				resetStyle: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const commands: unknown[] = [];
			if (a.text !== undefined || a.speaker !== undefined)
				commands.push({
					type: 'caption.setText',
					clipId: a.clipId,
					...(a.text !== undefined ? { text: a.text } : {}),
					...(a.speaker !== undefined ? { speaker: a.speaker } : {}),
				});
			if (a.start !== undefined || a.end !== undefined)
				commands.push({
					type: 'caption.setTimes',
					clipId: a.clipId,
					...(a.start !== undefined ? { start: a.start } : {}),
					...(a.end !== undefined ? { end: a.end } : {}),
				});
			if (a.style || a.resetStyle)
				commands.push({
					type: 'caption.setStyle',
					clipIds: [a.clipId],
					...(a.style ? { style: a.style } : {}),
					...(a.resetStyle ? { reset: true } : {}),
				});
			if (!commands.length)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Nothing to change',
					'Give text, speaker, start, end or style.',
				);
			return run(ctx, a.projectId, 'Edit Caption', commands, extra);
		},
	);

	defineTool(
		ctx,
		'split_captions',
		{
			title: 'Split captions',
			description:
				'Splits the captions under a time (default every caption there on unlocked caption tracks); the words go to the side they are spoken in.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				at: timeArg('Split time'),
				clipIds: ClipIdsArg.optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			run(
				ctx,
				a.projectId,
				'Split Caption',
				[{ type: 'caption.split', at: a.at, ...(a.clipIds ? { clipIds: a.clipIds } : {}) }],
				extra,
				a.sequenceId,
			),
	);

	defineTool(
		ctx,
		'merge_captions',
		{
			title: 'Merge captions',
			description:
				'Merges consecutive captions of one track into one (texts joined by line breaks, spanning first in to last out).',
			input: { projectId: ProjectIdArg, clipIds: ClipIdsArg },
			annotations: EDIT,
		},
		async (a, extra) =>
			run(ctx, a.projectId, 'Merge Captions', [{ type: 'caption.merge', clipIds: a.clipIds }], extra),
	);

	defineTool(
		ctx,
		'delete_captions',
		{
			title: 'Delete captions',
			description:
				'Deletes captions; ripple: true closes the gaps on their caption track (later captions move left; other tracks stay). For a sync-locked ripple of the whole sequence use delete_clips with ripple.',
			input: { projectId: ProjectIdArg, clipIds: ClipIdsArg, ripple: z.boolean().optional() },
			annotations: DESTRUCTIVE,
		},
		async (a, extra) =>
			run(
				ctx,
				a.projectId,
				'Delete Captions',
				[{ type: 'caption.delete', clipIds: a.clipIds, ...(a.ripple ? { ripple: true } : {}) }],
				extra,
			),
	);

	defineTool(
		ctx,
		'style_captions',
		{
			title: 'Style captions',
			description:
				'Sets the track style of a caption track (track) or per-caption overrides (clipIds): style fields, a preset (built-in or saved), reset (true or field names). savePresetAs saves the resulting track style as a project preset.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				track: TrackArg.optional(),
				clipIds: ClipIdsArg.optional(),
				style: StyleArg.optional(),
				preset: z
					.string()
					.optional()
					.describe(`Preset id: ${BUILTIN_CAPTION_PRESETS.map((p) => p.id).join(', ')} or a saved one`),
				reset: z.union([z.boolean(), z.array(z.string())]).optional(),
				savePresetAs: z.string().min(1).optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if ((a.track === undefined) === (a.clipIds === undefined))
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give track or clipIds',
					'track: the track style; clipIds: per-caption overrides.',
				);
			const target = a.track ? { trackId: a.track } : { clipIds: a.clipIds };
			const commands: unknown[] = [];
			if (a.preset) commands.push({ type: 'caption.applyPreset', presetId: a.preset, ...target });
			if (a.style || a.reset !== undefined)
				commands.push({
					type: 'caption.setStyle',
					...target,
					...(a.style ? { style: a.style } : {}),
					...(a.reset !== undefined ? { reset: a.reset } : {}),
				});
			if (a.savePresetAs) {
				if (!a.track)
					throw new ToolError('E_INVALID_PARAM', 'savePresetAs saves a track style', 'Give track.');
				commands.push({ type: 'caption.savePreset', name: a.savePresetAs, trackId: a.track });
			}
			if (!commands.length)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Nothing to change',
					'Give style, preset, reset or savePresetAs.',
				);
			return run(ctx, a.projectId, 'Caption Style', commands, extra, a.sequenceId);
		},
	);

	defineTool(
		ctx,
		'caption_track',
		{
			title: 'Caption track',
			description:
				'Adds a caption track (action "add": name, language, standard subtitle|cea-608|cea-708|teletext) or changes one ("update": name, language, standard, visible = burned in / shown, locked, syncLock, active = the track new captions go to and exports embed first).',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				action: z.enum(['add', 'update']),
				track: TrackArg.optional().describe('Track to update'),
				name: z.string().nullable().optional(),
				language: z.string().optional(),
				standard: z.enum(['subtitle', 'cea-608', 'cea-708', 'teletext']).optional(),
				visible: z.boolean().optional(),
				locked: z.boolean().optional(),
				syncLock: z.boolean().optional(),
				active: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if (a.action === 'add')
				return run(
					ctx,
					a.projectId,
					'Add Caption Track',
					[
						{
							type: 'caption.addTrack',
							...(a.name !== undefined ? { name: a.name } : {}),
							...(a.language ? { language: a.language } : {}),
							...(a.standard ? { standard: a.standard } : {}),
							...(a.active !== undefined ? { active: a.active } : {}),
						},
					],
					extra,
					a.sequenceId,
				);
			if (!a.track)
				throw new ToolError(
					'E_INVALID_PARAM',
					'track is required to update',
					'Caption tracks are "C1", "C2"…',
				);
			const patch = {
				...(a.name !== undefined ? { name: a.name } : {}),
				...(a.language !== undefined ? { language: a.language } : {}),
				...(a.standard ? { captionStandard: a.standard } : {}),
				...(a.visible !== undefined ? { visible: a.visible } : {}),
				...(a.locked !== undefined ? { locked: a.locked } : {}),
				...(a.syncLock !== undefined ? { syncLock: a.syncLock } : {}),
			};
			const commands: unknown[] = [];
			if (Object.keys(patch).length) commands.push({ type: 'track.update', trackId: a.track, patch });
			if (a.active) commands.push({ type: 'caption.setActiveTrack', trackId: a.track });
			if (!commands.length) throw new ToolError('E_INVALID_PARAM', 'Nothing to change');
			return run(ctx, a.projectId, 'Caption Track', commands, extra, a.sequenceId);
		},
	);

	// ---------------------------------------------------------------- transcripts

	defineTool(
		ctx,
		'import_transcript',
		{
			title: 'Import transcript',
			description:
				'Attaches a transcript to a media item (or the media of a clip) from JSON (our words in flicks; Whisper / whisper.cpp JSON; @remotion/captions Caption[]; {text,start,end} in seconds) or a caption file (cues split into words timed by character count). timeBase "sequence" (with clipId) maps file times through the clip. The sequence transcript (transcript_inspect) then follows every edit of that media.',
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().optional(),
				clipId: z.string().optional(),
				timeBase: z.enum(['media', 'sequence']).optional(),
				path: z.string().optional().describe('Absolute path of the file'),
				content: z.string().optional(),
				format: z.enum([...CAPTION_FILE_FORMATS, 'json']).optional(),
				language: z.string().optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const input = await readInput(a.path, a.content);
			return run(
				ctx,
				a.projectId,
				'Import Transcript',
				[
					{
						type: 'transcript.import',
						...input,
						...(a.mediaId ? { mediaId: a.mediaId } : {}),
						...(a.clipId ? { clipId: a.clipId } : {}),
						...(a.timeBase ? { timeBase: a.timeBase } : {}),
						...(a.format ? { format: a.format } : {}),
						...(a.language ? { language: a.language } : {}),
					},
				],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'transcript_inspect',
		{
			title: 'Inspect the sequence transcript',
			description:
				'The sequence transcript: words heard through the audio clips (top track first; disabled or reversed clips are silent), with sequence word indices, times, timecodes, speakers and clips; paragraphs (speaker change or a pause ≥ paragraphPauseSeconds); speakers. Use from/to to page through long transcripts.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				from: z.number().int().min(0).optional().describe('First word index (default 0)'),
				to: z.number().int().min(0).optional().describe('Last word index (default from + 499)'),
				paragraphPauseSeconds: z.number().min(0).optional().describe('Default 1.5'),
			},
			annotations: READ_ONLY,
		},
		async (a) => {
			const { doc, seq } = await sequenceOf(ctx, a.projectId, a.sequenceId);
			const words = sequenceWords(doc, seq);
			const from = a.from ?? 0;
			const to = Math.min(words.length - 1, a.to ?? from + 499);
			const paras = paragraphs(words, Math.round((a.paragraphPauseSeconds ?? 1.5) * 705_600_000));
			return jsonResult({
				sequenceId: seq.id,
				wordCount: words.length,
				speakers: [...new Set(words.map((w) => w.speaker).filter((s): s is string => !!s))],
				paragraphs: paras.map(([s, e]) => ({
					fromWord: s,
					toWord: e - 1,
					speaker: words[s]!.speaker,
					text: words
						.slice(s, e)
						.map((w) => w.text)
						.join(' '),
				})),
				words: words.slice(from, to + 1).map((w, k) => wordRow(seq, w, from + k)),
			});
		},
	);

	defineTool(
		ctx,
		'transcript_search',
		{
			title: 'Search the transcript',
			description:
				'Finds a phrase in the sequence transcript (case and punctuation ignored; the last word may be a prefix). Returns word index ranges with times.',
			input: { projectId: ProjectIdArg, sequenceId: SequenceIdArg, query: z.string().min(1) },
			annotations: READ_ONLY,
		},
		async (a) => {
			const { doc, seq } = await sequenceOf(ctx, a.projectId, a.sequenceId);
			const words = sequenceWords(doc, seq);
			return jsonResult({
				query: a.query,
				matches: searchWords(words, a.query).map(([s, e]) => ({
					fromWord: s,
					toWord: e - 1,
					text: words
						.slice(s, e)
						.map((w) => w.text)
						.join(' '),
					start: wordRow(seq, words[s]!, s).start,
					end: wordRow(seq, words[e - 1]!, e - 1).end,
				})),
			});
		},
	);

	const textEdit = (name: string, type: string, title: string, description: string, annotations = EDIT) =>
		defineTool(
			ctx,
			name,
			{
				title,
				description,
				input: { projectId: ProjectIdArg, sequenceId: SequenceIdArg, ...TextRangeArgs },
				annotations,
			},
			async (a, extra) => {
				const { doc, seq } = await sequenceOf(ctx, a.projectId, a.sequenceId);
				const [fromWord, toWord] = rangeOf(sequenceWords(doc, seq), a);
				return run(ctx, a.projectId, title, [{ type, sequenceId: seq.id, fromWord, toWord }], extra, seq.id);
			},
		);
	textEdit(
		'transcript_select',
		'transcript.select',
		'Mark Text Selection',
		'Marks In/Out around transcript words (snapped outward to frames), like selecting text in the Transcript panel.',
	);
	textEdit(
		'transcript_extract',
		'transcript.extract',
		'Extract Text',
		'Removes the frames of transcript words from every unlocked track and closes the gap (ripple; sync-locked caption tracks follow).',
		DESTRUCTIVE,
	);
	textEdit(
		'transcript_lift',
		'transcript.lift',
		'Lift Text',
		'Removes the frames of transcript words from every unlocked track, leaving a gap.',
		DESTRUCTIVE,
	);

	defineTool(
		ctx,
		'insert_transcript_selection',
		{
			title: 'Insert text selection into another sequence',
			description:
				'Copies the picture and sound under transcript words into another sequence (insert by default, at its end unless `at`).',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				...TextRangeArgs,
				targetSequenceId: z.string().min(1),
				at: timeArg('Where in the target sequence').optional(),
				mode: z.enum(['insert', 'overwrite']).optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc, seq } = await sequenceOf(ctx, a.projectId, a.sequenceId);
			const [fromWord, toWord] = rangeOf(sequenceWords(doc, seq), a);
			return run(
				ctx,
				a.projectId,
				'Insert Text Selection',
				[
					{
						type: 'transcript.insertInto',
						sequenceId: seq.id,
						fromWord,
						toWord,
						targetSequenceId: a.targetSequenceId,
						...(a.at !== undefined ? { at: a.at } : {}),
						...(a.mode ? { mode: a.mode } : {}),
					},
				],
				extra,
				seq.id,
			);
		},
	);

	defineTool(
		ctx,
		'remove_fillers',
		{
			title: 'Remove filler words',
			description: `Ripple-deletes filler words in one undo step (default ${DEFAULT_FILLERS.join(', ')}; phrases such as "you know" allowed and matched before single words). Cuts snap to the nearest frames without reaching into neighbouring words. dryRun lists the hits only.`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				fillers: z.array(z.string().min(1)).optional(),
				dryRun: z.boolean().optional(),
			},
			annotations: DESTRUCTIVE,
		},
		async (a, extra) => {
			const { doc, seq } = await sequenceOf(ctx, a.projectId, a.sequenceId);
			if (a.dryRun) {
				const words = sequenceWords(doc, seq);
				const hits = findFillers(words, a.fillers ?? DEFAULT_FILLERS);
				const ranges = mergeRanges(fillerRanges(words, hits, seq.settings.frameRate));
				return jsonResult({
					hits: hits.map(([s, e]) => ({
						fromWord: s,
						toWord: e - 1,
						text: words
							.slice(s, e)
							.map((w) => w.text)
							.join(' '),
						at: wordRow(seq, words[s]!, s).start,
					})),
					frames: ranges.reduce((n, [x, y]) => n + y - x, 0),
				});
			}
			return run(
				ctx,
				a.projectId,
				'Remove Filler Words',
				[
					{
						type: 'transcript.removeFillers',
						sequenceId: seq.id,
						...(a.fillers ? { fillers: a.fillers } : {}),
					},
				],
				extra,
				seq.id,
			);
		},
	);

	defineTool(
		ctx,
		'remove_pauses',
		{
			title: 'Remove pauses',
			description:
				'Ripple-deletes pauses between words at least minSeconds long (default 1), keeping keepSeconds (default 0.1) of air next to each word, in one undo step. dryRun lists them only.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				minSeconds: z.number().min(0.04).optional(),
				keepSeconds: z.number().min(0).optional(),
				dryRun: z.boolean().optional(),
			},
			annotations: DESTRUCTIVE,
		},
		async (a, extra) => {
			const { doc, seq } = await sequenceOf(ctx, a.projectId, a.sequenceId);
			if (a.dryRun) {
				const ranges = findPauses(
					sequenceWords(doc, seq),
					Math.round((a.minSeconds ?? 1) * 705_600_000),
					Math.round((a.keepSeconds ?? 0.1) * 705_600_000),
					seq.settings.frameRate,
				);
				return jsonResult({
					pauses: ranges.map(([x, y]) => ({
						from: { frame: x, timecode: sequenceTimecode(seq, x) },
						to: { frame: y, timecode: sequenceTimecode(seq, y) },
					})),
					frames: ranges.reduce((n, [x, y]) => n + y - x, 0),
				});
			}
			return run(
				ctx,
				a.projectId,
				'Remove Pauses',
				[
					{
						type: 'transcript.removePauses',
						sequenceId: seq.id,
						...(a.minSeconds !== undefined ? { minSeconds: a.minSeconds } : {}),
						...(a.keepSeconds !== undefined ? { keepSeconds: a.keepSeconds } : {}),
					},
				],
				extra,
				seq.id,
			);
		},
	);

	defineTool(
		ctx,
		'rename_speaker',
		{
			title: 'Rename speaker',
			description:
				'Renames a speaker (by name or key) in every transcript, or in one (transcriptId); captions and the Transcript panel follow.',
			input: {
				projectId: ProjectIdArg,
				speaker: z.string().min(1),
				name: z.string().min(1),
				transcriptId: z.string().optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			run(
				ctx,
				a.projectId,
				'Rename Speaker',
				[
					{
						type: 'transcript.renameSpeaker',
						speaker: a.speaker,
						name: a.name,
						...(a.transcriptId ? { transcriptId: a.transcriptId } : {}),
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'captions_from_transcript',
		{
			title: 'Create captions from the transcript',
			description:
				'Lays the sequence transcript (or words fromWord..toWord) out as captions on a new caption track (or `track`): maxChars per line (42), lines (2), minSeconds (1), maxSeconds (7), gapFrames (0), breakPauseSeconds (1). Frame-snapped and never overlapping; short captions extend into the following silence.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				track: z.string().optional().describe('"new" (default) or a caption track'),
				maxChars: z.number().int().min(1).max(200).optional(),
				lines: z.number().int().min(1).max(4).optional(),
				minSeconds: z.number().min(0).optional(),
				maxSeconds: z.number().min(0.1).optional(),
				gapFrames: z.number().int().min(0).optional(),
				breakPauseSeconds: z.number().min(0).optional(),
				fromWord: z.number().int().min(0).optional(),
				toWord: z.number().int().min(0).optional(),
				name: z.string().optional(),
				language: z.string().optional(),
				preset: z.string().optional().describe('Style preset for the new track'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const rules = Object.fromEntries(
				(['maxChars', 'lines', 'minSeconds', 'maxSeconds', 'gapFrames', 'breakPauseSeconds'] as const)
					.filter((k) => a[k] !== undefined)
					.map((k) => [k, a[k]]),
			);
			const commands: unknown[] = [
				{
					type: 'transcript.createCaptions',
					...(a.track ? { track: a.track } : {}),
					...(Object.keys(rules).length ? { rules } : {}),
					...(a.fromWord !== undefined ? { fromWord: a.fromWord } : {}),
					...(a.toWord !== undefined ? { toWord: a.toWord } : {}),
					...(a.name ? { name: a.name } : {}),
					...(a.language ? { language: a.language } : {}),
					ref: '$captions',
				},
			];
			if (a.preset) commands.push({ type: 'caption.applyPreset', presetId: a.preset, trackId: '$captions' });
			const res = await transact(
				ctx,
				a.projectId,
				{ label: 'Create Captions', commands, ...(a.sequenceId ? { sequenceId: a.sequenceId } : {}) },
				extra,
			);
			const ok = requireOk(res);
			return jsonResult(txBody(res, ok));
		},
	);
}
