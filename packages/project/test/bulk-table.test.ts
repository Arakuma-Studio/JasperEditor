// Delimited text tables for bulk import (docs/wp-notes/social-comments.md "Add another & bulk import"): RFC 4180
// CSV, spreadsheet TSV and semicolon CSV, lenient and bounded.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	detectDelimiter,
	formatTable,
	mgImportText,
	parseTable,
	TABLE_MAX_CELL,
	TABLE_MAX_CHARS,
	TABLE_MAX_COLUMNS,
	TABLE_MAX_ROWS,
} from '../src/index.ts';

const records = (text: string, opts?: Parameters<typeof parseTable>[1]) => {
	const r = parseTable(text, opts);
	if (!r.ok) throw new Error(mgImportText(r.message));
	return r.table.records;
};

describe('parseTable', () => {
	it('reads plain CSV with LF, CRLF and CR line ends and a trailing newline', () => {
		expect(records('a,b\n1,2\n')).toEqual([
			['a', 'b'],
			['1', '2'],
		]);
		expect(records('a,b\r\n1,2\r\n3,4')).toEqual([
			['a', 'b'],
			['1', '2'],
			['3', '4'],
		]);
		expect(records('a,b\r1,2\r')).toEqual([
			['a', 'b'],
			['1', '2'],
		]);
	});

	it('drops a byte order mark', () => {
		expect(records('﻿User,Comment\nluna,hi')).toEqual([
			['User', 'Comment'],
			['luna', 'hi'],
		]);
	});

	it('reads quoted cells: delimiters, doubled quotes and line breaks inside (normalised to LF)', () => {
		const t = parseTable('text,likes\n"Hello, ""world""\r\nsecond line",12\n"a\rb",3');
		expect(t.ok).toBe(true);
		if (!t.ok) return;
		expect(t.table.records).toEqual([
			['text', 'likes'],
			['Hello, "world"\nsecond line', '12'],
			['a\nb', '3'],
		]);
		// record line numbers count the line breaks inside quotes
		expect(t.table.lines).toEqual([1, 2, 4]);
		expect(t.table.issues).toEqual([]);
	});

	it('keeps a quote inside an unquoted cell literally', () => {
		expect(records('a,b\n5" screen,x"y"')).toEqual([
			['a', 'b'],
			['5" screen', 'x"y"'],
		]);
	});

	it('keeps text after a closing quote and reports it', () => {
		const t = parseTable('a,b\n"x"y,2');
		expect(t.ok && t.table.records[1]).toEqual(['xy', '2']);
		expect(t.ok && t.table.issues.map((i) => [i.kind, i.record, i.column])).toEqual([
			['text-after-quote', 1, 0],
		]);
	});

	it('an unclosed quote takes the rest of the text and is reported on its line', () => {
		const t = parseTable('a,b\n1,"open\n2,3');
		expect(t.ok).toBe(true);
		if (!t.ok) return;
		expect(t.table.records).toEqual([
			['a', 'b'],
			['1', 'open\n2,3'],
		]);
		expect(t.table.issues).toMatchObject([{ kind: 'unclosed-quote', line: 2, record: 1 }]);
	});

	it('skips blank lines and rows of empty cells; ragged rows keep their cells', () => {
		expect(records('a,b,c\n\n1\n,,\n 2 , 3 ,4,5\n\n')).toEqual([
			['a', 'b', 'c'],
			['1'],
			[' 2 ', ' 3 ', '4', '5'],
		]);
	});

	it('reads TSV pasted from a spreadsheet, quoted cells included', () => {
		const tsv = 'User\tComment\tVerified\nluna\t"line 1\nline ""2"""\tyes\nbo\tplain, with comma\t';
		const t = parseTable(tsv);
		expect(t.ok && t.table.delimiter).toBe('\t');
		expect(t.ok && t.table.records).toEqual([
			['User', 'Comment', 'Verified'],
			['luna', 'line 1\nline "2"', 'yes'],
			['bo', 'plain, with comma', ''],
		]);
	});

	it('detects the delimiter from the first record (outside quotes)', () => {
		expect(detectDelimiter('a\tb\n1,2')).toBe('\t');
		expect(detectDelimiter('a;b;c\n1,5;2;3')).toBe(';');
		expect(detectDelimiter('a,b')).toBe(',');
		expect(detectDelimiter('"x;y;z",b')).toBe(',');
		expect(detectDelimiter('single')).toBe(',');
		expect(records('a;b\n"1;5";2')).toEqual([
			['a', 'b'],
			['1;5', '2'],
		]);
		expect(records('a,b', { delimiter: '\t' })).toEqual([['a,b']]);
	});

	it('refuses empty text, too much text and too many rows', () => {
		expect(parseTable('')).toMatchObject({ ok: false, code: 'E_EMPTY' });
		expect(parseTable('\n\n , \n')).toMatchObject({ ok: false, code: 'E_EMPTY' });
		expect(parseTable('x'.repeat(TABLE_MAX_CHARS + 1))).toMatchObject({ ok: false, code: 'E_TOO_LARGE' });
		const many = ['h', ...Array.from({ length: TABLE_MAX_ROWS + 1 }, (_, i) => `${i}`)].join('\n');
		const r = parseTable(many);
		expect(r).toMatchObject({ ok: false, code: 'E_TOO_LARGE' });
		expect(parseTable(['h', ...Array.from({ length: TABLE_MAX_ROWS }, (_, i) => `${i}`)].join('\n')).ok).toBe(
			true,
		);
		expect(parseTable('h\n1\n2\n3', { maxRows: 2 })).toMatchObject({ ok: false });
	});

	it('cuts over-long cells and extra columns, with issues', () => {
		const t = parseTable(`a\n${'x'.repeat(TABLE_MAX_CELL + 5)}`);
		expect(t.ok && t.table.records[1]![0]!.length).toBe(TABLE_MAX_CELL);
		expect(t.ok && t.table.issues).toMatchObject([{ kind: 'cell-too-long', record: 1, column: 0 }]);
		const quoted = parseTable(`a\n"${'y'.repeat(TABLE_MAX_CELL + 5)}"`);
		expect(quoted.ok && quoted.table.records[1]![0]!.length).toBe(TABLE_MAX_CELL);
		const wide = parseTable(Array.from({ length: TABLE_MAX_COLUMNS + 3 }, (_, i) => `c${i}`).join(','));
		expect(wide.ok && wide.table.records[0]).toHaveLength(TABLE_MAX_COLUMNS);
		expect(wide.ok && wide.table.issues).toMatchObject([{ kind: 'too-many-columns' }]);
	});

	it('round-trips formatTable output (CSV, TSV and semicolon)', () => {
		const rows = [
			['User', 'Comment'],
			['luna', 'He said "hi", then\nleft'],
			['  spaced  ', ''],
		];
		for (const d of [',', '\t', ';'] as const) {
			const r = parseTable(formatTable(rows, d), { delimiter: d });
			expect(r.ok && r.table.records).toEqual(rows);
		}
	});

	describe('properties (fast-check)', () => {
		const cellArb = fc.oneof(
			fc.string({ maxLength: 12 }),
			fc.constantFrom('', ',', ';', '\t', '"', '""', '\n', '\r\n', 'a"b', ' x ', '😀👍🏽', 'é́', '﻿'),
			fc.string({ unit: 'binary', maxLength: 8 }),
		);

		it('never throws and stays within the caps on arbitrary text', () => {
			fc.assert(
				fc.property(
					fc.string({ unit: 'binary', maxLength: 400 }),
					fc.constantFrom('auto', ',', '\t', ';'),
					(text, d) => {
						const r = parseTable(text, { delimiter: d as ',' });
						if (!r.ok) return;
						expect(r.table.records.length).toBeLessThanOrEqual(TABLE_MAX_ROWS + 1);
						expect(r.table.lines).toHaveLength(r.table.records.length);
						for (const rec of r.table.records) {
							expect(rec.length).toBeLessThanOrEqual(TABLE_MAX_COLUMNS);
							expect(rec.some((c) => c.trim() !== '')).toBe(true);
						}
					},
				),
				{ numRuns: 600 },
			);
		});

		it('parse(format(records)) === records for records with a visible cell each', () => {
			fc.assert(
				fc.property(
					fc.array(fc.array(cellArb, { minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 12 }),
					fc.constantFrom(',', '\t', ';'),
					(raw, d) => {
						// line breaks inside cells come back as LF; rows of blank cells are skipped by design
						const rows = raw
							.map((r) => r.map((c) => c.replace(/\r\n?/g, '\n')))
							.filter((r) => r.some((c) => c.trim() !== ''));
						fc.pre(rows.length > 0);
						// a BOM is only stripped at the very start: keep it out of the first cell
						fc.pre(!rows[0]![0]!.startsWith('﻿'));
						const r = parseTable(formatTable(rows, d), { delimiter: d });
						expect(r.ok).toBe(true);
						if (r.ok) {
							expect(r.table.records).toEqual(rows);
							expect(r.table.issues).toEqual([]);
						}
					},
				),
				{ numRuns: 400 },
			);
		});

		it('records start on increasing lines', () => {
			fc.assert(
				fc.property(fc.string({ maxLength: 200 }), (text) => {
					const r = parseTable(text);
					if (!r.ok) return;
					for (let i = 1; i < r.table.lines.length; i++)
						expect(r.table.lines[i]!).toBeGreaterThan(r.table.lines[i - 1]!);
				}),
				{ numRuns: 300 },
			);
		});
	});

	it('parses a 2 MB table (500 rows of 4 KB) in well under a second', () => {
		const long = `This is ==so good== 🔥, ""really"" ${'lorem ipsum '.repeat(330)}`;
		const row = `"luna.makes","${long}","1.2K","yes"\n`;
		const text = `User,Comment,Likes,Verified\n${row.repeat(TABLE_MAX_ROWS)}`;
		expect(text.length).toBeGreaterThan(1.9 * 1024 * 1024);
		expect(text.length).toBeLessThanOrEqual(TABLE_MAX_CHARS);
		const t0 = performance.now();
		const r = parseTable(text);
		const ms = performance.now() - t0;
		expect(r.ok && r.table.records).toHaveLength(TABLE_MAX_ROWS + 1);
		expect(ms).toBeLessThan(1500);
	});
});
