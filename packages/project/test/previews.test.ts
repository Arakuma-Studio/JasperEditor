// Workstream `previews`: render-bar segments, the content-hash invalidation contract and the cost model
// (packages/project/src/render/previews.ts, docs/wp-notes/previews.md).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	audioPreviewSegments,
	flicksPerFrame,
	hash128,
	isPreviewHash,
	type ProjectDocument,
	previewSegmentAt,
	previewSegments,
	type RenderPreviewSegment,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F30 = flicksPerFrame({ num: 30, den: 1 });

function place(h: Harness, mediaId: string, at: number, track = 'V1', range?: [number, number]): string[] {
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId },
			at,
			tracks: { video: track },
			...(range ? { sourceRange: { in: { flicks: range[0] * F30 }, out: { flicks: range[1] * F30 } } } : {}),
		},
	]);
	return (r.results[0] as { clipIds: string[] }).clipIds;
}

const segs = (doc: ProjectDocument, seq: string) => previewSegments(doc, seq);
const hashes = (s: readonly RenderPreviewSegment[]) => s.map((x) => x.hash);
const byStart = (s: readonly RenderPreviewSegment[], f: number) => previewSegmentAt(s, f)!;

/** Two clips on V1 with a gap, a third on V2 over the first one's tail. */
function timeline() {
	const h = new Harness();
	const m = h.registerVideo({ seconds: 20 });
	const [a, aAudio] = place(h, m, 0, 'V1', [0, 90]);
	const [b] = place(h, m, 120, 'V1', [200, 260]);
	const [c] = place(h, m, 60, 'V2', [300, 330]);
	return { h, m, a: a!, aAudio: aAudio!, b: b!, c: c! };
}

describe('hash128', () => {
	it('is 32 hex digits, deterministic and sensitive to every character', () => {
		expect(isPreviewHash(hash128(''))).toBe(true);
		expect(hash128('abc')).toBe(hash128('abc'));
		expect(hash128('abc')).not.toBe(hash128('abd'));
		expect(hash128('ab')).not.toBe(hash128('ba'));
		const seen = new Set<string>();
		for (let i = 0; i < 5000; i++) seen.add(hash128(`segment-${i}`));
		expect(seen.size).toBe(5000);
	});
});

describe('segments', () => {
	it('cut at every clip edge; gaps give no segment', () => {
		const { h } = timeline();
		const s = segs(h.doc, h.seqId);
		expect(s.map((x) => [x.startFrame, x.frames])).toEqual([
			[0, 60],
			[60, 30],
			[120, 60],
		]);
		for (const x of s) expect(isPreviewHash(x.hash)).toBe(true);
		expect(new Set(hashes(s)).size).toBe(3);
		expect(byStart(s, 75).clipIds.sort()).toEqual([h.clips('V1')[0]!.id, h.clips('V2')[0]!.id].sort());
		expect(previewSegmentAt(s, 130)).toBe(s[2]);
		expect(previewSegmentAt(s, 100)).toBeNull();
		expect(previewSegmentAt(s, 180)).toBeNull();
	});

	it('an untouched clip at the sequence size and rate has no bar; Motion, effects and stacks do', () => {
		const { h, a, c } = timeline();
		let s = segs(h.doc, h.seqId);
		expect(byStart(s, 0).need).toBe('none');
		expect(byStart(s, 0).reasons).toEqual([]);
		expect(byStart(s, 60).need).not.toBe('none'); // two layers
		h.ok([{ type: 'param.set', target: ['clip', a, 'transform', 'scale'], value: 50 }]);
		s = segs(h.doc, h.seqId);
		expect(byStart(s, 0).need).toBe('realtime');
		h.ok([{ type: 'effect.add', target: { clipId: c }, effectId: 'jasper.gaussian-blur' }]);
		s = segs(h.doc, h.seqId);
		expect(byStart(s, 60).costMs).toBeGreaterThan(byStart(s, 0).costMs);
	});

	it('expensive effect stacks are red, with the reasons named', () => {
		const { h, a } = timeline();
		const heavy = ['jasper.gaussian-blur', 'jasper.gaussian-blur', 'jasper.gaussian-blur'];
		for (const effectId of heavy) h.ok([{ type: 'effect.add', target: { clipId: a }, effectId }]);
		const s = byStart(segs(h.doc, h.seqId), 0);
		expect(s.costMs).toBeGreaterThan(0);
		expect(s.reasons.length).toBeGreaterThan(0);
		expect(['realtime', 'render']).toContain(s.need);
		expect(s.budgetMs).toBeCloseTo(1000 / 30, 1);
	});
});

describe('content hash: invalidation contract', () => {
	it('a ripple keeps every hash (positions are relative to the segment start)', () => {
		const { h, a, b, c } = timeline();
		const before = segs(h.doc, h.seqId);
		h.ok([{ type: 'clip.move', clipIds: [a, b, c], deltaFrames: 45 }]);
		const after = segs(h.doc, h.seqId);
		expect(after.map((x) => x.startFrame)).toEqual(before.map((x) => x.startFrame + 45));
		expect(hashes(after)).toEqual(hashes(before));
	});

	it('an edit changes only the segments that show the edited clip; undo restores them', () => {
		const { h, b } = timeline();
		const d0 = h.doc;
		const before = segs(d0, h.seqId);
		h.ok([{ type: 'effect.add', target: { clipId: b }, effectId: 'jasper.gaussian-blur' }]);
		const after = segs(h.doc, h.seqId);
		expect(after.slice(0, 2).map((x) => x.hash)).toEqual(before.slice(0, 2).map((x) => x.hash));
		expect(after[2]!.hash).not.toBe(before[2]!.hash);
		// undo = the previous document value: the same hashes come back
		expect(hashes(segs(structuredClone(d0), h.seqId))).toEqual(hashes(before));
	});

	it('names, labels and markers do not change pixels; renaming a clip with effects does (Clip Name burn-ins)', () => {
		const { h, a, b } = timeline();
		const before = hashes(segs(h.doc, h.seqId));
		h.ok([{ type: 'clip.update', clipId: a, patch: { name: 'Renamed', label: 'violet' } }]);
		h.ok([{ type: 'marker.add', frame: 10, name: 'note' }]);
		h.ok([{ type: 'marker.add', clipId: a, frame: 10, name: 'clip note' }]);
		expect(hashes(segs(h.doc, h.seqId))).toEqual(before);
		h.ok([{ type: 'effect.add', target: { clipId: b }, effectId: 'jasper.gaussian-blur' }]);
		const withFx = segs(h.doc, h.seqId);
		h.ok([{ type: 'clip.update', clipId: b, patch: { name: 'B renamed' } }]);
		const renamed = segs(h.doc, h.seqId);
		expect(renamed[2]!.hash).not.toBe(withFx[2]!.hash);
	});

	it('identical plain clips share a hash anywhere; seeded clips (effects) keep their identity', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [a] = place(h, m, 0, 'V1', [0, 30]);
		h.ok([{ type: 'clip.duplicate', clipIds: [a!], at: 100 }]);
		let s = segs(h.doc, h.seqId);
		expect(s).toHaveLength(2);
		expect(s[0]!.hash).toBe(s[1]!.hash);
		h.ok([{ type: 'effect.add', target: { clipId: a! }, effectId: 'jasper.gaussian-blur' }]);
		const copy = h.clips('V1').find((x) => x.id !== a)!.id;
		h.ok([{ type: 'effect.add', target: { clipId: copy }, effectId: 'jasper.gaussian-blur' }]);
		s = segs(h.doc, h.seqId);
		// fx noise is seeded by clip and effect ids: two copies may draw different grain
		expect(s[0]!.hash).not.toBe(s[1]!.hash);
	});

	it('a muted or hidden track, a new empty track and the audio mix leave the picture hashes alone', () => {
		const { h, a } = timeline();
		const before = hashes(segs(h.doc, h.seqId));
		h.ok([{ type: 'track.add', kind: 'video', index: 0 }]);
		h.ok([{ type: 'track.add', kind: 'audio' }]);
		h.ok([{ type: 'param.set', target: ['clip', h.clips('A1')[0]!.id, 'volumeDb'], value: -6 }]);
		expect(hashes(segs(h.doc, h.seqId))).toEqual(before);
		void a;
	});

	it('media content counts, not URLs: another fingerprint invalidates', () => {
		const { h, m } = timeline();
		const before = hashes(segs(h.doc, h.seqId));
		const doc = structuredClone(h.doc) as ProjectDocument;
		(doc.media[m] as { fingerprint: string }).fingerprint = 'q1:relinked';
		const after = hashes(segs(doc, h.seqId));
		for (let i = 0; i < before.length; i++) expect(after[i]).not.toBe(before[i]);
	});

	it('sequence settings count', () => {
		const { h } = timeline();
		const before = hashes(segs(h.doc, h.seqId));
		const doc = structuredClone(h.doc) as ProjectDocument;
		doc.sequences[h.seqId]!.settings.backgroundColor = [1, 0, 0, 1];
		expect(hashes(segs(doc, h.seqId))[0]).not.toBe(before[0]);
	});

	it('adjustment layers: an edit below the adjustment invalidates the segments it covers', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [a] = place(h, m, 0, 'V1', [0, 60]);
		h.ok([{ type: 'clip.addAdjustment', at: 0, duration: 60, track: 'V2' }]);
		const adj = h.clips('V2')[0]!.id;
		h.ok([{ type: 'effect.add', target: { clipId: adj }, effectId: 'jasper.gaussian-blur' }]);
		const before = segs(h.doc, h.seqId);
		expect(before).toHaveLength(1);
		h.ok([{ type: 'param.set', target: ['clip', a!, 'opacity'], value: 50 }]);
		expect(segs(h.doc, h.seqId)[0]!.hash).not.toBe(before[0]!.hash);
	});

	it('nested sequences: edits inside the frames shown invalidate, edits outside them do not', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 30 });
		const [v1] = place(h, m, 0, 'V1', [0, 60]);
		const [v2] = place(h, m, 300, 'V1', [100, 160]);
		h.ok([{ type: 'clip.nest', clipIds: [v1!, v2!], name: 'N', ref: '$n' }]);
		// show only the first 60 nested frames
		const nest = h.clips('V1')[0]!;
		h.ok([{ type: 'clip.trim', clipId: nest.id, edge: 'out', deltaFrames: -(nest.duration - 60) }]);
		const before = segs(h.doc, h.seqId);
		expect(before).toHaveLength(1);
		const nestedSeq = Object.values(h.doc.sequences).find((s) => s.id !== h.seqId)!;
		const inner = Object.values(nestedSeq.clips).filter((c) => c.kind === 'video');
		const far = inner.find((c) => c.start >= 300)!;
		const near = inner.find((c) => c.start === 0)!;
		h.ok([{ type: 'effect.add', target: { clipId: far.id }, effectId: 'jasper.gaussian-blur' }], {});
		expect(segs(h.doc, h.seqId)[0]!.hash).toBe(before[0]!.hash);
		h.ok([{ type: 'effect.add', target: { clipId: near.id }, effectId: 'jasper.gaussian-blur' }]);
		expect(segs(h.doc, h.seqId)[0]!.hash).not.toBe(before[0]!.hash);
	});

	it('expressions: a segment whose layers read time is absolute; other segments ignore expressions', () => {
		const { h, a, b } = timeline();
		h.ok([{ type: 'expression.set', target: ['clip', b, 'transform', 'rotation'], text: 'time * 90' }]);
		const s0 = segs(h.doc, h.seqId);
		expect(byStart(s0, 130).absolute).toBe(true);
		expect(byStart(s0, 0).absolute).toBe(false);
		// moving the expressive clip changes what `time` gives it
		h.ok([{ type: 'clip.move', clipIds: [b], deltaFrames: 10 }]);
		const s1 = segs(h.doc, h.seqId);
		expect(byStart(s1, 140).hash).not.toBe(byStart(s0, 130).hash);
		expect(byStart(s1, 0).hash).toBe(byStart(s0, 0).hash);
		// an expression may read any other layer: an edit elsewhere invalidates the expressive segment
		h.ok([{ type: 'param.set', target: ['clip', a, 'opacity'], value: 40 }]);
		const s2 = segs(h.doc, h.seqId);
		expect(byStart(s2, 140).hash).not.toBe(byStart(s1, 140).hash);
	});

	it('Track Matte Keys read a hidden track: editing the matte invalidates; moving everything keeps', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [a] = place(h, m, 0, 'V1', [0, 60]);
		const v2 = h.seq.videoTracks[1]!.id;
		h.ok([{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V2', color: [1, 1, 1, 1] }]);
		const matte = h.clips('V2')[0]!.id;
		h.ok([
			{
				type: 'effect.add',
				target: { clipId: a! },
				effectId: 'jasper.track-matte-key',
				params: { matteTrack: v2 },
			},
			{ type: 'track.update', trackId: v2, patch: { output: false } },
		]);
		const before = segs(h.doc, h.seqId);
		expect(before).toHaveLength(1);
		h.ok([{ type: 'param.set', target: ['clip', matte, 'opacity'], value: 30 }]);
		const after = segs(h.doc, h.seqId);
		expect(after[0]!.hash).not.toBe(before[0]!.hash);
		h.ok([{ type: 'clip.move', clipIds: [a!, matte], deltaFrames: 20 }]);
		expect(segs(h.doc, h.seqId)[0]!.hash).toBe(after[0]!.hash);
	});

	it('captions are part of the picture: text edits invalidate, moving keeps', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		place(h, m, 0, 'V1', [0, 120]);
		h.ok([{ type: 'caption.addTrack', name: 'English', language: 'en' }]);
		h.ok([{ type: 'caption.add', at: 30, duration: 30, text: 'Hello' }]);
		const s0 = segs(h.doc, h.seqId);
		expect(s0.map((x) => x.startFrame)).toEqual([0, 30, 60]);
		const cap = Object.values(h.seq.clips).find((c) => c.kind === 'captions')!.id;
		h.ok([{ type: 'caption.setText', clipId: cap, text: 'Goodbye' }]);
		const s1 = segs(h.doc, h.seqId);
		expect(s1[1]!.hash).not.toBe(s0[1]!.hash);
		expect(s1[0]!.hash).toBe(s0[0]!.hash);
	});

	it('3D: a camera edit invalidates the segments it is on', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [a] = place(h, m, 0, 'V1', [0, 60]);
		h.ok([{ type: 'clip.set3d', clipIds: [a!], enabled: true }]);
		const cam = (h.ok([{ type: 'clip.addCamera', at: 0 }]).results[0] as { clipId: string }).clipId;
		const before = segs(h.doc, h.seqId);
		h.ok([{ type: 'camera.settings', clipId: cam, zoom: 900 }]);
		const after = segs(h.doc, h.seqId);
		expect(after[0]!.hash).not.toBe(before[0]!.hash);
		expect(after[0]!.costMs).toBeGreaterThan(0);
	});

	it('time remapping changes the picture', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [a] = place(h, m, 0, 'V1', [0, 90]);
		const before = segs(h.doc, h.seqId);
		h.ok([{ type: 'timeRemap.enable', clipIds: [a!], enabled: true }]);
		h.ok([{ type: 'timeRemap.setSpeed', clipId: a!, at: 10, speedPercent: 50 }]);
		const after = segs(h.doc, h.seqId);
		expect(after[0]!.hash).not.toBe(before[0]!.hash);
		expect(after[0]!.need).not.toBe('none');
	});

	it('property: moving the whole timeline by any offset keeps the hashes; any param edit on one clip changes only its segments', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 400 }),
				fc.integer({ min: 0, max: 2 }),
				fc.integer({ min: 10, max: 90 }),
				(delta, which, opacity) => {
					const { h, a, b, c } = timeline();
					const ids = [a, b, c];
					const before = segs(h.doc, h.seqId);
					h.ok([{ type: 'clip.move', clipIds: ids, deltaFrames: delta }]);
					const moved = segs(h.doc, h.seqId);
					expect(hashes(moved)).toEqual(hashes(before));
					const target = ids[which]!;
					h.ok([{ type: 'param.set', target: ['clip', target, 'opacity'], value: opacity }]);
					const edited = segs(h.doc, h.seqId);
					for (let i = 0; i < edited.length; i++) {
						const shows = moved[i]!.clipIds.includes(target);
						if (shows) expect(edited[i]!.hash).not.toBe(moved[i]!.hash);
						else expect(edited[i]!.hash).toBe(moved[i]!.hash);
					}
				},
			),
			{ numRuns: 25 },
		);
	});
});

describe('audio segments (Render Audio)', () => {
	it('cut at audio clip edges; ripple keeps hashes; a level change invalidates only that clip', () => {
		const { h, a, b, c } = timeline();
		const before = audioPreviewSegments(h.doc, h.seqId);
		expect(before.length).toBeGreaterThanOrEqual(2);
		for (const s of before) expect(isPreviewHash(s.hash)).toBe(true);
		h.ok([{ type: 'clip.move', clipIds: [a, b, c], deltaFrames: 33 }]);
		const moved = audioPreviewSegments(h.doc, h.seqId);
		expect(moved.map((s) => s.hash)).toEqual(before.map((s) => s.hash));
		const first = h.clips('A1')[0]!.id;
		h.ok([{ type: 'param.set', target: ['clip', first, 'volumeDb'], value: -12 }]);
		const after = audioPreviewSegments(h.doc, h.seqId);
		expect(after[0]!.hash).not.toBe(moved[0]!.hash);
		expect(after[after.length - 1]!.hash).toBe(moved[moved.length - 1]!.hash);
		// picture hashes ignore audio
		expect(hashes(segs(h.doc, h.seqId))).toEqual(hashes(segs(h.doc, h.seqId)));
	});
});
