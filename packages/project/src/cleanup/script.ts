// Script alignment (spec 14 TC-012): a plain-text script attached to a sequence is split into lines (sentences);
// each speech unit is matched to the line whose content words it repeats best (LCS, the measure of the prototype's
// retake rule and of `classify.py local_best`). Retake groups get the line they say; lines never said are reported.
// Pure.
import { cleanupNorm } from './lists.ts';
import { lcs } from './rules.ts';

export type ScriptLine = {
	index: number;
	text: string;
	/** Normalised tokens (all words). */
	tokens: string[];
	/** Content words (no stop words, ≥ 3 letters). */
	content: string[];
};

/** Most lines read from a script (256 KB of text is at most ≈ 50 000 short lines). */
const MAX_LINES = 50_000;

/**
 * Lines of a script: sentences ending in `.`, `?`, `!` or `…`, and line breaks; headings and blank lines without
 * words are skipped. Every token of the script also counts for the off-script vocabulary (`scriptTokens`).
 */
export function scriptLines(text: string, stop: ReadonlySet<string>): ScriptLine[] {
	const out: ScriptLine[] = [];
	const parts = text.replace(/\r\n?/g, '\n').split(/(?<=[.?!…])\s+|\n+/u);
	for (const raw of parts) {
		if (out.length >= MAX_LINES) break;
		const t = raw.trim();
		if (!t) continue;
		const tokens = t
			.split(/\s+/)
			.map(cleanupNorm)
			.filter((x) => x.length > 0);
		if (!tokens.length) continue;
		out.push({
			index: out.length,
			text: t,
			tokens,
			content: tokens.filter((x) => !stop.has(x) && x.length >= 3),
		});
	}
	return out;
}

/** Every normalised token of the script (prototype: `norm(x) for x in text.split()`, empties dropped). */
export function scriptTokens(text: string): string[] {
	return text
		.split(/\s+/)
		.map(cleanupNorm)
		.filter((x) => x.length > 0);
}

export type LineMatch = { line: number; similarity: number; coverage: number };

/**
 * The script line a unit says: the line maximising the share of the unit's content words found in order in the
 * line (LCS / unit content), ties to the larger coverage of the line (LCS / line content). Null when the best share
 * is below `minSimilarity` or the unit has no content words. Candidate lines are those sharing a content word with
 * the unit (an index keeps this linear in practice).
 */
export class ScriptIndex {
	private readonly byWord = new Map<string, number[]>();
	constructor(readonly lines: readonly ScriptLine[]) {
		for (const l of lines)
			for (const w of new Set(l.content)) {
				const list = this.byWord.get(w);
				if (list) list.push(l.index);
				else this.byWord.set(w, [l.index]);
			}
	}

	match(unitContent: readonly string[], minSimilarity: number): LineMatch | null {
		if (!unitContent.length) return null;
		const cand = new Set<number>();
		for (const w of unitContent) for (const i of this.byWord.get(w) ?? []) cand.add(i);
		let best: LineMatch | null = null;
		for (const i of [...cand].sort((a, b) => a - b)) {
			const line = this.lines[i]!;
			const common = lcs(unitContent, line.content);
			const similarity = common / unitContent.length;
			const coverage = line.content.length ? common / line.content.length : 0;
			if (
				!best ||
				similarity > best.similarity + 1e-12 ||
				(Math.abs(similarity - best.similarity) <= 1e-12 && coverage > best.coverage + 1e-12)
			)
				best = { line: i, similarity, coverage };
		}
		return best && best.similarity >= minSimilarity ? best : null;
	}
}
