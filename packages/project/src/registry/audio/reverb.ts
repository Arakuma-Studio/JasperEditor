// audio-fx "Reverb" effects (ported from filmcraft `audio-dsp/src/effects/time.rs` Reverb and `reverbs.rs`): Studio
// Reverb (8-line FDN), Convolution Reverb (generated impulse responses — no recorded IRs) and Surround Reverb.
import type { EffectSpec } from '../effects.ts';
import { defineAudioEffect, audioParam as P } from './define.ts';

const FOLDER = 'Reverb' as const;

/** The procedurally generated impulses of the Convolution Reverb (no recorded or third-party IRs). */
export const CONVOLUTION_IMPULSES = [
	['smallRoom', 'Small Room'],
	['mediumRoom', 'Medium Room'],
	['largeHall', 'Large Hall'],
	['cathedral', 'Cathedral'],
	['plate', 'Plate'],
	['ambience', 'Ambience'],
	['vocalBooth', 'Vocal Booth'],
] as const;

export const AUDIO_REVERB_EFFECTS: readonly EffectSpec[] = [
	defineAudioEffect({
		id: 'jasper.audio.convolution-reverb',
		label: 'Convolution Reverb',
		category: FOLDER,
		expensive: true,
		description:
			'Convolves the signal with a generated room, hall, plate or booth impulse (partitioned FFT convolution), with room size, damping and pre-delay.',
		keywords: ['reverb', 'impulse response', 'room', 'hall', 'space', 'convolution'],
		params: [
			P.choice('impulse', 'Impulse', CONVOLUTION_IMPULSES, 'mediumRoom', { animatable: false }),
			P.pct('mix', 'Mix', 30),
			P.pct('roomSize', 'Room Size', 100, 10, 100, { animatable: false }),
			P.hz('dampingLf', 'Damping LF', 10, 10, 1000, { animatable: false }),
			P.hz('dampingHf', 'Damping HF', 20000, 1000, 20000, { animatable: false }),
			P.ms('preDelay', 'Pre-Delay', 0, 0, 500),
			P.pct('width', 'Width', 100),
			P.db('gain', 'Gain', 0, -24, 12),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.studio-reverb',
		label: 'Studio Reverb',
		category: FOLDER,
		description:
			'Algorithmic reverb: an 8-line feedback delay network with a Householder matrix, decay time, high-frequency damping, size and pre-delay.',
		keywords: ['reverb', 'room', 'hall', 'algorithmic', 'space', 'echo'],
		params: [
			P.ms('preDelay', 'Pre-Delay', 20, 0, 200),
			P.seconds('decay', 'Decay (RT60)', 2, 0.1, 20),
			P.pct('damping', 'Damping', 40),
			P.pct('roomSize', 'Room Size', 50),
			P.pct('mix', 'Mix', 25),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.surround-reverb',
		label: 'Surround Reverb',
		category: FOLDER,
		description:
			'Early reflections plus a dense late field, with centre input level, low/high cut, width and separate dry and wet levels.',
		keywords: ['reverb', 'surround', 'ambience', 'space', 'early reflections'],
		params: [
			P.pct('centerInput', 'Center Input', 100),
			P.pct('roomSize', 'Room Size', 50),
			P.seconds('decay', 'Decay', 1.5, 0.1, 20),
			P.ms('preDelay', 'Pre-Delay', 20, 0, 200),
			P.pct('damping', 'Damping', 40),
			P.pct('early', 'Early Reflections', 40),
			P.hz('lowCut', 'Low Frequency Cut', 20, 20, 1000),
			P.hz('highCut', 'High Frequency Cut', 12000, 1000, 20000),
			P.pct('width', 'Width', 100),
			P.pct('dry', 'Dry', 80),
			P.pct('wet', 'Wet', 30),
		],
	}),
];
