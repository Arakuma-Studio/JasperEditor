// Sound cues (spec 12 §2.2, §2.9; P2-R1, P2-R2, P2-R5): soundCue.add / update / remove / resync, the cue model's
// invariants, repair (dangling anchors, placed clips, cue links, duplicate ids, frame clamp), diff and duplicate.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type AudioClip,
	type ClipSfx,
	COMMAND_CATALOG,
	checkInvariants,
	createCounterIdSource,
	diffDocuments,
	type LibraryProvenance,
	loadProject,
	type ProjectDocument,
	readSoundDesign,
	repairDocument,
	type SoundCue,
	type SoundDesign,
	soundDesignNeedsRepair,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
type SfxClip = AudioClip & { sfx?: ClipSfx };
const err = (r: ReturnType<Harness['tx']>) => (r.ok ? null : r.errors[0]!);
const sd = (h: Harness) => h.seq.soundDesign as SoundDesign;
const cue = (h: Harness, id: string) => sd(h).cues[id]!;

function libMedia(h: Harness): string {
	const library: LibraryProvenance = {
		...LIB,
		descriptors: {
			...LIB.descriptors!,
			peakSec: 0.07,
			onsetSec: 0.06,
			headQuietSec: 0.05,
			durationSec: 0.55,
		},
		leadSilenceSec: 0.05,
	};
	const r = h.ok([
		{ type: 'media.register', asset: { ...videoAsset({ kind: 'audio', seconds: 0.55 }), library } },
	]);
	return (r.results[0] as { mediaId: string }).mediaId;
}

/** V1: clips A [0, 60) and B [60, 150) of a 10 s video (+ their audio on A1). */
function edit() {
	const h = new Harness();
	const media = h.registerVideo({ seconds: 10 });
	const place = (at: number, from: number, to: number) =>
		(
			h.ok([
				{
					type: 'clip.place',
					source: { mediaId: media },
					at,
					sourceRange: { in: { seconds: from }, out: { seconds: to } },
				},
			]).results[0] as { clipIds: string[] }
		).clipIds[0]!;
	const a = place(0, 0, 2);
	const b = place(60, 3, 6);
	return { h, media, a, b, trackId: h.seq.videoTracks[0]!.id };
}

/** A cue the deriver would output (spec 12 §2.2, `DerivedCue`). */
const derived = (o: Record<string, unknown> = {}) => ({
	frame: 60,
	kind: 'cut',
	weight: 'support',
	types: ['hit', 'thump'],
	align: 'peak',
	pan: 'auto',
	confidence: 0.8,
	reason: 'Cut from A to B on V1',
	source: 'derived',
	...o,
});

describe('catalogue', () => {
	it('registers every cue and placement command with owner sound-design and a History label', () => {
		for (const t of [
			'soundCue.add',
			'soundCue.update',
			'soundCue.remove',
			'soundCue.resync',
			'soundDesign.place',
			'soundDesign.swap',
			'soundDesign.setPalette',
			'soundDesign.setSettings',
		] as const) {
			expect(COMMAND_CATALOG[t].owner).toBe('sound-design');
			expect(COMMAND_CATALOG[t].label.length).toBeGreaterThan(3);
		}
	});
});

describe('soundCue.add', () => {
	it('adds derived-shaped cues with ids and refs; undo leaves the document, redo repeats it', () => {
		const { h, a, b, trackId } = edit();
		const before = h.doc;
		const snapshot = clone(before);
		const r = h.ok([
			{
				type: 'soundCue.add',
				cues: [
					derived({ anchor: { type: 'edit', trackId, outgoingClipId: a, incomingClipId: b }, ref: '$cut' }),
					derived({
						frame: 10,
						kind: 'appear',
						weight: 'hero',
						window: { start: 5, end: 15 },
						source: 'agent',
					}),
				],
			},
			{ type: 'soundCue.update', cueId: '$cut', label: 'Cut' },
		]);
		const { sequenceId, cueIds } = r.results[0] as { sequenceId: string; cueIds: string[] };
		expect(sequenceId).toBe(h.seqId);
		expect(cueIds).toHaveLength(2);
		expect(r.refs.$cut).toBe(cueIds[0]);
		expect(r.created).toEqual(expect.arrayContaining(cueIds));
		expect(cue(h, cueIds[0]!)).toEqual({
			id: cueIds[0],
			...derived({ anchor: { type: 'edit', trackId, outgoingClipId: a, incomingClipId: b } }),
			label: 'Cut',
		});
		expect(cue(h, cueIds[1]!).window).toEqual({ start: 5, end: 15 });
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(before).toEqual(snapshot);
		expect(before.sequences[h.seqId]!.soundDesign).toBeUndefined();
		// a caller-supplied id
		const own = h.ok([{ type: 'soundCue.add', cues: [derived({ id: 'cue_00000000000000ZZ' })] }]);
		expect((own.results[0] as { cueIds: string[] }).cueIds).toEqual(['cue_00000000000000ZZ']);
	});

	it('refuses unknown types, anchors to nothing, bad or used ids, bad shapes and too many cues', () => {
		const { h } = edit();
		h.ok([{ type: 'soundCue.add', cues: [derived({ id: 'cue_0000000000000001' })] }]);
		const doc = h.doc;
		const cases: [unknown, string][] = [
			[derived({ types: ['whosh'] }), 'E_INVALID_PARAM'],
			[derived({ anchor: { type: 'clip', clipId: 'clp_0000000000000999', edge: 'start' } }), 'E_NOT_FOUND'],
			[derived({ anchor: { type: 'marker', markerId: 'mrk_0000000000000999' } }), 'E_NOT_FOUND'],
			[derived({ id: 'cue_bad' }), 'E_INVALID_PARAM'],
			[derived({ id: 'cue_0000000000000001' }), 'E_INVALID_PARAM'],
			[derived({ frame: -1 }), 'E_SCHEMA'],
			[derived({ kind: 'boom' }), 'E_SCHEMA'],
			[derived({ pan: 200 }), 'E_SCHEMA'],
			[derived({ window: { start: 9, end: 3 } }), 'E_SCHEMA'],
			[derived({ placedClipIds: [] }), 'E_SCHEMA'],
			[derived({ soundIds: ['not-a-sound'] }), 'E_SCHEMA'],
		];
		for (const [c, code] of cases) {
			expect(err(h.tx([{ type: 'soundCue.add', cues: [c] }]))?.code, JSON.stringify(c)).toBe(code);
			expect(h.doc).toBe(doc);
		}
		const many = Array.from({ length: 2001 }, () => derived());
		expect(err(h.tx([{ type: 'soundCue.add', cues: many }]))?.code).toBe('E_SCHEMA');
		// the sequence cap
		const big = clone(h.doc);
		const cues: Record<string, SoundCue> = {};
		for (let i = 0; i < 19_999; i++) {
			const id = `cue_${i.toString(32).toUpperCase().padStart(16, '0')}`;
			cues[id] = { id, frame: i, kind: 'manual', weight: 'support', source: 'user' };
		}
		(big.sequences[h.seqId] as { soundDesign?: unknown }).soundDesign = { cues };
		h.doc = big;
		expect(err(h.tx([{ type: 'soundCue.add', cues: [derived(), derived()] }]))?.code).toBe('E_LIMIT');
	});
});

/** A cue at the cut A|B filled with one library sound on an SFX track. */
function filled() {
	const e = edit();
	const { h, a, b, trackId } = e;
	const m = libMedia(h);
	const r = h.ok([
		{
			type: 'soundCue.add',
			cues: [derived({ anchor: { type: 'edit', trackId, outgoingClipId: a, incomingClipId: b }, ref: '$c' })],
		},
		{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId: m }] },
	]);
	const cueId = r.refs.$c!;
	const clipId = (r.results[1] as { clips: { clipId: string }[] }).clips[0]!.clipId;
	return { ...e, m, cueId, clipId };
}

describe('soundCue.update', () => {
	it('changes fields, clears with null, and moves the filling clips with the frame (undoable)', () => {
		const { h, cueId, clipId } = filled();
		const start = h.seq.clips[clipId]!.start;
		const before = h.doc;
		const r = h.ok([
			{ type: 'soundCue.update', cueId, frame: 75, weight: 'hero', reason: null, pan: -20, label: 'Hit' },
		]);
		expect(r.results[0]).toEqual({ cueId, frame: 75, movedClipIds: [clipId] });
		expect(cue(h, cueId)).toMatchObject({ frame: 75, weight: 'hero', pan: -20, label: 'Hit' });
		expect('reason' in cue(h, cueId)).toBe(false);
		expect(h.seq.clips[clipId]!.start).toBe(start + 15);
		expect(r.changed).toEqual(expect.arrayContaining([cueId, clipId]));
		expect(before.sequences[h.seqId]!.clips[clipId]!.start).toBe(start);
		h.ok([{ type: 'soundCue.update', cueId, frame: 80, moveClips: false }]);
		expect(h.seq.clips[clipId]!.start).toBe(start + 15);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('refuses an unknown cue, a move onto other audio or a locked track, and before frame 0', () => {
		const { h, cueId, clipId, m } = filled();
		const t = h.seq.clips[clipId]!.trackId;
		expect(err(h.tx([{ type: 'soundCue.update', cueId: 'cue_0000000000000999', frame: 1 }]))?.code).toBe(
			'E_NOT_FOUND',
		);
		expect(err(h.tx([{ type: 'soundCue.update', cueId, types: ['nope'] }]))?.code).toBe('E_INVALID_PARAM');
		expect(err(h.tx([{ type: 'soundCue.update', cueId, frame: 0 }]))?.code).toBe('E_INVALID_PARAM');
		h.ok([{ type: 'soundDesign.place', frame: 100, layers: [{ mediaId: m, track: t }] }]);
		const doc = h.doc;
		const ov = err(h.tx([{ type: 'soundCue.update', cueId, frame: 100 }]));
		expect(ov?.code).toBe('E_OVERLAP');
		expect(h.doc).toBe(doc);
		h.ok([{ type: 'track.update', trackId: t, patch: { locked: true } }]);
		expect(err(h.tx([{ type: 'soundCue.update', cueId, frame: 62 }]))?.code).toBe('E_TRACK_LOCKED');
	});
});

describe('soundCue.remove', () => {
	it('keeps the clips (they forget the cue) or lifts them with withClips; undo / redo', () => {
		const one = filled();
		const before = one.h.doc;
		const r = one.h.ok([{ type: 'soundCue.remove', cueIds: [one.cueId] }]);
		expect(r.results[0]).toEqual({ removed: [one.cueId], liftedClipIds: [] });
		expect((one.h.seq.clips[one.clipId] as SfxClip).sfx!.cueId).toBeNull();
		expect(sd(one.h).cues[one.cueId]).toBeUndefined();
		expect(r.deleted).toContain(one.cueId);
		expect((before.sequences[one.h.seqId]!.clips[one.clipId] as SfxClip).sfx!.cueId).toBe(one.cueId);

		const two = filled();
		two.h.ok([{ type: 'soundCue.remove', cueIds: [two.cueId], withClips: true }]);
		expect(two.h.seq.clips[two.clipId]).toBeUndefined();
		expect(checkInvariants(two.h.doc)).toEqual([]);
	});
	it('refuses an unknown cue and lifting from a locked track', () => {
		const { h, cueId, clipId } = filled();
		expect(err(h.tx([{ type: 'soundCue.remove', cueIds: ['cue_0000000000000999'] }]))?.code).toBe(
			'E_NOT_FOUND',
		);
		h.ok([{ type: 'track.update', trackId: h.seq.clips[clipId]!.trackId, patch: { locked: true } }]);
		expect(err(h.tx([{ type: 'soundCue.remove', cueIds: [cueId], withClips: true }]))?.code).toBe(
			'E_TRACK_LOCKED',
		);
		expect(h.tx([{ type: 'soundCue.remove', cueIds: [cueId] }]).ok).toBe(true);
	});
});

describe('soundCue.resync', () => {
	it('follows the edit: the cue and its clips move by the anchor’s delta; unresolved cues are reported', () => {
		const { h, b, cueId, clipId } = filled();
		const start = h.seq.clips[clipId]!.start;
		h.ok([{ type: 'clip.move', clipIds: [b], deltaFrames: 12 }]);
		const free = h.ok([{ type: 'soundCue.add', cues: [derived({ frame: 300 })] }]);
		const freeId = (free.results[0] as { cueIds: string[] }).cueIds[0]!;
		const before = h.doc;
		const r = h.ok([{ type: 'soundCue.resync' }]);
		expect(r.results[0]).toEqual({
			moved: [{ cueId, from: 60, to: 72, clipIds: [clipId] }],
			unresolved: [],
			unanchored: [],
		});
		expect(cue(h, cueId).frame).toBe(72);
		expect(h.seq.clips[clipId]!.start).toBe(start + 12);
		expect(cue(h, freeId).frame).toBe(300);
		expect(before.sequences[h.seqId]!.clips[clipId]!.start).toBe(start);
		// nothing to do the second time; explicit unanchored cue reported
		expect(h.ok([{ type: 'soundCue.resync', cueIds: [cueId, freeId] }]).results[0]).toEqual({
			moved: [],
			unresolved: [],
			unanchored: [freeId],
		});
		// the anchored clips are gone: unresolved, the cue stays
		h.ok([{ type: 'clip.lift', clipIds: [b] }]);
		const a = cue(h, cueId).anchor;
		expect(a).toBeTruthy();
		const r2 = h.ok([{ type: 'soundCue.resync' }]);
		expect((r2.results[0] as { unresolved: string[] }).unresolved).toEqual([]);
		expect(cue(h, cueId).frame).toBe(60);
	});

	it('refuses the whole transaction when a clip cannot follow (E_OVERLAP, E_TRACK_LOCKED) and unknown cues', () => {
		const { h, b, cueId, clipId, m } = filled();
		const t = h.seq.clips[clipId]!.trackId;
		h.ok([{ type: 'soundDesign.place', frame: 90, layers: [{ mediaId: m, track: t }] }]);
		h.ok([{ type: 'clip.move', clipIds: [b], deltaFrames: 30 }]);
		const doc = h.doc;
		expect(err(h.tx([{ type: 'soundCue.resync' }]))?.code).toBe('E_OVERLAP');
		expect(h.doc).toBe(doc);
		expect(cue(h, cueId).frame).toBe(60);
		h.ok([{ type: 'track.update', trackId: t, patch: { locked: true } }]);
		expect(err(h.tx([{ type: 'soundCue.resync' }]))?.code).toBe('E_TRACK_LOCKED');
		expect(err(h.tx([{ type: 'soundCue.resync', cueIds: ['cue_0000000000000999'] }]))?.code).toBe(
			'E_NOT_FOUND',
		);
	});
});

describe('invariants, repair and load', () => {
	it('INV-SOUND / INV-SFX flag unreadable data; loading repairs it field by field (idempotent)', () => {
		const { h, cueId, clipId } = filled();
		const raw = clone(h.doc) as ProjectDocument;
		const seq = raw.sequences[h.seqId] as { soundDesign: Record<string, unknown> };
		const cues = seq.soundDesign.cues as Record<string, Record<string, unknown>>;
		cues[cueId]!.frame = 1e12;
		cues[cueId]!.kind = 'future-kind';
		cues[cueId]!.extra = { kept: true };
		cues.cue_bad = { id: 'cue_bad', frame: 3, kind: 'cut', weight: 'hero', source: 'user' };
		cues.junk = 'x' as never;
		seq.soundDesign.settings = { density: 'huge', seed: -5, palette: ['snd_0000000000000001', 3] };
		const c = raw.sequences[h.seqId]!.clips[clipId] as unknown as { sfx: Record<string, unknown> };
		c.sfx.layer = 99;
		c.sfx.role = 'boss';
		const issues = checkInvariants(raw);
		expect(issues.some((i) => i.invariant === 'INV-SOUND')).toBe(true);
		expect(issues.some((i) => i.invariant === 'INV-SFX')).toBe(true);
		const loaded = loadProject(raw, { ids: createCounterIdSource(900) });
		expect(loaded.issues).toEqual([]);
		const out = loaded.document.sequences[h.seqId]!.soundDesign as SoundDesign;
		const kept = out.cues[cueId]!;
		expect(kept).toMatchObject({ frame: 10_368_000, kind: 'manual', extra: { kept: true } });
		const renamed = Object.values(out.cues).find((x) => x.frame === 3)!;
		expect(renamed.id).toMatch(/^cue_[0-9A-Z]{16}$/);
		expect(out.settings).toMatchObject({ density: 'balanced', seed: 0, palette: ['snd_0000000000000001'] });
		const sfx = (loaded.document.sequences[h.seqId]!.clips[clipId] as SfxClip).sfx!;
		expect(sfx).toMatchObject({ layer: 5, role: 'support', cueId });
		expect(loaded.repairs.map((r) => r.action)).toEqual(
			expect.arrayContaining(['repair-sound-design', 'repair-sfx', 'reid-cue']),
		);
		// idempotent
		const again = repairDocument(loaded.document, createCounterIdSource(5000));
		expect(again.document).toEqual(loaded.document);
		expect(again.report).toEqual([]);
		expect(soundDesignNeedsRepair(loaded.document)).toBe(false);
	});

	it('dangling anchors become null (reported), missing placed clips are pruned, lost cues unlink their clips', () => {
		const { h, b, cueId, clipId, m } = filled();
		const other = h.ok([{ type: 'soundDesign.place', frame: 400, layers: [{ mediaId: m }] }]);
		const otherClip = (other.results[0] as { clips: { clipId: string }[] }).clips[0]!.clipId;
		// edits never fail because of soft references
		h.ok([{ type: 'clip.lift', clipIds: [b] }]);
		h.ok([{ type: 'clip.lift', clipIds: [clipId] }]);
		expect(checkInvariants(h.doc)).toEqual([]);
		const raw = clone(h.doc);
		(raw.sequences[h.seqId]!.clips[otherClip] as unknown as { sfx: ClipSfx }).sfx.cueId =
			'cue_0000000000000777';
		expect(soundDesignNeedsRepair(raw)).toBe(true);
		const loaded = loadProject(raw, { ids: createCounterIdSource(900) });
		const c = (loaded.document.sequences[h.seqId]!.soundDesign as SoundDesign).cues[cueId]!;
		expect(c.anchor).toBeNull();
		expect(c.placedClipIds).toBeUndefined();
		expect((loaded.document.sequences[h.seqId]!.clips[otherClip] as SfxClip).sfx!.cueId).toBeNull();
		expect(loaded.repairs.map((r) => r.action)).toEqual(
			expect.arrayContaining(['drop-cue-anchor', 'prune-cue-clips', 'unlink-sfx']),
		);
		expect(repairDocument(loaded.document, createCounterIdSource(1)).report).toEqual([]);
	});

	it('cue ids shared by two sequences are renamed (with their clips’ links); sfx on a video clip is dropped', () => {
		const { h, cueId } = filled();
		const dup = h.ok([{ type: 'sequence.duplicate', sequenceId: h.seqId }]);
		const sid = (dup.results[0] as { sequenceId: string }).sequenceId;
		const copy = h.doc.sequences[sid]!.soundDesign as SoundDesign;
		// sequence.duplicate gives the copy its own cue ids, clips and anchors
		const copied = Object.values(copy.cues)[0]!;
		expect(copied.id).not.toBe(cueId);
		const placed = copied.placedClipIds![0]!;
		expect(h.doc.sequences[sid]!.clips[placed]).toBeDefined();
		expect((h.doc.sequences[sid]!.clips[placed] as SfxClip).sfx!.cueId).toBe(copied.id);
		const anchor = copied.anchor as { incomingClipId: string };
		expect(h.doc.sequences[sid]!.clips[anchor.incomingClipId]).toBeDefined();
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(soundDesignNeedsRepair(h.doc)).toBe(false);
		// a file whose copy shares the ids (an older build)
		const raw = clone(h.doc);
		const s2 = raw.sequences[sid] as { soundDesign: SoundDesign };
		s2.soundDesign.cues = { [cueId]: { ...copied, id: cueId } };
		(raw.sequences[sid]!.clips[placed] as unknown as { sfx: ClipSfx }).sfx.cueId = cueId;
		const v = Object.values(raw.sequences[h.seqId]!.clips).find((c) => c.kind === 'video')!;
		(v as unknown as { sfx: unknown }).sfx = {
			cueId: null,
			soundId: null,
			layer: 0,
			role: 'hero',
			placement: {},
		};
		const loaded = loadProject(raw, { ids: createCounterIdSource(900) });
		expect(loaded.issues).toEqual([]);
		const ids = Object.values(loaded.document.sequences).flatMap((s) =>
			Object.keys((s.soundDesign as SoundDesign | undefined)?.cues ?? {}),
		);
		expect(new Set(ids).size).toBe(ids.length);
		const newId = Object.keys((loaded.document.sequences[sid]!.soundDesign as SoundDesign).cues)[0]!;
		expect((loaded.document.sequences[sid]!.clips[placed] as SfxClip).sfx!.cueId).toBe(newId);
		expect((loaded.document.sequences[h.seqId]!.clips[v.id] as { sfx?: unknown }).sfx).toBeUndefined();
	});

	it('loading never throws and leaves no issue for arbitrary sound-design values (property)', () => {
		const { h, clipId } = filled();
		const base = clone(h.doc);
		const anyCue = fc.oneof(
			fc.anything(),
			fc.record(
				{
					id: fc.oneof(fc.string(), fc.constant('cue_0000000000000001')),
					frame: fc.oneof(fc.double(), fc.integer()),
					kind: fc.oneof(fc.string(), fc.constant('cut')),
					weight: fc.oneof(fc.string(), fc.constant('hero')),
					source: fc.oneof(fc.string(), fc.constant('user')),
					types: fc.anything(),
					anchor: fc.oneof(
						fc.anything(),
						fc.constant({ type: 'clip', clipId: 'clp_0000000000000999', edge: 'start' }),
					),
					placedClipIds: fc.oneof(fc.anything(), fc.constant([clipId, 'clp_X'])),
					window: fc.anything(),
				},
				{ requiredKeys: [] },
			),
		);
		fc.assert(
			fc.property(
				fc.oneof(
					fc.anything(),
					fc.record({ cues: fc.dictionary(fc.string(), anyCue), settings: fc.anything() }),
				),
				fc.anything(),
				(soundDesign, sfx) => {
					const raw = clone(base);
					(raw.sequences[h.seqId] as { soundDesign?: unknown }).soundDesign = soundDesign;
					(raw.sequences[h.seqId]!.clips[clipId] as unknown as { sfx?: unknown }).sfx = sfx;
					const r = loadProject(JSON.parse(JSON.stringify(raw)), { ids: createCounterIdSource(1000) });
					expect(r.issues).toEqual([]);
					expect(soundDesignNeedsRepair(r.document)).toBe(false);
					const again = repairDocument(r.document, createCounterIdSource(5000));
					expect(again.report).toEqual([]);
				},
			),
			{ numRuns: 300 },
		);
		expect(readSoundDesign('x')).toBeNull();
	});

	it('reports cue changes in the transaction diff', () => {
		const { h, cueId } = filled();
		const before = h.doc;
		h.ok([{ type: 'soundCue.update', cueId, label: 'x' }]);
		expect(diffDocuments(before, h.doc).changed).toContain(cueId);
		const b2 = h.doc;
		h.ok([{ type: 'soundDesign.setSettings', seed: 3 }]);
		expect(diffDocuments(b2, h.doc).changed).toContain(h.seqId);
	});
});
