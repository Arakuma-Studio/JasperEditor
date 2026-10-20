// Sound Check listen-here verdicts bound to the moment they judged (Phase 5 verification, follow-up (c)):
// `soundDesign.setVerdict` writes the verdict marker with a structured `soundCheck` field (slot, the clip or cue listened
// to, the mix fingerprint, the hash of the ±2 s window); `soundCheckHumanVerdicts(seq, {doc})` says whether a verdict is
// stale (the window sounds different, its clip / cue moved or is gone) — what MCP `sound_check` returns as
// `humanVerdicts`. Undo / redo, refusals, repair and hostile input.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	type LibraryProvenance,
	mixFingerprint,
	readSoundCheckVerdictMeta,
	repairDocument,
	SOUND_CHECK_VERDICT_MARKER,
	soundCheckHumanVerdicts,
	soundCheckMomentHash,
	soundCheckVerdictFor,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Music 0–20 s on A1, a hit on a cue at frame 120 (4 s), a second hit at frame 450 (15 s): 30 fps. */
function fixture() {
	const h = new Harness();
	const library: LibraryProvenance = {
		...LIB,
		soundId: 'snd_000000000000c0de',
		title: 'Hit',
		types: ['hit'],
	};
	const r = h.ok([
		{ type: 'media.register', asset: { ...videoAsset({ kind: 'audio', seconds: 0.5 }), library } },
	]);
	const m = (r.results[0] as { mediaId: string }).mediaId;
	const music = h.registerVideo({ seconds: 20 });
	h.ok([{ type: 'clip.place', source: { mediaId: music }, at: 0 }]);
	const placed = h.ok([
		{
			type: 'soundCue.add',
			cues: [
				{ frame: 120, kind: 'cut', weight: 'hero', source: 'user', ref: '$c' },
				{ frame: 450, kind: 'cut', weight: 'support', source: 'user', ref: '$d' },
			],
		},
		{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId: m, ref: '$x' }] },
		{ type: 'soundDesign.place', cueId: '$d', layers: [{ mediaId: m, ref: '$y' }] },
	]);
	return {
		h,
		media: m,
		cueId: placed.refs.$c!,
		cue2: placed.refs.$d!,
		clipId: placed.refs.$x!,
		clip2: placed.refs.$y!,
	};
}

const verdicts = (h: Harness) => soundCheckHumanVerdicts(h.seq, { doc: h.doc });

describe('soundDesign.setVerdict', () => {
	it('writes a user comment marker bound to its moment; updates it; null removes it; undo / redo', () => {
		const { h, clipId } = fixture();
		const before = h.doc;
		const snapshot = clone(before);
		const cmd = {
			type: 'soundDesign.setVerdict',
			frame: 120,
			verdict: 'flag',
			note: '  the hit is late  ',
			slot: 'worst',
			clipId,
			reportMixHash: 'abc123',
		};
		const r = h.ok([cmd], { label: 'Flag Sound at 00;00;04;00' });
		const markerId = (r.results[0] as { markerId: string }).markerId;
		expect(r.results[0]).toEqual({ markerId, removed: [] });
		expect(checkInvariants(h.doc)).toEqual([]);
		const m = h.seq.markers.find((x) => x.id === markerId)!;
		expect(m).toMatchObject({
			frame: 120,
			type: 'comment',
			author: 'user',
			name: SOUND_CHECK_VERDICT_MARKER.flag,
			comment: 'the hit is late',
			color: 'rose',
		});
		const meta = readSoundCheckVerdictMeta((m as { soundCheck?: unknown }).soundCheck);
		expect(meta).toEqual({
			v: 1,
			verdict: 'flag',
			slot: 'worst',
			subject: { kind: 'clip', id: clipId, start: h.seq.clips[clipId]!.start },
			mixHash: mixFingerprint(h.doc, h.seqId),
			momentHash: soundCheckMomentHash(h.doc, h.seqId, 120),
			reportMixHash: 'abc123',
		});
		expect(verdicts(h)).toEqual([
			{
				markerId,
				frame: 120,
				verdict: 'flag',
				note: 'the hit is late',
				slot: 'worst',
				clipId,
				cueId: null,
				bound: true,
				stale: false,
				staleReasons: [],
				mixChanged: false,
			},
		]);
		// undo = the document before (untouched); redo = the same sequences
		expect(before).toEqual(snapshot);
		const noIds = (d: typeof h.doc) =>
			Object.values(clone(d.sequences)).map((q) => ({
				...q,
				markers: q.markers.map(({ id: _id, ...x }) => x),
			}));
		const after = noIds(h.doc);
		h.doc = before;
		h.ok([cmd]);
		expect(noIds(h.doc)).toEqual(after);
		// a new verdict on the same moment updates the marker
		const u = h.ok([{ type: 'soundDesign.setVerdict', frame: 120, verdict: 'ok', slot: 'worst', clipId }]);
		expect(u.results[0]).toEqual({ markerId: expect.any(String), removed: [] });
		expect(verdicts(h)).toHaveLength(1);
		expect(verdicts(h)[0]).toMatchObject({ verdict: 'ok', note: null });
		expect(h.seq.markers.find((x) => x.frame === 120)).toMatchObject({ color: 'green' });
		// null removes it
		const d = h.ok([{ type: 'soundDesign.setVerdict', frame: 120, verdict: null, clipId }]);
		expect((d.results[0] as { removed: string[] }).removed).toHaveLength(1);
		expect(verdicts(h)).toEqual([]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('two moments on the same frame about different clips keep separate verdicts; an unbound one is taken over', () => {
		const { h, clipId, cueId } = fixture();
		h.ok([
			{ type: 'soundDesign.setVerdict', frame: 120, verdict: 'ok', slot: 'hero', clipId },
			{ type: 'soundDesign.setVerdict', frame: 120, verdict: 'flag', slot: 'passing', cueId, note: 'thin' },
		]);
		const v = verdicts(h);
		expect(v.map((x) => [x.slot, x.verdict, x.clipId, x.cueId])).toEqual(
			expect.arrayContaining([
				['hero', 'ok', clipId, null],
				['passing', 'flag', null, cueId],
			]),
		);
		expect(soundCheckVerdictFor(v, { frame: 120, clipId })?.verdict).toBe('ok');
		expect(soundCheckVerdictFor(v, { frame: 120, cueId })?.verdict).toBe('flag');
		// a moment about something else at that frame has no verdict
		expect(soundCheckVerdictFor(v, { frame: 120, clipId: 'clp_other' })).toBeNull();
		// an older (unbound) verdict marker at a frame counts for any moment there, and setVerdict takes it over
		const g = fixture();
		g.h.ok([{ type: 'marker.add', frame: 120, name: SOUND_CHECK_VERDICT_MARKER.ok, markerType: 'comment' }]);
		const legacy = verdicts(g.h);
		expect(legacy).toMatchObject([{ bound: false, stale: null, mixChanged: null, staleReasons: [] }]);
		expect(soundCheckVerdictFor(legacy, { frame: 120, clipId: g.clipId })).not.toBeNull();
		g.h.ok([{ type: 'soundDesign.setVerdict', frame: 120, verdict: 'flag', clipId: g.clipId }]);
		expect(verdicts(g.h)).toMatchObject([{ bound: true, verdict: 'flag', clipId: g.clipId }]);
		expect(g.h.seq.markers).toHaveLength(1);
		// a verdict about no clip / cue in particular covers every moment at its frame, until a specific one takes over
		const k = fixture();
		k.h.ok([{ type: 'soundDesign.setVerdict', frame: 120, verdict: 'ok' }]);
		expect(soundCheckVerdictFor(verdicts(k.h), { frame: 120, clipId: k.clipId })).toMatchObject({
			bound: true,
			clipId: null,
		});
		k.h.ok([{ type: 'soundDesign.setVerdict', frame: 120, verdict: 'flag', clipId: k.clipId }]);
		expect(verdicts(k.h)).toMatchObject([{ verdict: 'flag', clipId: k.clipId }]);
	});

	it('stale when the listened window changes or its clip moves / goes; an edit elsewhere only changes the mix', () => {
		const { h, clipId, clip2 } = fixture();
		h.ok([
			{ type: 'soundDesign.setVerdict', frame: 120, verdict: 'ok', slot: 'hero', clipId },
			{ type: 'soundDesign.setVerdict', frame: 450, verdict: 'ok', slot: 'passing', clipId: clip2 },
		]);
		const stored = h.doc;
		// a gain change of the clip in the window: that moment is stale, the other is not (but the mix changed)
		h.ok([{ type: 'audio.setGain', clipIds: [clipId], mode: 'adjust', db: 3 }]);
		let v = verdicts(h);
		expect(v.find((x) => x.frame === 120)).toMatchObject({ stale: true, staleReasons: ['moment'] });
		expect(v.find((x) => x.frame === 450)).toMatchObject({ stale: false, mixChanged: true });
		// the same for the second hit, 11 s away: the first verdict is untouched
		h.doc = stored;
		h.ok([{ type: 'audio.setGain', clipIds: [clip2], mode: 'adjust', db: 3 }]);
		v = verdicts(h);
		expect(v.find((x) => x.frame === 120)).toMatchObject({ stale: false, mixChanged: true });
		expect(v.find((x) => x.frame === 450)).toMatchObject({ stale: true, staleReasons: ['moment'] });
		// the clip moved away: moved (and the window changed)
		h.doc = stored;
		h.ok([{ type: 'clip.move', clipIds: [clipId], deltaFrames: 200 }]);
		expect(verdicts(h).find((x) => x.frame === 120)).toMatchObject({
			stale: true,
			staleReasons: ['moment', 'moved'],
		});
		// the clip deleted: gone
		h.doc = stored;
		h.ok([{ type: 'clip.lift', clipIds: [clipId] }]);
		expect(verdicts(h).find((x) => x.frame === 120)).toMatchObject({
			stale: true,
			staleReasons: ['moment', 'gone'],
		});
		// a marker or a selection is not an edit of the sound
		h.doc = stored;
		h.ok([{ type: 'marker.add', frame: 121, name: 'note' }]);
		expect(verdicts(h).every((x) => x.stale === false && x.mixChanged === false)).toBe(true);
	});

	it('a cue verdict is stale when the cue moves', () => {
		const { h, cueId } = fixture();
		h.ok([{ type: 'soundDesign.setVerdict', frame: 120, verdict: 'ok', slot: 'passing', cueId }]);
		h.ok([{ type: 'soundCue.update', cueId, frame: 126, moveClips: false }]);
		expect(verdicts(h)[0]).toMatchObject({ cueId, stale: true, staleReasons: ['moved'] });
	});

	it('an agent can write one, but it is not a human verdict', () => {
		const { h, clipId } = fixture();
		h.ok([{ type: 'soundDesign.setVerdict', frame: 120, verdict: 'ok', clipId }], {
			origin: { agent: 'sound-agent' },
		});
		expect(h.seq.markers).toHaveLength(1);
		expect(verdicts(h)).toEqual([]);
	});

	it('refusals: unknown sequence, clip or cue; a frame outside the sequence; a long note; bad fields', () => {
		const { h, clipId } = fixture();
		const refuse = (cmd: Record<string, unknown>, code: string) => {
			const r = h.tx([{ type: 'soundDesign.setVerdict', frame: 120, verdict: 'ok', ...cmd }]);
			expect(r.ok, JSON.stringify(cmd)).toBe(false);
			if (!r.ok) expect(r.errors[0]!.code).toBe(code);
		};
		refuse({ sequenceId: 'seq_nope' }, 'E_NOT_FOUND');
		refuse({ clipId: 'clp_nope' }, 'E_NOT_FOUND');
		refuse({ cueId: 'cue_nope' }, 'E_NOT_FOUND');
		refuse({ frame: 100_000 }, 'E_INVALID_PARAM');
		refuse({ note: 'x'.repeat(2001) }, 'E_SCHEMA');
		refuse({ verdict: 'maybe' }, 'E_SCHEMA');
		refuse({ slot: 'best' }, 'E_SCHEMA');
		refuse({ clipId, extra: 1 }, 'E_SCHEMA');
		expect(h.seq.markers).toEqual([]);
	});

	it('repair drops unreadable verdict data (the marker stays, unbound); idempotent', () => {
		const { h, clipId } = fixture();
		h.ok([{ type: 'soundDesign.setVerdict', frame: 120, verdict: 'flag', clipId, note: 'late' }]);
		const doc = clone(h.doc);
		const seq = Object.values(doc.sequences)[0]!;
		(seq.markers[0] as { soundCheck?: unknown }).soundCheck = { v: 1, verdict: 'flag', mixHash: 7 };
		expect(checkInvariants(doc).some((i) => i.invariant === 'INV-SOUND')).toBe(true);
		const { document, report } = repairDocument(doc, h.ids);
		expect(report).toContainEqual(expect.objectContaining({ action: 'drop-verdict-meta' }));
		const fixed = Object.values(document.sequences)[0]!;
		expect(fixed.markers[0]).not.toHaveProperty('soundCheck');
		expect(soundCheckHumanVerdicts(fixed)).toMatchObject([{ verdict: 'flag', note: 'late', bound: false }]);
		expect(checkInvariants(document)).toEqual([]);
		expect(repairDocument(document, h.ids).report).toEqual([]);
	});

	it('readSoundCheckVerdictMeta and the readers never throw on hostile input', () => {
		fc.assert(
			fc.property(fc.anything(), (v) => {
				const m = readSoundCheckVerdictMeta(v);
				return m === null || (m.v === 1 && (m.verdict === 'ok' || m.verdict === 'flag'));
			}),
			{ numRuns: 300 },
		);
		const { h } = fixture();
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						id: fc.string(),
						frame: fc.oneof(fc.integer({ min: -5, max: 2000 }), fc.double()),
						type: fc.constant('comment'),
						author: fc.constant('user'),
						name: fc.constantFrom(SOUND_CHECK_VERDICT_MARKER.ok, SOUND_CHECK_VERDICT_MARKER.flag),
						soundCheck: fc.oneof(
							fc.anything(),
							fc.record({
								v: fc.constant(1),
								verdict: fc.constantFrom('ok', 'flag'),
								mixHash: fc.string(),
								momentHash: fc.string(),
								subject: fc.anything(),
								slot: fc.anything(),
							}),
						),
					}),
					{ maxLength: 12 },
				),
				fc.integer({ min: -10, max: 10_000 }),
				(markers, frame) => {
					const seq = { ...h.seq, markers };
					const out = soundCheckHumanVerdicts(seq, {
						doc: { ...h.doc, sequences: { [h.seqId]: seq as never } },
					});
					expect(typeof soundCheckMomentHash(h.doc, h.seqId, frame)).toBe('string');
					return out.every((x) => x.stale === null || typeof x.stale === 'boolean');
				},
			),
			{ numRuns: 200 },
		);
	});
});
