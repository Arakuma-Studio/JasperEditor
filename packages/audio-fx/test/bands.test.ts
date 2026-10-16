// Octave-band levels and local loudness peaks shared by the descriptors and the masking solver (spec 12 §2.4).
import { LoudnessMeter } from '@jasper/audio-dsp';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	analyzeSound,
	BAND_FLOOR_DB,
	bandLevels,
	bedLocalPeakLu,
	OCTAVE_BAND_CENTRES_HZ,
	shortTermPeakLu,
	sumBandsDb,
} from '../src/index.ts';
import { noise, powerLawNoise, SR, sine } from './util.ts';

const maxMomentary = (ch: Float32Array[]): number => {
	const m = new LoudnessMeter(SR, ch.length);
	m.process(ch);
	return m.maxMomentary();
};

describe('bandLevels', () => {
	it('is the descriptors’ octaveBandsDb when the window is the whole (fully active) sound', () => {
		const x = powerLawNoise(3, 1 << 16, SR, 20, 20_000, -1);
		const y = noise(4, 1 << 16, 0.3);
		const d = analyzeSound([x, y], SR);
		const b = bandLevels([x, y], SR, { start: 0, end: x.length / SR });
		for (let k = 0; k < 7; k++)
			expect(Math.abs(b[k]! - d.octaveBandsDb[k]!), `${b} / ${d.octaveBandsDb}`).toBeLessThan(0.01);
	});

	it('a full-scale 1 kHz sine reads −3.01 dB in the 1 kHz band and ≥ 40 dB less elsewhere', () => {
		const x = sine(1000, 1, SR, 4 * SR);
		const b = bandLevels([x], SR, { start: 0, end: 4 });
		expect(Math.abs(b[3]! + 3.01), `${b}`).toBeLessThan(0.1);
		for (const k of [0, 1, 2, 5, 6]) expect(b[k]!).toBeLessThan(-43);
		// channels are averaged: the same sine on two channels reads the same
		const b2 = bandLevels([x, x], SR, { start: 0, end: 4 });
		expect(Math.abs(b2[3]! - b[3]!)).toBeLessThan(1e-9);
	});

	it('measures only inside the window', () => {
		const x = new Float32Array(5 * SR);
		x.set(sine(2000, 0.5, SR, SR), 2 * SR);
		expect(bandLevels([x], SR, { start: 3.2, end: 4.8 })).toEqual(
			OCTAVE_BAND_CENTRES_HZ.map(() => BAND_FLOOR_DB),
		);
		const inside = bandLevels([x], SR, { start: 2, end: 3 });
		expect(Math.abs(inside[4]! - 20 * Math.log10(0.5 / Math.SQRT2))).toBeLessThan(0.3);
		// a window that runs past the end counts the missing part as silence, never throws
		const past = bandLevels([x], SR, { start: 4.5, end: 9 });
		expect(past.every((v) => v === BAND_FLOOR_DB)).toBe(true);
	});

	it('pink noise has equal octave bands within 0.5 dB', () => {
		const x = powerLawNoise(5, 1 << 18, SR, 20, 20_000, -1);
		const b = bandLevels([x], SR, { start: 0.5, end: 5 });
		const mean = b.reduce((s, v) => s + v, 0) / 7;
		for (const v of b) expect(Math.abs(v - mean), `${b}`).toBeLessThan(0.5);
	});

	it('degenerate input gives the floor and never throws', () => {
		const floor = OCTAVE_BAND_CENTRES_HZ.map(() => BAND_FLOOR_DB);
		const x = sine(1000, 0.5, SR, SR);
		expect(bandLevels([], SR, { start: 0, end: 1 })).toEqual(floor);
		expect(bandLevels([x], 0, { start: 0, end: 1 })).toEqual(floor);
		expect(bandLevels([x], Number.NaN, { start: 0, end: 1 })).toEqual(floor);
		expect(bandLevels([x], SR, { start: 1, end: 0 })).toEqual(floor);
		expect(bandLevels([x], SR, { start: Number.NaN, end: 1 })).toEqual(floor);
		expect(bandLevels([x], SR, null as never)).toEqual(floor);
		expect(bandLevels(null as never, SR, { start: 0, end: 1 })).toEqual(floor);
		expect(bandLevels([new Float32Array(SR)], SR, { start: 0, end: 1 })).toEqual(floor);
		// NaN / ±Infinity samples count as 0
		const bad = new Float32Array(x);
		for (let i = 0; i < bad.length; i += 97) bad[i] = i % 2 ? Number.NaN : Number.POSITIVE_INFINITY;
		const clean = new Float32Array(bad.map((v) => (Number.isFinite(v) ? v : 0)));
		expect(bandLevels([bad], SR, { start: 0, end: 1 })).toEqual(
			bandLevels([clean], SR, { start: 0, end: 1 }),
		);
	});

	it('property: any samples and window give 7 finite levels ≥ the floor', () => {
		fc.assert(
			fc.property(
				fc.array(fc.float32Array({ maxLength: 3000 }), { maxLength: 3 }),
				fc.constantFrom(8000, 22050, 48000, 96000),
				fc.double(),
				fc.double(),
				(chs, sr, a, b) => {
					const r = bandLevels(chs, sr, { start: a, end: b });
					expect(r).toHaveLength(7);
					for (const v of r) {
						expect(Number.isFinite(v)).toBe(true);
						expect(v).toBeGreaterThanOrEqual(BAND_FLOOR_DB);
					}
				},
			),
			{ numRuns: 150 },
		);
	});

	it('sumBandsDb adds energies', () => {
		expect(sumBandsDb([-20, -20])).toBeCloseTo(-20 + 10 * Math.log10(2), 9);
		expect(sumBandsDb([])).toBe(BAND_FLOOR_DB);
		expect(sumBandsDb([Number.NEGATIVE_INFINITY, Number.NaN])).toBe(BAND_FLOOR_DB);
	});
});

describe('shortTermPeakLu', () => {
	it('a stereo −20 dBFS 1 kHz sine reads −20 LUFS, like the BS.1770 meter', () => {
		const x = sine(1000, 0.1, SR, 3 * SR);
		const v = shortTermPeakLu([x, x], SR, { start: 1, end: 2 });
		expect(Math.abs(v - maxMomentary([x, x])), `${v}`).toBeLessThan(0.05);
		expect(Math.abs(v + 20)).toBeLessThan(0.1);
	});

	it('finds the loudest 400 ms whose centre is in the range, and nothing outside it', () => {
		const x = new Float32Array(8 * SR);
		x.set(powerLawNoise(9, 1 << 14, SR, 100, 10_000, -1, 0.5), 2 * SR); // ≈ 0.34 s burst at 2 s
		const burst = shortTermPeakLu([x], SR, { start: 2, end: 2.4 });
		expect(Number.isFinite(burst)).toBe(true);
		// the burst is in a hero's ±1 s support around [3.2, 3.3] but not in a support's ±0.15 s
		expect(bedLocalPeakLu([x], SR, { start: 3.2, end: 3.3 }, 'hero')).toBeGreaterThan(burst - 3);
		expect(bedLocalPeakLu([x], SR, { start: 3.2, end: 3.3 }, 'support')).toBe(Number.NEGATIVE_INFINITY);
		expect(shortTermPeakLu([x], SR, { start: 5, end: 6 }, 0.15)).toBe(Number.NEGATIVE_INFINITY);
		// a quieter copy of the bed reads exactly that much lower
		const q = new Float32Array(x.map((v) => v * 0.5));
		expect(shortTermPeakLu([q], SR, { start: 2, end: 2.4 })).toBeCloseTo(burst - 20 * Math.log10(2), 3);
	});

	it('degenerate input gives −Infinity and never throws', () => {
		const x = sine(1000, 0.1, SR, SR);
		expect(shortTermPeakLu([], SR, { start: 0, end: 1 })).toBe(Number.NEGATIVE_INFINITY);
		expect(shortTermPeakLu([x], -1, { start: 0, end: 1 })).toBe(Number.NEGATIVE_INFINITY);
		expect(shortTermPeakLu([x], SR, { start: Number.NaN, end: 1 })).toBe(Number.NEGATIVE_INFINITY);
		expect(shortTermPeakLu([x], SR, { start: 0, end: 1 }, Number.NaN)).toBeGreaterThan(-30);
		expect(shortTermPeakLu([new Float32Array(SR)], SR, { start: 0, end: 1 })).toBe(Number.NEGATIVE_INFINITY);
		fc.assert(
			fc.property(
				fc.float32Array({ maxLength: 4000 }),
				fc.double(),
				fc.double(),
				fc.double(),
				(c, a, b, m) => {
					const v = shortTermPeakLu([c], 8000, { start: a, end: b }, m);
					expect(Number.isNaN(v)).toBe(false);
					expect(v).not.toBe(Number.POSITIVE_INFINITY);
				},
			),
			{ numRuns: 150 },
		);
	});
});
