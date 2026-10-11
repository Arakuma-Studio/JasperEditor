import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyTransaction, clipsOnTrack, createRandomIdSource, type Sequence } from '../src/index.ts';
import { Harness, makeCtx } from './helpers.ts';

const allTrackIds = (s: Sequence) =>
	[...s.videoTracks, ...s.audioTracks, ...s.captionTracks].map((t) => t.id);
/** A full build: the same sequence under an id that has no previous version. */
const fresh = (s: Sequence, n: number) => ({ ...s, id: `seq_fresh${n}`, clips: { ...s.clips } }) as Sequence;

describe('incremental per-track index (perf-core)', () => {
	it('equals a full build after every edit', () => {
		const h = new Harness({ seed: 11 });
		const media = h.registerVideo({ seconds: 10 });
		h.ok([
			{ type: 'clip.place', source: { mediaId: media }, at: 0 },
			...Array.from({ length: 60 }, (_, i) => ({
				type: 'clip.addSolid',
				at: Math.floor(i / 3) * 50,
				duration: 40,
				track: `V${(i % 3) + 1}`,
				color: [1, 0, 0, 1],
			})),
		]);
		const ids = createRandomIdSource();
		let n = 0;
		fc.assert(
			fc.property(
				fc.array(fc.record({ k: fc.nat(4), a: fc.nat(500), b: fc.nat(400) }), { minLength: 1, maxLength: 8 }),
				(steps) => {
					let doc = h.doc;
					for (const s of steps) {
						const seq = doc.sequences[h.seqId]!;
						for (const t of allTrackIds(seq)) clipsOnTrack(seq, t);
						const clips = Object.keys(seq.clips).sort();
						const c = clips[s.a % clips.length]!;
						const cmd = [
							{ type: 'clip.move', clipIds: [c], deltaFrames: (s.b % 200) - 100 },
							{ type: 'clip.trim', clipId: c, edge: 'out', deltaFrames: (s.b % 40) - 20 },
							{ type: 'clip.lift', clipIds: [c] },
							{ type: 'clip.split', at: s.b, clipIds: [c] },
							{ type: 'param.set', target: ['clip', c, 'opacity'], value: s.b % 100 },
						][s.k]!;
						const r = applyTransaction(
							doc,
							{ label: 'x', origin: 'user', sequenceId: h.seqId, commands: [cmd] },
							makeCtx({}, ids),
						);
						doc = r.document;
						const next = doc.sequences[h.seqId]!;
						const full = fresh(next, n++);
						for (const t of allTrackIds(next)) expect(clipsOnTrack(next, t)).toEqual(clipsOnTrack(full, t));
						if (next.clips !== seq.clips) {
							const touched = new Set(
								[...Object.keys(next.clips), ...Object.keys(seq.clips)]
									.filter((k) => next.clips[k] !== seq.clips[k])
									.flatMap((k) => [next.clips[k]?.trackId, seq.clips[k]?.trackId]),
							);
							for (const t of allTrackIds(next))
								if (!touched.has(t)) expect(clipsOnTrack(next, t)).toBe(clipsOnTrack(seq, t));
						}
					}
				},
			),
			{ numRuns: 150, seed: 20261008 },
		);
	});
});
