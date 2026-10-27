import fc from 'fast-check';
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { allTracks, gapAt, nextEditPoint, prevEditPoint } from '../src/derive/index.ts';
import type { Clip, Sequence } from '../src/schema/sequence.ts';
import { Harness } from './helpers.ts';

const h = new Harness();
h.ok([{ type: 'clip.addSolid', at: 0, duration: 10, track: 'V1', color: [1, 0, 0, 1] }]);
const template = Object.values(h.seq.clips)[0]!;

function sequence(spans: [number, number, number][]): Sequence {
	const seq = { ...h.seq, clips: {} as Record<string, Clip> };
	const tracks = allTracks(seq);
	for (let i = spans.length - 1; i >= 0; i--) {
		const [track, start, duration] = spans[i]!;
		const id = `clip-${i}`;
		seq.clips[id] = { ...template, id, trackId: tracks[track]!.id, start, duration } as Clip;
	}
	return seq;
}

function boundaries(seq: Sequence, trackIds?: readonly string[]): number[] {
	const targets = new Set(trackIds ?? allTracks(seq).map((t) => t.id));
	return [
		...new Set(
			Object.values(seq.clips)
				.filter((c) => targets.has(c.trackId))
				.flatMap((c) => [c.start, c.start + c.duration]),
		),
	].sort((a, b) => a - b);
}

function referenceGap(seq: Sequence, trackId: string, frame: number) {
	let cursor = 0;
	for (const c of Object.values(seq.clips)
		.filter((clip) => clip.trackId === trackId)
		.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))) {
		if (c.start > cursor && cursor <= frame && frame < c.start)
			return { trackId, start: cursor, end: c.start };
		cursor = Math.max(cursor, c.start + c.duration);
	}
	return null;
}

function compare(seq: Sequence, frames: number[], targets?: readonly string[]) {
	const points = boundaries(seq, targets);
	for (const frame of frames) {
		expect(nextEditPoint(seq, frame, targets)).toBe(points.find((p) => p > frame) ?? null);
		expect(prevEditPoint(seq, frame, targets)).toBe(points.filter((p) => p < frame).at(-1) ?? null);
		for (const trackId of targets ?? allTracks(seq).map((t) => t.id)) {
			expect(gapAt(seq, trackId, frame)).toEqual(referenceGap(seq, trackId, frame));
		}
	}
}

describe('indexed edit navigation and gap lookup', () => {
	it('keeps strict edit boundaries, target tracks and finite gap extents', () => {
		const seq = sequence([
			[0, 5, 10],
			[0, 15, 5],
			[0, 30, 10],
			[1, 7, 4],
			[3, 0, 2],
		]);
		const frames = [-Infinity, -1, 0, 2, 5, 7, 10.5, 11, 14, 15, 19, 20, 29, 30, 40, 41, Infinity, NaN];
		compare(seq, frames);
		compare(seq, frames, []);
		compare(seq, frames, ['missing-track']);
		compare(seq, frames, [seq.videoTracks[0]!.id, seq.videoTracks[0]!.id]);
		compare(seq, frames, [seq.audioTracks[0]!.id]);
		compare(sequence([]), frames);
	});

	it('sees changed clip versions, undo-like reuse and edits inside an Immer draft', () => {
		const seq = sequence([[0, 10, 10]]);
		compare(seq, [0, 10, 15, 20, 25, 30, 40]);
		const changed = produce(seq, (draft) => {
			compare(draft, [0, 10, 20, 30, 40]);
			draft.clips['clip-0']!.start = 30;
			compare(draft, [0, 10, 20, 30, 40]);
			draft.clips['clip-1'] = { ...draft.clips['clip-0']!, id: 'clip-1', start: 0, duration: 5 };
			compare(draft, [0, 5, 10, 20, 30, 40]);
		});
		compare(changed, [0, 5, 10, 20, 30, 40]);
		compare(seq, [0, 5, 10, 20, 30, 40]);
	});

	it('agrees with the full boundary and gap scans on non-overlapping generated tracks', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.array(fc.tuple(fc.integer({ min: 0, max: 15 }), fc.integer({ min: 1, max: 40 })), {
						maxLength: 35,
					}),
					{ minLength: 1, maxLength: 6 },
				),
				fc.array(fc.integer({ min: -20, max: 2000 }), { maxLength: 20 }),
				(trackSpans, frames) => {
					const spans: [number, number, number][] = [];
					trackSpans.forEach((track, ti) => {
						let cursor = 0;
						for (const [gap, duration] of track) {
							cursor += gap;
							spans.push([ti, cursor, duration]);
							cursor += duration;
						}
					});
					const seq = sequence(spans);
					const points = boundaries(seq);
					const queries = [...frames, ...points.flatMap((p) => [p - 0.5, p, p + 0.5])];
					compare(seq, queries);
					compare(
						seq,
						queries,
						allTracks(seq)
							.filter((_, i) => i % 2 === 0)
							.map((t) => t.id),
					);
				},
			),
			{ numRuns: 75, seed: 90210 },
		);
	});
});
