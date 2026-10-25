// Known-answer, robustness and property tests of `analyzeSound` (spec 12 P1-R2).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Fft } from '../src/core/fft.ts';
import { Prng } from '../src/core/util.ts';
import {
	analyzeSound,
	DESCRIPTOR_CEILING_DB,
	DESCRIPTOR_FLOOR_DB,
	OCTAVE_BAND_CENTRES_HZ,
	SoundAnalysisError,
	type SoundDescriptors,
} from '../src/index.ts';
import { noise, SR, sine } from './util.ts';

const midiOf = (f: number): number => 69 + 12 * Math.log2(f / 440);

/** Noise with an exact power-law spectrum: random-phase bins with power ∝ f^slope between lo and hi (Hz). */
function shapedNoise(
	seed: number,
	n: number,
	sr: number,
	lo: number,
	hi: number,
	slope: number,
): Float32Array {
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	const r = new Prng(seed);
	for (let k = 1; k < n / 2; k++) {
		const f = (k * sr) / n;
		if (f < lo || f > hi) continue;
		const a = Math.sqrt(f ** slope);
		const ph = r.unit() * 2 * Math.PI;
		re[k] = a * Math.cos(ph);
		im[k] = a * Math.sin(ph);
		re[n - k] = re[k]!;
		im[n - k] = -im[k]!;
	}
	new Fft(n).inverse(re, im);
	let peak = 0;
	for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(re[i]!));
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = (0.5 * re[i]!) / peak;
	return out;
}

/** Every number of the result is finite and on its quantisation grid. */
function expectWellFormed(d: SoundDescriptors): void {
	const grid = (v: number, scale: number, what: string) => {
		expect(Number.isFinite(v), `${what} finite`).toBe(true);
		expect(Math.abs(v * scale - Math.round(v * scale)), `${what} = ${v} on the 1/${scale} grid`).toBeLessThan(
			1e-6,
		);
	};
	for (const k of ['durationSec', 'peakSec', 'onsetSec', 'tailSec', 'headQuietSec'] as const)
		grid(d[k], 10_000, k);
	for (const k of ['riseMs', 'decayMs'] as const) grid(d[k], 10, k);
	for (const k of ['centroidHz', 'rolloff85Hz'] as const) grid(d[k], 1, k);
	for (const k of ['below150Share', 'above6kShare', 'flatness', 'pitchConfidence', 'stereoWidth'] as const) {
		grid(d[k], 1000, k);
		expect(d[k]).toBeGreaterThanOrEqual(0);
		expect(d[k]).toBeLessThanOrEqual(1);
	}
	expect(d.octaveBandsDb).toHaveLength(7);
	for (const v of d.octaveBandsDb) {
		grid(v, 100, 'octave band');
		expect(v).toBeGreaterThanOrEqual(DESCRIPTOR_FLOOR_DB);
	}
	for (const k of ['integratedLufs', 'maxMomentaryLufs', 'truePeakDb'] as const)
		if (d[k] !== null) grid(d[k]!, 100, k);
	if (d.pitchMidi !== null) grid(d.pitchMidi, 100, 'pitchMidi');
	expect(Number.isInteger(d.onsetCount) && d.onsetCount >= 0).toBe(true);
	expect(typeof d.decays).toBe('boolean');
	expect(typeof d.loopable).toBe('boolean');
	expect(d.onsetSec).toBeLessThanOrEqual(d.peakSec);
	expect(d.peakSec).toBeLessThanOrEqual(d.durationSec);
	expect(d.headQuietSec).toBeLessThanOrEqual(d.durationSec);
	expect(d.riseMs).toBeGreaterThanOrEqual(0);
	expect(d.decayMs).toBeGreaterThanOrEqual(0);
	expect(d.tailSec).toBeGreaterThanOrEqual(0);
	for (const k of Object.keys(d))
		expect(Object.is((d as unknown as Record<string, unknown>)[k], -0)).toBe(false);
}

describe('analyzeSound: known answers', () => {
	it('publishes the descriptor octave-band centres', () => {
		expect(OCTAVE_BAND_CENTRES_HZ).toEqual([125, 250, 500, 1000, 2000, 4000, 8000]);
	});

	it('an impulse at t gives peakSec within 1 ms (and onsetSec just before it)', () => {
		for (const t of [0, 0.0001, 0.0137, 0.25, 0.3, 0.77777, 0.999]) {
			const x = new Float32Array(SR);
			x[Math.round(t * SR)] = 0.8;
			const d = analyzeSound([x], SR);
			expect(Math.abs(d.peakSec - t), `impulse at ${t}: peak ${d.peakSec}`).toBeLessThanOrEqual(0.001);
			expect(d.onsetSec).toBeLessThanOrEqual(d.peakSec);
			expect(d.peakSec - d.onsetSec).toBeLessThanOrEqual(0.0015);
			expect(d.onsetCount).toBe(1);
			expect(d.riseMs).toBeLessThanOrEqual(1);
			expect(d.decays).toBe(true);
			// flat spectrum: centroid ≈ sr/4, flatness ≈ 1
			expect(Math.abs(d.centroidHz - SR / 4)).toBeLessThan(SR * 0.01);
			expect(d.flatness).toBeGreaterThan(0.95);
			expectWellFormed(d);
		}
	});

	it('an impulse at 44.1 and 96 kHz also lands within 1 ms', () => {
		for (const sr of [44_100, 96_000, 22_050]) {
			const x = new Float32Array(sr);
			const t = 0.4321;
			x[Math.round(t * sr)] = -0.5;
			expect(Math.abs(analyzeSound([x], sr).peakSec - t)).toBeLessThanOrEqual(0.001);
		}
	});

	it('an exponential decay gives decayMs = τ·ln(100)/2 (−20 dB) and its −60 dB tail', () => {
		for (const tau of [0.05, 0.1, 0.25]) {
			const n = Math.round(SR * tau * 9);
			const r = new Prng(7);
			const x = new Float32Array(n);
			for (let i = 0; i < n; i++)
				x[i] = 0.7 * Math.exp(-i / SR / tau) * Math.sin((2 * Math.PI * 1000 * i) / SR);
			const xn = new Float32Array(n);
			for (let i = 0; i < n; i++) xn[i] = 0.7 * Math.exp(-i / SR / tau) * r.uniform();
			const want = tau * Math.log(10) * 1000; // amplitude falls 20 dB after τ·ln 10
			for (const [what, sig] of [
				['sine', x],
				['noise', xn],
			] as const) {
				const d = analyzeSound([sig], SR);
				expect(d.decays, `${what} τ=${tau}`).toBe(true);
				// the 2 ms RMS window widens it slightly; with noise the peak is the loudest 2 ms fluctuation (≈ +2 dB over
				// the trend) and a dip can cross −20 dB early, so noise is within ±20 %
				expect(Math.abs(d.decayMs - want), `${what} τ=${tau}: decay ${d.decayMs} vs ${want}`).toBeLessThan(
					what === 'sine' ? Math.max(3, want * 0.03) : want * 0.2,
				);
				const tail = tau * Math.log(1000);
				expect(Math.abs(d.tailSec - tail), `${what} τ=${tau}: tail ${d.tailSec} vs ${tail}`).toBeLessThan(
					what === 'sine' ? Math.max(0.005, tail * 0.03) : tail * 0.1,
				);
			}
		}
	});

	it('a sine gives its frequency as centroid, rolloff and MIDI pitch', () => {
		for (const f of [110, 220, 440, 1000, 2637]) {
			const x = sine(f, 0.5, SR, SR);
			const d = analyzeSound([x, x.slice()], SR);
			expect(Math.abs(d.centroidHz - f), `centroid of ${f} Hz: ${d.centroidHz}`).toBeLessThan(f * 0.02 + 2);
			expect(Math.abs(d.rolloff85Hz - f), `rolloff of ${f} Hz: ${d.rolloff85Hz}`).toBeLessThan(f * 0.02 + 24);
			expect(d.pitchMidi, `pitch of ${f} Hz`).not.toBeNull();
			expect(Math.abs(d.pitchMidi! - midiOf(f)), `MIDI of ${f} Hz: ${d.pitchMidi}`).toBeLessThan(0.05);
			expect(d.pitchConfidence).toBeGreaterThan(0.9);
			expect(d.flatness).toBeLessThan(0.01);
			expect(d.stereoWidth).toBe(0);
			expect(d.onsetCount).toBe(1);
		}
		expect(analyzeSound([sine(440, 0.5, SR, SR)], SR).pitchMidi).toBe(69);
	});

	it('a sine sits in its own octave band at its mean-square level', () => {
		const d = analyzeSound([sine(1000, 1, SR, SR * 2)], SR);
		const i = OCTAVE_BAND_CENTRES_HZ.indexOf(1000);
		// full-scale sine: mean square 0.5 = −3.01 dB
		expect(Math.abs(d.octaveBandsDb[i]! - -3.01)).toBeLessThan(0.3);
		for (const [k, v] of d.octaveBandsDb.entries()) if (k !== i) expect(v).toBeLessThan(-30);
	});

	it('white noise has flatness ≈ 1 and the shares of a flat spectrum', () => {
		const x = noise(3, SR * 3, 0.5);
		const d = analyzeSound([x], SR);
		expect(d.flatness).toBeGreaterThan(0.95);
		expect(Math.abs(d.centroidHz - 12_000)).toBeLessThan(300);
		expect(Math.abs(d.rolloff85Hz - 20_400)).toBeLessThan(300);
		expect(Math.abs(d.above6kShare - 0.75)).toBeLessThan(0.02);
		expect(Math.abs(d.below150Share - 150 / 24_000)).toBeLessThan(0.003);
		// octave bands of white noise rise 3 dB per octave (10 s, so the 4-bin 125 Hz band averages enough frames)
		const long = analyzeSound([noise(5, SR * 10, 0.5)], SR);
		for (let k = 1; k < 7; k++)
			expect(
				Math.abs(long.octaveBandsDb[k]! - long.octaveBandsDb[k - 1]! - 3.01),
				`${long.octaveBandsDb}`,
			).toBeLessThan(0.3);
		expect(d.pitchMidi).toBeNull();
		expect(d.pitchConfidence).toBeLessThan(0.5);
		expect(d.onsetCount).toBe(1);
		expect(d.riseMs).toBeLessThan(5);
	});

	it('pink noise (power ∝ 1/f, 20 Hz … 20 kHz) gives the analytic band shares and equal octave bands', () => {
		const x = shapedNoise(11, 1 << 18, SR, 20, 20_000, -1);
		const d = analyzeSound([x], SR);
		const span = Math.log(20_000 / 20);
		expect(Math.abs(d.below150Share - Math.log(150 / 20) / span), `below150 ${d.below150Share}`).toBeLessThan(
			0.015,
		);
		expect(
			Math.abs(d.above6kShare - Math.log(20_000 / 6000) / span),
			`above6k ${d.above6kShare}`,
		).toBeLessThan(0.015);
		const mean = d.octaveBandsDb.reduce((s, v) => s + v, 0) / 7;
		for (const v of d.octaveBandsDb) expect(Math.abs(v - mean), `bands ${d.octaveBandsDb}`).toBeLessThan(0.5);
		// a falling spectrum is less flat than white noise, more than a tone
		expect(d.flatness).toBeGreaterThan(0.05);
		expect(d.flatness).toBeLessThan(0.8);
		expect(d.centroidHz).toBeLessThan(6000);
		expect(d.pitchMidi).toBeNull();
	});

	it('brown noise (power ∝ 1/f²) is mostly low', () => {
		const d = analyzeSound([shapedNoise(12, 1 << 17, SR, 20, 20_000, -2)], SR);
		// ∫ f⁻² from 20 to 150 over 20 to 20000 = (1/20 − 1/150) / (1/20 − 1/20000)
		expect(Math.abs(d.below150Share - (1 / 20 - 1 / 150) / (1 / 20 - 1 / 20_000))).toBeLessThan(0.02);
	});

	it('rise time: a 100 ms linear amplitude ramp rises 10 → 90 % in 80 ms', () => {
		const n = SR;
		const x = new Float32Array(n);
		for (let i = 0; i < n; i++)
			x[i] = Math.min(1, i / (0.1 * SR)) * 0.5 * Math.sin((2 * Math.PI * 500 * i) / SR);
		const d = analyzeSound([x], SR);
		expect(Math.abs(d.riseMs - 80), `rise ${d.riseMs}`).toBeLessThan(3);
	});

	it('headQuietSec is the head under −40 dB of the sample peak, rounded down', () => {
		const n = SR;
		const x = noise(5, n, 0.5);
		const head = Math.round(0.2537 * SR);
		x.fill(0, 0, head);
		for (let i = 0; i < 100; i++) x[i] = 0.004; // −42 dB re 0.5: still quiet
		const d = analyzeSound([x], SR);
		let first = head;
		while (Math.abs(x[first]!) < 0.005) first++;
		expect(d.headQuietSec).toBeLessThanOrEqual(first / SR);
		expect(first / SR - d.headQuietSec).toBeLessThan(0.0001);
		expect(d.onsetSec).toBeGreaterThanOrEqual(0.25);
	});

	it('counts separate hits, not the tail of one', () => {
		const n = SR;
		const make = (times: number[]): Float32Array => {
			const x = new Float32Array(n);
			const r = new Prng(3);
			for (const t of times)
				for (let i = Math.round(t * SR); i < n; i++)
					x[i] += 0.3 * Math.exp(-(i / SR - t) / 0.01) * r.uniform();
			return x;
		};
		expect(analyzeSound([make([0.1])], SR).onsetCount).toBe(1);
		expect(analyzeSound([make([0.1, 0.35])], SR).onsetCount).toBe(2);
		expect(analyzeSound([make([0.1, 0.3, 0.5, 0.7])], SR).onsetCount).toBe(4);
		// a swell with no attack: no onset after its start
		const swell = new Float32Array(n * 2);
		const r = new Prng(4);
		for (let i = 0; i < swell.length; i++) swell[i] = (i / swell.length) ** 3 * r.uniform() * 0.5;
		expect(analyzeSound([swell], SR).onsetCount).toBeLessThanOrEqual(1);
		// a steady tone stopping abruptly is one onset
		expect(analyzeSound([sine(800, 0.5, SR, SR / 2)], SR).onsetCount).toBe(1);
	});

	it('loudness: a stereo 1 kHz sine at −20 dBFS is −20 LUFS, −20 dBTP', () => {
		const a = 10 ** (-20 / 20);
		const x = sine(1000, a, SR, SR * 3);
		const d = analyzeSound([x, x.slice()], SR);
		expect(Math.abs(d.integratedLufs! - -20)).toBeLessThan(0.1);
		expect(Math.abs(d.maxMomentaryLufs! - -20)).toBeLessThan(0.1);
		expect(Math.abs(d.truePeakDb! - -20)).toBeLessThan(0.1);
	});

	it('a 30 ms click still has a momentary loudness and a true peak', () => {
		const x = new Float32Array(Math.round(0.03 * SR));
		const r = new Prng(9);
		for (let i = 0; i < x.length; i++) x[i] = 0.9 * Math.exp(-i / SR / 0.004) * r.uniform();
		const d = analyzeSound([x], SR);
		expect(d.maxMomentaryLufs).not.toBeNull();
		expect(d.maxMomentaryLufs!).toBeLessThan(-10);
		expect(d.truePeakDb!).toBeGreaterThan(-3);
		expect(d.onsetCount).toBe(1);
	});

	it('stereo width: 0 for dual mono, 0.5 for one side or uncorrelated, 1 for anti-phase', () => {
		const x = noise(1, SR, 0.5);
		const neg = x.map((v) => -v);
		expect(analyzeSound([x, x.slice()], SR).stereoWidth).toBe(0);
		expect(analyzeSound([x, neg], SR).stereoWidth).toBe(1);
		expect(analyzeSound([x, new Float32Array(SR)], SR).stereoWidth).toBe(0.5);
		expect(Math.abs(analyzeSound([x, noise(2, SR, 0.5)], SR).stereoWidth - 0.5)).toBeLessThan(0.02);
		expect(analyzeSound([x], SR).stereoWidth).toBe(0);
	});

	it('dual mono measures like mono (except loudness, which adds the second channel)', () => {
		const x = noise(8, SR, 0.3);
		const m = analyzeSound([x], SR);
		const s = analyzeSound([x, x.slice()], SR);
		const strip = (d: SoundDescriptors) => ({ ...d, integratedLufs: 0, maxMomentaryLufs: 0 });
		expect(strip(s)).toEqual(strip(m));
		expect(Math.abs(s.integratedLufs! - m.integratedLufs! - 3.01)).toBeLessThan(0.02);
	});

	it('loopable: steady noise and a whole-cycle tone loop; a hit, a fade-in or a click at the wrap do not', () => {
		expect(analyzeSound([noise(2, SR * 2, 0.4)], SR).loopable).toBe(true);
		expect(analyzeSound([sine(100, 0.4, SR, SR * 2)], SR).loopable).toBe(true);
		const half = sine(100, 0.4, SR, SR * 2 + 120); // ends a quarter cycle off: a jump at the wrap
		expect(analyzeSound([half], SR).loopable).toBe(false);
		const fade = noise(3, SR * 2, 0.4).map((v, i) => v * Math.min(1, i / SR));
		expect(analyzeSound([fade], SR).loopable).toBe(false);
		const hit = noise(4, SR * 2, 0.4).map((v, i) => v * Math.exp(-i / SR / 0.2));
		expect(analyzeSound([hit], SR).loopable).toBe(false);
		expect(analyzeSound([noise(2, SR / 2, 0.4)], SR).loopable).toBe(false); // < 1 s
	});

	it('a 5.1 sound is analysed (all channels in the envelope and spectrum, L/R for width)', () => {
		const chs = Array.from({ length: 6 }, (_, c) =>
			c === 2 ? sine(440, 0.5, SR, SR) : new Float32Array(SR),
		);
		const d = analyzeSound(chs, SR);
		expect(d.pitchMidi).toBe(69);
		expect(d.stereoWidth).toBe(0);
		expect(d.integratedLufs).not.toBeNull();
		expectWellFormed(d);
	});
});

describe('analyzeSound: edge input', () => {
	const silent: Partial<SoundDescriptors> = {
		peakSec: 0,
		onsetSec: 0,
		riseMs: 0,
		decayMs: 0,
		decays: false,
		tailSec: 0,
		centroidHz: 0,
		flatness: 0,
		octaveBandsDb: [-120, -120, -120, -120, -120, -120, -120],
		pitchMidi: null,
		pitchConfidence: 0,
		onsetCount: 0,
		integratedLufs: null,
		maxMomentaryLufs: null,
		truePeakDb: null,
		stereoWidth: 0,
		loopable: false,
	};

	it('no channels, empty channels, one sample and silence are defined', () => {
		expect(analyzeSound([], SR)).toMatchObject({ ...silent, durationSec: 0, headQuietSec: 0 });
		expect(analyzeSound([new Float32Array(0), new Float32Array(0)], SR)).toMatchObject({
			...silent,
			durationSec: 0,
		});
		expect(analyzeSound([new Float32Array(SR * 2)], SR)).toMatchObject({
			...silent,
			durationSec: 2,
			headQuietSec: 2,
		});
		const one = analyzeSound([new Float32Array([0.5])], SR);
		expectWellFormed(one);
		expect(one.durationSec).toBe(0);
		expect(one.peakSec).toBe(0);
		expect(one.truePeakDb).not.toBeNull();
		expectWellFormed(analyzeSound([new Float32Array([0.5]), new Float32Array([-0.5])], SR));
	});

	it('non-finite samples are treated as silence (sanitised, not propagated)', () => {
		const x = noise(6, SR, 0.5);
		const dirty = x.slice();
		const clean = x.slice();
		for (const i of [0, 17, 4000, 20_000, SR - 1]) {
			dirty[i] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY][i % 3]!;
			clean[i] = 0;
		}
		expect(analyzeSound([dirty], SR)).toEqual(analyzeSound([clean], SR));
		const allNaN = new Float32Array(1000).fill(Number.NaN);
		expect(analyzeSound([allNaN], SR)).toMatchObject(silent);
	});

	it('channels of different lengths are padded with silence', () => {
		const a = noise(1, SR, 0.5);
		const d = analyzeSound([a, a.subarray(0, SR / 2)], SR);
		expect(d.durationSec).toBe(1);
		expect(d).toEqual(
			analyzeSound([a, Float32Array.from({ length: SR }, (_, i) => (i < SR / 2 ? a[i]! : 0))], SR),
		);
	});

	it('huge finite samples stay finite', () => {
		const x = new Float32Array(4800);
		for (let i = 0; i < x.length; i++) x[i] = (i % 2 ? 1 : -1) * 3.4e38;
		const d = analyzeSound([x, x], SR);
		expectWellFormed(d);
		// ≈ +730 dBTP before the Phase 1 verification; capped so the value fits the project's provenance schema
		expect(d.truePeakDb!).toBe(DESCRIPTOR_CEILING_DB);
	});

	it('audio after 120 s is ignored while durationSec retains the full recording length', () => {
		const sr = 1000;
		const x = sine(200, 0.1, sr, 125 * sr);
		x.set(sine(440, 0.9, sr, 5 * sr), 120 * sr);
		const d = analyzeSound([x], sr);
		expect(d.durationSec).toBe(125);
		expect(Math.abs(d.centroidHz - 200)).toBeLessThan(2);
		expect(d.pitchMidi).not.toBeNull();
		expectWellFormed(d);
	});

	it('refuses invalid arguments with a typed error', () => {
		const x = new Float32Array(10);
		for (const sr of [0, -48000, Number.NaN, Number.POSITIVE_INFINITY, 10, 10_000_000])
			expect(() => analyzeSound([x], sr)).toThrow(SoundAnalysisError);
		expect(() => analyzeSound('x' as unknown as Float32Array[], SR)).toThrow(SoundAnalysisError);
		expect(() => analyzeSound([[1, 2, 3] as unknown as Float32Array], SR)).toThrow(SoundAnalysisError);
		expect(() =>
			analyzeSound(
				Array.from({ length: 33 }, () => x),
				SR,
			),
		).toThrow(SoundAnalysisError);
		try {
			analyzeSound([x], 0);
		} catch (e) {
			expect((e as SoundAnalysisError).code).toBe('E_INVALID_PARAM');
		}
	});

	it('is deterministic', () => {
		const x = noise(10, SR / 3, 0.5);
		expect(analyzeSound([x], SR)).toEqual(analyzeSound([x.slice()], SR));
	});
});

describe('analyzeSound: properties', () => {
	const rates = fc.constantFrom(8000, 16_000, 22_050, 44_100, 48_000, 96_000);

	it('never throws on finite input of any length and channel count; every output is finite and quantised', () => {
		fc.assert(
			fc.property(
				rates,
				fc.integer({ min: 0, max: 6 }),
				fc.integer({ min: 0, max: 12_000 }),
				fc.integer({ min: 0, max: 2 ** 31 }),
				fc.constantFrom(1e-6, 0.01, 1, 1000),
				fc.constantFrom('noise', 'burst', 'sparse', 'constant'),
				(sr, nch, len, seed, amp, kind) => {
					const r = new Prng(seed);
					const chs = Array.from({ length: nch }, () => {
						const x = new Float32Array(len);
						for (let i = 0; i < len; i++) {
							const u = r.uniform();
							x[i] =
								kind === 'noise'
									? u * amp
									: kind === 'burst'
										? i > len / 3 && i < len / 2
											? u * amp
											: 0
										: kind === 'sparse'
											? Math.abs(u) > 0.995
												? amp
												: 0
											: amp;
						}
						return x;
					});
					expectWellFormed(analyzeSound(chs, sr));
				},
			),
			{ numRuns: 120, seed: 0x5d1 },
		);
	});

	it('never throws on arbitrary float32 data (NaN, ±Infinity, subnormals, extremes included)', () => {
		fc.assert(
			fc.property(
				fc.array(fc.float32Array({ maxLength: 3000 }), { minLength: 0, maxLength: 3 }),
				rates,
				(chs, sr) => {
					expectWellFormed(analyzeSound(chs, sr));
				},
			),
			{ numRuns: 150, seed: 0x5d2 },
		);
	});
});
