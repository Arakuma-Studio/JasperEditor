// Motion-graphic bulk import (social-comments design §7.9 "Bulk import", §7.10): a parsed table (`parseTable`) →
// one clip per row. Columns are matched to template params by name or Properties label (ignoring case, spaces, `_`,
// `-`, `.` and `:`), by the template's import aliases (`ui.import.aliases`, which may depend on another param such as
// the variant), or to the clip timing (`start`, `duration`); the rest are ignored with a reason. Cells are coerced
// with the params' JSON Schema (numbers with thousands separators and K/M/B, yes/no booleans, enum values ignoring
// case and punctuation, JSON for object params) and checked against its constraints; an empty cell is "not given"
// (the template's fill hook or its defaults decide). Rows are placed one after another from a start frame, each on
// the first free video track. Pure: the web dialog and the MCP tool share it, and `resolveMgTemplateParams` turns a
// row into the exact params `clip.addMotionGraphic` will store.
import type { Command } from '../commands/index.ts';
import type { MgTemplateImportTarget, MgTemplateImportUi, MgTemplatePreset } from '../registry/mg.ts';
import { type Rational, secondsToFrames } from '../time.ts';
import { parseTimecode } from '../timecode.ts';
import { type MgImportMessage, type MgImportTextCode, shortValue as short } from './messages.ts';
import type { ParsedTable, TableDelimiter } from './table.ts';

/** What the planner needs of a template: the catalogue entry shape (`@jasper/api`, `mgRegistry.catalogJson()`). */
export type MgImportTemplate = {
	id: string;
	version: number;
	name: string;
	/** JSON Schema of the params (an object schema with `properties`). */
	paramsSchema: unknown;
	defaults: Readonly<Record<string, unknown>>;
	defaultDurationSeconds?: number;
	presets?: readonly Pick<MgTemplatePreset, 'id' | 'name' | 'params'>[];
	ui?: {
		params?: Readonly<Record<string, { label?: string } | undefined>>;
		import?: MgTemplateImportUi;
	};
};

export type MgImportColumn = { index: number; header: string } & (
	| { kind: 'param'; param: string }
	| { kind: 'alias'; target: MgTemplateImportTarget }
	| { kind: 'start' }
	| { kind: 'duration' }
	| { kind: 'ignored'; reason: MgImportMessage }
);

export type MgImportRow = {
	/** 0-based data row (the header is not counted). */
	index: number;
	/** 1-based line of the text the row starts on. */
	line: number;
	/** Params given by the row's cells, coerced (empty cells are absent). */
	params: Record<string, unknown>;
	/** Column index each given param came from. */
	sources: Record<string, number>;
	/** Explicit start / duration in frames (absent: after the previous row / the template default). */
	start?: number;
	duration?: number;
	/** Problems that keep the row out of the import (`mgImportText` words them). */
	errors: MgImportMessage[];
	/** Things the user should know (ignored cells, an alias overridden by a direct column). */
	warnings: MgImportMessage[];
};

export type MgImportPlan = {
	template: { id: string; version: number };
	preset?: string;
	/** The preset's params (empty without a preset): every row starts from them. */
	presetParams: Record<string, unknown>;
	delimiter: TableDelimiter;
	columns: MgImportColumn[];
	rows: MgImportRow[];
	/** Default clip length in frames (template default, else 5 s). */
	defaultDuration: number;
};

export type MgImportPlanResult = { ok: true; plan: MgImportPlan } | { ok: false; message: MgImportMessage };

/** Column names of the clip timing (unless a param has the same name, which wins). */
const START_COLUMNS = ['start', 'at', 'startat', 'starttime', 'in', 'clipstart'];
const DURATION_COLUMNS = ['duration', 'length', 'dur', 'clipduration', 'cliplength'];
/** Longest start accepted (100 h). */
const MAX_START_SECONDS = 360_000;
/** Longest clip accepted (1 h). */
const MAX_DURATION_SECONDS = 3600;

/** A header or name for matching: lower case, NFKC, without spaces, `_`, `-`, `.`, `:` and a leading `@` / `#`. */
export function normalizeColumnName(s: string): string {
	return s
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[\s_\-.:]+/gu, '')
		.replace(/^[@#]+/u, '');
}

/** Seed of import row / batch item `index` from the base seed (the MCP `add_motion_graphic` derivation). */
export function mgItemSeed(base: number, index: number): number {
	return (base + Math.imul(index, 0x9e37_79b9)) >>> 0;
}

type JsonSchema = Record<string, unknown>;
type ScalarKind = 'boolean' | 'integer' | 'number' | 'string' | 'enum' | 'json';
const isObj = (v: unknown): v is JsonSchema => !!v && typeof v === 'object' && !Array.isArray(v);

/** The non-null alternatives of a property schema (anyOf / oneOf / type arrays). */
function alternatives(s: JsonSchema): JsonSchema[] {
	const alts = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null) as
		| unknown[]
		| null;
	if (alts) return alts.filter(isObj).flatMap((a) => alternatives(a));
	if (s.type === 'null') return [];
	if (Array.isArray(s.type)) {
		const types = s.type.filter((t) => t !== 'null');
		return types.length === 1 ? [{ ...s, type: types[0] }] : [{ ...s, type: undefined, anyOf: undefined }];
	}
	return [s];
}

function kindOf(s: JsonSchema): ScalarKind {
	if (Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every((v) => typeof v === 'string')) return 'enum';
	if (typeof s.const === 'string') return 'enum';
	switch (s.type) {
		case 'boolean':
			return 'boolean';
		case 'integer':
			return 'integer';
		case 'number':
			return 'number';
		case 'string':
			return 'string';
		default:
			return 'json';
	}
}

/** The scalar schema of a param (the one non-null alternative), or a JSON param. */
function paramShape(prop: unknown): { kind: ScalarKind; schema: JsonSchema; nullable: boolean } {
	if (!isObj(prop)) return { kind: 'json', schema: {}, nullable: false };
	const alts = alternatives(prop);
	const all = Array.isArray(prop.anyOf) || Array.isArray(prop.oneOf) || Array.isArray(prop.type);
	const nullable = all && alts.length < ((prop.anyOf ?? prop.oneOf ?? prop.type) as unknown[]).length;
	if (alts.length !== 1) return { kind: 'json', schema: prop, nullable };
	return { kind: kindOf(alts[0]!), schema: alts[0]!, nullable };
}

const TRUE = new Set(['true', 'yes', 'y', '1', 'on', 'x', '✓', '✔', 'si', 'sí', 'verified', 'checked']);
const FALSE = new Set(['false', 'no', 'n', '0', 'off', '-', '✗', '✘', 'unchecked', 'none']);
const NUMBER = /^([-+]?)(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?\s*([kmb])?$/iu;
const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** "1,234", "1.2K", "12K", "3.5M", "-4" → a number; null when the text is not one. */
export function parseCellNumber(raw: string): number | null {
	const m = NUMBER.exec(raw.trim());
	if (!m || (m[2] === undefined && m[3] === undefined)) return null;
	const int = (m[2] ?? '0').replaceAll(',', '');
	const frac = m[3] ?? '';
	const base = Number(`${int}${frac ? `.${frac}` : ''}`);
	const mult = m[4] ? SUFFIX[m[4].toLowerCase()]! : 1;
	const value = Number((base * mult).toPrecision(15));
	if (!Number.isFinite(value)) return null;
	return m[1] === '-' ? -value || 0 : value;
}

const enumKey = (v: string) =>
	v
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '');

type Coerced = { ok: true; value: unknown } | { ok: false; message: MgImportMessage };
const msg = (code: MgImportTextCode, ...values: (string | number)[]): MgImportMessage => ({ code, values });

function checkNumber(n: number, s: JsonSchema, integer: boolean): MgImportMessage | null {
	if (integer && !Number.isInteger(n)) return msg('not-integer', n);
	if (typeof s.minimum === 'number' && n < s.minimum) return msg('below-minimum', n, s.minimum);
	if (typeof s.maximum === 'number' && n > s.maximum) return msg('above-maximum', n, s.maximum);
	if (typeof s.exclusiveMinimum === 'number' && n <= s.exclusiveMinimum)
		return msg('not-above', n, s.exclusiveMinimum);
	if (typeof s.exclusiveMaximum === 'number' && n >= s.exclusiveMaximum)
		return msg('not-below', n, s.exclusiveMaximum);
	return null;
}

function checkString(v: string, s: JsonSchema): MgImportMessage | null {
	if (typeof s.minLength === 'number' && v.length < s.minLength) return msg('text-too-short', s.minLength);
	if (typeof s.maxLength === 'number' && v.length > s.maxLength)
		return msg('text-too-long', s.maxLength, v.length);
	if (typeof s.pattern === 'string') {
		let re: RegExp | null = null;
		try {
			re = new RegExp(s.pattern, 'u');
		} catch {
			try {
				re = new RegExp(s.pattern);
			} catch {
				re = null; // a pattern this engine cannot compile: the template schema still checks it
			}
		}
		if (re && !re.test(v)) return msg('bad-characters', short(v));
	}
	return null;
}

/** A cell's text → the param value its JSON Schema describes (empty cells never reach here). */
export function coerceCell(raw: string, prop: unknown): Coerced {
	const { kind, schema } = paramShape(prop);
	const text = raw.trim();
	switch (kind) {
		case 'enum': {
			const values = (Array.isArray(schema.enum) ? schema.enum : [schema.const]) as string[];
			const exact = values.find((v) => v === text);
			const hit = exact ?? values.find((v) => enumKey(v) === enumKey(text));
			if (hit !== undefined) return { ok: true, value: hit };
			const list = values.slice(0, 12).join(', ') + (values.length > 12 ? ', …' : '');
			return { ok: false, message: msg('not-in-list', short(text), list) };
		}
		case 'boolean': {
			const k = text.toLowerCase();
			if (TRUE.has(k)) return { ok: true, value: true };
			if (FALSE.has(k)) return { ok: true, value: false };
			return { ok: false, message: msg('not-boolean', short(text)) };
		}
		case 'integer':
		case 'number': {
			const n = parseCellNumber(text);
			if (n === null) return { ok: false, message: msg('not-number', short(text)) };
			const bad = checkNumber(n, schema, kind === 'integer');
			return bad ? { ok: false, message: bad } : { ok: true, value: n };
		}
		case 'string': {
			// keep inner spacing and line breaks; only the cell's outer whitespace goes
			const bad = checkString(text, schema);
			return bad ? { ok: false, message: bad } : { ok: true, value: text };
		}
		default: {
			try {
				return { ok: true, value: JSON.parse(text) as unknown };
			} catch {
				return { ok: false, message: msg('not-json', short(text), jsonExample(schema)) };
			}
		}
	}
}

function jsonExample(s: JsonSchema): string {
	const alt = alternatives(s).find((a) => a.type === 'object' && isObj(a.properties));
	if (!alt) return 'null';
	const props = alt.properties as JsonSchema;
	const first = Object.keys(props)[0];
	return first ? `{"${first}": …}` : '{}';
}

/** A time cell → frames: seconds ("3", "1.5", "3s", "250ms"), frames ("90f"), "M:SS", "H:MM:SS" or timecode. */
export function parseCellTime(raw: string, rate: Rational): number | null {
	const t = raw.trim().toLowerCase();
	if (t.length === 0 || t.length > 32) return null;
	let m = /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)?$/u.exec(t);
	if (m) return secondsToFrames(Number(m[1]), rate, 'round');
	m = /^(\d+(?:\.\d+)?)\s*ms$/u.exec(t);
	if (m) return secondsToFrames(Number(m[1]) / 1000, rate, 'round');
	m = /^(\d+)\s*(?:f|frames?)$/u.exec(t);
	if (m) return Number(m[1]);
	m = /^(\d{1,4}):([0-5]\d)$/u.exec(t);
	if (m) return secondsToFrames(Number(m[1]) * 60 + Number(m[2]), rate, 'round');
	m = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/u.exec(t);
	if (m) return secondsToFrames(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), rate, 'round');
	if (/^\d{1,3}[:;]\d{1,2}[:;]\d{1,2}[:;.]\d{1,3}$/u.test(t)) {
		const f = parseTimecode(t, rate);
		return f !== null && Number.isFinite(f) && f >= 0 ? f : null;
	}
	return null;
}

/** The target param of an alias for a row whose params (row, then preset, then defaults) are `lookup`. */
function aliasTarget(target: MgTemplateImportTarget, lookup: (param: string) => unknown): string | null {
	if (typeof target === 'string') return target;
	if (!isObj(target) || typeof target.byParam !== 'string') return null;
	const v = lookup(target.byParam);
	const mapped =
		typeof v === 'string' && isObj(target.map) ? (target.map as Record<string, unknown>)[v] : undefined;
	if (typeof mapped === 'string') return mapped;
	return typeof target.otherwise === 'string' ? target.otherwise : null;
}

const plainEntries = <T>(o: unknown): [string, T][] =>
	isObj(o) ? (Object.entries(o) as [string, T][]).filter(([k]) => typeof k === 'string') : [];

/** Matches the header row to params, timing columns and ignored columns. */
export function mapImportColumns(header: readonly string[], template: MgImportTemplate): MgImportColumn[] {
	const props =
		isObj(template.paramsSchema) && isObj(template.paramsSchema.properties)
			? template.paramsSchema.properties
			: {};
	const params = Object.keys(props);
	const byName = new Map(params.map((p) => [normalizeColumnName(p), p]));
	const byLabel = new Map<string, string>();
	for (const [p, h] of plainEntries<{ label?: unknown }>(template.ui?.params))
		if (params.includes(p) && isObj(h) && typeof h.label === 'string' && h.label.trim())
			byLabel.set(normalizeColumnName(h.label), p);
	const hints = isObj(template.ui?.import) ? template.ui.import : {};
	const aliases = new Map(
		plainEntries<MgTemplateImportTarget>(hints.aliases).map(([k, v]) => [normalizeColumnName(k), v]),
	);
	const ignored = new Map(
		plainEntries<unknown>(hints.ignored)
			.filter(([, v]) => typeof v === 'string')
			.map(([k, v]) => [normalizeColumnName(k), v as string]),
	);
	const used = new Map<string, string>();
	return header.map((raw, index) => {
		const headerText = raw.trim();
		const key = normalizeColumnName(headerText);
		const col = { index, header: headerText };
		if (!key) return { ...col, kind: 'ignored', reason: msg('column-unnamed') };
		const param = byName.get(key) ?? byLabel.get(key);
		const claim = (name: string): MgImportColumn => {
			const prev = used.get(name);
			if (prev !== undefined) return { ...col, kind: 'ignored', reason: msg('column-duplicate', prev) };
			used.set(name, headerText);
			return { ...col, kind: 'param', param: name };
		};
		if (param) return claim(param);
		const alias = aliases.get(key);
		if (alias !== undefined) {
			if (typeof alias === 'string')
				return params.includes(alias)
					? claim(alias)
					: { ...col, kind: 'ignored', reason: msg('column-bad-alias') };
			return { ...col, kind: 'alias', target: alias };
		}
		if (START_COLUMNS.includes(key)) {
			if (used.has('$start'))
				return { ...col, kind: 'ignored', reason: msg('column-duplicate', used.get('$start')!) };
			used.set('$start', headerText);
			return { ...col, kind: 'start' };
		}
		if (DURATION_COLUMNS.includes(key)) {
			if (used.has('$duration'))
				return { ...col, kind: 'ignored', reason: msg('column-duplicate', used.get('$duration')!) };
			used.set('$duration', headerText);
			return { ...col, kind: 'duration' };
		}
		const why = ignored.get(key);
		if (why) return { ...col, kind: 'ignored', reason: { code: 'template', text: why, values: [] } };
		return { ...col, kind: 'ignored', reason: msg('column-unknown', template.name) };
	});
}

/**
 * Plans an import of `table` (first record = column names) as clips of `template`, optionally starting every row
 * from a preset's params. Refuses (ok: false) an unknown preset, a table without data rows, or a header that names
 * no param or timing column. Row problems are kept on the rows (`errors`), never thrown.
 */
export function planMgImport(
	table: ParsedTable,
	template: MgImportTemplate,
	opts: { preset?: string; rate: Rational },
): MgImportPlanResult {
	const props =
		isObj(template.paramsSchema) && isObj(template.paramsSchema.properties)
			? template.paramsSchema.properties
			: {};
	let presetParams: Record<string, unknown> = {};
	if (opts.preset !== undefined) {
		const p = template.presets?.find((x) => x.id === opts.preset);
		if (!p) return { ok: false, message: msg('no-preset', template.name, opts.preset) };
		presetParams = { ...p.params };
	}
	const [header, ...data] = table.records;
	if (!header) return { ok: false, message: msg('empty') };
	const columns = mapImportColumns(header, template);
	if (!columns.some((c) => c.kind !== 'ignored'))
		return {
			ok: false,
			message: msg('no-header', template.name, Object.keys(props).slice(0, 4).join(', ')),
		};
	if (data.length === 0) return { ok: false, message: msg('no-data') };
	const hints = isObj(template.ui?.import) ? template.ui.import : {};
	const trim = new Map(plainEntries<unknown>(hints.trimPrefix).filter(([, v]) => typeof v === 'string' && v));
	const fps = opts.rate.den > 0 ? opts.rate.num / opts.rate.den : 0;
	const defaultSeconds =
		typeof template.defaultDurationSeconds === 'number' && template.defaultDurationSeconds > 0
			? template.defaultDurationSeconds
			: 5;
	const issuesByRecord = new Map<number, ParsedTable['issues']>();
	for (const i of table.issues) issuesByRecord.set(i.record, [...(issuesByRecord.get(i.record) ?? []), i]);
	const headerIssues = issuesByRecord.get(0) ?? [];

	const rows = data.map((cells, r): MgImportRow => {
		const record = r + 1;
		const row: MgImportRow = {
			index: r,
			line: table.lines[record] ?? record + 1,
			params: {},
			sources: {},
			errors: [],
			warnings: [],
		};
		for (const issue of issuesByRecord.get(record) ?? []) {
			if (issue.kind === 'cell-too-long') row.errors.push(issue.message);
			else row.warnings.push(issue.message);
		}
		if (cells.length > header.length) row.warnings.push(msg('extra-cells', cells.length - header.length));
		const assign = (param: string, column: MgImportColumn, rawText: string) => {
			let text = rawText;
			const prefix = trim.get(param) as string | undefined;
			if (prefix && text.trim().startsWith(prefix)) text = text.trim().slice(prefix.length);
			const c = coerceCell(text, props[param]);
			if (!c.ok) row.errors.push({ ...c.message, column: column.header });
			else {
				row.params[param] = c.value;
				row.sources[param] = column.index;
			}
		};
		const cell = (c: MgImportColumn) => cells[c.index] ?? '';
		// direct params first: aliases may depend on them (e.g. the row's variant)
		for (const c of columns) if (c.kind === 'param' && cell(c).trim() !== '') assign(c.param, c, cell(c));
		const lookup = (p: string) =>
			Object.hasOwn(row.params, p)
				? row.params[p]
				: Object.hasOwn(presetParams, p)
					? presetParams[p]
					: template.defaults[p];
		for (const c of columns) {
			if (c.kind !== 'alias' || cell(c).trim() === '') continue;
			const target = aliasTarget(c.target, lookup);
			if (!target || !Object.hasOwn(props, target)) {
				row.warnings.push({ ...msg('alias-no-target'), column: c.header });
				continue;
			}
			const direct = columns.find((x) => x.kind === 'param' && x.param === target);
			if (Object.hasOwn(row.params, target) || (direct && cell(direct).trim() !== '')) {
				row.warnings.push({ ...msg('alias-overridden', target), column: c.header });
				continue;
			}
			assign(target, c, cell(c));
		}
		for (const c of columns) {
			if ((c.kind !== 'start' && c.kind !== 'duration') || cell(c).trim() === '') continue;
			const frames = fps > 0 ? parseCellTime(cell(c), opts.rate) : null;
			const max = (c.kind === 'start' ? MAX_START_SECONDS : MAX_DURATION_SECONDS) * fps;
			if (frames === null) row.errors.push({ ...msg('not-time', short(cell(c).trim())), column: c.header });
			else if (c.kind === 'duration' && frames < 1)
				row.errors.push({ ...msg('duration-too-short'), column: c.header });
			else if (frames > max)
				row.errors.push({ ...msg('time-too-long', short(cell(c).trim())), column: c.header });
			else row[c.kind] = frames;
		}
		return row;
	});
	for (const i of headerIssues) if (rows[0]) rows[0].warnings.push({ ...i.message, column: 'Header' });
	return {
		ok: true,
		plan: {
			template: { id: template.id, version: template.version },
			...(opts.preset !== undefined ? { preset: opts.preset } : {}),
			presetParams,
			delimiter: table.delimiter,
			columns,
			rows,
			defaultDuration: Math.max(1, secondsToFrames(defaultSeconds, opts.rate, 'round')),
		},
	};
}

export type MgImportPlacement = { row: number; start: number; duration: number };

/**
 * Start and length of each row: an explicit start, else the end of the previous row (the first at `startAt`); an
 * explicit duration, else the default. Rows in `rows` order (pass only the rows being inserted).
 */
export function scheduleMgImport(
	rows: readonly Pick<MgImportRow, 'index' | 'start' | 'duration'>[],
	opts: { startAt: number; defaultDuration: number },
): MgImportPlacement[] {
	let cursor = Math.max(0, Math.round(opts.startAt));
	const fallback = Math.max(1, Math.round(opts.defaultDuration));
	return rows.map((r) => {
		const start = r.start ?? cursor;
		const duration = r.duration ?? fallback;
		cursor = start + duration;
		return { row: r.index, start, duration };
	});
}

/** The `clip.addMotionGraphic` command of one row: preset ⊕ row params, its fill seed, first-free from `track`. */
export function mgImportCommand(
	plan: Pick<MgImportPlan, 'template' | 'presetParams'>,
	row: Pick<MgImportRow, 'index' | 'params'>,
	placement: Pick<MgImportPlacement, 'start' | 'duration'>,
	opts: { seed: number; track: string; sequenceId?: string },
): Command {
	const params = { ...plan.presetParams, ...row.params };
	return {
		type: 'clip.addMotionGraphic',
		...(opts.sequenceId ? { sequenceId: opts.sequenceId } : {}),
		at: placement.start,
		duration: placement.duration,
		track: opts.track,
		placement: 'first-free',
		template: { id: plan.template.id, version: plan.template.version },
		...(Object.keys(params).length > 0 ? { params } : {}),
		fill: { seed: mgItemSeed(opts.seed, row.index) },
	} as Command;
}
