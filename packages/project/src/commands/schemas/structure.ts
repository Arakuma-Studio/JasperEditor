// edit-structure (docs/wp-notes/edit-structure.md): commands of nested sequences, frame holds, through edits and
// subsequences that did not exist in the M1/M2 catalogue. Ported semantics from FilmCraft
// `crates/engine/src/{clip_ops,sequence_tools,multicam}.rs` (MIT OR Apache-2.0).
import { z } from 'zod';
import {
	ContentTimeInputSchema,
	cmd,
	IdListSchema,
	IdRefSchema,
	RefDeclSchema,
	TimeInputSchema,
	TrackRefSchema,
} from './common.ts';

/** Clip ▸ Unnest: replace nest clips by the clips they show (the nested sequence stays in the project). */
export const ClipUnnestCmd = cmd('clip.unnest', { clipIds: IdListSchema });

/**
 * Clip ▸ Video Options ▸ Add Frame Hold: each clip under `at` (the given clips, else the video clips there on
 * `tracks`, default every unlocked video track's topmost clip) is split at `at` and its right part holds the frame
 * shown at `at` until its end.
 */
export const ClipAddFrameHoldCmd = cmd('clip.addFrameHold', {
	sequenceId: IdRefSchema.optional(),
	at: TimeInputSchema,
	clipIds: IdListSchema.optional(),
	tracks: z.array(TrackRefSchema).min(1).optional(),
});

/**
 * Clip ▸ Video Options ▸ Insert Frame Hold Segment: splits the clip at `at` and inserts a segment holding the frame
 * shown at `at` (default 2 seconds); later material on its track and on sync-locked tracks moves right.
 */
export const ClipInsertFrameHoldSegmentCmd = cmd('clip.insertFrameHoldSegment', {
	clipId: IdRefSchema,
	at: TimeInputSchema,
	duration: TimeInputSchema.optional(),
	rippleMarkers: z.boolean().optional(),
});

/**
 * Clip ▸ Video Options ▸ Frame Hold Options…: `enabled: false` removes the hold. `holdOn`: `in` / `out` (the clip's
 * first / last frame), `sequence-time` or `playhead` (the frame shown at sequence time `at`), `source-time` (content
 * time `sourceTime`, Premiere's "Source Timecode"). `holdFilters` freezes effects and keyframes too.
 */
export const ClipFrameHoldOptionsCmd = cmd('clip.frameHoldOptions', {
	clipIds: IdListSchema,
	enabled: z.boolean().optional(),
	holdOn: z.enum(['in', 'out', 'sequence-time', 'playhead', 'source-time']).optional(),
	at: TimeInputSchema.optional(),
	sourceTime: ContentTimeInputSchema.optional(),
	holdFilters: z.boolean().optional(),
});

/**
 * Join Through Edits: every through edit of the sequence on unlocked tracks (or only those touching `clipIds`) is
 * healed — the left piece absorbs the right one and keeps its own effects and attributes.
 */
export const SequenceJoinThroughEditsCmd = cmd('sequence.joinThroughEdits', {
	sequenceId: IdRefSchema.optional(),
	clipIds: IdListSchema.optional(),
});

/**
 * Sequence ▸ Make Subsequence: a new sequence (same settings and track layout) with copies of the given clips (else
 * everything on `tracks`, default all tracks) trimmed to `[from, to)` (default the sequence In/Out when set). The
 * original is unchanged.
 */
export const SequenceMakeSubsequenceCmd = cmd('sequence.makeSubsequence', {
	sequenceId: IdRefSchema.optional(),
	clipIds: IdListSchema.optional(),
	tracks: z.array(TrackRefSchema).min(1).optional(),
	from: TimeInputSchema.optional(),
	to: TimeInputSchema.optional(),
	name: z.string().min(1).optional(),
	binId: IdRefSchema.nullable().optional(),
	ref: RefDeclSchema.optional(),
});

export const STRUCTURE_COMMANDS = [
	ClipUnnestCmd,
	ClipAddFrameHoldCmd,
	ClipInsertFrameHoldSegmentCmd,
	ClipFrameHoldOptionsCmd,
	SequenceJoinThroughEditsCmd,
	SequenceMakeSubsequenceCmd,
] as const;
