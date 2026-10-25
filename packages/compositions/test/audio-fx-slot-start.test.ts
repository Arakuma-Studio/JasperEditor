// @vitest-environment node
// WP0.1 (spec 12 Phase 0): a preview effect slot starts at its instance's values. The slot's processors are built with
// the catalogue defaults; without a snap, the parameter smoothers glided from the defaults to the instance's values over
// the first 20–100 ms of every slot (Amplify −40 dB started at 0 dB) — the export was fixed in WP0.2 (`EffectSlot`).
// And a new slot's worklet processed its first quanta with no effect at all (pass-through, no latency) until the
// instance arrived by message: it now arrives with the node (`processorOptions.effect`).
import { AUDIO_EFFECTS, type EffectInstance, flicksPerFrame } from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { FxSlotCore } from '../src/audio/fx-processor.ts';

const SR = 48000;

function amplify(db: number, keyed = false): EffectInstance {
	const spec = AUDIO_EFFECTS.find((s) => s.id === 'jasper.audio.amplify')!;
	const params: EffectInstance['params'] = {};
	for (const p of spec.params) params[p.name] = { value: p.default, keyframes: [] };
	params.leftGain = { value: db, keyframes: [] };
	params.rightGain = { value: db, keyframes: [] };
	if (keyed) {
		const F = flicksPerFrame({ num: 30, den: 1 });
		const k = (id: string, time: number, value: number) => ({
			id,
			time,
			value,
			interpolation: 'linear' as const,
			easeIn: { influence: 1 / 3, slope: 0 },
			easeOut: { influence: 1 / 3, slope: 0 },
		});
		params.leftGain = { value: 0, keyframes: [k('a', 0, db), k('b', 30 * F, 0)] };
	}
	return { id: 'fx1', effectId: 'jasper.audio.amplify', effectVersion: 1, enabled: true, params };
}

function quantum(render: (i: Float32Array[], o: Float32Array[]) => void): number {
	const x = new Float32Array(128).fill(0.5);
	const out = [new Float32Array(128), new Float32Array(128)];
	render([x, x], out);
	return Math.max(...out[0]!.map(Math.abs));
}

describe('preview effect slot start', () => {
	it('the first quantum is at the instance value (Amplify −40 dB), not a glide from 0 dB', () => {
		const core = new FxSlotCore(SR, 2, null);
		core.message({ type: 'effect', effect: amplify(-40), time: 0 });
		expect(quantum((i, o) => core.render(i, o))).toBeCloseTo(0.005, 4);
	});

	it('keyframed: the first quantum uses the keyframe instead of the stored base value', () => {
		const core = new FxSlotCore(SR, 2, null);
		core.message({ type: 'effect', effect: amplify(-40, true), time: 0 });
		expect(quantum((i, o) => core.render(i, o))).toBeCloseTo(0.005, 4);
	});

	it('an edit while playing still glides (no click)', () => {
		const core = new FxSlotCore(SR, 2, null);
		core.message({ type: 'effect', effect: amplify(-40), time: 0 });
		quantum((i, o) => core.render(i, o));
		core.message({ type: 'effect', effect: amplify(0), time: 0 });
		const x = new Float32Array(128).fill(0.5);
		const out = [new Float32Array(128), new Float32Array(128)];
		core.render([x, x], out);
		expect(out[0]![0]!).toBeLessThan(0.1);
	});
});

describe('preview effect slot worklet', () => {
	type Proc = { process(i: Float32Array[][], o: Float32Array[][]): boolean };
	const processors = new Map<string, new (o: unknown) => Proc>();
	beforeAll(async () => {
		const g = globalThis as Record<string, unknown>;
		g.sampleRate = SR;
		g.currentFrame = 0;
		g.AudioWorkletProcessor = class {
			port = { onmessage: null, postMessage() {}, close() {} };
		};
		g.registerProcessor = (name: string, ctor: new (o: unknown) => Proc) => processors.set(name, ctor);
		await import('../src/audio/worklet.ts');
	});

	it('processes its first quantum with the instance it was created with', () => {
		const Fx = processors.get('jasper-audio-fx')!;
		const p = new Fx({ processorOptions: { channels: 2, effect: amplify(-40), time: 0 } });
		expect(quantum((i, o) => p.process([i], [o]))).toBeCloseTo(0.005, 4);
	});
});
