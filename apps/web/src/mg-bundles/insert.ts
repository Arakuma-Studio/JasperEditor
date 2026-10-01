// Placing compositions (M2, S08:MGU-002): drag from the Motion Templates panel's Remotion tab to the timeline
// or Program monitor, or double-click to insert at the playhead on the targeted video track, through
// `clip.addComposition` (default duration = the composition's length at the sequence rate).
import type { Command, ProjectDocument } from '@jasper/project';
import type { EditorSession, SequenceViewState } from '@jasper/session';

export type CompositionRef = { mediaId: string; compositionId: string };

/** Track for a new composition clip: topmost targeted unlocked video track, else topmost unlocked, else V1. */
function targetTrackFor(
	doc: ProjectDocument,
	sequenceId: string,
	view: Pick<SequenceViewState, 'targeting'> | null,
): string {
	const seq = doc.sequences[sequenceId];
	if (!seq) return 'V1';
	const tracks = seq.videoTracks.filter((t) => !t.locked);
	const targeted = new Set(view?.targeting.video ?? []);
	for (let i = tracks.length - 1; i >= 0; i--) if (targeted.has(tracks[i]!.id)) return tracks[i]!.id;
	return tracks.at(-1)?.id ?? 'V1';
}

/** The `clip.addComposition` command for a composition at `at` (frames). */
function planCompositionInsert(
	doc: ProjectDocument,
	sequenceId: string,
	ref: CompositionRef,
	opts: {
		at: number;
		trackId?: string;
		view: Pick<SequenceViewState, 'targeting'> | null;
	},
): { command: Command; label: string } {
	const asset = doc.media[ref.mediaId];
	const info = asset?.mgBundle?.compositions.find((c) => c.id === ref.compositionId);
	if (!asset || !info) throw new Error(`Composition ${ref.compositionId} is not in the project`);
	return {
		command: {
			type: 'clip.addComposition',
			sequenceId,
			composition: { mediaId: ref.mediaId, id: ref.compositionId },
			at: Math.max(0, Math.round(opts.at)),
			track: opts.trackId ?? targetTrackFor(doc, sequenceId, opts.view),
		} as Command,
		label: `Add ${ref.compositionId}`,
	};
}

/** Inserts a composition at the playhead (or `at`) of the active sequence and selects it. */
export function insertComposition(
	session: EditorSession,
	ref: CompositionRef,
	opts: { at?: number; trackId?: string } = {},
): string {
	const state = session.store.getState();
	const sequenceId = state.activeSequenceId;
	if (!sequenceId) throw new Error('Open a sequence first');
	const plan = planCompositionInsert(session.getCommitted(), sequenceId, ref, {
		at: opts.at ?? session.transport.getState().frame,
		view: state.views[sequenceId] ?? null,
		...(opts.trackId ? { trackId: opts.trackId } : {}),
	});
	const result = session.apply({ label: plan.label, origin: 'user', sequenceId, commands: [plan.command] });
	if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; ') || 'Insert failed');
	const clipId = (result.results[0] as { clipId?: string } | undefined)?.clipId ?? result.created[0];
	if (!clipId) throw new Error('Insert produced no clip');
	session.select('timeline', [clipId], 'replace');
	return clipId;
}
