/**
 * @jasper/audio-dsp — pure, deterministic, allocation-free-in-the-hot-path audio DSP (AudioWorklet friendly):
 * BS.1770-4 / EBU R128 loudness, true-peak detection and limiting, level meters, channel layouts and pan
 * laws, auto-ducking analysis, WAV I/O, band-limited resampling, audio sync (two-pass GCC-PHAT, wp-multicam) and voice
 * analysis frames (levels, voicing, flatness, speech / breath / silence classes; spec 14 TC-001).
 * Audio is planar `Float32Array[]`.
 *
 * Large parts are ported from FilmCraft `crates/audio-dsp` (MIT OR Apache-2.0,
 * Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors); see licenses/ported/audio-mix.md.
 */
export {
	BIQUAD_IDENTITY,
	Biquad,
	type BiquadCoeffs,
	bilinearHighPass,
	bilinearHighShelf,
	bilinearSection,
	biquadMagnitude,
	biquadMagnitudeDb,
	designBiquad,
	type FilterType,
	flushDenormal,
} from './biquad.ts';
export {
	applyMatrix,
	balanceGains,
	CH_C,
	CH_L,
	CH_LFE,
	CH_LS,
	CH_R,
	CH_RS,
	channelCount,
	channelNames,
	channelPeaks,
	conversionMatrix,
	convertChannels,
	convertLayout,
	DEFAULT_PAN51,
	K,
	LAYOUTS,
	type Layout,
	layoutFromChannels,
	MIXDOWNS,
	type Mixdown,
	mixdownFromId,
	type Pan51,
	pan51Matrix,
	pan51MatrixInto,
	panMonoGains,
	pointGains51,
} from './channels.ts';
export {
	activeRegions,
	DUCK_BRIDGE_S,
	DUCK_HOP_S,
	DUCK_MIN_ON_S,
	DUCK_WINDOW_S,
	type DuckingPlan,
	type DuckingPlanInput,
	type DuckKeyframe,
	duckKeyframes,
	envelopeDb,
	FLOOR_DB,
	planDucking,
	sensitivityThresholdDb,
} from './ducking.ts';
export { Fft, fft, nextPow2 } from './fft.ts';
export { K_PREFILTER_PROTOTYPE, K_RLB_PROTOTYPE, kPrefilter, kRlb } from './kweight.ts';
export { limitBuffer, TruePeakLimiter, type TruePeakLimiterOptions } from './limiter.ts';
export {
	defaultChannelWeights,
	energyToLufs,
	LoudnessMeter,
	type LoudnessMeterOptions,
	type LoudnessSummary,
	measureLoudness,
	type NormalizeGain,
	normalizeGainDb,
} from './loudness.ts';
export {
	dbToLin,
	faderDbToGain,
	LevelMeter,
	type LevelMeterOptions,
	type LevelReading,
	linToDb,
	MeterBallistics,
	type MeterBallisticsOptions,
} from './meter.ts';
export {
	besselI0,
	Interpolator,
	PolyphaseBank,
	TAPS_PER_PHASE,
	TruePeakDetector,
	truePeakFactor,
} from './oversample.ts';
export { type ResampleQuality, resample } from './resample.ts';
export { Smoothed } from './smooth.ts';
export {
	type CoarseResult,
	coarseOffset,
	decimate,
	findOffset,
	isReliable,
	loudestCommonWindow,
	mixdown,
	RELIABLE_CONFIDENCE,
	RELIABLE_DISTINCT,
	refineMargin,
	refineOffset,
	SYNC_DEFAULTS,
	type SyncOptions,
	type SyncResult,
} from './sync.ts';
export { type DecodedWav, decodeWav, encodeWav, type WavFormat, wavChannelMask } from './wav.ts';
export {
	classifyVoiceFrames,
	DIGITAL_SILENCE_DB,
	type LevelStats,
	levelStats,
	quantiseUnit,
	quantiseVoiceLevel,
	speechThresholdDb,
	unitOf,
	VOICE_CLASS_BREATH,
	VOICE_CLASS_RULES,
	VOICE_CLASS_SILENCE,
	VOICE_CLASS_SPEECH,
	VOICE_HOP,
	VOICE_LEVEL_MIN_DB,
	VOICE_LEVEL_STEP_DB,
	VOICE_SAMPLE_RATE,
	VOICE_WINDOW,
	VOICE_WINDOW_LEAD,
	VOICE_WINDOW_TAIL,
	VoiceFeatureExtractor,
	type VoiceFeaturePlanes,
	type VoiceLevels,
	voiceFeatures,
	voiceFrameCount,
	voiceLevelDb,
	voiceLevels,
} from './voice.ts';
