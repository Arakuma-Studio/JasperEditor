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
