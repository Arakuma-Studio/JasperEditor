// The worklet uses 128-sample quanta; export blocks may have arbitrary lengths. Static parameters must
// produce bit-identical samples. Preview automation updates once per frame; export updates every 32 samples.
import { EffectSlot } from '@jasper/audio-fx';
import { AUDIO_EFFECTS, type EffectInstance, flicksPerFrame } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { FxSlotCore } from '../src/audio/fx-processor.ts';

const SR = 48000;
function noise(seed: number, n: number): Float32Array {
	let x = seed >>> 0 || 1;
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		out[i] = ((x >>> 8) / (1 << 24) - 0.5) * 0.8;
	}
	return out;
}

function instance(effectId: string): EffectInstance {
	const spec = AUDIO_EFFECTS.find((s) => s.id === effectId)!;
	const params: EffectInstance['params'] = {};
	for (const p of spec.params) params[p.name] = { value: p.default, keyframes: [] };
	return { id: 'fx1', effectId, effectVersion: 1, enabled: true, params };
}

describe('preview slot = export processor', () => {
	// One test per effect (all 60 in one test took ≈ 3 s alone and timed out at 5 s in the full gate under load; same
	// coverage).
	it.each(AUDIO_EFFECTS.map((s) => [s.id]))(
		'%s: identical samples (128-sample quanta vs. irregular mixer blocks)',
		(effectId) => {
			const n = 24000;
			const l = noise(1, n);
			const r = noise(2, n);
			for (const spec of AUDIO_EFFECTS.filter((x) => x.id === effectId)) {
				const fx = instance(spec.id);
				// Preview: the worklet core in 128-sample quanta.
				const core = new FxSlotCore(SR, 2, null);
				core.message({ type: 'effect', effect: fx, time: 0 });
				const pl = new Float32Array(n);
				const pr = new Float32Array(n);
				for (let i = 0; i < n; i += 128) {
					const k = Math.min(128, n - i);
					const outL = new Float32Array(k);
					const outR = new Float32Array(k);
					core.render([l.subarray(i, i + k), r.subarray(i, i + k)], [outL, outR]);
					pl.set(outL, i);
					pr.set(outR, i);
				}
				// Export: the mixer's processor in irregular blocks.
				const slot = new EffectSlot(fx, SR, 2);
				const el = l.slice();
				const er = r.slice();
				let pos = 0;
				let seed = 7;
				while (pos < n) {
					seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
					const k = Math.min(n - pos, 1 + (seed % 3000));
					slot.process([el.subarray(pos, pos + k), er.subarray(pos, pos + k)], k, {
						sampleRate: SR,
						time: 0,
						flicksPerSample: 705_600_000 / SR,
					});
					pos += k;
				}
				let same = true;
				for (let i = 0; i < n; i++) if (pl[i] !== el[i] || pr[i] !== er[i]) same = false;
				expect(same, spec.id).toBe(true);
			}
		},
	);

	it('keyframed parameters: preview (frame-rate updates) stays close to the export (32-sample control rate)', () => {
		const F = flicksPerFrame({ num: 30, den: 1 });
		const fx = instance('jasper.audio.amplify');
		fx.params.leftGain = {
			value: 0,
			keyframes: [
				{
					id: 'k1',
					time: 0,
					value: 0,
					interpolation: 'linear',
					easeIn: { influence: 1 / 3, slope: 0 },
					easeOut: { influence: 1 / 3, slope: 0 },
				},
				{
					id: 'k2',
					time: 30 * F,
					value: -24,
					interpolation: 'linear',
					easeIn: { influence: 1 / 3, slope: 0 },
					easeOut: { influence: 1 / 3, slope: 0 },
				},
			],
		};
		const n = SR;
		const one = () => new Float32Array(n).fill(0.5);
		const core = new FxSlotCore(SR, 2, null);
		core.message({ type: 'effect', effect: fx, time: 0 });
		const pl = new Float32Array(n);
		const spf = SR / 30;
		for (let i = 0; i < n; i += 128) {
			const k = Math.min(128, n - i);
			// The graph posts the time every rendered frame.
			if (i % Math.round(spf) < 128) core.message({ type: 'time', time: Math.floor(i / spf) * F });
			const out = [new Float32Array(k), new Float32Array(k)];
			core.render([one().subarray(i, i + k), one().subarray(i, i + k)], out);
			pl.set(out[0]!, i);
		}
		const slot = new EffectSlot(fx, SR, 2);
		const el = one();
		slot.process([el, one()], n, { sampleRate: SR, time: 0, flicksPerSample: 705_600_000 / SR });
		let worst = 0;
		for (let i = 4800; i < n - 4800; i++) worst = Math.max(worst, Math.abs(20 * Math.log10(pl[i]! / el[i]!)));
		expect(worst).toBeLessThan(1.5);
	});
});
