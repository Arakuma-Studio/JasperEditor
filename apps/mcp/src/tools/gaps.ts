// Workstream `gaps` MCP tools (docs/wp-notes/gaps.md): Find, Edit Original, Add / Delete Tracks, and (further down)
// Project Settings, Sequence Settings, proxies, Project Manager, Export Frame, Audio Channels, Warp Stabilizer,
// Auto Reframe, Morph Cut and Essential Graphics templates. Edits are document commands (one transaction each).
import {
	FIND_OPERATORS,
	findProjectItems,
	findTimelineHits,
	PROJECT_FIND_FIELDS,
	type Sequence,
	sequenceTimecode,
	TIMELINE_FIND_FIELDS,
	trackLabel,
} from '@jasper/project';
import { z } from 'zod';
import {
	DESTRUCTIVE,
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
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (EDITING_GUIDE). */
export const GAPS_GUIDE = `Find, Edit Original, tracks:
- find searches the Project panel (scope "project": name, label, type, path, codec, frameSize, any) or a sequence (scope "timeline": clipName, sourceName, text, marker, any) with up to two criteria (contains, matches, begins, ends, notContains), match all/any and matchCase, like Premiere's Edit ▸ Find. Timeline hits come in frame order with timecodes.
- locate_media says where a media file is on the engine host; action "reveal" shows it in the file browser and "open" opens it in its default application (Edit Original; local engines only, never programs).
- add_tracks adds video / audio / submix tracks at a placement ("first", "last" or after a track label like "V2"), audio track type mono / stereo / 5.1; delete_tracks deletes "empty" tracks, "unassigned" submixes or named tracks (tracks with clips need force: true and the user's approval).`;

const SequenceIdArg = z
	.string()
	.optional()
	.describe('Sequence id ("seq_…"); default: the project\'s first sequence');

function seqOf(doc: Parameters<typeof pickSequence>[0], sequenceId?: string): Sequence {
	try {
		return pickSequence(doc, sequenceId);
	} catch (e) {
		throw new ToolError('E_NOT_FOUND', (e as Error).message, 'Call get_project for sequence ids.');
	}
}

const Criterion = z.object({
	field: z.string().min(1).describe('Column: see the scope'),
	operator: z.enum(FIND_OPERATORS).default('contains'),
	value: z.string().min(1).max(500),
});

/** "first" → 0, "last" → the end, "V2" / "A1" / "S1" → after that track. */
function placementIndex(seq: Sequence, kind: 'video' | 'audio' | 'submix', at: string | undefined): number {
	const list =
		kind === 'video' ? seq.videoTracks : kind === 'audio' ? seq.audioTracks : (seq.submixTracks ?? []);
	if (!at || at === 'last') return list.length;
	if (at === 'first') return 0;
	const m = /^([VAS])(\d+)$/i.exec(at);
	const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'S';
	if (!m || m[1]!.toUpperCase() !== prefix)
		throw new ToolError(
			'E_INVALID_PARAM',
			`Bad placement "${at}" for ${kind} tracks`,
			`Use "first", "last" or "${prefix}1".`,
		);
	const n = Number(m[2]);
	if (n < 1 || n > list.length)
		throw new ToolError('E_NOT_FOUND', `No track ${at}`, 'Call get_timeline for track labels.');
	return n;
}

export function registerGapsTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'find',
		{
			title: 'Find in project or sequence',
			description:
				'Premiere\'s Edit ▸ Find. scope "project": project items whose fields match (fields name, label, type, path, codec, frameSize, any). scope "timeline": clips (clipName, sourceName, text = text clip content) and markers (marker = name or comment) of a sequence, in frame order. Up to two criteria; match "all" (default) or "any"; matchCase.',
			input: {
				projectId: ProjectIdArg,
				scope: z.enum(['project', 'timeline']),
				sequenceId: SequenceIdArg,
				criteria: z.array(Criterion).min(1).max(4),
				match: z.enum(['all', 'any']).optional(),
				matchCase: z.boolean().optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, scope, sequenceId, criteria, match, matchCase }) => {
			const fields = scope === 'project' ? PROJECT_FIND_FIELDS : TIMELINE_FIND_FIELDS;
			for (const c of criteria)
				if (!(fields as readonly string[]).includes(c.field))
					throw new ToolError(
						'E_INVALID_PARAM',
						`Unknown field "${c.field}" for scope ${scope}`,
						`Use one of: ${fields.join(', ')}`,
					);
			const { doc } = await loadDoc(ctx, projectId);
			const query = { criteria: criteria as never, match: match ?? 'all', matchCase: !!matchCase };
			if (scope === 'project') {
				const ids = findProjectItems(doc, query);
				return jsonResult({
					count: ids.length,
					items: ids.slice(0, 500).map((id) => {
						const it = doc.items[id]!;
						return { itemId: id, name: it.name, kind: it.kind, label: it.label };
					}),
				});
			}
			const seq = seqOf(doc, sequenceId);
			const hits = findTimelineHits(doc, seq.id, query);
			return jsonResult({
				sequenceId: seq.id,
				count: hits.length,
				hits: hits.slice(0, 500).map((h) => ({
					...h,
					timecode: sequenceTimecode(seq, h.frame),
					...(h.kind === 'clip'
						? { name: seq.clips[h.clipId]?.name, track: trackLabel(seq, h.trackId) }
						: {}),
				})),
			});
		},
	);

	defineTool(
		ctx,
		'locate_media',
		{
			title: 'Locate media (Edit Original)',
			description:
				'Where a media file is on the engine host and whether it is online. action "reveal" shows it in the host file browser, "open" opens it in its default application (Premiere Edit Original). Local engines only; programs are never opened.',
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().min(1).describe('Media id ("med_…") or a media / subclip item id'),
				action: z
					.enum(['none', 'reveal', 'open'])
					.optional()
					.describe('Default "none" (only report the path)'),
			},
			annotations: { ...READ_ONLY, idempotentHint: false },
		},
		async ({ projectId, mediaId, action }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const item = doc.items[mediaId];
			const id = item && (item.kind === 'media' || item.kind === 'subclip') ? item.mediaId : mediaId;
			const asset = doc.media[id];
			if (!asset)
				throw new ToolError('E_NOT_FOUND', `Media not found: ${mediaId}`, 'Call get_project for media ids.');
			const loc = asset.locators.find((l) => l.type === 'engine-store');
			if (!loc || loc.type !== 'engine-store')
				throw new ToolError(
					'E_INVALID_PARAM',
					'This media has no file on the engine',
					'Only imported files can be located.',
				);
			const where = await ctx.engine((c) => c.call('mediaLocation', { params: { mediaKey: loc.key } }));
			if (action && action !== 'none') {
				if (!where.exists)
					throw new ToolError('MEDIA_OFFLINE', 'The media file is offline', 'Relink it with link_media.');
				await ctx.engine((c) => c.call('mediaOpen', { params: { mediaKey: loc.key }, body: { action } }));
			}
			return jsonResult({
				mediaId: id,
				name: asset.originalName,
				path: where.path,
				online: where.exists,
				action: action ?? 'none',
			});
		},
	);

	defineTool(
		ctx,
		'add_tracks',
		{
			title: 'Add tracks',
			description:
				'Premiere\'s Sequence ▸ Add Tracks…: video, audio and audio submix tracks in one undoable step. Placement "first", "last" (default) or after a track label ("V2", "A1", "S1"); audio / submix type mono, stereo (default) or 5.1.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				video: z.object({ count: z.number().int().min(1).max(99), after: z.string().optional() }).optional(),
				audio: z
					.object({
						count: z.number().int().min(1).max(99),
						after: z.string().optional(),
						type: z.enum(['mono', 'stereo', '5.1']).optional(),
					})
					.optional(),
				submix: z
					.object({
						count: z.number().int().min(1).max(20),
						after: z.string().optional(),
						type: z.enum(['mono', 'stereo', '5.1']).optional(),
					})
					.optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, video, audio, submix }) => {
			if (!video && !audio && !submix)
				throw new ToolError('E_INVALID_PARAM', 'Nothing to add', 'Pass video, audio or submix.');
			const { doc } = await loadDoc(ctx, projectId);
			const seq = seqOf(doc, sequenceId);
			const cmds: unknown[] = [];
			if (video)
				cmds.push({
					type: 'track.add',
					sequenceId: seq.id,
					kind: 'video',
					count: video.count,
					index: placementIndex(seq, 'video', video.after),
				});
			if (audio)
				cmds.push({
					type: 'track.add',
					sequenceId: seq.id,
					kind: 'audio',
					count: audio.count,
					index: placementIndex(seq, 'audio', audio.after),
					...(audio.type && audio.type !== 'stereo' ? { channelFormat: audio.type } : {}),
				});
			if (submix) {
				const at = placementIndex(seq, 'submix', submix.after);
				for (let i = 0; i < submix.count; i++)
					cmds.push({
						type: 'mixer.addSubmix',
						sequenceId: seq.id,
						index: at + i,
						channelFormat: submix.type ?? 'stereo',
					});
			}
			const res = await transact(ctx, projectId, { label: 'Add Tracks', commands: cmds, sequenceId: seq.id });
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	defineTool(
		ctx,
		'delete_tracks',
		{
			title: 'Delete tracks',
			description:
				'Premiere\'s Sequence ▸ Delete Tracks…: video / audio = "empty" (every empty track, the first kept when all are empty) or a list of track labels; submix = "unassigned" (no track routes to it) or labels like "S1". Tracks that hold clips need force: true (their clips are deleted). Needs the user\'s approval in an open editor.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				video: z.union([z.literal('empty'), z.array(z.string()).min(1)]).optional(),
				audio: z.union([z.literal('empty'), z.array(z.string()).min(1)]).optional(),
				submix: z.union([z.literal('unassigned'), z.array(z.string()).min(1)]).optional(),
				force: z.boolean().optional(),
			},
			annotations: DESTRUCTIVE,
		},
		async ({ projectId, sequenceId, video, audio, submix, force }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = seqOf(doc, sequenceId);
			const empty = (id: string) => !Object.values(seq.clips).some((c) => c.trackId === id);
			const pick = (list: Sequence['videoTracks'], spec: 'empty' | string[] | undefined) => {
				if (!spec) return [];
				if (spec === 'empty') {
					const e = list.filter((t) => empty(t.id)).map((t) => t.id);
					return e.length === list.length ? e.slice(1) : e;
				}
				return spec.map((ref) => {
					const t = list.find(
						(x) => x.id === ref || trackLabel(seq, x.id)?.toUpperCase() === ref.toUpperCase(),
					);
					if (!t)
						throw new ToolError(
							'E_NOT_FOUND',
							`Track not found: ${ref}`,
							'Call get_timeline for track labels.',
						);
					return t.id;
				});
			};
			const ids = [...pick(seq.videoTracks, video), ...pick(seq.audioTracks, audio)];
			const subs = seq.submixTracks ?? [];
			let submixIds: string[] = [];
			if (submix === 'unassigned') {
				const all = [...seq.audioTracks, ...subs];
				submixIds = subs
					.filter(
						(s) =>
							!all.some(
								(t) => t.mixer?.output === s.id || (t.mixer?.sends ?? []).some((x) => x.target === s.id),
							),
					)
					.map((s) => s.id);
			} else if (submix)
				submixIds = submix.map((ref) => {
					const m = /^S(\d+)$/i.exec(ref);
					const t = m ? subs[Number(m[1]) - 1] : subs.find((x) => x.id === ref);
					if (!t) throw new ToolError('E_NOT_FOUND', `Submix not found: ${ref}`, 'Submixes are S1, S2…');
					return t.id;
				});
			if (!ids.length && !submixIds.length) return jsonResult({ deleted: 0, note: 'No track matched' });
			const cmds: unknown[] = [];
			if (ids.length)
				cmds.push({
					type: 'track.remove',
					sequenceId: seq.id,
					trackIds: ids,
					...(force ? { force: true } : {}),
				});
			for (const id of submixIds) cmds.push({ type: 'mixer.removeSubmix', sequenceId: seq.id, stripId: id });
			const res = await transact(ctx, projectId, {
				label: 'Delete Tracks',
				commands: cmds,
				sequenceId: seq.id,
			});
			return jsonResult({
				...txBody(res, requireOk(res)),
				deletedTracks: ids.length,
				deletedSubmixes: submixIds.length,
			});
		},
	);
}
