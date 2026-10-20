// The sound-design build (spec 12 §2.4 "Build", P4-R3; wp-note "Phase 4 → WP4.2a"): a 2nd-order Butterworth High Pass
// whose cutoff is keyframed rest (20 Hz) → fromHz → toHz (exponential) → rest at the hero, hosted like the export mixer
// hosts track inserts (`EffectSlot`, keyframes evaluated every 32 samples). Oracle: a sine through the sweep has no
// discontinuity — its third difference stays within a small multiple of the clean sine's (A·ω³), where a 0.1 % step
// (−60 dB) is already well over the limit — at the keyframes, during the sweep and on the release at the hero.
import { buildSweepPoints } from '@jasper/project';
import type { EffectInstance } from '@jasper/project/audio';
import { describe, expect, it } from 'vitest';
import { EffectSlot } from '../src/host.ts';

const SR = 48000;
const FPS_FLICKS = 705_600_000 / SR;
const ease = { influence: 1, slope: 1 };

function buildFilter(T: number, spec: { seconds: number; fromHz: number; toHz: number }): EffectInstance {
	const sweep = buildSweepPoints(T, spec, { num: 30, den: 1 })!;
	return {
		id: 'fx_build',
		effectId: 'jasper.audio.scientific-filter',
		effectVersion: 1,
		enabled: true,
		params: {
			type: { value: 'butterworth', keyframes: [] },
			mode: { value: 'highPass', keyframes: [] },
			order: { value: 2, keyframes: [] },
			cutoff: {
				value: 20,
				keyframes: sweep.points.map(([t, v], i) => ({
					id: `k${i}`,
					time: Math.round(t),
					value: v,
					interpolation: 'linear' as const,
					easeIn: ease,
					easeOut: ease,
				})),
			},
		},
	} as unknown as EffectInstance;
}

/** Third difference of `x` (the largest, and where). */
function d3max(x: Float32Array, from = 3): { max: number; at: number } {
	let max = 0;
	let at = 0;
	for (let i = Math.max(3, from); i < x.length; i++) {
		const d = Math.abs(x[i]! - 3 * x[i - 1]! + 3 * x[i - 2]! - x[i - 3]!);
		if (d > max) {
			max = d;
			at = i;
		}
	}
	return { max, at };
}

/** Renders `seconds` of a sine through the slot in mixer-sized blocks (1024). */
function render(effect: EffectInstance, hz: number, amp: number, seconds: number): Float32Array {
	const slot = new EffectSlot(effect, SR, 2);
	const n = Math.round(seconds * SR);
	const l = Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
	const r = l.slice();
	for (let i = 0; i < n; i += 1024) {
		const k = Math.min(1024, n - i);
		const bl = l.subarray(i, i + k);
		const br = r.subarray(i, i + k);
		slot.process([bl, br], k, { sampleRate: SR, time: i * FPS_FLICKS, flicksPerSample: FPS_FLICKS });
	}
	return l;
}

describe('build sweep (High Pass, keyframed cutoff): no clicks', () => {
	for (const [hz, spec] of [
		[220, { seconds: 2, fromHz: 150, toHz: 2000 }],
		[440, { seconds: 1, fromHz: 200, toHz: 4000 }],
		[110, { seconds: 2, fromHz: 150, toHz: 2000 }],
	] as const) {
		it(`a ${hz} Hz sine through ${spec.fromHz} → ${spec.toHz} Hz over ${spec.seconds} s and the release`, () => {
			const amp = 0.25;
			const y = render(buildFilter(90, spec), hz, amp, 4);
			const w = (2 * Math.PI * hz) / SR;
			const clean = amp * w ** 3;
			// a −60 dB step (0.1 % of the amplitude) gives a third difference of amp·1e-3
			const limit = Math.max(clean * 4, amp * 2e-4);
			const r = d3max(y, 10);
			expect(
				r.max,
				`max ${r.max.toExponential(2)} at ${(r.at / SR).toFixed(4)} s, limit ${limit.toExponential(2)}`,
			).toBeLessThan(limit);
			// the sweep did act: the tone is cut during the build and comes back after the hero
			const lvl = (a: number, b: number) => {
				let e = 0;
				for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) e += y[i]! * y[i]!;
				return Math.sqrt((2 * e) / Math.round((b - a) * SR));
			};
			expect(lvl(2.85, 2.95)).toBeLessThan(amp * 0.5);
			expect(lvl(3.3, 3.5)).toBeGreaterThan(amp * 0.95);
			// the detector sees a 0.1 % step (taken where the tone is at its crest)
			const z = y.slice();
			let i0 = SR;
			for (let i = SR; i < SR + 500; i++) if (Math.abs(y[i]!) > Math.abs(y[i0]!)) i0 = i;
			for (let i = i0; i < z.length; i++) z[i]! *= 1.001;
			expect(d3max(z, 10).max).toBeGreaterThan(limit);
		});
	}
});
