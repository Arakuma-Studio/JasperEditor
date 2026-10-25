// Essential Sound ▸ Auto Tag (`essentialSound.autoTag`, spec 12 P6-R3; wp-note "Phase 6 → WP6.3"): tags untyped clips
// with the classified type, marked "auto" until confirmed (`essentialSound.setType` with the same type); a type the user
// set is kept unless `force`; re-tagging an auto clip; `minConfidence`; undo / redo; every refusal; presets keep the
// mark; Clear Audio Type removes it; an unreadable mark is dropped by load / repair; auto-tagged dialogue counts as
// dialogue for `dialogueSpans`.
import { describe, expect, it } from 'vitest';
import {
	type AudioClip,
	checkInvariants,
	dialogueSpans,
	essentialAutoTag,
	newEssentialSound,
	readEssentialSound,
	repairDocument,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function setup(n = 2) {
	const h = new Harness();
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const m = h.registerVideo({ kind: 'audio', seconds: 4 });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: i * 150, tracks: { audio: 'A1' } }]);
	}
	for (const c of h.clips('A1')) ids.push(c.id);
	const clip = (id: string) => h.seq.clips[id] as AudioClip;
	const code = (cmd: Record<string, unknown>) => {
		const r = h.tx([{ type: 'essentialSound.autoTag', ...cmd }]);
		return r.ok ? null : r.errors[0]!.code;
	};
	return { h, ids, clip, code };
}

const music = {
	category: 'music',
	confidence: 0.91,
	scores: { music: 0.9, sfx: 0.2 },
	reasons: ['a steady pulse'],
};
const dialogue = { category: 'dialogue', confidence: 0.83 };

describe('essentialSound.autoTag', () => {
	it('tags untyped clips with the classified type and auto provenance', () => {
		const { h, ids, clip } = setup();
		const [a, b] = ids as [string, string];
		const r = h.ok([{ type: 'essentialSound.autoTag', results: { [a]: music, [b]: dialogue } }]);
		expect(r.results[0]).toEqual({
			tagged: [
				{ clipId: a, audioType: 'music', confidence: 0.91, from: null },
				{ clipId: b, audioType: 'dialogue', confidence: 0.83, from: null },
			],
			skipped: [],
		});
		const ea = readEssentialSound(clip(a).essential)!;
		expect(ea.type).toBe('music');
		expect(ea.tagged).toEqual({
			by: 'auto',
			confidence: 0.91,
			scores: { music: 0.9, sfx: 0.2 },
			reasons: ['a steady pulse'],
		});
		expect(essentialAutoTag(clip(b).essential)).toEqual({ by: 'auto', confidence: 0.83 });
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('never replaces a type the user set, unless force; the same type is SAME', () => {
		const { h, ids, clip } = setup();
		const [a, b] = ids as [string, string];
		h.ok([{ type: 'essentialSound.setType', clipIds: [a], audioType: 'sfx' }]);
		h.ok([{ type: 'essentialSound.setType', clipIds: [b], audioType: 'music' }]);
		h.ok([{ type: 'essentialSound.set', clipIds: [a], values: { 'creative.reverb.on': true } }]);
		const r = h.ok([{ type: 'essentialSound.autoTag', results: { [a]: music, [b]: music } }]);
		expect((r.results[0] as { skipped: { code: string }[] }).skipped.map((s) => s.code)).toEqual([
			'USER_TYPE',
			'SAME',
		]);
		expect(readEssentialSound(clip(a).essential)!.type).toBe('sfx');
		expect(readEssentialSound(clip(a).essential)!.creative.reverb.on).toBe(true);
		const f = h.ok([{ type: 'essentialSound.autoTag', results: { [a]: music, [b]: music }, force: true }]);
		expect((f.results[0] as { tagged: unknown[] }).tagged).toEqual([
			{ clipId: a, audioType: 'music', confidence: 0.91, from: 'sfx' },
		]);
		expect(readEssentialSound(clip(a).essential)!.type).toBe('music');
		expect(essentialAutoTag(clip(a).essential)?.by).toBe('auto');
		// the user's own music clip stays theirs (no mark) even with force
		expect(essentialAutoTag(clip(b).essential)).toBeNull();
	});

	it('re-tags an auto clip: another type resets to its defaults, the same type keeps the settings', () => {
		const { h, ids, clip } = setup(1);
		const a = ids[0]!;
		h.ok([{ type: 'essentialSound.autoTag', results: { [a]: dialogue } }]);
		h.ok([{ type: 'essentialSound.set', clipIds: [a], values: { 'repair.noise.on': true } }]);
		// a slider change does not confirm the type
		expect(essentialAutoTag(clip(a).essential)?.confidence).toBe(0.83);
		h.ok([{ type: 'essentialSound.autoTag', results: { [a]: { category: 'dialogue', confidence: 0.6 } } }]);
		expect(readEssentialSound(clip(a).essential)!.repair.noise.on).toBe(true);
		expect(essentialAutoTag(clip(a).essential)?.confidence).toBe(0.6);
		const r = h.ok([{ type: 'essentialSound.autoTag', results: { [a]: music } }]);
		expect((r.results[0] as { tagged: { from: string }[] }).tagged[0]!.from).toBe('dialogue');
		expect(readEssentialSound(clip(a).essential)!.repair.noise.on).toBe(false);
		expect(readEssentialSound(clip(a).essential)!.type).toBe('music');
	});

	it('Confirm = setType with the same type: the mark goes, settings and effects stay', () => {
		const { h, ids, clip } = setup(1);
		const a = ids[0]!;
		h.ok([{ type: 'essentialSound.autoTag', results: { [a]: dialogue } }]);
		h.ok([{ type: 'essentialSound.set', clipIds: [a], values: { 'repair.noise.on': true } }]);
		const effects = clone(clip(a).effects);
		const r = h.ok([{ type: 'essentialSound.setType', clipIds: [a], audioType: 'dialogue' }]);
		expect(r.results[0]).toMatchObject({ confirmed: [a] });
		expect(essentialAutoTag(clip(a).essential)).toBeNull();
		expect(readEssentialSound(clip(a).essential)!.repair.noise.on).toBe(true);
		expect(clone(clip(a).effects)).toEqual(effects);
		// now it is the user's: Auto Tag leaves it
		const again = h.ok([{ type: 'essentialSound.autoTag', results: { [a]: music } }]);
		expect((again.results[0] as { skipped: { code: string }[] }).skipped[0]!.code).toBe('USER_TYPE');
		// Change = setType with another type: a manual type without a mark
		h.ok([{ type: 'essentialSound.autoTag', results: { [a]: music }, force: true }]);
		h.ok([{ type: 'essentialSound.setType', clipIds: [a], audioType: 'ambience' }]);
		expect(readEssentialSound(clip(a).essential)!.type).toBe('ambience');
		expect(essentialAutoTag(clip(a).essential)).toBeNull();
	});

	it('minConfidence skips weak results (LOW_CONFIDENCE); presets keep the mark; Clear Audio Type removes it', () => {
		const { h, ids, clip } = setup();
		const [a, b] = ids as [string, string];
		const r = h.ok([
			{
				type: 'essentialSound.autoTag',
				results: { [a]: { category: 'sfx', confidence: 0.4 }, [b]: music },
				minConfidence: 0.6,
			},
		]);
		expect(r.results[0]).toMatchObject({
			tagged: [{ clipId: b }],
			skipped: [{ clipId: a, code: 'LOW_CONFIDENCE' }],
		});
		expect(clip(a).essential).toBeUndefined();
		h.ok([{ type: 'essentialSound.applyPreset', clipIds: [b], preset: '(Default)' }]);
		expect(essentialAutoTag(clip(b).essential)?.confidence).toBe(0.91);
		// a user preset carrying a mark does not mark the clip it is applied to
		h.ok([{ type: 'essentialSound.setType', clipIds: [a], audioType: 'music' }]);
		h.ok([
			{
				type: 'essentialSound.applyPreset',
				clipIds: [a],
				settings: { ...newEssentialSound('music'), tagged: { by: 'auto', confidence: 0.5 } },
			},
		]);
		expect(essentialAutoTag(clip(a).essential)).toBeNull();
		h.ok([{ type: 'essentialSound.clearType', clipIds: [b] }]);
		expect(clip(b).essential).toBeUndefined();
	});

	it('refusals: unknown clip, not audio, locked track, empty / malformed / oversized results', () => {
		const { h, ids, code } = setup(1);
		const a = ids[0]!;
		expect(code({ results: { nope: music } })).toBe('E_NOT_FOUND');
		const v = h.registerVideo({ seconds: 2 });
		h.ok([{ type: 'clip.place', source: { mediaId: v }, at: 300, tracks: { video: 'V1' } }]);
		const vid = h.clips('V1')[0]!.id;
		expect(code({ results: { [vid]: music } })).toBe('E_INVALID_PARAM');
		expect(code({ results: {} })).toBe('E_SCHEMA');
		expect(code({ results: { [a]: { category: 'speech', confidence: 0.5 } } })).toBe('E_SCHEMA');
		expect(code({ results: { [a]: { category: 'music', confidence: 1.5 } } })).toBe('E_SCHEMA');
		expect(code({ results: { [a]: { category: 'music', confidence: 0.5, extra: 1 } } })).toBe('E_SCHEMA');
		expect(code({ results: { [a]: music }, minConfidence: 2 })).toBe('E_SCHEMA');
		const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`c${i}`, music]));
		expect(code({ results: many })).toBe('E_SCHEMA');
		h.ok([{ type: 'track.update', trackId: h.seq.clips[a]!.trackId, patch: { locked: true } }]);
		expect(code({ results: { [a]: music } })).toBe('E_TRACK_LOCKED');
	});

	it('an unreadable mark is reported and dropped by repair (the type and settings stay)', () => {
		const { h, ids } = setup(1);
		const a = ids[0]!;
		h.ok([{ type: 'essentialSound.autoTag', results: { [a]: music } }]);
		const doc = clone(h.doc);
		const c = doc.sequences[h.seqId]!.clips[a] as AudioClip & { essential: { tagged: unknown } };
		c.essential.tagged = { by: 'robot', confidence: 'high' };
		expect(essentialAutoTag(c.essential)).toBeNull();
		expect(
			checkInvariants(doc).some((i) => (i as { invariant?: string }).invariant === 'INV-ESSENTIAL'),
		).toBe(true);
		const fixed = repairDocument(doc, h.ids);
		const fc = fixed.document.sequences[h.seqId]!.clips[a] as AudioClip;
		expect(readEssentialSound(fc.essential)!.type).toBe('music');
		expect((fc.essential as { tagged?: unknown }).tagged).toBeUndefined();
		expect(checkInvariants(fixed.document)).toEqual([]);
	});

	it('auto-tagged dialogue is dialogue for dialogueSpans (whole clip without voice activity)', () => {
		const { h, ids } = setup(1);
		const a = ids[0]!;
		expect(dialogueSpans(h.doc, h.seq)).toEqual([]);
		h.ok([{ type: 'essentialSound.autoTag', results: { [a]: dialogue } }]);
		const spans = dialogueSpans(h.doc, h.seq);
		expect(spans).toEqual([
			{ start: 0, end: 120, clipIds: [a], trackIds: [h.seq.clips[a]!.trackId], sources: ['clip'] },
		]);
	});
});
