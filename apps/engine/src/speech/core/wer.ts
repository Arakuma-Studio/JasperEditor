// Word error rate (as FilmCraft's `word_error_rate`): words compared case-insensitively without punctuation, split
// at whitespace and hyphens; (substitutions + deletions + insertions) / reference words.

/** Lower-case, letters/digits/apostrophes inside the word only. */
export function normalizeWord(w: string): string {
	return w
		.toLowerCase()
		.normalize('NFKC')
		.replace(/[’‘]/g, "'")
		.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

export function wordErrorRate(reference: string, hypothesis: string): number {
	const norm = (s: string) =>
		s
			.split(/[\s-]+/)
			.map(normalizeWord)
			.filter((w) => w.length > 0);
	const r = norm(reference);
	const h = norm(hypothesis);
	if (!r.length) return h.length ? 1 : 0;
	let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
	for (let i = 1; i <= r.length; i++) {
		const cur = new Array<number>(h.length + 1).fill(i);
		for (let j = 1; j <= h.length; j++) {
			const sub = prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1);
			cur[j] = Math.min(sub, prev[j] + 1, cur[j - 1] + 1);
		}
		prev = cur;
	}
	return prev[h.length] / r.length;
}
