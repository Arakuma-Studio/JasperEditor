// Spec 17 SC-051: in-place text edits of a subtitle text clip that keep its styled runs, paragraph settings and
// manual line breaks — splices of word regions (run boundaries inside a replaced region follow the words that replace
// them), and the re-break of only the lines that now break the group's rules. Pure; `transcript.replaceWords`
// (captions/replace-words.ts) plans and applies them.
import type { TextContent } from '../../schema/sequence.ts';
import { breakLines } from './text.ts';

/**
 * One replacement in a text: `[from, to)` becomes `text`. `oldWords` / `newWords` are the word offsets inside the old
 * region (absolute) and inside `text` (relative): with as many words on both sides, a run boundary inside old word k
 * moves to the same relative place in new word k; otherwise boundaries move proportionally over the region.
 */
export type TextSplice = {
	from: number;
	to: number;
	text: string;
	oldWords?: ReadonlyArray<readonly [number, number]>;
	newWords?: ReadonlyArray<readonly [number, number]>;
};

const newlines = (s: string) => {
	let n = 0;
	for (const ch of s) if (ch === '\n') n++;
	return n;
};

/** Where an old offset lands after one splice (`side`: a run's start moves past an insertion, its end does not). */
function mapOffset(p: number, sp: TextSplice, side: 'start' | 'end'): number {
	const oldLen = sp.to - sp.from;
	const newLen = sp.text.length;
	const delta = newLen - oldLen;
	if (p < sp.from) return p;
	if (p > sp.to) return p + delta;
	if (oldLen === 0) return side === 'start' ? p + delta : p;
	if (p === sp.from) return sp.from;
	if (p === sp.to) return sp.from + newLen;
	const ow = sp.oldWords ?? [];
	const nw = sp.newWords ?? [];
	if (ow.length > 0 && ow.length === nw.length) {
		for (let k = 0; k < ow.length; k++) {
			const [a, b] = ow[k]!;
			const [c, d] = nw[k]!;
			if (p >= a && p <= b) {
				const frac = b > a ? (p - a) / (b - a) : 0;
				return sp.from + c + Math.round(frac * (d - c));
			}
			const next = ow[k + 1];
			if (next && p > b && p < next[0]) {
				// inside the separator after word k: the separator is kept as is with as many words
				const off = Math.min(p - b, nw[k + 1]![0] - d);
				return sp.from + d + off;
			}
		}
	}
	return sp.from + Math.round(((p - sp.from) * newLen) / oldLen);
}

/**
 * Applies non-overlapping splices to a text content: the text, its runs (boundaries mapped; runs left empty dropped)
 * and its paragraph settings (by line index: lines merged away drop their entry, later lines are renumbered). The
 * input is not changed.
 */
export function spliceContent(content: TextContent, splices: readonly TextSplice[]): TextContent {
	const order = [...splices].sort((a, b) => b.from - a.from || b.to - a.to);
	let text = content.text;
	let runs = content.runs?.map((r) => ({ ...r }));
	let paragraphs = content.paragraphs?.map((p) => ({ ...p }));
	for (const sp of order) {
		const from = Math.max(0, Math.min(sp.from, text.length));
		const to = Math.max(from, Math.min(sp.to, text.length));
		const s: TextSplice = { ...sp, from, to };
		const line0 = newlines(text.slice(0, from));
		const kOld = newlines(text.slice(from, to));
		const kNew = newlines(s.text);
		text = text.slice(0, from) + s.text + text.slice(to);
		if (runs)
			runs = runs
				.map((r) => ({ ...r, from: mapOffset(r.from, s, 'start'), to: mapOffset(r.to, s, 'end') }))
				.filter((r) => r.to > r.from);
		if (paragraphs && kOld !== kNew) {
			// a line broken in two continues its paragraph: the new lines take the settings of the line they came from
			const split = paragraphs.find((p) => p.index === line0 + kOld);
			paragraphs = paragraphs
				.filter((p) => p.index <= line0 + kNew || p.index > line0 + kOld)
				.map((p) => (p.index > line0 + kOld ? { ...p, index: p.index + kNew - kOld } : p));
			if (split && kNew > kOld)
				for (let i = line0 + kOld + 1; i <= line0 + kNew; i++)
					paragraphs.push({ ...split, style: { ...split.style }, index: i });
			paragraphs.sort((x, y) => x.index - y.index);
		}
	}
	const out: TextContent = { ...content, text };
	if (runs?.length) out.runs = runs;
	else delete out.runs;
	if (paragraphs?.length) out.paragraphs = paragraphs;
	else delete out.paragraphs;
	return out;
}

/** The whitespace-separated tokens of a text with their offsets, and the separators between them. */
export function textTokens(text: string): { tokens: Array<[number, number, string]> } {
	const tokens: Array<[number, number, string]> = [];
	const re = /\S+/g;
	for (let m = re.exec(text); m; m = re.exec(text)) tokens.push([m.index, m.index + m[0].length, m[0]]);
	return { tokens };
}

const chars = (s: string) => [...s].length;

/**
 * Re-breaks only the lines of a subtitle text that now break the rules (spec 17 SC-051): a line longer than `maxChars`
 * with more than one word is broken with `breakLines` (weak words kept with what follows); the other line breaks —
 * manual ones included — stay. When that makes more than `maxLines` lines, the whole text is broken like a generated
 * subtitle. Returns the separator splices (space ↔ line break), empty when every line keeps the rules.
 */
export function rebreakSplices(
	text: string,
	maxChars: number,
	maxLines: number,
	weak: ReadonlySet<string> | null,
): TextSplice[] {
	const { tokens } = textTokens(text);
	if (tokens.length < 2) return [];
	// separators between tokens k-1 and k (k ≥ 1), and the lines they make
	const seps = tokens.slice(1).map((t, i) => [tokens[i]![1], t[0]] as const);
	const isBreak = seps.map(([a, b]) => text.slice(a, b).includes('\n'));
	const lines: Array<[number, number]> = []; // token index ranges [a, b)
	let a = 0;
	isBreak.forEach((brk, i) => {
		if (brk) {
			lines.push([a, i + 1]);
			a = i + 1;
		}
	});
	lines.push([a, tokens.length]);
	const lineLen = ([x, y]: [number, number]) =>
		tokens.slice(x, y).reduce((n, t, i) => n + chars(t[2]) + (i ? 1 : 0), 0);
	const next = [...isBreak];
	let changed = false;
	for (const ln of lines) {
		if (ln[1] - ln[0] < 2 || lineLen(ln) <= maxChars) continue;
		const words = tokens.slice(ln[0], ln[1]).map((t) => t[2]);
		for (const s of breakLines(words, maxChars, Number.POSITIVE_INFINITY, weak)) next[ln[0] + s - 1] = true;
		changed = true;
	}
	if (!changed) return [];
	if (next.filter(Boolean).length + 1 > maxLines) {
		const starts = new Set(
			breakLines(
				tokens.map((t) => t[2]),
				maxChars,
				maxLines,
				weak,
			),
		);
		for (let i = 0; i < next.length; i++) next[i] = starts.has(i + 1);
	}
	const out: TextSplice[] = [];
	seps.forEach(([x, y], i) => {
		if (next[i] === isBreak[i]) return;
		out.push({ from: x, to: y, text: next[i] ? '\n' : ' ' });
	});
	return out;
}
