import { z } from 'zod';
import { LabelColorSchema } from '../../schema/common.ts';
import { ProjectSettingsSchema } from '../../schema/document.ts';
import {
	LutInfoSchema,
	MediaAssetSchema,
	MediaKindSchema,
	MediaLocatorSchema,
	MediaProbeSchema,
	MgBundleInfoSchema,
	NativeRecipeSchema,
	SourceRangeSchema,
} from '../../schema/media.ts';
import { SourceFitSchema } from './clip.ts';
import { ContentTimeInputSchema, cmd, IdListSchema, IdRefSchema, RefDeclSchema } from './common.ts';

export const ProjectRenameCmd = cmd('project.rename', { name: z.string().min(1) });
export const ProjectUpdateSettingsCmd = cmd('project.updateSettings', {
	settings: ProjectSettingsSchema.partial(),
});

export const BinCreateCmd = cmd('bin.create', {
	name: z.string().min(1),
	parentBinId: IdRefSchema.nullable().optional(),
	index: z.number().int().min(0).optional(),
	ref: RefDeclSchema.optional(),
	id: z.string().optional(),
});
export const ItemRenameCmd = cmd('item.rename', { itemIds: IdListSchema, name: z.string().min(1) });
export const ItemSetLabelCmd = cmd('item.setLabel', { itemIds: IdListSchema, label: LabelColorSchema });
export const ItemMoveCmd = cmd('item.move', {
	itemIds: IdListSchema,
	toBinId: IdRefSchema.nullable(),
	index: z.number().int().min(0).optional(),
});
export const ItemDeleteCmd = cmd('item.delete', { itemIds: IdListSchema, force: z.boolean().optional() });
export const ItemSetMarksCmd = cmd('item.setMarks', {
	itemId: IdRefSchema,
	in: ContentTimeInputSchema.nullable(),
	out: ContentTimeInputSchema.nullable(),
	/**
	 * edit-ux (Mark Split): separate video/audio marks. Absent = keep the current split marks; a field set to null
	 * clears it; `split: null` clears all four.
	 */
	split: z
		.strictObject({
			videoIn: ContentTimeInputSchema.nullable().optional(),
			videoOut: ContentTimeInputSchema.nullable().optional(),
			audioIn: ContentTimeInputSchema.nullable().optional(),
			audioOut: ContentTimeInputSchema.nullable().optional(),
		})
		.nullable()
		.optional(),
});

/** `media.register`: `asset.id` may be omitted (generated) or be a temp ref. */
export const MediaRegisterCmd = cmd('media.register', {
	asset: MediaAssetSchema.extend({
		id: z.string().optional(),
		importedAt: z.string().optional(),
		derivation: MediaAssetSchema.shape.derivation.optional(),
	}),
	binId: IdRefSchema.nullable().optional(),
	name: z.string().optional(),
	label: LabelColorSchema.optional(),
	ref: RefDeclSchema.optional(),
	itemRef: RefDeclSchema.optional(),
});
export const MediaRelinkCmd = cmd('media.relink', {
	mediaId: IdRefSchema,
	locator: MediaLocatorSchema,
	probe: MediaProbeSchema.optional(),
	fingerprint: z.string().optional(),
	force: z.boolean().optional(),
	/**
	 * M2 (S08:MGC-013, additive): a rebuilt Remotion bundle — the new header (bundle hash, compositions). On an
	 * `mg-bundle` asset a changed fingerprint is accepted without `force` (the content address changes with
	 * every rebuild).
	 */
	mgBundle: MgBundleInfoSchema.optional(),
	/** M2 (S06, additive): an updated LUT header. */
	lut: LutInfoSchema.optional(),
	/** M2 (additive): new size and container of the relinked file. */
	sizeBytes: z.number().int().min(0).optional(),
	originalName: z.string().optional(),
	/**
	 * M3 (S07:PRC-018, additive) — Replace Footage: the file is a different rendering, not the same bytes moved.
	 * A changed fingerprint is accepted without `force`; `locators` replaces every locator (the old file's paths
	 * would point at the wrong bytes) and `container` updates the container.
	 */
	replace: z.boolean().optional(),
	locators: z.array(MediaLocatorSchema).min(1).optional(),
	container: z.string().optional(),
	/** The new file's source range (sidecar), or null to clear it; absent = unchanged. */
	sourceRange: SourceRangeSchema.nullable().optional(),
	/**
	 * Keep source timing: every clip using the media is moved in content time so it shows the same source frames
	 * (by declared source ranges, else by start timecode — `sourceTimingShift`). Default false: content time is
	 * kept as is.
	 */
	keepSourceTiming: z.boolean().optional(),
	/** When keeping source timing: what to do with clips the new file does not cover (default `refuse`). */
	fit: SourceFitSchema.optional(),
});
export const MediaDeriveCmd = cmd('media.derive', {
	fromMediaId: IdRefSchema,
	recipe: NativeRecipeSchema,
	/**
	 * The engine-produced file (M2, S07:PRC-060): the `RegisteredMedia` fields of the processed version. The new
	 * asset gets `derivation = {fromMediaId, recipe, recipeVersion, recipeHash}`.
	 */
	asset: z
		.looseObject({
			fingerprint: z.string(),
			originalName: z.string(),
			sizeBytes: z.number().int().min(0),
			container: z.string(),
			probe: MediaProbeSchema,
			locators: z.array(MediaLocatorSchema).min(1),
			recipeVersion: z.number().int(),
			recipeHash: z.string(),
		})
		.optional(),
	binId: IdRefSchema.nullable().optional(),
	replaceInClips: z.array(IdRefSchema).optional(),
	ref: RefDeclSchema.optional(),
	/**
	 * M3 (S07:PRC-015, additive): the source frames `[startFrame, endFrame)` (at the source's rate) the engine
	 * processed; absent = the whole source. Recorded as the version's `sourceRange`; swapped clips are remapped.
	 */
	range: z.looseObject({ startFrame: z.number().int().min(0), endFrame: z.number().int().min(1) }).optional(),
	/** M3 (additive): what `replaceInClips` does with clips the version does not cover (default `refuse`). */
	fit: SourceFitSchema.optional(),
});
/** M3 (S07:PRC-019): declares (or clears) the source frames a media file holds. Does not move any clip. */
export const MediaSetSourceRangeCmd = cmd('media.setSourceRange', {
	mediaId: IdRefSchema,
	sourceRange: SourceRangeSchema.nullable(),
});
export const MediaRemoveUnusedCmd = cmd('media.removeUnused', {
	kinds: z.array(MediaKindSchema).optional(),
});

export const SyntheticCreateCmd = cmd('synthetic.create', {
	kind: z.enum([
		'color-matte',
		'adjustment',
		'transparent',
		'black-video',
		'bars-and-tone',
		'counting-leader',
	]),
	params: z.record(z.string(), z.unknown()).optional(),
	binId: IdRefSchema.nullable().optional(),
	name: z.string().optional(),
	ref: RefDeclSchema.optional(),
});
export const SyntheticUpdateCmd = cmd('synthetic.update', {
	syntheticId: IdRefSchema,
	params: z.record(z.string(), z.unknown()),
});

export const TranscriptCreateCmd = cmd('transcript.create', {
	mediaId: IdRefSchema.nullable(),
	language: z.string(),
	origin: z.enum(['whisper-local', 'cloud-asr', 'subtitle-file', 'manual']),
	/** `{text, start, end}` (flicks of media time) plus optional `confidence`, `speaker` (a key of `speakers`), `breakBefore`. */
	words: z.array(z.record(z.string(), z.unknown())),
	/** wp captions: speaker names by key (default: a `Speaker N` entry per key used by the words). */
	speakers: z.record(z.string(), z.looseObject({ name: z.string() })).optional(),
	id: z.string().optional(),
	ref: RefDeclSchema.optional(),
});
export const TranscriptEditTextCmd = cmd('transcript.editText', {
	transcriptId: IdRefSchema,
	fromWord: z.number().int().min(0),
	toWord: z.number().int().min(0),
	text: z.string(),
});
export const TranscriptSetBreakCmd = cmd('transcript.setBreak', {
	transcriptId: IdRefSchema,
	wordIndex: z.number().int().min(0),
	breakBefore: z.enum(['none', 'line', 'segment']),
});

export const PROJECT_COMMANDS = [
	ProjectRenameCmd,
	ProjectUpdateSettingsCmd,
	BinCreateCmd,
	ItemRenameCmd,
	ItemSetLabelCmd,
	ItemMoveCmd,
	ItemDeleteCmd,
	ItemSetMarksCmd,
	MediaRegisterCmd,
	MediaRelinkCmd,
	MediaDeriveCmd,
	MediaSetSourceRangeCmd,
	MediaRemoveUnusedCmd,
	SyntheticCreateCmd,
	SyntheticUpdateCmd,
	TranscriptCreateCmd,
	TranscriptEditTextCmd,
	TranscriptSetBreakCmd,
] as const;
