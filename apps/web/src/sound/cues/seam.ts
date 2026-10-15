// Cue Seam state and edits (spec 12 §2.7): whether the seam shows for a sequence, the selected cues (session selection
// domain `cues`), and the document commands the seam's gestures, menus and keys commit (all ordinary undoable
// `soundCue.*` / `marker.*` commands, so agents reach the same edits through `apply_commands`).
import { mgRegistry } from '@jasper/mg-templates';
import {
	type Command,
	type CueWeight,
	type ProjectDocument,
	resolveCueAnchor,
	type Sequence,
	type SoundCue,
} from '@jasper/project';
import type { EditorSession, SequenceViewState } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import { useSyncExternalStore } from 'react';
import { getWorkspaceStore } from '../../shell/workspaces/instance.ts';
import { type CueInput, cuesOf, cueToMarker, markersToConvert, markerToCueInput } from './model.ts';

/** The built-in Sound Design workspace (spec 12 §2.7), where the seam shows by default. */
export const SOUND_DESIGN_WORKSPACE = 'sound-design';

/** Whether the seam shows: the user's choice for the sequence, else in the Sound Design workspace or with cues. */
export function cueSeamShown(
	view: Pick<SequenceViewState, 'cueSeam'> | undefined,
	opts: { workspaceId: string | null; hasCues: boolean },
): boolean {
	if (view?.cueSeam === 'on') return true;
	if (view?.cueSeam === 'off') return false;
	return opts.workspaceId === SOUND_DESIGN_WORKSPACE || opts.hasCues;
}

const subscribeWorkspace = (l: () => void) => getWorkspaceStore().subscribe(l);
const activeWorkspace = () => getWorkspaceStore().getState().activeId;

/** The active workspace id (re-renders when it changes). */
export function useActiveWorkspace(): string {
	return useSyncExternalStore(subscribeWorkspace, activeWorkspace, activeWorkspace);
}

/** `cueSeamShown` for a session's sequence, outside React (menus, commands). */
export function cueSeamShownFor(session: EditorSession, sequenceId: string): boolean {
	const st = session.getState();
	const seq = (st.transient ?? st.document).sequences[sequenceId];
	let ws: string | null = null;
	try {
		ws = activeWorkspace();
	} catch {
		ws = null;
	}
	return cueSeamShown(st.views[sequenceId], { workspaceId: ws, hasCues: cuesOf(seq).length > 0 });
}

/** Hook form of `cueSeamShown`. */
export function useCueSeamShown(sequenceId: string): boolean {
	const ws = useActiveWorkspace();
	const choice = useSessionState((s) => s.views[sequenceId]?.cueSeam);
	const hasCues = useSessionState((s) => cuesOf((s.transient ?? s.document).sequences[sequenceId]).length > 0);
	return cueSeamShown({ cueSeam: choice }, { workspaceId: ws, hasCues });
}

/** Selected cues of the session that belong to the sequence. */
export function selectedCues(session: EditorSession, seq: Pick<Sequence, 'soundDesign'>): SoundCue[] {
	const ids = new Set(session.getState().selection.cues ?? []);
	return cuesOf(seq).filter((c) => ids.has(c.id));
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

/** The frame a cue's anchor resolves to now (motion graphics read the template registry), or null. */
export function anchorFrame(doc: Pick<ProjectDocument, 'media'>, seq: Sequence, cue: SoundCue): number | null {
	if (!cue.anchor) return null;
	return resolveCueAnchor(doc, seq, cue.anchor, { mgTemplates: mgRegistry });
}

/**
 * Moving cues by `delta` frames: `soundCue.update` per cue (its filled clips follow). A cue dropped off the frame its
 * anchor resolves to forgets the anchor, so a later resync does not pull it back (an intentional offset survives).
 */
export function moveCueCommands(
	doc: Pick<ProjectDocument, 'media'>,
	seq: Sequence,
	cues: readonly SoundCue[],
	delta: number,
): Command[] {
	return cues.map((c) => {
		const frame = Math.max(0, c.frame + delta);
		const at = anchorFrame(doc, seq, c);
		const detach = !!c.anchor && at !== null && at !== frame;
		return {
			type: 'soundCue.update',
			cueId: c.id,
			frame,
			...(detach ? { anchor: null } : {}),
		} as Command;
	});
}

/** The `soundCue.add` input copying a cue (no clips, by the user), shifted by `delta`. */
export function copyCueInput(c: SoundCue, delta: number): CueInput {
	const { id: _id, placedClipIds: _p, ...rest } = c;
	const shift = (f: number) => Math.max(0, f + delta);
	return {
		...rest,
		frame: shift(c.frame),
		source: 'user',
		...(c.window ? { window: { start: shift(c.window.start), end: shift(c.window.end) } } : {}),
		anchor: null,
	};
}

export function duplicateCueCommands(cues: readonly SoundCue[], delta: number): Command[] {
	if (!cues.length) return [];
	return [{ type: 'soundCue.add', cues: cues.map((c) => copyCueInput(c, delta)) } as Command];
}

export function removeCueCommands(ids: readonly string[]): Command[] {
	return ids.length ? [{ type: 'soundCue.remove', cueIds: [...ids] } as Command] : [];
}

/** The same field change on several cues. */
export function updateCuesCommands(
	ids: readonly string[],
	patch: Partial<{
		weight: CueWeight;
		kind: SoundCue['kind'];
		align: SoundCue['align'] | null;
		stopBefore: SoundCue['stopBefore'] | null;
		muted: boolean;
	}>,
): Command[] {
	return ids.map((cueId) => ({ type: 'soundCue.update', cueId, ...patch }) as Command);
}

/** Stop Before Next: the music dips this long and deep before the cue (P4 renders it as volume keyframes). */
export const STOP_BEFORE_DEFAULT = { seconds: 0.25, depthDb: -24 } as const;

/** Convert to Marker: one `sfx: …` marker per cue (parsed back by Convert Markers to Cues), the cues removed. */
export function cuesToMarkersCommands(cues: readonly SoundCue[]): Command[] {
	if (!cues.length) return [];
	return [
		...cues.map((c) => {
			const m = cueToMarker(c);
			return { type: 'marker.add', frame: m.frame, name: m.name, comment: m.comment } as Command;
		}),
		...removeCueCommands(cues.map((c) => c.id)),
	];
}

/** Convert Markers to Cues: `sfx:` markers and the selected markers become cues and are removed. */
export function markersToCuesCommands(seq: Sequence, selectedMarkers: readonly string[]): Command[] {
	const ms = markersToConvert(seq.markers, selectedMarkers);
	if (!ms.length) return [];
	return [
		{ type: 'soundCue.add', sequenceId: seq.id, cues: ms.map((m) => markerToCueInput(m)) } as Command,
		{ type: 'marker.remove', markerIds: ms.map((m) => m.id) } as Command,
	];
}

/** A manual cue at a frame (Markers ▸ Add Sound Cue): support weight, by the user. */
export function addCueCommand(sequenceId: string, frame: number): Command {
	return {
		type: 'soundCue.add',
		sequenceId,
		cues: [{ frame: Math.max(0, Math.round(frame)), kind: 'manual', weight: 'support', source: 'user' }],
	} as Command;
}

/** Cues without clips (Clear Unfilled Cues). */
export function unfilledCueIds(seq: Pick<Sequence, 'soundDesign' | 'clips'>): string[] {
	return cuesOf(seq)
		.filter((c) => !(c.placedClipIds ?? []).some((id) => Object.hasOwn(seq.clips, id)))
		.map((c) => c.id);
}
