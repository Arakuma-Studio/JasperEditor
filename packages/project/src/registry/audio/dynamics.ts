// audio-fx "Amplitude and Compression" dynamics (ported from filmcraft `audio-dsp/src/effects/dynamics.rs` and
// `multiband.rs`): Single-band Compressor, Expander / Gate, Hard Limiter (true peak via @jasper/audio-dsp's limiter),
// Dynamics (auto gate · compressor · expander · limiter rack), Multiband Compressor and Tube-modeled Compressor.
// Names, ranges and defaults follow Premiere Pro / Audition's effect reference where documented (wp-note §Sources).
import type { EffectSpec, ParamSpec } from '../effects.ts';
import { defineAudioEffect, audioParam as P } from './define.ts';

const FOLDER = 'Amplitude and Compression' as const;

const DETECTOR = [
	['peak', 'Peak'],
	['rms', 'RMS'],
] as const;

function mbBand(n: number, def: { threshold: number }): ParamSpec[] {
	const g = `Band ${n}`;
	return [
		P.db(`b${n}Threshold`, `${g} Threshold`, def.threshold, -60, 0, { group: g }),
		P.ratio(`b${n}Ratio`, `${g} Ratio`, 3, 1, 30, { group: g }),
		P.ms(`b${n}Attack`, `${g} Attack`, 10, 0.1, 500, { group: g }),
		P.ms(`b${n}Release`, `${g} Release`, 100, 1, 5000, { group: g }),
		P.db(`b${n}Gain`, `${g} Output Gain`, 0, -18, 18, { group: g }),
		P.toggle(`b${n}Solo`, `${g} Solo`, false, { group: g }),
		P.toggle(`b${n}Bypass`, `${g} Bypass`, false, { group: g }),
	];
}

export const AUDIO_DYNAMICS_EFFECTS: readonly EffectSpec[] = [
	defineAudioEffect({
		id: 'jasper.audio.dynamics',
		label: 'Dynamics',
		category: FOLDER,
		editor: 'dynamics',
		meters: ['gain-reduction'],
		description:
			'Auto Gate, Compressor, Expander and Limiter sections in series (stereo-linked), with soft clipping and output gain.',
		keywords: ['gate', 'noise gate', 'compressor', 'expander', 'limiter', 'dynamics processing'],
		params: [
			P.toggle('gateOn', 'AutoGate', false, { group: 'AutoGate' }),
			P.db('gateThreshold', 'Threshold', -50, -80, 0, { group: 'AutoGate' }),
			P.ms('gateAttack', 'Attack', 2, 0.1, 100, { group: 'AutoGate' }),
			P.ms('gateRelease', 'Release', 100, 1, 3000, { group: 'AutoGate' }),
			P.ms('gateHold', 'Hold', 50, 0, 1000, { group: 'AutoGate' }),
			P.toggle('compOn', 'Compressor', true, { group: 'Compressor' }),
			P.db('compThreshold', 'Threshold', -20, -60, 0, { group: 'Compressor' }),
			P.ratio('compRatio', 'Ratio', 2, 1, 30, { group: 'Compressor' }),
			P.ms('compAttack', 'Attack', 10, 0.1, 300, { group: 'Compressor' }),
			P.ms('compRelease', 'Release', 100, 1, 3000, { group: 'Compressor' }),
			P.toggle('compAuto', 'Auto Makeup', false, { group: 'Compressor' }),
			P.db('compMakeup', 'Makeup', 0, 0, 30, { group: 'Compressor' }),
			P.toggle('expOn', 'Expander', false, { group: 'Expander' }),
			P.db('expThreshold', 'Threshold', -60, -80, 0, { group: 'Expander' }),
			P.ratio('expRatio', 'Ratio', 2, 1, 30, { group: 'Expander' }),
			P.toggle('limOn', 'Limiter', false, { group: 'Limiter' }),
			P.db('limThreshold', 'Threshold', -1, -30, 0, { group: 'Limiter' }),
			P.ms('limRelease', 'Release', 50, 1, 1000, { group: 'Limiter' }),
			P.toggle('softClip', 'Soft Clip', false, { group: 'Limiter' }),
			P.db('output', 'Output Gain', 0, -30, 30),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.expander-gate',
		label: 'Expander / Gate',
		category: FOLDER,
		editor: 'dynamics',
		meters: ['gain-reduction'],
		description:
			'Downward expander and noise gate with hold: attenuates the signal below the threshold by the ratio, at most by Range.',
		keywords: ['gate', 'noise gate', 'expander', 'downward expansion'],
		params: [
			P.db('threshold', 'Threshold', -40, -90, 0),
			P.ratio('ratio', 'Ratio', 10, 1, 100),
			P.db('range', 'Range', 60, 0, 90),
			P.ms('attack', 'Attack', 1, 0.01, 100),
			P.ms('hold', 'Hold', 50, 0, 2000),
			P.ms('release', 'Release', 150, 1, 3000),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.hard-limiter',
		label: 'Hard Limiter',
		category: FOLDER,
		editor: 'limiter',
		meters: ['gain-reduction'],
		description:
			'Look-ahead brick-wall limiter: the output never exceeds Maximum Amplitude (true-peak detection with 4× oversampling, or sample peak).',
		keywords: ['limiter', 'brickwall', 'true peak', 'maximizer', 'ceiling', 'loudness'],
		params: [
			P.db('maxAmplitude', 'Maximum Amplitude', -0.1, -20, 0),
			P.db('inputBoost', 'Input Boost', 0, 0, 24),
			P.ms('lookAhead', 'Look-Ahead Time', 7, 1, 20, { animatable: false }),
			P.ms('release', 'Release Time', 100, 1, 1000, { animatable: false }),
			P.toggle('truePeak', 'True Peak', true, { animatable: false }),
			P.toggle('linkChannels', 'Link Channels', true, { animatable: false }),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.multiband-compressor',
		label: 'Multiband Compressor',
		category: FOLDER,
		editor: 'multiband-compressor',
		meters: ['gain-reduction'],
		description:
			'Four bands split by Linkwitz–Riley crossovers (phase-compensated, they sum flat), each compressed on its own, plus a limiter.',
		keywords: ['multiband', 'compressor', 'mastering', 'crossover', 'bands'],
		params: [
			P.hz('xo1', 'Low Crossover', 120, 20, 1000),
			P.hz('xo2', 'Mid Crossover', 2000, 100, 8000),
			P.hz('xo3', 'High Crossover', 10000, 1000, 20000),
			...mbBand(1, { threshold: -18 }),
			...mbBand(2, { threshold: -18 }),
			...mbBand(3, { threshold: -18 }),
			...mbBand(4, { threshold: -18 }),
			P.db('output', 'Output Gain', 0, -18, 18),
			P.toggle('limOn', 'Limiter', false, { group: 'Limiter' }),
			P.db('limThreshold', 'Limiter Threshold', -0.1, -30, 0, { group: 'Limiter' }),
			P.ms('limRelease', 'Limiter Release', 50, 1, 1000, { group: 'Limiter' }),
			P.toggle('link', 'Link Channels', true),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.single-band-compressor',
		label: 'Single-band Compressor',
		category: FOLDER,
		editor: 'compressor',
		meters: ['gain-reduction'],
		description:
			'Feed-forward compressor (stereo-linked peak or RMS detection, soft knee, attack/release) with output gain.',
		keywords: ['compressor', 'compression', 'dynamics', 'leveling'],
		params: [
			P.db('threshold', 'Threshold', -20, -60, 0),
			P.ratio('ratio', 'Ratio', 4, 1, 30),
			P.db('knee', 'Knee', 6, 0, 24),
			P.ms('attack', 'Attack', 10, 0.01, 500),
			P.ms('release', 'Release', 100, 1, 5000),
			P.db('output', 'Output Gain', 0, -30, 30),
			P.choice('detector', 'Detector', DETECTOR, 'peak'),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.tube-compressor',
		label: 'Tube-modeled Compressor',
		category: FOLDER,
		editor: 'compressor',
		meters: ['gain-reduction'],
		description:
			'Warm RMS compressor with a wide soft knee, program-dependent release and gentle tube-style saturation.',
		keywords: ['tube', 'valve', 'compressor', 'warm', 'saturation', 'vintage'],
		params: [
			P.db('threshold', 'Threshold', -20, -60, 0),
			P.ratio('ratio', 'Ratio', 4, 1, 30),
			P.ms('attack', 'Attack', 10, 0.1, 500),
			P.ms('release', 'Release', 100, 1, 5000),
			P.db('output', 'Output Gain', 0, -30, 30),
		],
	}),
];
