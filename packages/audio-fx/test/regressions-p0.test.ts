// Regression tests of the sound-design Phase 0 audit (WP0.2, docs/wp-notes/sound-design.md): each failed before its
// fix. Effects hosted by the offline mixer, dynamics ordering, filter designs, multichannel inserts.
import type { EffectInstance } from '@jasper/project/audio';
import { describe, expect, it } from 'vitest';
import { EffectSlot } from '../src/host.ts';

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
