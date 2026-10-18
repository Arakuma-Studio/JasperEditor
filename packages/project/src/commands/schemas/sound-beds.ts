// Ambience and room-tone beds (spec 12 §4 P6-E12; owner `sound-design`; wp-note "Phase 6 → WP-E8"): one command lays a
// bed as ordinary clips — pieces of a loop joined by crossfade transitions, fades, Volume dips — in one undo step.
import { z } from 'zod';
import { BED_PURPOSES } from '../../schema/sound.ts';
import { BED_MAX_SHOTS } from '../../sound/ambience-bed.ts';
import { cmd, IdRefSchema, TimeInputSchema, TrackRefSchema } from './common.ts';

/** The loop of a bed's media (media seconds, `inSec < outSec`): the clean window or the measured loop points. */
export const BedLoopSchema = z
	.strictObject({
		inSec: z.number().min(0).max(86_400),
		outSec: z.number().min(0).max(86_400),
	})
	.refine((l) => l.outSec > l.inSec, 'loop.outSec must be after loop.inSec');

/** Crossfade law of the loop joints: equal power (Constant Power, default) or equal gain (Constant Gain). */
export const BED_FADE_LAWS = ['equal-power', 'equal-gain'] as const;

export const BedShotSchema = z.strictObject({
	start: TimeInputSchema,
	end: TimeInputSchema,
	/** This shot's bed (default the command's `mediaId`). */
	mediaId: IdRefSchema.optional(),
	/** The loop of this shot's media (default the command's `loop` when the media is the same, else the whole media). */
	loop: BedLoopSchema.optional(),
	gainDb: z.number().min(-60).max(40).optional(),
	fade: z.enum(BED_FADE_LAWS).optional(),
});
export type BedShot = z.infer<typeof BedShotSchema>;

/**
 * Lays an ambience bed per scene, or room tone in dialogue gaps (spec 12 §4 P6-E12), as ordinary clips on an
 * "Ambience" (or "Room Tone") audio track: give `range` (one bed over it) or `shots` (one bed per scene; scenes that
 * touch are joined by a short crossfade, `sceneCrossfadeSec`, default 0.5 s). Each bed repeats `loop` of its media
 * (media seconds; default the whole media — the engine measures the clean window and loop points: MCP
 * `lay_ambience_bed`, `POST /api/sound-design/beds`) with crossfades of `crossfadeSec` (default 1.5 s; shortened only
 * when the loop is too short, `W_BED_CROSSFADE_SHORTENED`) centred on each joint: the outgoing piece plays the loop's
 * tail, the incoming its head. Fades in and out of `fadeSec` (default 1 s ambience, 0.25 s room tone) where a bed
 * starts and stops. Pieces are Essential Sound type Ambience, at `gainDb` (default 0 dB, or the library sound's
 * ambience level), grouped per bed, named "<media> (Bed n/m)" / "(Room Tone n/m)", with `bed` metadata. `duckUnder`
 * dips them under the dialogue (−10 dB, 800 ms) or under hero sounds (−6 dB, 150 ms) with Volume keyframes
 * (`audio.volumeDip`; `duckDb` overrides the depth). `track`: an audio track that is free over every shot, or `auto`
 * (default: the first free unlocked track named "Ambience…" / "Room Tone…", else a new one). `replace` (default false)
 * first lifts the earlier beds of the same purpose that overlap the shots (their transitions with them). One undo
 * step. Result `{sequenceId, trackId, trackCreated, clipIds, transitionIds, beds: [{start, end, clipIds, mediaId,
 * pieces, crossfadeFrames}], replacedClipIds, ducked}`.
 */
export const SoundDesignLayBedCmd = cmd('soundDesign.layBed', {
	sequenceId: IdRefSchema.optional(),
	purpose: z.enum(BED_PURPOSES).optional(),
	range: z.strictObject({ start: TimeInputSchema, end: TimeInputSchema }).optional(),
	shots: z.array(BedShotSchema).min(1).max(BED_MAX_SHOTS).optional(),
	mediaId: IdRefSchema,
	loop: BedLoopSchema.optional(),
	gainDb: z.number().min(-60).max(40).optional(),
	fadeSec: z.number().min(0).max(30).optional(),
	crossfadeSec: z.number().min(0.05).max(30).optional(),
	sceneCrossfadeSec: z.number().min(0).max(10).optional(),
	fade: z.enum(BED_FADE_LAWS).optional(),
	duckUnder: z.enum(['dialogue', 'heroes']).nullable().optional(),
	duckDb: z.number().min(-60).max(0).optional(),
	track: TrackRefSchema.optional(),
	replace: z.boolean().optional(),
});

export const SOUND_BED_COMMANDS = [SoundDesignLayBedCmd] as const;
