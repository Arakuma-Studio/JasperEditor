// Spec 17 SC-070: the personal glossary's pure rules — text cleaning and caps, merge by target (idempotent save,
// "Remember" counting), edits, the lenient import parser (property: never throws, only valid entries, bounded) and
// the additive import merge.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	cleanGlossaryText,
	GLOSSARY_LIMITS,
	type GlossaryEntry,
	GlossaryEntrySchema,
	GlossaryError,
	GlossaryFileSchema,
	glossaryIdFrom,
	importGlossaryEntries,
	normalizeGlossaryInput,
	parseGlossaryImport,
	updateGlossaryEntry,
	upsertGlossaryEntry,
} from '../src/index.ts';

const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T11:00:00.000Z';

function ctx(now = NOW) {
	let n = 0;
	return {
		now,
		newId: () => {
			n++;
			return glossaryIdFrom(Array.from({ length: 16 }, (_, i) => (i >= 13 ? n >> (5 * (15 - i)) : 0)));
		},
	};
}

function refusal(fn: () => unknown): GlossaryError {
	try {
		fn();
	} catch (e) {
		if (e instanceof GlossaryError) return e;
		throw e;
	}
	throw new Error('expected a GlossaryError');
}

describe('glossary texts and entries', () => {
	it('cleans texts: NFC, control characters and line breaks as spaces, single spaces, trimmed', () => {
		expect(cleanGlossaryText('  Nova\u0000Play\n\n Studio\t ')).toBe('Nova Play Studio');
		expect(cleanGlossaryText('Pixelfórge'.normalize('NFD'))).toBe('Pixelfórge'.normalize('NFC'));
	});

	it('normalises input: dedupes spellings without case, drops the target, checks caps', () => {
		expect(
			normalizeGlossaryInput({ from: ['nova play', 'Nova Play', ' nova  play ', 'NovaPlay'], to: 'NovaPlay' }),
		).toEqual({ from: ['nova play'], to: 'NovaPlay' });
		expect(refusal(() => normalizeGlossaryInput({ from: [], to: '   ' })).code).toBe('GLOSSARY_INVALID');
		expect(refusal(() => normalizeGlossaryInput({ from: ['…'], to: 'Glimmerbox' })).code).toBe(
			'GLOSSARY_INVALID',
		);
		expect(refusal(() => normalizeGlossaryInput({ from: [], to: 'x'.repeat(65) })).code).toBe('GLOSSARY_INVALID');
		// 64 characters are allowed, counted in code points (an emoji is one)
		expect(normalizeGlossaryInput({ from: [], to: `${'x'.repeat(63)}😀` }).to).toHaveLength(65);
		expect(refusal(() => normalizeGlossaryInput({ from: [], to: 'ok', lang: 'spanish' })).code).toBe(
			'GLOSSARY_INVALID',
		);
		const many = Array.from({ length: 21 }, (_, i) => `spelling ${i}`);
		expect(refusal(() => normalizeGlossaryInput({ from: many, to: 'Pixelforge' })).code).toBe('GLOSSARY_LIMIT');
		expect(normalizeGlossaryInput({ from: many.slice(0, 20), to: 'Pixelforge' }).from).toHaveLength(20);
	});

	it('the stored schema refuses unclean texts, duplicate spellings and a spelling equal to the target', () => {
		const ok = {
			id: glossaryIdFrom(new Uint8Array(16)),
			from: ['glimer box'],
			to: 'Glimmerbox',
			count: 0,
			createdAt: NOW,
			updatedAt: NOW,
		};
		expect(GlossaryEntrySchema.safeParse(ok).success).toBe(true);
		expect(GlossaryEntrySchema.safeParse({ ...ok, to: ' Glimmerbox' }).success).toBe(false);
		expect(GlossaryEntrySchema.safeParse({ ...ok, from: ['a b', 'A B'] }).success).toBe(false);
		expect(GlossaryEntrySchema.safeParse({ ...ok, from: ['Glimmerbox'] }).success).toBe(false);
		expect(GlossaryEntrySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
		expect(GlossaryEntrySchema.safeParse({ ...ok, id: 'gle_short' }).success).toBe(false);
	});
});

describe('save, remember and edit', () => {
	it('adds, then merges by target; saving again changes nothing; Remember counts', () => {
		const c = ctx();
		const a = upsertGlossaryEntry([], { from: ['nova play'], to: 'NovaPlay', lang: 'es' }, c);
		expect(a).toMatchObject({ created: true, changed: true, entry: { count: 0, from: ['nova play'] } });
		const b = upsertGlossaryEntry(a.entries, { from: ['nova plei', 'Nova Play'], to: 'NovaPlay', lang: 'es' }, {
			...ctx(LATER),
		});
		expect(b).toMatchObject({ created: false, changed: true });
		expect(b.entries).toHaveLength(1);
		expect(b.entry).toMatchObject({ id: a.entry.id, from: ['nova play', 'nova plei'], updatedAt: LATER });
		const again = upsertGlossaryEntry(b.entries, { from: ['nova plei'], to: 'NovaPlay', lang: 'es' }, c);
		expect(again.changed).toBe(false);
		expect(again.entries).toEqual(b.entries);
		const r1 = upsertGlossaryEntry(b.entries, { from: ['nova plei'], to: 'NovaPlay', lang: 'es' }, { ...c, remember: true });
		expect(r1).toMatchObject({ changed: true, entry: { count: 1 } });
		// the same target in another language is another entry
		const en = upsertGlossaryEntry(r1.entries, { from: ['nova play'], to: 'NovaPlay' }, { ...c, remember: true });
		expect(en).toMatchObject({ created: true, entry: { count: 1 } });
		expect(en.entries).toHaveLength(2);
	});

	it('refuses the 2,001st entry and the 21st spelling of an entry', () => {
		const c = ctx();
		let entries: GlossaryEntry[] = [];
		for (let i = 0; i < GLOSSARY_LIMITS.maxEntries; i++) {
			entries.push(
				GlossaryEntrySchema.parse({
					id: glossaryIdFrom(Array.from({ length: 16 }, (_, k) => (k >= 13 ? i >> (5 * (15 - k)) : 0))),
					from: [],
					to: `Name ${i}`,
					count: 0,
					createdAt: NOW,
					updatedAt: NOW,
				}),
			);
		}
		expect(refusal(() => upsertGlossaryEntry(entries, { from: [], to: 'One more' }, c)).code).toBe(
			'GLOSSARY_LIMIT',
		);
		// merging into an existing entry still works at the cap
		expect(upsertGlossaryEntry(entries, { from: ['name zero'], to: 'Name 0' }, c).changed).toBe(true);
		entries = upsertGlossaryEntry(
			[],
			{ from: Array.from({ length: 20 }, (_, i) => `s${i}`), to: 'Glimmerbox' },
			c,
		).entries;
		const e = refusal(() => upsertGlossaryEntry(entries, { from: ['s20'], to: 'Glimmerbox' }, c));
		expect(e.code).toBe('GLOSSARY_LIMIT');
		expect(e.detail).toEqual({ entryId: entries[0]!.id });
	});

	it('edits replace fields; a target another entry has is refused; no change keeps updatedAt', () => {
		const c = ctx();
		const a = upsertGlossaryEntry([], { from: ['pixel forge'], to: 'Pixelforge' }, c);
		const b = upsertGlossaryEntry(a.entries, { from: ['glimer box'], to: 'Glimmerbox' }, c);
		const id = a.entry.id;
		const e = updateGlossaryEntry(b.entries, id, { to: 'PixelForge', from: ['pixel forge', 'pixelforch'], lang: 'en' }, LATER);
		expect(e.entry).toMatchObject({ id, to: 'PixelForge', from: ['pixel forge', 'pixelforch'], lang: 'en', updatedAt: LATER });
		const cleared = updateGlossaryEntry(e.entries, id, { lang: null }, LATER);
		expect(cleared.entry.lang).toBeUndefined();
		const same = updateGlossaryEntry(cleared.entries, id, { to: 'PixelForge' }, '2026-10-28T00:00:00.000Z');
		expect(same.changed).toBe(false);
		expect(same.entry.updatedAt).toBe(LATER);
		const dup = refusal(() => updateGlossaryEntry(cleared.entries, id, { to: 'Glimmerbox' }, LATER));
		expect(dup.code).toBe('GLOSSARY_DUPLICATE');
		expect(refusal(() => updateGlossaryEntry(cleared.entries, 'gle_nope', {}, LATER)).code).toBe(
			'GLOSSARY_NOT_FOUND',
		);
	});
});

describe('import', () => {
	it('reads an exported file and a bare list leniently, refusing other formats and newer versions', () => {
		const file = {
			format: 'jasper-speech-glossary',
			version: 1,
			revision: 7,
			entries: [
				{ id: 'whatever', from: 'nova play', to: 'NovaPlay', count: 3, createdAt: NOW, updatedAt: LATER },
				{ to: 'Glimmerbox', from: ['glimer box', 7] },
				{ from: ['x'] },
				'nope',
				{ to: '  ', from: [] },
				{ to: 'Pixelforge', lang: 'es', count: -4, createdAt: 'yesterday' },
			],
		};
		const r = parseGlossaryImport(file);
		if (!r.ok) throw new Error(r.reason);
		expect(r.entries).toEqual([
			{ from: ['nova play'], to: 'NovaPlay', count: 3, createdAt: NOW, updatedAt: LATER },
			{ from: [], to: 'Pixelforge', lang: 'es', count: 0 },
		]);
		expect(r.indices).toEqual([0, 5]);
		expect(r.skipped.map((s) => s.index)).toEqual([1, 2, 3, 4]);
		expect(parseGlossaryImport([{ to: 'A1', from: ['a one'] }])).toMatchObject({ ok: true, entries: [{ to: 'A1' }] });
		expect(parseGlossaryImport({ ...file, version: 2 })).toMatchObject({ ok: false });
		expect(parseGlossaryImport({ ...file, format: 'jasper-effect-preset' })).toMatchObject({ ok: false });
		expect(parseGlossaryImport('text')).toMatchObject({ ok: false });
		expect(parseGlossaryImport(null)).toMatchObject({ ok: false });
	});

	it('merges additively: new spellings, larger count, earlier creation; a full glossary skips with a reason', () => {
		const c = ctx(LATER);
		const base = upsertGlossaryEntry([], { from: ['nova play'], to: 'NovaPlay' }, { ...ctx(), remember: true });
		const parsed = parseGlossaryImport([
			{ to: 'NovaPlay', from: ['nova plei'], count: 5, createdAt: '2026-01-01T00:00:00.000Z' },
			{ to: 'NovaPlay', from: ['nova play'] },
			{ to: 'Glimmerbox', from: ['glimer box'] },
		]);
		if (!parsed.ok) throw new Error(parsed.reason);
		const m = importGlossaryEntries(base.entries, parsed.entries, c);
		expect(m).toMatchObject({ added: 1, merged: 1, unchanged: 1, skipped: [] });
		expect(m.entries[0]).toMatchObject({
			from: ['nova play', 'nova plei'],
			count: 5,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: LATER,
		});
		// importing the export of a glossary into itself changes nothing
		const reparsed = parseGlossaryImport(m.entries);
		if (!reparsed.ok) throw new Error(reparsed.reason);
		const self = importGlossaryEntries(m.entries, reparsed.entries, c);
		expect(self).toMatchObject({ added: 0, merged: 0, unchanged: 2 });
	});

	it('property: the parser never throws, yields only storable entries and stays bounded', () => {
		const text = fc.oneof(
			fc.string({ maxLength: 80 }),
			fc.constantFrom('NovaPlay', 'nova play', ' Glimmer\nbox ', '…', '', 'x'.repeat(70), 'Píxel', '¿qué?'),
		);
		const entry = fc.oneof(
			fc.record(
				{
					to: fc.oneof(text, fc.integer(), fc.constant(null)),
					from: fc.oneof(text, fc.array(fc.oneof(text, fc.integer()), { maxLength: 30 }), fc.constant(null)),
					lang: fc.oneof(fc.constantFrom('es', 'en', 'xx-YY', ''), fc.integer()),
					count: fc.oneof(fc.integer({ min: -5, max: 2e9 }), fc.double(), fc.string()),
					createdAt: fc.oneof(fc.constant(NOW), fc.string()),
				},
				{ requiredKeys: [] },
			),
			fc.jsonValue(),
		);
		const file = fc.oneof(
			fc.array(entry, { maxLength: 40 }),
			fc.record({
				format: fc.constantFrom('jasper-speech-glossary', 'other'),
				version: fc.oneof(fc.integer({ min: -1, max: 3 }), fc.string()),
				entries: fc.oneof(fc.array(entry, { maxLength: 40 }), fc.jsonValue()),
			}),
			fc.jsonValue(),
			fc.anything(),
		);
		fc.assert(
			fc.property(file, (raw) => {
				const r = parseGlossaryImport(raw);
				if (!r.ok) {
					expect(typeof r.reason).toBe('string');
					return;
				}
				expect(r.entries.length).toBe(r.indices.length);
				expect(r.entries.length + r.skipped.length).toBeLessThanOrEqual(GLOSSARY_LIMITS.maxImportEntries + 1);
				const merged = importGlossaryEntries([], r.entries, ctx());
				expect(merged.entries.length).toBeLessThanOrEqual(GLOSSARY_LIMITS.maxEntries);
				// every merged entry is storable, and the library is a valid file
				GlossaryFileSchema.parse({ format: 'jasper-speech-glossary', version: 1, revision: 0, entries: merged.entries });
				// importing again changes nothing (idempotent)
				const again = importGlossaryEntries(merged.entries, r.entries, ctx(LATER));
				expect(again.added + again.merged).toBe(0);
			}),
			{ numRuns: 300 },
		);
	});

	it('reads at most 10,000 entries of a file', () => {
		const r = parseGlossaryImport(Array.from({ length: 10_005 }, (_, i) => ({ to: `N${i}`, from: [] })));
		if (!r.ok) throw new Error(r.reason);
		expect(r.entries).toHaveLength(10_000);
		expect(r.skipped).toEqual([{ index: 10_000, reason: expect.stringContaining('5 more entries') }]);
		const m = importGlossaryEntries([], r.entries, ctx());
		expect(m.added).toBe(GLOSSARY_LIMITS.maxEntries);
		expect(m.skipped).toHaveLength(10_000 - GLOSSARY_LIMITS.maxEntries);
	});
});
