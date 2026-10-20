// @vitest-environment node
// WP0.1 (spec 12 Phase 0): the preview loudness limiter (`jasper-limiter`). Re-enabling loudness normalisation used to
// replay the look-ahead audio held from before it was bypassed (a stale burst), and a non-finite ceiling made a limiter
// that output NaN. The worklet module runs here with stub AudioWorkletGlobalScope globals.
import { beforeAll, describe, expect, it } from 'vitest';

type Proc = {
	port: { onmessage: ((e: { data: unknown }) => void) | null };
	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};
const processors = new Map<string, new (o: unknown) => Proc>();

beforeAll(async () => {
	const g = globalThis as Record<string, unknown>;
	g.sampleRate = 48000;
	g.currentFrame = 0;
	g.AudioWorkletProcessor = class {
		port = { onmessage: null, postMessage() {}, close() {} };
	};
	g.registerProcessor = (name: string, ctor: new (o: unknown) => Proc) => processors.set(name, ctor);
	await import('../src/audio/worklet.ts');
});

function run(p: Proc, input: (i: number) => number, blocks: number): Float32Array {
	const out = new Float32Array(blocks * 128);
	for (let b = 0; b < blocks; b++) {
		const x = new Float32Array(128);
		for (let i = 0; i < 128; i++) x[i] = input(b * 128 + i);
		const o = [new Float32Array(128), new Float32Array(128)];
		p.process([[x, x]], [o]);
		out.set(o[0]!, b * 128);
	}
	return out;
}

describe('preview loudness limiter worklet', () => {
	it('re-enabled after a bypass it starts clean (no stale look-ahead audio)', () => {
		const Limiter = processors.get('jasper-limiter')!;
		const p = new Limiter({
			processorOptions: { channels: 2, ceilingDb: -1, enabled: true, lookaheadMs: 5 },
		});
		run(p, (i) => 0.5 * Math.sin(i / 7), 40); // fills the look-ahead delay line
		p.port.onmessage!({ data: { enabled: false } });
		run(p, () => 0, 4);
		p.port.onmessage!({ data: { enabled: true, ceilingDb: -1 } });
		const after = run(p, () => 0, 8);
		expect(Math.max(...after.map(Math.abs))).toBe(0);
	});

	it('a non-finite ceiling falls back to −1 dBTP instead of producing NaN', () => {
		const Limiter = processors.get('jasper-limiter')!;
		const p = new Limiter({
			processorOptions: { channels: 2, ceilingDb: Number.NaN, enabled: true, lookaheadMs: 5 },
		});
		const out = run(p, (i) => 0.9 * Math.sin(i / 5), 40);
		expect(out.every(Number.isFinite)).toBe(true);
		expect(Math.max(...out.map(Math.abs))).toBeLessThan(0.95);
	});
});
