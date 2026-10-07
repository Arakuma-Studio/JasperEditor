// audio-fx special effects (ported from filmcraft `audio-dsp/src/effects/special.rs`): Distortion, GuitarSuite,
// Mastering, Vocal Enhancer, Loudness Meter and Mute; plus Loudness Auto Gain (ours: a BS.1770 short-term loudness
// rider). Folders follow Premiere's Audio Effects panel.
import type { EffectSpec } from '../effects.ts';
import { defineAudioEffect, audioParam as P } from './define.ts';

export const AUDIO_SPECIAL_EFFECTS: readonly EffectSpec[] = [
	defineAudioEffect({
		id: 'jasper.audio.auto-gain',
		label: 'Loudness Auto Gain',
		category: 'Amplitude and Compression',
		meters: ['level'],
		description:
			'Rides the gain so the short-term loudness (BS.1770, 3 s) approaches the target, within Max Boost / Max Cut; holds below the silence threshold.',
		keywords: ['loudness', 'lufs', 'auto level', 'leveler', 'normalize', 'agc', 'rider'],
		params: [
			P.lufs('target', 'Target Loudness', -23, -40, -5),
			P.db('maxBoost', 'Max Boost', 12, 0, 30),
			P.db('maxCut', 'Max Cut', 12, 0, 30),
			P.ms('response', 'Response Time', 2000, 100, 10000),
			P.lufs('silence', 'Silence Threshold', -50, -70, -20),
			P.db('ceiling', 'Peak Ceiling', -1, -12, 0),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.distortion',
		label: 'Distortion',
		category: 'Special',
		description: 'Waveshaping distortion with drive, curve, asymmetry (DC-blocked), tone, output and mix.',
		keywords: ['overdrive', 'saturation', 'fuzz', 'clip', 'crunch', 'grit'],
		params: [
			P.db('drive', 'Drive', 12, 0, 48),
			P.choice(
				'curve',
				'Curve',
				[
					['soft', 'Soft Clip'],
					['hard', 'Hard Clip'],
					['tube', 'Tube'],
					['foldback', 'Foldback'],
				],
				'soft',
			),
			P.pct('symmetry', 'Asymmetry', 0, -100, 100),
			P.hz('tone', 'Tone', 20000, 500, 20000),
			P.db('output', 'Output Gain', 0, -48, 12),
			P.pct('mix', 'Mix', 100),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.guitar-suite',
		label: 'GuitarSuite',
		category: 'Special',
		description:
			'Guitar chain: compressor → distortion → amplifier/cabinet voicing → filter, with mix and output.',
		keywords: ['guitar', 'amp', 'cabinet', 'distortion', 'overdrive'],
		params: [
			P.pct('compressor', 'Compressor', 30),
			P.pct('distortion', 'Distortion', 40),
			P.choice(
				'distType',
				'Distortion Type',
				[
					['soft', 'Soft'],
					['hard', 'Hard'],
					['fuzz', 'Fuzz'],
				],
				'soft',
			),
			P.choice(
				'amp',
				'Amplifier',
				[
					['none', 'None'],
					['cleanCombo', 'Clean Combo'],
					['britishStack', 'British Stack'],
					['tweed', 'Tweed'],
					['modernHighGain', 'Modern High Gain'],
				],
				'cleanCombo',
			),
			P.choice(
				'filter',
				'Filter',
				[
					['none', 'None'],
					['lowPass', 'Low Pass'],
					['highPass', 'High Pass'],
					['bandPass', 'Band Pass'],
				],
				'none',
			),
			P.hz('filterFreq', 'Filter Frequency', 2000, 100, 10000),
			P.pct('filterRes', 'Filter Resonance', 20),
			P.pct('mix', 'Mix', 100),
			P.db('output', 'Output Gain', 0, -24, 12),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.loudness-meter',
		label: 'Loudness Meter',
		category: 'Special',
		meters: ['loudness'],
		description:
			'Measures BS.1770 / EBU R128 loudness (momentary, short-term, integrated, range, true peak) at its place in the chain; audio passes unchanged.',
		keywords: ['loudness', 'lufs', 'r128', 'meter', 'radar', 'true peak'],
		params: [P.lufs('target', 'Target Loudness', -23, -36, -5)],
	}),
	defineAudioEffect({
		id: 'jasper.audio.mastering',
		label: 'Mastering',
		category: 'Special',
		editor: 'filter-response',
		description:
			'Mastering chain: three-band EQ → reverb → exciter → widener → loudness maximizer → output (transparent at its defaults).',
		keywords: ['master', 'maximizer', 'exciter', 'widener', 'polish', 'loudness'],
		params: [
			P.db('eqLow', 'Low Shelf Gain', 0, -12, 12, { group: 'Equalizer' }),
			P.hz('eqMidFreq', 'Peak Frequency', 1000, 100, 10000, { group: 'Equalizer' }),
			P.db('eqMid', 'Peak Gain', 0, -12, 12, { group: 'Equalizer' }),
			P.db('eqHigh', 'High Shelf Gain', 0, -12, 12, { group: 'Equalizer' }),
			P.pct('reverb', 'Reverb Amount', 0),
			P.pct('exciter', 'Exciter Amount', 0, 0, 100, { group: 'Exciter' }),
			P.choice(
				'exciterMode',
				'Exciter Mode',
				[
					['retro', 'Retro'],
					['tape', 'Tape'],
					['tube', 'Tube'],
				],
				'tape',
				{ group: 'Exciter' },
			),
			P.pct('widener', 'Widener', 100, 0, 200),
			P.pct('loudness', 'Loudness Maximizer', 0),
			P.db('output', 'Output Gain', 0, -24, 12),
		],
	}),
	defineAudioEffect({
		id: 'jasper.audio.mute',
		label: 'Mute',
		category: 'Amplitude and Compression',
		description: 'Silences the audio with a 5 ms ramp (keyframe it to mute passages without clicks).',
		keywords: ['silence', 'mute', 'cut'],
		params: [P.toggle('mute', 'Mute', false)],
	}),
	defineAudioEffect({
		id: 'jasper.audio.vocal-enhancer',
		label: 'Vocal Enhancer',
		category: 'Special',
		editor: 'filter-response',
		description:
			'Fixed voicings: Male / Female (rumble cut, de-mud, presence, air, gentle compression) or Music (carves room for a voice).',
		keywords: ['voice', 'vocal', 'dialogue', 'clarity', 'presence'],
		params: [
			P.choice(
				'mode',
				'Mode',
				[
					['male', 'Male'],
					['female', 'Female'],
					['music', 'Music'],
				],
				'male',
			),
		],
	}),
];
