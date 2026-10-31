// Spec 18 AF-BRF-001…003: `Sequence.brief` (`sequence.setBrief`: merge, clear, refusals, one undo step), the project's
// agent notes (`project.addAgentNote` signed by the agent of the transaction, `project.removeAgentNote` approval-gated
// for agents, E_LIMIT at 500), INV-BRIEF / INV-AGENT-NOTES, the conservative load repair (reported, idempotent,
// fast-check properties) and the save / load round trip.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	AGENT_NOTE_LIMITS,
	agentNotesIssue,
	approvalReasons,
	briefAspect,
	CURRENT_SCHEMA_VERSION,
	checkInvariants,
	createCounterIdSource,
	cutText,
	DELIVERY_ASPECTS,
	DELIVERY_TARGETS,
	loadProject,
	makeEnvelope,
	type ProjectDocument,
	readAgentNotes,
	readSequenceBrief,
	repairAgentNotes,
	repairDocument,
	repairSequenceBrief,
	sequenceBriefIssue,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const code = (r: ReturnType<Harness['tx']>) => (r.ok ? 'ok' : r.errors[0]!.code);
const briefOf = (h: Harness) => (h.seq as { brief?: unknown }).brief;
const AGENT = { agent: 'claude-code' };

describe('sequence.setBrief (AF-BRF-001)', () => {
	it('sets, merges and clears the brief; each call is one step and the previous document is kept', () => {
		const h = new Harness();
		const before = h.doc;
		const r = h.ok([
			{
				type: 'sequence.setBrief',
				brief: { text: 'A teaser', platform: 'tiktok', targetDurationSec: 30 },
			},
		]);
		expect(r.results[0]).toEqual({
			sequenceId: h.seqId,
			brief: { text: 'A teaser', platform: 'tiktok', targetDurationSec: 30 },
		});
		expect(briefOf(h)).toEqual({ text: 'A teaser', platform: 'tiktok', targetDurationSec: 30 });
		expect((before.sequences[h.seqId] as { brief?: unknown }).brief).toBeUndefined();
		const mid = h.doc;
		// merge: omitted fields kept, null clears one field
		h.ok([{ type: 'sequence.setBrief', brief: { aspect: '9:16', platform: null } }]);
		expect(briefOf(h)).toEqual({ text: 'A teaser', targetDurationSec: 30, aspect: '9:16' });
		expect((mid.sequences[h.seqId] as { brief?: unknown }).brief).toEqual({
			text: 'A teaser',
			platform: 'tiktok',
			targetDurationSec: 30,
		});
		expect(checkInvariants(h.doc)).toEqual([]);
		// an empty brief is not stored
		h.ok([{ type: 'sequence.setBrief', brief: { text: '', targetDurationSec: null, aspect: null } }]);
		expect(briefOf(h)).toBeUndefined();
		h.ok([{ type: 'sequence.setBrief', brief: { text: 'Again' } }]);
		h.ok([{ type: 'sequence.setBrief', brief: null }]);
		expect(briefOf(h)).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('accepts every delivery target and aspect, and agents may set it without approval', () => {
		const h = new Harness();
		for (const t of DELIVERY_TARGETS)
			h.ok([{ type: 'sequence.setBrief', brief: { platform: t.id, aspect: t.aspect } }], { origin: AGENT });
		for (const a of DELIVERY_ASPECTS) h.ok([{ type: 'sequence.setBrief', brief: { aspect: a } }]);
		expect(approvalReasons({ commands: [{ type: 'sequence.setBrief', brief: { text: 'x' } }] })).toEqual([]);
	});

	it('refuses unknown platforms and aspects, out-of-range lengths, long texts, unknown keys and sequences', () => {
		const h = new Harness();
		const bad: unknown[] = [
			{ platform: 'myspace' },
			{ aspect: '4:3' },
			{ targetDurationSec: 0.5 },
			{ targetDurationSec: 36_001 },
			{ targetDurationSec: Number.NaN },
			{ text: 'x'.repeat(8_001) },
			{ colour: 'red' },
		];
		for (const brief of bad) expect(code(h.tx([{ type: 'sequence.setBrief', brief }]))).toBe('E_SCHEMA');
		expect(code(h.tx([{ type: 'sequence.setBrief', sequenceId: 'seq_nope', brief: { text: 'x' } }]))).toBe(
			'E_NOT_FOUND',
		);
		h.ok([{ type: 'sequence.setBrief', brief: { text: 'x'.repeat(8_000), targetDurationSec: 36_000 } }]);
		expect(briefOf(h)).toBeDefined();
	});

	it('a duplicated sequence keeps its brief', () => {
		const h = new Harness();
		h.ok([{ type: 'sequence.setBrief', brief: { text: 'Keep me', platform: 'youtube' } }]);
		const r = h.ok([{ type: 'sequence.duplicate', sequenceId: h.seqId }]);
		const copy = Object.values(h.doc.sequences).find((s) => s.id !== h.seqId)!;
		expect(r.ok).toBe(true);
		expect(readSequenceBrief(copy)).toEqual({ text: 'Keep me', platform: 'youtube' });
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('briefAspect: own aspect, else the platform aspect', () => {
		expect(briefAspect(null)).toBeNull();
		expect(briefAspect({ text: '' })).toBeNull();
		expect(briefAspect({ text: '', platform: 'tiktok' })).toBe('9:16');
		expect(briefAspect({ text: '', platform: 'linkedin' })).toBe('1:1');
		expect(briefAspect({ text: '', platform: 'tiktok', aspect: '4:5' })).toBe('4:5');
	});
});

describe('agent notes (AF-BRF-002)', () => {
	it('adds notes signed by the agent of the transaction; removal is one step; undo keeps the previous document', () => {
		const h = new Harness();
		const before = h.doc;
		const a = h.ok([{ type: 'project.addAgentNote', text: 'Take 3 is best', author: 'someone-else' }], {
			origin: AGENT,
		});
		const id = (a.results[0] as { noteId: string }).noteId;
		expect(id).toMatch(/^agn_/);
		expect(a.results[0]).toEqual({ noteId: id, at: '2026-09-30T10:00:00.000Z', author: 'claude-code' });
		h.ok([{ type: 'project.addAgentNote', text: 'From the user' }]);
		h.ok([{ type: 'project.addAgentNote', text: 'Signed', author: 'Editor' }]);
		expect(readAgentNotes(h.doc).map((n) => [n.author, n.text])).toEqual([
			['claude-code', 'Take 3 is best'],
			['user', 'From the user'],
			['Editor', 'Signed'],
		]);
		expect(before.agentNotes).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
		const mid = h.doc;
		h.ok([{ type: 'project.removeAgentNote', noteId: id }]);
		expect(readAgentNotes(h.doc).map((n) => n.text)).toEqual(['From the user', 'Signed']);
		expect(readAgentNotes(mid)).toHaveLength(3);
		for (const n of readAgentNotes(h.doc)) h.ok([{ type: 'project.removeAgentNote', noteId: n.id }]);
		expect(h.doc.agentNotes).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('refuses empty or long notes and authors, unknown notes, and more than 500 notes (E_LIMIT)', () => {
		const h = new Harness();
		expect(code(h.tx([{ type: 'project.addAgentNote', text: '' }]))).toBe('E_SCHEMA');
		expect(code(h.tx([{ type: 'project.addAgentNote', text: '   ' }]))).toBe('E_SCHEMA');
		expect(code(h.tx([{ type: 'project.addAgentNote', text: 'x'.repeat(4_001) }]))).toBe('E_SCHEMA');
		expect(code(h.tx([{ type: 'project.addAgentNote', text: 'x', author: 'a'.repeat(65) }]))).toBe(
			'E_SCHEMA',
		);
		expect(code(h.tx([{ type: 'project.removeAgentNote', noteId: 'agn_0000000000000001' }]))).toBe(
			'E_NOT_FOUND',
		);
		h.ok(
			Array.from({ length: AGENT_NOTE_LIMITS.maxEntries }, (_, i) => ({
				type: 'project.addAgentNote',
				text: `note ${i}`,
			})),
		);
		expect(code(h.tx([{ type: 'project.addAgentNote', text: 'one more' }], { origin: AGENT }))).toBe(
			'E_LIMIT',
		);
		expect(readAgentNotes(h.doc)).toHaveLength(AGENT_NOTE_LIMITS.maxEntries);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('an agent long name is cut to 64 characters', () => {
		const h = new Harness();
		h.ok([{ type: 'project.addAgentNote', text: 'x' }], { origin: { agent: 'n'.repeat(80) } });
		expect(readAgentNotes(h.doc)[0]!.author).toBe('n'.repeat(64));
	});

	it('agents need the user approval to remove a note; adding one does not', () => {
		expect(approvalReasons({ commands: [{ type: 'project.removeAgentNote', noteId: 'agn_x' }] })).toEqual([
			'project.removeAgentNote (command 1)',
		]);
		expect(approvalReasons({ commands: [{ type: 'project.addAgentNote', text: 'x' }] })).toEqual([]);
	});
});

describe('reading and repair (AF-BRF-003)', () => {
	function damaged(brief: unknown, notes?: unknown): ProjectDocument {
		const h = new Harness();
		const doc = structuredClone(h.doc);
		if (brief !== undefined) (Object.values(doc.sequences)[0] as { brief?: unknown }).brief = brief;
		if (notes !== undefined) (doc as { agentNotes?: unknown }).agentNotes = notes;
		return doc;
	}
	const seqBrief = (d: ProjectDocument) => (Object.values(d.sequences)[0] as { brief?: unknown }).brief;

	it('INV-BRIEF reports an unreadable brief; the repair keeps the readable parts, idempotently', () => {
		const value = { text: 'Keep', platform: 'myspace', targetDurationSec: 30, aspect: '4:3', extra: 1 };
		const doc = damaged(value);
		expect(checkInvariants(doc).map((i) => i.invariant)).toContain('INV-BRIEF');
		expect(readSequenceBrief({ brief: value })).toEqual({ text: 'Keep', targetDurationSec: 30 });
		const ids = createCounterIdSource(900);
		const a = repairDocument(doc, ids);
		expect(a.report.map((x) => x.action)).toContain('repair-brief');
		expect(seqBrief(a.document)).toEqual({ text: 'Keep', targetDurationSec: 30 });
		expect(checkInvariants(a.document)).toEqual([]);
		expect(repairDocument(a.document, ids).report).toEqual([]);
		for (const v of [42, 'x', null, [], { text: 7 }]) {
			const r = repairDocument(damaged(v), createCounterIdSource(1));
			expect(seqBrief(r.document)).toBeUndefined();
			expect(r.report.map((x) => x.action)).toContain('repair-brief');
		}
		expect(repairSequenceBrief({ text: '😀'.repeat(5_000) })!.text.length).toBe(8_000);
		const blank = repairAgentNotes(
			{
				entries: [
					{ id: 'agn_0000000000000001', at: '2026-10-31T10:00:00.000Z', text: `${' '.repeat(4_000)}x` },
				],
			},
			() => 'agn_0000000000000002',
		);
		expect(blank).toBeNull();
	});

	it('INV-AGENT-NOTES reports unreadable notes; the repair keeps readable entries and re-ids duplicates', () => {
		const good = { id: 'agn_0000000000000001', at: '2026-10-31T10:00:00.000Z', author: 'a', text: 'one' };
		const notes = {
			entries: [
				good,
				{ ...good, text: 'dup id' },
				{ ...good, id: 'bad', text: 'bad id', extra: true },
				{ ...good, id: 'agn_0000000000000002', author: '', text: 'no author' },
				{ ...good, id: 'agn_0000000000000003', at: 'yesterday' },
				{ ...good, id: 'agn_0000000000000004', text: '' },
				{ ...good, id: 'agn_0000000000000005', text: 'y'.repeat(5_000) },
				7,
			],
			junk: 1,
		};
		const doc = damaged(undefined, notes);
		expect(checkInvariants(doc).map((i) => i.invariant)).toContain('INV-AGENT-NOTES');
		const ids = createCounterIdSource(700);
		const a = repairDocument(doc, ids);
		expect(a.report.map((x) => x.action)).toContain('repair-agent-notes');
		const kept = readAgentNotes(a.document);
		expect(kept.map((n) => n.text.slice(0, 10))).toEqual([
			'one',
			'dup id',
			'bad id',
			'no author',
			'y'.repeat(10),
		]);
		expect(new Set(kept.map((n) => n.id)).size).toBe(5);
		expect(kept[3]!.author).toBe('agent');
		expect(kept[4]!.text).toHaveLength(4_000);
		expect(checkInvariants(a.document)).toEqual([]);
		expect(repairDocument(a.document, ids).report).toEqual([]);
		for (const v of [42, null, { entries: 'no' }, { entries: [{}] }]) {
			const r = repairDocument(damaged(undefined, v), createCounterIdSource(1));
			expect(r.document.agentNotes).toBeUndefined();
			expect(r.report.map((x) => x.action)).toContain('repair-agent-notes');
		}
		const many = {
			entries: Array.from({ length: 520 }, (_, i) => ({ ...good, id: undefined, text: `n${i}` })),
		};
		const capped = repairAgentNotes(
			many,
			(() => {
				const src = createCounterIdSource(1);
				return () => src.next('agn');
			})(),
		)!;
		expect(capped.entries).toHaveLength(500);
		expect(capped.entries[0]!.text).toBe('n20');
		expect(agentNotesIssue(capped)).toBeNull();
	});

	it('loads a damaged file through the repair (reported) and keeps a readable one as saved', () => {
		const load = (doc: ProjectDocument) =>
			loadProject(
				JSON.parse(
					JSON.stringify(
						makeEnvelope(
							{ ...doc, schemaVersion: CURRENT_SCHEMA_VERSION },
							{ revision: 1, savedAt: '2026-10-31T10:00:00.000Z', platform: 'test' },
						),
					),
				),
			);
		const bad = load(damaged({ text: 'Hi', platform: 3 }, { entries: [{ text: 'no time' }] }));
		expect(bad.issues).toEqual([]);
		expect(bad.repairs.map((x) => x.action).sort()).toEqual(['repair-agent-notes', 'repair-brief']);
		expect(readSequenceBrief(Object.values(bad.document.sequences)[0]!)).toEqual({ text: 'Hi' });
		const brief = { text: 'Good', platform: 'youtube-shorts', targetDurationSec: 59.5, aspect: '9:16' };
		const notes = {
			entries: [{ id: 'agn_0000000000000009', at: '2026-10-31T10:00:00.000Z', author: 'codex', text: 'n' }],
		};
		const ok = load(damaged(brief, notes));
		expect(ok.repairs).toEqual([]);
		expect(seqBrief(ok.document)).toEqual(brief);
		expect(ok.document.agentNotes).toEqual(notes);
	});

	it('property: the repairs never throw, their output is readable and idempotent', () => {
		fc.assert(
			fc.property(fc.anything({ maxDepth: 3 }), (v) => {
				const b = repairSequenceBrief(v);
				if (b !== null) {
					expect(sequenceBriefIssue(b)).toBeNull();
					expect(repairSequenceBrief(b)).toEqual(b);
				}
				expect(() => readSequenceBrief({ brief: v })).not.toThrow();
				const src = createCounterIdSource(1);
				const n = repairAgentNotes(v, () => src.next('agn'));
				if (n !== null) {
					expect(agentNotesIssue(n)).toBeNull();
					expect(repairAgentNotes(n, () => src.next('agn'))).toEqual(n);
				}
				expect(() => readAgentNotes({ agentNotes: v })).not.toThrow();
			}),
			{ numRuns: 300, seed: 1811 },
		);
		fc.assert(
			fc.property(
				fc.record({
					text: fc.oneof(fc.string({ maxLength: 9_000 }), fc.integer()),
					platform: fc.oneof(
						fc.constantFrom(...DELIVERY_TARGETS.map((t) => t.id)),
						fc.string(),
						fc.constant(null),
					),
					targetDurationSec: fc.oneof(fc.double(), fc.constant(null)),
					aspect: fc.oneof(fc.constantFrom(...DELIVERY_ASPECTS), fc.string()),
				}),
				(v) => {
					const b = repairSequenceBrief(v);
					if (b) expect(sequenceBriefIssue(b)).toBeNull();
				},
			),
			{ numRuns: 300, seed: 1812 },
		);
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						id: fc.oneof(fc.constant('agn_0000000000000001'), fc.string()),
						at: fc.oneof(fc.constant('2026-10-31T10:00:00.000Z'), fc.string()),
						author: fc.string({ maxLength: 80 }),
						text: fc.string({ maxLength: 50 }),
					}),
					{ maxLength: 20 },
				),
				(entries) => {
					const src = createCounterIdSource(1);
					const n = repairAgentNotes({ entries }, () => src.next('agn'));
					if (n) expect(agentNotesIssue(n)).toBeNull();
				},
			),
			{ numRuns: 300, seed: 1813 },
		);
	});

	it('cutText never splits a surrogate pair', () => {
		expect(cutText('a😀b', 2)).toBe('a');
		expect(cutText('a😀b', 3)).toBe('a😀');
		expect(cutText('abc', 5)).toBe('abc');
	});
});
