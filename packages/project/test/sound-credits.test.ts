import { describe, expect, it } from 'vitest';
import { creditLine, type LibraryProvenance, type ProjectDocument, soundCredits } from '../src/index.ts';
import { Harness } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const lib = (over: Partial<LibraryProvenance>): LibraryProvenance => ({ ...LIB, ...over });

function project() {
	const h = new Harness();
	const add = (library: LibraryProvenance | null, seconds = 1) => {
		const m = h.registerVideo({ kind: 'audio', seconds });
		if (library) h.ok([{ type: 'media.setLibraryInfo', mediaId: m, library }]);
		return m;
	};
	const cc0 = add(lib({ soundId: 'snd_cc0', title: 'Zap Short' }));
	const by = add(
		lib({
			soundId: 'snd_by',
			title: 'Whoosh, "Big"',
			license: 'CC-BY-4.0',
			licenseUrl: undefined,
			author: 'Jane | Doe',
			attribution: null,
		}),
	);
	const nc = add(lib({ soundId: 'snd_nc', title: 'Boom NC', license: 'CC-BY-NC-4.0', author: 'X' }));
	const user = add(lib({ soundId: 'snd_user', title: '=cmd()', license: 'LicenseRef-UserProvided', author: '' }));
	const unused = add(lib({ soundId: 'snd_unused', title: 'Unused' }));
	const plain = add(null);
	const place = (m: string, at: number, track = 'A1') => {
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at, tracks: { audio: track } }]);
		return Object.values(h.seq.clips).find((c) => (c as { mediaId?: string }).mediaId === m && c.start === at)!.id;
	};
	const cCc0 = place(cc0, 0);
	const cBy = place(by, 40);
	const cPlain = place(plain, 80);
	const cNc = place(nc, 0, 'A2');
	const cUser = place(user, 40, 'A2');
	return { h, cc0, by, nc, user, unused, plain, cCc0, cBy, cPlain, cNc, cUser };
}

describe('soundCredits (spec 12 §2.1, P1-R8)', () => {
	it('lists the library sounds a sequence uses, sorted by title, with licence URLs and attribution flags', () => {
		const p = project();
		const c = soundCredits(p.h.doc, p.h.seqId);
		expect(c.rows.map((r) => r.soundId)).toEqual(['snd_user', 'snd_nc', 'snd_by', 'snd_cc0']);
		const by = c.rows.find((r) => r.soundId === 'snd_by')!;
		expect(by).toMatchObject({
			mediaId: p.by,
			license: 'CC-BY-4.0',
			licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
			requiresAttribution: true,
			usedIn: [p.cBy],
			sequenceIds: [p.h.seqId],
		});
		expect(c.rows.find((r) => r.soundId === 'snd_cc0')!.requiresAttribution).toBe(false);
		expect(c.rows.some((r) => r.mediaId === p.unused || r.mediaId === p.plain)).toBe(false);
		expect(soundCredits(p.h.doc, undefined, { includeUnused: true }).rows.map((r) => r.soundId)).toContain(
			'snd_unused',
		);
	});

	it('warns about non-commercial, undeclared and unknown licences', () => {
		const p = project();
		const c = soundCredits(p.h.doc, p.h.seqId);
		expect(c.warnings.map((w) => [w.code, w.mediaId])).toEqual([
			['W_USER_PROVIDED', p.user],
			['W_LICENSE_NC', p.nc],
		]);
		const h2 = new Harness();
		const m = h2.registerVideo({ kind: 'audio' });
		h2.ok([
			{
				type: 'media.setLibraryInfo',
				mediaId: m,
				library: lib({ license: 'NOASSERTION', author: '', attribution: null }),
			},
			{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } },
		]);
		expect(soundCredits(h2.doc).warnings.map((w) => w.code)).toEqual(['W_LICENSE_UNKNOWN']);
		h2.ok([{ type: 'media.setLibraryInfo', mediaId: m, library: lib({ license: 'CC-BY-3.0', author: '' }) }]);
		expect(soundCredits(h2.doc).warnings.map((w) => w.code)).toEqual(['W_CREDIT_INCOMPLETE']);
		expect(soundCredits(h2.doc, 'seq_missing').warnings.map((w) => w.code)).toEqual(['W_SEQUENCE_NOT_FOUND']);
	});

	it('walks nested sequences (sounds inside a nest are credited to the outer sequence)', () => {
		const p = project();
		const outerId = p.h.seqId;
		const r = p.h.ok([{ type: 'clip.nest', clipIds: [p.cBy, p.cNc], name: 'Inner' }]);
		const inner = p.h.doc.sequences[(r.results[0] as { sequenceId: string }).sequenceId]!;
		expect(p.h.seqId).toBe(outerId);
		const innerBy = Object.values(inner.clips).find((c) => (c as { mediaId?: string }).mediaId === p.by)!;
		const outer = soundCredits(p.h.doc, p.h.seqId);
		const by = outer.rows.find((x) => x.soundId === 'snd_by')!;
		expect(by.usedIn).toEqual([innerBy.id]);
		expect(by.sequenceIds).toEqual([inner.id]);
		expect(outer.rows.map((x) => x.soundId).sort()).toEqual(['snd_by', 'snd_cc0', 'snd_nc', 'snd_user']);
		// the nested sequence alone credits only what it holds
		expect(soundCredits(p.h.doc, inner.id).rows.map((x) => x.soundId).sort()).toEqual(['snd_by', 'snd_nc']);
	});

	it('survives a nesting cycle in a damaged document', () => {
		const p = project();
		const r = p.h.ok([{ type: 'clip.nest', clipIds: [p.cBy], name: 'Inner' }]);
		const doc = JSON.parse(JSON.stringify(p.h.doc)) as ProjectDocument;
		const inner = doc.sequences[(r.results[0] as { sequenceId: string }).sequenceId]!;
		const outerNest = Object.values(doc.sequences[p.h.seqId]!.clips).find((c) => c.kind === 'nest-audio')!;
		// make Inner nest the outer sequence too
		inner.clips.clp_cycle = { ...outerNest, id: 'clp_cycle', sequenceId: p.h.seqId } as never;
		expect(soundCredits(doc, p.h.seqId).rows.length).toBe(4);
	});

	it('credits the library original of a processed version', () => {
		const p = project();
		const doc = JSON.parse(JSON.stringify(p.h.doc)) as ProjectDocument;
		const derived = { ...doc.media[p.plain]!, id: 'med_derived00000001' } as Record<string, unknown>;
		derived.derivation = {
			fromMediaId: p.by,
			recipe: { op: 'loudness-normalize', targetLufs: -16, truePeakDb: -1 },
			recipeVersion: 1,
			recipeHash: 'h',
		};
		doc.media.med_derived00000001 = derived as never;
		(doc.sequences[p.h.seqId]!.clips[p.cPlain] as { mediaId: string }).mediaId = 'med_derived00000001';
		const by = soundCredits(doc, p.h.seqId).rows.find((r) => r.soundId === 'snd_by')!;
		expect(by.mediaId).toBe(p.by);
		expect(by.usedIn.sort()).toEqual([p.cBy, p.cPlain].sort());
	});

	it('formats text, Markdown and CSV safely (quotes, pipes, formulas)', () => {
		const p = project();
		const c = soundCredits(p.h.doc, p.h.seqId);
		const by = c.rows.find((r) => r.soundId === 'snd_by')!;
		expect(creditLine(by)).toBe(
			'"Whoosh, "Big"" by Jane | Doe, CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/). Source: https://kenney.nl/assets/impact-sounds',
		);
		expect(creditLine({ ...by, attribution: '  "Whoosh" by Jane Doe\n(CC BY 4.0)  ' })).toBe(
			'"Whoosh" by Jane Doe (CC BY 4.0)',
		);
		expect(c.text.split('\n')[0]).toBe('Sound credits');
		expect(c.text.split('\n')).toHaveLength(2 + c.rows.length);
		expect(c.markdown).toContain('| Whoosh, "Big" | Jane \\| Doe | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |');
		const lines = c.csv.trimEnd().split('\r\n');
		expect(lines[0]).toBe(
			'mediaId,soundId,title,author,license,licenseUrl,sourceUrl,attribution,requiresAttribution,usedIn',
		);
		expect(lines).toHaveLength(1 + c.rows.length);
		expect(c.csv).toContain('"Whoosh, ""Big"""');
		expect(c.csv).toContain(",'=cmd(),");
		const empty = soundCredits(new Harness().doc);
		expect(empty).toMatchObject({ rows: [], text: '', markdown: '', warnings: [] });
		expect(empty.csv.split('\r\n')[0]).toContain('mediaId');
	});
});
