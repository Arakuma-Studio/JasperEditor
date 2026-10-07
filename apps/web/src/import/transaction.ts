// Builds the ONE "Import N files" transaction of S01:LIFE-010 step 6: `media.register` for every file that
// is committed (+ `clip.place` when the drop target is the timeline or the Program monitor), preceded by
// `sequence.updateSettings` when the user accepted the clip-mismatch prompt (S01:SEQ-005, S04:IN-008).
import {
	type Command,
	flicksPerFrame,
	type MediaAsset,
	type ProjectDocument,
	type SourceSidecarInfo,
	sourceRangeFromSidecar,
	type TxInput,
} from '@jasper/project';
import type { ImportTarget } from '../state/services.ts';
import { placementFrames, type SequenceSettingsPatch } from './assets.ts';

export type PreparedMedia = {
	asset: MediaAsset;
	/** Display name of the new project item (the file name). */
	name: string;
	/** Id of an asset already in the project with the same fingerprint (S04:IN-007). */
	existingMediaId: string | null;
	/**
	 * M3 (S07:PRC-019): a source-range sidecar of the file (engine `sourceHint` for files registered by path, or
	 * a `.json` picked/dropped with an uploaded video). Recorded as the asset's `sourceRange`; the file becomes a
	 * version of its source when that is in the project or in this batch (matched by file name).
	 */
	sourceHint?: SourceSidecarInfo | null;
};

/** "Use existing" places/keeps the existing asset; "Import again" adds another project item (LIFE-010 step 3). */
export type DuplicateChoice = 'use-existing' | 'import-again';

/** Media already in the project with the same fingerprint (ignores `pending:` fingerprints). */
export function findExistingMedia(doc: Pick<ProjectDocument, 'media'>, fingerprint: string): string | null {
	for (const m of Object.values(doc.media)) {
		if (m.fingerprint === fingerprint && !m.fingerprint.startsWith('pending:')) return m.id;
	}
	return null;
}

export type ImportPlacementContext = {
	/** Program-monitor drops: overwrite at the playhead on the targeted tracks (S01:LIFE-012). */
	playheadFrame?: number;
	targetTracks?: { video?: string | null; audio?: string | null };
};

type BuiltImport = {
	tx: TxInput | null;
	/** Index of each prepared file's `media.register` command (null when an existing asset was reused). */
	registerIndex: (number | null)[];
	/** Index of each prepared file's `clip.place` command (null when not placed). */
	placeIndex: (number | null)[];
};

export function buildImportTransaction(input: {
	doc: ProjectDocument;
	prepared: PreparedMedia[];
	target: ImportTarget;
	duplicateChoice?: DuplicateChoice;
	matchSettings?: SequenceSettingsPatch | null;
	placement?: ImportPlacementContext;
}): BuiltImport {
	const { doc, prepared, target } = input;
	const choice = input.duplicateChoice ?? 'import-again';
	const commands: Command[] = [];
	const registerIndex: (number | null)[] = [];
	const placeIndex: (number | null)[] = [];
	const label = `Import ${prepared.length} ${prepared.length === 1 ? 'file' : 'files'}`;

	const sequenceId = target.kind === 'timeline' || target.kind === 'program' ? target.sequenceId : undefined;
	const seq = sequenceId ? doc.sequences[sequenceId] : undefined;
	if (seq && input.matchSettings) {
		commands.push({
			type: 'sequence.updateSettings',
			sequenceId: seq.id,
			settings: { ...input.matchSettings },
		} as Command);
	}

	const binId = target.kind === 'bin' ? target.binId : null;
	let cursor =
		target.kind === 'timeline'
			? target.at
			: target.kind === 'program'
				? Math.max(0, input.placement?.playheadFrame ?? 0)
				: 0;
	const rate = input.matchSettings?.frameRate ?? seq?.settings.frameRate;

	prepared.forEach((p, i) => {
		let source: string;
		if (p.existingMediaId && choice === 'use-existing') {
			registerIndex.push(null);
			source = p.existingMediaId;
		} else {
			registerIndex.push(commands.length);
			commands.push({
				type: 'media.register',
				asset: p.asset,
				binId,
				name: p.name,
				ref: `$m${i}`,
				itemRef: `$i${i}`,
			} as Command);
			source = `$m${i}`;
		}
		const placeable = p.asset.kind !== 'font' && p.asset.kind !== 'lut' && p.asset.kind !== 'color-config';
		if (!seq || !rate || !placeable) {
			placeIndex.push(null);
			return;
		}
		placeIndex.push(commands.length);
		const tracks = placementTracks(doc, seq.id, target, input.placement);
		commands.push({
			type: 'clip.place',
			sequenceId: seq.id,
			source: { mediaId: source },
			at: cursor,
			...(tracks ? { tracks } : {}),
			mode: target.kind === 'timeline' ? target.mode : 'overwrite',
			ref: `$c${i}`,
		} as Command);
		cursor += placementFrames(doc, p.asset, rate);
	});

	// Source ranges last, so a render can name a source imported in the same batch (any order).
	const table: Record<string, { id: string; originalName: string; fingerprint?: string }> = { ...doc.media };
	prepared.forEach((p, i) => {
		if (registerIndex[i] !== null)
			table[`$m${i}`] = {
				id: `$m${i}`,
				originalName: p.asset.originalName,
				fingerprint: p.asset.fingerprint,
			};
	});
	prepared.forEach((p, i) => {
		if (!p.sourceHint || registerIndex[i] === null) return;
		const sourceRange = sourceRangeFromSidecar({ media: table }, p.sourceHint, {
			probe: p.asset.probe,
			id: `$m${i}`,
			fingerprint: p.asset.fingerprint,
		});
		if (sourceRange)
			commands.push({ type: 'media.setSourceRange', mediaId: `$m${i}`, sourceRange } as Command);
	});

	return {
		tx: commands.length ? { label, origin: 'user', commands } : null,
		registerIndex,
		placeIndex,
	};
}

function placementTracks(
	doc: ProjectDocument,
	sequenceId: string,
	target: ImportTarget,
	placement: ImportPlacementContext | undefined,
): { video?: string; audio?: string } | null {
	const seq = doc.sequences[sequenceId];
	if (!seq) return null;
	if (target.kind === 'timeline') {
		if (seq.videoTracks.some((t) => t.id === target.trackId)) {
			const audio =
				target.audioTrackId && seq.audioTracks.some((t) => t.id === target.audioTrackId)
					? { audio: target.audioTrackId }
					: {};
			return { video: target.trackId, ...audio };
		}
		if (seq.audioTracks.some((t) => t.id === target.trackId)) return { audio: target.trackId };
		return null;
	}
	const t = placement?.targetTracks;
	if (!t) return null;
	const out: { video?: string; audio?: string } = {};
	if (t.video) out.video = t.video;
	if (t.audio) out.audio = t.audio;
	return Object.keys(out).length ? out : null;
}

/** `clip.place` commands for Project items dragged onto the Timeline or Program monitor (S05:PRJ-007). */
export function buildPlaceItemsTransaction(input: {
	doc: ProjectDocument;
	itemIds: string[];
	target: Extract<ImportTarget, { kind: 'timeline' | 'program' }>;
	matchSettings?: SequenceSettingsPatch | null;
	placement?: ImportPlacementContext;
}): { tx: TxInput | null; placeIndex: number[] } {
	const { doc, target } = input;
	const seq = doc.sequences[target.sequenceId];
	if (!seq) return { tx: null, placeIndex: [] };
	const commands: Command[] = [];
	const placeIndex: number[] = [];
	if (input.matchSettings)
		commands.push({
			type: 'sequence.updateSettings',
			sequenceId: seq.id,
			settings: { ...input.matchSettings },
		} as Command);
	const rate = input.matchSettings?.frameRate ?? seq.settings.frameRate;
	let cursor = target.kind === 'timeline' ? target.at : Math.max(0, input.placement?.playheadFrame ?? 0);
	for (const itemId of input.itemIds) {
		const item = doc.items[itemId];
		if (!item || item.kind === 'bin' || item.kind === 'search-bin' || item.kind === 'sequence') continue;
		let frames = 0;
		if (item.kind === 'media') {
			const asset = doc.media[item.mediaId];
			if (!asset || asset.kind === 'font' || asset.kind === 'lut' || asset.kind === 'color-config') continue;
			const marks = item.marks;
			if (asset.kind === 'video' || asset.kind === 'audio') {
				const F = flicksPerFrame(rate);
				const inF = marks.in?.flicks ?? 0;
				const outF = marks.out?.flicks ?? asset.probe.durationFlicks ?? 0;
				frames = Math.max(1, Math.floor(outF / F - inF / F + 1e-9));
			} else frames = placementFrames(doc, asset, rate);
		} else frames = placementFrames(doc, { kind: 'image' } as MediaAsset, rate);
		const tracks = placementTracks(doc, seq.id, target, input.placement);
		placeIndex.push(commands.length);
		commands.push({
			type: 'clip.place',
			sequenceId: seq.id,
			source: { projectItemId: itemId },
			at: cursor,
			...(tracks ? { tracks } : {}),
			mode: target.kind === 'timeline' ? target.mode : 'overwrite',
		} as Command);
		cursor += frames;
	}
	const label = target.kind === 'timeline' && target.mode === 'insert' ? 'Insert' : 'Overwrite';
	return { tx: placeIndex.length ? { label, origin: 'user', commands } : null, placeIndex };
}
