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
	FLICKS_PER_SECOND,
	framesToFlicks,
	type MediaAsset,
	type ProjectDocument,
	type ProjectItem,
	type RenderSnapshot,
	type Sequence,
	syntheticDefaultFlicks,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { createStore } from 'zustand/vanilla';

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

// edit-structure: sequences and synthetic sources open in the Source monitor too (Premiere).
type SourceItem = Extract<ProjectItem, { kind: 'media' | 'synthetic' | 'sequence' }>;

export function sourceItem(doc: ProjectDocument, itemId: string | null): SourceItem | null {
	const it = itemId ? doc.items[itemId] : undefined;
	return it && (it.kind === 'media' || it.kind === 'synthetic' || it.kind === 'sequence')
		? (it as SourceItem)
		: null;
}

/**
 * edit-structure: the picture/sound of a synthetic source as a render doc — a scratch project with one sequence of
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
	// edit-structure: a sequence's Source marks are its own In/Out (Premiere).
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
	const seqId = state.activeSequenceId;
	if (!seqId || !doc.sequences[seqId]) return { ok: false, message: 'No active sequence' };
	const view = state.views[seqId];
	const patch = view?.sourcePatching ?? {};
	const pick = (label: string, targeted: readonly string[] | undefined): string | null | undefined =>
		label in patch ? patch[label] : targeted?.[0];
	const video = pick('V1', view?.targeting.video);
	const audio = pick('A1', view?.targeting.audio);
	const at = session.transport.getState().frame;
	// edit-structure: synthetics place with their marks (else their default length); sequences with their In/Out,
	// as nests or individual clips (the timeline toggle).
	const marks = item.kind === 'sequence' ? null : item.marks;
	const source =
		item.kind === 'media'
			? { mediaId: item.mediaId }
			: item.kind === 'synthetic'
				? { syntheticId: item.syntheticId }
				: { sequenceId: item.sequenceId };
	const fullOut =
		item.kind === 'media'
			? (doc.media[item.mediaId]?.probe.durationFlicks ?? 0)
			: item.kind === 'synthetic' && doc.synthetics[item.syntheticId]
				? (marks?.in?.flicks ?? 0) +
					syntheticDefaultFlicks(
						doc.synthetics[item.syntheticId]!.kind,
						(doc.settings.defaultStillDurationFrames / 30) * FLICKS_PER_SECOND,
					)
				: 0;
	const cmd = {
		type: 'clip.place',
		sequenceId: seqId,
		source,
		at,
		mode,
		...(marks && (marks.in || marks.out)
			? { sourceRange: { in: marks.in ?? { flicks: 0 }, out: marks.out ?? { flicks: fullOut } } }
			: {}),
		...(item.kind === 'sequence' ? { nest: state.toggles.insertSequencesAsNests !== false } : {}),
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
