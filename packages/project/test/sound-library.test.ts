import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	COMMAND_CATALOG,
	checkInvariants,
	createCounterIdSource,
	LibraryProvenanceSchema,
	loadProject,
	MediaAssetSchema,
	type ProjectDocument,
	readLibraryProvenance,
	repairDocument,
	unknownCommandKeyIssues,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const audio = (h: Harness, seconds = 1) => h.registerVideo({ kind: 'audio', seconds });

describe('media.setLibraryInfo (spec 12 §2.9)', () => {
	it('is registered with owner sound-design and a History label', () => {
		const e = COMMAND_CATALOG['media.setLibraryInfo'];
		expect(e.owner).toBe('sound-design');
		expect(e.label).toBe('Set Sound Library Info');
	});

	it('sets and removes provenance; undo restores the previous document and redo reapplies it', () => {
		const h = new Harness();
		const m = audio(h);
		const before = h.doc;
		const snapshot = clone(before);
		const r = h.ok([{ type: 'media.setLibraryInfo', mediaId: m, library: LIB }], { label: 'Sound' });
		expect(r.changed).toContain(m);
		expect(h.doc.media[m]!.library).toEqual(LIB);
		expect(r.results[0]).toEqual({ mediaId: m, library: LIB });
		const after = h.doc;
		// undo = the document before the transaction, untouched (snapshot History, packages/session)
		expect(before).toEqual(snapshot);
		expect(before.media[m]!.library).toBeUndefined();
		// redo = the same transaction on the same document gives the same result
		h.doc = before;
		h.ok([{ type: 'media.setLibraryInfo', mediaId: m, library: LIB }]);
		expect(h.doc).toEqual(after);
		// null removes it, undoably
		const withLib = h.doc;
		h.ok([{ type: 'media.setLibraryInfo', mediaId: m, library: null }]);
		expect(h.doc.media[m]!.library).toBeUndefined();
		expect('library' in h.doc.media[m]!).toBe(false);
		expect(withLib.media[m]!.library).toEqual(LIB);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('keeps unknown fields of newer builds (looseObject) and future type ids', () => {
		const h = new Harness();
		const m = audio(h);
		const lib = { ...LIB, types: ['hit', 'future-type'], extra: { a: 1 } };
		h.ok([{ type: 'media.setLibraryInfo', mediaId: m, library: lib }]);
		expect(h.doc.media[m]!.library).toEqual(lib);
	});

	it('refuses a missing media (E_NOT_FOUND), non-audio media and impossible descriptors (E_INVALID_PARAM)', () => {
		const h = new Harness();
		const m = audio(h);
		const still = h.registerVideo({ kind: 'image' });
		const missing = h.tx([{ type: 'media.setLibraryInfo', mediaId: 'med_0000000000000000', library: LIB }]);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.errors[0]!.code).toBe('E_NOT_FOUND');
		const kind = h.tx([{ type: 'media.setLibraryInfo', mediaId: still, library: LIB }]);
		expect(kind.ok).toBe(false);
		if (!kind.ok) expect(kind.errors[0]!.code).toBe('E_INVALID_PARAM');
		const late = h.tx([
			{
				type: 'media.setLibraryInfo',
				mediaId: m,
				library: { ...LIB, descriptors: { ...LIB.descriptors!, peakSec: 2 } },
			},
		]);
		expect(late.ok).toBe(false);
		if (!late.ok) expect(late.errors[0]!.code).toBe('E_INVALID_PARAM');
		expect(h.doc.media[m]!.library).toBeUndefined();
	});

	it('refuses malformed provenance at the schema (E_SCHEMA): no sound id, NaN, wrong band count, huge strings', () => {
		const h = new Harness();
		const m = audio(h);
		const bad: unknown[] = [
			{ ...LIB, soundId: '' },
			{ ...LIB, license: '' },
			{ ...LIB, types: ['Not A Type'] },
			{ ...LIB, source: { type: 'pack' } },
			{ ...LIB, descriptors: { ...LIB.descriptors, peakSec: Number.NaN } },
			{ ...LIB, descriptors: { ...LIB.descriptors, octaveBandsDb: [1, 2, 3] } },
			{ ...LIB, title: 'x'.repeat(501) },
			{ ...LIB, attribution: 5 },
			'snd_x',
		];
		for (const library of bad) {
			const r = h.tx([{ type: 'media.setLibraryInfo', mediaId: m, library }]);
			expect(r.ok, JSON.stringify(library).slice(0, 80)).toBe(false);
			if (!r.ok) expect(r.errors[0]!.code).toBe('E_SCHEMA');
		}
	});

	it('media.register carries provenance, and a re-register of the same file adds it to the existing media', () => {
		const h = new Harness();
		const asset = videoAsset({ kind: 'audio', seconds: 1 });
		const r = h.ok([{ type: 'media.register', asset: { ...asset, library: LIB } }]);
		const id = (r.results[0] as { mediaId: string }).mediaId;
		expect(h.doc.media[id]!.library).toEqual(LIB);
		const bad = h.tx([
			{ type: 'media.register', asset: { ...videoAsset({ kind: 'audio' }), library: { a: 1 } } },
		]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors[0]!.code).toBe('E_SCHEMA');

		const plain = videoAsset({ kind: 'audio', seconds: 2 });
		const first = h.ok([{ type: 'media.register', asset: plain }]);
		const pid = (first.results[0] as { mediaId: string }).mediaId;
		const again = h.ok([{ type: 'media.register', asset: { ...plain, library: LIB } }]);
		expect(again.results[0]).toMatchObject({ mediaId: pid, deduped: true });
		expect(h.doc.media[pid]!.library).toEqual(LIB);
		// existing provenance is never overwritten by a re-register
		h.ok([{ type: 'media.register', asset: { ...plain, library: { ...LIB, title: 'Other' } } }]);
		expect(h.doc.media[pid]!.library!.title).toBe(LIB.title);
	});

	it('accepts the provenance the engine returns from register (starter/pack `file`) on the strict agent path', () => {
		// Regression (WP1.2b): the engine's register route names the kit or pack file in `source`; agent
		// transactions refuse keys a schema does not list, so committing it failed with E_SCHEMA.
		const kit = {
			...LIB,
			source: { type: 'starter', packId: 'kenney-impact-sounds', file: 'hit-metal-01.ogg' },
		};
		const pack = { ...LIB, source: { type: 'pack', packId: 'some-pack', file: 'impacts/a.ogg' } };
		for (const library of [kit, pack]) {
			const cmd = { type: 'media.register', asset: { ...videoAsset({ kind: 'audio' }), library } };
			expect(unknownCommandKeyIssues([cmd])).toEqual([]);
			const h = new Harness();
			const r = h.ok([cmd]);
			const id = (r.results[0] as { mediaId: string }).mediaId;
			expect(h.doc.media[id]!.library!.source).toEqual(library.source);
		}
		// still closed for anything else, and the file is bounded
		const typo = { ...LIB, source: { type: 'starter', fiel: 'a.ogg' } };
		expect(
			unknownCommandKeyIssues([
				{ type: 'media.register', asset: { ...videoAsset({ kind: 'audio' }), library: typo } },
			]),
		).toHaveLength(1);
		expect(
			LibraryProvenanceSchema.safeParse({ ...LIB, source: { type: 'pack', packId: 'p', file: '' } }).success,
		).toBe(false);
	});
});

describe('LibraryProvenance in the document (INV-LIBRARY, repair, load)', () => {
	function docWith(library: unknown): { doc: ProjectDocument; m: string; h: Harness } {
		const h = new Harness();
		const m = audio(h);
		const doc = clone(h.doc);
		(doc.media[m] as Record<string, unknown>).library = library;
		return { doc, m, h };
	}

	it('the document schema accepts anything there, so a load never fails on it', () => {
		for (const library of [5, 'x', null, [], { soundId: 3 }, LIB])
			expect(
				MediaAssetSchema.safeParse({ ...videoAsset({ kind: 'audio' }), id: 'med_x', library }).success,
			).toBe(true);
	});

	it('flags unreadable provenance (INV-LIBRARY) and repairs it field by field with a report', () => {
		const { doc, m, h } = docWith({
			...LIB,
			title: 42,
			license: '',
			types: ['hit', 'Bad Type', 7],
			source: { type: 'pack' },
			descriptors: { peakSec: -1 },
			sourceUrl: null,
			newerField: true,
		});
		expect(checkInvariants(doc).some((i) => i.invariant === 'INV-LIBRARY')).toBe(true);
		const { document, report } = repairDocument(doc, h.ids);
		expect(report).toContainEqual(expect.objectContaining({ action: 'repair-library', entity: m }));
		const lib = document.media[m]!.library!;
		expect(lib).toEqual({
			soundId: LIB.soundId,
			title: LIB.soundId,
			types: ['hit'],
			license: 'NOASSERTION',
			licenseUrl: LIB.licenseUrl,
			author: LIB.author,
			attribution: null,
			snapshotHash: LIB.snapshotHash,
			newerField: true,
		});
		expect(checkInvariants(document)).toEqual([]);
		// idempotent
		const again = repairDocument(document, h.ids);
		expect(again.report.filter((r) => r.action.includes('library'))).toEqual([]);
	});

	it('drops provenance without a sound id, with a report line', () => {
		for (const bad of [
			5,
			'snd',
			[],
			{ title: 'no id' },
			{ ...LIB, soundId: '' },
			{ ...LIB, soundId: 'x'.repeat(129) },
		]) {
			const { doc, m, h } = docWith(bad);
			const { document, report } = repairDocument(doc, h.ids);
			expect(document.media[m]!.library).toBeUndefined();
			expect(report).toContainEqual(expect.objectContaining({ action: 'drop-library', entity: m }));
			expect(checkInvariants(document)).toEqual([]);
		}
	});

	it('round-trips through save and load unchanged; a damaged file loads repaired', () => {
		const h = new Harness();
		const m = audio(h);
		h.ok([{ type: 'media.setLibraryInfo', mediaId: m, library: LIB }]);
		const loaded = loadProject(JSON.parse(JSON.stringify(h.doc)));
		expect(loaded.repairs).toEqual([]);
		expect(loaded.issues).toEqual([]);
		expect(loaded.document.media[m]!.library).toEqual(LIB);

		const damaged = clone(h.doc);
		(damaged.media[m] as Record<string, unknown>).library = { ...LIB, descriptors: 'oops' };
		const l2 = loadProject(damaged, { ids: createCounterIdSource(900) });
		expect(l2.issues).toEqual([]);
		expect(l2.repairs.map((r) => r.action)).toContain('repair-library');
		const { descriptors: _drop, ...rest } = LIB;
		expect(l2.document.media[m]!.library).toEqual(rest);
	});

	it('property: any value stored there loads, passes the invariants after repair, and a valid one is kept', () => {
		const h = new Harness();
		const m = audio(h);
		const base = clone(h.doc);
		const libArb = fc.oneof(
			fc.anything({ maxDepth: 3 }),
			fc.record(
				{
					soundId: fc.oneof(fc.string({ maxLength: 20 }), fc.integer()),
					title: fc.oneof(fc.string(), fc.constant(undefined)),
					types: fc.oneof(
						fc.array(fc.oneof(fc.constantFrom('hit', 'whoosh', 'X', ''), fc.integer())),
						fc.string(),
					),
					source: fc.oneof(
						fc.record({ type: fc.constantFrom('starter', 'pack', 'folder', 'synth', 'odd') }),
						fc.anything({ maxDepth: 1 }),
					),
					license: fc.oneof(fc.constantFrom('CC0-1.0', 'CC-BY-4.0', ''), fc.integer()),
					author: fc.oneof(fc.string(), fc.constant(null)),
					attribution: fc.oneof(fc.string(), fc.constant(null), fc.integer()),
					descriptors: fc.anything({ maxDepth: 2 }),
				},
				{ requiredKeys: [] },
			),
		);
		fc.assert(
			fc.property(libArb, (library) => {
				const doc = clone(base);
				(doc.media[m] as Record<string, unknown>).library = library;
				const raw = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
				const loaded = loadProject(raw, { ids: createCounterIdSource(5000) });
				expect(loaded.issues).toEqual([]);
				const stored = (raw.media[m] as { library?: unknown }).library;
				const kept = loaded.document.media[m]!.library;
				if (stored !== undefined && LibraryProvenanceSchema.safeParse(stored).success)
					expect(kept).toEqual(stored);
				if (kept !== undefined) expect(LibraryProvenanceSchema.safeParse(kept).success).toBe(true);
				expect(readLibraryProvenance(library) === null || kept !== undefined).toBe(true);
			}),
			{ numRuns: 300, seed: 1015 },
		);
	});

	it('pasting media with damaged provenance from another project repairs it instead of failing', () => {
		const h = new Harness();
		const m = audio(h);
		const payload = {
			format: 'jasper-clipboard',
			version: 1,
			sourceProjectId: 'prj_00000000000000EX',
			sourceSequenceId: null,
			kind: 'project-items',
			media: [
				{
					...clone(h.doc.media[m]!),
					id: 'med_foreign000000001',
					fingerprint: 'q1:foreign',
					library: { ...LIB, license: 7 },
				},
			],
			synthetics: [],
			transcripts: [],
			fonts: [],
			mediaItems: {},
			items: {
				items: [
					{
						id: 'itm_foreign000000001',
						kind: 'media',
						name: 'boom',
						mediaId: 'med_foreign000000001',
						label: 'iris',
						marks: { in: null, out: null },
					},
				],
				sequences: [],
				rootItems: ['itm_foreign000000001'],
			},
		};
		const r = h.tx([{ type: 'project.pasteItems', payload, binId: null }]);
		expect(r.ok, JSON.stringify(r)).toBe(true);
		const pasted = Object.values(h.doc.media).find((x) => x.fingerprint === 'q1:foreign')!;
		expect(pasted.library).toMatchObject({ soundId: LIB.soundId, license: 'NOASSERTION' });
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});
