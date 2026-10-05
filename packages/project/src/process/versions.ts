// Processed versions of a media asset (S07:PRC-001…004): the original/version relation and item naming.
import type { ProjectDocument } from '../schema/document.ts';
import type { Derivation, MediaAsset, NativeRecipe, ProcessStep, SourceRange } from '../schema/media.ts';

type MediaTable = Pick<ProjectDocument, 'media'>;

/**
 * Derivations that keep the frame count and rate of their source, so a clip can swap between the source and the
 * derived file without retiming: clip processing (`process`, S07) and plain transcodes.
 */
export function isVersionDerivation(d: Derivation | null | undefined): d is Derivation {
	return !!d && (d.recipe.op === 'process' || d.recipe.op === 'transcode');
}

/**
 * The media a file's frames come from (S07:PRC-015…019), or null for originals: the asset's `sourceRange`
 * when it names a media of the project (a range naming none — an external source — means no link), else
 * (processed versions without a recorded range, M2 documents) the source of a version derivation with the
 * identity mapping.
 */
export type SourceLink = {
	parentId: string;
	/** Source frame shown by the file's first frame (0 for the identity mapping). */
	firstFrame: number;
	/** Rate the source frames are counted at; null = identity mapping by content time (no range recorded). */
	frameRate: SourceRange['frameRate'] | null;
};

export function sourceLinkOf(
	doc: MediaTable,
	asset: Pick<MediaAsset, 'id' | 'sourceRange' | 'derivation'> | undefined | null,
): SourceLink | null {
	if (!asset) return null;
	const sr = asset.sourceRange;
	if (sr) {
		// A recorded range is authoritative: no project source (null / missing media) = no link.
		if (sr.mediaId && sr.mediaId !== asset.id && doc.media[sr.mediaId])
			return { parentId: sr.mediaId, firstFrame: sr.firstFrame, frameRate: sr.frameRate };
		return null;
	}
	const d = asset.derivation;
	if (isVersionDerivation(d) && d.fromMediaId !== asset.id && doc.media[d.fromMediaId])
		return { parentId: d.fromMediaId, firstFrame: 0, frameRate: null };
	return null;
}

/**
 * The original a media asset is a version of: follows the source links (`sourceLinkOf`: processed versions,
 * files declaring a source range of another media) until an asset that has none. Returns the id itself for
 * originals, null when the id is unknown.
 */
export function originalMediaId(doc: MediaTable, mediaId: string): string | null {
	let id = mediaId;
	const seen = new Set<string>();
	for (;;) {
		const m = doc.media[id] as MediaAsset | undefined;
		if (!m) return seen.size === 0 ? null : id;
		if (seen.has(id)) return id; // cycle guard (refused by commands)
		seen.add(id);
		const link = sourceLinkOf(doc, m);
		if (!link) return id;
		id = link.parentId;
	}
}

/** The original and every version of it (original first, then in document order). */
export function mediaVersionsOf(doc: MediaTable, mediaId: string): string[] {
	const original = originalMediaId(doc, mediaId);
	if (!original) return [];
	const versions = Object.keys(doc.media).filter(
		(id) => id !== original && originalMediaId(doc, id) === original,
	);
	return [original, ...versions];
}

/** Label of one processing step in item names, e.g. `Stabilized`, `Upscaled 2×` (S07:PRC-004). */
function processStepLabel(step: ProcessStep): string {
	switch (step.op) {
		case 'stabilize':
			return 'Stabilized';
		case 'dejudder':
			return 'De-juddered';
		case 'denoise':
			return 'Denoised';
		case 'deblock':
			return 'Deblocked';
		case 'upscale':
			return `Upscaled ${step.scale}×`;
		default:
			return String((step as { op: string }).op);
	}
}

const RECIPE_LABELS: Partial<Record<NativeRecipe['op'], string>> = {
	'conform-cfr': 'Conformed',
	reverse: 'Reversed',
	stabilize: 'Stabilized',
	'denoise-audio': 'Audio Denoised',
	'loudness-normalize': 'Normalized',
	'extract-audio': 'Audio',
	transcode: 'Transcoded',
	'time-stretch': 'Time-stretched',
	range: 'Range',
};

/** `frames 1100–1209` (inclusive) for a source range `[startFrame, endFrame)`. */
function frameRangeLabel(range: { startFrame: number; endFrame: number }): string {
	return `frames ${range.startFrame}–${range.endFrame - 1}`;
}

/**
 * `<original name> [<step labels joined with ' · '>]`, e.g. `crudo [Stabilized · Upscaled 2×]`; a version of a
 * source range adds it: `crudo [Denoised · frames 1100–1209]` (S07:PRC-015).
 */
export function processedItemName(
	originalName: string,
	recipe: NativeRecipe,
	range?: { startFrame: number; endFrame: number } | null,
): string {
	const labels =
		recipe.op === 'process' ? recipe.steps.map(processStepLabel) : [RECIPE_LABELS[recipe.op] ?? recipe.op];
	if (range) labels.push(frameRangeLabel(range));
	return `${originalName} [${labels.join(' · ')}]`;
}

/** Name of the auto-created bin that holds processed versions (S07:PRC-004). */
export const PROCESSED_BIN_NAME = 'Processed';
