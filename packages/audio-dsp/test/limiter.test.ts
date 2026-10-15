import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { limitBuffer, TruePeakDetector, TruePeakLimiter } from '../src/index.ts';
import { dbfs, Rng, sine } from './util.ts';

const TOL_DB = 0.05;

function truePeakDb(x: Float32Array[], sr: number): number {
	const d = new TruePeakDetector(sr, x.length);
	d.process(x);
	return d.truePeakDb();
}

function adversarial(sr: number): Record<string, Float32Array[]> {
	const n = sr;
	const r = new Rng(77);
	const sq = new Float32Array(n).map((_, i) => (Math.floor(i / 37) % 2 ? 1 : -1));
	const sqNyq = new Float32Array(n).map((_, i) => (Math.floor(i / 2) % 2 ? 1 : -1));
	const isp = new Float32Array(n).map((_, i) => 4 * Math.sin((Math.PI / 2) * i + Math.PI / 4));
	const clipped = new Float32Array(n).map(() => Math.max(-1, Math.min(1, 3 * r.uniform())));
	const transient = new Float32Array(n).map(
		(_, i) => 0.891 * Math.sin((2 * Math.PI * 1000 * i) / sr) + (i % 9000 > 8990 ? 20 * r.uniform() : 0),
	);
	const levels = [0.5, 30, 0.9, 100, 1, 0.01, 50];
	const steps = new Float32Array(n).map(
		(_, i) => levels[Math.floor(i / 700) % 7] * (i % 2 ? 1 : -1) * (i % 3 ? 1 : 0.3),
	);
	const nyqBurst = new Float32Array(n).map(
		(_, i) => (i % 1000 < 300 ? 50 : 0.89) * Math.sin(Math.PI * 0.97 * i + 0.3),
	);
	const impulse = new Float32Array(n);
	impulse[n / 2] = 8;
	impulse[n / 2 + 1] = -8;
	return {
		'full-scale square': [sq, sq.slice()],
		'square at fs/4': [sqNyq],
		'fs/4 sine at 45° (+12 dB)': [isp],
		'clipped noise': [clipped],
		'sudden transients over a ceiling-level sine': [transient],
		'level steps': [steps],
		'near-Nyquist bursts': [nyqBurst],
		'isolated doublet': [impulse],
		'linked stereo, loud left only': [sq.map((v) => v * 4), new Float32Array(n).fill(0.1)],
	};
}

describe('TruePeakLimiter', () => {
	it('keeps the output true peak ≤ ceiling + 0.05 dB on adversarial inputs (1.5 ms and 5 ms look-ahead)', () => {
		for (const sr of [48000, 44100, 96000]) {
			for (const lookaheadMs of [1.5, 5]) {
				for (const [name, x] of Object.entries(adversarial(sr))) {
					const y = limitBuffer(x, sr, { ceilingDb: -1, lookaheadMs });
					const tp = truePeakDb(y, sr);
					expect(tp, `${name} @ ${sr} Hz, ${lookaheadMs} ms: ${tp}`).toBeLessThanOrEqual(-1 + TOL_DB);
				}
			}
		}
	});

	it('limits steady loud material to the ceiling (not far below)', () => {
		const sr = 48000;
		const x = [sine(200, 1, sr, sr)];
		const y = limitBuffer(x, sr, { ceilingDb: -6 });
		const tail = [y[0].subarray(sr / 2)];
		expect(Math.abs(truePeakDb(tail, sr) + 6)).toBeLessThan(0.05);
	});

	it('is transparent below the ceiling, with the reported latency', () => {
		const sr = 48000;
		const lim = new TruePeakLimiter(sr, 1, { ceilingDb: -1, lookaheadMs: 2 });
		const x = sine(1000, 0.3, sr, 4800);
		const y = x.slice();
		lim.process([y]);
		for (let i = lim.latency; i < 4800; i++) expect(y[i]).toBe(x[i - lim.latency]);
		const tail = new Float32Array(lim.latency);
		lim.flush([tail]);
		for (let i = 0; i < lim.latency; i++) expect(tail[i]).toBe(x[4800 - lim.latency + i]);
		expect(lim.gainReductionDb()).toBe(0);
	});

	it('limitBuffer is time aligned, same length, input untouched', () => {
		const sr = 48000;
		const x = sine(440, 0.5, sr, 1000);
		const copy = x.slice();
		const [y] = limitBuffer([x], sr, { ceilingDb: 0 });
		expect(y.length).toBe(1000);
		expect(x).toEqual(copy);
		for (let i = 0; i < 1000; i++) expect(y[i]).toBe(x[i]);
		expect(limitBuffer([], sr, { ceilingDb: 0 })).toEqual([]);
	});

	it('attack is smooth (no gain step) and release recovers', () => {
		const sr = 48000;
		const n = sr;
		const x = new Float32Array(n).map((_, i) => (i >= 24000 && i < 24480 ? 4 : 0.25) * Math.sin(i * 0.05));
		const lim = new TruePeakLimiter(sr, 1, { ceilingDb: -1, lookaheadMs: 5, releaseMs: 50 });
		const gains: number[] = [];
		const one = new Float32Array(1);
		for (let i = 0; i < n; i++) {
			one[0] = x[i];
			lim.process([one]);
			gains.push(lim.gainReductionDb());
		}
		// linear ramp over the look-ahead: no single-sample jump bigger than the full drop / look-ahead
		const lin = gains.map((g) => 10 ** (g / 20));
		let maxStep = 0;
		for (let i = 1; i < n; i++) maxStep = Math.max(maxStep, lin[i - 1] - lin[i]);
		const fullDrop = 1 - Math.min(...lin);
		expect(fullDrop).toBeGreaterThan(0.7);
		expect(maxStep).toBeLessThanOrEqual(fullDrop / 240 + 1e-9);
		expect(gains[24480 + lim.latency + 0.3 * sr]).toBeGreaterThan(-0.05);
	});

	it('block-size independent and reset restores the initial state', () => {
		const sr = 48000;
		const r = new Rng(4);
		const x = new Float32Array(9000).map((_, i) => (i % 3000 < 400 ? 3 : 0.5) * r.uniform());
		const a = x.slice();
		const la = new TruePeakLimiter(sr, 1, { ceilingDb: -2 });
		la.process([a]);
		const b = x.slice();
		const lb = new TruePeakLimiter(sr, 1, { ceilingDb: -2 });
		for (let pos = 0; pos < b.length; ) {
			const len = Math.min(b.length - pos, r.nextU32() % 700);
			lb.process([b], pos, len);
			pos += len;
		}
		expect(b).toEqual(a);
		la.reset();
		const c = x.slice();
		la.process([c]);
		expect(c).toEqual(a);
	});

	it('property: random signals never exceed the ceiling + 0.05 dB', () => {
		const sr = 48000;
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 2 ** 31 - 1 }),
				fc.double({ min: -12, max: 0, noNaN: true }),
				fc.constantFrom(1.5, 3, 5),
				(seed, ceilingDb, lookaheadMs) => {
					const r = new Rng(seed);
					const n = 3000;
					const ch = [new Float32Array(n), new Float32Array(n)];
					let lvl = 1;
					for (let i = 0; i < n; i++) {
						if (r.uniform() > 0.99) lvl = dbfs(40 * r.uniform());
						ch[0][i] = lvl * r.uniform();
						ch[1][i] = (i % 2 ? 1 : -1) * lvl * Math.abs(r.uniform()) ** 0.2;
					}
					const y = limitBuffer(ch, sr, { ceilingDb, lookaheadMs });
					return truePeakDb(y, sr) <= ceilingDb + TOL_DB;
				},
			),
			{ numRuns: 40 },
		);
	});
});
