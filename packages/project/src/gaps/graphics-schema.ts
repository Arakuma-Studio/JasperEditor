// Essential Graphics data (workstream gaps, §GR-4/5): the schemas only (the sequence schema imports them).
import { z } from 'zod';

export const ROLL_MODES = ['roll', 'crawlLeft', 'crawlRight'] as const;
export const GraphicRollSchema = z.looseObject({
	mode: z.enum(ROLL_MODES),
	startOffScreen: z.boolean(),
	endOffScreen: z.boolean(),
	/** Frames. */
	preRoll: z.number().int().min(0).max(1_000_000),
	easeIn: z.number().int().min(0).max(1_000_000),
	easeOut: z.number().int().min(0).max(1_000_000),
	postRoll: z.number().int().min(0).max(1_000_000),
});
export type GraphicRoll = z.infer<typeof GraphicRollSchema>;

export const GraphicSettingsSchema = z.looseObject({
	/** Responsive Design – Time: protected Intro / Outro durations in frames (0 = none). */
	intro: z.number().int().min(0).max(1_000_000),
	outro: z.number().int().min(0).max(1_000_000),
	roll: GraphicRollSchema.nullable().optional(),
});
export type GraphicSettings = z.infer<typeof GraphicSettingsSchema>;

export const PIN_EDGES = ['left', 'top', 'right', 'bottom'] as const;
export type PinEdge = (typeof PIN_EDGES)[number];
/** Responsive Design – Position of a layer: pinned edges, the target ('frame' or a layer clip id) and the offsets. */
export const LayerPinsSchema = z.looseObject({
	target: z.string().min(1),
	/** Offset (px) of each pinned edge of the layer from the same edge of the target. */
	edges: z.partialRecord(z.enum(PIN_EDGES), z.number()),
});
export type LayerPins = z.infer<typeof LayerPinsSchema>;

