// audio-fx "Delay and Echo" and "Modulation" effects (ported from filmcraft `audio-dsp/src/effects/time.rs` Delay and
// `modulation.rs`): Delay (time or tempo-synced), Analog Delay, Multitap Delay, Chorus/Flanger, Flanger and Phaser.
// Parameter names follow Premiere / Audition (wp-note §Sources).
import type { EffectSpec, ParamSpec } from '../effects.ts';
import { defineAudioEffect, audioParam as P } from './define.ts';

/** Note divisions of the tempo-synced Delay (quarter notes in the DSP). */
export const DELAY_DIVISIONS = [
	['1/1', '1/1'],
	['1/2', '1/2'],
	['1/4', '1/4'],
	['1/8', '1/8'],
	['1/16', '1/16'],
	['1/4d', '1/4 dotted'],
	['1/8d', '1/8 dotted'],
	['1/4t', '1/4 triplet'],
	['1/8t', '1/8 triplet'],
] as const;

function tap(n: number, delay: number, level: number): ParamSpec[] {
	const g = `Tap ${n}`;
	return [
		P.ms(`delay${n}`, `Delay ${n}`, delay, 1, 4000, { group: g }),
		P.pct(`feedback${n}`, `Feedback ${n}`, 0, 0, 95, { group: g }),
		P.db(`level${n}`, `Level ${n}`, level, -96, 0, { group: g }),
	];
}

export const AUDIO_DELAY_MODULATION_EFFECTS: readonly EffectSpec[] = [
	defineAudioEffect({
		id: 'jasper.audio.analog-delay',
		label: 'Analog Delay',
		category: 'Delay and Echo',
		description:
			'Warm echo with a coloured, saturating feedback path (tape, tape/tube or bucket-brigade style) and stereo spread.',
		keywords: ['echo', 'tape delay', 'slapback', 'analog', 'vintage'],
		params: [
			P.choice(
				'mode',
				'Mode',
				[
					['tape', 'Tape'],
					['tapeTube', 'Tape/Tube'],
					['analog', 'Analog'],
				],
				'tape',
			),
			P.pct('dry', 'Dry Out', 100),
			P.pct('wet', 'Wet Out', 40),
			P.ms('delay', 'Delay', 250, 5, 8000),
			P.pct('feedback', 'Feedback', 40, 0, 200),
			P.pct('trash', 'Trash', 0, 0, 200),
			P.pct('spread', 'Spread', 0, 0, 200),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.delay',
		label: 'Delay',
		category: 'Delay and Echo',
		description: 'Echo after a delay time (or a note value at a tempo), with feedback and mix.',
		keywords: ['echo', 'repeat', 'tempo', 'sync'],
		params: [
			P.choice(
				'mode',
				'Mode',
				[
					['time', 'Time'],
					['tempo', 'Tempo'],
				],
				'time',
			),
			P.ms('time', 'Delay', 1000, 1, 2000),
			P.bpm('bpm', 'Tempo', 120, 20, 300),
			P.choice('division', 'Division', DELAY_DIVISIONS, '1/8'),
			P.pct('feedback', 'Feedback', 0, 0, 95),
			P.pct('mix', 'Mix', 50),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.multitap-delay',
		label: 'Multitap Delay',
		category: 'Delay and Echo',
		description: 'Four independent echo taps, each with its own delay, feedback and level.',
		keywords: ['echo', 'taps', 'rhythmic', 'delay'],
		params: [
			...tap(1, 250, -6),
			...tap(2, 500, -9),
			...tap(3, 750, -12),
			...tap(4, 1000, -15),
			P.pct('mix', 'Mix', 50),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.chorus-flanger',
		label: 'Chorus/Flanger',
		category: 'Modulation',
		description: 'Chorus (three modulated voices, 15–35 ms) or flanger (one swept voice with feedback).',
		keywords: ['chorus', 'flanger', 'doubling', 'ensemble', 'modulation'],
		params: [
			P.choice(
				'mode',
				'Mode',
				[
					['chorus', 'Chorus'],
					['flanger', 'Flanger'],
				],
				'chorus',
			),
			P.hz('speed', 'Speed', 0.8, 0.05, 10, { step: 0.01 }),
			P.pct('width', 'Width', 50),
			P.pct('intensity', 'Intensity', 30),
			P.pct('transience', 'Transience', 0),
			P.pct('mix', 'Mix', 50),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.flanger',
		label: 'Flanger',
		category: 'Modulation',
		description:
			'Classic flanger: the delay sweeps between the initial and final delay; stereo phasing, feedback, inverted and special-effects modes.',
		keywords: ['flange', 'jet', 'sweep', 'modulation'],
		params: [
			P.ms('initialDelay', 'Initial Delay Time', 1, 0.1, 20),
			P.ms('finalDelay', 'Final Delay Time', 5, 0.1, 20),
			P.num('stereoPhasing', 'Stereo Phasing (°)', 90, 0, 180, { step: 1 }),
			P.pct('feedback', 'Feedback', 50, -100, 100),
			P.hz('rate', 'Modulation Rate', 0.5, 0.01, 10, { step: 0.01 }),
			P.toggle('inverted', 'Inverted', false),
			P.toggle('special', 'Special Effects', false),
			P.toggle('sinusoidal', 'Sinusoidal', true),
			P.pct('mix', 'Mix', 50),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.phaser',
		label: 'Phaser',
		category: 'Modulation',
		description: 'A swept cascade of all-pass stages with feedback (notches moving through the spectrum).',
		keywords: ['phase', 'sweep', 'modulation', 'psychedelic'],
		params: [
			P.num('stages', 'Stages', 4, 2, 12, { step: 2 }),
			P.pct('intensity', 'Intensity', 100),
			P.pct('depth', 'Depth', 70),
			P.hz('rate', 'Modulation Rate', 0.5, 0.01, 10, { step: 0.01 }),
			P.num('phaseDiff', 'Phase Difference (°)', 90, 0, 180, { step: 1 }),
			P.hz('upperFreq', 'Upper Frequency', 2500, 100, 20000),
			P.pct('feedback', 'Feedback', 0, -100, 100),
			P.pct('mix', 'Mix', 50),
			P.db('output', 'Output Gain', 0, -24, 24),
		],
	}),
];
