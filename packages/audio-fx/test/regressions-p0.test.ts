// Regression tests of the sound-design Phase 0 audit (WP0.2, docs/wp-notes/sound-design.md): each failed before its
// fix. Effects hosted by the offline mixer, dynamics ordering, filter designs, multichannel inserts.
import type { EffectInstance } from '@jasper/project/audio';
import { describe, expect, it } from 'vitest';
import { EffectSlot } from '../src/host.ts';
import { createProcessor } from '../src/registry.ts';

const SR = 48000;
const FPS = 705_600_000 / SR;
const ease = { influence: 0.333, slope: 0 };
const kf = (id: string, time: number, value: number) => ({
	id,
	time,
	value,
	interpolation: 'linear' as const,
	easeIn: ease,
	easeOut: ease,
});
const db = (x: number) => 20 * Math.log10(Math.abs(x));

function amplify(leftGain: EffectInstance['params'][string]): EffectInstance {
	return {
		id: 'fx1',
		effectId: 'jasper.audio.amplify',
		effectVersion: 1,
		enabled: true,
		params: {
			leftGain,
			rightGain: { value: 0, keyframes: [] },
			link: { value: false, keyframes: [] },
		},
	} as EffectInstance;
}

function runSlot(effect: EffectInstance, n = 2400): Float32Array {
	const slot = new EffectSlot(effect, SR, 2);
	const l = new Float32Array(n).fill(1);
	const r = new Float32Array(n).fill(1);
	slot.process([l, r], n, { sampleRate: SR, time: 0, flicksPerSample: FPS });
	return l;
}

describe('hosted effects start at their parameter values (no glide from the defaults)', () => {
	it('a static parameter applies from the first sample of a new slot', () => {
		const l = runSlot(amplify({ value: -40, keyframes: [] }));
		for (const i of [0, 1, 100, 480, 2000]) expect(db(l[i]!), `sample ${i}`).toBeCloseTo(-40, 2);
	});

	it('a keyframed parameter applies from the first sample, and after a reset', () => {
		const effect = amplify({ value: 0, keyframes: [kf('a', 0, -40), kf('b', 1e12, -40)] });
		const l = runSlot(effect);
		for (const i of [0, 1, 100, 480, 2000]) expect(db(l[i]!), `sample ${i}`).toBeCloseTo(-40, 2);
		const slot = new EffectSlot(effect, SR, 2);
		const a = [new Float32Array(1200).fill(1), new Float32Array(1200).fill(1)];
		slot.process(a, 1200, { sampleRate: SR, time: 0, flicksPerSample: FPS });
		slot.reset();
		const b = [new Float32Array(10).fill(1), new Float32Array(10).fill(1)];
		slot.process(b, 10, { sampleRate: SR, time: 0, flicksPerSample: FPS });
		expect(db(b[0]![0]!)).toBeCloseTo(-40, 2);
	});
});

const sine = (n: number, hz: number, amp: number, sr = SR) =>
	Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
const peakDb = (x: Float32Array, from = 0, to = x.length) => {
	let p = 0;
	for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]!));
	return 20 * Math.log10(p);
};

describe('Dynamics: compressor make-up sits before the limiter', () => {
	const run = (makeup: number, auto = false) => {
		const fx = createProcessor('jasper.audio.dynamics', SR, 2)!;
		fx.setParam('compOn', true);
		fx.setParam('compThreshold', -20);
		fx.setParam('compRatio', 4);
		fx.setParam('compMakeup', makeup);
		fx.setParam('compAuto', auto);
		fx.setParam('limOn', true);
		fx.setParam('limThreshold', -6);
		fx.reset();
		const l = sine(SR, 440, 0.9);
		const r = sine(SR, 440, 0.9);
		fx.process([l, r], 0, SR);
		return peakDb(l, SR / 2);
	};

	it('make-up gain cannot push the output over the limiter threshold', () => {
		expect(run(0)).toBeLessThanOrEqual(-6 + 1e-6);
		expect(run(12)).toBeLessThanOrEqual(-6 + 1e-6);
		expect(run(0, true)).toBeLessThanOrEqual(-6 + 1e-6);
		expect(run(12)).toBeGreaterThan(-6.5);
	});
});

describe('Scientific Filter', () => {
	const rmsDb = (x: Float32Array, from: number) => {
		let s = 0;
		for (let i = from; i < x.length; i++) s += x[i]! * x[i]!;
		return 10 * Math.log10(s / (x.length - from));
	};
	// [rate, params, test tone]: steep / narrow designs whose first-section gain used to underflow to silence.
	const cases: [number, Record<string, number>, number][] = [
		[48000, { type: 1, mode: 0, order: 12, cutoff: 20 }, 10],
		[96000, { type: 0, mode: 0, order: 12, cutoff: 20 }, 5],
		[48000, { type: 1, mode: 2, order: 12, cutoff: 1000, highCutoff: 1010 }, 1000],
		[48000, { type: 1, mode: 2, order: 12, cutoff: 1000, highCutoff: 1100 }, 1050],
		[48000, { type: 3, mode: 1, order: 12, cutoff: 5000, ripple: 1, stopAtten: 80 }, 12000],
	];
	for (const [sr, params, hz] of cases)
		it(`passes its pass band: ${sr} Hz ${JSON.stringify(params)} at ${hz} Hz`, () => {
			const fx = createProcessor('jasper.audio.scientific-filter', sr, 1)!;
			for (const [k, v] of Object.entries(params)) fx.setParam(k, v);
			fx.reset();
			const n = sr * 4;
			const x = sine(n, hz, 0.5, sr);
			fx.process([x], 0, n);
			const measured = rmsDb(x, n - sr) - 20 * Math.log10(0.5 / Math.SQRT2);
			expect(Math.abs(measured - fx.responseDb!(hz)!)).toBeLessThan(0.5);
		});

	it('sections that come back after an order change start from silence', () => {
		const fx = createProcessor('jasper.audio.scientific-filter', SR, 1)!;
		fx.setParam('order', 12);
		fx.reset();
		let seed = 1;
		const a = Float32Array.from({ length: SR / 2 }, () => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return (seed / 2 ** 31 - 0.5) * 1.8;
		});
		fx.process([a], 0, a.length);
		fx.setParam('order', 2);
		const b = new Float32Array(SR);
		fx.process([b], 0, b.length);
		fx.setParam('order', 12);
		const c = new Float32Array(SR / 2);
		fx.process([c], 0, c.length);
		expect(peakDb(c)).toBeLessThan(-120);
	});
});

describe('5.1 inserts process every channel', () => {
	const noiseOf = (n: number, amp: number, seed0: number) => {
		let seed = seed0;
		return Float32Array.from({ length: n }, () => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return (seed / 2 ** 31 - 0.5) * 2 * amp;
		});
	};
	const rms = (x: Float32Array, a = x.length / 2) => {
		let s = 0;
		for (let i = a; i < x.length; i++) s += x[i]! * x[i]!;
		return 10 * Math.log10(s / (x.length - a) + 1e-300);
	};
	const six = (n: number, amp = 0.3) => Array.from({ length: 6 }, (_, c) => noiseOf(n, amp, 7 + c));

	it('Surround Reverb: Dry 0 / Wet 0 silences all six channels; the centre feeds the reverb', () => {
		const fx = createProcessor('jasper.audio.surround-reverb', SR, 6)!;
		fx.setParam('dry', 0);
		fx.setParam('wet', 0);
		fx.reset();
		const ch = six(SR);
		fx.process(ch, 0, SR);
		for (const c of ch) expect(rms(c)).toBeLessThan(-200);
		const fx2 = createProcessor('jasper.audio.surround-reverb', SR, 6)!;
		fx2.setParam('dry', 0);
		fx2.setParam('wet', 100);
		fx2.reset();
		const ch2 = Array.from({ length: 6 }, () => new Float32Array(SR));
		ch2[2]!.set(noiseOf(SR, 0.3, 3));
		fx2.process(ch2, 0, SR);
		expect(rms(ch2[0]!)).toBeGreaterThan(-60);
	});

	it('Mastering: output gain and the maximiser apply to every channel', () => {
		const fx = createProcessor('jasper.audio.mastering', SR, 6)!;
		fx.setParam('output', -12);
		fx.reset();
		const ch = six(SR);
		const before = ch.map((c) => rms(c));
		fx.process(ch, 0, SR);
		ch.forEach((c, k) => expect(rms(c) - before[k]!, `channel ${k}`).toBeCloseTo(-12, 1));
		const fx2 = createProcessor('jasper.audio.mastering', SR, 6)!;
		fx2.setParam('loudness', 100);
		fx2.reset();
		const loud = six(SR, 0.9);
		fx2.process(loud, 0, SR);
		loud.forEach((c, k) => expect(peakDb(c), `channel ${k}`).toBeLessThanOrEqual(-0.3 + 1e-6));
	});

	it('Loudness Meter measures a 5.1 centre channel', () => {
		const fx = createProcessor('jasper.audio.loudness-meter', SR, 6)!;
		const ch = Array.from({ length: 6 }, () => new Float32Array(SR * 2));
		ch[2]!.set(sine(SR * 2, 1000, 0.3));
		fx.process(ch, 0, SR * 2);
		const [, , integrated] = fx.meters!();
		expect(Number.isFinite(integrated)).toBe(true);
		expect(integrated!).toBeGreaterThan(-20);
	});

	it('Loudness Auto Gain weights channels like BS.1770 (LFE ignored, surrounds +1.5 dB)', () => {
		const gainWith = (c: number) => {
			const fx = createProcessor('jasper.audio.auto-gain', SR, 6)!;
			fx.setParam('response', 100);
			fx.reset();
			const n = SR * 10;
			const ch = Array.from({ length: 6 }, () => new Float32Array(n));
			ch[c]!.set(noiseOf(n, 0.05, 11));
			for (let a = 0; a < n; a += 4800) fx.process(ch, a, Math.min(n, a + 4800));
			return fx.meters!()[0]!;
		};
		const l = gainWith(0);
		expect(gainWith(3)).toBe(0); // LFE only: below the silence threshold, the gain holds
		expect(l - gainWith(4)).toBeCloseTo(1.5, 0);
	});
});
