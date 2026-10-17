// Takes in the project model (spec 12 P6-E9) and the materials index field (P6-E10): take ids, the provenance's
// `take`, take ids wherever commands take a sound id, `pickVariant` rotating over a recording's takes, `materialsOf`.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	COMMAND_CATALOG,
	checkInvariants,
	LibraryProvenanceSchema,
	loadProject,
	materialsOf,
	parseTakeId,
	pickVariant,
	readLibraryProvenance,
	recordingIdOf,
	repairDocument,
	SOUND_MATERIALS,
	SOUND_REF_RE,
	takeIdOf,
} from '../src/index.ts';
import { Harness } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const REC = 'snd_0123456789abcdef';
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('take ids', () => {
	it('snd_<16 hex>~t<n> with n 1…64; parse, build and the recording of an id', () => {
		for (const n of [1, 9, 10, 42, 59, 60, 64]) {
			const id = takeIdOf(REC, n);
			expect(SOUND_REF_RE.test(id), id).toBe(true);
			expect(parseTakeId(id)).toEqual({ parentId: REC, index: n });
			expect(recordingIdOf(id)).toBe(REC);
		}
		expect(SOUND_REF_RE.test(REC)).toBe(true);
		expect(parseTakeId(REC)).toBeNull();
		expect(recordingIdOf(REC)).toBe(REC);
		for (const bad of [
			`${REC}~t0`,
			`${REC}~t65`,
			`${REC}~t01`,
			`${REC}~t`,
			`${REC}~x3`,
			`${REC}~t3~t4`,
			'snd_0123~t3',
			'',
			7,
			null,
		]) {
			if (typeof bad === 'string') expect(SOUND_REF_RE.test(bad), bad).toBe(false);
			expect(parseTakeId(bad)).toBeNull();
		}
	});
});

describe('LibraryProvenance.take', () => {
	const TAKE_LIB = {
		...LIB,
		soundId: takeIdOf(REC, 3),
		title: 'Keyboard typing (take 3)',
		types: ['key'],
		take: { soundId: REC, index: 3, sourceStartSec: 1.2345, sourceEndSec: 1.4567 },
	};

	it('is accepted by media.setLibraryInfo, undone and redone, and round-trips through save and load', () => {
		const h = new Harness();
		const m = h.registerVideo({ kind: 'audio', seconds: 1 });
		const before = h.doc;
		h.ok([{ type: 'media.setLibraryInfo', mediaId: m, library: TAKE_LIB }]);
		expect(h.doc.media[m]!.library).toEqual(TAKE_LIB);
		expect(before.media[m]!.library).toBeUndefined();
		const after = h.doc;
		h.doc = before;
		h.ok([{ type: 'media.setLibraryInfo', mediaId: m, library: TAKE_LIB }]);
		expect(h.doc).toEqual(after);
		expect(checkInvariants(h.doc)).toEqual([]);
		const loaded = loadProject(clone(h.doc));
		expect(loaded.repairs).toEqual([]);
		expect(loaded.document.media[m]!.library).toEqual(TAKE_LIB);
	});

	it('refuses a take that ends before it starts, a bad index or a take id as the recording', () => {
		const h = new Harness();
		const m = h.registerVideo({ kind: 'audio', seconds: 1 });
		for (const take of [
			{ ...TAKE_LIB.take, sourceEndSec: 1 },
			{ ...TAKE_LIB.take, index: 0 },
			{ ...TAKE_LIB.take, index: 65 },
			{ ...TAKE_LIB.take, soundId: takeIdOf(REC, 2) },
		]) {
			expect(LibraryProvenanceSchema.safeParse({ ...TAKE_LIB, take }).success).toBe(false);
			expect(h.tx([{ type: 'media.setLibraryInfo', mediaId: m, library: { ...TAKE_LIB, take } }]).ok).toBe(
				false,
			);
		}
		expect(h.doc.media[m]!.library).toBeUndefined();
	});

	it('repair drops an unreadable take and keeps the rest of the provenance', () => {
		const h = new Harness();
		const m = h.registerVideo({ kind: 'audio', seconds: 1 });
		const doc = clone(h.doc);
		(doc.media[m] as Record<string, unknown>).library = { ...TAKE_LIB, take: { soundId: 5 } };
		expect(checkInvariants(doc).some((i) => i.invariant === 'INV-LIBRARY')).toBe(true);
		const { document } = repairDocument(doc, h.ids);
		const { take: _t, ...rest } = TAKE_LIB;
		expect(document.media[m]!.library).toEqual(rest);
		expect(checkInvariants(document)).toEqual([]);
		expect(readLibraryProvenance(TAKE_LIB)).toEqual(TAKE_LIB);
	});
});

describe('commands take take ids wherever a sound id goes', () => {
	it('soundDesign.setPalette with takes: applied, undone; a bad take id is refused', () => {
		const schema = COMMAND_CATALOG['soundDesign.setPalette'].schema;
		const ok = { type: 'soundDesign.setPalette', soundIds: [takeIdOf(REC, 1), REC] };
		expect(schema.safeParse(ok).success).toBe(true);
		expect(schema.safeParse({ ...ok, soundIds: [`${REC}~t0`] }).success).toBe(false);
		const h = new Harness();
		const before = h.doc;
		h.ok([ok]);
		expect(h.seq.soundDesign?.settings?.palette).toEqual([takeIdOf(REC, 1), REC]);
		expect(Object.values(before.sequences)[0]!.soundDesign?.settings?.palette ?? []).toEqual([]);
		expect(h.tx([{ ...ok, soundIds: [`${REC}~t99`] }]).ok).toBe(false);
	});
});

describe('pickVariant over takes (vary the take, not the pitch)', () => {
	const takes = (n: number, rec = REC) => Array.from({ length: n }, (_, i) => takeIdOf(rec, i + 1));

	it('cycles through the takes of the best recording, never the same take twice in a row', () => {
		const candidates = [...takes(8), 'snd_aaaaaaaaaaaaaaaa', 'snd_bbbbbbbbbbbbbbbb'];
		const picks: string[] = [];
		for (let cue = 0; cue < 40; cue++) {
			const recent = [...picks].reverse().slice(0, 16);
			const v = pickVariant(candidates, { seed: 1, cueId: `cue_${cue}`, recentSoundIds: recent })!;
			picks.push(v.soundId);
		}
		for (const p of picks) expect(parseTakeId(p)?.parentId).toBe(REC);
		for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1]);
		// all eight takes before any repeats
		expect(new Set(picks.slice(0, 8)).size).toBe(8);
	});

	it('uses the ordinary top-N rotation when the best candidate is no take or its recording has one take here', () => {
		expect(
			pickVariant(['snd_aaaaaaaaaaaaaaaa', ...takes(3)], { seed: 1, cueId: 'c', recentSoundIds: [] })!
				.soundId,
		).toBe('snd_aaaaaaaaaaaaaaaa');
		const single = [takeIdOf(REC, 2), 'snd_aaaaaaaaaaaaaaaa'];
		expect(pickVariant(single, { seed: 1, cueId: 'c', recentSoundIds: [takeIdOf(REC, 2)] })!.soundId).toBe(
			'snd_aaaaaaaaaaaaaaaa',
		);
	});

	it('property: the pick is a take of the best recording and never the last one used', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 2, max: 64 }),
				fc.array(fc.integer({ min: 1, max: 64 }), { maxLength: 20 }),
				fc.integer(),
				(n, recentIdx, seed) => {
					const pool = [...takes(n), ...takes(4, 'snd_cccccccccccccccc')];
					const recent = recentIdx.map((i) => takeIdOf(REC, Math.min(n, i)));
					const v = pickVariant(pool, { seed, cueId: 'c', recentSoundIds: recent })!;
					expect(parseTakeId(v.soundId)?.parentId).toBe(REC);
					if (recent.length) expect(v.soundId).not.toBe(recent[0]);
					expect(v.repeated).toBe(false);
				},
			),
			{ numRuns: 300 },
		);
	});
});

describe('materialsOf (P6-E10 index field)', () => {
	it('reads materials from titles, tags and paths, in the fixed order, each once', () => {
		expect(materialsOf(['Heavy aluminium pan rim hit (bright)'])).toEqual(['metal']);
		expect(materialsOf(['Table glasses clinking', 'kitchen', 'foley/glass/1324.flac'])).toEqual(['glass']);
		expect(materialsOf(['Paperback page turn 1'])).toEqual(['paper']);
		expect(materialsOf(['Nylon flag shake', 'Trouser zip'])).toEqual(['cloth']);
		expect(materialsOf(['Wooden door knock on a metal plate'])).toEqual(['wood', 'metal']);
		expect(materialsOf(['Sci-Fi laser blip'])).toEqual(['electronic']);
		expect(materialsOf(['Balloon inflation', 'riser'])).toEqual(['rubber']);
		expect(materialsOf(['Stream in the forest', 'water'])).toEqual(['water']);
		expect(materialsOf(['Wind in a tree'])).toEqual(['air']);
		expect(materialsOf(['Ceramic mug set down'])).toEqual(['ceramic']);
		expect(materialsOf(['Concrete footstep'])).toEqual(['stone']);
		expect(materialsOf(['Plastic button'])).toEqual(['plastic']);
	});

	it('ambiguous words name no material', () => {
		expect(materialsOf(['Door slam', 'Key press', 'Pan left whoosh', 'Plate', 'Drum stick'])).toEqual([]);
		expect(materialsOf([])).toEqual([]);
		expect(materialsOf([5, null, undefined, {}] as never)).toEqual([]);
		expect(materialsOf('wood' as never)).toEqual([]);
	});

	it('property: any texts give a sorted, duplicate-free subset of the twelve materials', () => {
		fc.assert(
			fc.property(
				fc.array(fc.oneof(fc.string(), fc.constantFrom('wood', 'GLASS', 'sci fi', 'Água')), {
					maxLength: 20,
				}),
				(texts) => {
					const m = materialsOf(texts);
					expect(new Set(m).size).toBe(m.length);
					const order = m.map((x) => SOUND_MATERIALS.indexOf(x));
					expect(order.every((o) => o >= 0)).toBe(true);
					expect([...order].sort((a, b) => a - b)).toEqual(order);
					expect(materialsOf(texts)).toEqual(m);
				},
			),
			{ numRuns: 300 },
		);
	});
});
