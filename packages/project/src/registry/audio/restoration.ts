// audio-fx restoration and speech effects (ported from filmcraft `audio-dsp/src/effects/restoration.rs`,
// `essential.rs` and `declick.rs`): DeHummer, DeNoise (spectral gating, adaptive or learned noise print), DeEsser,
// DeReverb, Enhance Speech and Automatic Click Remover. Folders follow Premiere's Audio Effects panel.
import type { EffectSpec } from '../effects.ts';
import { defineAudioEffect, audioParam as P } from './define.ts';

const FOLDER = 'Noise Reduction/Restoration' as const;

export const AUDIO_RESTORATION_EFFECTS: readonly EffectSpec[] = [
	defineAudioEffect({
		id: 'jasper.audio.click-remover',
		label: 'Automatic Click Remover',
		category: FOLDER,
		expensive: true,
		description:
			'Finds clicks and crackle as outliers of a linear-prediction residual and re-synthesises them from the surrounding audio.',
		keywords: ['declick', 'crackle', 'pops', 'vinyl', 'repair', 'restoration'],
		params: [
			P.num('threshold', 'Threshold', 30, 1, 100, { step: 1 }),
			P.num('complexity', 'Complexity', 16, 1, 100, { step: 1 }),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.dehummer',
		label: 'DeHummer',
		category: FOLDER,
		editor: 'filter-response',
		description:
			'Removes mains hum: narrow notches at 50 or 60 Hz and its harmonics (Output Hum Only plays what is removed).',
		keywords: ['hum', 'dehum', 'mains', 'buzz', '50 hz', '60 hz', 'ground loop', 'repair'],
		params: [
			P.choice(
				'frequency',
				'Frequency',
				[
					['50', '50 Hz'],
					['60', '60 Hz'],
				],
				'60',
			),
			P.num('harmonics', 'Number of Harmonics', 5, 1, 10, { step: 1 }),
			P.q('q', 'Q', 30, 1, 100),
			P.pct('amount', 'Amount', 100),
			P.toggle('humOnly', 'Output Hum Only', false),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.deesser',
		label: 'DeEsser',
		category: FOLDER,
		meters: ['gain-reduction'],
		description:
			'Reduces sibilance: a high-pass side chain detects "s" sounds and a dynamic high shelf cuts the band above Frequency.',
		keywords: ['sibilance', 'de-ess', 'esses', 'harsh', 'voice', 'dialogue'],
		params: [
			P.hz('frequency', 'Frequency', 6000, 2000, 12000),
			P.db('threshold', 'Threshold', -12, -40, 0),
			P.db('reduction', 'Max Reduction', 8, 0, 24),
			P.toggle('sibilanceOnly', 'Output Sibilance Only', false),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.denoise',
		label: 'DeNoise',
		category: FOLDER,
		expensive: true,
		description:
			'Spectral noise gate: bins that do not rise above the noise floor (tracked automatically, or a learned noise print) are attenuated by Reduction.',
		keywords: ['noise reduction', 'hiss', 'background noise', 'noise print', 'denoiser', 'repair'],
		params: [
			P.db('reduction', 'Reduction', 12, 0, 40),
			P.db('threshold', 'Threshold', 6, 0, 20),
			P.pct('smoothing', 'Smoothing', 50),
			P.choice(
				'noiseModel',
				'Noise Model',
				[
					['adaptive', 'Adaptive'],
					['learn', 'Learn Noise Print'],
					['print', 'Use Noise Print'],
				],
				'adaptive',
			),
			P.db('gain', 'Output Gain', 0, -20, 20),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.dereverb',
		label: 'DeReverb',
		category: FOLDER,
		expensive: true,
		description:
			'Suppresses the late reverberant tail predicted by an exponential decay model (spectral subtraction with a floor).',
		keywords: ['reverb', 'echo', 'room', 'dereverberation', 'repair', 'dialogue'],
		params: [P.pct('amount', 'Amount', 50), P.seconds('rt60', 'Decay (RT60)', 0.8, 0.1, 5)],
	}),
	defineAudioEffect({
		id: 'jasper.audio.enhance-speech',
		label: 'Enhance Speech',
		category: 'Special',
		description:
			'Voice enhancement chain: rumble cut, de-mud, presence and air, then a combined downward expander and soft-knee compressor.',
		keywords: ['speech', 'voice', 'dialogue', 'clarity', 'enhance', 'podcast'],
		params: [
			P.pct('mix', 'Mix', 100),
			P.choice(
				'tone',
				'Tone',
				[
					['low', 'Low Tone (lower voices)'],
					['high', 'High Tone (higher voices)'],
				],
				'low',
			),
		],
	}),
];
