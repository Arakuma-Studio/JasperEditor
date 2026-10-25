// "Filter and EQ" family: ports of the filmcraft `effects/eq.rs` / `effects/filters.rs` tests and the filter parts of
// `effects/premiere_tests.rs`, plus analytic checks — every biquad effect's measured sine response against its
// `responseDb` and against the RBJ cookbook formulas (written out independently here), ISO graphic-EQ centres,
// Butterworth pass filters of every slope, Scientific Filter design properties, notch depth, FFT Filter curve
// and reported latency.
import type { ParamValue } from '@jasper/project/audio';
import { describe, expect, it } from 'vitest';
import type { AudioProcessor } from '../src/core/effect.ts';
import { createProcessor } from '../src/registry.ts';
import { db, noise, SR, sine, toneAmplitude } from './util.ts';

function fx(id: string, params: Record<string, ParamValue> = {}, channels = 2): AudioProcessor {
	const e = createProcessor(`jasper.audio.${id}`, SR, channels);
	if (!e) throw new Error(`no effect ${id}`);
	for (const [k, v] of Object.entries(params)) expect(e.setParam(k, v), `${id}.${k}`).toBe(true);
	e.reset();
	return e;
}

function resp(e: AudioProcessor, f: number): number {
	const r = e.responseDb?.(f);
	if (r === null || r === undefined) throw new Error(`${e.id}: no response`);
	return r;
}

/** Steady-state gain (dB) of a tone through the effect (second half measured; both channels must agree). */
function toneDb(e: AudioProcessor, freq: number, amp = 0.25, seconds = 1): number {
	e.reset();
	const n = SR * seconds;
	const l = sine(freq, amp, SR, n);
	const r = l.slice();
	e.process([l, r], 0, n);
	const a = toneAmplitude(l, freq, SR, n / 2, n);
	const b = toneAmplitude(r, freq, SR, n / 2, n);
	expect(Math.abs(a - b)).toBeLessThan(1e-6);
	return db(a / amp);
}

// ---- RBJ "Audio EQ Cookbook" written out from the text (independent of core/biquad.ts).

type Rbj = 'LPF' | 'HPF' | 'BPF' | 'notch' | 'peakingEQ' | 'lowShelf' | 'highShelf';

function cookbookDb(type: Rbj, f0: number, Q: number, dBgain: number, f: number, Fs = SR): number {
	const A = 10 ** (dBgain / 40);
	const w0 = (2 * Math.PI * f0) / Fs;
	const cos = Math.cos(w0);
	const alpha = Math.sin(w0) / (2 * Q);
	const sA = 2 * Math.sqrt(A) * alpha;
	let b: number[];
	let a: number[];
	switch (type) {
		case 'LPF':
			b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
			a = [1 + alpha, -2 * cos, 1 - alpha];
			break;
		case 'HPF':
			b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
			a = [1 + alpha, -2 * cos, 1 - alpha];
			break;
		case 'BPF':
			b = [alpha, 0, -alpha];
			a = [1 + alpha, -2 * cos, 1 - alpha];
			break;
		case 'notch':
			b = [1, -2 * cos, 1];
			a = [1 + alpha, -2 * cos, 1 - alpha];
			break;
		case 'peakingEQ':
			b = [1 + alpha * A, -2 * cos, 1 - alpha * A];
			a = [1 + alpha / A, -2 * cos, 1 - alpha / A];
			break;
		case 'lowShelf':
			b = [
				A * (A + 1 - (A - 1) * cos + sA),
				2 * A * (A - 1 - (A + 1) * cos),
				A * (A + 1 - (A - 1) * cos - sA),
			];
			a = [A + 1 + (A - 1) * cos + sA, -2 * (A - 1 + (A + 1) * cos), A + 1 + (A - 1) * cos - sA];
			break;
		case 'highShelf':
			b = [
				A * (A + 1 + (A - 1) * cos + sA),
				-2 * A * (A - 1 + (A + 1) * cos),
				A * (A + 1 + (A - 1) * cos - sA),
			];
			a = [A + 1 - (A - 1) * cos + sA, 2 * (A - 1 - (A + 1) * cos), A + 1 - (A - 1) * cos - sA];
			break;
	}
	const w = (2 * Math.PI * f) / Fs;
	const mag = (c: number[]) =>
		Math.hypot(
			c[0]! + c[1]! * Math.cos(w) + c[2]! * Math.cos(2 * w),
			c[1]! * Math.sin(w) + c[2]! * Math.sin(2 * w),
		);
	return 20 * Math.log10(mag(b) / mag(a));
}

/** Digital Butterworth (bilinear, pre-warped) of order n. */
function butterworthDb(low: boolean, fc: number, n: number, f: number): number {
	const t = (x: number) => Math.tan((Math.PI * x) / SR);
	const r = low ? t(f) / t(fc) : t(fc) / t(f);
	return -10 * Math.log10(1 + r ** (2 * n));
}

/** Measured, analytic (`responseDb`) and cookbook responses agree within 0.05 dB (measured only above −60 dB). */
function expectMatches(
	e: AudioProcessor,
	freqs: readonly number[],
	cookbook: (f: number) => number,
	label: string,
) {
	for (const f of freqs) {
		const analytic = resp(e, f);
		const want = cookbook(f);
		expect(
			Math.abs(analytic - want),
			`${label} ${f} Hz: analytic ${analytic} vs cookbook ${want}`,
		).toBeLessThan(0.05);
		const got = toneDb(e, f);
		if (want > -60)
			expect(Math.abs(got - want), `${label} ${f} Hz: measured ${got} vs cookbook ${want}`).toBeLessThan(
				0.05,
			);
		else expect(got, `${label} ${f} Hz`).toBeLessThan(-55);
	}
}

/** The catalogue's displayed 1/√2. */
const Q707 = Math.round(Math.SQRT1_2 * 1000) / 1000;

const FREQS = [40, 120, 400, 1000, 2500, 6000, 12000, 18000];

describe('simple biquad filters (RBJ cookbook)', () => {
	it('Highpass / Lowpass / Bandpass', () => {
		expectMatches(
			fx('highpass', { cutoff: 300 }),
			FREQS,
			(f) => cookbookDb('HPF', 300, Math.SQRT1_2, 0, f),
			'hp',
		);
		expectMatches(
			fx('lowpass', { cutoff: 3000 }),
			FREQS,
			(f) => cookbookDb('LPF', 3000, Math.SQRT1_2, 0, f),
			'lp',
		);
		expectMatches(
			fx('bandpass', { center: 1500, q: 2.5 }),
			FREQS,
			(f) => cookbookDb('BPF', 1500, 2.5, 0, f),
			'bp',
		);
		// Butterworth corners, unity peak of the band-pass.
		expect(Math.abs(resp(fx('highpass', { cutoff: 300 }), 300) + 3.0103)).toBeLessThan(0.01);
		expect(Math.abs(resp(fx('lowpass', { cutoff: 3000 }), 3000) + 3.0103)).toBeLessThan(0.01);
		expect(Math.abs(resp(fx('bandpass', { center: 1500, q: 2.5 }), 1500))).toBeLessThan(1e-9);
	});

	it('Bass / Treble shelves at 200 Hz and 4 kHz', () => {
		const bass = fx('bass', { boost: 9 });
		expectMatches(bass, FREQS, (f) => cookbookDb('lowShelf', 200, Math.SQRT1_2, 9, f), 'bass');
		expect(Math.abs(resp(bass, 20) - 9)).toBeLessThan(0.3);
		expect(Math.abs(resp(bass, 200) - 4.5)).toBeLessThan(0.05);
		const treble = fx('treble', { boost: -12 });
		expectMatches(treble, FREQS, (f) => cookbookDb('highShelf', 4000, Math.SQRT1_2, -12, f), 'treble');
		expect(Math.abs(resp(treble, 20000) + 12)).toBeLessThan(0.5);
		expect(Math.abs(resp(treble, 4000) + 6)).toBeLessThan(0.05);
	});

	it('Low Shelf / High Shelf', () => {
		expectMatches(
			fx('low-shelf', { frequency: 300, gain: 10, q: 1.2 }),
			FREQS,
			(f) => cookbookDb('lowShelf', 300, 1.2, 10, f),
			'low shelf',
		);
		expectMatches(
			fx('high-shelf', { frequency: 6000, gain: -8, q: 0.5 }),
			FREQS,
			(f) => cookbookDb('highShelf', 6000, 0.5, -8, f),
			'high shelf',
		);
	});

	it('Simple Parametric EQ and Simple Notch Filter', () => {
		const peq = fx('simple-parametric-eq', { center: 2500, q: 3, boost: 15 });
		expectMatches(peq, FREQS, (f) => cookbookDb('peakingEQ', 2500, 3, 15, f), 'speq');
		expect(Math.abs(resp(peq, 2500) - 15)).toBeLessThan(1e-9);
		const notch = fx('simple-notch-filter', { center: 1000, q: 10 });
		expectMatches(notch, [40, 400, 900, 1100, 6000], (f) => cookbookDb('notch', 1000, 10, 0, f), 'notch');
	});

	it('notches are at least 40 dB deep at their centre', () => {
		for (const center of [50, 60, 1000, 7000])
			expect(toneDb(fx('simple-notch-filter', { center, q: 10 }), center), `simple ${center}`).toBeLessThan(
				-40,
			);
		for (const width of ['narrow', 'veryNarrow', 'superNarrow']) {
			const e = fx('notch-filter', { n2On: true, n2Freq: 1000, n2Gain: -60, width });
			expect(resp(e, 1000)).toBeLessThan(-59.9);
			expect(toneDb(e, 1000), width).toBeLessThan(-40);
		}
		const eq8 = fx('parametric-eq-8-band', { b5Type: 'notch', b5Freq: 3000, b5Q: 4 });
		expect(toneDb(eq8, 3000)).toBeLessThan(-40);
	});

	it('parameter changes glide (Simple Parametric EQ) and reach the target', () => {
		const e = fx('simple-parametric-eq', { center: 1000, q: 1, boost: 0 }, 1);
		const x = sine(1000, 0.25, SR, SR);
		e.process([x], 0, SR / 4);
		e.setParam('boost', 20);
		e.process([x], SR / 4, SR);
		let maxStep = 0;
		for (let i = 1; i < SR; i++) maxStep = Math.max(maxStep, Math.abs(x[i]! - x[i - 1]!));
		// A 1 kHz sine at 0.25 moves at most 0.033 per sample; ×10 gain → 0.33 (no jump).
		expect(maxStep).toBeLessThan(0.4);
		expect(Math.abs(db(toneAmplitude(x, 1000, SR, SR / 2, SR) / 0.25) - 20)).toBeLessThan(0.05);
	});
});

describe('Parametric EQ (8 bands) and Simple 3-Band EQ (filmcraft eq.rs)', () => {
	it('default parametric is flat', () => {
		const eq = fx('parametric-eq-8-band');
		for (const f of [30, 250, 1000, 8000, 16000]) {
			expect(Math.abs(resp(eq, f))).toBeLessThan(1e-9);
			expect(Math.abs(toneDb(eq, f))).toBeLessThan(0.01);
		}
	});

	it('parametric bands match the analytic response', () => {
		const eq = fx('parametric-eq-8-band', {
			b4Gain: 9,
			b4Freq: 1000,
			b4Q: 2,
			b2Gain: -6,
			b1On: true,
			b1Freq: 40,
			b8On: true,
			b8Type: 'notch',
			b8Freq: 12000,
			b8Q: 5,
			output: 1.5,
		});
		for (const f of [30, 80, 400, 1000, 3000, 12000 * 1.2]) {
			const m = toneDb(eq, f);
			expect(Math.abs(m - resp(eq, f)), `f ${f}: measured ${m} analytic ${resp(eq, f)}`).toBeLessThan(0.05);
		}
		expect(toneDb(eq, 12000)).toBeLessThan(-30);
	});

	it('band types cover peaking, shelves, pass, notch and band-pass (cookbook)', () => {
		const types: [string, Rbj, number][] = [
			['peaking', 'peakingEQ', 7],
			['lowShelf', 'lowShelf', -9],
			['highShelf', 'highShelf', 6],
			['lowPass', 'LPF', 0],
			['highPass', 'HPF', 0],
			['notch', 'notch', 0],
			['bandPass', 'BPF', 0],
		];
		for (const [type, rbj, gain] of types) {
			const p: Record<string, ParamValue> = {};
			for (let b = 1; b <= 8; b++) p[`b${b}On`] = b === 3;
			Object.assign(p, { b3Type: type, b3Freq: 1500, b3Q: 1.4, b3Gain: gain });
			const freqs = type === 'notch' ? FREQS.filter((f) => f !== 1000) : FREQS;
			expectMatches(fx('parametric-eq-8-band', p), freqs, (f) => cookbookDb(rbj, 1500, 1.4, gain, f), type);
		}
	});

	it('simple 3-band EQ gains', () => {
		const eq = fx('simple-3-band-eq', { low: 6, high: -6, mid: 3 });
		expect(Math.abs(toneDb(eq, 30) - resp(eq, 30))).toBeLessThan(0.05);
		expect(Math.abs(resp(eq, 20) - 6)).toBeLessThan(0.3);
		expect(Math.abs(resp(eq, 20000) + 6)).toBeLessThan(0.5);
		expect(Math.abs(toneDb(eq, 1000) - resp(eq, 1000))).toBeLessThan(0.05);
		const want = (f: number) =>
			cookbookDb('lowShelf', 200, Math.SQRT1_2, 6, f) +
			cookbookDb('peakingEQ', 1000, 0.7, 3, f) +
			cookbookDb('highShelf', 5000, Math.SQRT1_2, -6, f);
		expectMatches(eq, FREQS, want, '3-band');
	});

	it('gain change glides without a jump', () => {
		const eq = fx('parametric-eq-8-band', {}, 1);
		const x = new Float32Array(4800).fill(0.5);
		eq.process([x], 0, 2400);
		eq.setParam('output', 12);
		eq.process([x], 2400, 4800);
		let maxStep = 0;
		for (let i = 1; i < x.length; i++) maxStep = Math.max(maxStep, Math.abs(x[i]! - x[i - 1]!));
		expect(maxStep).toBeLessThan(0.01);
		expect(Math.abs(x[4799]! - 0.5 * 10 ** (12 / 20))).toBeLessThan(1e-4);
	});
});

describe('Graphic Equalizer', () => {
	const ISO: Record<10 | 20 | 30, number[]> = {
		10: [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
		20: [
			31.5, 45, 63, 90, 125, 180, 250, 355, 500, 710, 1000, 1400, 2000, 2800, 4000, 5600, 8000, 11200, 16000,
			22400,
		],
		30: [
			25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
			2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
		],
	};

	it('a single band at +12 dB peaks at its centre (every band of every size)', () => {
		for (const n of [10, 20, 30] as const)
			ISO[n].forEach((fc, i) => {
				const e = fx(`graphic-equalizer-${n}`, { [`b${i + 1}`]: 12 });
				expect(Math.abs(resp(e, fc) - 12), `${n}/${fc}`).toBeLessThan(1e-9);
				for (const r of [0.97, 0.99, 1.01, 1.03]) expect(resp(e, fc * r)).toBeLessThan(12);
			});
	});

	it('bands hit their gain, measured (premiere_tests)', () => {
		for (const [n, band] of [
			[10, 'b6'],
			[20, 'b11'],
			[30, 'b17'],
		] as const) {
			const e = fx(`graphic-equalizer-${n}`, { [band]: 12 });
			const want = resp(e, 1000);
			expect(Math.abs(want - 12)).toBeLessThan(1);
			expect(Math.abs(toneDb(e, 1000, 0.1) - want)).toBeLessThan(0.05);
			expect(resp(e, 4000)).toBeLessThan(1);
			const flat = fx(`graphic-equalizer-${n}`, { gain: -6 });
			expect(Math.abs(toneDb(flat, 300, 0.1) + 6)).toBeLessThan(0.05);
		}
		// Several bands: measured = Σ cookbook peaking responses.
		const e = fx('graphic-equalizer-30', { b10: 6, b17: -9, b24: 4 });
		const octaveWidth = 1 / 3;
		const q = Math.sqrt(2 ** octaveWidth) / (2 ** octaveWidth - 1);
		expectMatches(
			e,
			[100, 200, 700, 1000, 3000, 5000],
			(f) =>
				cookbookDb('peakingEQ', 200, q, 6, f) +
				cookbookDb('peakingEQ', 1000, q, -9, f) +
				cookbookDb('peakingEQ', 5000, q, 4, f),
			'geq30',
		);
	});
});

describe('Parametric Equalizer', () => {
	it('24 dB/oct high-pass: −3 dB at the corner, ≈ −48 dB two octaves down (premiere_tests)', () => {
		const hp = fx('parametric-equalizer', { hpOn: true, hpFreq: 200, hpSlope: '24' });
		expect(Math.abs(resp(hp, 200) + 3.01)).toBeLessThan(0.05);
		expect(resp(hp, 50)).toBeLessThan(-45);
		const e = fx('parametric-equalizer', {
			hpOn: true,
			hpFreq: 200,
			hpSlope: '24',
			b3Gain: 9,
			masterGain: -3,
		});
		expect(Math.abs(resp(e, 1000) - 6)).toBeLessThan(0.05);
		for (const f of [50, 200, 1000, 5000]) {
			const want = resp(e, f);
			expect(Math.abs(toneDb(e, f, 0.1) - want), `${f} Hz`).toBeLessThan(0.05);
		}
	});

	it('pass filters of every slope are digital Butterworths (6·N dB/oct)', () => {
		for (let n = 1; n <= 8; n++) {
			const slope = String(6 * n);
			const hp = fx('parametric-equalizer', { hpOn: true, hpFreq: 150, hpSlope: slope });
			const lp = fx('parametric-equalizer', { lpOn: true, lpFreq: 5000, lpSlope: slope });
			for (const f of [20, 75, 150, 300, 1000, 5000, 10000, 20000]) {
				expect(Math.abs(resp(hp, f) - butterworthDb(false, 150, n, f)), `hp n=${n} ${f}`).toBeLessThan(1e-6);
				expect(Math.abs(resp(lp, f) - butterworthDb(true, 5000, n, f)), `lp n=${n} ${f}`).toBeLessThan(1e-6);
			}
			expect(Math.abs(resp(hp, 150) + 3.0103)).toBeLessThan(1e-3);
			for (const f of [76, 150, 600]) {
				const want = butterworthDb(false, 150, n, f);
				if (want > -60) expect(Math.abs(toneDb(hp, f) - want), `hp n=${n} ${f}`).toBeLessThan(0.05);
			}
			for (const f of [2500, 5000, 9000]) {
				const want = butterworthDb(true, 5000, n, f);
				if (want > -60) expect(Math.abs(toneDb(lp, f) - want), `lp n=${n} ${f}`).toBeLessThan(0.05);
			}
		}
	});

	it('shelves and peaking bands follow the cookbook; bands switch off', () => {
		const e = fx('parametric-equalizer', {
			lowGain: 5,
			lowFreq: 120,
			b2Gain: -7,
			b2Freq: 700,
			b2Q: 3,
			highGain: 4,
			highFreq: 9000,
			highQ: 1,
			masterGain: 2,
		});
		expectMatches(
			e,
			FREQS,
			(f) =>
				cookbookDb('lowShelf', 120, Q707, 5, f) +
				cookbookDb('peakingEQ', 700, 3, -7, f) +
				cookbookDb('highShelf', 9000, 1, 4, f) +
				2,
			'peq',
		);
		e.setParam('b2On', false);
		expect(
			Math.abs(
				resp(e, 700) -
					(cookbookDb('lowShelf', 120, Q707, 5, 700) + cookbookDb('highShelf', 9000, 1, 4, 700) + 2),
			),
		).toBeLessThan(1e-9);
	});
});

describe('Notch Filter (premiere_tests)', () => {
	it('removes tones and leaves the neighbours', () => {
		const e = fx('notch-filter', { n1On: true, n1Freq: 1000, n1Gain: -60, width: 'superNarrow' });
		expect(toneDb(e, 1000, 0.3)).toBeLessThan(-50);
		expect(Math.abs(toneDb(e, 1200, 0.3))).toBeLessThan(0.5);
	});

	it('is a neutral pass-through by default and matches its analytic response', () => {
		const e = fx('notch-filter');
		const x = noise(1, 24000, 0.25);
		const y = x.slice();
		e.process([y, y.slice()], 0, y.length);
		expect(y.every((v, i) => Object.is(v, x[i]))).toBe(true);
		const h = fx('notch-filter', {
			n1On: true,
			n1Freq: 60,
			n3On: true,
			n3Freq: 180,
			n3Gain: -20,
			width: 'veryNarrow',
		});
		for (const f of [50, 60, 120, 180, 1000]) {
			const want = resp(h, f);
			// Narrow low notches ring for ~0.1 s: measure a long tone.
			const got = toneDb(h, f, 0.25, 4);
			if (want > -60) expect(Math.abs(got - want), `${f}`).toBeLessThan(0.05);
		}
		expect(Math.abs(resp(h, 60) + 30)).toBeLessThan(0.01);
		expect(Math.abs(resp(h, 180) + 20)).toBeLessThan(0.01);
	});
});

describe('Scientific Filter', () => {
	it('matches its design, measured (premiere_tests)', () => {
		for (const [type, mode] of [
			['elliptic', 'lowPass'],
			['butterworth', 'highPass'],
			['chebyshev', 'bandPass'],
			['bessel', 'bandStop'],
		] as const) {
			const e = fx('scientific-filter', { type, mode, order: 4, cutoff: 800, highCutoff: 3000 });
			for (const f of [200, 1000, 1500, 6000]) {
				const want = resp(e, f);
				const got = toneDb(e, f, 0.1);
				if (want > -60) expect(Math.abs(got - want), `${type} ${mode} ${f} Hz`).toBeLessThan(0.05);
				else expect(got).toBeLessThan(-55);
			}
		}
	});

	it('Butterworth: −3.01 dB at the cutoff and a 6·N dB/oct asymptote', () => {
		for (const order of [1, 2, 3, 6, 9, 12]) {
			const e = fx('scientific-filter', { type: 'butterworth', mode: 'lowPass', order, cutoff: 1000 });
			expect(Math.abs(resp(e, 1000) + 3.0103)).toBeLessThan(1e-3);
			expect(Math.abs(toneDb(e, 1000) + 3.0103)).toBeLessThan(0.05);
			const lo = fx('scientific-filter', { type: 'butterworth', mode: 'lowPass', order, cutoff: 20 });
			const slope = resp(lo, 400) - resp(lo, 800);
			expect(Math.abs(slope - 6.0206 * order), `order ${order}: ${slope}`).toBeLessThan(0.02 * order);
		}
	});

	it('Chebyshev pass-band ripple equals the parameter; elliptic stop band ≥ the attenuation', () => {
		for (const ripple of [0.25, 1, 3]) {
			const e = fx('scientific-filter', { type: 'chebyshev', order: 5, cutoff: 2000, ripple });
			let min = Number.POSITIVE_INFINITY;
			let max = Number.NEGATIVE_INFINITY;
			for (let f = 2; f <= 2000; f += 2) {
				const m = resp(e, f);
				min = Math.min(min, m);
				max = Math.max(max, m);
			}
			expect(Math.abs(max - min - ripple), `ripple ${ripple}`).toBeLessThan(0.01 * ripple);
		}
		for (const stopAtten of [30, 60, 90]) {
			const e = fx('scientific-filter', { type: 'elliptic', order: 6, cutoff: 1000, ripple: 0.5, stopAtten });
			let below = false;
			for (let f = 1000; f < 23900; f += 5) {
				const m = resp(e, f);
				if (m < -stopAtten) below = true;
				if (below) expect(m, `atten ${stopAtten} at ${f}`).toBeLessThan(-stopAtten + 0.05);
			}
			expect(below).toBe(true);
		}
	});

	it('master gain and cutoff glides reach the target design', () => {
		const e = fx('scientific-filter', { cutoff: 500, gain: -6 });
		expect(Math.abs(resp(e, 50) + 6)).toBeLessThan(0.01);
		const x = sine(400, 0.25, SR, SR * 2);
		e.process([x], 0, SR / 2);
		e.setParam('cutoff', 4000);
		e.process([x], SR / 2, 2 * SR);
		expect(Math.abs(db(toneAmplitude(x, 400, SR, SR, 2 * SR) / 0.25) - resp(e, 400))).toBeLessThan(0.05);
	});
});

describe('FFT Filter', () => {
	it('applies its curve (premiere_tests)', () => {
		const e = fx('fft-filter', { p5Gain: -30, interp: 'linear' });
		expect(Math.abs(resp(e, 1500) + 30)).toBeLessThan(1e-9);
		expect(Math.abs(toneDb(e, 1500, 0.3) + 30)).toBeLessThan(1.5);
		expect(Math.abs(toneDb(e, 100, 0.3))).toBeLessThan(0.3);
	});

	it('magnitude follows a smooth curve at many frequencies', () => {
		const e = fx('fft-filter', {
			p1Gain: 6,
			p2Gain: 3,
			p3Gain: -3,
			p4Gain: -12,
			p5Gain: -6,
			p6Gain: 0,
			p7Gain: 9,
			p8Gain: -20,
			interp: 'smooth',
		});
		expect(Math.abs(resp(e, 20) - 6)).toBeLessThan(1e-9);
		expect(Math.abs(resp(e, 20000) + 20)).toBeLessThan(1e-9);
		expect(Math.abs(resp(e, Math.sqrt(600 * 1500)) - -9)).toBeLessThan(1e-9);
		for (const f of [60, 150, 400, 600, 1000, 2500, 6000, 9000, 12000]) {
			const want = resp(e, f);
			const got = toneDb(e, f);
			expect(Math.abs(got - want), `${f} Hz: ${got} vs ${want}`).toBeLessThan(0.3);
		}
	});

	it('latency() equals the measured impulse delay', () => {
		const e = fx('fft-filter');
		const lat = e.latency();
		const n = lat + 4000;
		const l = new Float32Array(n);
		l[100] = 0.5;
		const r = l.slice();
		e.process([l, r], 0, n);
		let peak = 0;
		for (let i = 0; i < n; i++) if (Math.abs(l[i]!) > Math.abs(l[peak]!)) peak = i;
		expect(peak).toBe(100 + lat);
		expect(Math.abs(l[peak]! - 0.5)).toBeLessThan(1e-3);
		const x = noise(2, 20000, 0.25);
		const y = x.slice();
		fx('fft-filter').process([y], 0, y.length);
		let worst = 0;
		for (let i = lat; i < x.length; i++) worst = Math.max(worst, Math.abs(y[i]! - x[i - lat]!));
		expect(worst).toBeLessThan(2e-4);
		expect(fx('fft-filter', { p3Gain: -40, interp: 'linear' }).latency()).toBe(lat);
	});
});
