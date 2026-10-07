import { describe, expect, it } from 'vitest';
import { dbToLin, faderDbToGain, LevelMeter, linToDb, MeterBallistics } from '../src/index.ts';
import { Rng, sine } from './util.ts';

describe('display helpers', () => {
	it('linToDb / dbToLin / faderDbToGain', () => {
		expect(linToDb(1)).toBe(0);
		expect(linToDb(0)).toBe(Number.NEGATIVE_INFINITY);
		expect(linToDb(0, -120)).toBe(-120);
		expect(linToDb(1e-9, -120)).toBe(-120);
		expect(linToDb(-0.5)).toBeCloseTo(-6.0206, 4);
		expect(dbToLin(-6.0206)).toBeCloseTo(0.5, 4);
		expect(dbToLin(Number.NEGATIVE_INFINITY)).toBe(0);
		expect(dbToLin(-120)).toBeCloseTo(1e-6, 12);
		expect(faderDbToGain(-96)).toBe(0);
		expect(faderDbToGain(-200)).toBe(0);
		expect(faderDbToGain(-95.9)).toBeGreaterThan(0);
		expect(faderDbToGain(0)).toBe(1);
		expect(faderDbToGain(6)).toBeCloseTo(1.9953, 4);
	});
});

describe('LevelMeter', () => {
	it('reports peak, windowed RMS and clipping per channel since the last take', () => {
		const sr = 48000;
		const m = new LevelMeter(sr, 2);
		expect(m.windowSamples).toBe(14400);
		const a = sine(1000, 0.5, sr, sr);
		const b = new Float32Array(sr);
		b[100] = -1;
		m.process([a, b]);
		const r = m.take();
		expect(r.peak[0]).toBeCloseTo(0.5, 4);
		expect(r.rms[0]).toBeCloseTo(0.5 / Math.SQRT2, 4);
		expect(r.peak[1]).toBe(1);
		expect(r.clipped[0]).toBe(0);
		expect(r.clipped[1]).toBe(1);
		// next period: quiet, clip flag and peak cleared; RMS window keeps running
		m.process([new Float32Array(480), new Float32Array(480)]);
		const r2 = m.take();
		expect(r2).toBe(r); // reused object
		expect(r2.peak[0]).toBe(0);
		expect(r2.clipped[1]).toBe(0);
		expect(r2.rms[0]).toBeGreaterThan(0.3); // window still mostly full of the sine
		m.process([new Float32Array(sr), new Float32Array(sr)]);
		expect(m.take().rms[0]).toBeGreaterThan(0.3); // the window max since the last take still saw the sine
		m.process([new Float32Array(10), new Float32Array(10)]);
		expect(m.take().rms[0]).toBeLessThan(1e-6); // window now only holds silence
	});

	it('RMS is the max of the running window, block-size independent, and drift-free', () => {
		const sr = 8000;
		const r = new Rng(5);
		const x = new Float32Array(sr * 30).map(() => 0.3 * r.uniform());
		const a = new LevelMeter(sr, 1, { rmsWindowMs: 100 });
		const b = new LevelMeter(sr, 1, { rmsWindowMs: 100 });
		a.process([x]);
		for (let pos = 0; pos < x.length; ) {
			const len = Math.min(x.length - pos, 1 + (r.nextU32() % 997));
			b.process([x], pos, len);
			pos += len;
		}
		const ra = a.take();
		const rb = b.take();
		expect(rb.peak[0]).toBe(ra.peak[0]);
		expect(Math.abs(rb.rms[0] - ra.rms[0])).toBeLessThan(1e-6);
		// exact RMS of the last window after many re-sums
		let s = 0;
		for (let i = x.length - 800; i < x.length; i++) s += x[i] * x[i];
		a.process([new Float32Array(0)]);
		a.take();
		const exact = Math.sqrt(s / 800);
		expect(Math.abs(a.take().rms[0] - exact)).toBeLessThan(1e-6);
	});

	it('missing channels read silence; reset clears', () => {
		const m = new LevelMeter(48000, 2);
		m.process([sine(100, 1, 48000, 4800)]);
		const r = m.take();
		expect(r.peak[1]).toBe(0);
		expect(r.rms[1]).toBe(0);
		m.reset();
		expect(m.take().rms[0]).toBe(0);
	});
});

describe('MeterBallistics', () => {
	it('instant attack, linear dB release, peak hold then fall', () => {
		const b = new MeterBallistics({ releaseDbPerSec: 20, holdMs: 1000 });
		let o = b.update(-10, 0);
		expect(o.displayDb).toBe(-10);
		expect(o.holdDb).toBe(-10);
		o = b.update(-60, 500);
		expect(o.displayDb).toBeCloseTo(-20, 9);
		expect(o.holdDb).toBe(-10);
		o = b.update(-60, 1000);
		expect(o.displayDb).toBeCloseTo(-30, 9);
		expect(o.holdDb).toBeCloseTo(-30, 9); // hold expired → rides with the bar
		o = b.update(-60, 3000);
		expect(o.displayDb).toBe(-60); // never below the input level
		o = b.update(-3, 3010);
		expect(o.displayDb).toBe(-3);
		expect(o.holdDb).toBe(-3);
		o = b.update(Number.NEGATIVE_INFINITY, 3510);
		expect(o.displayDb).toBeCloseTo(-13, 9);
		expect(o.holdDb).toBe(-3);
		b.reset();
		expect(b.update(-40, 0).displayDb).toBe(-40);
	});
});
