import { describe, expect, it } from 'vitest';
import { type Clip, checkInvariants, flicksPerFrame, RATES } from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = flicksPerFrame(RATES.r30);
const fl = (frames: number) => ({ flicks: frames * F });

function mediaItem(h: Harness, seconds = 20, audio = true): { itemId: string; mediaId: string } {
	const mediaId = h.registerVideo({ seconds, audio });
	const itemId = Object.values(h.doc.items).find((i) => i.kind === 'media' && i.mediaId === mediaId)!.id;
	return { itemId, mediaId };
}

const clipsOf = (h: Harness, ids: string[]) => ids.map((id) => h.seq.clips[id] as Clip);
const span = (c: Clip) => [c.start, c.start + c.duration];

function edit(h: Harness, args: Record<string, unknown>) {
	const r = h.ok([{ type: 'clip.sourceEdit', ...args }]);
	return r.results[0] as { clipIds: string[]; at: number; frames: number; rate: number; end: number };
}

describe('three-point editing', () => {
	it('source In/Out at the playhead; the sequence In wins over the playhead', () => {
		const h = new Harness();
		const { itemId } = mediaItem(h);
		h.ok([{ type: 'item.setMarks', itemId, in: fl(30), out: fl(90) }]);
		let r = edit(h, { source: { projectItemId: itemId }, playhead: 100 });
		expect(r.at).toBe(100);
		expect(r.frames).toBe(60);
		expect(r.end).toBe(160);
		const [v, a] = clipsOf(h, r.clipIds) as [Clip, Clip];
		expect(span(v)).toEqual([100, 160]);
		expect(v.sourceIn).toBe(30 * F);
		expect(a.linkId).toBe(v.linkId);
		h.ok([{ type: 'sequence.setInOut', in: 300, out: null }]);
		r = edit(h, { source: { projectItemId: itemId }, playhead: 10 });
		expect(r.at).toBe(300);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('backtiming: a sequence Out alone ends the edit there', () => {
		const h = new Harness();
		const { itemId } = mediaItem(h);
		h.ok([{ type: 'item.setMarks', itemId, in: fl(30), out: fl(90) }]);
		h.ok([{ type: 'sequence.setInOut', in: null, out: 500 }]);
		const r = edit(h, { source: { projectItemId: itemId }, playhead: 0 });
		expect([r.at, r.frames]).toEqual([440, 60]);
		expect(r.end).toBe(500);
	});

	it('source Out + sequence In/Out backtimes the source', () => {
		const h = new Harness();
		const { itemId } = mediaItem(h);
		h.ok([{ type: 'item.setMarks', itemId, in: null, out: fl(200) }]);
		h.ok([{ type: 'sequence.setInOut', in: 100, out: 150 }]);
		const r = edit(h, { source: { projectItemId: itemId } });
		const [v] = clipsOf(h, r.clipIds) as [Clip];
		expect(span(v)).toEqual([100, 150]);
		expect(v.sourceIn).toBe(150 * F);
	});

	it('source In + sequence In/Out takes the sequence duration; too little media is refused', () => {
		const h = new Harness();
		const { itemId } = mediaItem(h, 4);
		h.ok([{ type: 'item.setMarks', itemId, in: fl(30), out: null }]);
		h.ok([{ type: 'sequence.setInOut', in: 0, out: 50 }]);
		const r = edit(h, { source: { projectItemId: itemId } });
		expect(r.frames).toBe(50);
		h.ok([{ type: 'sequence.setInOut', in: 0, out: 200 }]);
		const bad = h.tx([{ type: 'clip.sourceEdit', source: { projectItemId: itemId } }]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors[0]!.code).toBe('E_OUT_OF_MEDIA');
	});

	it('insert ripples the sequence once; overwrite does not', () => {
		const h = new Harness();
		const { itemId } = mediaItem(h);
		edit(h, { source: { projectItemId: itemId }, sourceIn: fl(0), sourceOut: fl(100), playhead: 0 });
		h.ok([{ type: 'item.setMarks', itemId, in: fl(0), out: fl(10) }]);
		edit(h, { source: { projectItemId: itemId }, playhead: 50, mode: 'insert' });
		expect(h.spans('V1')).toEqual([
			[0, 50],
			[50, 60],
			[60, 110],
		]);
		expect(h.spans('A1')).toEqual(h.spans('V1'));
	});
});

describe('four-point editing (Fit Clip)', () => {
	function setup() {
		const h = new Harness();
		const { itemId } = mediaItem(h);
		h.ok([{ type: 'item.setMarks', itemId, in: fl(30), out: fl(90) }]); // 60 frames
		h.ok([{ type: 'sequence.setInOut', in: 100, out: 130 }]); // 30 frames
		return { h, itemId };
	}
	it('without a choice the edit is refused', () => {
		const { h, itemId } = setup();
		const r = h.tx([{ type: 'clip.sourceEdit', source: { projectItemId: itemId } }]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors[0]!.message).toMatch(/fit/);
	});
	it('change-speed fits the source range into the sequence range (200%)', () => {
		const { h, itemId } = setup();
		const r = edit(h, { source: { projectItemId: itemId }, fit: 'change-speed' });
		expect(r.rate).toBe(2);
		const [v, a] = clipsOf(h, r.clipIds) as [Clip, Clip];
		expect(span(v)).toEqual([100, 130]);
		expect(v.speed.rate).toBe(2);
		expect(a.speed.rate).toBe(2);
		expect(v.sourceIn).toBe(30 * F);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
	it('ignore-source-in / ignore-source-out', () => {
		{
			const { h, itemId } = setup();
			const r = edit(h, { source: { projectItemId: itemId }, fit: 'ignore-source-in' });
			const [v] = clipsOf(h, r.clipIds) as [Clip];
			expect(span(v)).toEqual([100, 130]);
			expect(v.sourceIn).toBe(60 * F);
		}
		{
			const { h, itemId } = setup();
			const r = edit(h, { source: { projectItemId: itemId }, fit: 'ignore-source-out' });
			const [v] = clipsOf(h, r.clipIds) as [Clip];
			expect(span(v)).toEqual([100, 130]);
			expect(v.sourceIn).toBe(30 * F);
		}
	});
	it('ignore-sequence-in / ignore-sequence-out', () => {
		{
			const { h, itemId } = setup();
			const r = edit(h, { source: { projectItemId: itemId }, fit: 'ignore-sequence-in' });
			expect(span(clipsOf(h, r.clipIds)[0]!)).toEqual([70, 130]);
		}
		{
			const { h, itemId } = setup();
			const r = edit(h, { source: { projectItemId: itemId }, fit: 'ignore-sequence-out' });
			expect(span(clipsOf(h, r.clipIds)[0]!)).toEqual([100, 160]);
		}
	});
});

describe('split edits and source patching', () => {
	it('video and audio take their own source ranges, offset by the In difference (J cut)', () => {
		const h = new Harness();
		const { itemId } = mediaItem(h);
		h.ok([
			{
				type: 'item.setMarks',
				itemId,
				in: fl(60),
				out: fl(120),
				split: { audioIn: fl(45) },
			},
		]);
		const r = edit(h, { source: { projectItemId: itemId }, playhead: 200, mode: 'insert' });
		const [v, a] = clipsOf(h, r.clipIds) as [Clip, Clip];
		expect(span(v)).toEqual([215, 275]);
		expect(span(a)).toEqual([200, 275]);
		expect(v.sourceIn).toBe(60 * F);
		expect(a.sourceIn).toBe(45 * F);
		expect(v.linkId).toBe(a.linkId);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('Mark Split marks can be cleared', () => {
		const h = new Harness();
		const { itemId } = mediaItem(h);
		h.ok([{ type: 'item.setMarks', itemId, in: null, out: null, split: { videoOut: fl(50) } }]);
		const item = h.doc.items[itemId] as { marks: { split?: { videoOut?: { flicks: number } | null } } };
		expect(item.marks.split?.videoOut).toEqual(fl(50));
		h.ok([{ type: 'item.setMarks', itemId, in: null, out: null, split: null }]);
		expect((h.doc.items[itemId] as { marks: { split?: unknown } }).marks.split).toBeUndefined();
	});

	it('patching sends source tracks to other tracks or turns them off', () => {
		const h = new Harness();
		const { itemId } = mediaItem(h);
		let r = edit(h, {
			source: { projectItemId: itemId },
			sourceIn: fl(0),
			sourceOut: fl(30),
			patch: { video: ['V2'], audio: ['A3'] },
		});
		const [v, a] = clipsOf(h, r.clipIds) as [Clip, Clip];
		expect(v.trackId).toBe(h.seq.videoTracks[1]!.id);
		expect(a.trackId).toBe(h.seq.audioTracks[2]!.id);
		r = edit(h, {
			source: { projectItemId: itemId },
			sourceIn: fl(0),
			sourceOut: fl(30),
			playhead: 100,
			patch: { video: [null], audio: ['A1'] },
		});
		expect(clipsOf(h, r.clipIds).map((c) => c.kind)).toEqual(['audio']);
	});
});

describe('sequences as sources', () => {
	function withSource() {
		const h = new Harness();
		const { itemId } = mediaItem(h);
		const main = h.seqId;
		const r = h.ok([{ type: 'sequence.create', name: 'Source', preset: 'hd-1080p-30' }]);
		const src = (r.results[0] as { sequenceId: string }).sequenceId;
		h.ok(
			[
				{
					type: 'clip.place',
					sequenceId: src,
					source: { projectItemId: itemId },
					at: 0,
					sourceRange: { in: fl(0), out: fl(40) },
				},
				{
					type: 'clip.place',
					sequenceId: src,
					source: { projectItemId: itemId },
					at: 40,
					sourceRange: { in: fl(100), out: fl(140) },
				},
			],
			{},
		);
		return { h, main, src };
	}
	it('as a nest: one linked nest-video / nest-audio pair over the marked range', () => {
		const { h, main, src } = withSource();
		h.ok([{ type: 'sequence.setInOut', sequenceId: src, in: 10, out: 70 }]);
		const r = h.ok([{ type: 'clip.sourceEdit', sequenceId: main, source: { sequenceId: src }, playhead: 5 }]);
		const res = r.results[0] as { clipIds: string[] };
		const seq = h.doc.sequences[main]!;
		const [nv, na] = res.clipIds.map((id) => seq.clips[id]!) as [Clip, Clip];
		expect(nv.kind).toBe('nest-video');
		expect(na.kind).toBe('nest-audio');
		expect([nv.start, nv.duration, nv.sourceIn]).toEqual([5, 60, 10 * F]);
		expect(nv.linkId).toBe(na.linkId);
		expect(checkInvariants(h.doc)).toEqual([]);
		const self = h.tx([{ type: 'clip.sourceEdit', sequenceId: main, source: { sequenceId: main } }]);
		expect(self.ok).toBe(false);
		const loop = h.tx([{ type: 'clip.sourceEdit', sequenceId: src, source: { sequenceId: main } }]);
		expect(loop.ok).toBe(false);
		if (!loop.ok) expect(loop.errors[0]!.code).toBe('E_CYCLE');
	});
	it('as individual clips: trimmed copies with their links', () => {
		const { h, main, src } = withSource();
		h.ok([{ type: 'sequence.setInOut', sequenceId: src, in: 30, out: 50 }]);
		const r = h.ok([
			{
				type: 'clip.sourceEdit',
				sequenceId: main,
				source: { sequenceId: src },
				sequenceAs: 'clips',
				playhead: 100,
			},
		]);
		const ids = (r.results[0] as { clipIds: string[] }).clipIds;
		const seq = h.doc.sequences[main]!;
		const copies = ids.map((id) => seq.clips[id]!);
		expect(copies).toHaveLength(4);
		const v = copies.filter((c) => c.kind === 'video').sort((a, b) => a.start - b.start);
		expect(v.map((c) => [c.start, c.duration, c.sourceIn])).toEqual([
			[100, 10, 30 * F],
			[110, 10, 100 * F],
		]);
		for (const c of v) expect(seq.links[c.linkId!]!.members).toHaveLength(2);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('subclips', () => {
	it('make, edit in, restrict trims, update and delete', () => {
		const h = new Harness();
		const { itemId } = mediaItem(h);
		const r = h.ok([
			{ type: 'item.makeSubclip', itemId, in: fl(60), out: fl(120), name: 'Take 2', restrictTrims: true },
		]);
		const sub = (r.results[0] as { itemId: string }).itemId;
		expect(h.doc.items[sub]).toMatchObject({ kind: 'subclip', name: 'Take 2', parentItemId: itemId });
		const e = edit(h, { source: { projectItemId: sub }, playhead: 0 });
		const [v] = clipsOf(h, e.clipIds) as [Clip];
		expect([v.duration, v.sourceIn, v.subclipId]).toEqual([60, 60 * F, sub]);
		const t = h.tx([{ type: 'clip.trim', clipId: v.id, edge: 'out', deltaFrames: 30 }]);
		expect(t.ok ? null : t.errors[0]!.code).toBe('E_OUT_OF_MEDIA');
		h.ok([{ type: 'item.updateSubclip', itemId: sub, restrictTrims: false }]);
		const t2 = h.ok([{ type: 'clip.trim', clipId: v.id, edge: 'out', deltaFrames: 30 }]);
		expect((t2.results[0] as { deltaFrames: number }).deltaFrames).toBe(30);
		h.ok([{ type: 'item.updateSubclip', itemId: sub, restrictTrims: true, out: fl(150) }]);
		const bad = h.tx([{ type: 'item.updateSubclip', itemId: sub, out: fl(100) }]);
		expect(bad.ok).toBe(false);
		const r2 = h.ok([{ type: 'item.makeSubclip', itemId: sub, in: fl(70), out: fl(80) }]);
		const sub2 = (r2.results[0] as { itemId: string }).itemId;
		expect(h.doc.items[sub2]).toMatchObject({ parentItemId: itemId, name: 'Take 2.Subclip' });
		const outside = h.tx([{ type: 'item.makeSubclip', itemId: sub, in: fl(10), out: fl(80) }]);
		expect(outside.ok).toBe(false);
		h.ok([{ type: 'item.delete', itemIds: [sub] }]);
		expect(h.seq.clips[v.id]?.subclipId).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
		h.ok([{ type: 'item.delete', itemIds: [itemId], force: true }]);
		expect(h.doc.items[sub2]).toMatchObject({ parentItemId: null });
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('clip.trimEdits (keyboard trim mode)', () => {
	function cut() {
		const h = new Harness();
		const { itemId } = mediaItem(h);
		for (const t of ['V2', 'V3', 'A2', 'A3'])
			h.ok([{ type: 'track.update', trackId: t, patch: { syncLock: false } }]);
		edit(h, { source: { projectItemId: itemId }, sourceIn: fl(30), sourceOut: fl(90), playhead: 0 });
		edit(h, { source: { projectItemId: itemId }, sourceIn: fl(200), sourceOut: fl(260), playhead: 60 });
		return h;
	}
	it('ripple edit points on V1 and A1 (unlinked selection) ripple as one edit', () => {
		const h = cut();
		const [v1] = h.clips('V1');
		const [a1] = h.clips('A1');
		const r = h.ok([
			{
				type: 'clip.trimEdits',
				edits: [
					{ clipId: v1!.id, edge: 'out', mode: 'ripple' },
					{ clipId: a1!.id, edge: 'out', mode: 'ripple' },
				],
				deltaFrames: 5,
				linked: false,
			},
		]);
		expect((r.results[0] as { deltaFrames: number }).deltaFrames).toBe(5);
		expect(h.spans('V1')).toEqual([
			[0, 65],
			[65, 125],
		]);
		expect(h.spans('A1')).toEqual(h.spans('V1'));
	});
	it('roll and regular points move in lockstep (the tightest limit wins)', () => {
		const h = cut();
		const [, v2] = h.clips('V1');
		const r = h.ok([
			{
				type: 'clip.trimEdits',
				edits: [{ clipId: v2!.id, edge: 'in', mode: 'roll' }],
				deltaFrames: -40,
			},
		]);
		// The incoming clip has 200 frames of head, the outgoing 60 frames of content: the roll is limited by
		// the outgoing clip's duration (59 frames left at least 1).
		expect((r.results[0] as { deltaFrames: number }).deltaFrames).toBe(-40);
		expect(h.spans('V1')).toEqual([
			[0, 20],
			[20, 120],
		]);
		expect(h.spans('A1')).toEqual(h.spans('V1'));
		const bad = h.tx([
			{
				type: 'clip.trimEdits',
				edits: [
					{ clipId: h.clips('V1')[0]!.id, edge: 'out', mode: 'regular' },
					{ clipId: h.clips('V1')[1]!.id, edge: 'in', mode: 'regular' },
				],
				deltaFrames: 1,
			},
		]);
		expect(bad.ok).toBe(false);
	});
	it('roll points on a picture and its linked sound roll once (not once per point)', () => {
		const h = cut();
		const [v1] = h.clips('V1');
		const [a1] = h.clips('A1');
		h.ok([
			{
				type: 'clip.trimEdits',
				edits: [
					{ clipId: v1!.id, edge: 'out', mode: 'roll' },
					{ clipId: a1!.id, edge: 'out', mode: 'roll' },
				],
				deltaFrames: 6,
			},
		]);
		expect(h.spans('V1')).toEqual([
			[0, 66],
			[66, 120],
		]);
		expect(h.spans('A1')).toEqual(h.spans('V1'));
	});
});
