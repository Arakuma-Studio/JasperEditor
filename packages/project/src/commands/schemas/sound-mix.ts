// Sound design mixing commands (spec 12 §2.4, §2.9; P4-R3, P4-R4; owner `sound-design`; wp-note "Phase 4 → WP4.2a"):
// music dips (`audio.volumeDip`), stop-before and build realizations of a cue, the "SFX Room" glue and delivery presets.
// Every one is made of ordinary edits (volume / lane keyframes, a filter insert, a submix with a reverb, sends,
// `mixer.setLoudness`, Essential Sound Auto-Match and ducking) and is one undo step.
import { z } from 'zod';
import { LoudnessAnalysisCommandSchema } from '../../schema/audio.ts';
import { SOUND_DELIVERIES, SOUND_MIX_LIMITS } from '../../schema/sound.ts';
import { cmd, IdListSchema, IdRefSchema, TrackRefSchema } from './common.ts';

const Flicks = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Most dips one `audio.volumeDip` writes. */
export const VOLUME_DIP_MAX = 64;

export const VolumeDipSchema = z
	.strictObject({
		/** Floor start and end (sequence flicks). */
		start: Flicks,
		end: Flicks,
		/** How far the volume goes down on the floor (dB, ≤ 0). */
		depthDb: z.number().min(-60).max(0),
		/** Linear fade before `start` and after `end` (ms). */
		fadeMs: z.number().min(0).max(5000),
	})
	.refine((d) => d.end >= d.start, 'end must be ≥ start');

/**
 * Dips the Volume of audio clips (a music dip): over each dip the clip's volume curve becomes the minimum of what it was
 * and the dip (the local level − `depthDb` on the floor, linear fades outside it). Keyframes outside the dips are never
 * replaced; a static clip gets keyframes inside the dips only. Result `{clips: {clipId: {written, replaced} | {skipped}}}`.
 */
export const AudioVolumeDipCmd = cmd('audio.volumeDip', {
	clipIds: IdListSchema,
	dips: z.array(VolumeDipSchema).min(1).max(VOLUME_DIP_MAX),
});

/**
 * Realises the cue's `stopBefore {seconds, depthDb}` (spec 12 §2.4): the music under the cue dips by `depthDb` from
 * `seconds` before it until 10 ms before it (30 ms ramps) — written on the music track's volume lane
 * (`mixer.writeAutomation`) when only music plays on that track there, else as `audio.volumeDip` on the music clips. What
 * was written is recorded (`soundDesign.mix.cues`), so running it again first takes the previous dip out exactly, and a
 * cue without `stopBefore` (cleared) just has its dip removed. `ambience: true` dips ambience clips too. Result
 * `{cueId, applied, removed, writes: [{target, trackId?, clipId?, keyframes}], reason?}`.
 */
export const SoundDesignApplyStopBeforeCmd = cmd('soundDesign.applyStopBefore', {
	cueId: IdRefSchema,
	sequenceId: IdRefSchema.optional(),
	ambience: z.boolean().optional(),
});

/**
 * Realises the cue's `build {seconds, fromHz, toHz}` (spec 12 §2.4): one `jasper.audio.scientific-filter` (Butterworth
 * High Pass, order 2) insert per music track — reused by every build on that track — whose cutoff is keyframed rest
 * (20 Hz) → fromHz at `seconds` before the cue → toHz one frame before it (exponential sweep) → rest at the cue. A music
 * clip sharing its track with other audio gets the filter as a clip effect instead. Recorded like stop-before (re-running
 * replaces, a cleared `build` removes, and a filter left without keys is removed). Result `{cueId, applied, removed,
 * writes, reason?}`.
 */
export const SoundDesignApplyBuildCmd = cmd('soundDesign.applyBuild', {
	cueId: IdRefSchema,
	sequenceId: IdRefSchema.optional(),
});

export const RoomGlueInputSchema = z.strictObject({
	/** Send level (dB, post-fader; default −16). */
	sendDb: z.number().min(-96).max(15).optional(),
	/** Reverb decay RT60 (s; default 0.6). */
	decay: z.number().min(0.1).max(20).optional(),
	/** Reverb mix (%; default 100: the bus is all return). */
	mix: z.number().min(0).max(100).optional(),
	/** Pre-delay (ms; default 8). */
	preDelayMs: z.number().min(0).max(200).optional(),
});

/**
 * Room glue (spec 12 §2.4): the "SFX Room" submix with a `jasper.audio.studio-reverb` (decay 0.6 s, mix 100 %, pre-delay
 * 8 ms) and post-fader sends at −16 dB from the sound-effect tracks — tracks whose sound effects are all interface sounds
 * (ui, click, key, tick) stay dry, and tracks that also play bed audio (dialogue, music, ambience) get none (sends are per
 * track) unless named in `sfxTracks`. Idempotent: run again it reuses the bus, updates the reverb and send levels, adds
 * the missing sends and removes its own sends from tracks that no longer qualify. Sets `settings.roomBus`. Result
 * `{busId, label, reverbId, created, sends: [{trackId, sendId, added}], removed: [trackId], skipped: [{trackId, reason}]}`.
 */
export const SoundDesignEnsureBusCmd = cmd('soundDesign.ensureBus', {
	sequenceId: IdRefSchema.optional(),
	roomGlue: RoomGlueInputSchema.optional(),
	sfxTracks: z.array(TrackRefSchema).max(SOUND_MIX_LIMITS.sends).optional(),
});

/**
 * Removes the room glue `ensureBus` made: its sends, and the "SFX Room" submix when it created it (an adopted submix
 * stays, without its sends). `settings.roomBus` becomes null. Result `{busId, removedBus, removedSends}`.
 */
export const SoundDesignRemoveBusCmd = cmd('soundDesign.removeBus', {
	sequenceId: IdRefSchema.optional(),
});

/** Most ducking groups and regions one delivery applies. */
export const DELIVERY_LIMITS = { ducking: 256, regions: 20_000, measured: 5000 } as const;

/**
 * Applies a delivery preset (spec 12 §2.4; P4-R4): sets `settings.delivery`; turns Mix loudness normalisation on at the
 * preset's integrated target and true-peak ceiling (`mixer.setLoudness`, with `analysis` when given: the measured mix,
 * so the preview applies the gain too); Auto-Matches the clips in `measuredLufs` (their own integrated loudness,
 * engine-measured) to the preset by Essential Sound type — dialogue at the target, music 8 LU and ambience 10 LU under it
 * (music at the target without dialogue), sound effects left to the masking solver; ducks the clips of each `ducking`
 * group under its trigger `regions` with each clip's own Ducking amount and fades (`audio.autoDuck`), redoing the clip
 * dips stop-before wrote on them; and moves sound-effect gains that are still placement's default to the preset's
 * default level. The engine's `POST /api/sound-design/delivery` measures and builds this command. Result
 * `{sequenceId, delivery, loudness, matched, ducked, redipped, levels}`.
 */
export const SoundDesignApplyDeliveryCmd = cmd('soundDesign.applyDelivery', {
	sequenceId: IdRefSchema.optional(),
	delivery: z.enum(SOUND_DELIVERIES),
	/** Loudness normalisation of the Mix (default true). */
	loudness: z.boolean().optional(),
	analysis: LoudnessAnalysisCommandSchema.nullable().optional(),
	measuredLufs: z
		.record(z.string().min(1).max(128), z.number().min(-200).max(50).nullable())
		.refine(
			(r) => Object.keys(r).length <= DELIVERY_LIMITS.measured,
			`at most ${DELIVERY_LIMITS.measured} clips`,
		)
		.optional(),
	ducking: z
		.array(
			z.strictObject({
				clipIds: z.array(IdRefSchema).min(1).max(DELIVERY_LIMITS.measured),
				regions: z
					.array(z.tuple([Flicks, Flicks]).refine(([a, b]) => b >= a, 'a region ends after it starts'))
					.max(DELIVERY_LIMITS.regions),
			}),
		)
		.max(DELIVERY_LIMITS.ducking)
		.optional(),
});

export const SOUND_MIX_COMMANDS = [
	AudioVolumeDipCmd,
	SoundDesignApplyStopBeforeCmd,
	SoundDesignApplyBuildCmd,
	SoundDesignEnsureBusCmd,
	SoundDesignRemoveBusCmd,
	SoundDesignApplyDeliveryCmd,
] as const;
