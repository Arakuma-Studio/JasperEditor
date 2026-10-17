// @vitest-environment node
// Sound design Phase 4 verification: a preview effect slot WHILE PLAYING (a `SlotClock` with each time message)
// evaluates keyframed parameters like the export's `EffectSlot` — every CONTROL_BLOCK samples on the export's grid,
// at the time of that sample — so a build sweep (Scientific Filter high pass, cutoff keyframed 20 → 150 → 2000 → 20 Hz)
// renders sample for sample as the export does, whatever the frame rate of the time messages. Before, the slot
// evaluated the keyframes once per message (once per picture frame) and the processors glided between those values.
import { EffectSlot, installAudioFxProcessors } from '@jasper/audio-fx';
import { AUDIO_EFFECTS, type EffectInstance, FLICKS_PER_SECOND } from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { FxSlotCore } from '../src/audio/fx-processor.ts';

const SR = 48000;
const S = FLICKS_PER_SECOND;

function key(id: string, seconds: number, value: number) {
	return {
		id,
		time: Math.round(seconds * S),
		value,
		interpolation: 'linear' as const,
		easeIn: { influence: 1 / 3, slope: 0 },
		easeOut: { influence: 1 / 3, slope: 0 },
	};
}

function build(): EffectInstance {
	const spec = AUDIO_EFFECTS.find((s) => s.id === 'jasper.audio.scientific-filter')!;
	const params: EffectInstance['params'] = {};
	for (const p of spec.params) params[p.name] = { value: p.default, keyframes: [] };
	params.mode = { value: 'highPass', keyframes: [] };
	params.type = { value: 'butterworth', keyframes: [] };
	params.order = { value: 2, keyframes: [] };
	params.cutoff = {
		value: 20,
		keyframes: [key('a', 0.25, 20), key('b', 0.3, 150), key('c', 0.567, 2000), key('d', 0.6, 20)],
	};
	return {
		id: 'fx_build',
		effectId: 'jasper.audio.scientific-filter',
		effectVersion: 1,
		enabled: true,
		params,
	};
}

function noise(n: number): Float32Array {
	let x = 7;
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		out[i] = ((x >>> 8) / (1 << 24) - 0.5) * 0.5;
	}
	return out;
}

beforeAll(() => installAudioFxProcessors());

describe('preview effect slot while playing', () => {
	it('a keyframed build sweep: identical to the export slot, sample for sample', () => {
		const N = Math.round(0.8 * SR);
		const src = noise(N);
		// export: EffectSlot over the whole signal in 1000-sample blocks (block size does not matter)
		const exp = new EffectSlot(build(), SR, 1);
		const e = src.slice();
		for (let a = 0; a < N; a += 1000) {
			const k = Math.min(1000, N - a);
			const view = [e.subarray(a, a + k)];
			exp.process(view, k, { sampleRate: SR, time: (a * S) / SR, flicksPerSample: S / SR });
		}
		// preview: 128-sample quanta; a time message per 30 fps frame (1600 samples), valid at the quantum where it
		// arrives, with its clock — as the graph posts them while playing
		const core = new FxSlotCore(SR, 1, null);
		core.message({ type: 'effect', effect: build(), time: 0, clock: { at: 0, rate: 1, grid: 0 } });
		const p = new Float32Array(N);
		let nextFrame = 1600;
		for (let q = 0; q < N; q += 128) {
			if (q >= nextFrame) {
				const at = q / SR;
				core.message({ type: 'time', time: (q * S) / SR, clock: { at, rate: 1, grid: q } });
				nextFrame += 1600;
			}
			const n = Math.min(128, N - q);
			const out = [new Float32Array(n)];
			core.render([src.subarray(q, q + n)], out, q / SR);
			p.set(out[0]!, q);
		}
		let worst = 0;
		for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(p[i]! - e[i]!));
		expect(worst).toBeLessThan(1e-6);
		// The same messages without their clock (the slot before this fix: keyframes evaluated once per message, the
		// filter gliding between those values) are far off the export.
		const old = new FxSlotCore(SR, 1, null);
		old.message({ type: 'effect', effect: build(), time: 0 });
		let oldWorst = 0;
		nextFrame = 1600;
		for (let q = 0; q < N; q += 128) {
			if (q >= nextFrame) {
				old.message({ type: 'time', time: (q * S) / SR });
				nextFrame += 1600;
			}
			const n = Math.min(128, N - q);
			const out = [new Float32Array(n)];
			old.render([src.subarray(q, q + n)], out, q / SR);
			for (let i = 0; i < n; i++) oldWorst = Math.max(oldWorst, Math.abs(out[0]![i]! - e[q + i]!));
		}
		expect(oldWorst).toBeGreaterThan(1e-3);
	});
});
