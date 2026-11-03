import {
	FLICKS_PER_SECOND,
	matchFrame,
	nearestEditPoints,
	resolveFrameInput,
	reverseMatchFrame,
	type Sequence,
	sequenceTimecode,
	trackLabel,
	trimSides,
} from '@jasper/project';
import { z } from 'zod';
import { normalizeTimeArg, ProjectIdArg, SequenceIdArg, TIME_HINT, timeArg } from '../arguments.ts';
import {
	applyCommands,
	defineTool,
	EDIT,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';

export const EDIT_UX_GUIDE = `Three/four-point editing, trimming, match frame, subclips:
- source_edit edits a source (media/subclip/synthetic/sequence item, media id or sequence id) into a sequence like Premiere's Insert (,) / Overwrite (.): any three of sourceIn/sourceOut/sequenceIn/sequenceOut define it (absent = the item's / sequence's marks; null = ignore a mark). The sequence In wins over \`at\` (the playhead); with only a sequence Out the edit is backtimed (ends there). Four points with different durations need fit: change-speed (fit to fill), ignore-source-in, ignore-source-out, ignore-sequence-in or ignore-sequence-out. split gives video and audio their own source ranges (J/L cuts); patch sends source V1/A1… to tracks or null (off). Sequences go in as one nest (default) or as clips.
- find_edit_points lists the edit points nearest a time per track (Premiere Select Nearest Edit Point as Ripple In/Out, Roll, Trim In/Out); trim_edit_points moves them by frames as ONE edit: regular trims leave gaps, ripple trims shift later material (sync-locked tracks follow; a linked sound that leads its picture — a J cut — moves with it), rolls move the cut between two clips. The most restrictive limit (media handles, neighbours, sync locks) wins for every point; clampToSyncLock stops at the limit instead of refusing.
- match_frame returns the source and source time shown at a sequence frame (through nests and multi-camera angles; subclips match to the subclip); reverse_match_frame finds the sequence frame that uses a source time.
- make_subclip creates a subclip item (a named range of a media item; restrictTrims keeps clips placed from it inside the range); edit_subclip changes it; set_split_marks sets Mark Split video/audio In/Out on a media or subclip item (used by source_edit).`;

const SourceTimeArg = z
	.union([
		z.object({ seconds: z.number().min(0) }),
		z.object({ sourceFrames: z.number().int().min(0) }),
		z.object({ flicks: z.number().int().min(0) }),
	])
	.describe('Source content time: {seconds}, {sourceFrames} at the source rate, or {flicks}');
const FitArg = z
	.enum([
		'change-speed',
		'ignore-source-in',
		'ignore-source-out',
		'ignore-sequence-in',
		'ignore-sequence-out',
	])
	.describe("Premiere's Fit Clip choice when four points disagree");

function frameOf(seq: Sequence, input: unknown): number {
	try {
		return resolveFrameInput(seq, normalizeTimeArg(input));
	} catch (e) {
		throw new ToolError('E_INVALID_PARAM', (e as Error).message, TIME_HINT);
	}
}

export function registerEditUxTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'match_frame',
		{
			title: 'Match frame',
			description:
				"Premiere Match Frame (F): the source clip and source time shown at a sequence frame — topmost clip on `tracks` (all tracks when absent; video top-down, then audio), through nested sequences and multi-camera angles. `clipId` prefers that clip (a selected clip). Returns the project item (subclip, media or synthetic), the source time in seconds and frames, and the clip's source In/Out.",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				at: timeArg('Sequence frame to match'),
				tracks: z.array(z.string().min(1)).optional().describe('Track labels or ids to look at ("V1", "A1")'),
				clipId: z.string().min(1).optional().describe('Prefer this clip when it is under `at`'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, at, tracks, clipId }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const trackIds = (tracks ?? []).map((ref) => {
				const t = [...seq.videoTracks, ...seq.audioTracks].find(
					(x) => x.id === ref || trackLabel(seq, x.id)?.toUpperCase() === ref.toUpperCase(),
				);
				if (!t)
					throw new ToolError('E_NOT_FOUND', `Track not found: ${ref}`, 'Use labels like "V1" or "A1".');
				return t.id;
			});
			const frame = frameOf(seq, at);
			const m = matchFrame(doc, seq.id, frame, { trackIds, ...(clipId ? { clipId } : {}) });
			if (!m) return jsonResult({ found: false, frame, timecode: sequenceTimecode(seq, frame) });
			const asset = m.mediaId ? doc.media[m.mediaId] : undefined;
			const vs = asset?.probe.streams.find((s) => s.type === 'video');
			const fps = vs?.type === 'video' ? vs.frameRate.num / vs.frameRate.den : null;
			const sec = (fl: number) => Math.round((fl / FLICKS_PER_SECOND) * 1e6) / 1e6;
			return jsonResult({
				found: true,
				frame,
				timecode: sequenceTimecode(seq, frame),
				clipId: m.clipId,
				inSequenceId: m.sequenceId,
				itemId: m.itemId,
				itemName: m.itemId ? doc.items[m.itemId]?.name : null,
				mediaId: m.mediaId,
				sourceSeconds: sec(m.sourceTime),
				...(fps ? { sourceFrame: Math.round((m.sourceTime / FLICKS_PER_SECOND) * fps) } : {}),
				clipSourceIn: sec(m.sourceIn),
				clipSourceOut: sec(m.sourceOut),
			});
		},
	);

	defineTool(
		ctx,
		'reverse_match_frame',
		{
			title: 'Reverse match frame',
			description:
				'Premiere Reverse Match Frame (Shift+R): the first sequence frame showing a source time of a project item (media, subclip or synthetic) or media id, through nests. Clips on `tracks` (and, for a subclip, clips placed from it) are preferred.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				itemId: z.string().min(1).optional().describe('Project item id ("itm_…")'),
				mediaId: z.string().min(1).optional().describe('Media id ("med_…") instead of itemId'),
				sourceTime: SourceTimeArg,
				tracks: z.array(z.string().min(1)).optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, itemId, mediaId, sourceTime, tracks }) => {
			if (!itemId && !mediaId) throw new ToolError('E_INVALID_PARAM', 'Pass itemId or mediaId');
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const item = itemId ? doc.items[itemId] : undefined;
			const mid = mediaId ?? (item && 'mediaId' in item ? (item as { mediaId: string }).mediaId : undefined);
			const asset = mid ? doc.media[mid] : undefined;
			const vs = asset?.probe.streams.find((s) => s.type === 'video');
			const fps = vs?.type === 'video' ? vs.frameRate.num / vs.frameRate.den : 30;
			const t =
				'seconds' in sourceTime
					? sourceTime.seconds * FLICKS_PER_SECOND
					: 'flicks' in sourceTime
						? sourceTime.flicks
						: (sourceTime.sourceFrames / fps) * FLICKS_PER_SECOND;
			const trackIds = (tracks ?? [])
				.map(
					(ref) =>
						[...seq.videoTracks, ...seq.audioTracks].find(
							(x) => x.id === ref || trackLabel(seq, x.id)?.toUpperCase() === ref.toUpperCase(),
						)?.id,
				)
				.filter((x): x is string => !!x);
			const r = reverseMatchFrame(
				doc,
				seq.id,
				{ ...(itemId ? { itemId } : {}), ...(mediaId ? { mediaId } : {}), time: t },
				{ trackIds },
			);
			return jsonResult(
				r
					? { found: true, frame: r.frame, timecode: sequenceTimecode(seq, r.frame), clipId: r.clipId }
					: { found: false },
			);
		},
	);

	defineTool(
		ctx,
		'source_edit',
		{
			title: 'Insert / overwrite from a source (3- and 4-point editing)',
			description:
				"Premiere Insert (,) / Overwrite (.) with three- and four-point editing (clip.sourceEdit). Any three of sourceIn/sourceOut/sequenceIn/sequenceOut (absent = the item's or sequence's marks, null = ignore a mark); the sequence In wins over `at`; a sequence Out alone backtimes. Four points of different durations need `fit`. `split` gives video and audio their own source ranges (J/L cuts). `patch` maps source tracks to sequence tracks (null = off). Returns the new clip ids, where the edit landed and its speed.",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				itemId: z
					.string()
					.min(1)
					.optional()
					.describe('Project item to edit in (media, subclip, synthetic or sequence)'),
				mediaId: z.string().min(1).optional(),
				sourceSequenceId: z.string().min(1).optional().describe('A sequence as the source'),
				mode: z.enum(['overwrite', 'insert']).optional().describe('Default overwrite'),
				sourceIn: SourceTimeArg.nullable().optional(),
				sourceOut: SourceTimeArg.nullable().optional().describe('Exclusive'),
				sequenceIn: timeArg('Sequence In').nullable().optional(),
				sequenceOut: timeArg('Sequence Out (exclusive)').nullable().optional(),
				at: timeArg('The playhead: where the edit goes when no sequence mark is set').optional(),
				fit: FitArg.optional(),
				split: z
					.object({
						video: z.object({ in: SourceTimeArg.optional(), out: SourceTimeArg.optional() }).optional(),
						audio: z.object({ in: SourceTimeArg.optional(), out: SourceTimeArg.optional() }).optional(),
					})
					.optional(),
				patch: z
					.object({
						video: z.array(z.string().nullable()).optional(),
						audio: z.array(z.string().nullable()).optional(),
					})
					.optional()
					.describe('Destination per source track, e.g. {"video": ["V2"], "audio": ["A3", null]}'),
				sequenceAs: z.enum(['nest', 'clips']).optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const sources = [a.itemId, a.mediaId, a.sourceSequenceId].filter(Boolean);
			if (sources.length !== 1)
				throw new ToolError('E_INVALID_PARAM', 'Pass exactly one of itemId, mediaId, sourceSequenceId');
			const cmd = {
				type: 'clip.sourceEdit',
				...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
				source: a.itemId
					? { projectItemId: a.itemId }
					: a.mediaId
						? { mediaId: a.mediaId }
						: { sequenceId: a.sourceSequenceId },
				...(a.mode ? { mode: a.mode } : {}),
				...(a.sourceIn !== undefined ? { sourceIn: a.sourceIn } : {}),
				...(a.sourceOut !== undefined ? { sourceOut: a.sourceOut } : {}),
				...(a.sequenceIn !== undefined ? { sequenceIn: a.sequenceIn } : {}),
				...(a.sequenceOut !== undefined ? { sequenceOut: a.sequenceOut } : {}),
				...(a.at !== undefined ? { playhead: a.at } : {}),
				...(a.fit ? { fit: a.fit } : {}),
				...(a.split ? { split: a.split } : {}),
				...(a.patch ? { patch: a.patch } : {}),
				...(a.sequenceAs ? { sequenceAs: a.sequenceAs } : {}),
			};
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: a.mode === 'insert' ? 'Insert' : 'Overwrite',
					commands: [cmd],
					...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
				},
				extra,
			);
			const r = requireOk(res);
			return jsonResult({ ...txBody(res, r), edit: r.results[0] });
		},
	);

	defineTool(
		ctx,
		'find_edit_points',
		{
			title: 'Find edit points',
			description:
				'Premiere Select Nearest Edit Point as Ripple In / Ripple Out / Roll / Trim In / Trim Out: per track (or `tracks`) the edit point nearest `at`, ready for trim_edit_points. Each point names its clip, edge, trim mode, frame, and the outgoing/incoming clips around it.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				at: timeArg('Time to search around'),
				kind: z
					.enum(['rippleIn', 'rippleOut', 'roll', 'trimIn', 'trimOut'])
					.optional()
					.describe('Default roll'),
				tracks: z.array(z.string().min(1)).optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, at, kind, tracks }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const trackIds = (tracks ?? [])
				.map(
					(ref) =>
						[...seq.videoTracks, ...seq.audioTracks].find(
							(x) => x.id === ref || trackLabel(seq, x.id)?.toUpperCase() === ref.toUpperCase(),
						)?.id,
				)
				.filter((x): x is string => !!x);
			const pts = nearestEditPoints(seq, frameOf(seq, at), kind ?? 'roll', trackIds);
			return jsonResult({
				editPoints: pts.map((p) => {
					const c = seq.clips[p.clipId]!;
					const frame = p.edge === 'out' ? c.start + c.duration : c.start;
					return {
						...p,
						track: trackLabel(seq, c.trackId),
						frame,
						timecode: sequenceTimecode(seq, frame),
						...trimSides(seq, p),
					};
				}),
			});
		},
	);

	defineTool(
		ctx,
		'trim_edit_points',
		{
			title: 'Trim edit points',
			description: 'Trim several edit points by `frames` as one edit.',
			details:
				'Trims edit points by `frames` as one edit (clip.trimEdits; Premiere trim mode / Trim Forward and Backward): each point is {clipId, edge: in|out, mode: regular|ripple|roll}, at most one per track. Regular trims move one edge (gaps open or close), ripple trims shift later material and sync-locked tracks (split edits stay in sync), rolls move the cut between two adjacent clips. Linked partners at the same edge follow unless linked: false. All points move by the same, most restrictive amount; clampToSyncLock stops at what sync locks allow instead of refusing. Returns the applied frames.',
			input: {
				projectId: ProjectIdArg,
				edits: z
					.array(
						z.object({
							clipId: z.string().min(1),
							edge: z.enum(['in', 'out']),
							mode: z.enum(['regular', 'ripple', 'roll']),
						}),
					)
					.min(1),
				frames: z.number().int().describe('Movement of every edit point, positive = later'),
				linked: z.boolean().optional(),
				clampToSyncLock: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, edits, frames, linked, clampToSyncLock }, extra) => {
			const res = await transact(
				ctx,
				projectId,
				{
					label:
						edits[0]!.mode === 'roll' ? 'Rolling Edit' : edits[0]!.mode === 'ripple' ? 'Ripple Trim' : 'Trim',
					commands: [
						{
							type: 'clip.trimEdits',
							edits,
							deltaFrames: frames,
							...(linked !== undefined ? { linked } : {}),
							...(clampToSyncLock ? { clampToSyncLock } : {}),
						},
					],
				},
				extra,
			);
			const r = requireOk(res);
			return jsonResult({
				...txBody(res, r),
				appliedFrames: (r.results[0] as { deltaFrames: number }).deltaFrames,
			});
		},
	);

	defineTool(
		ctx,
		'make_subclip',
		{
			title: 'Make subclip',
			description:
				'Premiere Make Subclip (item.makeSubclip): a new project item for a range of a media item (or of a subclip, keeping its media). restrictTrims (Restrict Trims To Subclip Boundaries) keeps clips placed from it inside the range. Use it like any item: source_edit {itemId}, apply_commands clip.place {source: {projectItemId}}.',
			input: {
				projectId: ProjectIdArg,
				itemId: z.string().min(1).describe('Media item or subclip ("itm_…")'),
				in: SourceTimeArg,
				out: SourceTimeArg.describe('Exclusive'),
				name: z.string().min(1).optional(),
				restrictTrims: z.boolean().optional(),
				binId: z.string().min(1).optional().describe("Bin for the subclip (default: the source item's bin)"),
			},
			annotations: EDIT,
		},
		async ({ projectId, itemId, in: inT, out, name, restrictTrims, binId }, extra) => {
			const res = await transact(
				ctx,
				projectId,
				{
					label: 'Make Subclip',
					commands: [
						{
							type: 'item.makeSubclip',
							itemId,
							in: inT,
							out,
							...(name ? { name } : {}),
							...(restrictTrims !== undefined ? { restrictTrims } : {}),
							...(binId ? { binId } : {}),
						},
					],
				},
				extra,
			);
			const r = requireOk(res);
			return jsonResult({ ...txBody(res, r), ...(r.results[0] as object) });
		},
	);

	defineTool(
		ctx,
		'edit_subclip',
		{
			title: 'Edit subclip',
			description:
				"Premiere Edit Subclip (item.updateSubclip): change a subclip's range or Restrict Trims. Refused while trims are restricted and a placed clip would fall outside the new range.",
			input: {
				projectId: ProjectIdArg,
				itemId: z.string().min(1),
				in: SourceTimeArg.optional(),
				out: SourceTimeArg.optional(),
				restrictTrims: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, itemId, in: inT, out, restrictTrims }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Edit Subclip',
				[
					{
						type: 'item.updateSubclip',
						itemId,
						...(inT ? { in: inT } : {}),
						...(out ? { out } : {}),
						...(restrictTrims !== undefined ? { restrictTrims } : {}),
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'set_split_marks',
		{
			title: 'Set split marks',
			description:
				"Premiere Mark Split: separate video and audio In/Out marks on a media or subclip item (item.setMarks split), used by source_edit for J and L cuts. A field set to null clears it; clear: true removes all four. The item's ordinary In/Out stay as they are.",
			input: {
				projectId: ProjectIdArg,
				itemId: z.string().min(1),
				videoIn: SourceTimeArg.nullable().optional(),
				videoOut: SourceTimeArg.nullable().optional(),
				audioIn: SourceTimeArg.nullable().optional(),
				audioOut: SourceTimeArg.nullable().optional(),
				clear: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, itemId, videoIn, videoOut, audioIn, audioOut, clear }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const it = doc.items[itemId];
			if (!it || (it.kind !== 'media' && it.kind !== 'subclip'))
				throw new ToolError(
					'E_NOT_FOUND',
					`Media or subclip item not found: ${itemId}`,
					'Call list_media or get_project.',
				);
			const split = clear
				? null
				: {
						...(videoIn !== undefined ? { videoIn } : {}),
						...(videoOut !== undefined ? { videoOut } : {}),
						...(audioIn !== undefined ? { audioIn } : {}),
						...(audioOut !== undefined ? { audioOut } : {}),
					};
			return applyCommands(
				ctx,
				projectId,
				'Mark Split',
				[{ type: 'item.setMarks', itemId, in: it.marks.in, out: it.marks.out, split }],
				extra,
			);
		},
	);
}
