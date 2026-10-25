// Acknowledged Sound Check findings (spec 12 §4 P6-E4; wp-note "Phase 6 → WP-E2"): `soundDesign.acknowledgeIssue` /
// `unacknowledgeIssue` (immutability, refusals — an agent acknowledging an error is E_APPROVAL_REQUIRED, limits), the
// marks `applySoundAcknowledgements` puts on a report's findings (left out of the verdict, counted, back after the
// target changed, worse or an agent's word on an error), load / repair (malformed entries dropped, idempotent), a copied
// sequence starting without them, and fuzz (hostile entries and findings never throw).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applySoundAcknowledgements,
	checkInvariants,
	createCounterIdSource,
	type LibraryProvenance,
	loadProject,
	makeEnvelope,
	readSoundAcknowledgements,
	readSoundDesign,
	repairDocument,
	SOUND_DESIGN_LIMITS,
	type SoundAckFinding,
	soundAckInputsHash,
	soundAcknowledgementsOf,
	soundAckTargetOf,
	soundDesignIssue,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const AGENT = { agent: 'test-agent' };

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
	const music = h.registerVideo({ kind: 'audio', seconds: 10 });
	const mus = h.ok([{ type: 'clip.place', source: { mediaId: music }, at: 0, ref: '$m' }]);
	const cue = h.ok([
		{ type: 'soundCue.add', cues: [{ frame: 40, kind: 'cut', weight: 'hero', source: 'user', ref: '$c' }] },
		{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId: m, ref: '$x' }] },
	]);
	const clipId = cue.refs.$x!;
	const cueId = cue.refs.$c!;
	// three findings as a report gives them: a warning about the clip, an error about it, a frame-only warning
	const masked: SoundAckFinding = {
		id: `MASKED:${clipId}`,
		code: 'MASKED',
		severity: 'warning',
		clipIds: [clipId],
		cueId,
		frame: 40,
		message: { text: 'Hero sound Hit at 00:00:01:10 clears the bed by only 1.0 dB' },
	};
	const sync: SoundAckFinding = {
		id: `OUT_OF_SYNC:${clipId}`,
		code: 'OUT_OF_SYNC',
		severity: 'error',
		clipIds: [clipId],
		cueId,
		frame: 40,
	};
	const silence: SoundAckFinding = {
		id: 'SILENCE:120',
		code: 'SILENCE',
		severity: 'warning',
		range: { start: 120, end: 150 },
	};
	return { h, clipId, cueId, musicClip: mus.refs.$m!, masked, sync, silence };
}

const ackCmd = (
	f: SoundAckFinding,
	reason = 'A hard cut on purpose',
	over: Record<string, unknown> = {},
) => ({
	type: 'soundDesign.acknowledgeIssue',
	key: f.id,
	code: f.code,
	severity: f.severity,
	reason,
	target: soundAckTargetOf(f),
	...(f.message?.text ? { message: f.message.text } : {}),
	...over,
});

describe('soundDesign.acknowledgeIssue / unacknowledgeIssue', () => {
	it('stores the acknowledgement (user, reason, target, hash); immutability; unacknowledge removes it', () => {
		const { h, clipId, cueId, masked } = fixture();
		const before = h.doc;
		const snapshot = clone(before);
		const r = h.ok([ackCmd(masked)], { label: 'Acknowledge Sound Check Finding' });
		const entry = soundAcknowledgementsOf(h.seq)[masked.id]!;
		expect(r.results[0]).toEqual({ key: masked.id, acknowledged: entry });
		expect(entry).toMatchObject({
			code: 'MASKED',
			severity: 'warning',
			reason: 'A hard cut on purpose',
			by: 'user',
			at: '2026-09-30T10:00:00.000Z',
			target: { clipIds: [clipId], cueId },
			message: masked.message!.text,
		});
		expect(entry.agent).toBeUndefined();
		expect(entry.inputsHash).toBe(soundAckInputsHash(h.doc, h.seqId, { clipIds: [clipId], cueId }));
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(soundDesignIssue((h.seq as { soundDesign?: unknown }).soundDesign)).toBeNull();
		// The previous document stays unchanged.
		expect(before).toEqual(snapshot);
		// acknowledged again: replaced (one entry, the new reason)
		h.ok([ackCmd(masked, 'Quiet on purpose under the voice')]);
		expect(Object.keys(soundAcknowledgementsOf(h.seq))).toEqual([masked.id]);
		expect(soundAcknowledgementsOf(h.seq)[masked.id]!.reason).toBe('Quiet on purpose under the voice');
		// Unacknowledge removes the final entry and the empty field.
		const u = h.ok([{ type: 'soundDesign.unacknowledgeIssue', key: masked.id }]);
		expect((u.results[0] as { removed: { reason: string } }).removed.reason).toBe(
			'Quiet on purpose under the voice',
		);
		expect((h.seq as { soundDesign?: { acknowledged?: unknown } }).soundDesign?.acknowledged).toBeUndefined();
	});

	it('agents: warnings and infos yes (by agent, its name); an error is E_APPROVAL_REQUIRED; the user may', () => {
		const { h, masked, sync, silence } = fixture();
		const before = h.doc;
		const r = h.tx([ackCmd(sync, 'It is fine')], { origin: AGENT });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]!.code).toBe('E_APPROVAL_REQUIRED');
			expect(r.errors[0]!.message).toMatch(/Only the user can acknowledge an error/);
		}
		expect(h.doc).toBe(before);
		h.ok([ackCmd(masked), ackCmd(silence, 'A beat of silence before the logo')], { origin: AGENT });
		const acks = soundAcknowledgementsOf(h.seq);
		expect(acks[masked.id]).toMatchObject({ by: 'agent', agent: 'test-agent' });
		expect(acks[silence.id]).toMatchObject({ by: 'agent', target: { frame: 120 } });
		h.ok([ackCmd(sync, 'The hit lands early on purpose')]);
		expect(soundAcknowledgementsOf(h.seq)[sync.id]).toMatchObject({ by: 'user', severity: 'error' });
		// an agent may take back any acknowledgement (that only brings the finding back)
		h.ok([{ type: 'soundDesign.unacknowledgeIssue', key: sync.id }], { origin: AGENT });
		expect(soundAcknowledgementsOf(h.seq)[sync.id]).toBeUndefined();
	});

	it('refusals', () => {
		const { h, masked } = fixture();
		const code = (cmd: Record<string, unknown>, origin?: unknown) => {
			const r = h.tx([cmd], origin ? { origin } : {});
			return r.ok ? 'ok' : r.errors[0]!.code;
		};
		const base = ackCmd(masked);
		expect(code({ ...base, reason: '' })).toBe('E_SCHEMA');
		expect(code({ ...base, reason: '   ' })).toBe('E_INVALID_PARAM');
		expect(code({ ...base, reason: 'x'.repeat(301) })).toBe('E_SCHEMA');
		expect(code({ ...base, key: 'masked:clp' })).toBe('E_SCHEMA');
		expect(code({ ...base, key: `MASKED:${'x'.repeat(250)}` })).toBe('E_SCHEMA');
		expect(code({ ...base, code: 'LOUD' })).toBe('E_SCHEMA');
		expect(code({ ...base, code: 'SILENCE' })).toBe('E_INVALID_PARAM');
		expect(code({ ...base, severity: 'fatal' })).toBe('E_SCHEMA');
		expect(code({ ...base, target: { clipIds: ['clp_nope'] } })).toBe('E_NOT_FOUND');
		expect(code({ ...base, target: { cueId: 'cue_nope' } })).toBe('E_NOT_FOUND');
		expect(code({ ...base, target: { frame: 999_999 } })).toBe('E_INVALID_PARAM');
		expect(code({ ...base, target: { frame: 3, extra: 1 } })).toBe('E_SCHEMA');
		expect(code({ ...base, sequenceId: 'seq_nope' })).toBe('E_NOT_FOUND');
		expect(code({ ...base, extra: true })).toBe('E_SCHEMA');
		expect(code({ type: 'soundDesign.unacknowledgeIssue', key: masked.id })).toBe('E_NOT_FOUND');
		expect(code({ type: 'soundDesign.unacknowledgeIssue', key: 'nope' })).toBe('E_SCHEMA');
		expect(code(base)).toBe('ok');
	});

	it('at most 500 per sequence (E_LIMIT); re-acknowledging one of them still works', () => {
		const { h } = fixture();
		const many = Array.from({ length: SOUND_DESIGN_LIMITS.acknowledged }, (_, i) => ({
			type: 'soundDesign.acknowledgeIssue',
			key: `SILENCE:${i}`,
			code: 'SILENCE',
			severity: 'warning',
			reason: 'quiet on purpose',
			target: { frame: i % 200 },
		}));
		h.ok(many);
		expect(Object.keys(soundAcknowledgementsOf(h.seq))).toHaveLength(500);
		expect(checkInvariants(h.doc)).toEqual([]);
		const r = h.tx([{ ...many[0]!, key: 'SILENCE:9999' }]);
		expect(r.ok ? 'ok' : r.errors[0]!.code).toBe('E_LIMIT');
		h.ok([{ ...many[3]!, reason: 'still quiet on purpose' }]);
		expect(soundAcknowledgementsOf(h.seq)['SILENCE:3']!.reason).toBe('still quiet on purpose');
	});
});

describe('applySoundAcknowledgements (what Sound Check reports)', () => {
	it('an acknowledged finding is left out of the verdict and counted; listed with its reason', () => {
		const { h, masked, silence } = fixture();
		const issues = [masked, silence];
		const none = applySoundAcknowledgements(h.doc, h.seqId, issues);
		expect(none).toMatchObject({
			verdict: 'warn',
			acknowledged: 0,
			counts: { warning: 2, MASKED: 1, SILENCE: 1 },
		});
		expect(none.unmatched).toEqual([]);
		h.ok([ackCmd(masked), ackCmd(silence, 'A beat of air before the logo')]);
		const r = applySoundAcknowledgements(h.doc, h.seqId, issues);
		expect(r.verdict).toBe('pass');
		expect(r.acknowledged).toBe(2);
		expect(r.counts).toEqual({ acknowledged: 2 });
		expect(r.open).toEqual([]);
		expect(r.issues[0]!.acknowledged).toEqual({
			reason: 'A hard cut on purpose',
			by: 'user',
			at: '2026-09-30T10:00:00.000Z',
			active: true,
		});
		// a mark already on a report read back is replaced by what the document says now
		const again = applySoundAcknowledgements(h.doc, h.seqId, r.issues);
		expect(again.issues).toEqual(r.issues);
	});

	it('editing the clip brings the finding back, "acknowledged before the change"; restoring the original document hides it again', () => {
		const { h, clipId, musicClip, masked, silence } = fixture();
		h.ok([ackCmd(masked), ackCmd(silence, 'quiet on purpose')]);
		const acked = h.doc;
		h.ok([{ type: 'audio.setGain', clipIds: [clipId], mode: 'adjust', db: 2 }]);
		let r = applySoundAcknowledgements(h.doc, h.seqId, [masked, silence]);
		expect(r.verdict).toBe('warn');
		expect(r.issues[0]!.acknowledged).toMatchObject({ active: false, why: 'changed' });
		expect(r.issues[1]!.acknowledged).toMatchObject({ active: true });
		expect(r.counts).toEqual({ MASKED: 1, warning: 1, acknowledged: 1 });
		// a frame-only target follows what plays around its frame: the music under it changed
		h.doc = acked;
		h.ok([{ type: 'audio.setGain', clipIds: [musicClip], mode: 'adjust', db: -3 }]);
		r = applySoundAcknowledgements(h.doc, h.seqId, [masked, silence]);
		expect(r.issues[1]!.acknowledged).toMatchObject({ active: false, why: 'changed' });
		// renaming the clip changes nothing that sounds
		h.doc = acked;
		h.ok([{ type: 'clip.update', clipId, patch: { name: 'Renamed' } }]);
		r = applySoundAcknowledgements(h.doc, h.seqId, [masked, silence]);
		expect(r.acknowledged).toBe(2);
		h.doc = acked;
		expect(applySoundAcknowledgements(h.doc, h.seqId, [masked, silence]).acknowledged).toBe(2);
	});

	it('a finding worse than what was acknowledged, and an agent’s acknowledgement of an error, count again', () => {
		const { h, masked, sync } = fixture();
		h.ok([ackCmd(masked)], { origin: AGENT });
		const worse = applySoundAcknowledgements(h.doc, h.seqId, [{ ...masked, severity: 'error' }]);
		expect(worse.verdict).toBe('fail');
		expect(worse.issues[0]!.acknowledged).toMatchObject({ active: false, why: 'needs-user' });
		// an agent writing "warning" for an error finding: the check does not trust it
		h.ok([ackCmd({ ...sync, severity: 'warning' })], { origin: AGENT });
		const lied = applySoundAcknowledgements(h.doc, h.seqId, [sync]);
		expect(lied.issues[0]!.acknowledged).toMatchObject({ active: false, why: 'needs-user' });
		expect(lied.verdict).toBe('fail');
		// the user's acknowledgement of a warning does not cover the same finding as an error
		h.ok([ackCmd(masked)]);
		const userWorse = applySoundAcknowledgements(h.doc, h.seqId, [{ ...masked, severity: 'error' }]);
		expect(userWorse.issues[0]!.acknowledged).toMatchObject({ active: false, why: 'worse' });
		// an info is covered by an acknowledged warning
		expect(applySoundAcknowledgements(h.doc, h.seqId, [{ ...masked, severity: 'info' }]).acknowledged).toBe(
			1,
		);
	});

	it('acknowledgements no finding matches are listed (fixed since, or outside the range); another code never matches', () => {
		const { h, masked, silence } = fixture();
		h.ok([ackCmd(masked), ackCmd(silence, 'quiet')]);
		const r = applySoundAcknowledgements(h.doc, h.seqId, [{ ...masked, code: 'HARSH' }]);
		expect(r.acknowledged).toBe(0);
		expect(r.unmatched.map((u) => u.key).sort()).toEqual([masked.id, silence.id].sort());
		expect(r.unmatched.find((u) => u.key === masked.id)!.message).toBe(masked.message!.text);
	});
});

describe('acknowledgements: load, repair, copies', () => {
	it('survive load; malformed entries are dropped by repair (idempotent); the key must start with its code', () => {
		const { h, masked, silence } = fixture();
		h.ok([ackCmd(masked), ackCmd(silence, 'quiet')]);
		const env = makeEnvelope(h.doc, { revision: 1, savedAt: '2026-10-18T00:00:00.000Z', platform: 'test' });
		const loaded = loadProject(JSON.parse(JSON.stringify(env))).document;
		expect(Object.keys(soundAcknowledgementsOf(loaded.sequences[h.seqId])).sort()).toEqual(
			[masked.id, silence.id].sort(),
		);
		const bad = clone(h.doc);
		const sd = (
			bad.sequences[h.seqId] as { soundDesign: { acknowledged: Record<string, Record<string, unknown>> } }
		).soundDesign;
		sd.acknowledged[masked.id]!.reason = '';
		sd.acknowledged['NOT A KEY'] = { ...sd.acknowledged[silence.id]! };
		sd.acknowledged['HARSH:x'] = { ...sd.acknowledged[silence.id]! };
		expect(soundDesignIssue(sd)).not.toBeNull();
		expect(checkInvariants(bad).length).toBeGreaterThan(0);
		expect(Object.keys(readSoundDesign(sd)!.acknowledged!)).toEqual([silence.id]);
		const once = repairDocument(bad, createCounterIdSource(77)).document;
		const twice = repairDocument(once, createCounterIdSource(78)).document;
		expect(twice).toEqual(once);
		expect(checkInvariants(once)).toEqual([]);
		expect(Object.keys(soundAcknowledgementsOf(once.sequences[h.seqId]))).toEqual([silence.id]);
		// all unreadable: the field goes
		sd.acknowledged = { x: 1 } as never;
		expect(readSoundDesign(sd)!.acknowledged).toBeUndefined();
		// more than 500: the most recent kept
		const many: Record<string, unknown> = {};
		for (let i = 0; i < 520; i++)
			many[`SILENCE:${i}`] = {
				...clone(soundAcknowledgementsOf(h.seq)[silence.id]!),
				at: `2026-10-18T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
			};
		const kept = readSoundAcknowledgements(many)!;
		expect(Object.keys(kept)).toHaveLength(500);
		expect(kept['SILENCE:519']).toBeDefined();
		expect(kept['SILENCE:0']).toBeUndefined();
	});

	it('a duplicated sequence starts without acknowledgements', () => {
		const { h, masked } = fixture();
		h.ok([ackCmd(masked)]);
		const r = h.ok([{ type: 'sequence.duplicate', sequenceId: h.seqId }]);
		const copyId = (r.results[0] as { sequenceId: string }).sequenceId;
		expect(Object.keys(soundAcknowledgementsOf(h.doc.sequences[copyId]))).toEqual([]);
		expect(Object.keys(soundAcknowledgementsOf(h.doc.sequences[h.seqId]))).toEqual([masked.id]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('fuzz: hostile acknowledgements and findings never throw; repair always ends valid', () => {
		const { h } = fixture();
		const entry = fc.record(
			{
				code: fc.oneof(fc.constantFrom('MASKED', 'SILENCE', 'x', ''), fc.string()),
				severity: fc.oneof(fc.constantFrom('error', 'warning', 'info'), fc.anything()),
				reason: fc.oneof(fc.string({ maxLength: 400 }), fc.anything()),
				by: fc.oneof(fc.constantFrom('user', 'agent'), fc.anything()),
				at: fc.oneof(fc.string(), fc.anything()),
				target: fc.anything(),
				inputsHash: fc.oneof(fc.string(), fc.anything()),
			},
			{ requiredKeys: [] },
		);
		const acks = fc.dictionary(
			fc.oneof(fc.constantFrom('MASKED:clp_1', 'SILENCE:3', '__proto__'), fc.string()),
			fc.oneof(entry, fc.anything()),
		);
		const finding = fc.record(
			{
				id: fc.oneof(fc.constantFrom('MASKED:clp_1', 'SILENCE:3'), fc.string(), fc.anything()),
				code: fc.oneof(fc.constantFrom('MASKED', 'SILENCE'), fc.anything()),
				severity: fc.oneof(fc.constantFrom('error', 'warning', 'info'), fc.anything()),
				clipIds: fc.anything(),
				cueId: fc.anything(),
				frame: fc.anything(),
				range: fc.anything(),
			},
			{ requiredKeys: [] },
		);
		fc.assert(
			fc.property(acks, fc.array(fc.oneof(finding, fc.anything()), { maxLength: 8 }), (a, fs) => {
				const doc = clone(h.doc);
				(doc.sequences[h.seqId] as { soundDesign: Record<string, unknown> }).soundDesign.acknowledged = a;
				const r = applySoundAcknowledgements(doc, h.seqId, fs as SoundAckFinding[]);
				expect(['pass', 'warn', 'fail']).toContain(r.verdict);
				readSoundAcknowledgements(a);
				soundAckTargetOf((fs[0] ?? {}) as SoundAckFinding);
				const fixed = repairDocument(doc, createCounterIdSource(5)).document;
				expect(checkInvariants(fixed)).toEqual([]);
			}),
			{ numRuns: 150 },
		);
	});
});
