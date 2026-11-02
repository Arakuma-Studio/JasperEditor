// Spec 19 TL-018: the commands of Title Looks. Paints, gradients and recipes travel as `z.unknown()` here and are checked
// by the handlers, so a limit overflow is refused with `E_LIMIT` (TL-013) rather than a schema error.
import { z } from 'zod';
import {
	LookColorSchema,
	LookQuickControlSchema,
	MAX_QUICK_CONTROLS,
	MAX_TITLE_LOOK_NAME,
	RoleSchema,
} from '../../title-looks/model.ts';
import { cmd, IdListSchema, IdRefSchema, RefDeclSchema, TimeInputSchema, TrackRefSchema } from './common.ts';

const LookName = z.string().trim().min(1).max(MAX_TITLE_LOOK_NAME);
const FxRef = { effectInstanceId: IdRefSchema };

/** A look to copy into the project: a recipe and its metadata (library, imported or agent looks, TL-015). */
export const LookSourceSchema = z.strictObject({
	name: LookName,
	recipe: z.unknown(),
	sourceId: z.string().min(1).max(128).optional(),
	tags: z.array(z.string().max(64)).max(64).optional(),
	category: z.string().max(64).optional(),
	colorways: z.array(z.unknown()).max(64).optional(),
	quickControls: z.array(LookQuickControlSchema).max(MAX_QUICK_CONTROLS).optional(),
});

export const PalettePatchSchema = z.partialRecord(RoleSchema, LookColorSchema);

export const LookApplyCmd = cmd('look.apply', {
	clipIds: IdListSchema,
	/** A project look, or a factory library id (copied into the project on first use). */
	lookId: z.string().min(1).max(128).optional(),
	/** A look given whole (user library, agent recipe); it is copied into the project. */
	look: LookSourceSchema.optional(),
	colorwayId: z.string().min(1).max(128).optional(),
	/** The appearance seed (default: kept on clips that have a look, else a new one per clip). */
	seed: z.number().int().min(0).max(0xffff_ffff).optional(),
});
export const LookRemoveCmd = cmd('look.remove', { clipIds: IdListSchema });
export const LookDetachCmd = cmd('look.detach', { clipIds: IdListSchema });
export const LookResetCmd = cmd('look.reset', {
	clipIds: IdListSchema,
	/** Only these layers go back to the look (default: the whole appearance, its added and removed layers too). */
	layerIds: z.array(IdRefSchema).min(1).max(64).optional(),
});
export const LookSetColorwayCmd = cmd('look.setColorway', {
	clipIds: IdListSchema,
	/** A colourway of the linked look or of the library. */
	colorwayId: z.string().min(1).max(128).optional(),
	/** Role values given directly (a user colourway); `colorwayId` then only names them. */
	palette: PalettePatchSchema.optional(),
});
export const LookCreateCmd = cmd('look.create', {
	name: LookName,
	/** Start from this clip's appearance, at its first frame (TL-015: keyframes stay on clips). */
	fromClipId: IdRefSchema.optional(),
	/** Or from a recipe. */
	recipe: z.unknown().optional(),
	/** Link `fromClipId` to the new look. */
	link: z.boolean().optional(),
	tags: z.array(z.string().max(64)).max(64).optional(),
	category: z.string().max(64).optional(),
	id: z.string().optional(),
	ref: RefDeclSchema.optional(),
});
export const LookUpdateCmd = cmd('look.update', {
	lookId: IdRefSchema,
	/** Redefine the look as this clip's appearance. */
	fromClipId: IdRefSchema.optional(),
	/** Or as this recipe. */
	recipe: z.unknown().optional(),
});
export const LookRenameCmd = cmd('look.rename', { lookId: IdRefSchema, name: LookName });
export const LookDeleteCmd = cmd('look.delete', { lookId: IdRefSchema });

export const AppearanceAddLayerCmd = cmd('appearance.addLayer', {
	...FxRef,
	layerType: z.string().min(1).max(64),
	/** Stack position, bottom-first (default: the top). */
	index: z.number().int().min(0).optional(),
	name: z.string().max(MAX_TITLE_LOOK_NAME).optional(),
	params: z.record(z.string(), z.unknown()).optional(),
	ref: RefDeclSchema.optional(),
});
export const AppearanceRemoveLayerCmd = cmd('appearance.removeLayer', { ...FxRef, layerId: IdRefSchema });
export const AppearanceReorderLayerCmd = cmd('appearance.reorderLayer', {
	...FxRef,
	layerId: IdRefSchema,
	index: z.number().int().min(0),
});
export const AppearanceSetLayerEnabledCmd = cmd('appearance.setLayerEnabled', {
	...FxRef,
	layerId: IdRefSchema,
	enabled: z.boolean(),
});
export const AppearanceSetPaintCmd = cmd('appearance.setPaint', {
	...FxRef,
	layerId: IdRefSchema,
	/** The paint param (default `paint`). */
	param: z.string().min(1).max(64).optional(),
	paint: z.unknown(),
});
export const AppearanceSetGradientCmd = cmd('appearance.setGradient', {
	...FxRef,
	layerId: IdRefSchema,
	param: z.string().min(1).max(64).optional(),
	gradient: z.unknown(),
});
export const SequenceSetGlobalLightCmd = cmd('sequence.setGlobalLight', {
	sequenceId: IdRefSchema.optional(),
	angle: z.number().min(-3600).max(3600).optional(),
	altitude: z.number().min(0).max(90).optional(),
	/** Removes it (looks that follow it use their own light again). */
	clear: z.boolean().optional(),
});
export const ClipAddGeneratorCmd = cmd('clip.addGenerator', {
	sequenceId: IdRefSchema.optional(),
	/** An effect of the `Generate` category (or `generator:<id>`). */
	effectId: z.string().min(1).max(128),
	at: TimeInputSchema,
	duration: TimeInputSchema,
	/** Where it goes: the lowest track to consider (default V1). */
	track: TrackRefSchema.optional(),
	/** TL-064: a free track below this title, when one exists; else above it. */
	belowClipId: IdRefSchema.optional(),
	params: z.record(z.string(), z.unknown()).optional(),
	name: z.string().min(1).max(MAX_TITLE_LOOK_NAME).optional(),
	id: z.string().optional(),
	ref: RefDeclSchema.optional(),
});

export const TITLE_LOOK_COMMANDS = [
	LookApplyCmd,
	LookRemoveCmd,
	LookDetachCmd,
	LookResetCmd,
	LookSetColorwayCmd,
	LookCreateCmd,
	LookUpdateCmd,
	LookRenameCmd,
	LookDeleteCmd,
	AppearanceAddLayerCmd,
	AppearanceRemoveLayerCmd,
	AppearanceReorderLayerCmd,
	AppearanceSetLayerEnabledCmd,
	AppearanceSetPaintCmd,
	AppearanceSetGradientCmd,
	SequenceSetGlobalLightCmd,
	ClipAddGeneratorCmd,
] as const;
