import type { z } from 'zod';
import { CLIP_COMMANDS } from './clip.ts';
import { PARAM_COMMANDS } from './param.ts';
import { PROJECT_COMMANDS } from './project.ts';
import { SEQUENCE_COMMANDS } from './sequence.ts';

export * from './clip.ts';
export * from './common.ts';
export * from './param.ts';
export * from './project.ts';
export * from './sequence.ts';

/** Every document command schema (M1 + M2), keyed by nothing: see `catalog.ts` for registration. */
export const ALL_COMMAND_SCHEMAS = [
	...PROJECT_COMMANDS,
	...SEQUENCE_COMMANDS,
	...CLIP_COMMANDS,
	...PARAM_COMMANDS,
] as const;

export type Command = z.infer<(typeof ALL_COMMAND_SCHEMAS)[number]>;
export type CommandType = Command['type'];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;
