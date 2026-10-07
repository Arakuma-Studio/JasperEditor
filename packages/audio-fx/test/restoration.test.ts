// Restoration: DeHummer notch depth, DeNoise (adaptive and learned print), DeEsser, DeReverb, click removal,
// Enhance Speech, latency = measured delay, determinism.
import { describe, expect, it } from 'vitest';
import { Biquad, designBiquad } from '../src/core/biquad.ts';
import { Prng } from '../src/core/util.ts';
import { createProcessor } from '../src/registry.ts';
import { db, noise, rms, SR, sine, toneAmplitude } from './util.ts';

function fx(id: string, params: Record<string, number | boolean | string> = {}, ch = 1) {
	const e = createProcessor(`jasper.audio.${id}`, SR, ch)!;
	for (const [k, v] of Object.entries(params)) expect(e.setParam(k, v), `${id}.${k}`).toBe(true);
	e.reset();
	return e;
}
const run1 = (e: ReturnType<typeof fx>, x: Float32Array) => {
	const y = x.slice();
	e.process([y], 0, y.length);
	return y;
};
const add = (...xs: Float32Array[]) => {
	const out = new Float32Array(xs[0]!.length);
	for (const x of xs) for (let i = 0; i < out.length; i++) out[i] = out[i]! + x[i]!;
	return out;
};

describe('DeHummer', () => {
	for (const f0 of [50, 60] as const)
		it(`notches ${f0} Hz and every enabled harmonic by ≥ 30 dB, keeps a 1 kHz tone within 0.5 dB`, () => {
			const d = fx('dehummer', { frequency: String(f0), harmonics: 5 });
			const n = SR * 2;
			const parts = [1, 2, 3, 4, 5].map((k) => sine(f0 * k, 0.1, SR, n, 0.3 * k));
			const prog = sine(1000, 0.2, SR, n);
			const y = run1(d, add(...parts, prog));
			for (let k = 1; k <= 5; k++)
				expect(db(toneAmplitude(y, f0 * k, SR, n / 2, n) / 0.1), `${f0}×${k}`).toBeLessThan(-30);
			expect(Math.abs(db(toneAmplitude(y, 1000, SR, n / 2, n) / 0.2))).toBeLessThan(0.5);
			expect(d.responseDb!(f0)).toBeLessThan(-30);
			expect(Math.abs(d.responseDb!(1000))).toBeLessThan(0.5);
		});

	it('60 Hz mode leaves 50 Hz mostly alone; Output Hum Only outputs the removed hum', () => {
		const n = SR * 2;
		const y = run1(fx('dehummer', { frequency: '60' }), sine(50, 0.2, SR, n));
		expect(db(toneAmplitude(y, 50, SR, n / 2, n) / 0.2)).toBeGreaterThan(-3);
		const hum = sine(60, 0.2, SR, n);
		const prog = sine(1000, 0.2, SR, n);
		const z = run1(fx('dehummer', { frequency: '60', humOnly: true }), add(hum, prog));
		expect(Math.abs(db(toneAmplitude(z, 60, SR, n / 2, n) / 0.2))).toBeLessThan(0.5);
		expect(db(toneAmplitude(z, 1000, SR, n / 2, n) / 0.2)).toBeLessThan(-20);
	});
});

describe('DeNoise', () => {
	it('zero reduction is a pure delay of exactly latency() samples', () => {
		const d = fx('denoise', { reduction: 0 });
		const lat = d.latency();
		const x = noise(9, 20000, 0.5);
		const y = run1(d, x);
		for (let i = lat; i < x.length; i++) expect(Math.abs(y[i]! - x[i - lat]!)).toBeLessThan(1e-4);
	});

	for (const model of ['adaptive', 'print'] as const)
		it(`reduces stationary noise and keeps a tone within 1 dB (${model})`, () => {
			const n = SR * 8;
			const nz = noise(21, n, 0.02);
			const tone = sine(1000, 0.3, SR, n);
			const half = SR / 2;
			const on = (i: number) => Math.floor(i / half) % 2 === 1;
			const x = new Float32Array(n);
			for (let i = 0; i < n; i++) x[i] = nz[i]! + (on(i) && i >= SR ? tone[i]! : 0);
			const d = fx('denoise', { reduction: 20 });
			const lat = d.latency();
			const y = x.slice();
			if (model === 'print') {
				// Learn over the first (noise-only) second, then gate against the print.
				d.setParam('noiseModel', 'learn');
				d.process([y], 0, SR);
				d.setParam('noiseModel', 'print');
				d.process([y], SR, n);
			} else d.process([y], 0, n);
			const seg = (k: number) => [k * half + lat + half / 4, k * half + lat + (3 * half) / 4] as const;
			const [o0, o1] = seg(14);
			const red = db(rms(y, o0, o1) / rms(x, o0 - lat, o1 - lat));
			expect(red, 'noise reduction').toBeLessThan(-10);
			const [t0, t1] = seg(15);
			expect(Math.abs(db(toneAmplitude(y, 1000, SR, t0, t1) / 0.3))).toBeLessThan(1);
		});

	it('learned print gates from the first frame after learning (no adaptation delay)', () => {
		const n = SR * 3;
		const x = noise(4, n, 0.05);
		const d = fx('denoise', { reduction: 24, noiseModel: 'learn' });
		const y = x.slice();
		d.process([y], 0, SR);
		d.setParam('noiseModel', 'print');
		d.process([y], SR, n);
		const lat = d.latency();
		// Within 0.25 s of switching the noise is already well down.
		expect(db(rms(y, SR + lat + 6000, SR + lat + 12000) / rms(x, SR + 6000, SR + 12000))).toBeLessThan(-12);
	});
});

describe('DeEsser', () => {
	const bandNoise = (seed: number, n: number, lo: number, hi: number, amp: number) => {
		const fc = Math.sqrt(lo * hi);
		const c = designBiquad('bandPass', SR, fc, fc / (hi - lo), 0);
		const a = new Biquad();
		const b = new Biquad();
		const r = new Prng(seed);
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) out[i] = amp * b.tick(c, a.tick(c, r.uniform()));
		return out;
	};
	it('cuts a sibilant band by ≥ 6 dB and leaves a 300 Hz tone within 0.5 dB', () => {
		const n = SR * 2;
		const sib = bandNoise(11, n, 5000, 10000, 0.6);
		const tone = sine(300, 0.3, SR, n);
		const d = fx('deesser', { frequency: 5000, threshold: -20, reduction: 12 });
		const y = run1(d, add(sib, tone));
		const yS = run1(fx('deesser', { frequency: 5000, threshold: -20, reduction: 12 }), sib);
		expect(db(rms(yS, n / 2, n) / rms(sib, n / 2, n))).toBeLessThan(-6);
		const t = run1(fx('deesser'), tone);
		expect(Math.abs(db(toneAmplitude(t, 300, SR, n / 2, n) / 0.3))).toBeLessThan(0.5);
		expect(d.meters!()[0]!).toBeLessThan(0);
		expect(Number.isFinite(y[n - 1]!)).toBe(true);
	});
});

describe('DeReverb, click remover, Enhance Speech', () => {
	it('DeReverb at 0 % is a delay; at 100 % it shortens a decaying tail', () => {
		const d0 = fx('dereverb', { amount: 0 });
		const lat = d0.latency();
		const x = noise(2, 12000, 0.3);
		const y0 = run1(d0, x);
		for (let i = lat; i < x.length; i++) expect(Math.abs(y0[i]! - x[i - lat]!)).toBeLessThan(1e-4);
		// Noise bursts with an exponential (RT60 = 1 s) tail.
		const n = SR * 4;
		const r = new Prng(5);
		const tail = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const t = (i % SR) / SR;
			tail[i] = r.uniform() * (t < 0.1 ? 0.5 : 0.5 * 10 ** ((-3 * (t - 0.1)) / 1));
		}
		const d = fx('dereverb', { amount: 100, rt60: 1 });
		const y = run1(d, tail);
		const L = d.latency();
		const tailIn = rms(tail, 3 * SR + 0.4 * SR, 3 * SR + 0.8 * SR);
		const tailOut = rms(y, 3 * SR + 0.4 * SR + L, 3 * SR + 0.8 * SR + L);
		expect(db(tailOut / tailIn)).toBeLessThan(-3);
	});

	it('Automatic Click Remover removes impulses (≥ 20 dB) and leaves clean audio alone', () => {
		const n = SR;
		const base = add(sine(440, 0.3, SR, n), sine(1320, 0.1, SR, n, 1));
		const clicked = base.slice();
		for (let i = 2000; i < n - 2000; i += 3001) clicked[i] = clicked[i]! + (i % 2 ? 0.8 : -0.8);
		const c = fx('click-remover');
		const lat = c.latency();
		const y = run1(c, clicked);
		let errIn = 0;
		let errOut = 0;
		for (let i = 2000 + lat; i < n; i++) {
			errIn = Math.max(errIn, Math.abs(clicked[i - lat]! - base[i - lat]!));
			errOut = Math.max(errOut, Math.abs(y[i]! - base[i - lat]!));
		}
		expect(db(errOut / errIn)).toBeLessThan(-20);
		const clean = run1(fx('click-remover'), base);
		let e = 0;
		for (let i = 2000 + lat; i < n; i++) e = Math.max(e, Math.abs(clean[i]! - base[i - lat]!));
		expect(db(e / 0.3)).toBeLessThan(-40);
	});

	it('Enhance Speech: mix 0 is identity, the EQ shapes a voice band, and noise between words is pushed down', () => {
		const x = noise(3, 9600, 0.2);
		const y0 = run1(fx('enhance-speech', { mix: 0 }), x);
		for (let i = 0; i < x.length; i++) expect(y0[i]).toBeCloseTo(x[i]!, 6);
		const n = SR * 2;
		const quiet = noise(8, n, 0.002);
		const y = run1(fx('enhance-speech'), quiet);
		expect(db(rms(y, n / 2, n) / rms(quiet, n / 2, n))).toBeLessThan(-6);
		const rumble = run1(fx('enhance-speech'), sine(30, 0.1, SR, n));
		expect(db(toneAmplitude(rumble, 30, SR, n / 2, n) / 0.1)).toBeLessThan(-6);
	});

	it('is deterministic and reports constant latency', () => {
		for (const id of ['dehummer', 'denoise', 'deesser', 'dereverb', 'click-remover', 'enhance-speech']) {
			const a = noise(3, 9600, 0.5);
			const b = a.slice();
			const e1 = fx(id, {}, 2);
			const e2 = fx(id, {}, 2);
			e1.process([a, a.slice()], 0, a.length);
			e2.process([b, b.slice()], 0, b.length);
			expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer)), id).toBe(true);
			expect(e1.latency()).toBe(e2.latency());
		}
	});

	it('spectral effects run faster than 8× realtime (stereo, 10 s)', () => {
		for (const id of ['denoise', 'dereverb']) {
			const e = fx(id, {}, 2);
			const l = noise(1, SR * 10, 0.3);
			const r = noise(2, SR * 10, 0.3);
			const t0 = performance.now();
			e.process([l, r], 0, l.length);
			expect(performance.now() - t0, id).toBeLessThan(1250);
		}
	});
});
