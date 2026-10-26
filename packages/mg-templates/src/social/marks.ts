// Word marks in social-comment text (design 2026-10-25 §7.5): `==highlight==`, `||blur||`, `~~remove~~`, with `\`
// escapes. Pure and total: every function accepts any string and never throws.
//
// Grammar (deterministic; see docs/wp-notes/social-comments.md "Social comment core"):
// - `\` followed by one of `\ = | ~` is that character, literally. Any other `\` is a literal backslash.
// - A doubled marker character (`==`, `||`, `~~`) opens a mark when a matching unescaped pair of the same character
//   follows with at least one character between them; the first such pair closes it. Otherwise the characters are
//   literal text (unbalanced markers render literally).
// - Marks do not nest: inside a mark, other markers are literal text. Overlapping markup therefore resolves to the
//   mark that opens first (`==a ||b== c||` → highlight "a ||b", then literal " c||").
// Coordinates: positions in the *visible* text (marks stripped), in UTF-16 code units.

export const SOCIAL_MARKS = ['highlight', 'blur', 'remove'] as const;
export type SocialMark = (typeof SOCIAL_MARKS)[number];
export type SocialMarkKind = 'none' | SocialMark;

/** A run of visible text with one mark. */
export type MarkSpan = { text: string; mark: SocialMarkKind };

/** A range of the visible text, `start` inclusive, `end` exclusive (UTF-16 code units; any order, clamped). */
export type MarkRange = { start: number; end: number };

const MARK_OF_CHAR: Readonly<Record<string, SocialMark>> = { '=': 'highlight', '|': 'blur', '~': 'remove' };
const CHAR_OF_MARK: Readonly<Record<SocialMark, string>> = { highlight: '=', blur: '|', remove: '~' };
const ESCAPABLE = new Set(['\\', '=', '|', '~']);

const isEscape = (s: string, i: number) => s[i] === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1]!);

function unescapeMarkup(s: string): string {
	let out = '';
	for (let i = 0; i < s.length; i++) {
		if (isEscape(s, i)) i++;
		out += s[i];
	}
	return out;
}

/** Appends to `spans`, merging with the previous span when the mark is the same; empty text is dropped. */
function pushSpan(spans: MarkSpan[], text: string, mark: SocialMarkKind) {
	if (!text) return;
	const last = spans[spans.length - 1];
	if (last && last.mark === mark) last.text += text;
	else spans.push({ text, mark });
}

/**
 * Parses markup into visible spans: adjacent spans never share a mark and none is empty. Concatenating the span
 * texts gives the visible text. Linear time: once a marker character has no closing pair ahead, later openers of
 * that character are not searched again.
 */
export function parseMarks(text: string): MarkSpan[] {
	const s = typeof text === 'string' ? text : '';
	const spans: MarkSpan[] = [];
	/** Marker characters with no closing pair at or after the recorded position. */
	const noCloserFrom: Record<string, number> = {};
	let plain = '';
	let i = 0;
	while (i < s.length) {
		if (isEscape(s, i)) {
			plain += s[i + 1];
			i += 2;
			continue;
		}
		const c = s[i]!;
		const mark = MARK_OF_CHAR[c];
		if (mark && s[i + 1] === c && !(noCloserFrom[c] !== undefined && noCloserFrom[c]! <= i + 2)) {
			let close = -1;
			for (let j = i + 2; j < s.length; j++) {
				if (isEscape(s, j)) {
					j++;
					continue;
				}
				if (s[j] === c && s[j + 1] === c) {
					close = j;
					break;
				}
			}
			if (close < 0) noCloserFrom[c] = i + 2;
			else if (close > i + 2) {
				pushSpan(spans, plain, 'none');
				plain = '';
				pushSpan(spans, unescapeMarkup(s.slice(i + 2, close)), mark);
				i = close + 2;
				continue;
			}
		}
		plain += c;
		i++;
	}
	pushSpan(spans, plain, 'none');
	return spans;
}

/**
 * Writes spans back as markup (the inverse of `parseMarks`: `parseMarks(serializeMarks(x))` equals `x` with adjacent
 * same-mark spans merged and empty ones dropped). A marker character is escaped only where it would otherwise pair
 * with the next character, and a backslash only before an escapable character.
 */
export function serializeMarks(spans: readonly MarkSpan[]): string {
	const units: { ch: string; marker: boolean }[] = [];
	const merged: MarkSpan[] = [];
	for (const sp of spans)
		pushSpan(merged, typeof sp?.text === 'string' ? sp.text : '', normalizeKind(sp?.mark));
	for (const sp of merged) {
		const m = sp.mark === 'none' ? '' : CHAR_OF_MARK[sp.mark];
		if (m) units.push({ ch: m, marker: true }, { ch: m, marker: true });
		for (let k = 0; k < sp.text.length; k++) units.push({ ch: sp.text[k]!, marker: false });
		if (m) units.push({ ch: m, marker: true }, { ch: m, marker: true });
	}
	let out = '';
	for (let k = 0; k < units.length; k++) {
		const u = units[k]!;
		const next = units[k + 1]?.ch;
		if (!u.marker && next !== undefined) {
			if ((u.ch === '\\' && ESCAPABLE.has(next)) || (MARK_OF_CHAR[u.ch] && next === u.ch)) out += '\\';
		}
		out += u.ch;
	}
	return out;
}

function normalizeKind(mark: unknown): SocialMarkKind {
	return mark === 'highlight' || mark === 'blur' || mark === 'remove' ? mark : 'none';
}

/** The visible text: markup removed, escapes resolved. */
export function stripMarks(text: string): string {
	let out = '';
	for (const sp of parseMarks(text)) out += sp.text;
	return out;
}

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/u.test(ch);

const clampIndex = (v: unknown, n: number) => {
	const x = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
	return Math.min(n, Math.max(0, x));
};

/**
 * Applies `mark` (or clears marks with `null`) to the words touched by `range` of the visible text and returns the
 * new markup. Like tokcomment, marks apply to whole words (runs of non-whitespace): a range that starts or ends inside
 * a word grows to cover it, a collapsed range marks the word under the caret, and a range of only whitespace changes
 * nothing. Each word carries one mark (a new mark replaces a different one). Whitespace between two words with the
 * same mark joins the mark, so adjacent highlighted words merge into one pill; whitespace next to the changed words
 * whose neighbours differ is left unmarked. The text is returned unchanged when no mark changes.
 */
export function applyMark(text: string, range: MarkRange, mark: SocialMark | null): string {
	const source = typeof text === 'string' ? text : '';
	const spans = parseMarks(source);
	const marks: SocialMarkKind[] = [];
	let visible = '';
	for (const sp of spans) {
		visible += sp.text;
		for (let k = 0; k < sp.text.length; k++) marks.push(sp.mark);
	}
	const n = visible.length;
	let s = clampIndex(range?.start, n);
	let e = clampIndex(range?.end, n);
	if (s > e) [s, e] = [e, s];
	if (s < e) {
		while (s < e && isSpace(visible[s])) s++;
		while (e > s && isSpace(visible[e - 1])) e--;
		if (s === e) return source; // only whitespace selected
	}
	while (s > 0 && !isSpace(visible[s - 1])) s--;
	while (e < n && !isSpace(visible[e])) e++;
	if (s === e) return source; // caret between two whitespace characters or in empty text
	const kind: SocialMarkKind = normalizeKind(mark);
	const next = marks.slice();
	for (let k = s; k < e; k++) next[k] = kind;
	// Whitespace runs bordering the changed words: marked only when the words on both sides share a mark.
	const settleRun = (from: number, to: number) => {
		if (from >= to) return;
		const before = from > 0 ? next[from - 1] : undefined;
		const after = to < n ? next[to] : undefined;
		const joined = before !== undefined && before === after && before !== 'none' ? before : 'none';
		for (let k = from; k < to; k++) next[k] = joined;
	};
	let a = s;
	while (a > 0 && isSpace(visible[a - 1])) a--;
	settleRun(a, s);
	let b = e;
	while (b < n && isSpace(visible[b])) b++;
	settleRun(e, b);
	if (next.every((m, k) => m === marks[k])) return source;
	const out: MarkSpan[] = [];
	for (let k = 0; k < n; k++) pushSpan(out, visible[k]!, next[k]!);
	return serializeMarks(out);
}
