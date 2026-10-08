// perf-core: proxy-free draft reads (src/commands/draft-read.ts). The fast path must be active with the Immer we
// ship (an Immer upgrade that changes its internal state shape fails here instead of silently slowing editing down),
// reads must see the draft's current values, and reading must not draft anything.
import { isDraft, produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { cachedRead, DRAFT_READ_FAST, keysOf, latest, peekIn, valuesOf } from '../src/commands/draft-read.ts';

type Doc = { clips: Record<string, { id: string; start: number; tags: string[] }> };
const base = (): Doc => ({
	clips: {
		a: { id: 'a', start: 0, tags: ['x'] },
		b: { id: 'b', start: 10, tags: [] },
		c: { id: 'c', start: 20, tags: [] },
	},
});

describe('draft-read', () => {
	it('uses the proxy-free fast path with this Immer', () => {
		expect(DRAFT_READ_FAST).toBe(true);
	});

	it('returns plain values that follow writes, deletions and additions', () => {
		const doc = base();
		produce(doc, (d) => {
			expect(latest(d)).toBe(doc);
			expect(latest(d.clips)).toBe(doc.clips);
			d.clips.b!.start = 99;
			delete d.clips.c;
			d.clips.n = { id: 'n', start: 5, tags: [] };
			expect(keysOf(d.clips)).toEqual(['a', 'b', 'n']);
			expect(valuesOf(d.clips).map((c) => c.start)).toEqual([0, 99, 5]);
			expect(valuesOf(d.clips).some((c) => isDraft(c))).toBe(false);
			expect(peekIn(d.clips, 'b')!.start).toBe(99);
			expect(peekIn(d.clips, 'c')).toBeUndefined();
			expect(peekIn(d.clips, 'toString')).toBeUndefined();
			expect(latest(42)).toBe(42);
		});
	});

	it('drafts nothing it only reads (unchanged documents keep their identity)', () => {
		const doc = base();
		const next = produce(doc, (d) => {
			for (const c of valuesOf(d.clips)) expect(c.start).toBeGreaterThanOrEqual(0);
			peekIn(d.clips, 'a');
			keysOf(d.clips);
		});
		expect(next).toBe(doc);
		const edited = produce(doc, (d) => {
			valuesOf(d.clips);
			d.clips.a!.start = 1;
		});
		expect(edited.clips.b).toBe(doc.clips.b);
		expect(edited.clips.c).toBe(doc.clips.c);
	});

	it('caches reads of finished (frozen) values only', () => {
		const cache = new WeakMap<object, number>();
		let calls = 0;
		const count = (rec: Doc['clips']) => {
			calls++;
			return Object.keys(rec).length;
		};
		const frozen = produce(base(), (d) => {
			d.clips.a!.start = 1;
		});
		expect(Object.isFrozen(frozen.clips)).toBe(true);
		expect(cachedRead(cache, frozen.clips, count)).toBe(3);
		expect(cachedRead(cache, frozen.clips, count)).toBe(3);
		expect(calls).toBe(1);
		produce(frozen, (d) => {
			d.clips.z = { id: 'z', start: 0, tags: [] };
			expect(cachedRead(cache, d.clips, count)).toBe(4);
			d.clips.y = { id: 'y', start: 0, tags: [] };
			expect(cachedRead(cache, d.clips, count)).toBe(5);
		});
		expect(calls).toBe(3);
	});
});
