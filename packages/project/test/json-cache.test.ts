import fc from 'fast-check';
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';

import { stringifyJson } from '../src/index.ts';

function deepFreeze<T>(v: T): T {
	if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
		Object.freeze(v);
		for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
	}
	return v;
}

describe('stringifyJson', () => {
	it('equals JSON.stringify on arbitrary JSON values, frozen or not, cold and cached', () => {
		fc.assert(
			fc.property(fc.jsonValue({ maxDepth: 6 }), fc.boolean(), (value, freeze) => {
				const v = freeze ? deepFreeze(structuredClone(value)) : value;
				expect(stringifyJson(v)).toBe(JSON.stringify(v));
				expect(stringifyJson(v)).toBe(JSON.stringify(v));
			}),
			{ numRuns: 300 },
		);
	});

	it('equals JSON.stringify on large containers (composed) with every special value', () => {
		const make = () =>
			Object.fromEntries(
				Array.from({ length: 150 }, (_, i) => [
					i % 3 ? `k${i}` : String(i),
					{
						n: i % 7 === 0 ? Number.NaN : i % 11 === 0 ? Number.POSITIVE_INFINITY : i / 3,
						u: undefined,
						f: () => i,
						s: Symbol('x'),
						d: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
						arr: [undefined, () => 1, Symbol('y'), null, -0, `q"${i}\n `],
						boxed: [new Number(i), new String('s'), new Boolean(i % 2)],
						nested: { list: Array.from({ length: 70 }, (_, j) => ({ j, t: j % 2 ? 'a' : undefined })) },
					},
				]),
			);
		const big = make();
		expect(stringifyJson(big)).toBe(JSON.stringify(big));
		const frozen = deepFreeze({ ...make(), a: [1, 2, 3] });
		expect(stringifyJson(frozen)).toBe(JSON.stringify(frozen));
		expect(stringifyJson(frozen)).toBe(JSON.stringify(frozen));
		expect(stringifyJson(undefined)).toBe(JSON.stringify(undefined));
		expect(stringifyJson('x')).toBe(JSON.stringify('x'));
		const withToJSON = { a: { toJSON: (k: string) => `key:${k}` }, b: [{ toJSON: (k: string) => k }] };
		expect(stringifyJson(withToJSON)).toBe(JSON.stringify(withToJSON));
	});

	it('throws like JSON.stringify on cycles and BigInt', () => {
		const cyc: Record<string, unknown> = Object.fromEntries(
			Array.from({ length: 80 }, (_, i) => [`k${i}`, i]),
		);
		cyc.self = { inner: cyc };
		expect(() => stringifyJson(cyc)).toThrow(TypeError);
		expect(() => stringifyJson({ big: 1n })).toThrow(TypeError);
	});

	it('never caches objects that can still change', () => {
		const list = Array.from({ length: 100 }, (_, i) => ({ i }));
		const doc = { list };
		const a = stringifyJson(doc);
		list[5]!.i = 999;
		expect(stringifyJson(doc)).toBe(JSON.stringify(doc));
		expect(stringifyJson(doc)).not.toBe(a);
		// A frozen container with a mutable child is not cached either.
		const shallow = Object.freeze({ list: Array.from({ length: 100 }, (_, i) => ({ i })) });
		stringifyJson(shallow);
		shallow.list[0]!.i = -1;
		expect(stringifyJson(shallow)).toBe(JSON.stringify(shallow));
	});

	it('follows Immer edits of a frozen tree', () => {
		let state = deepFreeze({
			items: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`i${i}`, { v: i, tags: ['a'] }])),
			meta: { n: 0 },
		});
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 119 }), fc.integer(), (i, v) => {
				state = produce(state, (d) => {
					d.items[`i${i}`]!.v = v;
					d.meta.n++;
				});
				expect(stringifyJson(state)).toBe(JSON.stringify(state));
			}),
			{ numRuns: 100 },
		);
	});
});
