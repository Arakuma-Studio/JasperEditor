// Generic contract of every registered processor (port of filmcraft `effects/mod.rs` tests): catalogue
// consistency, block-size independence with parameter changes, degenerate blocks, extreme settings, reset.
import { AUDIO_EFFECTS, type ParamSpec } from '@jasper/project/audio';
import { describe, expect, it } from 'vitest';
import { type AudioProcessor, numericDefault } from '../src/core/effect.ts';
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
	it('every catalogue entry has exactly one processor with matching params', () => {
		const ids = AUDIO_EFFECTS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect([...processorIds()].sort()).toEqual([...ids].sort());
		for (const spec of AUDIO_EFFECTS) {
			expect(spec.id.startsWith('jasper.audio.')).toBe(true);
			const fx = createProcessor(spec.id, SR, 2)!;
			expect(fx.id).toBe(spec.id);
			const names = new Set<string>();
			for (const p of spec.params) {
				expect(names.has(p.name), `${spec.id}: duplicate ${p.name}`).toBe(false);
				names.add(p.name);
				expect(/^[a-zA-Z][a-zA-Z0-9]*$/.test(p.name), `${spec.id}.${p.name}: camelCase name`).toBe(true);
				if (p.type === 'number') {
					expect(p.range?.min).toBeTypeOf('number');
					expect(p.range?.max).toBeTypeOf('number');
					expect(p.default as number).toBeGreaterThanOrEqual(p.range!.min!);
					expect(p.default as number).toBeLessThanOrEqual(p.range!.max!);
				}
				if (p.type === 'enum') expect(p.options).toContain(p.default);
				expect(['number', 'boolean', 'enum']).toContain(p.type);
				expect(fx.param(p.name)).toBe(numericDefault(p));
			}
			expect(fx.setParam('nope', 1)).toBe(false);
		}
		expect(createProcessor('jasper.audio.nope', SR, 2)).toBeNull();
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
					if (!Number.isFinite(a)) throw new Error(`${id}: non-finite output`);
					if (Math.abs(a - small[c]![i]!) > 1e-6)
						throw new Error(`${id}: block-size dependent output at ${i}`);
				}
		}
	});

	it('handles empty, single-sample, mono and extra-channel blocks', () => {
		for (const id of processorIds()) {
			const fx = createProcessor(id, SR, 2)!;
			fx.process([], 0, 0);
			fx.process([new Float32Array(0), new Float32Array(0)], 0, 0);
			const a = new Float32Array([0.25]);
			const b = new Float32Array([-0.25]);
			fx.process([a, b], 0, 1);
			fx.process([new Float32Array(3).fill(0.1)], 0, 3);
			fx.process(
				[new Float32Array(3).fill(0.1), new Float32Array(3).fill(0.1), new Float32Array(3).fill(0.1)],
				0,
				3,
			);
			expect(Number.isFinite(a[0]!) && Number.isFinite(b[0]!), id).toBe(true);
		}
	});

	// One test per processor: all of them in one test (12 s of tail × 2 settings × every effect) ran 90–190 s under
	// load and hit the 120 s test timeout. The coverage is the same.
	it.each([...processorIds()].map((id) => [id]))(
		'%s: extreme settings stay finite and tails end without subnormals',
		(id) => {
			for (const extreme of ['min', 'max'] as const) {
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
				for (let k = 0; k < 12; k++) {
					const zl = new Float32Array(48000);
					const zr = new Float32Array(48000);
					fx.process([zl, zr], 0, zl.length);
					for (let i = 0; i < zl.length; i++) {
						const v = zl[i]!;
						const w = zr[i]!;
						if (!Number.isFinite(v) || !Number.isFinite(w) || isF32Subnormal(v) || isF32Subnormal(w))
							throw new Error(`${id} ${extreme}: NaN or subnormal in the tail`);
					}
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
			for (let i = 0; i < x.length; i++)
				if (Math.abs(a1[i]! - b1[i]!) >= 1e-6) throw new Error(`${id}: reset did not clear the state (${i})`);
		}
	});
});
