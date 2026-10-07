// Channel utilities and stereo imagery (ports of filmcraft `channel.rs` / `premiere_tests.rs` tests plus analytic
// checks of the pan laws and the Mono Maker crossover).

import { balanceGains, panMonoGains as constantPowerPan } from '@jasper/audio-dsp';
import { describe, expect, it } from 'vitest';
import { magnitudeDb } from '../src/core/biquad.ts';
import { dbToGain } from '../src/core/math.ts';
import { AmbisonicsPanner } from '../src/effects/stereo-channel.ts';
import { createProcessor } from '../src/registry.ts';
import { noise, peak, rms, SR, sine, toneAmplitude } from './util.ts';

function fx(id: string, params: Record<string, number | boolean | string> = {}) {
	const e = createProcessor(`jasper.audio.${id}`, SR, 2)!;
	for (const [k, v] of Object.entries(params)) expect(e.setParam(k, v), `${id}.${k}`).toBe(true);
	e.reset();
	return e;
}
function run(e: ReturnType<typeof fx>, l: Float32Array, r: Float32Array) {
	const a = l.slice();
	const b = r.slice();
	e.process([a, b], 0, a.length);
	return [a, b] as const;
}

describe('pan laws (audio-dsp, used by Balance)', () => {
	it('constant-power pan sums power to 1; balance is cosine', () => {
		for (let i = -10; i <= 10; i++) {
			const [l, r] = constantPowerPan(i / 10);
			expect(l * l + r * r).toBeCloseTo(1, 12);
		}
		expect(constantPowerPan(0)[0]).toBeCloseTo(Math.SQRT1_2, 12);
		expect(balanceGains(0)).toEqual([1, 1]);
		expect(balanceGains(1)[0]).toBeCloseTo(0, 12);
		expect(balanceGains(1)[1]).toBe(1);
		expect(balanceGains(0.5)[0]).toBeCloseTo(Math.cos(Math.PI / 4), 12);
	});
});

describe('channel utilities', () => {
	it('Amplify reaches exact gains, smoothed, linked or not; −96 dB is silence', () => {
		const a = fx('amplify');
		a.setParam('leftGain', -6);
		const l = new Float32Array(2000).fill(1);
		const r = new Float32Array(2000).fill(0.5);
		a.process([l, r], 0, 2000);
		expect(l[1999]).toBeCloseTo(dbToGain(-6), 6);
		expect(r[1999]).toBeCloseTo(0.5 * dbToGain(-6), 6);
		expect(l[0]!).toBeGreaterThan(0.99);
		const b = fx('amplify', { link: false, leftGain: 6, rightGain: -12 });
		const [x, y] = run(b, new Float32Array(10).fill(0.1), new Float32Array(10).fill(0.1));
		expect(x[5]).toBeCloseTo(0.1 * dbToGain(6), 6);
		expect(y[5]).toBeCloseTo(0.1 * dbToGain(-12), 6);
		a.setParam('leftGain', -96);
		l.fill(1);
		a.process([l, r], 0, 2000);
		expect(l[1999]).toBe(0);
	});

	it('Channel Volume per channel', () => {
		const c = fx('channel-volume', { right: -20 });
		const [l, r] = run(c, new Float32Array(10).fill(1), new Float32Array(10).fill(1));
		expect(l[5]).toBe(1);
		expect(r[5]).toBeCloseTo(0.1, 6);
	});

	it('Balance and Pan modes', () => {
		const b = fx('balance', { mode: 'pan', balance: 100 });
		const [l, r] = run(b, new Float32Array(4).fill(0.5), new Float32Array(4).fill(0.5));
		expect(Math.abs(l[3]!)).toBeLessThan(1e-6);
		expect(r[3]).toBeCloseTo(0.5 * Math.SQRT2, 6);
		for (const p of [-100, -50, 0, 50, 100]) {
			const e = fx('balance', { balance: p });
			const [x, y] = run(e, new Float32Array(4).fill(1), new Float32Array(4).fill(1));
			const [gl, gr] = balanceGains(p / 100);
			expect(x[3]).toBeCloseTo(gl, 6);
			expect(y[3]).toBeCloseTo(gr, 6);
		}
	});

	it('Invert, Swap and Fill route exactly', () => {
		const l = new Float32Array([1, 2]);
		const r = new Float32Array([3, 4]);
		fx('swap-channels').process([l, r], 0, 2);
		expect([...l, ...r]).toEqual([3, 4, 1, 2]);
		fx('fill-left-with-right').process([l, r], 0, 2);
		expect([...l]).toEqual([1, 2]);
		l[0] = 9;
		fx('fill-right-with-left').process([l, r], 0, 2);
		expect([...r]).toEqual([9, 2]);
		fx('invert', { channels: 'right' }).process([l, r], 0, 2);
		expect([...l, ...r]).toEqual([9, 2, -9, -2]);
		fx('invert').process([l, r], 0, 2);
		expect([...l, ...r]).toEqual([-9, -2, 9, 2]);
	});

	it('Channel Mixer matrix and Stereo Expander mid/side', () => {
		const n = 4800;
		const l = noise(10, n, 0.3);
		const r = noise(11, n, 0.3);
		const sw = fx('channel-mixer', {
			leftFromLeft: 0,
			leftFromRight: 100,
			rightFromLeft: 100,
			rightFromRight: 0,
			invertRight: true,
		});
		const [a, b] = run(sw, l, r);
		for (let i = 0; i < n; i++) {
			expect(Math.abs(a[i]! - r[i]!)).toBeLessThan(1e-6);
			expect(Math.abs(b[i]! + l[i]!)).toBeLessThan(1e-6);
		}
		const [m1, m2] = run(fx('stereo-expander', { expand: 0 }), l, r);
		for (let i = 0; i < n; i++) expect(Math.abs(m1[i]! - m2[i]!)).toBeLessThan(1e-6);
		const [w1, w2] = run(fx('stereo-expander', { expand: 200, centerPan: 100 }), l, l);
		for (let i = 0; i < n; i++) {
			expect(Math.abs(w1[i]!)).toBeLessThan(1e-6);
			expect(Math.abs(w2[i]! - l[i]!)).toBeLessThan(1e-6);
		}
		// Expander: mid unchanged, side scaled by the parameter.
		const [e1, e2] = run(fx('stereo-expander', { expand: 150 }), l, r);
		for (let i = 0; i < n; i++) {
			expect(e1[i]! + e2[i]!).toBeCloseTo(l[i]! + r[i]!, 5);
			expect(e1[i]! - e2[i]!).toBeCloseTo(1.5 * (l[i]! - r[i]!), 5);
		}
	});

	it('Stereo Width: 0 % is mono, 100 % identity, 200 % doubles the side; mono input stays mono', () => {
		const n = 2000;
		const l = noise(1, n, 0.3);
		const r = noise(2, n, 0.3);
		const [a, b] = run(fx('stereo-width', { width: 0 }), l, r);
		for (let i = 0; i < n; i++) expect(a[i]).toBeCloseTo(b[i]!, 6);
		const [c, d] = run(fx('stereo-width'), l, r);
		for (let i = 0; i < n; i++) {
			expect(c[i]).toBeCloseTo(l[i]!, 6);
			expect(d[i]).toBeCloseTo(r[i]!, 6);
		}
		const [e, f] = run(fx('stereo-width', { width: 200 }), l, r);
		for (let i = 0; i < n; i++) expect(e[i]! - f[i]!).toBeCloseTo(2 * (l[i]! - r[i]!), 5);
		const [g, h] = run(fx('stereo-width', { width: 200 }), l, l);
		for (let i = 0; i < n; i++) expect(g[i]).toBeCloseTo(h[i]!, 6);
	});
});

describe('Mono Maker', () => {
	it('full mode: L = R = (L + R)/2 at 100 %, identity at 0 %', () => {
		const n = 2000;
		const l = noise(3, n, 0.4);
		const r = noise(4, n, 0.4);
		const [a, b] = run(fx('mono-maker'), l, r);
		for (let i = 0; i < n; i++) {
			expect(a[i]).toBeCloseTo(0.5 * (l[i]! + r[i]!), 6);
			expect(b[i]).toBe(a[i]);
		}
		const [c] = run(fx('mono-maker', { amount: 0 }), l, r);
		for (let i = 0; i < n; i++) expect(c[i]).toBeCloseTo(l[i]!, 6);
	});

	it('below mode: the crossover sums flat; lows become mono, highs keep their stereo', () => {
		const n = SR;
		const e = fx('mono-maker', { mode: 'below', frequency: 200 });
		// A 50 Hz tone only on the left → shared equally (−6 dB each side); a 5 kHz tone on the left stays left.
		const low = sine(50, 0.5, SR, n);
		const [a, b] = run(e, low, new Float32Array(n));
		expect(toneAmplitude(a, 50, SR, n / 2, n)).toBeCloseTo(0.25, 2);
		expect(toneAmplitude(b, 50, SR, n / 2, n)).toBeCloseTo(0.25, 2);
		e.reset();
		const high = sine(5000, 0.5, SR, n);
		const [c, d] = run(e, high, new Float32Array(n));
		expect(toneAmplitude(c, 5000, SR, n / 2, n)).toBeCloseTo(0.5, 2);
		expect(toneAmplitude(d, 5000, SR, n / 2, n)).toBeLessThan(0.001);
		// Flat magnitude through the crossover region with amount 0 (all-pass).
		for (const f of [100, 200, 400, 1000]) {
			const z = fx('mono-maker', { mode: 'below', frequency: 200, amount: 0 });
			const x = sine(f, 0.5, SR, n);
			const [y] = run(z, x, x.slice());
			expect(Math.abs(20 * Math.log10(toneAmplitude(y, f, SR, n / 2, n) / 0.5))).toBeLessThan(0.05);
		}
		expect(magnitudeDb({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }, 1, SR)).toBe(0);
	});
});

describe('spatial', () => {
	it('Binauralizer: unity on correlated lows, interaural delay and head shadow', () => {
		const b = fx('binauralizer');
		const x = sine(100, 0.3, SR, SR);
		const [y] = run(b, x, x.slice());
		expect(Math.abs(20 * Math.log10(toneAmplitude(y, 100, SR, SR / 2, SR) / 0.3))).toBeLessThan(0.5);
		b.reset();
		const imp = new Float32Array(2000);
		imp[100] = 1;
		const [l, r] = run(b, imp, new Float32Array(2000));
		const pk = (s: Float32Array) => {
			let k = 0;
			for (let i = 0; i < s.length; i++) if (Math.abs(s[i]!) > Math.abs(s[k]!)) k = i;
			return k;
		};
		const itd = pk(r) - pk(l);
		const a = 0.0875;
		const th = Math.PI / 6;
		const want = (a / 343) * (th + Math.sin(th)) * SR;
		expect(Math.abs(itd - want)).toBeLessThanOrEqual(1.5);
		expect(Math.abs(l[pk(l)]!)).toBeGreaterThan(Math.abs(r[pk(r)]!));
	});

	it('Ambisonics panner: identity at rest, 180° pan puts the left source on the right', () => {
		const n = SR;
		const x = noise(13, n, 0.3);
		const [l0, r0] = run(fx('ambisonics-panner'), x, x.slice());
		for (let i = 0; i < 100; i++) {
			expect(l0[i]).toBeCloseTo(x[i]!, 6);
			expect(r0[i]).toBeCloseTo(x[i]!, 6);
		}
		const [l, r] = run(fx('ambisonics-panner', { pan: 180 }), x, new Float32Array(n));
		expect(rms(r)).toBeGreaterThan(3 * rms(l));
		expect(AmbisonicsPanner.sourceGains(30, 0, 0, 0)[0]).toBeCloseTo(1, 6);
		expect(peak(l)).toBeLessThan(1);
	});
});
