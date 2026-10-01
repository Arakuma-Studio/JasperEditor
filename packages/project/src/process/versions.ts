// Processed versions of a media asset (S07:PRC-001…004): the original/version relation and item naming.
import type { ProjectDocument } from '../schema/document.ts';
import type { Derivation, MediaAsset, NativeRecipe, ProcessStep } from '../schema/media.ts';

type MediaTable = Pick<ProjectDocument, 'media'>;

/**
 * Derivations that keep the frame count and rate of their source, so a clip can swap between the source and the
 * derived file without retiming: clip processing (`process`, S07) and plain transcodes.
 */
export function isVersionDerivation(d: Derivation | null | undefined): d is Derivation {
	return !!d && (d.recipe.op === 'process' || d.recipe.op === 'transcode');
}

/**
 * The original a media asset is a version of: follows `derivation.fromMediaId` through version derivations
 * (`isVersionDerivation`) until an asset that is not one. Returns the id itself for originals, null when the id
 * is unknown.
 */
export function originalMediaId(doc: MediaTable, mediaId: string): string | null {
	let id = mediaId;
	const seen = new Set<string>();
	for (;;) {
		const m = doc.media[id] as MediaAsset | undefined;
		if (!m) return seen.size === 0 ? null : id;
		if (seen.has(id)) return id; // cycle guard (never produced by commands)
		seen.add(id);
		if (!isVersionDerivation(m.derivation) || !doc.media[m.derivation.fromMediaId]) return id;
		id = m.derivation.fromMediaId;
	}
}

/** The original and every processed version of it (original first, then in document order). */
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

/** `<original name> [<step labels joined with ' · '>]`, e.g. `crudo [Stabilized · Upscaled 2×]`. */
export function processedItemName(originalName: string, recipe: NativeRecipe): string {
	const labels =
		recipe.op === 'process' ? recipe.steps.map(processStepLabel) : [RECIPE_LABELS[recipe.op] ?? recipe.op];
	return `${originalName} [${labels.join(' · ')}]`;
}

/** Name of the auto-created bin that holds processed versions (S07:PRC-004). */
export const PROCESSED_BIN_NAME = 'Processed';
