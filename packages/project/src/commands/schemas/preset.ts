// Effect presets (S03:FX-030, AGT-002 `presets.apply`, AGT-020). The preset travels inline (the editor and the
// MCP server resolve library ids to the JSON first), so the command is pure and works headless; the handler
// validates it with the preset schema before anything is read from it.
import { z } from 'zod';
import { cmd, IdListSchema } from './common.ts';

export const EffectPresetArgSchema = z
	.record(z.string(), z.unknown())
	.describe(
		'An effect preset {format: "jasper-effect-preset", version: 1, id, name, type: "scale" | "anchor-in" | "anchor-out", source: {duration, frameRate}, intrinsic?, effects?} as returned by list_effect_presets / get_effect_preset',
	);

/**
 * Applies a preset to clips (one undo entry for N clips): intrinsic properties (Motion, Opacity, Crop, Volume,
 * Panner) are overwritten, applied effects are appended (or inserted at `index`) with new instance ids; key times
 * map per the preset type onto each clip.
 */
export const EffectApplyPresetCmd = cmd('effect.applyPreset', {
	preset: EffectPresetArgSchema,
	clipIds: IdListSchema,
	/** Insert position of the preset's applied effects in each stack (default: appended). */
	index: z.number().int().min(0).optional(),
});

export const PRESET_COMMANDS = [EffectApplyPresetCmd] as const;
