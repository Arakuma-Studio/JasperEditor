import {
	isNestClip,
	nestContentKey,
	nestReferences,
	SYNTHETIC_INFO,
	SYNTHETIC_KINDS,
	sequenceGaps,
	sequenceTimecode,
	throughEdits,
	trackGaps,
	trackLabel,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, timeArg } from '../arguments.ts';
import {
	applyCommands,
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	loadDoc,
	READ_ONLY,
	type ToolContext,
} from '../context.ts';
import { jsonResult } from '../errors.ts';
import { pickSequence } from '../format.ts';

export const STRUCTURE_GUIDE = `Nests, adjustment layers, groups, synthetics, through edits, frame holds:
- nest_clips turns clips into a nested sequence (Premiere Nest): the clips move into a new sequence (same settings, tracks, links, effects, keyframes, transitions between them) and are replaced by a nest-video clip (+ a linked nest-audio clip when audio moved). unnest_clips puts a nest clip's clips back (100 % speed, no Motion changes). place_sequence places any sequence into another as a nest (default) or as copies of its clips (nest: false); its In/Out choose the range. Nest clips trim, speed up, take effects, Motion and frame holds like any clip; cycles are refused (E_CYCLE). list_nests shows nest clips and which sequences use a sequence.
- add_adjustment_layer adds an adjustment layer: its effects apply to everything on the tracks below (incl. the background) during its range, mixed back with its opacity and blend mode, limited to its crop. Add effects with effects: [{effectId, params}] or apply_commands effect.add.
- group_clips / ungroup_clips: grouped clips select, move and delete together; trimming the group's outer edge trims every member there.
- create_synthetic makes a Project item: bars-and-tone (SMPTE HD bars + 1 kHz at −20 dBFS, 1 s), black-video, color-matte (params.color RGBA 0..1), transparent, adjustment, counting-leader (11 s countdown; params wipeColor, backgroundColor, lineColor, targetColor, numeralColor, cueBlipOnOut, cueBlipOnTwo, cueBlipAllSeconds). Place it with add_clip-style apply_commands clip.place {source: {syntheticId}}; update_synthetic changes it everywhere it is used.
- duplicate_sequence copies a sequence; delete_sequence and remove_unused_media need the user's approval in an open editor.
- list_through_edits / join_through_edits: cuts between pieces that continue the same source (left by split_at / Add Edit). find_gaps lists empty time in the sequence or on tracks. make_subsequence copies clips (or In–Out on tracks) into a new sequence.
- add_frame_hold (Premiere Add Frame Hold: split at a time, the right part holds that frame), insert_frame_hold_segment (a held segment pushed in, 2 s by default), frame_hold_options (hold on in / out / sequence-time / source-time / playhead, holdFilters freezes effects and keyframes too; enabled: false removes it).`;

const ClipIdsArg = z.array(z.string().min(1)).min(1).describe('Clip ids ("clp_…") from get_timeline');
const RgbaArg = z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('RGBA, each 0..1');

async function sequenceOf(ctx: ToolContext, projectId: string, sequenceId?: string) {
	const { doc, revision, live } = await loadDoc(ctx, projectId);
	const seq = pickSequence(doc, sequenceId);
	return { doc, seq, revision, live };
}

export function registerStructureTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'nest_clips',
		{
			title: 'Nest clips',
			description:
				'Premiere Nest (clip.nest): moves the clips into a new sequence (same settings and track layout; relative times, tracks, links, effects, keyframes and the transitions between them kept) and replaces them with a nest-video clip (+ a linked nest-audio clip). Returns the new sequenceId, its project itemId and the nest clip ids.',
			input: {
				projectId: ProjectIdArg,
				clipIds: ClipIdsArg,
				name: z
					.string()
					.min(1)
					.optional()
					.describe('Name of the nested sequence (default "Nested Sequence NN")'),
			},
			annotations: EDIT,
		},
		async ({ projectId, clipIds, name }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Nest',
				[{ type: 'clip.nest', clipIds, ...(name ? { name } : {}) }],
				extra,
			),
	);

	defineTool(
		ctx,
		'unnest_clips',
		{
			title: 'Unnest clips',
			description:
				"Replaces nest clips by the clips they show (clip.unnest), on free tracks from the nest clip's track, links and transitions kept, the nest clip's effects added to each clip. Refused for nest clips with a speed change, reverse, frame hold, Motion/Opacity changes, pan or volume keyframes. The nested sequence stays in the project.",
			input: { projectId: ProjectIdArg, clipIds: ClipIdsArg },
			annotations: EDIT,
		},
		async ({ projectId, clipIds }, extra) =>
			applyCommands(ctx, projectId, 'Unnest', [{ type: 'clip.unnest', clipIds }], extra),
	);

	defineTool(
		ctx,
		'place_sequence',
		{
			title: 'Place a sequence',
			description:
				'Places a sequence into another one (clip.place {source: {sequenceId}}): as linked nest-video / nest-audio clips (nest: true, default — Premiere\'s "Insert and overwrite sequences as nests") or as copies of its clips (nest: false). The source sequence\'s In/Out choose the range unless sourceRange is given. Overwrite or insert at `at`.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg.describe('Target sequence (default: the first sequence)'),
				sourceSequenceId: z.string().min(1).describe('The sequence to place'),
				at: timeArg('Where it starts in the target sequence'),
				mode: z.enum(['overwrite', 'insert']).optional(),
				nest: z.boolean().optional().describe('true (default): nest clips; false: its individual clips'),
				videoTrack: z.string().optional().describe('Video track ("V1"…); default V1'),
				audioTrack: z.string().optional().describe('Audio track ("A1"…); default the matching A track'),
				sourceRange: z
					.object({
						in: z.object({ seconds: z.number().min(0) }),
						out: z.object({ seconds: z.number().min(0) }),
					})
					.optional()
					.describe('Part of the source sequence in seconds of its own time'),
			},
			annotations: EDIT,
		},
		async (
			{ projectId, sequenceId, sourceSequenceId, at, mode, nest, videoTrack, audioTrack, sourceRange },
			extra,
		) => {
			const { seq } = await sequenceOf(ctx, projectId, sequenceId);
			return applyCommands(
				ctx,
				projectId,
				'Place Sequence',
				[
					{
						type: 'clip.place',
						sequenceId: seq.id,
						source: { sequenceId: sourceSequenceId },
						at,
						...(mode ? { mode } : {}),
						...(nest !== undefined ? { nest } : {}),
						...(videoTrack || audioTrack
							? {
									tracks: {
										...(videoTrack ? { video: videoTrack } : {}),
										...(audioTrack ? { audio: audioTrack } : {}),
									},
								}
							: {}),
						...(sourceRange ? { sourceRange } : {}),
					},
				],
				extra,
				seq.id,
			);
		},
	);

	defineTool(
		ctx,
		'list_nests',
		{
			title: 'List nests',
			description:
				'The nest clips of a sequence (clip id, kind, track, range, nested sequence id and name, contentKey = a hash of everything the nested sequence renders) and the sequences that use this sequence as a nest.',
			input: { projectId: ProjectIdArg, sequenceId: SequenceIdArg },
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId }) => {
			const { doc, seq } = await sequenceOf(ctx, projectId, sequenceId);
			const name = (id: string) =>
				Object.values(doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === id)?.name ?? null;
			const nests = Object.values(seq.clips)
				.filter(isNestClip)
				.sort((a, b) => a.start - b.start)
				.map((c) => {
					const sid = (c as { sequenceId: string }).sequenceId;
					return {
						clipId: c.id,
						kind: c.kind,
						track: trackLabel(seq, c.trackId),
						start: c.start,
						end: c.start + c.duration,
						startTimecode: sequenceTimecode(seq, c.start),
						speed: c.speed.rate,
						nestedSequenceId: sid,
						nestedName: name(sid),
						contentKey: doc.sequences[sid] ? nestContentKey(doc, sid) : null,
					};
				});
			return jsonResult({ sequenceId: seq.id, nests, usedBy: nestReferences(doc, seq.id) });
		},
	);

	defineTool(
		ctx,
		'add_adjustment_layer',
		{
			title: 'Add adjustment layer',
			description:
				'Adds an adjustment layer (clip.addAdjustment) on a video track: its effects apply to the composite of every track below during its range (Premiere Adjustment Layer), mixed with its opacity / blend mode and limited to its crop. Optional effects are added in order.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				at: timeArg('Start'),
				duration: timeArg('Length'),
				track: z.string().min(1).describe('Video track ("V2"…), above the tracks it adjusts'),
				name: z.string().min(1).optional(),
				effects: z
					.array(
						z.object({ effectId: z.string().min(1), params: z.record(z.string(), z.unknown()).optional() }),
					)
					.optional()
					.describe('Effects to add (list_effects for ids)'),
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, at, duration, track, name, effects }, extra) => {
			const { seq } = await sequenceOf(ctx, projectId, sequenceId);
			return applyCommands(
				ctx,
				projectId,
				'New Adjustment Layer',
				[
					{
						type: 'clip.addAdjustment',
						sequenceId: seq.id,
						at,
						duration,
						track,
						...(name ? { name } : {}),
						ref: '$adj',
					},
					...(effects ?? []).map((e) => ({
						type: 'effect.add',
						target: { clipId: '$adj' },
						effectId: e.effectId,
						...(e.params ? { params: e.params } : {}),
					})),
				],
				extra,
				seq.id,
			);
		},
	);

	defineTool(
		ctx,
		'group_clips',
		{
			title: 'Group clips',
			description:
				"Groups clips (clip.group, Premiere Ctrl+G): they select, move and delete together; trimming the group's first In or last Out trims every member at that edge. Grouping clips of existing groups merges them.",
			input: { projectId: ProjectIdArg, clipIds: z.array(z.string().min(1)).min(2) },
			annotations: EDIT,
		},
		async ({ projectId, clipIds }, extra) =>
			applyCommands(ctx, projectId, 'Group', [{ type: 'clip.group', clipIds }], extra),
	);

	defineTool(
		ctx,
		'ungroup_clips',
		{
			title: 'Ungroup clips',
			description: 'Dissolves the groups of the given clips (clip.ungroup).',
			input: { projectId: ProjectIdArg, clipIds: ClipIdsArg },
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipIds }, extra) =>
			applyCommands(ctx, projectId, 'Ungroup', [{ type: 'clip.ungroup', clipIds }], extra),
	);

	defineTool(
		ctx,
		'duplicate_sequence',
		{
			title: 'Duplicate sequence',
			description:
				'Copies a sequence (new ids everywhere, media shared) next to it in its bin. Returns the new sequenceId and itemId.',
			input: { projectId: ProjectIdArg, sequenceId: z.string().min(1), name: z.string().min(1).optional() },
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, name }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Duplicate Sequence',
				[{ type: 'sequence.duplicate', sequenceId, ...(name ? { name } : {}) }],
				extra,
			),
	);

	defineTool(
		ctx,
		'delete_sequence',
		{
			title: 'Delete sequence',
			description:
				"Deletes a sequence and its project item (sequence.delete). Needs the user's approval in an open editor. A sequence nested elsewhere is refused (E_IN_USE) unless force: true, which also removes those nest clips.",
			input: { projectId: ProjectIdArg, sequenceId: z.string().min(1), force: z.boolean().optional() },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ projectId, sequenceId, force }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Delete Sequence',
				[{ type: 'sequence.delete', sequenceId, ...(force ? { force: true } : {}) }],
				extra,
			),
	);

	defineTool(
		ctx,
		'remove_unused_media',
		{
			title: 'Remove unused media',
			description:
				"Premiere Remove Unused (media.removeUnused): removes media and synthetic items no clip, effect, transcript or processed version uses. Needs the user's approval in an open editor. kinds limits it to media kinds (synthetics are then kept).",
			input: {
				projectId: ProjectIdArg,
				kinds: z
					.array(
						z.enum(['video', 'audio', 'image', 'animated-image', 'font', 'lut', 'mg-bundle', 'color-config']),
					)
					.optional(),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ projectId, kinds }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Remove Unused',
				[{ type: 'media.removeUnused', ...(kinds ? { kinds } : {}) }],
				extra,
			),
	);

	defineTool(
		ctx,
		'create_synthetic',
		{
			title: 'Create synthetic item',
			description: `Premiere New Item (synthetic.create): ${SYNTHETIC_KINDS.map((k) => `${k} (${SYNTHETIC_INFO[k].label})`).join(', ')}. Returns the syntheticId and itemId; place it with apply_commands clip.place {source: {syntheticId}} (Bars and Tone and the leader bring a linked tone/blip audio clip).`,
			input: {
				projectId: ProjectIdArg,
				kind: z.enum(SYNTHETIC_KINDS as [string, ...string[]]),
				name: z.string().min(1).optional(),
				binId: z.string().min(1).optional(),
				params: z
					.object({
						color: RgbaArg.optional(),
						toneHz: z.number().optional(),
						toneDb: z.number().optional(),
						wipeColor: RgbaArg.optional(),
						backgroundColor: RgbaArg.optional(),
						lineColor: RgbaArg.optional(),
						targetColor: RgbaArg.optional(),
						numeralColor: RgbaArg.optional(),
						cueBlipOnOut: z.boolean().optional(),
						cueBlipOnTwo: z.boolean().optional(),
						cueBlipAllSeconds: z.boolean().optional(),
					})
					.optional()
					.describe(
						'color-matte: color; bars-and-tone: toneHz, toneDb; counting-leader: colours and cue options',
					),
			},
			annotations: EDIT,
		},
		async ({ projectId, kind, name, binId, params }, extra) =>
			applyCommands(
				ctx,
				projectId,
				`New ${SYNTHETIC_INFO[kind as keyof typeof SYNTHETIC_INFO].label}`,
				[
					{
						type: 'synthetic.create',
						kind,
						...(name ? { name } : {}),
						...(binId ? { binId } : {}),
						...(params ? { params } : {}),
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'update_synthetic',
		{
			title: 'Update synthetic item',
			description:
				"Changes a synthetic source's params (synthetic.update); every clip using it changes (Premiere).",
			input: {
				projectId: ProjectIdArg,
				syntheticId: z.string().min(1),
				params: z.record(z.string(), z.unknown()),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, syntheticId, params }, extra) =>
			applyCommands(ctx, projectId, 'Edit Item', [{ type: 'synthetic.update', syntheticId, params }], extra),
	);

	defineTool(
		ctx,
		'list_through_edits',
		{
			title: 'List through edits',
			description:
				'Cuts between two pieces of the same source that continue each other (left by split_at / Add Edit): track, frame, timecode, left and right clip ids.',
			input: { projectId: ProjectIdArg, sequenceId: SequenceIdArg },
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId }) => {
			const { seq } = await sequenceOf(ctx, projectId, sequenceId);
			return jsonResult({
				sequenceId: seq.id,
				throughEdits: throughEdits(seq).map((t) => ({
					track: trackLabel(seq, t.trackId),
					frame: t.frame,
					timecode: sequenceTimecode(seq, t.frame),
					leftClipId: t.leftId,
					rightClipId: t.rightId,
				})),
			});
		},
	);

	defineTool(
		ctx,
		'join_through_edits',
		{
			title: 'Join through edits',
			description:
				'Heals through edits (sequence.joinThroughEdits) on unlocked tracks: all of them, or only those touching clipIds. The left piece absorbs the right one and keeps its effects and attributes.',
			input: { projectId: ProjectIdArg, sequenceId: SequenceIdArg, clipIds: ClipIdsArg.optional() },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ projectId, sequenceId, clipIds }, extra) => {
			const { seq } = await sequenceOf(ctx, projectId, sequenceId);
			return applyCommands(
				ctx,
				projectId,
				'Join Through Edits',
				[{ type: 'sequence.joinThroughEdits', sequenceId: seq.id, ...(clipIds ? { clipIds } : {}) }],
				extra,
				seq.id,
			);
		},
	);

	defineTool(
		ctx,
		'find_gaps',
		{
			title: 'Find gaps',
			description:
				'Gaps (empty time followed by material, Premiere Go to Gap): of the whole sequence (no video or audio track has material) or per track. Close one with apply_commands gap.close.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				tracks: z.array(z.string()).optional().describe('Track labels ("V1", "A2") for per-track gaps'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, tracks }) => {
			const { seq } = await sequenceOf(ctx, projectId, sequenceId);
			const fmt = (g: { start: number; end: number }) => ({
				start: g.start,
				end: g.end,
				startTimecode: sequenceTimecode(seq, g.start),
				frames: g.end - g.start,
			});
			if (!tracks) return jsonResult({ sequenceId: seq.id, gaps: sequenceGaps(seq).map(fmt) });
			const byLabel = new Map(
				[...seq.videoTracks, ...seq.audioTracks].map((t) => [trackLabel(seq, t.id) ?? t.id, t.id]),
			);
			return jsonResult({
				sequenceId: seq.id,
				tracks: tracks.map((l) => {
					const id = byLabel.get(l) ?? l;
					return { track: l, gaps: trackGaps(seq, id).map(fmt) };
				}),
			});
		},
	);

	defineTool(
		ctx,
		'make_subsequence',
		{
			title: 'Make subsequence',
			description:
				'Premiere Make Subsequence: a new sequence with copies of the clips (or of everything on the tracks) trimmed to [from, to) (default: the sequence In/Out when set). The original is unchanged. Returns the new sequenceId and itemId.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipIds: ClipIdsArg.optional(),
				tracks: z.array(z.string()).optional(),
				from: timeArg('Range start').optional(),
				to: timeArg('Range end (exclusive)').optional(),
				name: z.string().min(1).optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, clipIds, tracks, from, to, name }, extra) => {
			const { seq } = await sequenceOf(ctx, projectId, sequenceId);
			return applyCommands(
				ctx,
				projectId,
				'Make Subsequence',
				[
					{
						type: 'sequence.makeSubsequence',
						sequenceId: seq.id,
						...(clipIds ? { clipIds } : {}),
						...(tracks ? { tracks } : {}),
						...(from !== undefined ? { from } : {}),
						...(to !== undefined ? { to } : {}),
						...(name ? { name } : {}),
					},
				],
				extra,
				seq.id,
			);
		},
	);

	defineTool(
		ctx,
		'add_frame_hold',
		{
			title: 'Add frame hold',
			description:
				'Premiere Add Frame Hold: splits each clip under `at` (the given clips, else the topmost video clip there) and makes its right part hold the frame shown at `at` to its end.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				at: timeArg('The frame to hold'),
				clipIds: ClipIdsArg.optional(),
				tracks: z.array(z.string()).optional().describe('Video tracks to hold on (instead of clipIds)'),
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, at, clipIds, tracks }, extra) => {
			const { seq } = await sequenceOf(ctx, projectId, sequenceId);
			return applyCommands(
				ctx,
				projectId,
				'Add Frame Hold',
				[
					{
						type: 'clip.addFrameHold',
						sequenceId: seq.id,
						at,
						...(clipIds ? { clipIds } : {}),
						...(tracks ? { tracks } : {}),
					},
				],
				extra,
				seq.id,
			);
		},
	);

	defineTool(
		ctx,
		'insert_frame_hold_segment',
		{
			title: 'Insert frame hold segment',
			description:
				'Premiere Insert Frame Hold Segment: splits the clip at `at` and inserts a segment holding that frame (default 2 seconds); later material on its track and sync-locked tracks moves right.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				at: timeArg('The frame to hold'),
				duration: timeArg('Segment length (default 2 s)').optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, clipId, at, duration }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Insert Frame Hold Segment',
				[
					{
						type: 'clip.insertFrameHoldSegment',
						clipId,
						at,
						...(duration !== undefined ? { duration } : {}),
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'frame_hold_options',
		{
			title: 'Frame hold options',
			description:
				'Premiere Frame Hold Options: hold each clip on its In point (in), Out point (out), the frame shown at a sequence time (sequence-time / playhead, with at) or a source time (source-time, with sourceTime seconds); holdFilters freezes effects and keyframes too. enabled: false removes the hold.',
			input: {
				projectId: ProjectIdArg,
				clipIds: ClipIdsArg,
				enabled: z.boolean().optional(),
				holdOn: z.enum(['in', 'out', 'sequence-time', 'playhead', 'source-time']).optional(),
				at: timeArg('Sequence time for sequence-time / playhead').optional(),
				sourceTime: z.number().min(0).optional().describe('Source time in seconds for source-time'),
				holdFilters: z.boolean().optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipIds, enabled, holdOn, at, sourceTime, holdFilters }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Frame Hold Options',
				[
					{
						type: 'clip.frameHoldOptions',
						clipIds,
						...(enabled !== undefined ? { enabled } : {}),
						...(holdOn ? { holdOn } : {}),
						...(at !== undefined ? { at } : {}),
						...(sourceTime !== undefined ? { sourceTime: { seconds: sourceTime } } : {}),
						...(holdFilters !== undefined ? { holdFilters } : {}),
					},
				],
				extra,
			),
	);
}
