// Editing social-comment text with word marks (design §7.5) without showing the markup: the editor holds the visible
// text, and every edit is mapped back onto the stored markup so marks survive typing. Pure and total.
//
// `replaceVisible(markup, next)` diffs the old and new visible text (longest common prefix and suffix, never splitting
// a surrogate pair). Unchanged characters keep their marks. Inserted characters:
// - a non-space character joins the word it is typed into: the mark of the character before it when that is not a
//   space, else of the character after the insertion when the inserted run reaches it without a space, else (typing
//   over a selection) the mark of the first non-space character it replaced, else none;
// - whitespace is settled like `applyMark` does: a whitespace run touching the edit is marked only when the
//   non-space characters on both sides share the same mark (so a space typed inside a highlighted phrase stays inside
//   the pill, and a trailing space never extends it). Runs elsewhere are left exactly as they were.
import { parseMarks, type SocialMark, type SocialMarkKind, serializeMarks } from '@jasper/mg-templates';

export type MarkedText = { visible: string; marks: SocialMarkKind[] };

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/u.test(ch);
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The visible text of `markup` with one mark per UTF-16 code unit. */
export function decodeMarkup(markup: unknown): MarkedText {
	const marks: SocialMarkKind[] = [];
	let visible = '';
	for (const sp of parseMarks(typeof markup === 'string' ? markup : '')) {
		visible += sp.text;
		for (let k = 0; k < sp.text.length; k++) marks.push(sp.mark);
	}
	return { visible, marks };
}

/** Markup for visible text with per-unit marks (canonical form of `serializeMarks`). */
export function encodeMarks(visible: string, marks: readonly SocialMarkKind[]): string {
	const spans: { text: string; mark: SocialMarkKind }[] = [];
	for (let k = 0; k < visible.length; k++) {
		const mark = marks[k] ?? 'none';
		const last = spans[spans.length - 1];
		if (last && last.mark === mark) last.text += visible[k];
		else spans.push({ text: visible[k]!, mark });
	}
	return serializeMarks(spans);
}

/** Markup whose visible text is `next`, keeping the marks of `markup` (see the module comment). */
export function replaceVisible(markup: unknown, next: string): string {
	const source = typeof markup === 'string' ? markup : '';
	const target = typeof next === 'string' ? next : '';
	const prev = decodeMarkup(source);
	if (prev.visible === target) return source;
	const a = prev.visible;
	const max = Math.min(a.length, target.length);
	let p = 0;
	while (p < max && a.charCodeAt(p) === target.charCodeAt(p)) p++;
	if (p > 0 && p < max && isHigh(a.charCodeAt(p - 1))) p--;
	let q = 0;
	while (q < max - p && a.charCodeAt(a.length - 1 - q) === target.charCodeAt(target.length - 1 - q)) q++;
	if (q > 0 && isLow(target.charCodeAt(target.length - q))) q--;
	const removedFrom = p;
	const removedTo = a.length - q;
	const insEnd = target.length - q;
	const marks: SocialMarkKind[] = [
		...prev.marks.slice(0, p),
		...new Array<SocialMarkKind>(insEnd - p).fill('none'),
		...prev.marks.slice(removedTo),
	];
	let replaced: SocialMarkKind = 'none';
	for (let k = removedFrom; k < removedTo; k++)
		if (!isSpace(a[k])) {
			replaced = prev.marks[k] ?? 'none';
			break;
		}
	// the inserted run reaches the following character without a space from index `k` on
	let reachesRight = insEnd < target.length && !isSpace(target[insEnd]);
	const rightMark = reachesRight ? (marks[insEnd] ?? 'none') : 'none';
	const joinsRight: boolean[] = new Array(insEnd - p).fill(false);
	for (let k = insEnd - 1; k >= p; k--) {
		if (isSpace(target[k])) reachesRight = false;
		joinsRight[k - p] = reachesRight;
	}
	for (let k = p; k < insEnd; k++) {
		if (isSpace(target[k])) continue;
		if (k > 0 && !isSpace(target[k - 1])) marks[k] = marks[k - 1] ?? 'none';
		else if (joinsRight[k - p]) marks[k] = rightMark;
		else marks[k] = replaced;
	}
	// settle whitespace runs inside the insertion and touching its edges
	let from = p;
	while (from > 0 && isSpace(target[from - 1])) from--;
	let to = insEnd;
	while (to < target.length && isSpace(target[to])) to++;
	let k = from;
	while (k < to) {
		if (!isSpace(target[k])) {
			k++;
			continue;
		}
		let end = k;
		while (end < target.length && isSpace(target[end])) end++;
		const before = k > 0 ? marks[k - 1] : undefined;
		const after = end < target.length ? marks[end] : undefined;
		const joined: SocialMarkKind = before !== undefined && before === after ? before : 'none';
		for (let j = k; j < end; j++) marks[j] = joined;
		k = end;
	}
	return encodeMarks(target, marks);
}

/**
 * The words a selection (`start`…`end` of the visible text, either order) marks, grown like `applyMark` does, and the
 * marks they carry now. `range` is null when the selection holds no word (only whitespace, or a caret between
 * spaces).
 */
export function selectionMarks(
	markup: unknown,
	start: number,
	end: number,
): { range: { start: number; end: number } | null; marks: ReadonlySet<SocialMarkKind> } {
	const { visible, marks } = decodeMarkup(markup);
	const n = visible.length;
	const clamp = (v: number) => Math.min(n, Math.max(0, Number.isFinite(v) ? Math.trunc(v) : 0));
	let s = clamp(start);
	let e = clamp(end);
	if (s > e) [s, e] = [e, s];
	if (s < e) {
		while (s < e && isSpace(visible[s])) s++;
		while (e > s && isSpace(visible[e - 1])) e--;
		if (s === e) return { range: null, marks: new Set() };
	}
	while (s > 0 && !isSpace(visible[s - 1])) s--;
	while (e < n && !isSpace(visible[e])) e++;
	if (s === e) return { range: null, marks: new Set() };
	const found = new Set<SocialMarkKind>();
	for (let k = s; k < e; k++) if (!isSpace(visible[k])) found.add(marks[k] ?? 'none');
	return { range: { start: s, end: e }, marks: found };
}

/** Whether every word of the selection already carries `mark` (the mark button shows pressed). */
export function selectionHas(info: { marks: ReadonlySet<SocialMarkKind> }, mark: SocialMark): boolean {
	return info.marks.size === 1 && info.marks.has(mark);
}

let segmenter: Intl.Segmenter | null | undefined;

/** User-perceived characters (grapheme clusters: "👍🏽" and "🇪🇸" count as one). */
export function countGraphemes(text: string): number {
	if (segmenter === undefined) {
		try {
			segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
		} catch {
			segmenter = null;
		}
	}
	if (!segmenter) return Array.from(text).length;
	let n = 0;
	for (const _ of segmenter.segment(text)) n++;
	return n;
}
