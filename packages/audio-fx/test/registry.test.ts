// Generic contract of every registered processor (port of filmcraft `effects/mod.rs` tests): block-size independence with parameter changes, degenerate blocks, extreme settings, reset.
import type { ParamSpec } from '@jasper/project/audio';
import { describe, expect, it } from 'vitest';
import type { AudioProcessor } from '../src/core/effect.ts';
import { createProcessor, processorIds } from '../src/registry.ts';
import { noise, SR } from './util.ts';

/** A non-default setting for every parameter (exercises real processing paths). */
function tweak(fx: AudioProcessor) {
	for (const p of fx.spec.params) expect(fx.setParam(p.name, tweakValue(p))).toBe(true);
}
function tweakValue(p: ParamSpec): number | boolean {
	if (p.type === 'boolean') return true;
	if (p.type === 'enum') return (p.options?.length ?? 1) - 1;
	const lo = p.range?.min ?? 0;
	const hi = p.range?.max ?? 1;
	return lo + (hi - lo) * 0.37;
}
const isF32Subnormal = (v: number) => v !== 0 && Math.abs(v) < 1.1754944e-38;

describe('audio-fx registry', () => {
	it('refuses unknown processor and parameter identifiers', () => {
		expect(createProcessor('jasper.audio.nope', SR, 2)).toBeNull();
		const processor = createProcessor('jasper.audio.amplify', SR, 2)!;
		expect(processor.setParam('nope', 1)).toBe(false);
	});

	it('output is independent of the block size, with a parameter change mid-stream', () => {
		const n = 30000;
		const srcL = noise(1, n, 0.7);
		const srcR = noise(2, n, 0.7);
		const changeAt = 11111;
		for (const id of processorIds()) {
			const runWith = (sizes: () => number) => {
				const fx = createProcessor(id, SR, 2)!;
				const l = srcL.slice();
				const r = srcR.slice();
				let pos = 0;
				let changed = false;
				while (pos < n) {
					if (!changed && pos === changeAt) {
						tweak(fx);
						changed = true;
					}
					let len = Math.min(sizes(), n - pos);
					if (!changed && pos + len > changeAt) len = changeAt - pos;
					fx.process([l, r], pos, pos + len);
					pos += len;
				}
				return [l, r] as const;
			};
			const big = runWith(() => Number.MAX_SAFE_INTEGER);
			let seed = 5;
			const rnd = () => {
				seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
				return seed;
			};
			const small = runWith(() => {
				const k = rnd() % 4;
				return k === 0 ? 0 : k === 1 ? 1 : k === 2 ? rnd() % 64 : rnd() % 3000;
			});
			for (let c = 0; c < 2; c++)
				for (let i = 0; i < n; i++) {
					const a = big[c]![i]!;
					if (!Number.isFinite(a) || !Number.isFinite(small[c]![i]!))
						throw new Error(`${id}: non-finite output`);
					if (Math.abs(a - small[c]![i]!) > 1e-6)
						throw new Error(`${id}: block-size dependent output at ${i}`);
				}
		}
	});

	it('handles empty, single-sample, mono and extra-channel blocks', () => {
		for (const id of processorIds()) {
			for (const configured of [1, 2]) {
				const fx = createProcessor(id, SR, configured)!;
				for (const changed of [false, true]) {
					if (changed) {
						tweak(fx);
						fx.reset();
					}
					const label = `${id}: ${configured} configured, ${changed ? 'changed' : 'default'} settings`;
					const cases = [
						[],
						[new Float32Array(0), new Float32Array(0)],
						[new Float32Array([0.25]), new Float32Array([-0.25])],
						[new Float32Array(3).fill(0.1)],
						[
							new Float32Array(3).fill(0.1),
							new Float32Array(3).fill(0.1),
							new Float32Array([0.1, -0.3, 0.2]),
						],
					];
					for (const channels of cases) {
						const extra = channels.slice(configured).map((channel) => channel.slice());
						fx.process(channels, 0, channels[0]?.length ?? 0);
						for (const channel of channels) expect(channel.every(Number.isFinite), label).toBe(true);
						expect.soft(channels.slice(configured), `${label}: extra channels`).toEqual(extra);
					}
				}
			}
		}
	});

	it.each(processorIds().flatMap((id) => (['min', 'max'] as const).map((extreme) => [id, extreme] as const)))(
		'extreme settings stay finite and tails end without subnormals (%s, %s)',
		(id, extreme) => {
			const fx = createProcessor(id, SR, 2)!;
			for (const p of fx.spec.params) {
				if (p.type === 'number') fx.setParam(p.name, extreme === 'min' ? p.range!.min! : p.range!.max!);
				else if (p.type === 'boolean') fx.setParam(p.name, extreme === 'max');
				else fx.setParam(p.name, extreme === 'min' ? 0 : (p.options?.length ?? 1) - 1);
			}
			const l = noise(3, 24000, 4);
			const r = noise(4, 24000, 4);
			l[100] = 1e6;
			r[200] = -1e6;
			fx.process([l, r], 0, l.length);
			for (let i = 0; i < l.length; i++)
				if (!Number.isFinite(l[i]!) || !Number.isFinite(r[i]!))
					throw new Error(`${id} ${extreme}: non-finite`);
			fx.reset();
			const l2 = noise(3, 4800, 0.5);
			const r2 = noise(4, 4800, 0.5);
			fx.process([l2, r2], 0, l2.length);
			const zl = new Float32Array(48000);
			const zr = new Float32Array(48000);
			for (let k = 0; k < 12; k++) {
				zl.fill(0);
				zr.fill(0);
				fx.process([zl, zr], 0, zl.length);
				for (let i = 0; i < zl.length; i++) {
					const v = zl[i]!;
					const w = zr[i]!;
					if (!Number.isFinite(v) || !Number.isFinite(w) || isF32Subnormal(v) || isF32Subnormal(w))
						throw new Error(`${id} ${extreme}: NaN or subnormal in the tail`);
				}
			}
		},
	);

	it('reset restores the initial behaviour', () => {
		for (const id of processorIds()) {
			const fx = createProcessor(id, SR, 2)!;
			const x = noise(8, 6000, 0.5);
			const a1 = x.slice();
			const a2 = x.slice();
			fx.process([a1, a2], 0, x.length);
			fx.process([noise(9, 3000, 0.9), noise(10, 3000, 0.9)], 0, 3000);
			fx.reset();
			const b1 = x.slice();
			const b2 = x.slice();
			fx.process([b1, b2], 0, x.length);
			for (const [expected, actual] of [
				[a1, b1],
				[a2, b2],
			] as const)
				for (let i = 0; i < x.length; i++)
					if (!Number.isFinite(actual[i]!) || !(Math.abs(expected[i]! - actual[i]!) < 1e-6))
						throw new Error(`${id}: reset did not clear the state (${i})`);
		}
	});
});
