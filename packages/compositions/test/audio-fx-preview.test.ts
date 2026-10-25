// The worklet uses 128-sample quanta; export blocks may have arbitrary lengths. Static parameters must
// produce bit-identical samples.
import { EffectSlot } from '@jasper/audio-fx';
import { AUDIO_EFFECTS, type EffectInstance } from '@jasper/project';
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
	it.each(AUDIO_EFFECTS)('$id: identical samples (128-sample quanta vs. irregular mixer blocks)', (spec) => {
		const n = 24000;
		const l = noise(1, n);
		const r = noise(2, n);
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
	});
});
