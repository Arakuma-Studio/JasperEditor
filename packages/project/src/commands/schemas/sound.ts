// Sound design commands (spec 12 §2.9; owner `sound-design`): library provenance of media (P1), cues, placement,
// swap, palette and settings (P2).
import { z } from 'zod';
import {
	CUE_ALIGNS,
	CueAnchorSchema,
	SFX_ROLES,
	SOUND_DELIVERIES,
	SOUND_DENSITIES,
	SOUND_DESIGN_LIMITS,
	soundCueFields,
} from '../../schema/sound.ts';
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
	id: z.string().optional(),
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
	/** Clip gain (dB), default 0. */
	gainDb: z.number().min(-96).max(96).optional(),
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
 * pan, gain, effects, group, role and cue link; keyframes keep their sequence times). The same media with another
 * `align` re-aligns the clip (its start, peak or end on the frame the old point played at); `pitchSt` re-pitches it
 * around that point (|st| ≤ 3 by varispeed keeping the seeded ±2 % variation, else the Pitch Shifter effect; 0
 * removes the shift). Result `{clipId, mediaId, soundId, start, sourceInFlicks, errorFlicks, alignedFrame, align, rate,
 * pitchSt}`.
 */
export const SoundDesignSwapCmd = cmd('soundDesign.swap', {
	clipId: IdRefSchema,
	mediaId: IdRefSchema,
	align: z.enum(CUE_ALIGNS).optional(),
	pitchSt: z.number().min(-12).max(12).optional(),
});

/**
 * Sets the sound-design role of placed clips (hero, support or layer; spec 12 §2.7 Essential Sound ▸ Role). Clips
 * without `sfx` metadata get it (not linked to a cue) when their media is a library sound. Result `{clipIds, role}`.
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
] as const;
