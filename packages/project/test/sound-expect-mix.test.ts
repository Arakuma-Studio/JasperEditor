// `soundDesign.expectMix` (WP6.5b): the precondition the rebalance and delivery jobs put first in their transaction, so an
// edit of the mix landing between their last check and the apply refuses the transaction where it applies instead of
// being fast-forwarded over (S01:AGT-010 only refuses edits of the entities a transaction touches). Changes nothing;
// typed refusals; `mixFingerprint` reads a document and its JSON copy alike (the engine measures a JSON copy, the
// editor session checks its own in-memory document).
import { describe, expect, it } from 'vitest';
import { mixFingerprint, type ProjectDocument, soundDesignSettingsOf } from '../src/index.ts';
import { Harness } from './helpers.ts';

function setup() {
	const h = new Harness();
	const place = (track: string, type: string) => {
		const m = h.registerVideo({ kind: 'audio', seconds: 10 });
		const r = h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: track } }]);
		const id = (r.results[0] as { clipIds: string[] }).clipIds[0]!;
		h.ok([{ type: 'essentialSound.setType', clipIds: [id], audioType: type }]);
		return id;
	};
	const music = place('A1', 'music');
	const hit = place('A2', 'sfx');
	return { h, music, hit };
}
const expect_ = (h: Harness, extra: object = {}) => ({
	type: 'soundDesign.expectMix',
	mixHash: mixFingerprint(h.doc, h.seqId),
	...extra,
});
type Refused = {
	ok: false;
	errors: { code: string; message: string; commandIndex: number; blocking?: string[] }[];
};

describe('soundDesign.expectMix', () => {
	it('passes on the measured mix and changes nothing (no History entry, same document)', () => {
		const { h } = setup();
		const before = structuredClone(h.doc);
		const r = h.ok([expect_(h, { delivery: soundDesignSettingsOf(h.seq).delivery })]);
		expect(r.results[0]).toEqual({ sequenceId: h.seqId, mixHash: mixFingerprint(before, h.seqId) });
		expect(h.doc).toEqual(before);
		expect(r.changed).toEqual([]);
		expect(r.revision).toBe(h.revision);
	});

	it('then the rest of the guarded transaction applies', () => {
		const { h, hit } = setup();
		const before = structuredClone(h.doc);
		h.ok([expect_(h), { type: 'audio.setGain', clipIds: [hit], mode: 'set', db: -9 }]);
		expect((h.seq.clips[hit] as { gainDb: number }).gainDb).toBe(-9);
		expect(mixFingerprint(h.doc, h.seqId)).not.toBe(mixFingerprint(before, h.seqId));
	});

	it('refuses with E_REVISION_MISMATCH (nothing applied) when the mix or the delivery changed', () => {
		const { h, music, hit } = setup();
		const measured = expect_(h, { delivery: 'web' });
		h.ok([{ type: 'audio.setGain', clipIds: [music], mode: 'adjust', db: 6 }]);
		const before = structuredClone(h.doc);
		const r = h.tx([measured, { type: 'audio.setGain', clipIds: [hit], mode: 'set', db: -9 }]) as Refused;
		expect(r.ok).toBe(false);
		expect(r.errors[0]).toMatchObject({ code: 'E_REVISION_MISMATCH', commandIndex: 0, blocking: [h.seqId] });

		expect(h.doc).toEqual(before);
		// the delivery setting is part of what was measured
		const fresh = setup();
		const other = soundDesignSettingsOf(fresh.h.seq).delivery === 'web' ? 'broadcast-r128' : 'web';
		const d = fresh.h.tx([expect_(fresh.h, { delivery: other })]) as Refused;
		expect(d.errors[0]!.code).toBe('E_REVISION_MISMATCH');
		// renaming a clip or a track is not a change of the mix
		const g = setup();
		const m = expect_(g.h);
		g.h.ok([{ type: 'track.update', trackId: 'A1', patch: { name: 'Score' } }]);
		expect(g.h.tx([m]).ok).toBe(true);
	});

	it('closes the fast-forward window: an untouched edit since expectedRevision refuses the guarded transaction', () => {
		const { h, music, hit } = setup();
		const at = h.revision;
		const guard = expect_(h);
		// the user raises the music (the bed) after the job measured at `at`
		h.ok([{ type: 'audio.setGain', clipIds: [music], mode: 'adjust', db: 6 }]);
		const gains = { type: 'audio.setGain', clipIds: [hit], mode: 'set', db: -9 };
		// without the guard the job's transaction (it touches only the sound effect) is fast-forwarded…
		const probe = new Harness();
		Object.assign(probe, { doc: h.doc, revision: h.revision, entityRevisions: new Map(h.entityRevisions) });
		expect(probe.tx([gains], { expectedRevision: at }).ok).toBe(true);
		// …with it, it is refused
		const r = h.tx([guard, gains], { expectedRevision: at }) as Refused;
		expect(r.ok).toBe(false);
		expect(r.errors[0]!.code).toBe('E_REVISION_MISMATCH');
	});

	it('typed refusals: unknown sequence, bad arguments', () => {
		const { h } = setup();
		const code = (cmd: object) => (h.tx([cmd]) as Refused).errors?.[0]?.code;
		expect(code({ type: 'soundDesign.expectMix', sequenceId: 'seq_00000000000none', mixHash: 'x' })).toBe(
			'E_NOT_FOUND',
		);
		expect(code({ type: 'soundDesign.expectMix', mixHash: '' })).toBe('E_SCHEMA');
		expect(code({ type: 'soundDesign.expectMix', mixHash: 'a'.repeat(257) })).toBe('E_SCHEMA');
		expect(code({ type: 'soundDesign.expectMix', mixHash: 'x', delivery: 'cinema' })).toBe('E_SCHEMA');
		expect(code({ type: 'soundDesign.expectMix', mixHash: 'x', extra: 1 })).toBe('E_SCHEMA');
	});
});

describe('mixFingerprint of a document and its JSON copy', () => {
	it('is the same when a key holds undefined (JSON drops it)', () => {
		const { h, music } = setup();
		const json = JSON.parse(JSON.stringify(h.doc)) as ProjectDocument;
		const withUndefined = structuredClone(h.doc) as ProjectDocument;
		const clip = withUndefined.sequences[h.seqId]!.clips[music] as unknown as Record<string, unknown>;
		clip.notAField = undefined;
		(withUndefined.sequences[h.seqId]!.master as unknown as Record<string, unknown>).extra = undefined;
		expect(mixFingerprint(withUndefined, h.seqId)).toBe(mixFingerprint(json, h.seqId));
		expect(mixFingerprint(h.doc, h.seqId)).toBe(mixFingerprint(json, h.seqId));
	});
});
