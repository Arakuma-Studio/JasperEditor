// Sound Check measurements (spec 12 §2.6; wp-note "Phase 5 → WP5.1"): 10 ms curves, loudness curves against the
// BS.1770 meter, peak location by cross-correlation, and the solver-consistent evaluation of a sound effect's gain.
import { LoudnessMeter } from '@jasper/audio-dsp';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	CurveMeter,
	evaluateSfxGain,
	LOUDNESS_FLOOR_LUFS,
	locateByCorrelation,
	loudnessCurve,
	maxPool,
	type SolverEvent,
	shortTermPeakLu,
	silentCurves,
	solveSfxGains,
} from '../src/index.ts';
import { noise, sine } from './util.ts';

const SR = 48_000;

function feed(meter: CurveMeter, planar: Float32Array[], block: number) {
	const n = planar[0]!.length;
	for (let i = 0; i < n; i += block) {
		const k = Math.min(block, n - i);
		meter.push(
			planar.map((c) => c.subarray(i, i + k)),
			k,
		);
	}
	return meter.finish();
}

describe('CurveMeter', () => {
	it('does not depend on how the stream is cut', () => {
		const x = [noise(3, SR + 123, 0.2), noise(4, SR + 123, 0.1)];
		const whole = feed(new CurveMeter(SR, 2), x, x[0]!.length);
		for (const block of [1, 7, 480, 4096]) {
			const c = feed(new CurveMeter(SR, 2), x, block);
			expect(c.count).toBe(whole.count);
			for (let i = 0; i < c.count; i++) {
				expect(c.kEnergy[i]).toBeCloseTo(whole.kEnergy[i]!, 9);
				expect(c.msDb[i]).toBe(whole.msDb[i]);
				expect(c.peakDb[i]).toBe(whole.peakDb[i]);
			}
		}
		// 101 hops: 100 full and the partial last one
		expect(whole.count).toBe(101);
	});

	it('levels and peaks of a −20 dBFS sine; silence is the floor; non-finite samples count as 0', () => {
		const a = 0.1 * Math.SQRT2; // RMS 0.1 = −20 dBFS
		const s = sine(1000, a, SR, SR);
		const c = feed(new CurveMeter(SR, 1), [s], 512);
		expect(c.msDb[50]).toBeCloseTo(-20, 1);
		expect(c.peakDb[50]).toBeCloseTo(20 * Math.log10(a), 1);
		const z = new Float32Array(SR);
		z[10] = Number.NaN;
		z[20] = Number.POSITIVE_INFINITY;
		const q = feed(new CurveMeter(SR, 2), [z], 1000);
		expect([...q.msDb].every((v) => v === LOUDNESS_FLOOR_LUFS)).toBe(true);
		expect(silentCurves(SR, 5).msDb[4]).toBe(LOUDNESS_FLOOR_LUFS);
	});

	it('momentary and short-term curves equal the BS.1770 meter in the steady state', () => {
		const a = 0.1 * Math.SQRT2;
		const n = 5 * SR;
		const x = [sine(997, a, SR, n), sine(997, a, SR, n, 0.3)];
		const c = feed(new CurveMeter(SR, 2), x, 4800);
		const meter = new LoudnessMeter(SR, 2);
		meter.process(x, 0, n);
		const m = loudnessCurve(c, 0.4);
		const st = loudnessCurve(c, 3);
		// the centred window at 2.5 s sees the same steady sine as the trailing meter
		expect(m[250]).toBeCloseTo(meter.momentary(), 1);
		expect(st[250]).toBeCloseTo(meter.shortTerm(), 1);
		// and the same as bands.ts' local peak (centred 400 ms windows every 10 ms)
		expect(m[250]).toBeCloseTo(shortTermPeakLu(x, SR, { start: 2.5, end: 2.5 }), 1);
		// an offset shifts every value
		expect(loudnessCurve(c, 0.4, -6)[250]).toBeCloseTo(m[250]! - 6, 4);
	});

	it('maxPool keeps the peaks', () => {
		const v = new Float32Array(1000).fill(-30);
		v[777] = -3;
		const p = maxPool(v, 100);
		expect(p.factor).toBe(10);
		expect(p.values.length).toBe(100);
		expect(Math.max(...p.values)).toBe(-3);
		expect(p.values[77]).toBe(-3);
	});
});

describe('locateByCorrelation', () => {
	const click = () => {
		const r = new Float32Array(2400);
		for (let i = 0; i < r.length; i++) r[i] = Math.sin((2 * Math.PI * 900 * i) / SR) * Math.exp(-i / 300);
		return r;
	};

	it('finds a reference inside noise at its exact offset, whatever its gain', () => {
		const ref = click();
		for (const at of [0, 1234, 5000, 7600]) {
			const sig = noise(9, 10_000, 0.01);
			for (let i = 0; i < ref.length; i++) sig[at + i]! += 0.3 * ref[i]!;
			const r = locateByCorrelation(ref, sig, 0, 10_000 - ref.length)!;
			expect(Math.abs(r.lag - at)).toBeLessThan(0.05);
			expect(r.ncc).toBeGreaterThan(0.9);
		}
	});

	it('only looks inside the lag range; null without a fit or energy', () => {
		const ref = click();
		const sig = new Float32Array(10_000);
		for (let i = 0; i < ref.length; i++) sig[4000 + i] = ref[i]!;
		const r = locateByCorrelation(ref, sig, 0, 1000)!;
		expect(r.lag).toBeLessThanOrEqual(1000);
		expect(r.ncc).toBeLessThan(0.5);
		expect(locateByCorrelation(ref, sig, 9000, 9500)).toBeNull();
		expect(locateByCorrelation(new Float32Array(100), sig, 0, 100)).toBeNull();
		expect(locateByCorrelation(ref, new Float32Array(100), 0, 100)).toBeNull();
	});

	it('never throws on hostile input', () => {
		fc.assert(
			fc.property(
				fc.array(fc.double(), { maxLength: 64 }),
				fc.array(fc.double(), { maxLength: 256 }),
				fc.double(),
				fc.double(),
				(a, b, lo, hi) => {
					const r = locateByCorrelation(Float32Array.from(a), Float32Array.from(b), lo, hi);
					if (r) {
						expect(Number.isFinite(r.lag)).toBe(true);
						expect(Number.isFinite(r.ncc)).toBe(true);
					}
				},
			),
			{ numRuns: 300 },
		);
	});
});

describe('evaluateSfxGain', () => {
	const ev = (over: Partial<SolverEvent> & { clipId: string }): SolverEvent => ({
		soundId: `snd-${over.clipId}`,
		type: '',
		weight: 'support',
		startSec: 0,
		endSec: 0.5,
		soundBandsDb: [-40, -30, -20, -30, -40, -50, -60],
		soundPeakLu: -20,
		truePeakDb: -10,
		bedBandsDb: [-40, -40, -40, -40, -40, -40, -40],
		bedLocalPeakLu: -30,
		speechOverlap: false,
		baseGainDb: -20,
		...over,
	});

	it('agrees with the solver at the solved gains (lift, peak over bed, true peak, speech lift)', () => {
		const events = [
			ev({ clipId: 'a', weight: 'hero' }),
			ev({ clipId: 'b', speechOverlap: true, startSec: 3, endSec: 3.2 }),
			ev({ clipId: 'c', weight: 'ambient', bedLocalPeakLu: null, startSec: 6, endSec: 7 }),
		];
		const solved = solveSfxGains(events, { programLufs: -16 });
		for (const [i, r] of solved.events.entries()) {
			const e = evaluateSfxGain(events[i]!, r.gainDb, { programLufs: -16 });
			expect(e.liftDb).toBe(r.achievedLiftDb);
			expect(e.peakOverBedLu).toBe(r.peakOverBedLu);
			expect(e.truePeakDb).toBe(r.truePeakDb);
			expect(e.speechBandLiftDb).toBe(r.speechBandLiftDb);
			expect(e.dominantBands).toEqual(r.dominantBands);
			expect(e.targetLiftDb).toBe(r.targetLiftDb);
		}
	});

	it('lift follows the gain dB for dB; a silent sound has no lift; never throws', () => {
		const e0 = evaluateSfxGain(ev({ clipId: 'x' }), -20);
		const e1 = evaluateSfxGain(ev({ clipId: 'x' }), -17);
		expect(e1.liftDb! - e0.liftDb!).toBeCloseTo(3, 6);
		expect(evaluateSfxGain(ev({ clipId: 's', soundBandsDb: [] }), 0).liftDb).toBeNull();
		fc.assert(
			fc.property(fc.anything(), fc.anything(), (a, g) => {
				const r = evaluateSfxGain(a as SolverEvent, g as number);
				expect(Number.isFinite(r.gainDb)).toBe(true);
			}),
			{ numRuns: 300 },
		);
	});
});
