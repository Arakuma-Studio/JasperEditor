// Transcript cleanup commands (spec 14 TC-030, TC-031; docs/wp-notes/transcript-cleanup.md "Commands").
import { z } from 'zod';
import {
	CleanupFingerprintSchema,
	CleanupListLanguageSchema,
	CleanupListsSchema,
	CleanupOverridesSchema,
	CleanupScriptSchema,
} from '../../cleanup/schema.ts';
import { cmd, IdRefSchema } from './common.ts';

/** Most ranges one `cleanup.apply` takes. */
export const CLEANUP_APPLY_MAX_RANGES = 100_000;

/** A range in sequence frames `[start, end)`… */
export const CleanupSequenceRangeSchema = z.strictObject({
	start: z.number().int().min(0),
	end: z.number().int().min(1),
});
/** … or in the media time (flicks) of a clip, mapped through its placement (100 % speed, forward). */
export const CleanupSourceRangeSchema = z.strictObject({
	clipId: IdRefSchema,
	start: z.number().int().min(0),
	end: z.number().int().min(1),
});

export const CleanupApplyCmd = cmd('cleanup.apply', {
	sequenceId: IdRefSchema.optional(),
	/** The speech clips (default: the clips of source ranges, else every transcribed audio clip). */
	clipIds: z.array(IdRefSchema).min(1).optional(),
	ranges: z
		.array(z.union([CleanupSourceRangeSchema, CleanupSequenceRangeSchema]))
		.min(1)
		.max(CLEANUP_APPLY_MAX_RANGES),
	/**
	 * `extract` (default): ripple delete on the speech clips' tracks, their linked partners' and clip groups' tracks;
	 * unlocked sync-locked tracks follow. `lift`: leave gaps. `mute`: Volume keys down to −∞ dB over the ranges (with
	 * `fadeMs` ramps, at least 1 ms). `markers`: one range marker per range, nothing else changes.
	 */
	mode: z.enum(['extract', 'lift', 'mute', 'markers']).optional(),
	/** Equal-power micro-fade at every audio cut edge (ms, default 0 = none). */
	fadeMs: z.number().min(0).max(30).optional(),
	/** J / L offset of the sound at every join (frames; > 0 the incoming sound leads; extract only). */
	jlFrames: z.number().int().min(-30).max(30).optional(),
	/** Name of the markers of `markers` mode (default "Clean Up"). */
	markerName: z.string().max(200).optional(),
});

export const CleanupConfigureCmd = cmd('cleanup.configure', {
	sequenceId: IdRefSchema.optional(),
	/** Preset and overrides; null resets to Fast with no overrides. */
	settings: z
		.strictObject({
			/** `builtin.fast`, `builtin.natural` or a user preset id. */
			presetId: z.string().min(1).max(200).optional(),
			overrides: CleanupOverridesSchema.optional(),
		})
		.nullable()
		.optional(),
	/** true: `settings.overrides` are merged into the stored overrides group by group (default: replace them). */
	mergeOverrides: z.boolean().optional(),
	/** The script (plain text, ≤ 256 KB); null detaches it. */
	script: CleanupScriptSchema.nullable().optional(),
	/** Edited word lists per language (`es`, `en`…); null for a language goes back to the built-in lists. */
	lists: z.record(CleanupListLanguageSchema, CleanupListsSchema.nullable()).optional(),
	/** Finding fingerprints to remember as rejected… */
	reject: z.array(CleanupFingerprintSchema).max(20_000).optional(),
	/** … to forget… */
	unreject: z.array(CleanupFingerprintSchema).max(20_000).optional(),
	/** … or forget them all (before `reject`). */
	clearRejected: z.boolean().optional(),
});

export const CLEANUP_COMMANDS = [CleanupApplyCmd, CleanupConfigureCmd] as const;
