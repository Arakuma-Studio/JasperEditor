// Vector shape editing state and edits shared by Properties ▸ Shape Contents, Effect Controls and the Program monitor
// tools (wp shapes): the selected item of the selected vector shape (its path is edited on the monitor), the selected
// vertices, and the edits the tools issue (new vector clips, items added into a selected shape) — one transaction
// (one undo step) each.
import {
	applyMatrix,
	type Command,
	DEFAULT_SHAPE_SECONDS,
	invertMatrix,
	layerMatrix,
	type Sequence,
	type ShapeClip,
	type ShapeItem,
	type VectorShapeData,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSyncExternalStore } from 'react';
import { activeSequence, freeVideoTrack, transformAt } from '../panels/program/edits.ts';

export type Vec2 = [number, number];

export type VectorUiState = {
	/** The item selected in the contents list (and edited on the monitor when it is a path). */
	selected: { clipId: string; itemId: string } | null;
	/** Selected vertex indices of the selected path item. */
	vertices: number[];
	/** Twirled-up groups (contents list), by `clipId:itemId`. */
	collapsed: Record<string, boolean>;
};

let state: VectorUiState = { selected: null, vertices: [], collapsed: {} };
const listeners = new Set<() => void>();

export const vectorUi = {
	get: (): VectorUiState => state,
	set(patch: Partial<VectorUiState>): void {
		state = { ...state, ...patch };
		for (const l of [...listeners]) l();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
	select(sel: VectorUiState['selected']): void {
		vectorUi.set({ selected: sel, vertices: [] });
	},
};

export function useVectorUi<T>(pick: (s: VectorUiState) => T): T {
	return useSyncExternalStore(
		vectorUi.subscribe,
		() => pick(state),
		() => pick(state),
	);
}

export const isVectorClip = (c: unknown): c is ShapeClip & { shape: VectorShapeData } =>
	!!c && (c as { kind?: string }).kind === 'shape' && (c as ShapeClip).shape?.type === 'vector';

/** The single selected vector shape clip of the active sequence visible at `frame` (unlocked), or null. */
export function selectedVectorClip(
	session: EditorSession,
	frame?: number,
): (ShapeClip & { shape: VectorShapeData }) | null {
	const seq = activeSequence(session);
	if (!seq) return null;
	const ids = session.getState().selection.timeline.clips;
	if (ids.length !== 1) return null;
	const c = seq.clips[ids[0]!];
	if (!isVectorClip(c)) return null;
	if (seq.videoTracks.find((t) => t.id === c.trackId)?.locked) return null;
	if (frame !== undefined && (frame < c.start || frame >= c.start + c.duration)) return null;
	return c;
}

/** Sequence px → content px (origin = layer box centre) of a vector clip at `frame`. */
export function sequenceToContent(seq: Sequence, clip: ShapeClip, frame: number, p: Vec2): Vec2 | null {
	const m = layerMatrix(transformAt(seq, clip as never, frame));
	const inv = invertMatrix(m);
	if (!inv) return null;
	const q = applyMatrix(inv, p);
	return [q[0] - seq.settings.width / 2, q[1] - seq.settings.height / 2];
}

/**
 * A new vector shape clip at `frame` on the targeted video track (busy → first free → new), with `items` around
 * the layer centre, its Motion position at `center` (sequence px). Selects it. Returns the clip id.
 */
export function addVectorClipAt(
	session: EditorSession,
	frame: number,
	items: Record<string, unknown>[],
	label: string,
	center?: Vec2,
	name?: string,
): string | null {
	const seq = activeSequence(session);
	if (!seq) return null;
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const duration = Math.max(1, Math.round(DEFAULT_SHAPE_SECONDS * fps));
	const track = freeVideoTrack(seq, frame, duration, session.getState().views[seq.id]?.targeting.video);
	const r = session.apply({
		label,
		origin: 'user',
		sequenceId: seq.id,
		commands: [
			{
				type: 'clip.addShape',
				ref: '$shape',
				at: frame,
				duration,
				track,
				shape: { type: 'vector', contents: items },
				...(center ? { transform: { position: center } } : {}),
				...(name ? { name } : {}),
			} as Command,
		],
	});
	if (!r.ok) return null;
	const id = r.refs.$shape ?? null;
	if (id) session.select('timeline', [id], 'replace');
	return id;
}

/** Adds items to a vector shape (top level, at the top of the list, as a new group) in one transaction. */
export function addItemsToVector(
	session: EditorSession,
	clipId: string,
	items: Record<string, unknown>[],
	label: string,
	opts: { parentId?: string | null; index?: number } = {},
): string[] {
	const seq = activeSequence(session);
	if (!seq) return [];
	const r = session.apply({
		label,
		origin: 'user',
		sequenceId: seq.id,
		commands: [
			{
				type: 'shape.addItems',
				clipId,
				items,
				...(opts.parentId ? { parentId: opts.parentId } : {}),
				index: opts.index ?? 0,
			} as Command,
		],
	});
	if (!r.ok) return [];
	return ((r.results?.[0] as { itemIds?: string[] } | undefined)?.itemIds ?? []) as string[];
}

/** A group holding one path item, a stroke and a fill (what a drawing tool adds into a selected shape). */
export function drawnGroup(
	path: Record<string, unknown>,
	name: string,
	opts: { stroke?: boolean; fill?: boolean } = {},
) {
	const contents: Record<string, unknown>[] = [path];
	if (opts.stroke) contents.push({ type: 'stroke', color: [1, 1, 1, 1], width: 4 });
	if (opts.fill !== false) contents.push({ type: 'fill', color: [1, 1, 1, 1] });
	return { type: 'group', name, contents };
}

/** Items of a vector clip (draft-safe read). */
export const contentsOf = (c: ShapeClip & { shape: VectorShapeData }): ShapeItem[] => c.shape.contents;
