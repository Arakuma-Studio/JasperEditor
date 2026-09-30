// Source monitor state (S03:SRC-001…004, S05:PGM-010): which project item is open, the recent list
// (≤ 20), and the item's marks mirrored in source frames for the transport commands. The marks
// themselves live in the document (`item.setMarks`, undoable, ARCHITECTURE §2.3).
import {
	type Command,
	FLICKS_PER_SECOND,
	type MediaAsset,
	type ProjectDocument,
	type ProjectItem,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { createStore } from 'zustand/vanilla';

export type SourceMonitorState = {
	itemId: string | null;
	recent: string[];
	/** Source frame rate (sequence fps for stills). */
	fps: number;
	durationFrames: number;
	/** Marks in source frames (In inclusive, Out exclusive), mirrored from the document. */
	markIn: number | null;
	markOut: number | null;
};

export const MAX_RECENT_SOURCES = 20;

export const sourceMonitorState = createStore<SourceMonitorState>(() => ({
	itemId: null,
	recent: [],
	fps: 30,
	durationFrames: 1,
	markIn: null,
	markOut: null,
}));

export type SourceItem = Extract<ProjectItem, { kind: 'media' | 'synthetic' }>;

export function sourceItem(doc: ProjectDocument, itemId: string | null): SourceItem | null {
	const it = itemId ? doc.items[itemId] : undefined;
	return it && (it.kind === 'media' || it.kind === 'synthetic') ? (it as SourceItem) : null;
}

export function sourceAsset(doc: ProjectDocument, item: SourceItem | null): MediaAsset | null {
	return item?.kind === 'media' ? (doc.media[item.mediaId] ?? null) : null;
}

/** Nominal rate of an asset's first video stream (stills/audio: the fallback). */
export function assetFps(asset: MediaAsset | null, fallback: number): number {
	const vs = asset?.probe.streams.find((s) => s.type === 'video');
	if (vs?.type === 'video' && asset?.kind === 'video') return vs.frameRate.num / vs.frameRate.den;
	return fallback;
}

export const flicksToSourceFrames = (flicks: number, fps: number) =>
	Math.round((flicks / FLICKS_PER_SECOND) * fps);
export const sourceFramesToFlicks = (frames: number, fps: number) =>
	Math.round((frames / fps) * FLICKS_PER_SECOND);

/** Opens a media item in the Source monitor (S03:SRC-001). Returns false for non-media items. */
export function openInSource(session: EditorSession, itemId: string): boolean {
	const doc = session.getCommitted();
	if (!sourceItem(doc, itemId)) return false;
	const s = sourceMonitorState.getState();
	sourceMonitorState.setState({
		itemId,
		recent: [itemId, ...s.recent.filter((x) => x !== itemId)].slice(0, MAX_RECENT_SOURCES),
	});
	return true;
}

export function closeSource(itemId?: string): void {
	const s = sourceMonitorState.getState();
	const target = itemId ?? s.itemId;
	const recent = s.recent.filter((x) => x !== target);
	sourceMonitorState.setState({ recent, itemId: s.itemId === target ? (recent[0] ?? null) : s.itemId });
}

/** Sets or clears source marks through the document (`item.setMarks`, S03:SRC-003). */
export function setSourceMarks(
	session: EditorSession,
	marks: { in?: number | null; out?: number | null },
	label = 'Set Source Marks',
): boolean {
	const s = sourceMonitorState.getState();
	if (!s.itemId) return false;
	let inF = marks.in === undefined ? s.markIn : marks.in;
	let outF = marks.out === undefined ? s.markOut : marks.out;
	if (inF !== null && outF !== null && outF <= inF) {
		if (marks.in !== undefined) outF = null;
		else inF = null;
	}
	const r = session.apply({
		label,
		origin: 'user',
		commands: [
			{
				type: 'item.setMarks',
				itemId: s.itemId,
				in: inF === null ? null : { flicks: sourceFramesToFlicks(inF, s.fps) },
				out: outF === null ? null : { flicks: sourceFramesToFlicks(outF, s.fps) },
			} as Command,
		],
	});
	return r.ok;
}

/**
 * Insert (`,`) / Overwrite (`.`) from the Source monitor (S03:SRC-004, S05:PGM-010): `clip.place` of the
 * marked range at the sequence playhead on the source-patched (else targeted) tracks.
 */
export function performSourceEdit(
	session: EditorSession,
	mode: 'insert' | 'overwrite',
): { ok: boolean; message?: string; clipIds?: string[] } {
	const state = session.getState();
	const doc = state.document;
	const src = sourceMonitorState.getState();
	const item = sourceItem(doc, src.itemId);
	if (!item) return { ok: false, message: 'Open a clip in the Source monitor first' };
	if (item.kind !== 'media')
		return { ok: false, message: 'Only media items can be edited in from Source in M1' };
	const seqId = state.activeSequenceId;
	if (!seqId || !doc.sequences[seqId]) return { ok: false, message: 'No active sequence' };
	const view = state.views[seqId];
	const patch = view?.sourcePatching ?? {};
	const pick = (label: string, targeted: readonly string[] | undefined): string | null | undefined =>
		label in patch ? patch[label] : targeted?.[0];
	const video = pick('V1', view?.targeting.video);
	const audio = pick('A1', view?.targeting.audio);
	const marks = item.marks;
	const at = session.transport.getState().frame;
	const cmd = {
		type: 'clip.place',
		sequenceId: seqId,
		source: { mediaId: item.mediaId },
		at,
		mode,
		...(marks.in || marks.out
			? {
					sourceRange: {
						in: marks.in ?? { flicks: 0 },
						out: marks.out ?? { flicks: doc.media[item.mediaId]?.probe.durationFlicks ?? 0 },
					},
				}
			: {}),
		...(video === null ? { video: false } : {}),
		...(audio === null ? { audio: false } : {}),
		...(video || audio ? { tracks: { ...(video ? { video } : {}), ...(audio ? { audio } : {}) } } : {}),
	} as Command;
	const r = session.apply({
		label: mode === 'insert' ? 'Insert' : 'Overwrite',
		origin: 'user',
		sequenceId: seqId,
		commands: [cmd],
	});
	if (!r.ok) return { ok: false, message: r.errors[0]?.message };
	const seq = session.getCommitted().sequences[seqId]!;
	const created = r.created.filter((id) => seq.clips[id]);
	const end = Math.max(at, ...created.map((id) => seq.clips[id]!.start + seq.clips[id]!.duration));
	session.transport.seek(end);
	return { ok: true, clipIds: created };
}
