import type { z } from 'zod';
import { AUDIO_COMMANDS } from './audio.ts';
import { BATCH_COMMANDS } from './batch.ts';
import { CAPTION_COMMANDS } from './captions.ts';
import { CLEANUP_COMMANDS } from './cleanup.ts';
import { CLIP_COMMANDS } from './clip.ts';
import { CLIPBOARD_COMMANDS } from './clipboard.ts';
import { COLOR_MGMT_COMMANDS } from './color-mgmt.ts';
import { EASE_COMMANDS } from './ease.ts';
import { EDIT_UX_COMMANDS } from './edit-ux.ts';
import { ESSENTIAL_COMMANDS } from './essential.ts';
import { EXPRESSION_COMMANDS } from './expression.ts';
import { GAPS_COMMANDS } from './gaps.ts';
import { INTERCHANGE_COMMANDS } from './interchange.ts';
import { INTERPRET_COMMANDS } from './interpret.ts';
import { MASK_COMMANDS } from './mask.ts';
import { MULTICAM_COMMANDS } from './multicam.ts';
import { PARAM_COMMANDS } from './param.ts';
import { PRESET_COMMANDS } from './preset.ts';
import { PREVIEWS_COMMANDS } from './previews.ts';
import { PROJECT_COMMANDS } from './project.ts';
import { ROTO_COMMANDS } from './roto.ts';
import { SEQUENCE_COMMANDS } from './sequence.ts';
import { SHAPE_COMMANDS } from './shape.ts';
import { SHAPE_TRACER_COMMANDS } from './shape-tracer.ts';
import { SHAPE_TRIM_COMMANDS } from './shape-trim.ts';
import { SIM_WARP_COMMANDS } from './sim-warp.ts';
import { SIMPLIFY_COMMANDS } from './simplify.ts';
import { SOUND_COMMANDS } from './sound.ts';
import { SOUND_BED_COMMANDS } from './sound-beds.ts';
import { SOUND_MIX_COMMANDS } from './sound-mix.ts';
import { SPEECH_COMMANDS } from './speech.ts';
import { STRUCTURE_COMMANDS } from './structure.ts';
import { STYLE_RECIPE_COMMANDS } from './style-recipes.ts';
import { SUBTITLE_COMMANDS } from './subtitles.ts';
import { TEXT_ANIMATOR_COMMANDS } from './text-animators.ts';
import { TEXT_STYLE_COMMANDS } from './text-style.ts';
import { THREE_D_COMMANDS } from './three-d.ts';
import { TIME_COMMANDS } from './time.ts';
import { TRACKER_COMMANDS } from './tracker.ts';

export * from './audio.ts';
export * from './batch.ts';
export * from './captions.ts';
export * from './cleanup.ts';
export * from './clip.ts';
export * from './clipboard.ts';
export * from './color-mgmt.ts';
export * from './common.ts';
export * from './ease.ts';
export * from './edit-ux.ts';
export * from './essential.ts';
export * from './expression.ts';
export * from './gaps.ts';
export * from './interchange.ts';
export * from './interpret.ts';
export * from './mask.ts';
export * from './multicam.ts';
export * from './param.ts';
export * from './preset.ts';
export * from './previews.ts';
export * from './project.ts';
export * from './roto.ts';
export * from './sequence.ts';
export * from './shape.ts';
export * from './shape-tracer.ts';
export * from './shape-trim.ts';
export * from './sim-warp.ts';
export * from './simplify.ts';
export * from './sound.ts';
export * from './sound-beds.ts';
export * from './sound-mix.ts';
export * from './speech.ts';
export * from './structure.ts';
export * from './subtitles.ts';
export * from './text-animators.ts';
export * from './text-style.ts';
export * from './three-d.ts';
export * from './time.ts';
export * from './tracker.ts';

/** Every document command schema (M1 + M2), keyed by nothing: see `catalog.ts` for registration. */
export const ALL_COMMAND_SCHEMAS = [
	...PROJECT_COMMANDS,
	...SEQUENCE_COMMANDS,
	...CLIP_COMMANDS,
	...PARAM_COMMANDS,
	...TRACKER_COMMANDS,
	...SIMPLIFY_COMMANDS,
	...CLIPBOARD_COMMANDS,
	...PRESET_COMMANDS,
	...SHAPE_COMMANDS,
	...SHAPE_TRIM_COMMANDS,
	...SHAPE_TRACER_COMMANDS,
	...TEXT_ANIMATOR_COMMANDS,
	...INTERCHANGE_COMMANDS,
	...MULTICAM_COMMANDS,
	...AUDIO_COMMANDS,
	...STRUCTURE_COMMANDS,
	...MASK_COMMANDS,
	...SIM_WARP_COMMANDS,
	...CAPTION_COMMANDS,
	...SPEECH_COMMANDS,
	...EXPRESSION_COMMANDS,
	...ESSENTIAL_COMMANDS,
	...TIME_COMMANDS,
	...ROTO_COMMANDS,
	...EDIT_UX_COMMANDS,
	...COLOR_MGMT_COMMANDS,
	...THREE_D_COMMANDS,
	...INTERPRET_COMMANDS,
	...PREVIEWS_COMMANDS,
	...GAPS_COMMANDS,
	...EASE_COMMANDS,
	...SOUND_COMMANDS,
	...SOUND_MIX_COMMANDS,
	...SOUND_BED_COMMANDS,
	...TEXT_STYLE_COMMANDS,
	...SUBTITLE_COMMANDS,
	...BATCH_COMMANDS,
	...CLEANUP_COMMANDS,
	...STYLE_RECIPE_COMMANDS,
] as const;

export type CommandInput = z.input<(typeof ALL_COMMAND_SCHEMAS)[number]>;
export type Command = z.infer<(typeof ALL_COMMAND_SCHEMAS)[number]>;
export type CommandType = Command['type'];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;
