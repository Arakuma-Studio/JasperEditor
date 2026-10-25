// Ages in one spreadsheet cell for the motion-graphic bulk import (docs/wp-notes/social-comments.md "Bulk import",
// App QA N4): "3h", "2 weeks", "10 months", "1y", "5 min", "3 hours ago", "a day ago", "yesterday", "just now" → a
// count and a unit, which the planner stores in the two params a template names in `ui.import.age`
// (social-comment: `timeValue` + `timeUnit`). The spellings are those social platforms print (TikTok / Instagram /
// X "3h", "2w", "10mo"; YouTube "3 hours ago") and what people type. Pure and total: anything else is null.

/** Units an age cell can name, smallest first (a template's unit param offers a subset, by these names). */
export const AGE_UNITS = ['second', 'minute', 'hour', 'day', 'week', 'month', 'year'] as const;
export type AgeUnit = (typeof AGE_UNITS)[number];

/** An age cell: `unit` null = "just now" (value 0, any unit). */
export type ParsedAge = { value: number; unit: AgeUnit | null };

/** Longest cell read as an age (longer text is not one). */
const MAX_AGE_CHARS = 40;
/** Largest count read (more digits are not an age; the value param's maximum is checked afterwards). */
const MAX_AGE_DIGITS = 9;

const UNIT_WORDS: Readonly<Record<string, AgeUnit>> = {
	s: 'second',
	sec: 'second',
	secs: 'second',
	second: 'second',
	seconds: 'second',
	m: 'minute',
	min: 'minute',
	mins: 'minute',
	minute: 'minute',
	minutes: 'minute',
	h: 'hour',
	hr: 'hour',
	hrs: 'hour',
	hour: 'hour',
	hours: 'hour',
	d: 'day',
	day: 'day',
	days: 'day',
	w: 'week',
	wk: 'week',
	wks: 'week',
	week: 'week',
	weeks: 'week',
	mo: 'month',
	mos: 'month',
	mon: 'month',
	mth: 'month',
	mths: 'month',
	month: 'month',
	months: 'month',
	y: 'year',
	yr: 'year',
	yrs: 'year',
	year: 'year',
	years: 'year',
};

const NOW = new Set(['now', 'just now', 'right now', 'a moment ago', 'moments ago', 'a few seconds ago']);
const ONE = new Set(['a', 'an', 'one']);

/**
 * Reads an age cell, ignoring case, surrounding space, a trailing "ago" and a dot after the unit: "3h", "3 h",
 * "3hrs", "2 weeks ago", "10mo", "1y", "5 min.", "an hour ago", "yesterday", "last week", "just now". A bare number
 * ("3") is not an age (it has no unit: the planner reads it as the count alone). Null when the text is not an age.
 */
export function parseAgeCell(raw: string): ParsedAge | null {
	if (typeof raw !== 'string' || raw.length > MAX_AGE_CHARS * 4) return null;
	const t = raw.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
	if (t.length === 0 || t.length > MAX_AGE_CHARS) return null;
	if (NOW.has(t)) return { value: 0, unit: null };
	if (t === 'yesterday') return { value: 1, unit: 'day' };
	const last = /^last (week|month|year)$/u.exec(t);
	if (last) return { value: 1, unit: last[1] as AgeUnit };
	const m = new RegExp(`^(\\d{1,${MAX_AGE_DIGITS}}|a|an|one) ?([a-z]+)\\.?(?: ago)?$`, 'u').exec(t);
	if (!m) return null;
	const unit = UNIT_WORDS[m[2]!];
	if (!unit) return null;
	const value = ONE.has(m[1]!) ? 1 : Number(m[1]);
	return Number.isSafeInteger(value) ? { value, unit } : null;
}
