// audio-fx "Time and Pitch": Pitch Shifter (`@jasper/audio-fx` effects/pitch.ts). Duration unchanged, aligned at
// 0 ms. Stored instances without `engine` keep the v1 phase vocoder (`legacy`); new instances get Signalsmith Stretch.
import type { EffectSpec } from '../effects.ts';
import { defineAudioEffect, audioParam as P } from './define.ts';

export const AUDIO_PITCH_EFFECTS: readonly EffectSpec[] = [
	defineAudioEffect({
		id: 'jasper.audio.pitch-shifter',
		label: 'Pitch Shifter',
		category: 'Time and Pitch',
		expensive: true,
		description:
			'Shifts the pitch by semitones and cents without changing the duration. Engines: Signalsmith Stretch, Rubber Band R3 (both with Preserve Formants) or the legacy phase vocoder.',
		keywords: ['pitch', 'transpose', 'tune', 'semitone', 'voice', 'chipmunk', 'formant', 'rubber band'],
		params: [
			P.semitones('semitones', 'Semi-tones', 0, -12, 12),
			P.cents('cents', 'Cents', 0, -100, 100),
			P.choice(
				'engine',
				'Engine',
				[
					['legacy', 'Legacy'],
					['signalsmith', 'Signalsmith Stretch'],
					['rubberband-r3', 'Rubber Band R3'],
				],
				'legacy',
				{ animatable: false },
			),
			P.choice(
				'quality',
				'Quality',
				[
					['best', 'Best'],
					['fast', 'Fast'],
				],
				'best',
				{ animatable: false },
			),
			P.toggle('preserveFormants', 'Preserve Formants', false),
		],
		instanceDefaults: () => ({ engine: 'signalsmith' }),
	}),
];
