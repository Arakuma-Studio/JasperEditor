// Fuzzy matching for the command palette (S05:MN-041, PERF-005: < 30 ms for 5k entries). Subsequence
// match, scored by consecutive runs, word starts and early matches; null = no match.

export function fuzzyScore(query: string, text: string): number | null {
	const q = query.trim().toLowerCase();
	if (!q) return 0;
	const t = text.toLowerCase();
	const direct = t.indexOf(q);
	if (direct >= 0)
		return (
			1000 - direct * 2 + (direct === 0 || /[\s._:/-]/.test(t[direct - 1] ?? '') ? 200 : 0) - t.length * 0.1
		);
	let score = 0;
	let ti = 0;
	let run = 0;
	for (const ch of q) {
		if (ch === ' ') continue;
		const found = t.indexOf(ch, ti);
		if (found < 0) return null;
		const wordStart =
			found === 0 ||
			/[\s._:/-]/.test(t[found - 1] ?? '') ||
			(text[found] ?? '') !== (text[found] ?? '').toLowerCase();
		run = found === ti ? run + 1 : 0;
		score += 10 + run * 8 + (wordStart ? 15 : 0) - Math.min(20, found - ti);
		ti = found + 1;
	}
	return score - t.length * 0.1;
}

/** Rows kept together by group, best row first in each, and the group with the best row first. */
export function rankByGroup<T extends { group: string; score: number }>(rows: readonly T[]): T[] {
	const groups = new Map<string, T[]>();
	for (const r of [...rows].sort((a, b) => b.score - a.score)) {
		const g = groups.get(r.group);
		if (g) g.push(r);
		else groups.set(r.group, [r]);
	}
	return [...groups.values()].flat();
}

export type PalettePrefix = '>' | '@' | ':' | '#' | '?' | null;

/** Splits a palette query into its prefix (MN-042) and the remaining text. */
export function parsePaletteQuery(raw: string): { prefix: PalettePrefix; text: string } {
	const s = raw.trimStart();
	const p = s[0];
	if (p === '>' || p === '@' || p === ':' || p === '#' || p === '?')
		return { prefix: p, text: s.slice(1).trim() };
	return { prefix: null, text: s.trim() };
}
