// Audio buses (workstream audio-mix): Audio Track Mixer strips, sends, submixes, automation modes, channel formats,
// sequence sample rates and loudness normalisation. Every field is optional with read-time defaults (see
// `audio/strip.ts`), so documents written before the mixer existed read exactly as before.
import { z } from 'zod';
import type { DeepStrip } from './common.ts';
import { AnimNumberSchema } from './common.ts';

/** Channel format of an audio track, a submix and the Mix (master). 5.1 is L, R, C, LFE, Ls, Rs (SMPTE order). */
export const AUDIO_CHANNEL_FORMATS = ['mono', 'stereo', '5.1'] as const;
export const AudioChannelFormatSchema = z.enum(AUDIO_CHANNEL_FORMATS);
export type AudioChannelFormat = (typeof AUDIO_CHANNEL_FORMATS)[number];

/** Sequence audio sample rates (Premiere offers 32/44.1/48/88.2/96 kHz; we support the three common ones). */
export const SEQUENCE_SAMPLE_RATES = [44100, 48000, 96000] as const;
export const SequenceSampleRateSchema = z.union([z.literal(44100), z.literal(48000), z.literal(96000)]);
export type SequenceSampleRate = (typeof SEQUENCE_SAMPLE_RATES)[number];

/**
 * Track automation mode (the Audio Track Mixer's mode menu above M/S/R). Read is Premiere's default.
 * - `off`: play the static values, ignore automation.
 * - `read`: play automation; touching a control during playback does not record.
 * - `latch`: record from the first touch; after release keep writing the last value until playback stops.
 * - `touch`: record while touched; after release ramp back to the existing automation over the automatch time.
 * - `write`: record every automatable control from the start of playback until it stops.
 */
export const AUTOMATION_MODES = ['off', 'read', 'latch', 'touch', 'write'] as const;
export const AutomationModeSchema = z.enum(AUTOMATION_MODES);
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

/** How a track's (stereo) clip audio feeds the strip input. */
export const INPUT_MAPS = ['stereo', 'left', 'right', 'swap', 'mono'] as const;
export const InputMapSchema = z.enum(INPUT_MAPS);
export type InputMap = (typeof INPUT_MAPS)[number];

/** A send from a strip to a submix. `levelDb` is automatable (keyframes in sequence time, flicks). */
export const TrackSendSchema = z.looseObject({
	id: z.string(),
	/** Destination submix track id. */
	target: z.string(),
	levelDb: AnimNumberSchema,
	/** Send pan / balance, −100 (left) … 100 (right). Absent = 0. */
	pan: z.number().min(-100).max(100).optional(),
	/** Tap before the fader (after pre-fader inserts) instead of after the post-fader inserts. */
	preFader: z.boolean().optional(),
	mute: z.boolean().optional(),
});
export type TrackSend = DeepStrip<z.infer<typeof TrackSendSchema>>;

/** Lanes stored in `MixerStrip.lanes` (volume and pan stay in `Track.volumeDb` / `Track.pan`). */
export const LANE_MUTE = 'mute';
export const LANE_PAN51_X = 'pan51.x';
export const LANE_PAN51_Y = 'pan51.y';
export const LANE_PAN51_CENTER = 'pan51.center';
export const LANE_PAN51_LFE = 'pan51.lfe';
export const STRIP_LANES = [
	LANE_MUTE,
	LANE_PAN51_X,
	LANE_PAN51_Y,
	LANE_PAN51_CENTER,
	LANE_PAN51_LFE,
] as const;
export type StripLane = (typeof STRIP_LANES)[number];

/** Mixer-only state of a channel strip (audio track, submix or the Mix). */
export const MixerStripSchema = z.looseObject({
	/** Absent = `read`. */
	automation: AutomationModeSchema.optional(),
	/** Output assignment: a submix track id; absent / null = the Mix. Submixes may only feed a later submix. */
	output: z.string().nullable().optional(),
	sends: z.array(TrackSendSchema).optional(),
	/** Record-arm (R): voice-over recording goes to the armed track. */
	recordArm: z.boolean().optional(),
	/** Solo safe: never solo-muted. */
	soloSafe: z.boolean().optional(),
	/** Absent = `stereo`. */
	inputMap: InputMapSchema.optional(),
	/** `mute` (0/1, hold) and the 5.1 panner lanes (`pan51.x/y` −100…100, `pan51.center` 0…100 %, `pan51.lfe` dB). */
	lanes: z.record(z.string(), AnimNumberSchema).optional(),
	/** Audio Clip Mixer automation mode of an audio track (absent = `read`). */
	clipAutomation: AutomationModeSchema.optional(),
});
export type MixerStrip = DeepStrip<z.infer<typeof MixerStripSchema>>;

/** The Mix track's mixer state (no output, no sends). */
export const MasterMixerSchema = z.looseObject({
	automation: AutomationModeSchema.optional(),
});
export type MasterMixer = DeepStrip<z.infer<typeof MasterMixerSchema>>;

/** Result of a loudness analysis (ITU-R BS.1770-4 / EBU R128). */
export const LoudnessAnalysisSchema = z.looseObject({
	integratedLufs: z.number().nullable(),
	truePeakDbtp: z.number().nullable(),
	lra: z.number().nullable(),
	maxMomentaryLufs: z.number().nullable().optional(),
	maxShortTermLufs: z.number().nullable().optional(),
	/** Hash of everything the mix depends on (`mixFingerprint`): a different hash means the analysis is stale. */
	mixHash: z.string(),
	analyzedAt: z.string(),
});
export type LoudnessAnalysis = DeepStrip<z.infer<typeof LoudnessAnalysisSchema>>;

/**
 * Sequence loudness normalisation (the Mix): when enabled, preview and export apply `target − integrated` (from the
 * analysis; exports re-measure the final mix, two-pass) and a true-peak limiter at `truePeakDb`.
 */
export const LoudnessNormalizeSchema = z.looseObject({
	enabled: z.boolean(),
	targetLufs: z.number().min(-60).max(0),
	truePeakDb: z.number().min(-20).max(0),
	analysis: LoudnessAnalysisSchema.nullable().optional(),
});
export type LoudnessNormalize = DeepStrip<z.infer<typeof LoudnessNormalizeSchema>>;
