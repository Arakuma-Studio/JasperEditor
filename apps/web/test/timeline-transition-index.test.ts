import { describe, expect, it } from 'vitest';
import {
	hitTransition,
	transitionIndex,
	transitionsInRange,
} from '../src/panels/timeline/model/transitions.ts';
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
		// Caller-supplied maps retain their order and do not require pre-indexed lists.
		const unsorted = [...list].reverse();
		expect(transitionsInRange(new Map([[row.trackId, unsorted]]), row.trackId, 0, 100)).toEqual(
			unsorted.filter((g) => g.end > 0 && g.start < 100),
		);
	});

	it('matches exhaustive hits at body/edge boundaries across zoom and row heights', () => {
		const { seq, media, row } = transitionSequence(30);
		// Overlapping fades exercise edge/body priority and the prefix maximum for a long earlier span.
		seq.clips['clip-0'] = { ...seq.clips['clip-0']!, duration: 4000 };
		seq.transitions['fade-0'] = { ...seq.transitions['fade-0']!, duration: 4000 };
		const index = transitionIndex(seq, media);
		const list = index.get(row.trackId)!;
		const exhaustive = new Map([[row.trackId, [...list]]]);
		for (const pxPerFrame of [0.0001, 0.01, 0.1, 0.3, 1, 2, 10, 100]) {
			for (const height of [20, 30, 64]) {
				const testRow = { ...row, height };
				const v = { scrollFrame: 153.75, pxPerFrame, width: 1200 };
				for (const g of list) {
					for (const frame of [g.start, (g.start + g.end) / 2, g.end]) {
						for (const dx of [-3, -2, -1.5, -1, 0, 1, 1.5, 2, 3]) {
							const x = (frame - v.scrollFrame) * pxPerFrame + dx;
							expect(hitTransition(index, testRow, v, x, 15)).toEqual(
								hitTransition(exhaustive, testRow, v, x, 15),
							);
						}
					}
				}
			}
		}
	});

	it('reuses unchanged indexes and rebuilds after a transient clip movement', () => {
		const { seq, media, row } = transitionSequence(10);
		const before = transitionIndex(seq, media);
		expect(transitionIndex({ ...seq }, media)).toBe(before);
		const moved = { ...seq, clips: { ...seq.clips, 'clip-9': { ...seq.clips['clip-9']!, start: 5000 } } };
		const after = transitionIndex(moved, media);
		expect(after).not.toBe(before);
		expect(transitionsInRange(before, row.trackId, 900, 920)).toHaveLength(1);
		expect(transitionsInRange(after, row.trackId, 900, 920)).toHaveLength(0);
		expect(transitionsInRange(after, row.trackId, 5000, 5020).map((g) => g.t.id)).toEqual(['fade-9']);
	});
});
