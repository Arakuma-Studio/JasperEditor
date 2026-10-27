import fc from 'fast-check';
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { gapAt, nextEditPoint, prevEditPoint } from '../src/derive/index.ts';
import type { Clip, Sequence } from '../src/schema/sequence.ts';
import { Harness } from './helpers.ts';

const h = new Harness();
h.ok([{ type: 'clip.addSolid', at: 0, duration: 10, track: 'V1', color: [1, 0, 0, 1] }]);
const template = Object.values(h.seq.clips)[0]!;

function sequence(spans: [number, number, number][]): Sequence {
	const seq = { ...h.seq, clips: {} as Record<string, Clip> };
	const tracks = [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks];
	for (let i = spans.length - 1; i >= 0; i--) {
		const [track, start, duration] = spans[i]!;
		const id = `clip-${i}`;
		seq.clips[id] = { ...template, id, trackId: tracks[track]!.id, start, duration } as Clip;
	}
	return seq;
}

/** Empty connected intervals between frame zero and the last clip, from the interval definition (TL-019). */
function compare(seq: Sequence, frames: number[], targets?: readonly string[]) {
	const tracks = targets ?? [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks].map((t) => t.id);
	const clips = Object.values(seq.clips).filter((c) => tracks.includes(c.trackId));
	const points = [...new Set(clips.flatMap((c) => [c.start, c.start + c.duration]))];
	expect(frames.map((frame) => nextEditPoint(seq, frame, targets))).toEqual(
		frames.map((frame) => {
			const after = points.filter((p) => p > frame);
			return after.length ? Math.min(...after) : null;
		}),
	);
	expect(frames.map((frame) => prevEditPoint(seq, frame, targets))).toEqual(
		frames.map((frame) => {
			const before = points.filter((p) => p < frame);
			return before.length ? Math.max(...before) : null;
		}),
	);
	for (const trackId of tracks) {
		const intervals = clips.filter((c) => c.trackId === trackId);
		const edges = [...new Set([0, ...intervals.flatMap((c) => [c.start, c.start + c.duration])])].sort(
			(a, b) => a - b,
		);
		const gaps = edges.slice(0, -1).flatMap((start, i) => {
			const end = edges[i + 1]!;
			return intervals.every((c) => c.start >= end || c.start + c.duration <= start)
				? [{ trackId, start, end }]
				: [];
		});
		expect(frames.map((frame) => gapAt(seq, trackId, frame))).toEqual(
			frames.map((frame) => gaps.find((g) => g.start <= frame && frame < g.end) ?? null),
		);
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
		const frames = [-1, 0, 2, 5, 7, 10.5, 11, 14, 15, 19, 20, 29, 30, 40, 41];
		expect(frames.map((f) => nextEditPoint(seq, f))).toEqual([
			0,
			2,
			5,
			7,
			11,
			11,
			15,
			15,
			20,
			20,
			30,
			30,
			40,
			null,
			null,
		]);
		expect(frames.map((f) => prevEditPoint(seq, f))).toEqual([
			null,
			null,
			0,
			2,
			5,
			7,
			7,
			11,
			11,
			15,
			15,
			20,
			20,
			30,
			40,
		]);
		const video = seq.videoTracks[0]!.id;
		expect(gapAt(seq, video, 0)).toEqual({ trackId: video, start: 0, end: 5 });
		expect(gapAt(seq, video, 5)).toBeNull();
		expect(gapAt(seq, video, 20)).toEqual({ trackId: video, start: 20, end: 30 });
		expect(gapAt(seq, video, 40)).toBeNull();
		expect(nextEditPoint(seq, 5, [video, video])).toBe(15);
		expect(prevEditPoint(seq, 15, [video])).toBe(5);
		expect(nextEditPoint(seq, 0, [seq.audioTracks[0]!.id])).toBe(2);
		for (const targets of [[], ['missing-track']]) {
			expect(nextEditPoint(seq, 0, targets)).toBeNull();
			expect(prevEditPoint(seq, 10, targets)).toBeNull();
		}
		expect(nextEditPoint(sequence([]), 0)).toBeNull();
		expect(prevEditPoint(sequence([]), 10)).toBeNull();
		expect(gapAt(sequence([]), video, 0)).toBeNull();
	});

	it('reads changed clip versions and a previous version restored by undo', () => {
		const seq = sequence([[0, 10, 10]]);
		const track = seq.videoTracks[0]!.id;
		expect(nextEditPoint(seq, 0)).toBe(10);
		const changed = produce(seq, (draft) => {
			draft.clips['clip-0']!.start = 30;
			draft.clips['clip-1'] = { ...draft.clips['clip-0']!, id: 'clip-1', start: 0, duration: 5 };
		});
		expect(nextEditPoint(changed, 10)).toBe(30);
		expect(prevEditPoint(changed, 10)).toBe(5);
		expect(gapAt(changed, track, 10)).toEqual({ trackId: track, start: 5, end: 30 });
		expect(nextEditPoint(seq, 10)).toBe(20);
		expect(prevEditPoint(seq, 15)).toBe(10);
		expect(gapAt(seq, track, 5)).toEqual({ trackId: track, start: 0, end: 10 });
	});

	it('obeys nearest-boundary and empty-interval definitions on generated tracks', () => {
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
					const points = [...new Set(spans.flatMap(([, start, duration]) => [start, start + duration]))];
					const queries = [...frames, ...points.flatMap((p) => [p - 0.5, p, p + 0.5])];
					compare(seq, queries);
					compare(
						seq,
						queries,
						[...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks]
							.filter((_, i) => i % 2 === 0)
							.map((t) => t.id),
					);
				},
			),
			{ numRuns: 75, seed: 90210 },
		);
	});
});
