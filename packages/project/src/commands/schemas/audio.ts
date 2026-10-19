// Strips accept track ids, track names, A1… / S1… labels, or Mix.
import { z } from 'zod';
import {
	AudioChannelFormatSchema,
	AutomationModeSchema,
	InputMapSchema,
	LoudnessAnalysisCommandSchema,
} from '../../schema/audio.ts';
import { AnimNumberSchema } from '../../schema/common.ts';
import { cmd, IdListSchema, IdRefSchema, RefDeclSchema } from './common.ts';

const StripRef = z.string().min(1);
/** Sequence time in flicks (sub-frame: automation is sample accurate). */
const Flicks = z.number().int().min(0);
const Point = z.tuple([Flicks, z.number()]);

export const MixerUpdateStripCmd = cmd('mixer.updateStrip', {
	sequenceId: IdRefSchema.optional(),
	stripId: StripRef,
	patch: z.strictObject({
		name: z.string().nullable().optional(),
		automation: AutomationModeSchema.optional(),
		/** Audio Clip Mixer mode of an audio track. */
		clipAutomation: AutomationModeSchema.optional(),
		/** A submix strip ref, or `Mix` / null for the Mix. */
		output: z.string().nullable().optional(),
		recordArm: z.boolean().optional(),
		soloSafe: z.boolean().optional(),
		inputMap: InputMapSchema.optional(),
		channelFormat: AudioChannelFormatSchema.optional(),
		mute: z.boolean().optional(),
		solo: z.boolean().optional(),
		/** A number sets the static value (stopwatch off); an Animatable replaces the lane. */
		volumeDb: z.union([z.number(), AnimNumberSchema]).optional(),
		pan: z.union([z.number(), AnimNumberSchema]).optional(),
	}),
});

export const MixerAddSubmixCmd = cmd('mixer.addSubmix', {
	sequenceId: IdRefSchema.optional(),
	name: z.string().nullable().optional(),
	channelFormat: AudioChannelFormatSchema.optional(),
	/** Position among the submixes (0 = S1); default after the last. */
	index: z.number().int().min(0).optional(),
	ref: RefDeclSchema.optional(),
});

export const MixerRemoveSubmixCmd = cmd('mixer.removeSubmix', {
	sequenceId: IdRefSchema.optional(),
	stripId: StripRef,
});

export const MixerAddSendCmd = cmd('mixer.addSend', {
	sequenceId: IdRefSchema.optional(),
	stripId: StripRef,
	/** Destination submix (strip ref). */
	target: StripRef,
	levelDb: z.number().min(-96).max(15).optional(),
	pan: z.number().min(-100).max(100).optional(),
	preFader: z.boolean().optional(),
	ref: RefDeclSchema.optional(),
});

export const MixerUpdateSendCmd = cmd('mixer.updateSend', {
	sequenceId: IdRefSchema.optional(),
	stripId: StripRef,
	sendId: IdRefSchema,
	patch: z.strictObject({
		target: StripRef.optional(),
		levelDb: z.union([z.number(), AnimNumberSchema]).optional(),
		pan: z.number().min(-100).max(100).optional(),
		preFader: z.boolean().optional(),
		mute: z.boolean().optional(),
	}),
});

export const MixerRemoveSendCmd = cmd('mixer.removeSend', {
	sequenceId: IdRefSchema.optional(),
	stripId: StripRef,
	sendId: IdRefSchema,
});

/** Moves a track / submix / Mix insert before or after the fader. */
export const MixerSetInsertPositionCmd = cmd('mixer.setInsertPosition', {
	effectInstanceId: IdRefSchema,
	postFader: z.boolean(),
});

/**
 * Sets a lane (`volume`, `pan`, `mute`, `pan51.x|y|center|lfe`, `send.<sendId>.level`): the static value, or a
 * keyframe at `time` (sequence flicks) when the lane is automated (or `keyframe: true`).
 */
export const MixerSetLaneCmd = cmd('mixer.setLane', {
	sequenceId: IdRefSchema.optional(),
	stripId: StripRef,
	lane: z.string().min(1),
	value: z.number(),
	time: Flicks.optional(),
	keyframe: z.boolean().optional(),
});

export const MixerClearLaneCmd = cmd('mixer.clearLane', {
	sequenceId: IdRefSchema.optional(),
	stripId: StripRef,
	lane: z.string().min(1),
});

const Thinning = z.strictObject({
	/** Max deviation kept by the line simplification (lane units; default 0.05 dB, 0.25 for pan lanes). */
	tolerance: z.number().min(0).optional(),
	/** Minimum time between keyframes in ms (default 0 = off). */
	minIntervalMs: z.number().min(0).optional(),
});

/**
 * Writes a recorded automation gesture (one pass = one transaction of these): replaces the lane's keyframes in
 * `[points[0].t, points[last].t]` with the thinned points, keeping the automation outside the range unchanged.
 */
export const MixerWriteAutomationCmd = cmd('mixer.writeAutomation', {
	sequenceId: IdRefSchema.optional(),
	stripId: StripRef,
	lane: z.string().min(1),
	points: z.array(Point).min(1),
	thinning: Thinning.optional(),
});

/**
 * Audio Clip Mixer pass: writes the clip `volume` (dB) / `pan` lane of every clip of an audio track the gesture
 * covers, as clip keyframes in content time, keeping each clip's values outside the recorded range.
 */
export const ClipMixerWriteCmd = cmd('clipMixer.write', {
	sequenceId: IdRefSchema.optional(),
	trackId: StripRef,
	lane: z.enum(['volume', 'pan']),
	points: z.array(Point).min(1),
	thinning: Thinning.optional(),
});

/** Audio Clip Mixer outside a pass: the clip under `time` gets the value (a keyframe there when it is animated). */
export const ClipMixerSetCmd = cmd('clipMixer.set', {
	sequenceId: IdRefSchema.optional(),
	trackId: StripRef,
	lane: z.enum(['volume', 'pan']),
	value: z.number(),
	time: Flicks,
});

/**
 * Audio Gain (Premiere `G`): `set` gain to `db`; `adjust` by `db`; `normalizeMax` — the loudest peak of the
 * selection reaches `db` (one common change, relative levels kept); `normalizeAll` — every clip's peak reaches `db`.
 * The normalise modes need `peaks`: each clip's measured sample peak in dBFS **without** its gain (engine analysis,
 * `POST /api/audio/analyze` or MCP `measure_loudness`).
 */
export const AudioSetGainCmd = cmd('audio.setGain', {
	clipIds: IdListSchema,
	mode: z.enum(['set', 'adjust', 'normalizeMax', 'normalizeAll']),
	db: z.number().min(-96).max(96),
	peaks: z.record(z.string(), z.number().nullable()).optional(),
});

/**
 * Auto-ducking (Essential Sound ▸ Music ▸ Ducking): ducks the target clips under the trigger activity `regions`
 * (sequence flicks, from the engine's activity analysis of the triggers) by `amountDb` with `fadeMs` ramps, as
 * clip volume keyframes (existing volume keyframes of the targets in their span are replaced).
 */
export const AudioAutoDuckCmd = cmd('audio.autoDuck', {
	targetClipIds: IdListSchema,
	regions: z.array(z.tuple([Flicks, Flicks])),
	amountDb: z.number().min(0).max(96),
	fadeMs: z.number().min(0).max(10_000),
});

/** Loudness normalisation of the Mix (preview and export). `analysis` stores a measurement of the current mix. */
export const MixerSetLoudnessCmd = cmd('mixer.setLoudness', {
	sequenceId: IdRefSchema.optional(),
	enabled: z.boolean().optional(),
	targetLufs: z.number().min(-60).max(0).optional(),
	truePeakDb: z.number().min(-20).max(0).optional(),
	analysis: LoudnessAnalysisCommandSchema.nullable().optional(),
});

export const AUDIO_COMMANDS = [
	MixerUpdateStripCmd,
	MixerAddSubmixCmd,
	MixerRemoveSubmixCmd,
	MixerAddSendCmd,
	MixerUpdateSendCmd,
	MixerRemoveSendCmd,
	MixerSetInsertPositionCmd,
	MixerSetLaneCmd,
	MixerClearLaneCmd,
	MixerWriteAutomationCmd,
	ClipMixerWriteCmd,
	ClipMixerSetCmd,
	AudioSetGainCmd,
	AudioAutoDuckCmd,
	MixerSetLoudnessCmd,
] as const;
