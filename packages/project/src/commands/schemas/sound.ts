// Sound design commands (spec 12 §2.9; owner `sound-design`): library provenance of media (P1), cues, placement,
// swap, palette and settings (P2).
import { z } from 'zod';
import {
	CUE_ALIGNS,
	CueAnchorSchema,
	SFX_ROLES,
	SFX_SOLVER_LEVEL_LIMITS,
	SOUND_CREDITS_FORMATS,
	SOUND_DELIVERIES,
	SOUND_DENSITIES,
	SOUND_DESIGN_LIMITS,
	soundCueFields,
} from '../../schema/sound.ts';
import { SFX_DEFAULT_GAIN_MAX_DB, SFX_DEFAULT_GAIN_MIN_DB } from '../../sound/level.ts';
import { LibraryProvenanceSchema } from '../../sound/provenance.ts';
import { cmd, IdRefSchema, RefDeclSchema, TimeInputSchema, TrackRefSchema } from './common.ts';

/**
 * Sets (or with `null` removes) the library provenance of a media asset: which Sound Library sound it is, its licence
 * and credit, and the descriptors placement uses (spec 12 §2.1). Audio and video media only. Result
 * `{mediaId, library}` (the stored value, or null).
 */
export const MediaSetLibraryInfoCmd = cmd('media.setLibraryInfo', {
	mediaId: IdRefSchema,
	library: LibraryProvenanceSchema.nullable(),
});

/** A library sound id (`snd_` + 16 hex digits, the engine's `SoundEntry.id`). */
export const SoundIdSchema = z
	.string()
	.regex(/^snd_[0-9a-f]{16}$/, 'a sound id looks like snd_0123456789abcdef');

/**
 * One cue to add: the `SoundCue` fields of spec 12 §2.2 (what `deriveCues` outputs) without the model's own
 * `placedClipIds`; `id` (a well-formed unused `cue_…`) and `ref` (`$name`, for a later command of the transaction) are
 * optional.
 */
export const SoundCueInputSchema = z.strictObject({
	...soundCueFields,
	soundIds: z.array(SoundIdSchema).max(SOUND_DESIGN_LIMITS.soundIds).optional(),
	id: z.string().max(SOUND_DESIGN_LIMITS.id).optional(),
	ref: RefDeclSchema.optional(),
});
export type SoundCueInput = z.infer<typeof SoundCueInputSchema>;

/** Adds cues to a sequence (≤ 2000 per command). Result `{sequenceId, cueIds}` (the refs are defined too). */
export const SoundCueAddCmd = cmd('soundCue.add', {
	sequenceId: IdRefSchema.optional(),
	cues: z.array(SoundCueInputSchema).min(1).max(SOUND_DESIGN_LIMITS.addCues),
});

/** Optional cue fields `soundCue.update` may clear with `null`. */
const clearable = <T extends z.ZodType>(s: T) => s.nullable().optional();

/**
 * Changes a cue. Optional fields take `null` to remove them. A new `frame` moves the clips filling the cue by the
 * same number of frames (`moveClips`, default true; refused like `soundCue.resync` when a clip cannot move).
 */
export const SoundCueUpdateCmd = cmd('soundCue.update', {
	cueId: IdRefSchema,
	frame: soundCueFields.frame.optional(),
	label: clearable(soundCueFields.label.unwrap()),
	kind: soundCueFields.kind.optional(),
	weight: soundCueFields.weight.optional(),
	types: clearable(soundCueFields.types.unwrap()),
	soundIds: clearable(z.array(SoundIdSchema).max(SOUND_DESIGN_LIMITS.soundIds)),
	align: clearable(soundCueFields.align.unwrap()),
	pan: clearable(soundCueFields.pan.unwrap()),
	panSweep: clearable(soundCueFields.panSweep.unwrap()),
	pitchSt: clearable(soundCueFields.pitchSt.unwrap()),
	stopBefore: clearable(soundCueFields.stopBefore.unwrap()),
	build: clearable(soundCueFields.build.unwrap()),
	anchor: CueAnchorSchema.nullable().optional(),
	/** Frames between the anchor's frame and the cue (null / 0 = on it); dropped with the anchor. */
	anchorOffset: clearable(soundCueFields.anchorOffset.unwrap()),
	source: soundCueFields.source.optional(),
	confidence: clearable(soundCueFields.confidence.unwrap()),
	reason: clearable(soundCueFields.reason.unwrap()),
	muted: soundCueFields.muted.optional(),
	window: clearable(soundCueFields.window.unwrap()),
	moveClips: z.boolean().optional(),
});

/**
 * Removes cues. `withClips: true` also lifts the clips filling them (their groups' other clips stay); otherwise those
 * clips stay and forget the cue (`sfx.cueId` → null). Result `{removed, liftedClipIds}`.
 */
export const SoundCueRemoveCmd = cmd('soundCue.remove', {
	cueIds: z.array(IdRefSchema).min(1).max(SOUND_DESIGN_LIMITS.cues),
	withClips: z.boolean().optional(),
});

/**
 * Follows the edit: every cue with an anchor (or the given ones) moves to where its anchor's picture event is now
 * (`resolveCueAnchor`), and the clips filling it move by the same number of frames. A cue whose anchor no longer
 * resolves stays (reported). The whole transaction is refused when a clip cannot move (`E_OVERLAP`, `E_TRACK_LOCKED`,
 * before frame 0 `E_INVALID_PARAM`). Result `{moved: [{cueId, from, to, clipIds}], unresolved: cueIds}`.
 */
export const SoundCueResyncCmd = cmd('soundCue.resync', {
	sequenceId: IdRefSchema.optional(),
	cueIds: z.array(IdRefSchema).min(1).max(SOUND_DESIGN_LIMITS.cues).optional(),
});

const PanKeyframeSchema = z.strictObject({
	/** Frames from the cue frame (negative = before it). */
	offset: z.number().int().min(-100_000).max(100_000),
	value: z.number().min(-100).max(100),
});

/** One layer of a placement: a media (a registered library sound) on a track. */
export const SoundLayerSchema = z.strictObject({
	mediaId: IdRefSchema,
	/** An audio track (`A3`, an id, or a `$ref`), or `auto` (default): a free SFX track, else a new "SFX n". */
	track: TrackRefSchema.optional(),
	/** Which point of the sound lands on the cue: `auto` (default: the cue's `align`, else the sound type's). */
	align: z.enum([...CUE_ALIGNS, 'auto']).optional(),
	/**
	 * Clip gain (dB). Default: the sound's default level — its loudest 400 ms (`maxMomentaryLufs`) to the role's
	 * momentary target at the sequence's delivery (web: hero −16, support −22, layer −24, beds −30 LUFS) under the
	 * role's true-peak ceiling (−6 / −12 / −16 / −20 dBTP), within −30…+12 dB; recorded as `sfx.level`.
	 */
	gainDb: z.number().min(-96).max(96).optional(),
	/** Added to the default level (dB; the seeded ±1 dB variation of a fill); ignored when `gainDb` is given. */
	gainOffsetDb: z.number().min(-12).max(12).optional(),
	/** Clip speed (varispeed; changes pitch), default 1. */
	rate: z.number().min(0.25).max(4).optional(),
	/** Pitch in semitones (default: the cue's): |st| ≤ 3 by varispeed, else the Pitch Shifter effect. */
	pitchSt: z.number().min(-12).max(12).optional(),
	/**
	 * Static pan −100…100, or keyframes relative to the cue frame (whoosh sweeps). Default: the cue's `panSweep` (from →
	 * to over its window, else ± 0.2 s around the cue), else its static pan.
	 */
	pan: z
		.union([
			z.number().min(-100).max(100),
			z.strictObject({ keyframes: z.array(PanKeyframeSchema).min(2).max(32) }),
		])
		.optional(),
	/** Default: hero for the first layer of a hero cue, support for the first layer otherwise, layer for the others. */
	role: z.enum(SFX_ROLES).optional(),
	/** Binds the placed clip's id. */
	ref: RefDeclSchema.optional(),
});
export type SoundLayerInput = z.infer<typeof SoundLayerSchema>;

/**
 * Places sounds so that their aligned point (peak, start or end) lands on a cue or a frame (spec 12 §2.3): one clip
 * per layer on its own free audio track, never overwriting audio, peak-exact (library media are padded with lead
 * silence, so the sub-frame rest is cut from silence), Essential Sound type SFX, `sfx` metadata, grouped
 * (`group`, default true for several layers), the cue's `placedClipIds` updated. Give `cueId` or `frame`.
 */
export const SoundDesignPlaceCmd = cmd('soundDesign.place', {
	sequenceId: IdRefSchema.optional(),
	cueId: IdRefSchema.optional(),
	frame: TimeInputSchema.optional(),
	layers: z.array(SoundLayerSchema).min(1).max(SOUND_DESIGN_LIMITS.layers),
	group: z.boolean().optional(),
	/** Alternatives offered for variation cycling (sound ids, ≤ 16), stored on the first layer's clip. */
	alternatives: z.array(SoundIdSchema).max(SOUND_DESIGN_LIMITS.alternatives).optional(),
	/** Tracks `auto` tries first when they are free (the drop target, then targeted tracks). */
	preferTrackIds: z.array(TrackRefSchema).max(32).optional(),
	/** A sound that would start before frame 0: false (default) refuses; true starts it at 0 with its head trimmed. */
	clampStart: z.boolean().optional(),
});

/**
 * Swaps the sound of a placed clip: the new media's aligned point lands where the old one did (same track, speed,
 * pan, gain, effects, group, role and cue link; keyframes keep their sequence times; a gain still at placement's
 * default level, `sfx.level`, becomes the new sound's default). `frame` lands it on that frame
 * instead (with the clip's own media this re-aligns the clip: MCP `align_peak`), still sample-exact through the In
 * point. The same media with another `align` re-aligns the clip (its start, peak or end on the frame the old point
 * played at, or on `frame`); `pitchSt` re-pitches it around that point (|st| ≤ 3 by varispeed keeping the seeded ±2 %
 * variation, else the Pitch Shifter effect; 0 removes the shift: the speed is the variation again, exactly, read from the
 * clip's `sfx.pitch` record of the applied shift, which placement and every re-pitch write). A sound that would start before frame 0 is refused,
 * except for a clip at frame 0 swapped in place (an insert near the start, `clampStart`): the new sound starts there
 * with its head trimmed. Fades on the clip's edges are shortened to its new length. Result `{clipId, mediaId, soundId,
 * start, sourceInFlicks, errorFlicks, alignedFrame, align, rate, pitchSt, trimmedHeadSec, gainDb}`. `alternatives` replaces the
 * clip's variation ring (`sfx.alternatives`, sound ids ≤ 16, the original first): variation cycling across separate
 * calls keeps one anchor even for a sound placed without alternatives (MCP `swap_sound` stores `[original]` on its
 * first swap).
 */
export const SoundDesignSwapCmd = cmd('soundDesign.swap', {
	clipId: IdRefSchema,
	mediaId: IdRefSchema,
	align: z.enum(CUE_ALIGNS).optional(),
	frame: TimeInputSchema.optional(),
	pitchSt: z.number().min(-12).max(12).optional(),
	alternatives: z.array(SoundIdSchema).min(1).max(SOUND_DESIGN_LIMITS.alternatives).optional(),
});

/**
 * Sets the sound-design role of placed clips (hero, support or layer; spec 12 §2.7 Essential Sound ▸ Role). Clips
 * without `sfx` metadata get it (not linked to a cue) when their media is a library sound. A gain still at
 * placement's default level (`sfx.level`) follows the role's. Result `{clipIds, role}`.
 */
export const SoundDesignSetRoleCmd = cmd('soundDesign.setRole', {
	clipIds: z.array(IdRefSchema).min(1).max(SOUND_DESIGN_LIMITS.cues),
	role: z.enum(SFX_ROLES),
});

/** Sets the sequence's sound palette (preferred library sounds): replace (default), add or remove. */
export const SoundDesignSetPaletteCmd = cmd('soundDesign.setPalette', {
	sequenceId: IdRefSchema.optional(),
	soundIds: z.array(SoundIdSchema).max(SOUND_DESIGN_LIMITS.palette),
	mode: z.enum(['replace', 'add', 'remove']).optional(),
});

/** Sets sound-design settings of a sequence (the others keep their values or read-time defaults). */
export const SoundDesignSetSettingsCmd = cmd('soundDesign.setSettings', {
	sequenceId: IdRefSchema.optional(),
	delivery: z.enum(SOUND_DELIVERIES).optional(),
	density: z.enum(SOUND_DENSITIES).optional(),
	sfxTrackIds: z.array(TrackRefSchema).max(SOUND_DESIGN_LIMITS.sfxTracks).optional(),
	roomBus: TrackRefSchema.nullable().optional(),
	seed: z.number().int().min(0).max(0xffff_ffff).optional(),
	agentsMayApply: z.boolean().optional(),
	/** Sound credits sidecar of the sequence's exports (`txt` / `md`), or null: not configured. */
	credits: z.enum(SOUND_CREDITS_FORMATS).nullable().optional(),
});

/** Sound Check verdicts (spec 12 §2.6). */
export const SOUND_CHECK_VERDICT_VALUES = ['pass', 'warn', 'fail'] as const;

/**
 * Stores the summary of a Sound Check in `Sequence.soundDesign.lastCheck` (spec 12 §2.6, P5-R1), or with `summary: null`
 * removes it. `mixHash` is the mix fingerprint the check measured (`mixFingerprint`); `inputsHash` the hash of its
 * other inputs (`soundCheckInputsHash`): `soundCheckStatus` calls the summary stale when either differs. `counts` are
 * issues per code or severity (≤ 64 keys). Result `{sequenceId, lastCheck}`.
 */
export const SoundDesignSetCheckCmd = cmd('soundDesign.setCheck', {
	sequenceId: IdRefSchema.optional(),
	summary: z
		.strictObject({
			mixHash: z.string().min(1).max(256),
			verdict: z.enum(SOUND_CHECK_VERDICT_VALUES),
			counts: z
				.record(z.string().min(1).max(64), z.number().int().min(0).max(1_000_000))
				.refine((c) => Object.keys(c).length <= 64, 'at most 64 counts'),
			at: z.iso.datetime(),
			preset: z.enum(SOUND_DELIVERIES),
			/** Checked against a custom target instead of the preset's numbers (Sound Check panel "Custom…"). */
			target: z
				.strictObject({
					integratedLufs: z.number().min(-40).max(-5),
					truePeakDb: z.number().min(-12).max(0),
				})
				.optional(),
			inputsHash: z.string().min(1).max(256).optional(),
			jobId: z.string().min(1).max(128).optional(),
			range: z
				.strictObject({ start: z.number().int().min(0), end: z.number().int().min(0) })
				.refine((r) => r.end > r.start, 'range.end must be after range.start')
				.optional(),
		})
		.nullable(),
});

/** Listen-here slots a verdict can name (spec 12 §2.6 listen[5]). */
export const SOUND_CHECK_VERDICT_SLOTS = ['worst', 'hero', 'loudest', 'densest', 'passing'] as const;

/**
 * Records the listener's verdict on a Sound Check listen-here moment (spec 12 §2.7 "Sounds right / Flag + note, stored
 * as `comment` markers"; Phase 5 verification): a `comment` sequence marker at `frame` named "Sound Check: sounds right"
 * (`verdict: 'ok'`) or "Sound Check: flagged" (`'flag'`, rose), the note as its comment, with a structured
 * `soundCheck` field binding it to the moment — the slot, the clip (`clipId`) or else cue (`cueId`) listened to and where
 * it was, the mix fingerprint and the hash of what plays in the ±2 s window (`soundCheckMomentHash`), so a later edit
 * there makes it stale. A verdict on the same frame about the same clip / cue (or an older unbound one at that frame)
 * is updated instead of adding another; `verdict: null` removes them. Authored by whoever applies it: MCP
 * `sound_check` reports only user-authored verdicts. Result `{markerId, removed}`.
 */
export const SoundDesignSetVerdictCmd = cmd('soundDesign.setVerdict', {
	sequenceId: IdRefSchema.optional(),
	frame: TimeInputSchema,
	verdict: z.enum(['ok', 'flag']).nullable(),
	note: z.string().max(2000).optional(),
	slot: z.enum(SOUND_CHECK_VERDICT_SLOTS).optional(),
	clipId: IdRefSchema.optional(),
	cueId: z.string().min(1).max(SOUND_DESIGN_LIMITS.id).optional(),
	/** The `mixHash` of the Sound Check report the moment came from. */
	reportMixHash: z.string().min(1).max(256).optional(),
});

/**
 * Sets where the peak of a clip's sound is (spec 12 §2.7 "Peak handle", Shift-drag, Detect Peak): `peakFlicks` =
 * content flicks from the media start, within the media. Writes `sfx.placement` (align `peak`; an audio clip without
 * `sfx` gets it, not linked to a cue: `soundId` is its library sound, or null for other audio); the clip does not move. Peak snapping, cue fills and swaps use it from then on. Result
 * `{clipId, peakFlicks, errorFlicks}`.
 */
export const SoundDesignSetPeakCmd = cmd('soundDesign.setPeak', {
	clipId: IdRefSchema,
	peakFlicks: z.number().int().min(0),
});

/** Most clips one `soundDesign.applyGains` may set. */
export const APPLY_GAINS_MAX_CLIPS = 2000;
/** A clip id, or a `$ref` a placement earlier in the transaction bound (`soundDesign.place` layer `ref`). */
const GainClipKeySchema = z
	.string()
	.min(1)
	.max(SOUND_DESIGN_LIMITS.id)
	.regex(/^(?:\$[A-Za-z_][\w.-]*|[A-Za-z0-9_-]+)$/, 'a clip id or a $ref');

/** Why one solved gain is what it is (stored in `sfx.level`). */
export const SolverGainReportSchema = z.strictObject({
	/** Target lift of the dominant band over the bed (dB). */
	targetLiftDb: z.number().min(-100).max(100).optional(),
	/** Lift reached at the gain (dB); null for a silent sound. */
	achievedLiftDb: z.number().min(-400).max(400).nullable().optional(),
	/** Constraints that held it under the target (`dialogue`, `bed-cap`, `conflict:bed-cap/consistency`…). */
	limitedBy: z
		.array(z.string().min(1).max(SFX_SOLVER_LEVEL_LIMITS.limit))
		.max(SFX_SOLVER_LEVEL_LIMITS.limitedBy)
		.optional(),
	reason: z.string().max(SFX_SOLVER_LEVEL_LIMITS.reason).optional(),
});

/**
 * Sets the clip gains the masking solver chose for sound effects (spec 12 §2.4, §2.9; MCP `rebalance_sfx`, the plan
 * job): `gains` maps clip ids (or `$refs` bound earlier in the transaction) to a gain in the solver's range −30…+12 dB;
 * `report` (same keys) says why. Each clip's `sfx.level` becomes `{by: 'solver', gainDb, offsetDb (kept from its
 * previous level), targetLiftDb, achievedLiftDb, limitedBy, reason}`; a sound effect without `sfx` metadata (Essential
 * Sound type SFX only) just gets the gain. Clips must be sound effects (Essential Sound SFX or placed sounds) on
 * unlocked tracks. A clip whose Auto gain is off (`level.manual`, `setAutoGain {auto: false}`) keeps its gain unless
 * `override: true` (a rebalance the user asked for names it); it is listed in `skipped`. Result `{clips: [{clipId,
 * fromDb, gainDb}], skipped?: [{clipId, reason}]}`.
 */
export const SoundDesignApplyGainsCmd = cmd('soundDesign.applyGains', {
	sequenceId: IdRefSchema.optional(),
	gains: z
		.record(GainClipKeySchema, z.number().min(SFX_DEFAULT_GAIN_MIN_DB).max(SFX_DEFAULT_GAIN_MAX_DB))
		.refine((g) => {
			const n = Object.keys(g).length;
			return n >= 1 && n <= APPLY_GAINS_MAX_CLIPS;
		}, `1–${APPLY_GAINS_MAX_CLIPS} clips`),
	report: z
		.record(GainClipKeySchema, SolverGainReportSchema)
		.refine((g) => Object.keys(g).length <= APPLY_GAINS_MAX_CLIPS, `at most ${APPLY_GAINS_MAX_CLIPS} clips`)
		.optional(),
	/** Also solve clips whose Auto gain is off (the user asked for them by name). Default false: they are skipped. */
	override: z.boolean().optional(),
});

/**
 * Auto gain of sound effects on or off (Essential Sound ▸ Sound Design ▸ "Auto gain", spec 12 §2.7). `auto: false`
 * keeps each clip's current gain as the user's own: its `sfx.level` (default or solver) stays for display and is marked
 * `manual`, so a rebalance (unless it names the clip), a delivery preset, a swap or a role change leave the gain alone.
 * `auto: true` hands it back (spec 12 §2.7: Auto gain on = the solver owns the gain): the clip's gain becomes its
 * recorded level (the solver's or placement's default) again, also when the gain was changed by hand since. Clips
 * without a recorded level are left as they are (`skipped`: rebalance to solve them). Clips must be sound effects
 * (Essential Sound SFX or placed sounds) on unlocked tracks. Result `{clips: [{clipId, owner, skipped?}]}` (the gain
 * owner after the change).
 */
export const SoundDesignSetAutoGainCmd = cmd('soundDesign.setAutoGain', {
	sequenceId: IdRefSchema.optional(),
	clipIds: z.array(IdRefSchema).min(1).max(APPLY_GAINS_MAX_CLIPS),
	auto: z.boolean(),
});

export const SOUND_COMMANDS = [
	MediaSetLibraryInfoCmd,
	SoundCueAddCmd,
	SoundCueUpdateCmd,
	SoundCueRemoveCmd,
	SoundCueResyncCmd,
	SoundDesignPlaceCmd,
	SoundDesignSwapCmd,
	SoundDesignSetRoleCmd,
	SoundDesignSetPaletteCmd,
	SoundDesignSetSettingsCmd,
	SoundDesignSetPeakCmd,
	SoundDesignApplyGainsCmd,
	SoundDesignSetAutoGainCmd,
	SoundDesignSetCheckCmd,
	SoundDesignSetVerdictCmd,
] as const;
