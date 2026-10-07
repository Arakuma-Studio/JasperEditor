import type { z } from 'zod';
import { AUDIO_COMMANDS } from './audio.ts';
import { CAPTION_COMMANDS } from './captions.ts';
import { CLIP_COMMANDS } from './clip.ts';
import { CLIPBOARD_COMMANDS } from './clipboard.ts';
import { EDIT_UX_COMMANDS } from './edit-ux.ts';
import { ESSENTIAL_COMMANDS } from './essential.ts';
import { EXPRESSION_COMMANDS } from './expression.ts';
import { INTERCHANGE_COMMANDS } from './interchange.ts';
import { MASK_COMMANDS } from './mask.ts';
import { MULTICAM_COMMANDS } from './multicam.ts';
import { PARAM_COMMANDS } from './param.ts';
import { PRESET_COMMANDS } from './preset.ts';
import { PROJECT_COMMANDS } from './project.ts';
import { ROTO_COMMANDS } from './roto.ts';
import { SEQUENCE_COMMANDS } from './sequence.ts';
import { SHAPE_COMMANDS } from './shape.ts';
import { SIM_WARP_COMMANDS } from './sim-warp.ts';
import { SIMPLIFY_COMMANDS } from './simplify.ts';
import { SPEECH_COMMANDS } from './speech.ts';
import { STRUCTURE_COMMANDS } from './structure.ts';
import { TEXT_ANIMATOR_COMMANDS } from './text-animators.ts';
import { TRACKER_COMMANDS } from './tracker.ts';

export * from './audio.ts';
export * from './captions.ts';
export * from './clip.ts';
export * from './clipboard.ts';
export * from './common.ts';
export * from './edit-ux.ts';
export * from './essential.ts';
export * from './expression.ts';
export * from './interchange.ts';
export * from './mask.ts';
export * from './multicam.ts';
export * from './param.ts';
export * from './preset.ts';
export * from './project.ts';
export * from './roto.ts';
export * from './sequence.ts';
export * from './shape.ts';
export * from './sim-warp.ts';
export * from './simplify.ts';
export * from './speech.ts';
export * from './structure.ts';
export * from './text-animators.ts';
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
	// wp shapes: vector shape items
	...SHAPE_COMMANDS,
	// text-animators workstream (AE text animators)
	...TEXT_ANIMATOR_COMMANDS,
	// Timeline interchange (wp interchange)
	...INTERCHANGE_COMMANDS,
	// Synchronize, Merge Clips, multi-camera (wp-multicam)
	...MULTICAM_COMMANDS,
	// Audio buses (audio-mix)
	...AUDIO_COMMANDS,
	// edit-structure (nests, frame holds, through edits, subsequences)
	...STRUCTURE_COMMANDS,
	// wp masks (S03 §17)
	...MASK_COMMANDS,
	// sim-warp: Liquify, Mesh Warp, Puppet
	...SIM_WARP_COMMANDS,
	// wp captions
	...CAPTION_COMMANDS,
	// wp speech
	...SPEECH_COMMANDS,
	// Expressions (wave expressions)
	...EXPRESSION_COMMANDS,
	// Essential Sound and Remix (audio-fx)
	...ESSENTIAL_COMMANDS,
	// parity: roto / object mattes
	...ROTO_COMMANDS,
	// edit-ux: 3/4-point editing, multi-edit trims, subclips
	...EDIT_UX_COMMANDS,
] as const;

export type Command = z.infer<(typeof ALL_COMMAND_SCHEMAS)[number]>;
export type CommandType = Command['type'];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;
