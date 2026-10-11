// Synchronize, Merge Clips and multi-camera MCP tools (docs/wp-notes/multicam.md). Audio sync measures the offsets
// in the engine (POST /api/sync/audio, two-pass GCC-PHAT) and passes them to the document commands, refusing
// unreliable matches unless asked to apply them anyway. Every edit is one transaction of document commands (also
// available through apply_commands: clip.synchronize, item.mergeClips, multicam.*).
import type { SyncAudioResponse } from '@jasper/api';
import {
	type AudioSyncClip,
	audioSyncClipsForItems,
	audioSyncClipsForUnits,
	cameraNumber,
	isMulticamClip,
	type MulticamSource,
	multicamSourceOf,
	type ProjectDocument,
	resolveFrameInput,
	resolveTrackRef,
	SyncError,
	sequenceTimecode,
	shownAngles,
	synchronizeReference,
	synchronizeUnits,
	trackLabel,
} from '@jasper/project';
import { z } from 'zod';
import {
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	type Extra,
	loadDoc,
	READ_ONLY,
	requireOk,
	requireSequence,
	type ToolContext,
	transact,
	txBody,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { timeArg } from './editing.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (EDITING_GUIDE). */
export const MULTICAM_GUIDE = `Synchronize, Merge Clips, multi-camera:
- Sync methods everywhere: "in" (In points / clip starts), "out" (Out points / clip ends), "timecode" (embedded start timecode; ignoreHours compares MM:SS:FF only), "marker" (first clip marker, or the first named marker), "audio" (waveforms: the engine cross-correlates the recordings, two-pass GCC-PHAT, sample-accurate). Audio results carry confidence (≥ 8 is a clear peak) and distinct (≥ 1.5: no competing match); unreliable matches are refused unless onUnreliable: "apply". measure_audio_sync only measures.
- synchronize_clips moves timeline clips (with their linked clips) so their sync points line up with a reference clip (default: the one on the lowest video track; or referenceClipId / referenceTrack). offsetFrames shifts the others by a known delay.
- merge_clips makes a merged clip (a project item) from one video clip and 1–16 audio clips; removeVideoAudio drops the camera's own audio. Placing it (add_clip / clip.place {source: {projectItemId}}) edits its clips linked and in sync.
- create_multicam_sequence makes a multi-camera source sequence from project items: one video track per camera (angle), audio per source, synced; audio "camera1" (default), "all" or "switch" (audio follows the shown angle); cameraNames "enumerate" (Camera 1…) or "clip"; order "selection", "name", "timecode" or explicit item ids; preset = a sequence preset id or "automatic". Place it with place_sequence or add_clip/clip.place {source: {sequenceId}}: you get linked multi-camera clips (nest-video + nest-audio) showing camera 1.
- switch_multicam_angle sets the angle (camera number 1–n of the shown cameras, an angle id or a camera name) of clips, of the clip at a time, or of a range only (edits are added at its ends; neighbouring pieces with the same angle are joined). record_multicam_cuts applies a whole live-switching pass (cuts at times, each until the next) as ONE undo step. audio: false keeps the audio angle fixed (default: audio follows video).
- set_multicam_enabled off makes a multi-camera clip play its whole nested sequence (composite); on turns any nest clip into a multi-camera clip (a plain nested sequence then gets one camera per video track). flatten_multicam replaces multi-camera clips by the clips their angles show (same picture, effects and Motion composed). edit_multicam_cameras renames, hides/shows and reorders cameras and changes the audio mode. Adjust the sync later by editing the source sequence itself (its clips' positions are the sync); every multi-camera clip follows. get_multicam lists sources, cameras and the multi-camera clips with their angles.`;

const MethodArg = z
	.enum(['in', 'out', 'timecode', 'marker', 'audio'])
	.describe('Sync point: in, out, timecode, marker (clip marker) or audio (waveforms)');
const SyncOptionArgs = {
	ignoreHours: z.boolean().optional().describe('timecode: ignore the hours digits'),
	marker: z.string().optional().describe('marker: use the first clip marker with this name'),
	offsetFrames: z
		.number()
		.int()
		.optional()
		.describe('Shift every clip but the reference later by this many frames (a known delay)'),
	onUnreliable: z
		.enum(['refuse', 'apply'])
		.optional()
		.describe('audio: what to do when a match is unreliable (default refuse)'),
	maxOffsetSeconds: z.number().positive().optional().describe('audio: largest offset to search (seconds)'),
};
const AngleArg = z
	.union([z.number().int().min(1), z.string().min(1)])
	.describe('Camera number (1 = first shown camera), an angle id or a camera name');
const SequenceIdArg = z
	.string()
	.optional()
	.describe('Sequence id ("seq_…") of the edit; default: the project\'s first sequence');

type SyncReport = {
	key: string;
	offsetSeconds: number;
	confidence: number | null;
	distinct: number | null;
	reliable: boolean;
	inverted: boolean;
	error?: string;
};

/** Runs the engine analysis; refuses (or reports) unreliable matches. */
async function measure(
	ctx: ToolContext,
	clips: AudioSyncClip[],
	opts: { reference?: string; maxOffsetSeconds?: number; onUnreliable?: 'refuse' | 'apply' | 'report' },
): Promise<{ offsets: Record<string, number>; report: SyncReport[] }> {
	const res = (await ctx.engine((c) =>
		c.call('syncAudio', {
			body: {
				clips,
				...(opts.reference ? { reference: opts.reference } : {}),
				...(opts.maxOffsetSeconds ? { maxOffsetSeconds: opts.maxOffsetSeconds } : {}),
			},
		}),
	)) as SyncAudioResponse;
	const report: SyncReport[] = res.results.map((r) => ({
		key: r.key,
		offsetSeconds: r.offsetFlicks / 705_600_000,
		confidence: r.confidence,
		distinct: r.distinct,
		reliable: r.reliable,
		inverted: r.inverted,
		...(r.error ? { error: r.error } : {}),
	}));
	const failed = report.filter((r) => r.error);
	if (failed.length && opts.onUnreliable !== 'report')
		throw new ToolError(
			'E_SYNC_NO_MATCH',
			`No common audio for ${failed.map((r) => `${r.key} (${r.error})`).join(', ')}`,
			'Check that the recordings overlap in time and have audio, or use another sync method.',
			{ report },
		);
	const bad = report.filter((r) => !r.reliable && !r.error);
	if (bad.length && (opts.onUnreliable ?? 'refuse') === 'refuse')
		throw new ToolError(
			'E_SYNC_UNRELIABLE',
			`The audio match is unreliable for ${bad.map((r) => r.key).join(', ')}`,
			'confidence < 8 or distinct < 1.5 (repetitive or unrelated sound). Check with measure_audio_sync, use another sync method, or pass onUnreliable: "apply".',
			{ report },
		);
	return { offsets: Object.fromEntries(res.results.map((r) => [r.key, r.offsetFlicks])), report };
}

function syncErrors<T>(fn: () => T): T {
	try {
		return fn();
	} catch (e) {
		if (e instanceof SyncError) throw new ToolError(e.code, e.message);
		throw e;
	}
}

async function apply(
	ctx: ToolContext,
	projectId: string,
	label: string,
	commands: unknown[],
	extra: Extra,
	more: Record<string, unknown> = {},
	sequenceId?: string,
) {
	const res = await transact(
		ctx,
		projectId,
		{ label, commands, ...(sequenceId ? { sequenceId } : {}) },
		extra,
	);
	return jsonResult({ ...txBody(res, requireOk(res)), ...more });
}

function multicamSummary(doc: ProjectDocument, seqId: string, mc: MulticamSource) {
	const item = Object.values(doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === seqId);
	const seq = doc.sequences[seqId]!;
	return {
		sequenceId: seqId,
		name: item?.name ?? null,
		audio: mc.audio,
		sync: mc.sync ?? null,
		cameras: mc.angles.map((a) => ({
			angle: a.id,
			camera: cameraNumber(mc, a.id) || null,
			name: a.name,
			enabled: a.enabled,
			video: a.videoTrackId ? trackLabel(seq, a.videoTrackId) : null,
			audio: a.audioTrackIds.map((t) => trackLabel(seq, t)),
		})),
	};
}

export function registerMulticamTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'measure_audio_sync',
		{
			title: 'Measure audio sync',
			description:
				'Measures how recordings of one event line up by their audio (engine, two-pass GCC-PHAT) without changing anything: for project items (whole media) or timeline clips (the audio they play). offsetSeconds = the clip’s media time when the reference’s is 0; confidence ≥ 8 and distinct ≥ 1.5 = reliable; inverted = opposite polarity.',
			input: {
				projectId: ProjectIdArg,
				itemIds: z.array(z.string().min(1)).min(2).optional().describe('Project items (media clips)'),
				clipIds: z.array(z.string().min(1)).min(2).optional().describe('Timeline clips ("clp_…")'),
				sequenceId: SequenceIdArg,
				maxOffsetSeconds: SyncOptionArgs.maxOffsetSeconds,
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, itemIds, clipIds, sequenceId, maxOffsetSeconds }) => {
			if (!!itemIds === !!clipIds) throw new ToolError('E_INVALID_PARAM', 'Give either itemIds or clipIds');
			const { doc } = await loadDoc(ctx, projectId);
			let clips: AudioSyncClip[];
			if (itemIds) clips = syncErrors(() => audioSyncClipsForItems(doc, itemIds));
			else {
				const seq = requireSequence(doc, sequenceId);
				clips = syncErrors(() => audioSyncClipsForUnits(doc, seq, synchronizeUnits(seq, clipIds!, 'audio')));
			}
			const r = await measure(ctx, clips, {
				onUnreliable: 'report',
				...(maxOffsetSeconds ? { maxOffsetSeconds } : {}),
			});
			return jsonResult({ reference: clips[0]!.key, results: r.report });
		},
	);

	defineTool(
		ctx,
		'synchronize_clips',
		{
			title: 'Synchronize clips',
			description:
				'Clip ▸ Synchronize (clip.synchronize): moves timeline clips, each with its linked clips, so their sync points line up with the reference clip. Methods in/out/timecode/marker/audio; audio is measured by the engine first. Sub-frame audio offsets are kept in the source In.',
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(z.string().min(1)).min(2).describe('Clips from at least two sources'),
				method: MethodArg,
				referenceClipId: z.string().optional().describe('The clip that stays put'),
				referenceTrack: z.string().optional().describe('Or: the clip on this track stays put ("V1", "A2"…)'),
				sequenceId: SequenceIdArg,
				...SyncOptionArgs,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = requireSequence(doc, a.sequenceId);
			let audioOffsets: Record<string, number> | undefined;
			let report: SyncReport[] | undefined;
			if (a.method === 'audio') {
				const units = syncErrors(() => synchronizeUnits(seq, a.clipIds, 'audio'));
				const clips = syncErrors(() => audioSyncClipsForUnits(doc, seq, units));
				const refTrack = a.referenceTrack ? (resolveTrackRef(seq, a.referenceTrack) ?? undefined) : undefined;
				const ref = synchronizeReference(seq, units, {
					...(a.referenceClipId ? { referenceClipId: a.referenceClipId } : {}),
					...(refTrack ? { referenceTrackId: refTrack } : {}),
				});
				const m = await measure(ctx, clips, {
					...(ref >= 0 ? { reference: clips[ref]!.key } : {}),
					...(a.onUnreliable ? { onUnreliable: a.onUnreliable } : {}),
					...(a.maxOffsetSeconds ? { maxOffsetSeconds: a.maxOffsetSeconds } : {}),
				});
				audioOffsets = m.offsets;
				report = m.report;
			}
			return apply(
				ctx,
				a.projectId,
				`Synchronize (${a.method})`,
				[
					{
						type: 'clip.synchronize',
						clipIds: a.clipIds,
						method: a.method,
						...(a.referenceClipId ? { referenceClipId: a.referenceClipId } : {}),
						...(a.referenceTrack ? { referenceTrack: a.referenceTrack } : {}),
						...(a.ignoreHours !== undefined ? { ignoreHours: a.ignoreHours } : {}),
						...(a.marker ? { marker: a.marker } : {}),
						...(a.offsetFrames ? { offsetFrames: a.offsetFrames } : {}),
						...(audioOffsets ? { audioOffsets } : {}),
					},
				],
				extra,
				report ? { audio: report } : {},
				seq.id,
			);
		},
	);

	const itemSync = async (
		a: {
			projectId: string;
			itemIds: string[];
			method: string;
			onUnreliable?: 'refuse' | 'apply';
			maxOffsetSeconds?: number;
		},
		reference?: string,
	) => {
		if (a.method !== 'audio') return {};
		const { doc } = await loadDoc(ctx, a.projectId);
		const clips = syncErrors(() => audioSyncClipsForItems(doc, a.itemIds));
		const m = await measure(ctx, clips, {
			...(reference ? { reference } : {}),
			...(a.onUnreliable ? { onUnreliable: a.onUnreliable } : {}),
			...(a.maxOffsetSeconds ? { maxOffsetSeconds: a.maxOffsetSeconds } : {}),
		});
		return { audioOffsets: m.offsets, report: m.report };
	};

	defineTool(
		ctx,
		'merge_clips',
		{
			title: 'Merge clips',
			description:
				'Clip ▸ Merge Clips (item.mergeClips): one video clip plus 1–16 separately recorded audio clips (project items) → a merged clip item "<video> - Merged", synced by in/out/timecode/marker/audio. Placing the merged clip edits its clips linked and in sync.',
			input: {
				projectId: ProjectIdArg,
				itemIds: z
					.array(z.string().min(1))
					.min(2)
					.describe('Project items: at most one with video, the rest audio'),
				method: MethodArg,
				name: z.string().min(1).optional().describe('Name of the merged clip'),
				removeVideoAudio: z
					.boolean()
					.optional()
					.describe('Leave the video file’s own audio out ("Remove Audio From AV Clip")'),
				binId: z.string().optional().describe('Bin for the merged clip (default: the video clip’s bin)'),
				...SyncOptionArgs,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const s = await itemSync(a);
			return apply(
				ctx,
				a.projectId,
				'Merge Clips',
				[
					{
						type: 'item.mergeClips',
						itemIds: a.itemIds,
						method: a.method,
						...(a.name ? { name: a.name } : {}),
						...(a.removeVideoAudio !== undefined ? { removeVideoAudio: a.removeVideoAudio } : {}),
						...(a.binId ? { binId: a.binId } : {}),
						...(a.ignoreHours !== undefined ? { ignoreHours: a.ignoreHours } : {}),
						...(a.marker ? { marker: a.marker } : {}),
						...(a.offsetFrames ? { offsetFrames: a.offsetFrames } : {}),
						...(s.audioOffsets ? { audioOffsets: s.audioOffsets } : {}),
					},
				],
				extra,
				s.report ? { audio: s.report } : {},
			);
		},
	);

	defineTool(
		ctx,
		'create_multicam_sequence',
		{
			title: 'Create multi-camera source sequence',
			description:
				'Clip ▸ Create Multi-Camera Source Sequence (multicam.create) from project items: one video track per camera (angle), audio per source, synced by in/out/timecode/marker/audio. Returns the source sequenceId and its cameras. Place it with place_sequence to get multi-camera clips.',
			input: {
				projectId: ProjectIdArg,
				itemIds: z
					.array(z.string().min(1))
					.min(1)
					.describe('Project items: cameras (with video) and audio-only sources'),
				method: MethodArg,
				name: z.string().min(1).optional().describe('Default "<reference clip name> Multicam"'),
				referenceItemId: z.string().optional().describe('The camera the others sync to (default: camera 1)'),
				audio: z
					.enum(['camera1', 'all', 'switch'])
					.optional()
					.describe(
						'camera1 (default): camera 1’s audio; all: every camera mixed; switch: the shown angle’s audio',
					),
				cameraNames: z
					.enum(['enumerate', 'clip'])
					.optional()
					.describe('Camera 1, Camera 2… (default) or the clip names'),
				names: z.array(z.string().min(1)).optional().describe('Explicit camera names in camera order'),
				order: z
					.union([z.enum(['selection', 'name', 'timecode']), z.array(z.string().min(1))])
					.optional()
					.describe('Camera order: selection (itemIds order, default), name, timecode, or item ids'),
				preset: z
					.string()
					.optional()
					.describe('Sequence preset id, or "automatic" (default: camera 1’s format)'),
				moveToProcessedBin: z
					.boolean()
					.optional()
					.describe('Move the source clips into a "Processed Clips" bin'),
				binId: z.string().optional().describe('Bin for the new sequence'),
				...SyncOptionArgs,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const s = await itemSync(a, a.referenceItemId);
			return apply(
				ctx,
				a.projectId,
				'Create Multi-Camera Source Sequence',
				[
					{
						type: 'multicam.create',
						itemIds: a.itemIds,
						method: a.method,
						...(a.name ? { name: a.name } : {}),
						...(a.referenceItemId ? { referenceItemId: a.referenceItemId } : {}),
						...(a.audio ? { audio: a.audio } : {}),
						...(a.cameraNames ? { cameraNames: a.cameraNames } : {}),
						...(a.names ? { names: a.names } : {}),
						...(a.order ? { order: a.order } : {}),
						...(a.preset ? { preset: a.preset } : {}),
						...(a.moveToProcessedBin !== undefined ? { moveToProcessedBin: a.moveToProcessedBin } : {}),
						...(a.binId ? { binId: a.binId } : {}),
						...(a.ignoreHours !== undefined ? { ignoreHours: a.ignoreHours } : {}),
						...(a.marker ? { marker: a.marker } : {}),
						...(a.offsetFrames ? { offsetFrames: a.offsetFrames } : {}),
						...(s.audioOffsets ? { audioOffsets: s.audioOffsets } : {}),
					},
				],
				extra,
				s.report ? { audio: s.report } : {},
			);
		},
	);

	defineTool(
		ctx,
		'switch_multicam_angle',
		{
			title: 'Switch multi-camera angle',
			description:
				'multicam.switchAngle: shows another camera on multi-camera clips — the given clips, the multi-camera clip at `at` (lowest video track, or topDown), or only the part inside `range` (edits are added at its ends; neighbours with the same angle are joined). The linked multi-camera audio follows unless audio: false.',
			input: {
				projectId: ProjectIdArg,
				angle: AngleArg,
				clipIds: z.array(z.string().min(1)).min(1).optional().describe('Multi-camera clips'),
				at: timeArg('A time inside the multi-camera clip to switch').optional(),
				range: z
					.object({ from: timeArg('Range start'), to: timeArg('Range end (exclusive)') })
					.optional()
					.describe('Switch only this part'),
				track: z.string().optional().describe('Video track of the multi-camera clips ("V1"…)'),
				topDown: z
					.boolean()
					.optional()
					.describe('Multi-Camera Selection Top Down: the topmost multi-camera clip first'),
				video: z.boolean().optional().describe('Switch the picture (default true)'),
				audio: z.boolean().optional().describe('Switch the linked audio too (default true)'),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const n = [a.clipIds, a.at, a.range].filter((x) => x !== undefined).length;
			if (n === 0) throw new ToolError('E_INVALID_PARAM', 'Give clipIds, at or range');
			return apply(
				ctx,
				a.projectId,
				'Switch Multi-Camera Angle',
				[
					{
						type: 'multicam.switchAngle',
						angle: a.angle,
						...(a.clipIds ? { clipIds: a.clipIds } : {}),
						...(a.at !== undefined && !a.clipIds ? { at: a.at } : {}),
						...(a.range ? { range: a.range } : {}),
						...(a.track ? { track: a.track } : {}),
						...(a.topDown !== undefined ? { topDown: a.topDown } : {}),
						...(a.video !== undefined ? { video: a.video } : {}),
						...(a.audio !== undefined ? { audio: a.audio } : {}),
						...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
					},
				],
				extra,
				{},
				a.sequenceId,
			);
		},
	);

	defineTool(
		ctx,
		'record_multicam_cuts',
		{
			title: 'Record multi-camera cuts',
			description:
				'A live-switching pass (multicam.record) as one undo step: from each cut’s time on, show its camera until the next cut (the last until `to`, default the end of the multi-camera clip). Cuts to the camera already shown add no edit.',
			input: {
				projectId: ProjectIdArg,
				cuts: z
					.array(z.object({ at: timeArg('Cut time'), angle: AngleArg }))
					.min(1)
					.describe('Cuts in any order (two at one time: the later wins)'),
				to: timeArg('End of the pass (exclusive)').optional(),
				track: z.string().optional().describe('Video track of the multi-camera clips'),
				topDown: z.boolean().optional(),
				audio: z.boolean().optional().describe('Linked audio follows (default true)'),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) =>
			apply(
				ctx,
				a.projectId,
				'Record Multi-Camera',
				[
					{
						type: 'multicam.record',
						cuts: a.cuts,
						...(a.to !== undefined ? { to: a.to } : {}),
						...(a.track ? { track: a.track } : {}),
						...(a.topDown !== undefined ? { topDown: a.topDown } : {}),
						...(a.audio !== undefined ? { audio: a.audio } : {}),
						...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
					},
				],
				extra,
				{},
				a.sequenceId,
			),
	);

	defineTool(
		ctx,
		'set_multicam_enabled',
		{
			title: 'Enable or disable multi-camera',
			description:
				'Clip ▸ Multi-Camera ▸ Enable (multicam.setEnabled) on nest clips (with their linked clips): off = the clip plays its whole nested sequence; on = it shows one angle (a plain nested sequence becomes a multi-camera source with one camera per video track).',
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(z.string().min(1)).min(1).describe('Nest / multi-camera clips'),
				enabled: z.boolean(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipIds, enabled }, extra) =>
			apply(
				ctx,
				projectId,
				enabled ? 'Enable Multi-Camera' : 'Disable Multi-Camera',
				[{ type: 'multicam.setEnabled', clipIds, enabled }],
				extra,
			),
	);

	defineTool(
		ctx,
		'flatten_multicam',
		{
			title: 'Flatten multi-camera clips',
			description:
				'Clip ▸ Multi-Camera ▸ Flatten (multicam.flatten): replaces multi-camera clips (and their linked audio) by the clips their angles show, with the same picture: Motion, opacity and effects composed, keyframes re-timed.',
			input: { projectId: ProjectIdArg, clipIds: z.array(z.string().min(1)).min(1) },
			annotations: { ...EDIT, destructiveHint: true },
		},
		async ({ projectId, clipIds }, extra) =>
			apply(ctx, projectId, 'Flatten Multi-Camera', [{ type: 'multicam.flatten', clipIds }], extra),
	);

	defineTool(
		ctx,
		'edit_multicam_cameras',
		{
			title: 'Edit multi-camera cameras',
			description:
				'Edit Cameras (multicam.editAngles) of a multi-camera source sequence: rename, show/hide (hidden cameras leave the camera numbering), reorder (angle ids), change the audio mode.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: z.string().min(1).describe('The multi-camera source sequence'),
				cameras: z
					.array(
						z.object({
							angle: AngleArg,
							name: z.string().min(1).optional(),
							enabled: z.boolean().optional(),
						}),
					)
					.optional(),
				order: z.array(z.string().min(1)).optional().describe('Every angle id once, in the new camera order'),
				audio: z.enum(['camera1', 'all', 'switch']).optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) =>
			apply(
				ctx,
				a.projectId,
				'Edit Cameras',
				[
					{
						type: 'multicam.editAngles',
						sequenceId: a.sequenceId,
						...(a.cameras ? { angles: a.cameras } : {}),
						...(a.order ? { order: a.order } : {}),
						...(a.audio ? { audio: a.audio } : {}),
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'get_multicam',
		{
			title: 'Get multi-camera sources and clips',
			description:
				'Lists the multi-camera source sequences (cameras with numbers, names, tracks, audio mode) and, for the edit sequence, its multi-camera clips with their time, track and active camera; with `at`, the camera shown at that time.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				at: timeArg('A time to report the active camera at').optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, at }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const sources = Object.values(doc.sequences)
				.filter((s) => multicamSourceOf(s))
				.map((s) => multicamSummary(doc, s.id, multicamSourceOf(s)!));
			const seq = requireSequence(doc, sequenceId);
			const clips = Object.values(seq.clips)
				.filter(isMulticamClip)
				.sort((x, y) => x.start - y.start)
				.map((c) => {
					const mc = multicamSourceOf(doc.sequences[c.sequenceId]);
					const angle = mc?.angles.find((x) => x.id === c.multicam.angle);
					return {
						clipId: c.id,
						kind: c.kind,
						track: trackLabel(seq, c.trackId),
						start: c.start,
						end: c.start + c.duration,
						startTimecode: sequenceTimecode(seq, c.start),
						source: c.sequenceId,
						enabled: c.multicam.enabled,
						angle: c.multicam.angle,
						camera: mc ? cameraNumber(mc, c.multicam.angle) || null : null,
						cameraName: angle?.name ?? null,
					};
				});
			let active: unknown;
			if (at !== undefined) {
				const f = resolveFrameInput(seq, at);
				active = clips.filter((c) => c.kind === 'nest-video' && c.start <= f && f < c.end);
			}
			return jsonResult({
				sequenceId: seq.id,
				sources,
				clips,
				...(at !== undefined ? { at: active } : {}),
				shownCameras: sources.map((s) => ({
					sequenceId: s.sequenceId,
					count: shownAngles(multicamSourceOf(doc.sequences[s.sequenceId])!).length,
				})),
			});
		},
	);
}
