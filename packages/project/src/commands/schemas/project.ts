import { z } from 'zod';
import { LabelColorSchema } from '../../schema/common.ts';
import { ProjectSettingsSchema } from '../../schema/document.ts';
import {
	MediaAssetSchema,
	MediaKindSchema,
	MediaLocatorSchema,
	MediaProbeSchema,
	NativeRecipeSchema,
} from '../../schema/media.ts';
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
	words: z.array(z.record(z.string(), z.unknown())),
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
	MediaRemoveUnusedCmd,
	SyntheticCreateCmd,
	SyntheticUpdateCmd,
	TranscriptCreateCmd,
	TranscriptEditTextCmd,
	TranscriptSetBreakCmd,
] as const;
