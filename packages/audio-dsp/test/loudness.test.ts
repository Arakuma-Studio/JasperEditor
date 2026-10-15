// Ported from FilmCraft crates/audio-dsp/src/loudness.rs tests, plus API and property tests.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LoudnessMeter, measureLoudness, normalizeGainDb } from '../src/index.ts';
import { dbfs, Rng, segments } from './util.ts';

function stereoMeasure(x: Float32Array, sr: number): LoudnessMeter {
	const m = new LoudnessMeter(sr, 2);
	// Feed in odd-sized blocks to exercise the sub-block splitting.
	for (let pos = 0; pos < x.length; pos += 1237) m.process([x, x], pos, Math.min(1237, x.length - pos));
	return m;
}

describe('LoudnessMeter (BS.1770-4 / EBU R128)', () => {
	it('silence and below-gate programmes', () => {
		const sr = 48000;
		const m = new LoudnessMeter(sr, 2);
		expect(m.momentary()).toBe(Number.NEGATIVE_INFINITY);
		expect(m.shortTerm()).toBe(Number.NEGATIVE_INFINITY);
		const z = new Float32Array(sr * 2);
		m.process([z, z]);
		expect(m.integrated()).toBe(Number.NEGATIVE_INFINITY);
		expect(m.momentary()).toBe(Number.NEGATIVE_INFINITY);
		expect(m.loudnessRange()).toBe(0);
		expect(m.relativeThreshold()).toBe(Number.NEGATIVE_INFINITY);
		const x = segments(1000, sr, [[5, -80]]);
		expect(stereoMeasure(x, sr).integrated()).toBe(Number.NEGATIVE_INFINITY);
	});

	it('custom channel weights can include LFE in loudness', () => {
		const sr = 48000;
		const x = segments(1000, sr, [[10, -30]]);
		const z = new Float32Array(x.length);
		const front = new LoudnessMeter(sr, 6);
		front.process([x, z, z, z, z, z]);
		const custom = new LoudnessMeter(sr, 6, { weights: [1, 1, 1, 1, 1, 1] });
		custom.process([z, z, z, x, z, z]);
		expect(Math.abs(custom.integrated() - front.integrated())).toBeLessThan(1e-9);
	});

	it('reset clears everything', () => {
		const sr = 48000;
		const m = stereoMeasure(segments(1000, sr, [[5, -20]]), sr);
		m.reset();
		expect(m.integrated()).toBe(Number.NEGATIVE_INFINITY);
		expect(m.truePeak()).toBe(0);
		expect(m.samplePeak()).toBe(0);
		expect(m.maxMomentary()).toBe(Number.NEGATIVE_INFINITY);
		const x = segments(1000, sr, [[5, -30]]);
		m.process([x, x]);
		expect(Math.abs(m.integrated() + 30)).toBeLessThan(0.1);
	});

	it('normalisation helpers', () => {
		expect(normalizeGainDb({ integratedLufs: -30, truePeakDbtp: -10 }, -23)).toEqual({
			gainDb: 7,
			maxGainDb: Number.POSITIVE_INFINITY,
			limitedGainDb: 7,
		});
		expect(normalizeGainDb({ integratedLufs: Number.NEGATIVE_INFINITY, truePeakDbtp: -3 }, -23).gainDb).toBe(
			0,
		);
		expect(normalizeGainDb({ integratedLufs: -30, truePeakDbtp: -3 }, -23, -1)).toEqual({
			gainDb: 7,
			maxGainDb: 2,
			limitedGainDb: 2,
		});
		expect(normalizeGainDb({ integratedLufs: -30, truePeakDbtp: -10 }, -23, -1).limitedGainDb).toBe(7);
		const sr = 48000;
		const x = segments(1000, sr, [[10, -31.3]]);
		const m = stereoMeasure(x, sr);
		const g = dbfs(
			normalizeGainDb({ integratedLufs: m.integrated(), truePeakDbtp: m.truePeakDb() }, -16).gainDb,
		);
		const y = x.map((v) => v * g);
		expect(Math.abs(stereoMeasure(y, sr).integrated() + 16)).toBeLessThan(0.02);
	});

	it('missing channels count as silence; measureLoudness summarises', () => {
		const sr = 48000;
		const x = segments(1000, sr, [[4, -20]]);
		const a = new LoudnessMeter(sr, 2);
		a.process([x]);
		const b = new LoudnessMeter(sr, 2);
		b.process([x, new Float32Array(x.length)]);
		expect(a.integrated()).toBe(b.integrated());
		const s = measureLoudness([x, x], sr);
		expect(Math.abs(s.integrated + 20)).toBeLessThan(0.1);
		expect(Math.abs(s.samplePeakDb + 20)).toBeLessThan(0.01);
		expect(s.truePeakDb).toBeGreaterThanOrEqual(s.samplePeakDb);
		expect(s.lra).toBeLessThan(0.1);
		expect(s.maxMomentary).toBeGreaterThanOrEqual(s.integrated - 0.1);
		expect(s.maxShortTerm).toBeGreaterThanOrEqual(s.integrated - 0.1);
		expect(measureLoudness([x], sr, [2]).integrated).toBeCloseTo(measureLoudness([x, x], sr).integrated, 9);
	});

	it('property: results do not depend on how the input is cut into blocks', () => {
		const sr = 8000;
		const r = new Rng(9);
		const n = sr * 4;
		const l = new Float32Array(n);
		const rr = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const env = i < n / 2 ? 0.5 : 0.05;
			l[i] = env * r.uniform();
			rr[i] = env * Math.sin(i * 0.3);
		}
		const ref = new LoudnessMeter(sr, 2);
		ref.process([l, rr]);
		fc.assert(
			fc.property(fc.array(fc.integer({ min: 0, max: 2500 }), { minLength: 1, maxLength: 40 }), (sizes) => {
				const m = new LoudnessMeter(sr, 2);
				let pos = 0;
				let k = 0;
				while (pos < n) {
					const len = Math.min(n - pos, sizes[k++ % sizes.length] || 1);
					m.process([l, rr], pos, len);
					pos += len;
				}
				return (
					m.integrated() === ref.integrated() &&
					m.loudnessRange() === ref.loudnessRange() &&
					m.maxMomentary() === ref.maxMomentary() &&
					m.maxShortTerm() === ref.maxShortTerm() &&
					m.truePeak() === ref.truePeak() &&
					m.momentary() === ref.momentary() &&
					m.shortTerm() === ref.shortTerm()
				);
			}),
			{ numRuns: 25 },
		);
	});
});
