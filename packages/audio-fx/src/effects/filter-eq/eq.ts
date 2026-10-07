// Biquad-bank equalisers and filters (ports of filmcraft `effects/eq.rs` ParametricEq / SimpleEq and
// `effects/filters.rs` GraphicEq / FullParametricEq / NotchFilter, plus Premiere's simple filters — Highpass, Lowpass,
// Bandpass, Bass, Treble, Simple Notch Filter, Simple Parametric EQ — and Low/High Shelf, all smoothed RBJ biquads).
import { FILTER_TYPES } from '../../core/biquad.ts';
import { EffectBase, type ParamValues, type ProcessorFactory } from '../../core/effect.ts';
import { dbToGain } from '../../core/math.ts';
import { Smoothed } from '../../core/smooth.ts';
import { BandBank, type BandKind, butterworthQ, qForOctaves, SMOOTH_MS } from './bank.ts';

/** How an effect maps its parameters onto a band bank. */
type BankLayout = {
	bands: number;
	/** dB parameter applied as output gain (null = none). */
	output: string | null;
	configure(pv: ParamValues, bank: BandBank, snap: boolean): void;
};

/** An effect that is a bank of smoothed biquads (+ smoothed output gain). */
class BankEffect extends EffectBase {
	private readonly bank: BandBank;
	private readonly out: Smoothed;

	constructor(
		id: string,
		sampleRate: number,
		channels: number,
		private readonly layout: BankLayout,
	) {
		super(id, sampleRate, channels);
		this.bank = new BandBank(sampleRate, channels, layout.bands);
		this.out = layout.output ? Smoothed.withMs(1, sampleRate, SMOOTH_MS) : new Smoothed(1, 0);
		this.applyParams(true);
	}

	private outputDb(): number {
		return this.layout.output ? this.pv.v(this.layout.output) : 0;
	}

	protected applyParams(snap: boolean): void {
		this.layout.configure(this.pv, this.bank, snap);
		this.out.set(dbToGain(this.outputDb()));
		if (snap) {
			this.out.snap();
			this.bank.updateCoeffs(true);
		}
	}

	/** Analytic magnitude (dB) at the target settings, output gain included (drives the EQ curve). */
	responseDb(freq: number): number {
		return this.bank.responseDb(freq) + this.outputDb();
	}

	reset(): void {
		this.out.snap();
		this.bank.reset();
	}

	process(channels: readonly Float32Array[], start: number, end: number): void {
		this.bank.process(channels, start, end, this.out);
	}
}

function bankFactory(id: string, layout: BankLayout): [string, ProcessorFactory] {
	return [id, (sr, ch) => new BankEffect(id, sr, ch, layout)];
}

// ------------------------------------------------------------------------------------------- 8-band / 3-band

const EQ8_NAMES = Array.from({ length: 8 }, (_, i) => {
	const p = `b${i + 1}`;
	return { on: `${p}On`, type: `${p}Type`, freq: `${p}Freq`, gain: `${p}Gain`, q: `${p}Q` };
});

const PARAMETRIC_EQ_8: BankLayout = {
	bands: 8,
	output: 'output',
	configure(pv, bank, snap) {
		for (let i = 0; i < 8; i++) {
			const n = EQ8_NAMES[i]!;
			const kind = FILTER_TYPES[Math.min(pv.idx(n.type), FILTER_TYPES.length - 1)]!;
			bank.setBand(i, pv.on(n.on), kind, pv.v(n.freq), pv.v(n.gain), pv.v(n.q), snap);
		}
	},
};

const SIMPLE_3_BAND: BankLayout = {
	bands: 3,
	output: 'output',
	configure(pv, bank, snap) {
		bank.setBand(0, true, 'lowShelf', pv.v('lowFreq'), pv.v('low'), Math.SQRT1_2, snap);
		bank.setBand(1, true, 'peaking', pv.v('midFreq'), pv.v('mid'), pv.v('midQ'), snap);
		bank.setBand(2, true, 'highShelf', pv.v('highFreq'), pv.v('high'), Math.SQRT1_2, snap);
	},
};

// -------------------------------------------------------------------------------------------- graphic EQs

/** ISO 266 nominal centre frequencies: octave, half-octave and third-octave bands. */
export const GRAPHIC_EQ_FREQS: Readonly<Record<10 | 20 | 30, readonly number[]>> = {
	10: [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
	20: [
		31.5, 45, 63, 90, 125, 180, 250, 355, 500, 710, 1000, 1400, 2000, 2800, 4000, 5600, 8000, 11200, 16000,
		22400,
	],
	30: [
		25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500,
		3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
	],
};

/** Band Q of the graphic equalisers (octave, half-octave, third-octave bandwidth). */
export function graphicEqQ(bands: 10 | 20 | 30): number {
	return qForOctaves(bands === 10 ? 1 : bands === 20 ? 0.5 : 1 / 3);
}

function graphicEq(bands: 10 | 20 | 30): BankLayout {
	const freqs = GRAPHIC_EQ_FREQS[bands];
	const names = freqs.map((_, i) => `b${i + 1}`);
	const q = graphicEqQ(bands);
	return {
		bands,
		output: 'gain',
		configure(pv, bank, snap) {
			for (let i = 0; i < bands; i++) bank.setBand(i, true, 'peaking', freqs[i]!, pv.v(names[i]!), q, snap);
		},
	};
}

// --------------------------------------------------------------------------------------- parametric equalizer

/** The bands between the pass filters, in signal order: parameter prefix and filter type. */
const PEQ_BANDS: readonly (readonly [string, BandKind])[] = [
	['low', 'lowShelf'],
	['b1', 'peaking'],
	['b2', 'peaking'],
	['b3', 'peaking'],
	['b4', 'peaking'],
	['b5', 'peaking'],
	['high', 'highShelf'],
];
const PEQ_NAMES = PEQ_BANDS.map(([p, kind]) => ({
	on: `${p}On`,
	freq: `${p}Freq`,
	gain: `${p}Gain`,
	q: `${p}Q`,
	kind,
}));
/** Pass-filter slots per side (a Butterworth of order ≤ 8 = at most 4 sections). */
const PASS_SLOTS = 4;

/**
 * One side's pass filter as Butterworth sections in `slots` [first, first + PASS_SLOTS): order `n` = a first-order
 * section when odd, then ⌊n/2⌋ biquads with the Butterworth Qs.
 */
function passFilter(
	bank: BandBank,
	first: number,
	on: boolean,
	low: boolean,
	freq: number,
	order: number,
	snap: boolean,
): void {
	const odd = order % 2 === 1;
	const pairs = Math.floor(order / 2);
	for (let s = 0; s < PASS_SLOTS; s++) {
		let kind: BandKind = low ? 'lowPass' : 'highPass';
		let q = Math.SQRT1_2;
		let used = false;
		if (odd && s === 0) {
			kind = low ? 'lowPass1' : 'highPass1';
			used = true;
		} else {
			const k = odd ? s - 1 : s;
			if (k < pairs) {
				q = butterworthQ(order, k);
				used = true;
			}
		}
		bank.setBand(first + s, on && used, kind, freq, 0, q, snap);
	}
}

const PARAMETRIC_EQUALIZER: BankLayout = {
	bands: PASS_SLOTS + PEQ_BANDS.length + PASS_SLOTS,
	output: 'masterGain',
	configure(pv, bank, snap) {
		passFilter(bank, 0, pv.on('hpOn'), false, pv.v('hpFreq'), pv.idx('hpSlope') + 1, snap);
		for (let i = 0; i < PEQ_NAMES.length; i++) {
			const n = PEQ_NAMES[i]!;
			bank.setBand(PASS_SLOTS + i, pv.on(n.on), n.kind, pv.v(n.freq), pv.v(n.gain), pv.v(n.q), snap);
		}
		passFilter(
			bank,
			PASS_SLOTS + PEQ_BANDS.length,
			pv.on('lpOn'),
			true,
			pv.v('lpFreq'),
			pv.idx('lpSlope') + 1,
			snap,
		);
	},
};

// ---------------------------------------------------------------------------------------------- notch filter

/** Q of the Notch Filter widths (Narrow, Very Narrow, Super Narrow). */
export const NOTCH_Q = [8, 20, 50] as const;
const NOTCH_NAMES = Array.from({ length: 6 }, (_, i) => ({
	on: `n${i + 1}On`,
	freq: `n${i + 1}Freq`,
	gain: `n${i + 1}Gain`,
}));

/** Up to six narrow cuts (constant-bandwidth `cut` biquads) of selectable width. */
const NOTCH_FILTER: BankLayout = {
	bands: 6,
	output: null,
	configure(pv, bank, snap) {
		const q = NOTCH_Q[Math.min(pv.idx('width'), 2)]!;
		for (let i = 0; i < 6; i++) {
			const n = NOTCH_NAMES[i]!;
			bank.setBand(i, pv.on(n.on), 'cut', pv.v(n.freq), pv.v(n.gain), q, snap);
		}
	},
};

// ------------------------------------------------------------------------------------------- simple filters

/** One always-on band; `[freq, q, gain]` from the parameters. */
function single(kind: BandKind, read: (pv: ParamValues) => readonly [number, number, number]): BankLayout {
	return {
		bands: 1,
		output: null,
		configure(pv, bank, snap) {
			const [f, q, g] = read(pv);
			bank.setBand(0, true, kind, f, g, q, snap);
		},
	};
}

/** Corner of the Bass effect's low shelf ("200 Hz and below"). */
export const BASS_FREQ = 200;
/** Corner of the Treble effect's high shelf ("4000 Hz and above"). */
export const TREBLE_FREQ = 4000;

export const EQ_PROCESSORS: Readonly<Record<string, ProcessorFactory>> = Object.fromEntries([
	bankFactory('jasper.audio.parametric-eq-8-band', PARAMETRIC_EQ_8),
	bankFactory('jasper.audio.simple-3-band-eq', SIMPLE_3_BAND),
	bankFactory('jasper.audio.graphic-equalizer-10', graphicEq(10)),
	bankFactory('jasper.audio.graphic-equalizer-20', graphicEq(20)),
	bankFactory('jasper.audio.graphic-equalizer-30', graphicEq(30)),
	bankFactory('jasper.audio.parametric-equalizer', PARAMETRIC_EQUALIZER),
	bankFactory('jasper.audio.notch-filter', NOTCH_FILTER),
	bankFactory(
		'jasper.audio.highpass',
		single('highPass', (pv) => [pv.v('cutoff'), Math.SQRT1_2, 0]),
	),
	bankFactory(
		'jasper.audio.lowpass',
		single('lowPass', (pv) => [pv.v('cutoff'), Math.SQRT1_2, 0]),
	),
	bankFactory(
		'jasper.audio.bandpass',
		single('bandPass', (pv) => [pv.v('center'), pv.v('q'), 0]),
	),
	bankFactory(
		'jasper.audio.bass',
		single('lowShelf', (pv) => [BASS_FREQ, Math.SQRT1_2, pv.v('boost')]),
	),
	bankFactory(
		'jasper.audio.treble',
		single('highShelf', (pv) => [TREBLE_FREQ, Math.SQRT1_2, pv.v('boost')]),
	),
	bankFactory(
		'jasper.audio.simple-notch-filter',
		single('notch', (pv) => [pv.v('center'), pv.v('q'), 0]),
	),
	bankFactory(
		'jasper.audio.simple-parametric-eq',
		single('peaking', (pv) => [pv.v('center'), pv.v('q'), pv.v('boost')]),
	),
	bankFactory(
		'jasper.audio.low-shelf',
		single('lowShelf', (pv) => [pv.v('frequency'), pv.v('q'), pv.v('gain')]),
	),
	bankFactory(
		'jasper.audio.high-shelf',
		single('highShelf', (pv) => [pv.v('frequency'), pv.v('q'), pv.v('gain')]),
	),
]);
