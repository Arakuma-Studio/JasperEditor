// Delimited text tables for bulk import (social-comments design §7.9 "Bulk import"): RFC 4180 CSV, rows pasted from a
// spreadsheet (TSV — Excel, Numbers, LibreOffice and Google Sheets copy cells as tab-separated text and quote cells
// that hold tabs, quotes or line breaks the CSV way) and semicolon CSV (spreadsheets of comma-decimal locales).
// Lenient like the spreadsheets that produce the text: quotes, doubled quotes, CRLF / LF / CR line ends, a byte
// order mark, line breaks inside quoted cells and ragged rows are read; problems become issues, never exceptions.
// Pure and bounded (AGENTS §0): the text, the rows, the columns and each cell are capped.
import type { MgImportMessage } from './messages.ts';

/** Largest text parsed, in UTF-16 code units (≈ 2 MB of ASCII). */
export const TABLE_MAX_CHARS = 2 * 1024 * 1024;
/** Most data rows (records after the header). */
export const TABLE_MAX_ROWS = 500;
/** Most columns kept per record. */
export const TABLE_MAX_COLUMNS = 64;
/** Longest cell kept, in UTF-16 code units. */
export const TABLE_MAX_CELL = 10_000;

export type TableDelimiter = ',' | '\t' | ';';

export type TableIssue = {
	/** 0-based record index (0 = header) the issue belongs to. */
	record: number;
	/** 1-based physical line the record starts on. */
	line: number;
	kind: 'unclosed-quote' | 'text-after-quote' | 'cell-too-long' | 'too-many-columns';
	/** 0-based column, when the issue is about one cell. */
	column?: number;
	/** What to tell the user (`mgImportText` words it). */
	message: MgImportMessage;
};

export type ParsedTable = {
	delimiter: TableDelimiter;
	/** Records in file order (the first is usually the header); blank records are skipped. */
	records: string[][];
	/** 1-based physical line each record starts on (same length as `records`). */
	lines: number[];
	issues: TableIssue[];
};

export type ParseTableResult =
	| { ok: true; table: ParsedTable }
	| { ok: false; code: 'E_TOO_LARGE' | 'E_EMPTY'; message: MgImportMessage };

export type ParseTableOptions = {
	/** `auto` (default) = `detectDelimiter`. */
	delimiter?: TableDelimiter | 'auto';
	/** Most data rows (default TABLE_MAX_ROWS); more refuses the table. */
	maxRows?: number;
};

const QUOTE = 0x22;
const CR = 0x0d;
const LF = 0x0a;

/**
 * The delimiter of `text`: tab when its first record has a tab outside quotes (pasted cells), else semicolon when
 * that record has more semicolons than commas, else comma.
 */
export function detectDelimiter(text: string): TableDelimiter {
	let tabs = 0;
	let commas = 0;
	let semis = 0;
	let quoted = false;
	const limit = Math.min(text.length, 65_536);
	for (let i = 0; i < limit; i++) {
		const c = text.charCodeAt(i);
		if (c === QUOTE) quoted = !quoted;
		else if (quoted) continue;
		else if (c === LF || c === CR) break;
		else if (c === 0x09) tabs++;
		else if (c === 0x2c) commas++;
		else if (c === 0x3b) semis++;
	}
	if (tabs > 0) return '\t';
	return semis > commas ? ';' : ',';
}

const blank = (record: readonly string[]) => record.every((c) => c.trim() === '');

/**
 * Parses delimited text into records. Rules (RFC 4180 plus what spreadsheets write):
 * - a leading byte order mark is dropped; CRLF, LF and CR all end a record outside quotes;
 * - a cell that starts with `"` is quoted: `""` inside is one quote, delimiters and line breaks are literal
 *   (line breaks are normalised to LF); text after the closing quote is kept (issue `text-after-quote`); a quote
 *   left open at the end takes the rest of the text (issue `unclosed-quote`);
 * - a quote inside an unquoted cell is literal (`5" screen`);
 * - records whose cells are all blank are skipped; records may have any number of cells (ragged rows);
 * - more than TABLE_MAX_COLUMNS cells: the rest are dropped (issue); a cell longer than TABLE_MAX_CELL is cut
 *   (issue `cell-too-long`, which import treats as an error of that row);
 * - more than `maxRows` data records, or text over TABLE_MAX_CHARS, refuse the table (E_TOO_LARGE).
 */
export function parseTable(text: string, opts: ParseTableOptions = {}): ParseTableResult {
	if (typeof text !== 'string') return { ok: false, code: 'E_EMPTY', message: { code: 'empty', values: [] } };
	if (text.length > TABLE_MAX_CHARS)
		return {
			ok: false,
			code: 'E_TOO_LARGE',
			message: { code: 'too-large', values: [Math.ceil(text.length / 1024), TABLE_MAX_CHARS / 1024 / 1024] },
		};
	const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const delimiter = opts.delimiter && opts.delimiter !== 'auto' ? opts.delimiter : detectDelimiter(src);
	const maxRows = Math.max(0, Math.min(opts.maxRows ?? TABLE_MAX_ROWS, TABLE_MAX_ROWS));
	const delim = delimiter.charCodeAt(0);
	const records: string[][] = [];
	const lines: number[] = [];
	const issues: TableIssue[] = [];

	let line = 1;
	let recordLine = 1;
	let record: string[] = [];
	let cell = '';
	let cellCut = false;
	let columnsCut = false;
	let i = 0;
	const n = src.length;

	const issue = (kind: TableIssue['kind'], message: MgImportMessage, column?: number) =>
		issues.push({
			record: records.length,
			line: recordLine,
			kind,
			message,
			...(column !== undefined ? { column } : {}),
		});
	const append = (s: string) => {
		if (cellCut) return;
		if (cell.length + s.length > TABLE_MAX_CELL) {
			cell += s.slice(0, TABLE_MAX_CELL - cell.length);
			cellCut = true;
			issue(
				'cell-too-long',
				{ code: 'cell-too-long', values: [record.length + 1, TABLE_MAX_CELL] },
				record.length,
			);
		} else cell += s;
	};
	const endCell = () => {
		if (record.length < TABLE_MAX_COLUMNS) record.push(cell);
		else if (!columnsCut) {
			columnsCut = true;
			issue('too-many-columns', { code: 'too-many-columns', values: [TABLE_MAX_COLUMNS] });
		}
		cell = '';
		cellCut = false;
	};
	/** Ends the record; false when the row cap is exceeded. */
	const endRecord = (): boolean => {
		endCell();
		if (!blank(record)) {
			records.push(record);
			lines.push(recordLine);
		} else {
			// issues raised on a skipped blank record belong to nothing
			while (issues.length && issues[issues.length - 1]!.record === records.length) issues.pop();
		}
		record = [];
		columnsCut = false;
		recordLine = line;
		return records.length <= maxRows + 1;
	};
	/** Consumes a line break at `i` (CRLF, LF or CR); returns the index after it. */
	const lineBreak = (at: number): number => {
		line++;
		return src.charCodeAt(at) === CR && src.charCodeAt(at + 1) === LF ? at + 2 : at + 1;
	};

	while (i < n) {
		const c = src.charCodeAt(i);
		if (c === QUOTE && cell === '' && !cellCut) {
			// quoted cell
			const openLine = line;
			i++;
			let closed = false;
			while (i < n) {
				const q = src.indexOf('"', i);
				const stop = q < 0 ? n : q;
				// copy the run, normalising line breaks to LF and counting lines
				let j = i;
				while (j < stop) {
					const k = src.charCodeAt(j);
					if (k === CR || k === LF) {
						append(src.slice(i, j));
						append('\n');
						j = lineBreak(j);
						i = j;
						// a CRLF split by `stop` cannot happen: `stop` is a quote
					} else j++;
				}
				append(src.slice(i, stop));
				if (q < 0) {
					i = n;
					break;
				}
				if (src.charCodeAt(q + 1) === QUOTE) {
					append('"');
					i = q + 2;
					continue;
				}
				i = q + 1;
				closed = true;
				break;
			}
			if (!closed) {
				issues.push({
					record: records.length,
					line: openLine,
					kind: 'unclosed-quote',
					column: record.length,
					message: { code: 'unclosed-quote', values: [openLine] },
				});
				continue;
			}
			// text after the closing quote, up to the delimiter or the line end
			const tailStart = i;
			while (i < n) {
				const k = src.charCodeAt(i);
				if (k === delim || k === CR || k === LF) break;
				i++;
			}
			if (i > tailStart) {
				append(src.slice(tailStart, i));
				issue('text-after-quote', { code: 'text-after-quote', values: [record.length + 1] }, record.length);
			}
			continue;
		}
		if (c === delim) {
			endCell();
			i++;
			continue;
		}
		if (c === CR || c === LF) {
			i = lineBreak(i);
			if (!endRecord()) return tooManyRows(maxRows);
			continue;
		}
		// unquoted run up to the next delimiter or line break
		let j = i + 1;
		while (j < n) {
			const k = src.charCodeAt(j);
			if (k === delim || k === CR || k === LF) break;
			j++;
		}
		append(src.slice(i, j));
		i = j;
	}
	if (cell !== '' || record.length > 0) {
		if (!endRecord()) return tooManyRows(maxRows);
	}
	if (records.length === 0) return { ok: false, code: 'E_EMPTY', message: { code: 'empty', values: [] } };
	return { ok: true, table: { delimiter, records, lines, issues } };
}

function tooManyRows(maxRows: number): ParseTableResult {
	return {
		ok: false,
		code: 'E_TOO_LARGE',
		message: { code: 'too-many-rows', values: [maxRows] },
	};
}

/** Writes records as RFC 4180 text (quotes cells holding the delimiter, quotes or line breaks); CRLF line ends. */
export function formatTable(
	records: readonly (readonly string[])[],
	delimiter: TableDelimiter = ',',
): string {
	const needs = (s: string) => s.includes(delimiter) || /["\r\n]/.test(s) || s.trim() !== s;
	return records
		.map((r) => r.map((c) => (needs(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(delimiter))
		.join('\r\n');
}
