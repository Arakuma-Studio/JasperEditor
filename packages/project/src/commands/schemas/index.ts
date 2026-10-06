import type { z } from 'zod';
import { CLIP_COMMANDS } from './clip.ts';
import { CLIPBOARD_COMMANDS } from './clipboard.ts';
import { EDIT_UX_COMMANDS } from './edit-ux.ts';
import { PARAM_COMMANDS } from './param.ts';
import { PRESET_COMMANDS } from './preset.ts';
import { PROJECT_COMMANDS } from './project.ts';
import { SEQUENCE_COMMANDS } from './sequence.ts';
import { SIMPLIFY_COMMANDS } from './simplify.ts';
import { TRACKER_COMMANDS } from './tracker.ts';

export * from './clip.ts';
export * from './clipboard.ts';
export * from './common.ts';
export * from './edit-ux.ts';
export * from './param.ts';
export * from './preset.ts';
export * from './project.ts';
export * from './sequence.ts';
export * from './simplify.ts';
export * from './tracker.ts';

/** Every document command schema (M1 + M2), keyed by nothing: see `catalog.ts` for registration. */
export const ALL_COMMAND_SCHEMAS = [
	...PROJECT_COMMANDS,
	...SEQUENCE_COMMANDS,
	...CLIP_COMMANDS,
	...PARAM_COMMANDS,
	...TRACKER_COMMANDS,
	// wp-m3-trackui (S09:TRK-023)
	...SIMPLIFY_COMMANDS,
	// wp-clipboard (S01 §20)
	...CLIPBOARD_COMMANDS,
	// Effect presets (S03:FX-030)
	...PRESET_COMMANDS,
	// edit-ux: 3/4-point editing, multi-edit trims, subclips
	...EDIT_UX_COMMANDS,
] as const;

export type Command = z.infer<(typeof ALL_COMMAND_SCHEMAS)[number]>;
export type CommandType = Command['type'];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;
