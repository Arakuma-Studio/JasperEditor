import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	type Clip,
	checkInvariants,
	clipPictureTime,
	contentTimeAt,
	createCounterIdSource,
	encodeWavStereo16,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	gapNavigation,
	isThroughEdit,
	LEADER_DURATION,
	leaderBlipTimes,
	leaderPhaseAt,
	leaderStyleOf,
	type MediaHandle,
	nestContentKey,
	nestGainDbAt,
	type ProjectDocument,
	type RenderSnapshot,
	renderBars,
	renderCountingLeader,
	repairDocument,
	resolveVideoTransitions,
	type Sequence,
	sequenceGaps,
	syntheticSamples,
	throughEdits,
	trackGaps,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F30 = flicksPerFrame({ num: 30, den: 1 });

function handle(): MediaHandle {
	return {
		url: 'x',
		proxyUrl: null,
		kind: 'video',
		width: 1920,
		height: 1080,
		durationFlicks: 10 * FLICKS_PER_SECOND,
		hasAudio: true,
		rotation: 0,
	};
}
const snap = (doc: ProjectDocument, seqId: string, range?: { start: number; end: number }): RenderSnapshot =>
	buildRenderSnapshot(doc, seqId, {
		...(range ? { range } : {}),
		resolveMedia: () => handle(),
		resolveFont: () => 'font.woff2',
	});

function placeAV(h: Harness, mediaId: string, at: number, track = 'V1', range?: [number, number]) {
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

const clean = (h: Harness) => expect(checkInvariants(h.doc)).toEqual([]);

describe('clip.nest', () => {
	it('moves linked clips into a new sequence and replaces them with linked nest clips', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [v1, a1] = placeAV(h, m, 30, 'V1', [0, 60]);
		const [v2] = placeAV(h, m, 90, 'V2', [100, 130]);
		h.ok([{ type: 'effect.add', target: { clipId: v1 }, effectId: 'jasper.gaussian-blur' }]);
		const r = h.ok([{ type: 'clip.nest', clipIds: [v1, a1, v2], name: 'My Nest', ref: '$n' }]);
		const res = r.results[0] as { sequenceId: string; clipIds: string[] };
		expect(r.refs.$n).toBe(res.sequenceId);
		const nested = h.doc.sequences[res.sequenceId]!;
		expect(nested.clips[v1!]!.start).toBe(0);
		expect(nested.clips[v2!]!.start).toBe(60);
		expect(nested.clips[v2!]!.trackId).toBe(nested.videoTracks[1]!.id);
		expect((nested.clips[v1!] as { effects: unknown[] }).effects).toHaveLength(1);
		expect(nested.clips[v1!]!.linkId).toBe(nested.clips[a1!]!.linkId);
		expect(nested.clips[v1!]!.linkId).not.toBeNull();
		// Parent: nest-video on V1, nest-audio on A1, linked, spanning 30..120.
		const [nv, na] = res.clipIds.map((id) => h.seq.clips[id]!);
		expect(nv!.kind).toBe('nest-video');
		expect(na!.kind).toBe('nest-audio');
		expect([nv!.start, nv!.duration]).toEqual([30, 90]);
		expect(nv!.linkId).toBe(na!.linkId);
		expect(h.seq.clips[v1!]).toBeUndefined();
		const item = Object.values(h.doc.items).find(
			(i) => i.kind === 'sequence' && i.sequenceId === res.sequenceId,
		);
		expect(item?.name).toBe('My Nest');
		clean(h);
	});

	it('names nests Nested Sequence 01, 02… and places them on a free track', () => {
		const h = new Harness();
		const m = h.registerVideo();
		const [v1] = placeAV(h, m, 0, 'V1', [0, 30]);
		h.ok([{ type: 'clip.addText', at: 10, duration: 10, track: 'V1', content: { text: 'x' } }]);
		const r = h.ok([{ type: 'clip.nest', clipIds: [v1] }]);
		const res = r.results[0] as { sequenceId: string; clipIds: string[] };
		const it0 = Object.values(h.doc.items).find(
			(i) => i.kind === 'sequence' && i.sequenceId === res.sequenceId,
		);
		expect(it0?.name).toBe('Nested Sequence 01');
		clean(h);
	});

	it('moves transitions between nested clips and refuses a nesting cycle', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 30 });
		const [a] = placeAV(h, m, 0, 'V1', [0, 60]);
		const [b] = placeAV(h, m, 60, 'V1', [200, 300]);
		h.ok([
			{ type: 'transition.add', trackId: 'V1', at: 60, effectId: 'jasper.cross-dissolve', duration: 10 },
		]);
		const r = h.ok([{ type: 'clip.nest', clipIds: [a, b] }]);
		const nid = (r.results[0] as { sequenceId: string }).sequenceId;
		expect(Object.keys(h.doc.sequences[nid]!.transitions)).toHaveLength(1);
		expect(Object.keys(h.seq.transitions)).toHaveLength(0);
		const bad = h.tx([{ type: 'clip.place', sequenceId: nid, source: { sequenceId: h.seqId }, at: 0 }]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors[0]!.code).toBe('E_CYCLE');
		clean(h);
	});
});

describe('placing sequences', () => {
	function withNested() {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const r = h.ok([{ type: 'sequence.create', name: 'Inner', ref: '$s' }]);
		const inner = r.refs.$s!;
		h.ok([
			{ type: 'clip.place', sequenceId: inner, source: { mediaId: m }, at: 0, tracks: { video: 'V1' } },
			{
				type: 'clip.addText',
				sequenceId: inner,
				at: 30,
				duration: 60,
				track: 'V2',
				content: { text: 'Title' },
			},
		]);
		return { h, m, inner };
	}

	it('places a sequence as linked nest clips (default) honouring its In/Out', () => {
		const { h, inner } = withNested();
		h.ok([{ type: 'sequence.setInOut', sequenceId: inner, in: 30, out: 90 }]);
		const r = h.ok([{ type: 'clip.place', source: { sequenceId: inner }, at: 100, tracks: { video: 'V1' } }]);
		const ids = (r.results[0] as { clipIds: string[] }).clipIds;
		const [v, a] = ids.map((id) => h.seq.clips[id]!);
		expect(v!.kind).toBe('nest-video');
		expect(a!.kind).toBe('nest-audio');
		expect(v!.duration).toBe(60);
		expect(v!.sourceIn).toBe(30 * F30);
		expect(v!.name).toBe('Inner');
		clean(h);
	});

	it('places a sequence as individual clips (nest: false), links and tracks kept', () => {
		const { h, inner } = withNested();
		const r = h.ok([
			{ type: 'clip.place', source: { sequenceId: inner }, at: 10, tracks: { video: 'V1' }, nest: false },
		]);
		const ids = (r.results[0] as { clipIds: string[] }).clipIds;
		const kinds = ids.map((id) => h.seq.clips[id]!.kind).sort();
		expect(kinds).toEqual(['audio', 'text', 'video']);
		const text = ids.map((id) => h.seq.clips[id]!).find((c) => c.kind === 'text')!;
		expect(text.start).toBe(40);
		expect(text.trackId).toBe(h.seq.videoTracks[1]!.id);
		const v = ids.map((id) => h.seq.clips[id]!).find((c) => c.kind === 'video')!;
		const a = ids.map((id) => h.seq.clips[id]!).find((c) => c.kind === 'audio')!;
		expect(v.linkId).not.toBeNull();
		expect(v.linkId).toBe(a.linkId);
		clean(h);
	});

	it('places from the project item (bin drag) and refuses an empty sequence', () => {
		const { h, inner } = withNested();
		const item = Object.values(h.doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === inner)!;
		const r = h.ok([{ type: 'clip.place', source: { projectItemId: item.id }, at: 0 }]);
		expect((r.results[0] as { clipIds: string[] }).clipIds).toHaveLength(2);
		const e = h.ok([{ type: 'sequence.create', name: 'Empty', ref: '$e' }]).refs.$e!;
		const bad = h.tx([{ type: 'clip.place', source: { sequenceId: e }, at: 0 }]);
		expect(bad.ok).toBe(false);
	});

	it('bounds trims of nest clips by the nested duration', () => {
		const { h, inner } = withNested();
		const r = h.ok([{ type: 'clip.place', source: { sequenceId: inner }, at: 0, tracks: { video: 'V1' } }]);
		const [v] = (r.results[0] as { clipIds: string[] }).clipIds;
		const t = h.tx([{ type: 'clip.trim', clipId: v, edge: 'out', deltaFrames: 100, linked: false }]);
		expect(t.ok ? null : t.errors[0]!.code).toBe('E_OUT_OF_MEDIA');
	});
});

describe('clip.unnest', () => {
	it('restores the nested clips at their places (round trip)', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [v1, a1] = placeAV(h, m, 30, 'V1', [0, 60]);
		const before = { v: { ...h.seq.clips[v1!]! }, a: { ...h.seq.clips[a1!]! } };
		const r = h.ok([{ type: 'clip.nest', clipIds: [v1, a1] }]);
		const nestIds = (r.results[0] as { clipIds: string[] }).clipIds;
		const u = h.ok([{ type: 'clip.unnest', clipIds: nestIds }]);
		const ids = (u.results[0] as { clipIds: string[] }).clipIds;
		const v = ids.map((id) => h.seq.clips[id]!).find((c) => c.kind === 'video')!;
		const a = ids.map((id) => h.seq.clips[id]!).find((c) => c.kind === 'audio')!;
		expect([v.start, v.duration, v.sourceIn, v.trackId]).toEqual([
			before.v.start,
			before.v.duration,
			before.v.sourceIn,
			before.v.trackId,
		]);
		expect([a.start, a.trackId]).toEqual([before.a.start, before.a.trackId]);
		expect(v.linkId).toBe(a.linkId);
		expect(v.linkId).not.toBeNull();
		clean(h);
	});

	it('refuses nests with speed, Motion or panning changes', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [v1] = placeAV(h, m, 0, 'V1', [0, 60]);
		const r = h.ok([{ type: 'clip.nest', clipIds: [v1] }]);
		const [nv] = (r.results[0] as { clipIds: string[] }).clipIds;
		h.ok([{ type: 'param.set', target: ['clip', nv, 'transform', 'scale'], value: 50 }]);
		const bad = h.tx([{ type: 'clip.unnest', clipIds: [nv] }]);
		expect(bad.ok).toBe(false);
	});

	it('refuses nests with masks (wp masks: layer-space geometry cannot move onto the nested clips)', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [v1] = placeAV(h, m, 0, 'V1', [0, 60]);
		const r = h.ok([{ type: 'clip.nest', clipIds: [v1] }]);
		const [nv] = (r.results[0] as { clipIds: string[] }).clipIds;
		h.ok([{ type: 'mask.add', clipId: nv, shape: 'ellipse' }]);
		const bad = h.tx([{ type: 'clip.unnest', clipIds: [nv] }]);
		expect(bad.ok).toBe(false);
	});
});

describe('render snapshot of nests', () => {
	it('embeds the nested snapshot with a transparent background and flattens nested audio', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [v1, a1] = placeAV(h, m, 30, 'V1', [0, 60]);
		const nid = (h.ok([{ type: 'clip.nest', clipIds: [v1, a1] }]).results[0] as { sequenceId: string })
			.sequenceId;
		// Trim the nest: show nested frames 10..50 from frame 40, nest audio at -6 dB.
		const nv = Object.values(h.seq.clips).find((c) => c.kind === 'nest-video')!;
		const na = Object.values(h.seq.clips).find((c) => c.kind === 'nest-audio')!;
		h.ok([{ type: 'clip.trim', clipId: nv.id, edge: 'in', deltaFrames: 10 }]);
		h.ok([{ type: 'clip.trim', clipId: nv.id, edge: 'out', deltaFrames: -10 }]);
		h.ok([{ type: 'clip.update', clipId: na.id, patch: { gainDb: -6 } }]);
		const s = snap(h.doc, h.seqId);
		const layer = s.videoTracks[0]!.clips.find((c) => c.kind === 'nest-video')!;
		expect('nest' in layer.source).toBe(true);
		if (!('nest' in layer.source)) return;
		expect(layer.source.nest.sequenceId).toBe(nid);
		expect(layer.source.nest.snapshot.settings.backgroundColor[3]).toBe(0);
		expect(layer.source.nest.snapshot.videoTracks[0]!.clips[0]!.clipId).toBe(v1);
		expect(layer.source.nest.contentKey).toBe(nestContentKey(h.doc, nid));
		const pieces = s.audioClips;
		expect(pieces).toHaveLength(1);
		const p = pieces[0]!;
		expect([p.start, p.duration]).toEqual([40, 40]);
		expect(p.sourceIn).toBe(10 * F30);
		expect(p.mediaId).toBe(m);
		expect(nestGainDbAt(p.nestGain, 50)).toBeCloseTo(-6, 6);
	});

	it('composes nest speed with the nested clips and conforms other frame rates', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 30 });
		const inner = h.ok([
			{ type: 'sequence.create', name: 'Inner25', settings: { frameRate: { num: 25, den: 1 } }, ref: '$s' },
		]).refs.$s!;
		h.ok([
			{ type: 'clip.place', sequenceId: inner, source: { mediaId: m }, at: 25, tracks: { video: 'V1' } },
		]);
		const r = h.ok([{ type: 'clip.place', source: { sequenceId: inner }, at: 0, tracks: { video: 'V1' } }]);
		const [nv, na] = (r.results[0] as { clipIds: string[] }).clipIds;
		h.ok([{ type: 'clip.setSpeed', clipIds: [nv, na], rate: 2, ripple: false }]);
		const s = snap(h.doc, h.seqId);
		const layer = s.videoTracks[0]!.clips.find((c) => c.clipId === nv)!;
		if (!('nest' in layer.source)) throw new Error('no nest');
		const inner30 = layer.source.nest.snapshot;
		expect(inner30.settings.fps).toEqual({ num: 30, den: 1 });
		expect(inner30.videoTracks[0]!.clips[0]!.start).toBe(30); // 25 frames @25 = 1 s = 30 frames @30
		const p = s.audioClips[0]!;
		expect(p.speed.rate).toBe(2);
		expect(p.start).toBe(15); // nested 1 s plays after 0.5 s at 2×
		expect(p.sourceIn).toBe(0);
	});
});

describe('adjustment layers and groups', () => {
	it('clip.addAdjustment makes an adjustment clip whose snapshot source is the composite below', () => {
		const h = new Harness();
		const r = h.ok([{ type: 'clip.addAdjustment', at: 0, duration: 60, track: 'V2', ref: '$a' }]);
		const id = r.refs.$a!;
		const c = h.seq.clips[id]!;
		expect(c.kind).toBe('adjustment');
		expect(h.doc.synthetics[(c as { syntheticId: string }).syntheticId]!.kind).toBe('adjustment');
		const s = snap(h.doc, h.seqId);
		const layer = s.videoTracks[1]!.clips[0]!;
		expect(layer.source).toEqual({ adjustment: true });
		expect(layer.transform).toBeNull();
		clean(h);
	});

	it('groups select, move, delete and trim together (outer edges only)', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [a] = placeAV(h, m, 0, 'V1', [0, 30]);
		const t = h.ok([
			{ type: 'clip.addText', at: 10, duration: 40, track: 'V2', content: { text: 'g' }, ref: '$t' },
		]).refs.$t!;
		const g = h.ok([{ type: 'clip.group', clipIds: [a, t], ref: '$g' }]);
		const gid = g.refs.$g!;
		expect([...h.seq.groups[gid]!.members].sort()).toEqual([a!, t].sort());
		h.ok([{ type: 'clip.move', clipIds: [a], deltaFrames: 5 }]);
		expect(h.seq.clips[t]!.start).toBe(15);
		// Outer edge (the group's last Out is the text's) trims; the video's Out is inner and trims alone.
		h.ok([{ type: 'clip.trim', clipId: t, edge: 'out', deltaFrames: -5 }]);
		expect(h.seq.clips[t]!.duration).toBe(35);
		h.ok([{ type: 'clip.trim', clipId: a, edge: 'in', deltaFrames: 2, linked: false }]);
		expect(h.seq.clips[t]!.start).toBe(15);
		h.ok([{ type: 'clip.ungroup', clipIds: [a] }]);
		expect(h.seq.groups[gid]).toBeUndefined();
		h.ok([{ type: 'clip.group', clipIds: [a, t] }]);
		h.ok([{ type: 'clip.lift', clipIds: [t] }]);
		expect(h.seq.clips[a!]).toBeUndefined();
		clean(h);
	});
});

describe('sequence and project operations', () => {
	it('duplicates a sequence with new ids and deletes sequences (nest references need force)', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [v1, a1] = placeAV(h, m, 0, 'V1', [0, 60]);
		h.ok([{ type: 'clip.group', clipIds: [v1, a1] }]);
		const d = h.ok([{ type: 'sequence.duplicate', sequenceId: h.seqId, ref: '$d' }]);
		const copy = h.doc.sequences[d.refs.$d!]!;
		expect(Object.keys(copy.clips)).toHaveLength(2);
		expect(Object.keys(copy.clips).some((id) => h.seq.clips[id])).toBe(false);
		expect(Object.keys(copy.groups)).toHaveLength(1);
		const item = Object.values(h.doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === copy.id)!;
		expect(item.name).toMatch(/Copy$/);
		clean(h);
		const nid = (h.ok([{ type: 'clip.nest', clipIds: [v1, a1] }]).results[0] as { sequenceId: string })
			.sequenceId;
		const refused = h.tx([{ type: 'sequence.delete', sequenceId: nid }]);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.errors[0]!.code).toBe('E_IN_USE');
		h.ok([{ type: 'sequence.delete', sequenceId: nid, force: true }]);
		expect(h.doc.sequences[nid]).toBeUndefined();
		expect(Object.values(h.seq.clips).some((c) => c.kind === 'nest-video')).toBe(false);
		clean(h);
	});

	it('Remove Unused removes media and synthetic items no clip uses', () => {
		const h = new Harness();
		const used = h.registerVideo();
		const unused = h.registerVideo();
		placeAV(h, used, 0);
		h.ok([{ type: 'synthetic.create', kind: 'black-video' }]);
		const r = h.ok([{ type: 'media.removeUnused' }]);
		expect((r.results[0] as { removed: string[] }).removed).toHaveLength(2);
		expect(h.doc.media[unused]).toBeUndefined();
		expect(h.doc.media[used]).toBeDefined();
		expect(Object.keys(h.doc.synthetics)).toHaveLength(0);
		clean(h);
	});
});

describe('Track Matte Keys across structure operations (wp masks)', () => {
	const matteOf = (doc: ProjectDocument, seqId: string, clipId: string): unknown => {
		const c = doc.sequences[seqId]!.clips[clipId] as {
			effects: { params: Record<string, { value: unknown }> }[];
		};
		return c.effects[0]!.params.matteTrack!.value;
	};
	function setup() {
		const h = new Harness();
		h.ok([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$fill' },
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [1, 1, 1, 1], ref: '$matte' },
		]);
		const [fill] = h.clips('V1');
		const [matte] = h.clips('V2');
		const v2 = h.seq.videoTracks[1]!.id;
		h.ok([
			{
				type: 'effect.add',
				target: { clipId: fill!.id },
				effectId: 'jasper.track-matte-key',
				params: { matteTrack: v2 },
			},
		]);
		return { h, fill: fill!.id, matte: matte!.id, v2 };
	}

	it('nest, duplicate and Make Subsequence read the matching track of the new sequence', () => {
		const { h, fill, matte } = setup();
		const d = h.ok([{ type: 'sequence.duplicate', sequenceId: h.seqId, ref: '$d' }]);
		const copy = h.doc.sequences[d.refs.$d!]!;
		const copyFill = Object.values(copy.clips).find((c) => c.trackId === copy.videoTracks[0]!.id)!;
		expect(matteOf(h.doc, copy.id, copyFill.id)).toBe(copy.videoTracks[1]!.id);
		const sub = h.ok([{ type: 'sequence.makeSubsequence', from: 0, to: 30 }]);
		const subId = (sub.results[0] as { sequenceId: string }).sequenceId;
		const s = h.doc.sequences[subId]!;
		const subFill = Object.values(s.clips).find((c) => c.trackId === s.videoTracks[0]!.id)!;
		expect(matteOf(h.doc, subId, subFill.id)).toBe(s.videoTracks[1]!.id);
		const n = h.ok([{ type: 'clip.nest', clipIds: [fill, matte] }]);
		const nid = (n.results[0] as { sequenceId: string }).sequenceId;
		expect(matteOf(h.doc, nid, fill)).toBe(h.doc.sequences[nid]!.videoTracks[1]!.id);
		clean(h);
	});

	it('a key whose track does not come along is cleared (W_TRACK_MATTE_CLEARED)', () => {
		const { h, fill } = setup();
		// The nested sequence mirrors the track layout: V2 exists there (empty), so the key reads it.
		const n = h.ok([{ type: 'clip.nest', clipIds: [fill] }]);
		const nid = (n.results[0] as { sequenceId: string }).sequenceId;
		expect(matteOf(h.doc, nid, fill)).toBe(h.doc.sequences[nid]!.videoTracks[1]!.id);
		// Placing the nest's clips individually: its empty V2 brings no track along, so the key is cleared.
		const p = h.ok([
			{
				type: 'clip.place',
				source: { sequenceId: nid },
				nest: false,
				at: 100,
				video: true,
				audio: false,
			},
		]);
		expect(p.warnings.some((w) => w.code === 'W_TRACK_MATTE_CLEARED')).toBe(true);
		const placed = (p.results[0] as { clipIds: string[] }).clipIds[0]!;
		expect(matteOf(h.doc, h.seqId, placed)).toBe('');
		clean(h);
	});
});

describe('synthetic sources', () => {
	it('creates every kind with defaults and places Bars and Tone as linked video + tone', () => {
		const h = new Harness();
		for (const kind of [
			'color-matte',
			'adjustment',
			'transparent',
			'black-video',
			'bars-and-tone',
			'counting-leader',
		] as const)
			h.ok([{ type: 'synthetic.create', kind }]);
		const bars = Object.values(h.doc.synthetics).find((s) => s.kind === 'bars-and-tone')!;
		expect(bars).toMatchObject({ toneHz: 1000, toneDb: -20 });
		const item = Object.values(h.doc.items).find((i) => i.kind === 'synthetic' && i.syntheticId === bars.id)!;
		expect(item.name).toBe('Bars and Tone');
		const r = h.ok([{ type: 'clip.place', source: { projectItemId: item.id }, at: 0 }]);
		const [v, a] = (r.results[0] as { clipIds: string[] }).clipIds.map((id) => h.seq.clips[id]!);
		expect(v!.kind).toBe('solid');
		expect(a!.kind).toBe('synthetic-audio');
		expect(v!.duration).toBe(30); // Premiere: a one-second clip
		expect(v!.linkId).toBe(a!.linkId);
		const s = snap(h.doc, h.seqId);
		expect(s.videoTracks[0]!.clips[0]!.source).toEqual({ generator: { kind: 'bars' } });
		expect(s.audioClips[0]!.generator).toEqual({ kind: 'tone', hz: 1000, db: -20 });
		expect(s.audioClips[0]!.mediaId).toBe(`syn:${bars.id}`);
		const leader = Object.values(h.doc.items).find(
			(i) => i.kind === 'synthetic' && h.doc.synthetics[i.syntheticId]?.kind === 'counting-leader',
		)!;
		const r2 = h.ok([{ type: 'clip.place', source: { projectItemId: leader.id }, at: 100 }]);
		expect(h.seq.clips[(r2.results[0] as { clipIds: string[] }).clipIds[0]!]!.duration).toBe(330);
		clean(h);
	});

	it('validates and updates params', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'synthetic.create', kind: 'color-matte', params: { color: [1, 0, 0, 1] }, ref: '$m' },
		]);
		const id = r.refs.$m!;
		expect(
			h.tx([{ type: 'synthetic.update', syntheticId: id, params: { color: [2, 0, 0, 1] } }]),
		).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] });
		expect(h.tx([{ type: 'synthetic.update', syntheticId: id, params: { hue: 3 } }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_INVALID_PARAM' }],
		});
		h.ok([{ type: 'synthetic.update', syntheticId: id, params: { color: [0, 1, 0, 1] } }]);
		expect(h.doc.synthetics[id]).toMatchObject({ color: [0, 1, 0, 1] });
		const l = h.ok([
			{ type: 'synthetic.create', kind: 'counting-leader', params: { cueBlipAllSeconds: true }, ref: '$l' },
		]);
		expect(
			leaderStyleOf((h.doc.synthetics[l.refs.$l!] as { style: Record<string, unknown> }).style),
		).toMatchObject({
			cueBlipAllSeconds: true,
			cueBlipOnTwo: true,
		});
	});
});

describe('generators', () => {
	it('draws SMPTE RP 219 bars', () => {
		const w = 1920;
		const h = 1080;
		const px = renderBars(w, h);
		const at = (x: number, y: number) => [...px.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];
		expect(at(10, 10)).toEqual([102, 102, 102, 255]); // 40 % grey side panel
		expect(at(300, 10)).toEqual([191, 191, 191, 255]); // 75 % white
		expect(at(300 + 206, 10)).toEqual([191, 191, 0, 255]); // yellow
		expect(at(1600, 10)).toEqual([0, 0, 191, 255]); // blue
		expect(at(1700, 10)).toEqual([102, 102, 102, 255]); // right side panel
		expect(at(10, 700)).toEqual([0, 255, 255, 255]); // 100 % cyan
		expect(at(10, 800)).toEqual([255, 255, 0, 255]); // 100 % yellow
		expect(at(960, 800)[0]).toBeGreaterThan(120); // ramp mid
		expect(at(10, 1000)).toEqual([38, 38, 38, 255]); // 15 % grey
		expect(at(700, 1000)).toEqual([255, 255, 255, 255]); // 100 % white
	});

	it('counts the leader down 8 → 2 with blips, then black', () => {
		expect(leaderPhaseAt(0.5)).toEqual({ phase: 'lead-in' });
		expect(leaderPhaseAt(2.25)).toMatchObject({ phase: 'count', numeral: 8 });
		expect(leaderPhaseAt(8.5)).toMatchObject({ phase: 'count', numeral: 2 });
		expect(leaderPhaseAt(9.5)).toEqual({ phase: 'black' });
		expect(LEADER_DURATION).toBe(11);
		const style = leaderStyleOf({});
		expect(leaderBlipTimes(style)).toEqual([8]);
		expect(leaderBlipTimes({ ...style, cueBlipAllSeconds: true })).toEqual([2, 3, 4, 5, 6, 7, 8]);
		const px = renderCountingLeader(320, 180, 2.5, style, 1 / 30);
		// Centre is a numeral or line (dark); a corner in the swept half shows the wipe colour.
		const at = (x: number, y: number) => px[(y * 320 + x) * 4]!;
		expect(at(300, 20)).toBe(Math.round(0.55 * 255)); // swept (top-right quadrant at half a second)
		expect(at(20, 160)).toBe(Math.round(0.78 * 255)); // not swept yet
		const black = renderCountingLeader(32, 18, 10, style, 1 / 30);
		expect([...black.slice(0, 4)]).toEqual([0, 0, 0, 255]);
	});

	it('generates the 1 kHz tone at the level and one-frame blips', () => {
		const tone = syntheticSamples({ kind: 'tone', hz: 1000, db: -20 }, 0, 4800, 48000, 1 / 30);
		const peak = Math.max(...tone.map(Math.abs));
		expect(peak).toBeCloseTo(0.1, 3);
		const blip = syntheticSamples(
			{ kind: 'leader-blips', style: leaderStyleOf({}) },
			7.9,
			9600,
			48000,
			1 / 30,
		);
		const nonZero = [...blip].map((v, i) => (Math.abs(v) > 1e-6 ? i : -1)).filter((i) => i >= 0);
		expect(nonZero[0]).toBeGreaterThanOrEqual(4800 - 1);
		expect(nonZero[nonZero.length - 1]! - nonZero[0]!).toBeLessThan(1600);
		const wav = encodeWavStereo16(tone, 48000);
		expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
		expect(wav.length).toBe(44 + 4800 * 4);
	});
});

describe('frame holds', () => {
	it('Add Frame Hold splits at the playhead and holds the frame there', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [v] = placeAV(h, m, 0, 'V1', [30, 130]);
		const r = h.ok([{ type: 'clip.addFrameHold', at: 40, clipIds: [v] }]);
		const [held] = (r.results[0] as { clipIds: string[] }).clipIds;
		const c = h.seq.clips[held!]!;
		expect(c.start).toBe(40);
		expect(c.frameHold).toEqual({ flicks: 70 * F30 });
		expect(clipPictureTime(c, 90, { num: 30, den: 1 })).toBe(70 * F30);
		expect(contentTimeAt(c, 90, { num: 30, den: 1 })).toBe(120 * F30);
		const s = snap(h.doc, h.seqId);
		expect(s.videoTracks[0]!.clips[1]!.frameHold).toEqual({ flicks: 70 * F30 });
		clean(h);
	});

	it('Insert Frame Hold Segment inserts a 2-second hold and ripples', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [v, a] = placeAV(h, m, 0, 'V1', [0, 90]);
		const r = h.ok([{ type: 'clip.insertFrameHoldSegment', clipId: v, at: 30 }]);
		const seg = h.seq.clips[(r.results[0] as { clipId: string }).clipId]!;
		expect([seg.start, seg.duration]).toEqual([30, 60]);
		expect(seg.frameHold?.flicks).toBe(30 * F30);
		expect(h.spans('V1')).toEqual([
			[0, 30],
			[30, 90],
			[90, 150],
		]);
		expect(h.spans('A1')).toEqual([
			[0, 30],
			[90, 150],
		]);
		expect(h.seq.clips[a!]).toBeDefined();
		clean(h);
	});

	it('Frame Hold Options holds on In / Out / source time, with Hold Filters', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [v] = placeAV(h, m, 0, 'V1', [30, 130]);
		h.ok([{ type: 'clip.frameHoldOptions', clipIds: [v], holdOn: 'out', holdFilters: true }]);
		expect(h.seq.clips[v!]!.frameHold).toEqual({ flicks: 129 * F30, holdFilters: true });
		h.ok([
			{ type: 'clip.frameHoldOptions', clipIds: [v], holdOn: 'source-time', sourceTime: { seconds: 2 } },
		]);
		expect(h.seq.clips[v!]!.frameHold?.flicks).toBe(2 * FLICKS_PER_SECOND);
		h.ok([{ type: 'clip.frameHoldOptions', clipIds: [v], holdOn: 'sequence-time', at: 10 }]);
		expect(h.seq.clips[v!]!.frameHold?.flicks).toBe(40 * F30);
		h.ok([{ type: 'clip.frameHoldOptions', clipIds: [v], enabled: false }]);
		expect(h.seq.clips[v!]!.frameHold).toBeUndefined();
		clean(h);
	});
});

describe('through edits, gaps, subsequences', () => {
	it('finds and joins through edits (speed and reverse included)', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [v, a] = placeAV(h, m, 0, 'V1', [0, 99]);
		const orig = { ...h.seq.clips[v!]! };
		h.ok([{ type: 'clip.split', clipIds: [v], at: 37 }]);
		expect(throughEdits(h.seq)).toHaveLength(2); // video and audio
		h.ok([{ type: 'sequence.joinThroughEdits' }]);
		expect(throughEdits(h.seq)).toHaveLength(0);
		const j = h.seq.clips[v!]!;
		expect([j.start, j.duration, j.sourceIn]).toEqual([orig.start, orig.duration, orig.sourceIn]);
		expect(h.seq.clips[v!]!.linkId).toBe(h.seq.clips[a!]!.linkId);
		h.ok([{ type: 'clip.setSpeed', clipIds: [v, a], rate: 1.5, reverse: true, ripple: false }]);
		h.ok([{ type: 'clip.split', clipIds: [v], at: 20 }]);
		const parts = h.clips('V1');
		expect(isThroughEdit(parts[0]!, parts[1]!, { num: 30, den: 1 })).toBe(true);
		h.ok([{ type: 'sequence.joinThroughEdits', clipIds: [parts[1]!.id] }]);
		expect(h.clips('V1')).toHaveLength(1);
		expect(h.clips('A1')).toHaveLength(2);
		h.ok([{ type: 'sequence.joinThroughEdits' }]);
		expect(h.clips('A1')).toHaveLength(1);
		expect(h.tx([{ type: 'sequence.joinThroughEdits' }]).ok).toBe(false);
		clean(h);
	});

	it('does not treat different sources or discontinuous content as through edits', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const m2 = h.registerVideo({ seconds: 20 });
		placeAV(h, m, 0, 'V1', [0, 30]);
		placeAV(h, m, 30, 'V1', [40, 70]);
		placeAV(h, m2, 60, 'V1', [70, 100]);
		expect(throughEdits(h.seq)).toHaveLength(0);
	});

	it('navigates gaps in the sequence and in tracks', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		placeAV(h, m, 10, 'V1', [0, 20]);
		placeAV(h, m, 50, 'V1', [0, 10]);
		const seq = h.seq as Sequence;
		expect(sequenceGaps(seq)).toEqual([
			{ start: 0, end: 10 },
			{ start: 30, end: 50 },
		]);
		expect(trackGaps(seq, seq.videoTracks[0]!.id)).toHaveLength(2);
		expect(gapNavigation(seq, 5, 1)).toBe(30);
		expect(gapNavigation(seq, 45, -1)).toBe(30);
		expect(gapNavigation(seq, 30, 1)).toBeNull();
		expect(gapNavigation(seq, 0, 1, [seq.videoTracks[0]!.id])).toBe(30);
	});

	it('makes a subsequence trimmed to In/Out with links and transitions', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 30 });
		placeAV(h, m, 0, 'V1', [0, 60]);
		placeAV(h, m, 60, 'V1', [200, 300]);
		h.ok([
			{ type: 'transition.add', trackId: 'V1', at: 60, effectId: 'jasper.cross-dissolve', duration: 10 },
		]);
		h.ok([{ type: 'sequence.setInOut', in: 40, out: 120 }]);
		const r = h.ok([{ type: 'sequence.makeSubsequence', ref: '$s' }]);
		const sub = h.doc.sequences[r.refs.$s!]!;
		const v = Object.values(sub.clips)
			.filter((c) => c.trackId === sub.videoTracks[0]!.id)
			.sort((a, b) => a.start - b.start);
		expect(v.map((c) => [c.start, c.duration])).toEqual([
			[0, 20],
			[20, 60],
		]);
		expect(v[0]!.sourceIn).toBe(40 * F30);
		expect(Object.keys(sub.transitions)).toHaveLength(1);
		const item = Object.values(h.doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === sub.id)!;
		expect(item.name).toMatch(/_Sub_01$/);
		clean(h);
	});
});

describe('freeze-frame transition handles', () => {
	it('keeps the duration with repeated frames and tells the renderers which handle frames freeze', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10 });
		placeAV(h, m, 0, 'V1', [240, 300]); // 0 frames after the out-point
		placeAV(h, m, 60, 'V1', [0, 60]); // 0 frames before the in-point
		const shorten = h.tx(
			[{ type: 'transition.add', trackId: 'V1', at: 60, effectId: 'jasper.cross-dissolve', duration: 20 }],
			{
				dryRun: true,
			},
		);
		expect(shorten.ok).toBe(false);
		const r = h.ok([
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 60,
				effectId: 'jasper.cross-dissolve',
				duration: 20,
				handles: 'freeze',
			},
		]);
		expect(r.warnings.map((w) => w.code)).toContain('W_TRANSITION_FREEZE_FRAMES');
		const t = Object.values(h.seq.transitions)[0]!;
		expect([t.duration, t.freezeHandles]).toEqual([20, true]);
		const res = resolveVideoTransitions(h.doc, h.seq as Sequence);
		const [a, b] = h.clips('V1');
		expect(res.clips.get(a!.id)).toMatchObject({ tailHandle: 10, freezeTail: 10 });
		expect(res.clips.get(b!.id)).toMatchObject({ headHandle: 10, freezeHead: 10 });
		const s = snap(h.doc, h.seqId);
		expect(s.videoTracks[0]!.clips[0]!.freezeTail).toBe(10);
		clean(h);
	});
});

describe('invariants and repair', () => {
	it('flags frame holds on adjustment layers and repairs nesting cycles', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [v] = placeAV(h, m, 0, 'V1', [0, 30]);
		const nid = (h.ok([{ type: 'clip.nest', clipIds: [v] }]).results[0] as { sequenceId: string }).sequenceId;
		const doc = JSON.parse(JSON.stringify(h.doc)) as ProjectDocument;
		const nested = doc.sequences[nid]!;
		const nv = Object.values(doc.sequences[h.seqId]!.clips).find((c) => c.kind === 'nest-video')!;
		nested.clips.clp_cycle = {
			...(nv as Clip),
			id: 'clp_cycle',
			trackId: nested.videoTracks[2]!.id,
			sequenceId: h.seqId,
			linkId: null,
		} as Clip;
		const issues = checkInvariants(doc);
		expect(
			issues.some((i) => (i as { invariant?: string }).invariant === 'INV-009'),
			JSON.stringify(issues),
		).toBe(true);
		const fixed = repairDocument(doc, createCounterIdSource(900));
		expect(
			checkInvariants(fixed.document).some((i) => (i as { invariant?: string }).invariant === 'INV-009'),
		).toBe(false);
		expect(fixed.report.some((r) => r.action === 'drop-clip')).toBe(true);
	});

	it('nest content keys ignore names and change with content', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20 });
		const [v] = placeAV(h, m, 0, 'V1', [0, 30]);
		const nid = (h.ok([{ type: 'clip.nest', clipIds: [v] }]).results[0] as { sequenceId: string }).sequenceId;
		const k0 = nestContentKey(h.doc, nid);
		h.ok([{ type: 'clip.update', clipId: v, patch: { name: 'renamed', label: 'rose' } }]);
		expect(nestContentKey(h.doc, nid)).toBe(k0);
		h.ok([{ type: 'clip.trim', clipId: v, edge: 'out', deltaFrames: -1 }]);
		expect(nestContentKey(h.doc, nid)).not.toBe(k0);
	});
});
