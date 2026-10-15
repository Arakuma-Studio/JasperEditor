import { describe, expect, it } from 'vitest';
import { transitionIndex, transitionsInRange } from '../src/panels/timeline/model/transitions.ts';
import { transitionSequence } from './transition-performance-fixture.ts';

describe('indexed timeline transition queries', () => {
	it('matches exhaustive half-open range queries, including long overlaps and equal starts', () => {
		const { seq, media, row } = transitionSequence(120);
		for (let i = 0; i < 120; i++) {
			const clip = seq.clips[`clip-${i}`]!;
			seq.clips[clip.id] = {
				...clip,
				start: ((i * 37) % 50) * 10 - 100,
				duration: i === 0 ? 2000 : 20 + (i % 13) * 20,
			};
			seq.transitions[`fade-${i}`] = {
				...seq.transitions[`fade-${i}`]!,
				duration: seq.clips[clip.id]!.duration,
			};
		}
		const index = transitionIndex(seq, media);
		const list = index.get(row.trackId)!;
		for (let start = -150; start < 2100; start += 7) {
			for (const width of [0, 1, 20, 100, 1000]) {
				expect(transitionsInRange(index, row.trackId, start, start + width)).toEqual(
					list.filter((g) => g.end > start && g.start < start + width),
				);
			}
		}
		expect(transitionsInRange(index, 'missing', 0, 100)).toEqual([]);
		const unsorted = [...list].reverse();
		expect(transitionsInRange(new Map([[row.trackId, unsorted]]), row.trackId, 0, 100)).toEqual(
			unsorted.filter((g) => g.end > 0 && g.start < 100),
		);
	});

	it('queries the new range after a transient clip movement', () => {
		const { seq, media, row } = transitionSequence(10);
		const before = transitionIndex(seq, media);
		const moved = { ...seq, clips: { ...seq.clips, 'clip-9': { ...seq.clips['clip-9']!, start: 5000 } } };
		const after = transitionIndex(moved, media);
		expect(transitionsInRange(before, row.trackId, 900, 920)).toHaveLength(1);
		expect(transitionsInRange(after, row.trackId, 900, 920)).toHaveLength(0);
		expect(transitionsInRange(after, row.trackId, 5000, 5020).map((g) => g.t.id)).toEqual(['fade-9']);
	});
});
