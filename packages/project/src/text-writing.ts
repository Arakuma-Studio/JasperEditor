// Vertical writing of text clips (spec 19 TL-111, docs/wp-notes/title-looks.md "Text"): which text is set vertically
// and which short runs stand upright across a column (tate-chu-yoko). The browser shapes everything (`writing-mode:
// vertical-rl`, `vert` glyphs, `text-combine-upright`); this file only decides what the renderers and the in-place
// editor ask it for, so they all cut the text in the same places.
import type { TextContent } from './schema/sequence.ts';

export const TEXT_WRITING_MODES = ['horizontal', 'vertical'] as const;
export type TextWritingMode = (typeof TEXT_WRITING_MODES)[number];

/** Longest run set upright across a column (spec 19 TL-111). */
export const MAX_TATE_CHU_YOKO = 3;

type WritingFields = Pick<TextContent, 'writingMode' | 'tateChuYoko'>;

/** Whether the text is set in right-to-left columns. An unreadable value reads as horizontal. */
export function isVerticalText(c: Pick<TextContent, 'writingMode'> | null | undefined): boolean {
	return c?.writingMode === 'vertical';
}

/** Half-width characters a column would otherwise turn on their side (ASCII graphic characters). */
const HALF_WIDTH = /[!-~]/;
/** A space next to a run makes it part of Latin text, not a short insert in a column. */
const SPACE = /\s/u;

export type TextRange = { from: number; to: number };

/** What is wrong with the writing fields of a stored text content (they are read leniently). */
export function textWritingIssues(content: unknown): string[] {
	if (!content || typeof content !== 'object') return [];
	const c = content as { writingMode?: unknown; tateChuYoko?: unknown; runs?: unknown };
	const out: string[] = [];
	if (c.writingMode !== undefined && !(TEXT_WRITING_MODES as readonly unknown[]).includes(c.writingMode))
		out.push('writing mode must be horizontal or vertical');
	if (c.tateChuYoko !== undefined && typeof c.tateChuYoko !== 'boolean')
		out.push('tate-chu-yoko must be a boolean');
	if (Array.isArray(c.runs))
		for (const r of c.runs) {
			const finish = (r as { finish?: unknown } | null)?.finish;
			if (finish !== undefined && typeof finish !== 'string') out.push('a run finish must be a finish id');
		}
	return out;
}

/** Removes unreadable writing fields of a stored text content in place; returns what changed. */
export function repairTextWriting(content: unknown): string[] {
	if (!content || typeof content !== 'object') return [];
	const c = content as { writingMode?: unknown; tateChuYoko?: unknown; runs?: unknown };
	const out: string[] = [];
	if (c.writingMode !== undefined && !(TEXT_WRITING_MODES as readonly unknown[]).includes(c.writingMode)) {
		delete c.writingMode;
		out.push('unreadable writing mode removed (horizontal)');
	}
	if (c.tateChuYoko !== undefined && typeof c.tateChuYoko !== 'boolean') {
		delete c.tateChuYoko;
		out.push('unreadable tate-chu-yoko removed (on)');
	}
	if (Array.isArray(c.runs))
		for (const r of c.runs as { finish?: unknown }[])
			if (r && typeof r === 'object' && r.finish !== undefined && typeof r.finish !== 'string') {
				delete r.finish;
				out.push('unreadable run finish removed');
			}
	return out;
}

/** The stored text contents of a clip: its content and every Source Text key. */
export function clipTextContents(c: {
	kind: string;
	content?: unknown;
	sourceTextKeyframes?: unknown;
}): unknown[] {
	if (c.kind !== 'text') return [];
	const keys = Array.isArray(c.sourceTextKeyframes) ? c.sourceTextKeyframes : [];
	return [c.content, ...keys.map((k) => (k as { value?: unknown } | null)?.value)];
}

/**
 * The ranges (UTF-16 offsets, sorted, disjoint) of `content` set upright across the column: maximal runs of 1 to
 * `MAX_TATE_CHU_YOKO` half-width characters with a character of another kind or a paragraph edge on both sides, so
 * "12月" and a lone "OK" stand upright, while the words of a Latin phrase and "2026年" stay on their side. Empty for
 * horizontal text and when `tateChuYoko` is false.
 */
export function tateChuYokoRanges(c: WritingFields & Pick<TextContent, 'text'>): TextRange[] {
	if (!isVerticalText(c) || c.tateChuYoko === false) return [];
	const { text } = c;
	const out: TextRange[] = [];
	const edge = (ch: string) => ch === '\n' || ch === '\r' || !SPACE.test(ch);
	let i = 0;
	while (i < text.length) {
		if (!HALF_WIDTH.test(text[i]!)) {
			i++;
			continue;
		}
		let end = i + 1;
		while (end < text.length && HALF_WIDTH.test(text[end]!)) end++;
		const before = i > 0 ? text[i - 1]! : '\n';
		const after = end < text.length ? text[end]! : '\n';
		if (end - i <= MAX_TATE_CHU_YOKO && edge(before) && edge(after)) out.push({ from: i, to: end });
		i = end;
	}
	return out;
}
