// audio-fx "Filter and EQ" family (Premiere's Filter and EQ folder): graphic, parametric and simple equalisers,
// pass/shelving/notch filters, the Scientific Filter (classical IIR designs) and the FFT Filter. DSP:
// packages/audio-fx/src/effects/filter-eq.ts (ported from filmcraft `effects/eq.rs`, `effects/filters.rs`,
// `design.rs`; the simple filters are RBJ cookbook biquads).
import type { EffectSpec, ParamSpec } from '../effects.ts';
import { audioParam as P, defineAudioEffect } from './define.ts';

const FOLDER = 'Filter and EQ' as const;

/** Band filter types of the 8-band parametric EQ (order = `FILTER_TYPES` of `@jasper/audio-fx` biquads). */
export const EQ_BAND_TYPES = [
	['peaking', 'Peaking'],
	['lowShelf', 'Low Shelf'],
	['highShelf', 'High Shelf'],
	['lowPass', 'Low Pass'],
	['highPass', 'High Pass'],
	['notch', 'Notch'],
	['bandPass', 'Band Pass'],
] as const;

/** Pass-filter slopes of the Parametric Equalizer (Butterworth order = index + 1). */
export const EQ_PASS_SLOPES = [
	['6', '6 dB/oct'],
	['12', '12 dB/oct'],
	['18', '18 dB/oct'],
	['24', '24 dB/oct'],
	['30', '30 dB/oct'],
	['36', '36 dB/oct'],
	['42', '42 dB/oct'],
	['48', '48 dB/oct'],
] as const;

/** ISO 266 nominal centre frequencies of the graphic equalisers: octave, half-octave and third-octave bands. */
export const GRAPHIC_EQ_FREQS: Readonly<Record<10 | 20 | 30, readonly number[]>> = {
	10: [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
	20: [
		31.5, 45, 63, 90, 125, 180, 250, 355, 500, 710, 1000, 1400, 2000, 2800, 4000, 5600, 8000, 11200, 16000, 22400,
	],
	30: [
		25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
		4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
	],
};

function freqLabel(f: number): string {
	return f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`;
}

function graphicEq(bands: 10 | 20 | 30): EffectSpec {
	const width = bands === 10 ? 'octave' : bands === 20 ? 'half-octave' : 'third-octave';
	return defineAudioEffect({
		id: `jasper.audio.graphic-equalizer-${bands}`,
		label: `Graphic Equalizer (${bands} Bands)`,
		category: FOLDER,
		params: [
			...GRAPHIC_EQ_FREQS[bands].map((f, i) =>
				P.db(`b${i + 1}`, freqLabel(f), 0, -24, 24, { group: 'Bands' }),
			),
			P.db('gain', 'Master Gain', 0, -24, 24),
		],
		editor: 'graphic-eq',
		description: `${bands} constant-Q ${width} bands at the ISO centre frequencies, ±24 dB each, plus master gain.`,
		keywords: ['eq', 'equalizer', 'graphic', 'bands', 'tone', width],
	});
}

/** Pass / shelf / peak / notch: one smoothed RBJ biquad. */
function band(
	id: string,
	label: string,
	params: ParamSpec[],
	description: string,
	keywords: readonly string[],
): EffectSpec {
	return defineAudioEffect({
		id: `jasper.audio.${id}`,
		label,
		category: FOLDER,
		params,
		editor: 'filter-response',
		description,
		keywords,
	});
}

function parametricBand(prefix: string, name: string, freq: number, q: number): ParamSpec[] {
	return [
		P.toggle(`${prefix}On`, `${name} On`, true, { group: name }),
		P.hz(`${prefix}Freq`, `${name} Frequency`, freq, 20, 20000, { group: name }),
		P.db(`${prefix}Gain`, `${name} Gain`, 0, -30, 30, { group: name }),
		P.q(`${prefix}Q`, `${name} Q`, q, 0.1, 30, { group: name }),
	];
}

const EQ8_DEFAULTS: readonly [boolean, string, number, number][] = [
	[false, 'highPass', 30, 0.707],
	[true, 'lowShelf', 100, 0.707],
	[true, 'peaking', 250, 1],
	[true, 'peaking', 700, 1],
	[true, 'peaking', 2000, 1],
	[true, 'peaking', 5000, 1],
	[true, 'highShelf', 10000, 0.707],
	[false, 'lowPass', 18000, 0.707],
];

const NOTCH_DEFAULT_FREQS = [60, 120, 180, 240, 300, 360];

const FFT_DEFAULT_FREQS = [40, 100, 250, 600, 1500, 4000, 9000, 16000];

export const AUDIO_FILTER_EQ_EFFECTS: readonly EffectSpec[] = [
	band(
		'bandpass',
		'Bandpass',
		[P.hz('center', 'Center', 1000, 20, 20000), P.q('q', 'Q', 1, 0.1, 30)],
		'Keeps a band of frequencies around Center (width set by Q) and removes the rest (12 dB/oct skirts).',
		['band pass', 'filter', 'telephone', 'radio'],
	),
	band(
		'bass',
		'Bass',
		[P.db('boost', 'Boost', 0, -24, 24)],
		'Boosts or cuts the low frequencies (200 Hz and below) with a low shelf.',
		['low', 'shelf', 'tone', 'eq', 'bass boost'],
	),
	defineAudioEffect({
		id: 'jasper.audio.fft-filter',
		label: 'FFT Filter',
		category: FOLDER,
		params: [
			...FFT_DEFAULT_FREQS.flatMap((f, i) => [
				P.hz(`p${i + 1}Freq`, `Point ${i + 1} Frequency`, f, 20, 20000, { group: `Point ${i + 1}` }),
				P.db(`p${i + 1}Gain`, `Point ${i + 1} Gain`, 0, -60, 20, { group: `Point ${i + 1}` }),
			]),
			P.choice(
				'interp',
				'Interpolation',
				[
					['linear', 'Linear'],
					['smooth', 'Smooth'],
				],
				'smooth',
			),
		],
		editor: 'filter-response',
		expensive: true,
		description:
			'Draws any gain curve (8 points) and applies it with zero-phase FFT filtering: steep cuts, notches and broad shaping.',
		keywords: ['fft', 'spectral', 'curve', 'filter', 'eq', 'linear phase'],
	}),
	graphicEq(10),
	graphicEq(20),
	graphicEq(30),
	band(
		'high-shelf',
		'High Shelf',
		[
			P.hz('frequency', 'Frequency', 4000, 20, 20000),
			P.db('gain', 'Gain', 0, -24, 24),
			P.q('q', 'Q', 0.707, 0.1, 10),
		],
		'Boosts or cuts everything above the shelf frequency by the same amount.',
		['shelf', 'treble', 'high', 'tone', 'eq', 'air'],
	),
	band(
		'highpass',
		'Highpass',
		[P.hz('cutoff', 'Cutoff', 80, 20, 20000)],
		'Removes frequencies below Cutoff (12 dB/oct Butterworth): rumble, wind and handling noise.',
		['high pass', 'low cut', 'rumble', 'filter'],
	),
	band(
		'low-shelf',
		'Low Shelf',
		[
			P.hz('frequency', 'Frequency', 200, 20, 20000),
			P.db('gain', 'Gain', 0, -24, 24),
			P.q('q', 'Q', 0.707, 0.1, 10),
		],
		'Boosts or cuts everything below the shelf frequency by the same amount.',
		['shelf', 'bass', 'low', 'tone', 'eq', 'warmth'],
	),
	band(
		'lowpass',
		'Lowpass',
		[P.hz('cutoff', 'Cutoff', 8000, 20, 20000)],
		'Removes frequencies above Cutoff (12 dB/oct Butterworth): hiss and harshness, muffled effects.',
		['low pass', 'high cut', 'hiss', 'muffle', 'filter'],
	),
	defineAudioEffect({
		id: 'jasper.audio.notch-filter',
		label: 'Notch Filter',
		category: FOLDER,
		params: [
			...NOTCH_DEFAULT_FREQS.flatMap((f, i) => {
				const g = `Notch ${i + 1}`;
				return [
					P.toggle(`n${i + 1}On`, `${g} On`, false, { group: g }),
					P.hz(`n${i + 1}Freq`, `${g} Frequency`, f, 20, 20000, { group: g }),
					P.db(`n${i + 1}Gain`, `${g} Gain`, -30, -90, 0, { group: g }),
				];
			}),
			P.choice(
				'width',
				'Notch Width',
				[
					['narrow', 'Narrow'],
					['veryNarrow', 'Very Narrow'],
					['superNarrow', 'Super Narrow'],
				],
				'narrow',
			),
		],
		editor: 'filter-response',
		description: 'Removes up to six narrow frequency bands (hum and its harmonics, whistles) and leaves the rest.',
		keywords: ['notch', 'hum', 'buzz', '50 hz', '60 hz', 'whistle', 'filter'],
	}),
	defineAudioEffect({
		id: 'jasper.audio.parametric-equalizer',
		label: 'Parametric Equalizer',
		category: FOLDER,
		params: [
			P.db('masterGain', 'Master Gain', 0, -30, 30),
			P.toggle('hpOn', 'High Pass On', false, { group: 'High Pass' }),
			P.hz('hpFreq', 'High Pass Frequency', 30, 10, 20000, { group: 'High Pass' }),
			P.choice('hpSlope', 'High Pass Slope', EQ_PASS_SLOPES, '12', { group: 'High Pass' }),
			...parametricBand('low', 'Low Shelf', 100, 0.707),
			...parametricBand('b1', 'Band 1', 200, 1),
			...parametricBand('b2', 'Band 2', 500, 1),
			...parametricBand('b3', 'Band 3', 1000, 1),
			...parametricBand('b4', 'Band 4', 2000, 1),
			...parametricBand('b5', 'Band 5', 5000, 1),
			...parametricBand('high', 'High Shelf', 8000, 0.707),
			P.toggle('lpOn', 'Low Pass On', false, { group: 'Low Pass' }),
			P.hz('lpFreq', 'Low Pass Frequency', 18000, 20, 22000, { group: 'Low Pass' }),
			P.choice('lpSlope', 'Low Pass Slope', EQ_PASS_SLOPES, '12', { group: 'Low Pass' }),
		],
		editor: 'parametric-eq',
		description:
			'Master gain, high-pass and low-pass (6–48 dB/oct), low and high shelves and five peaking bands.',
		keywords: ['eq', 'equalizer', 'parametric', 'shelf', 'high pass', 'low pass', 'tone'],
	}),
	defineAudioEffect({
		id: 'jasper.audio.parametric-eq-8-band',
		label: 'Parametric EQ (8 Bands)',
		category: FOLDER,
		params: [
			...EQ8_DEFAULTS.flatMap(([on, type, freq, q], i) => {
				const g = `Band ${i + 1}`;
				return [
					P.toggle(`b${i + 1}On`, `${g} On`, on, { group: g }),
					P.choice(`b${i + 1}Type`, `${g} Type`, EQ_BAND_TYPES, type, { group: g }),
					P.hz(`b${i + 1}Freq`, `${g} Frequency`, freq, 20, 20000, { group: g }),
					P.db(`b${i + 1}Gain`, `${g} Gain`, 0, -30, 30, { group: g }),
					P.q(`b${i + 1}Q`, `${g} Q`, q, 0.1, 30, { group: g }),
				];
			}),
			P.db('output', 'Output Gain', 0, -30, 30),
		],
		editor: 'parametric-eq',
		description:
			'Eight free bands, each peaking, shelf, pass, notch or band-pass, with smooth gliding changes and output gain.',
		keywords: ['eq', 'equalizer', 'parametric', 'bands', 'shelf', 'notch', 'tone'],
	}),
	defineAudioEffect({
		id: 'jasper.audio.scientific-filter',
		label: 'Scientific Filter',
		category: FOLDER,
		params: [
			P.choice(
				'type',
				'Type',
				[
					['bessel', 'Bessel'],
					['butterworth', 'Butterworth'],
					['chebyshev', 'Chebyshev'],
					['elliptic', 'Elliptical'],
				],
				'butterworth',
			),
			P.choice(
				'mode',
				'Mode',
				[
					['lowPass', 'Low Pass'],
					['highPass', 'High Pass'],
					['bandPass', 'Band Pass'],
					['bandStop', 'Band Stop'],
				],
				'lowPass',
			),
			P.num('order', 'Order', 6, 1, 12, { step: 1 }),
			P.hz('cutoff', 'Cutoff', 1000, 20, 20000),
			P.hz('highCutoff', 'High Cutoff', 4000, 20, 20000),
			P.db('ripple', 'Passband Ripple', 1, 0.01, 6, { step: 0.01 }),
			P.db('stopAtten', 'Stopband Attenuation', 60, 20, 120),
			P.db('gain', 'Master Gain', 0, -30, 30),
		],
		editor: 'filter-response',
		description:
			'Classical IIR designs (Bessel, Butterworth, Chebyshev, Elliptical) as low-pass, high-pass, band-pass or band-stop.',
		keywords: ['filter', 'butterworth', 'chebyshev', 'elliptic', 'bessel', 'band stop', 'band pass', 'iir'],
	}),
	defineAudioEffect({
		id: 'jasper.audio.simple-3-band-eq',
		label: 'Simple 3-Band EQ',
		category: FOLDER,
		params: [
			P.db('low', 'Low', 0, -24, 24, { group: 'Low' }),
			P.hz('lowFreq', 'Low Frequency', 200, 20, 1000, { group: 'Low' }),
			P.db('mid', 'Mid', 0, -24, 24, { group: 'Mid' }),
			P.hz('midFreq', 'Mid Frequency', 1000, 100, 10000, { group: 'Mid' }),
			P.q('midQ', 'Mid Q', 0.7, 0.1, 10, { group: 'Mid' }),
			P.db('high', 'High', 0, -24, 24, { group: 'High' }),
			P.hz('highFreq', 'High Frequency', 5000, 1000, 20000, { group: 'High' }),
			P.db('output', 'Output Gain', 0, -24, 24),
		],
		editor: 'parametric-eq',
		description: 'Low shelf, mid peak and high shelf with output gain: quick tone shaping.',
		keywords: ['eq', 'equalizer', 'three band', 'bass', 'mid', 'treble', 'tone'],
	}),
	band(
		'simple-notch-filter',
		'Simple Notch Filter',
		[P.hz('center', 'Center', 60, 20, 20000), P.q('q', 'Q', 10, 0.1, 100)],
		'Removes the frequencies near Center (e.g. 50 or 60 Hz power-line hum); Q sets how narrow the notch is.',
		['notch', 'hum', 'buzz', '50 hz', '60 hz', 'filter'],
	),
	band(
		'simple-parametric-eq',
		'Simple Parametric EQ',
		[
			P.hz('center', 'Center', 1000, 20, 20000),
			P.q('q', 'Q', 1, 0.1, 30),
			P.db('boost', 'Boost', 0, -20, 20),
		],
		'Boosts or cuts the frequencies around Center by up to 20 dB; Q sets the width of the band.',
		['eq', 'peak', 'bell', 'boost', 'cut', 'tone'],
	),
	band(
		'treble',
		'Treble',
		[P.db('boost', 'Boost', 0, -24, 24)],
		'Boosts or cuts the high frequencies (4 kHz and above) with a high shelf.',
		['high', 'shelf', 'tone', 'eq', 'brightness'],
	),
];
