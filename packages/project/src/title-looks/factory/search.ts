// Spec 19 TL-086 / TL-100: search over the library. Folding makes accents, width and kana irrelevant: "neón" finds "neon",
// "ﾈｵﾝ", "ネオン" and "ねおん" are one word. Results are deterministic: score, then library order.
import type { FactoryLook } from './build.ts';
import { lookCategory } from './categories.ts';

/** Text folded for matching: NFKC (widths), lower case, no Latin accents, katakana as hiragana. */
export function foldSearchText(s: string): string {
	const out = s.normalize('NFKC').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
	let folded = '';
	for (const ch of out) {
		const c = ch.codePointAt(0)!;
		folded += c >= 0x30a1 && c <= 0x30f6 ? String.fromCodePoint(c - 0x60) : ch;
	}
	return folded;
}

export type LookSearchEntry = {
	/** Folded name, English and Spanish. */
	names: readonly string[];
	/** Folded tags, the category's among them. */
	tags: readonly string[];
	/** Everything folded, joined. */
	text: string;
};

const cache = new WeakMap<object, LookSearchEntry>();

/** The search metadata of a look, cached per look. */
export function lookSearchEntry(l: FactoryLook): LookSearchEntry {
	const hit = cache.get(l);
	if (hit) return hit;
	const cat = lookCategory(l.category);
	const names = [l.name, l.nameEs].map(foldSearchText);
	const tags = [...l.tags, ...(cat ? [cat.label, cat.labelEs, ...cat.tags] : [])].map(foldSearchText);
	const entry = { names, tags, text: [...names, ...tags, foldSearchText(l.description)].join(' ') };
	cache.set(l, entry);
	return entry;
}

function scoreOf(e: LookSearchEntry, words: readonly string[]): number {
	let score = 0;
	for (const w of words) {
		if (!e.text.includes(w)) return 0;
		if (e.names.includes(w)) score += 100;
		else if (e.names.some((n) => n.startsWith(w))) score += 60;
		else if (e.names.some((n) => n.includes(w))) score += 40;
		else if (e.tags.includes(w)) score += 30;
		else if (e.tags.some((t) => t.startsWith(w))) score += 20;
		else score += 10;
	}
	return score;
}

export type LookQuery = {
	/** Words, all of which must match. Empty: every look, in library order. */
	query?: string;
	category?: string;
	/** Every one of these must be a tag (folded). */
	tags?: readonly string[];
};

/** Looks matching a query, best first. */
export function searchLooks<L extends FactoryLook>(looks: readonly L[], q: LookQuery = {}): L[] {
	const words = foldSearchText(q.query ?? '')
		.split(/\s+/)
		.filter(Boolean);
	const wanted = (q.tags ?? []).map(foldSearchText);
	const scored: { look: L; score: number; order: number }[] = [];
	looks.forEach((look, order) => {
		if (q.category && look.category !== q.category) return;
		const e = lookSearchEntry(look);
		if (!wanted.every((t) => e.tags.includes(t))) return;
		const score = words.length ? scoreOf(e, words) : 1;
		if (score > 0) scored.push({ look, score, order });
	});
	return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.look);
}
