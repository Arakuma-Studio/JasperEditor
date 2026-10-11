// Source monitor state (S03:SRC-001…004, S05:PGM-010): which project item is open, the recent list
// (≤ 20), and the item's marks mirrored in source frames for the transport commands. The marks
// themselves live in the document (`item.setMarks`, undoable, ARCHITECTURE §2.3).
import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type FitClip,
	FLICKS_PER_SECOND,
	framesToFlicks,
	type MediaAsset,
	type ProjectDocument,
	type ProjectItem,
	type RenderSnapshot,
	type Sequence,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { createStore } from 'zustand/vanilla';
import { resolvePatch, sourceTracksOf } from './patching.ts';

type SourceMonitorState = {
	itemId: string | null;
	recent: string[];
	/** Source frame rate (sequence fps for stills). */
	fps: number;
	durationFrames: number;
	/** Marks in source frames (In inclusive, Out exclusive), mirrored from the document. */
	markIn: number | null;
	markOut: number | null;
};

const MAX_RECENT_SOURCES = 20;

export const sourceMonitorState = createStore<SourceMonitorState>(() => ({
	itemId: null,
	recent: [],
	fps: 30,
	durationFrames: 1,
	markIn: null,
	markOut: null,
}));

// sequences and synthetic sources open in the Source monitor too (Premiere); edit-ux: subclips.
type SourceItem = Extract<ProjectItem, { kind: 'media' | 'synthetic' | 'sequence' | 'subclip' }>;

export function sourceItem(doc: ProjectDocument, itemId: string | null): SourceItem | null {
	const it = itemId ? doc.items[itemId] : undefined;
	return it &&
		(it.kind === 'media' || it.kind === 'synthetic' || it.kind === 'sequence' || it.kind === 'subclip')
		? (it as SourceItem)
		: null;
}

/**
 * the picture/sound of a synthetic source as a render doc — a scratch project with one sequence of
 * `settings` holding the source placed for `frames` frames (so the Source monitor draws exactly what the timeline
 * draws). Null for adjustment layers (no picture of their own).
 */
export function syntheticPreviewDoc(
	doc: ProjectDocument,
	item: Extract<ProjectItem, { kind: 'synthetic' }>,
	settings: Sequence['settings'],
	frames: number,
): RenderSnapshot | null {
	const syn = doc.synthetics[item.syntheticId];
	if (!syn || syn.kind === 'adjustment') return null;
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'Source' });
	const seqId = Object.keys(base.sequences)[0]!;
	base.synthetics[syn.id] = JSON.parse(JSON.stringify(syn));
	const { document, result } = applyTransaction(
		base,
		{
			label: 'source',
			origin: 'system',
			sequenceId: seqId,
			commands: [
				{
					type: 'sequence.updateSettings',
					sequenceId: seqId,
					settings: { width: settings.width, height: settings.height, frameRate: settings.frameRate },
				} as Command,
				{
					type: 'clip.place',
					source: { syntheticId: syn.id },
					at: 0,
					sourceRange: { in: { flicks: 0 }, out: { flicks: framesToFlicks(frames, settings.frameRate) } },
				} as Command,
			],
		},
		{ ids, now: () => '', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) return null;
	return buildRenderSnapshot(document, seqId, { resolveMedia: () => null, resolveFont: () => null });
}

export function sourceAsset(doc: ProjectDocument, item: SourceItem | null): MediaAsset | null {
	return item?.kind === 'media' || item?.kind === 'subclip' ? (doc.media[item.mediaId] ?? null) : null;
}

/** Nominal rate of an asset's first video stream (stills/audio: the fallback). */
export function assetFps(asset: MediaAsset | null, fallback: number): number {
	const vs = asset?.probe.streams.find((s) => s.type === 'video');
	if (vs?.type === 'video' && asset?.kind === 'video') return vs.frameRate.num / vs.frameRate.den;
	return fallback;
}

export const flicksToSourceFrames = (flicks: number, fps: number) =>
	Math.round((flicks / FLICKS_PER_SECOND) * fps);
const sourceFramesToFlicks = (frames: number, fps: number) => Math.round((frames / fps) * FLICKS_PER_SECOND);

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
	const it = session.getCommitted().items[s.itemId];
	let inF = marks.in === undefined ? s.markIn : marks.in;
	let outF = marks.out === undefined ? s.markOut : marks.out;
	if (inF !== null && outF !== null && outF <= inF) {
		if (marks.in !== undefined) outF = null;
		else inF = null;
	}
	// a sequence's Source marks are its own In/Out (Premiere).
	if (it?.kind === 'sequence')
		return session.apply({
			label,
			origin: 'user',
			commands: [{ type: 'sequence.setInOut', sequenceId: it.sequenceId, in: inF, out: outF } as Command],
		}).ok;
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
 * Insert (`,`) / Overwrite (`.`) from the Source monitor (S03:SRC-004, S05:PGM-010; edit-ux three- and
 * four-point editing): `clip.sourceEdit` of the open item with its marks (split marks too), the sequence In/Out
 * (the sequence In wins over the playhead; an Out alone backtimes), the playhead and the source patching. When all
 * four points are set and their durations differ, the result asks for a Fit Clip choice (`needsFit`) unless one
 * is given.
 */
export function performSourceEdit(
	session: EditorSession,
	mode: 'insert' | 'overwrite',
	opts: { fit?: FitClip } = {},
): { ok: boolean; message?: string; clipIds?: string[]; needsFit?: boolean } {
	const state = session.getState();
	const doc = state.document;
	const src = sourceMonitorState.getState();
	const item = sourceItem(doc, src.itemId);
	if (!item) return { ok: false, message: 'Open a clip in the Source monitor first' };
	const seqId = state.activeSequenceId;
	const seq = seqId ? doc.sequences[seqId] : undefined;
	if (!seqId || !seq) return { ok: false, message: 'No active sequence' };
	if (item.kind === 'sequence' && item.sequenceId === seqId)
		return { ok: false, message: 'A sequence cannot be edited into itself' };
	const asNests = state.toggles.insertSequencesAsNests !== false;
	const counts = sourceTracksOf(doc, item, asNests);
	const patch = resolvePatch(seq as Sequence, state.views[seqId], counts);
	if (counts.video + counts.audio > 0 && [...patch.video, ...patch.audio].every((p) => p === null))
		return { ok: false, message: 'Every source track is patched off' };
	const cmd = {
		type: 'clip.sourceEdit',
		sequenceId: seqId,
		source: { projectItemId: item.id },
		mode,
		playhead: session.transport.getState().frame,
		patch,
		...(item.kind === 'sequence' ? { sequenceAs: asNests ? 'nest' : 'clips' } : {}),
		...(opts.fit ? { fit: opts.fit } : {}),
		rippleMarkers: state.toggles.rippleMarkers,
	} as Command;
	const r = session.apply({
		label: mode === 'insert' ? 'Insert' : 'Overwrite',
		origin: 'user',
		sequenceId: seqId,
		commands: [cmd],
		selectAfter: (res) => ({ timeline: (res.results[0] as { clipIds: string[] }).clipIds }),
	});
	if (!r.ok) {
		const e = r.errors[0];
		if (!opts.fit && e?.path?.[0] === 'fit') return { ok: false, needsFit: true, message: e.message };
		return { ok: false, message: e?.message };
	}
	const res = r.results[0] as { clipIds: string[]; end: number };
	// Premiere: the playhead moves to the end of the new material.
	session.transport.seek(res.end);
	return { ok: true, clipIds: res.clipIds };
}
