// Messages of the bulk import (table parser and motion-graphic import planner) as codes with values, so every
// surface words them in its own language: `mgImportText` gives the English text (MCP, logs); the web app looks the
// same templates up in its catalogue (they are listed in apps/web/src/i18n/model-strings.json by `pnpm i18n`).

/** English templates; `{0}`, `{1}` are the message's values. */
export const MG_IMPORT_TEXT = {
	// table
	'too-large': 'The text is too large to import ({0} KB; at most {1} MB)',
	'too-many-rows': 'Too many rows: at most {0} rows (plus the header row) can be imported at once',
	empty: 'There are no rows to import',
	'unclosed-quote': 'A quote opened on line {0} is never closed: the rest of the text is in one cell',
	'text-after-quote': 'Text after the closing quote of cell {0} was kept',
	'cell-too-long': 'Cell {0} is longer than {1} characters',
	'too-many-columns': 'More than {0} cells: the rest of the row is ignored',
	// plan
	'no-preset': '{0} has no preset "{1}"',
	'no-header': 'The first row must name the columns (parameter names of {0} such as {1})',
	'no-data': 'There are no rows under the column names',
	'extra-cells': '{0} cell(s) beyond the named columns ignored',
	// columns
	'column-unnamed': 'The column has no name',
	'column-duplicate': 'Same column as "{0}"',
	'column-bad-alias': 'The template names an unknown parameter for this column',
	'column-unknown': 'Not a parameter of {0}',
	// cells
	'not-in-list': '"{0}" is not one of {1}',
	'not-boolean': '"{0}" is not yes / no',
	'not-number': '"{0}" is not a number',
	'not-integer': '{0} is not a whole number',
	'below-minimum': '{0} is below the minimum {1}',
	'above-maximum': '{0} is above the maximum {1}',
	'not-above': '{0} must be above {1}',
	'not-below': '{0} must be below {1}',
	'text-too-short': 'Needs at least {0} character(s)',
	'text-too-long': 'Longer than {0} characters ({1})',
	'bad-characters': '"{0}" has characters this field does not take',
	'not-json': '"{0}" is not JSON (this field takes a value like {1})',
	'not-date': '"{0}" is not a date (year-month-day, e.g. 2025-09-24)',
	'alias-no-target': 'No parameter takes this column for this row',
	'alias-overridden': 'Ignored: the row already sets {0}',
	'not-time': '"{0}" is not a time (3, 1.5s, 0:03, 90f)',
	'duration-too-short': 'The length must be at least 1 frame',
	'time-too-long': '"{0}" is too long',
} as const;

export type MgImportTextCode = keyof typeof MG_IMPORT_TEXT;

/**
 * One message: a code of `MG_IMPORT_TEXT` with its values, or `template` (`text` = a reason written by the template,
 * itself a catalogue string). `column` = the header of the column it is about.
 */
export type MgImportMessage =
	| { code: MgImportTextCode; values: (string | number)[]; column?: string }
	| { code: 'template'; text: string; values: []; column?: string };

/** Fills `{n}` placeholders of a template. */
export function fillTemplateText(template: string, values: readonly (string | number)[]): string {
	return template.replace(/\{(\d+)\}/g, (all, n: string) =>
		values[Number(n)] === undefined ? all : String(values[Number(n)]),
	);
}

/** English text of a message, prefixed by its column ("Likes: "abc" is not a number"). */
export function mgImportText(m: MgImportMessage): string {
	const body = m.code === 'template' ? m.text : fillTemplateText(MG_IMPORT_TEXT[m.code] ?? m.code, m.values);
	return m.column ? `${m.column}: ${body}` : body;
}

/** A value shown inside a message (long cells are cut). */
export const shortValue = (v: string): string => (v.length > 40 ? `${v.slice(0, 39)}…` : v);
