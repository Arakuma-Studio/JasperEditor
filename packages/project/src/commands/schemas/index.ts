import type { z } from 'zod';
import { AUDIO_COMMANDS } from './audio.ts';
import { CAPTION_COMMANDS } from './captions.ts';
import { CLIP_COMMANDS } from './clip.ts';
import { CLIPBOARD_COMMANDS } from './clipboard.ts';
import { COLOR_MGMT_COMMANDS } from './color-mgmt.ts';
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
import { SHAPE_TRIM_COMMANDS } from './shape-trim.ts';
import { SIM_WARP_COMMANDS } from './sim-warp.ts';
import { SIMPLIFY_COMMANDS } from './simplify.ts';
import { SPEECH_COMMANDS } from './speech.ts';
import { STRUCTURE_COMMANDS } from './structure.ts';
import { TEXT_ANIMATOR_COMMANDS } from './text-animators.ts';
import { THREE_D_COMMANDS } from './three-d.ts';
import { TIME_COMMANDS } from './time.ts';
import { TRACKER_COMMANDS } from './tracker.ts';

export * from './audio.ts';
export * from './captions.ts';
export * from './clip.ts';
export * from './clipboard.ts';
export * from './color-mgmt.ts';
export * from './common.ts';
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
export * from './shape-trim.ts';
export * from './sim-warp.ts';
export * from './simplify.ts';
export * from './speech.ts';
export * from './structure.ts';
export * from './text-animators.ts';
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
] as const;

export type CommandInput = z.input<(typeof ALL_COMMAND_SCHEMAS)[number]>;
export type Command = z.infer<(typeof ALL_COMMAND_SCHEMAS)[number]>;
export type CommandType = Command['type'];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;
