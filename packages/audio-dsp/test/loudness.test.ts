// Ported from FilmCraft crates/audio-dsp/src/loudness.rs tests, plus API and property tests.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	defaultChannelWeights,
	energyToLufs,
	kWeightingPower,
	LoudnessMeter,
	lufsToEnergy,
	measureLoudness,
	normalizeGainDb,
} from '../src/index.ts';
import { dbfs, Rng, rms, segments, sine } from './util.ts';

function stereoMeasure(x: Float32Array, sr: number): LoudnessMeter {
	const m = new LoudnessMeter(sr, 2);
	// Feed in odd-sized blocks to exercise the sub-block splitting.
	for (let pos = 0; pos < x.length; pos += 1237) m.process([x, x], pos, Math.min(1237, x.length - pos));
	return m;
}

describe('LoudnessMeter (BS.1770-4 / EBU R128)', () => {
	it('Tech 3341 cases 1 & 2: stereo sine at −23 / −33 dBFS', () => {
		for (const [sr, freq] of [
			[48000, 1000],
			[44100, 997],
			[96000, 1000],
		]) {
			for (const level of [-23, -33]) {
				const x = segments(freq, sr, [[20, level]]);
				const m = stereoMeasure(x, sr);
				expect(Math.abs(m.integrated() - level), `sr ${sr} I ${m.integrated()}`).toBeLessThan(0.1);
				expect(Math.abs(m.momentary() - level)).toBeLessThan(0.1);
				expect(Math.abs(m.shortTerm() - level)).toBeLessThan(0.1);
				expect(Math.abs(m.maxMomentary() - level)).toBeLessThan(0.1);
				expect(Math.abs(m.maxShortTerm() - level)).toBeLessThan(0.1);
				expect(m.loudnessRange()).toBeLessThan(0.1);
			}
		}
	});

	it('Tech 3341 cases 3 & 4: absolute and relative gating', () => {
		const sr = 48000;
		let x = segments(1000, sr, [
			[10, -36],
			[60, -23],
			[10, -36],
		]);
		expect(Math.abs(stereoMeasure(x, sr).integrated() + 23)).toBeLessThan(0.1);
		x = segments(1000, sr, [
			[10, -72],
			[10, -36],
			[60, -23],
			[10, -36],
			[10, -72],
		]);
		expect(Math.abs(stereoMeasure(x, sr).integrated() + 23)).toBeLessThan(0.1);
	});

	it('Tech 3341 case 5: relative gate', () => {
		const sr = 48000;
		const x = segments(1000, sr, [
			[20, -26],
			[20.1, -20],
			[20, -26],
		]);
		expect(Math.abs(stereoMeasure(x, sr).integrated() + 23)).toBeLessThan(0.1);
	});

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

	it('Tech 3342 loudness range', () => {
		const sr = 48000;
		const cases: [[number, number][], number][] = [
			[
				[
					[20, -20],
					[20, -30],
				],
				10,
			],
			[
				[
					[20, -20],
					[20, -15],
				],
				5,
			],
			[
				[
					[20, -40],
					[20, -20],
				],
				20,
			],
			[
				[
					[20, -50],
					[20, -35],
					[20, -20],
					[20, -35],
					[20, -50],
				],
				15,
			],
		];
		for (const [segs, expected] of cases) {
			const m = stereoMeasure(segments(1000, sr, segs), sr);
			expect(Math.abs(m.loudnessRange() - expected), `LRA ${m.loudnessRange()} vs ${expected}`).toBeLessThan(
				1,
			);
		}
	});

	it('log sweep matches the analytic K-weighting', () => {
		const sr = 48000;
		const n = sr * 20;
		const f1 = 20;
		const f2 = 20000;
		const k = Math.log(f2 / f1);
		const amp = dbfs(-20);
		let phase = 0;
		const x = new Float32Array(n);
		let expected = 0;
		for (let i = 0; i < n; i++) {
			const f = f1 * Math.exp((k * i) / n);
			x[i] = amp * Math.sin(phase);
			phase += (2 * Math.PI * f) / sr;
			expected += amp * amp * kWeightingPower(f, sr);
		}
		expected /= n;
		const i = stereoMeasure(x, sr).integrated();
		const e = energyToLufs(expected);
		// gating removes the quiet low-frequency start, so integrated ≥ ungated expectation (and close)
		expect(i).toBeGreaterThanOrEqual(e - 0.1);
		expect(i - e).toBeLessThan(0.6);
	});

	it('surround weights: Ls +1.5 dB, LFE excluded', () => {
		const sr = 48000;
		const x = segments(1000, sr, [[10, -30]]);
		const z = new Float32Array(x.length);
		const front = new LoudnessMeter(sr, 6);
		front.process([x, z, z, z, z, z]);
		const surr = new LoudnessMeter(sr, 6);
		surr.process([z, z, z, z, x, z]);
		const lfe = new LoudnessMeter(sr, 6);
		lfe.process([z, z, z, x, z, z]);
		expect(Math.abs(surr.integrated() - front.integrated() - 10 * Math.log10(1.41))).toBeLessThan(0.01);
		expect(lfe.integrated()).toBe(Number.NEGATIVE_INFINITY);
		// explicit weights override the defaults
		const custom = new LoudnessMeter(sr, 6, { weights: [1, 1, 1, 1, 1, 1] });
		custom.process([z, z, z, x, z, z]);
		expect(Math.abs(custom.integrated() - front.integrated())).toBeLessThan(1e-9);
	});

	it('default channel weights', () => {
		expect(defaultChannelWeights(1)).toEqual([1]);
		expect(defaultChannelWeights(2)).toEqual([1, 1]);
		expect(defaultChannelWeights(6)).toEqual([1, 1, 1, 0, 1.41, 1.41]);
		expect(defaultChannelWeights(3)).toEqual([1, 1, 1]);
	});

	it('true peak of inter-sample-peak signals', () => {
		for (const sr of [48000, 44100]) {
			// fs/4 sine with 45° phase: every sample is at ±0.5·√2·A, true peak A (0 dBFS).
			const x = sine(sr / 4, 1, sr, sr, Math.PI / 4);
			const m = stereoMeasure(x, sr);
			expect(Math.abs(m.samplePeakDb() + 3.01)).toBeLessThan(0.01);
			// EBU Tech 3341 true-peak tolerance: +0.2 / −0.4 dB.
			const tp = m.truePeakDb();
			expect(tp, `sr ${sr} TP ${tp}`).toBeGreaterThanOrEqual(-0.4);
			expect(tp).toBeLessThanOrEqual(0.2);
		}
		let m = stereoMeasure(sine(997, dbfs(-6), 48000, 48000, 0.3), 48000);
		expect(Math.abs(m.truePeakDb() + 6)).toBeLessThan(0.2);
		m = stereoMeasure(sine(11025, 1, 44100, 44100, 0), 44100);
		expect(m.truePeakDb()).toBeGreaterThanOrEqual(-0.4);
		expect(m.truePeakDb()).toBeLessThanOrEqual(0.2);
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
		// applying the gain lands on target
		const sr = 48000;
		const x = segments(1000, sr, [[10, -31.3]]);
		const m = stereoMeasure(x, sr);
		const g = dbfs(
			normalizeGainDb({ integratedLufs: m.integrated(), truePeakDbtp: m.truePeakDb() }, -16).gainDb,
		);
		const y = x.map((v) => v * g);
		expect(Math.abs(stereoMeasure(y, sr).integrated() + 16)).toBeLessThan(0.02);
		expect(Math.abs(lufsToEnergy(energyToLufs(0.3)) - 0.3)).toBeLessThan(1e-12);
	});

	it('tiny blocks equal big blocks; mono has no dual-mono +3 dB', () => {
		const sr = 48000;
		const x = segments(440, sr, [[4, -18]]);
		const a = new LoudnessMeter(sr, 1);
		a.process([x]);
		const b = new LoudnessMeter(sr, 1);
		b.process([new Float32Array(0)]);
		for (let i = 0; i < x.length; i++) b.process([x], i, 1);
		expect(b.integrated()).toBe(a.integrated());
		expect(b.truePeak()).toBe(a.truePeak());
		const expected = -0.691 + 20 * Math.log10(rms(x)) + 10 * Math.log10(kWeightingPower(440, sr));
		expect(Math.abs(a.integrated() - expected)).toBeLessThan(0.1);
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
