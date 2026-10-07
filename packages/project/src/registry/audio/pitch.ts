// audio-fx "Time and Pitch" (ported from filmcraft `audio-dsp/src/effects/pitch.rs`): Pitch Shifter (phase vocoder
// with peak-region shifting and identity phase locking; duration unchanged).
import type { EffectSpec } from '../effects.ts';
import { defineAudioEffect, audioParam as P } from './define.ts';

export const AUDIO_PITCH_EFFECTS: readonly EffectSpec[] = [
	defineAudioEffect({
		id: 'jasper.audio.pitch-shifter',
		label: 'Pitch Shifter',
		category: 'Time and Pitch',
		expensive: true,
		description:
			'Shifts the pitch by semitones and cents without changing the duration (phase vocoder with phase locking).',
		keywords: ['pitch', 'transpose', 'tune', 'semitone', 'voice', 'chipmunk'],
		params: [P.semitones('semitones', 'Semi-tones', 0, -12, 12), P.cents('cents', 'Cents', 0, -100, 100)],
	}),
];
