import { buildClipsPayload, buildItemsPayload, EditModeSchema, TrackRefSchema } from '@jasper/project';
import { z } from 'zod';
import {
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
import { applyHelper, timeArg } from './editing.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions. */
export const CLIPBOARD_GUIDE = `Copy and paste (between sequences and projects):
- copy_clips returns a clipboard payload for clips: their linked audio/video partners, the transitions between them, and the media, fonts, synthetics and transcripts they use come along. paste_clips pastes it at a time with the lowest copied video/audio track on the tracks you name (overwrite, or insert to ripple later clips); media resolve by fingerprint in the target project or are added to it. Every pasted entity gets a new id.
- The same payload works in apply_commands: clip.pasteAttributes {payload, clipIds, attributes: {motion, opacity, volume, panner, effects: "all" | [payload effect ids], textAnimationIn, textAnimationOut, textStyle, shapeStyle}, scaleTimes} copies attributes onto other clips; effect.paste {payload, clipIds} appends the copied effects; clip.removeAttributes {clipIds, attributes: {motion, opacity, volume, panner, effects: [registry ids], textAnimationIn, textAnimationOut}} resets or removes them; keyframe.paste {payload, clipId, at} pastes copied keyframes.
- copy_items / paste_items copy project items: bins with their contents, media items, and sequences (deep-copied with new ids).
- Payloads are JSON {format: "jasper-clipboard", version: 1, kind, …} of at most 20 MB; pass them back unchanged (they are validated on paste).`;

const PayloadArg = z
	.record(z.string(), z.unknown())
	.describe('A clipboard payload as returned by copy_clips / copy_items ({format: "jasper-clipboard", …})');

export function registerClipboardTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'copy_clips',
		{
			title: 'Copy clips',
			description:
				'Returns a clipboard payload for clips of one sequence (with their linked partners unless linked: false, the transitions between them, and every media/font/synthetic/transcript they use). Paste it with paste_clips (any project), or use it with clip.pasteAttributes / effect.paste in apply_commands. Read-only.',
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(z.string().min(1)).min(1).describe('Clip ids ("clp_…") from get_timeline'),
				linked: z.boolean().optional().describe('Include linked audio/video partners (default true)'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, clipIds, linked }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = Object.values(doc.sequences).find((s) => s.clips[clipIds[0]!]);
			if (!seq)
				throw new ToolError('E_NOT_FOUND', `Clip not found: ${clipIds[0]}`, 'Use get_timeline for clip ids.');
			const missing = clipIds.filter((id) => !seq.clips[id]);
			if (missing.length)
				throw new ToolError(
					'E_INVALID_PARAM',
					`Clips must exist in one sequence: ${missing.join(', ')}`,
					'Copy clips of one sequence at a time.',
				);
			const payload = buildClipsPayload(doc, seq.id, clipIds, {
				linked: linked !== false,
				primaryClipId: clipIds[0],
				now: new Date().toISOString(),
			});
			return jsonResult({
				payload,
				summary: {
					clips: payload.clips!.clips.length,
					transitions: payload.clips!.transitions.length,
					media: payload.media.map((m) => m.originalName),
				},
			});
		},
	);

	defineTool(
		ctx,
		'paste_clips',
		{
			title: 'Paste clips',
			description:
				'Pastes a copy_clips payload into a sequence (clip.paste): the earliest copied clip lands at `at`, the lowest copied video/audio track on videoTrack/audioTrack (default V1/A1), other clips keep their relative time and track offsets (missing tracks are added). mode overwrite (default) replaces what is there; insert ripples later clips. Media missing from the project are added (offline until the file is reachable).',
			input: {
				projectId: ProjectIdArg,
				payload: PayloadArg,
				at: timeArg('Where the earliest copied clip starts'),
				mode: EditModeSchema.optional().describe('overwrite (default) or insert'),
				videoTrack: TrackRefSchema.optional().describe('Lowest destination video track (default V1)'),
				audioTrack: TrackRefSchema.optional().describe('Lowest destination audio track (default A1)'),
				sequenceId: z
					.string()
					.optional()
					.describe('Sequence id ("seq_…"); default: the project\'s first sequence'),
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			applyHelper(
				ctx,
				a.projectId,
				a.mode === 'insert' ? 'Paste Insert' : 'Paste',
				[
					{
						type: 'clip.paste',
						payload: a.payload,
						at: a.at,
						...(a.mode ? { mode: a.mode } : {}),
						tracks: { video: a.videoTrack ?? 'V1', audio: a.audioTrack ?? 'A1' },
						...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
					},
				],
				extra,
				{ sequenceId: a.sequenceId },
			),
	);

	defineTool(
		ctx,
		'copy_items',
		{
			title: 'Copy project items',
			description:
				'Returns a clipboard payload for Project panel items: bins with everything inside, media and synthetic items, and sequence items with their sequences (and the sequences nested in them). Paste it with paste_items into this or another project. Read-only.',
			input: {
				projectId: ProjectIdArg,
				itemIds: z
					.array(z.string().min(1))
					.min(1)
					.describe('Project item ids ("itm_…", "bin_…") from list_media / get_project'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, itemIds }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const missing = itemIds.filter((id) => !doc.items[id]);
			if (missing.length)
				throw new ToolError('E_NOT_FOUND', `Project items not found: ${missing.join(', ')}`);
			const payload = buildItemsPayload(doc, itemIds, { now: new Date().toISOString() });
			return jsonResult({
				payload,
				summary: {
					items: payload.items!.items.length,
					sequences: payload.items!.sequences.length,
					media: payload.media.map((m) => m.originalName),
				},
			});
		},
	);

	defineTool(
		ctx,
		'paste_items',
		{
			title: 'Paste project items',
			description:
				'Pastes a copy_items payload into the project (project.pasteItems), into binId or the root. Sequences are deep-copied with new ids; media resolve by fingerprint or are added.',
			input: {
				projectId: ProjectIdArg,
				payload: PayloadArg,
				binId: z.string().optional().describe('Destination bin id ("bin_…"); default: the project root'),
			},
			annotations: EDIT,
		},
		async ({ projectId, payload, binId }, extra) => {
			const res = await transact(
				ctx,
				projectId,
				{ label: 'Paste', commands: [{ type: 'project.pasteItems', payload, binId: binId ?? null }] },
				extra,
			);
			return jsonResult(txBody(res, requireOk(res)));
		},
	);
}
