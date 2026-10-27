// Spec 17 SC-055: `Sequence.scriptFix` — `scriptFix.configure` (settings merged, rejections remembered / forgotten,
// refusals, undo, invariants), lenient reading, INV-SCRIPTFIX and the conservative load repair (malformed entries
// dropped, at most 10 000 fingerprints, readable settings kept); the field survives a save / load round trip.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	CURRENT_SCHEMA_VERSION,
	checkInvariants,
	createCounterIdSource,
	DEFAULT_SCRIPT_FIX_SETTINGS,
	loadProject,
	makeEnvelope,
	type ProjectDocument,
	readSequenceScriptFix,
	repairDocument,
	repairSequenceScriptFix,
	SCRIPT_FIX_MAX_REJECTED,
	scriptFixRejected,
	scriptFixSettingsOf,
	sequenceScriptFixIssue,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const code = (r: ReturnType<Harness['tx']>) => (r.ok ? 'ok' : r.errors[0]!.code);
const stateOf = (h: Harness) => (h.seq as { scriptFix?: unknown }).scriptFix;

describe('scriptFix.configure (SC-055)', () => {
	it('merges settings, remembers and forgets rejections, clears; undo leaves the previous document', () => {
		const h = new Harness();
		expect(scriptFixSettingsOf(h.seq)).toEqual(DEFAULT_SCRIPT_FIX_SETTINGS);
		const before = h.doc;
		const r = h.ok([
			{ type: 'scriptFix.configure', settings: { strictness: 'careful' }, reject: ['fp:a', 'fp:b'] },
		]);
		expect(r.results[0]).toEqual({
			settings: { strictness: 'careful', sources: ['script', 'glossary'], scope: 'recordings' },
			rejected: 2,
		});
		expect(stateOf(h)).toEqual({ settings: { strictness: 'careful' }, rejected: ['fp:a', 'fp:b'] });
		expect((before.sequences[h.seqId] as { scriptFix?: unknown }).scriptFix).toBeUndefined();
		h.ok([
			{ type: 'scriptFix.configure', settings: { scope: 'used', sources: ['script'] }, unreject: ['fp:a'] },
		]);
		expect(stateOf(h)).toEqual({
			settings: { strictness: 'careful', scope: 'used', sources: ['script'] },
			rejected: ['fp:b'],
		});
		expect([...scriptFixRejected(h.seq)]).toEqual(['fp:b']);
		h.ok([{ type: 'scriptFix.configure', settings: null, clearRejected: true }]);
		expect(stateOf(h)).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('refuses malformed settings and fingerprints (E_SCHEMA) and more than 10 000 rejections (E_LIMIT)', () => {
		const h = new Harness();
		expect(code(h.tx([{ type: 'scriptFix.configure', settings: { strictness: 'wild' } }]))).toBe('E_SCHEMA');
		expect(code(h.tx([{ type: 'scriptFix.configure', settings: { sources: [] } }]))).toBe('E_SCHEMA');
		expect(code(h.tx([{ type: 'scriptFix.configure', settings: { sources: ['script', 'script'] } }]))).toBe(
			'E_SCHEMA',
		);
		expect(code(h.tx([{ type: 'scriptFix.configure', settings: { colour: 'red' } }]))).toBe('E_SCHEMA');
		expect(code(h.tx([{ type: 'scriptFix.configure', reject: ['bad\u0001fp'] }]))).toBe('E_SCHEMA');
		const many = Array.from({ length: SCRIPT_FIX_MAX_REJECTED }, (_, i) => `fp:${i}`);
		h.ok([{ type: 'scriptFix.configure', reject: many }]);
		expect(code(h.tx([{ type: 'scriptFix.configure', reject: ['fp:one-more'] }]))).toBe('E_LIMIT');
		expect(code(h.tx([{ type: 'scriptFix.configure', sequenceId: 'seq_nope' }]))).toBe('E_NOT_FOUND');
		expect(readSequenceScriptFix(h.seq).rejected).toHaveLength(SCRIPT_FIX_MAX_REJECTED);
	});
});

describe('Sequence.scriptFix reading and repair (SC-055)', () => {
	function damaged(value: unknown): ProjectDocument {
		const h = new Harness();
		const doc = structuredClone(h.doc);
		(Object.values(doc.sequences)[0] as { scriptFix?: unknown }).scriptFix = value;
		return doc;
	}

	it('INV-SCRIPTFIX reports an unreadable value; the repair keeps the readable parts, idempotently', () => {
		const value = {
			rejected: ['ok:1', 42, '', 'ok:1', 'ok:2', 'bad\u0000x'],
			settings: { strictness: 'generous', sources: ['script', 'nope', 'script'], scope: 'everywhere', x: 1 },
			junk: true,
		};
		const doc = damaged(value);
		expect(checkInvariants(doc).map((i) => i.invariant)).toContain('INV-SCRIPTFIX');
		expect(readSequenceScriptFix({ scriptFix: value })).toEqual({
			rejected: ['ok:1', 'ok:2'],
			settings: { strictness: 'generous', sources: ['script'] },
		});
		const ids = createCounterIdSource(500);
		const a = repairDocument(doc, ids);
		expect(a.report.map((x) => x.action)).toContain('repair-script-fix');
		expect((Object.values(a.document.sequences)[0] as { scriptFix?: unknown }).scriptFix).toEqual({
			rejected: ['ok:1', 'ok:2'],
			settings: { strictness: 'generous', sources: ['script'] },
		});
		expect(checkInvariants(a.document)).toEqual([]);
		expect(repairDocument(a.document, ids).report).toEqual([]);
	});

	it('drops what is unreadable entirely, and caps the rejections at 10 000', () => {
		for (const v of [42, 'x', null, [], { rejected: 'no', settings: 3 }]) {
			const r = repairDocument(damaged(v), createCounterIdSource(1));
			expect((Object.values(r.document.sequences)[0] as { scriptFix?: unknown }).scriptFix).toBeUndefined();
			expect(r.report.map((x) => x.action)).toContain('repair-script-fix');
		}
		const huge = Array.from({ length: SCRIPT_FIX_MAX_REJECTED + 50 }, (_, i) => `fp:${i}`);
		const fixed = repairSequenceScriptFix({ rejected: huge })!;
		expect(fixed.rejected).toHaveLength(SCRIPT_FIX_MAX_REJECTED);
		expect(fixed.rejected![0]).toBe('fp:0');
		expect(sequenceScriptFixIssue(fixed)).toBeNull();
	});

	it('loads a damaged file through the repair (reported) and keeps a readable one as saved', () => {
		const load = (doc: ProjectDocument) =>
			loadProject(
				JSON.parse(
					JSON.stringify(
						makeEnvelope(
							{ ...doc, schemaVersion: CURRENT_SCHEMA_VERSION },
							{ revision: 1, savedAt: '2026-10-27T10:00:00.000Z', platform: 'test' },
						),
					),
				),
			);
		const bad = load(damaged({ rejected: [1, 'fp:x'] }));
		expect(bad.issues).toEqual([]);
		expect(bad.repairs.map((x) => x.action)).toContain('repair-script-fix');
		expect(readSequenceScriptFix(Object.values(bad.document.sequences)[0]!)).toEqual({ rejected: ['fp:x'] });
		const good = { settings: { strictness: 'careful' }, rejected: ['fp:y'] };
		const ok = load(damaged(good));
		expect(ok.repairs).toEqual([]);
		expect((Object.values(ok.document.sequences)[0] as { scriptFix?: unknown }).scriptFix).toEqual(good);
	});

	it('property: the repair never throws, its output is readable and idempotent', () => {
		fc.assert(
			fc.property(fc.anything({ maxDepth: 3 }), (v) => {
				const fixed = repairSequenceScriptFix(v);
				if (fixed === null) return;
				expect(sequenceScriptFixIssue(fixed)).toBeNull();
				expect(repairSequenceScriptFix(fixed)).toEqual(fixed);
			}),
			{ numRuns: 300, seed: 55 },
		);
		fc.assert(
			fc.property(
				fc.record({
					rejected: fc.array(fc.oneof(fc.string(), fc.integer()), { maxLength: 30 }),
					settings: fc.record({
						strictness: fc.string(),
						sources: fc.array(fc.string()),
						scope: fc.string(),
					}),
				}),
				(v) => {
					const fixed = repairSequenceScriptFix(v);
					if (fixed) expect(sequenceScriptFixIssue(fixed)).toBeNull();
				},
			),
			{ numRuns: 300, seed: 56 },
		);
	});
});
