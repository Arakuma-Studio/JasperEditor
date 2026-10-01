// Text units for animators (S11:TXA-010/011, R-ANM §2): segmentation with Intl.Segmenter (anime.js `splitText`
// is banned: it rewrites React-owned DOM and measures with getBoundingClientRect), and line grouping by layout
// boxes (`offsetTop`/`offsetHeight`, unaffected by ancestor transforms).

export type TextUnit = 'char' | 'word' | 'line';

/**
 * One piece of the text, in order; concatenating `text` gives the input back. Whitespace runs are separate
 * segments with `space: true` and `unitIndex: -1` (kept as text, never animated); other segments are units
 * numbered from 0.
 */
export type TextSegment = { text: string; unitIndex: number; space: boolean };

const WHITESPACE = /^\s+$/u;

type RawSegment = { segment: string; isWordLike?: boolean };

function rawSegments(text: string, granularity: 'grapheme' | 'word', locale?: string): RawSegment[] {
	const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
	if (Segmenter) return [...new Segmenter(locale, { granularity }).segment(text)];
	// Fallback without Intl.Segmenter: code points / whitespace-separated runs.
	if (granularity === 'grapheme') return Array.from(text, (segment) => ({ segment }));
	return (text.match(/\s+|\S+/gu) ?? []).map((segment) => ({ segment, isWordLike: true }));
}

/**
 * Splits `text` into graphemes (`char`) or words (`word`) with Intl.Segmenter. Words keep adjacent punctuation
 * (`"Hello,"`, `"(hi)"`); scripts without spaces (CJK, Thai) split at dictionary word boundaries. Whitespace runs
 * become non-animated space segments.
 */
export function segmentText(text: string, unit: 'char' | 'word', locale?: string): TextSegment[] {
	const out: TextSegment[] = [];
	let units = 0;
	// Word mode: the non-space segments between two whitespace runs, split at word boundaries; punctuation joins
	// the previous word of the run (or the next one at the run's start).
	let run: string[] = [];
	let prefix = '';
	const flush = () => {
		if (prefix) {
			if (run.length) run[run.length - 1] += prefix;
			else run.push(prefix);
		}
		for (const t of run) out.push({ text: t, unitIndex: units++, space: false });
		run = [];
		prefix = '';
	};
	for (const s of rawSegments(text, unit === 'char' ? 'grapheme' : 'word', locale)) {
		if (WHITESPACE.test(s.segment)) {
			flush();
			const last = out[out.length - 1];
			if (last?.space) last.text += s.segment;
			else out.push({ text: s.segment, unitIndex: -1, space: true });
		} else if (unit === 'char') out.push({ text: s.segment, unitIndex: units++, space: false });
		else if (s.isWordLike === false) {
			if (run.length) run[run.length - 1] += s.segment;
			else prefix += s.segment;
		} else {
			run.push(prefix + s.segment);
			prefix = '';
		}
	}
	flush();
	return out;
}

/**
 * Scripts whose glyphs change shape with their neighbours or that run right-to-left: per-character spans would
 * break shaping/bidi, so `char` units fall back to `word` (S11:TXA-010).
 */
const NEEDS_SHAPING =
	/[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Mongolian}\p{Script=Javanese}\p{Script=Balinese}]/u;

export function needsShaping(text: string): boolean {
	return NEEDS_SHAPING.test(text);
}

/**
 * Line index of every element matching `selector` inside `container`, in document order, from layout boxes: an
 * element starts a new line when its vertical centre lies below the bottom of the current line (robust to mixed
 * font sizes on one line and to line-height < 1).
 */
export function groupLines(container: HTMLElement, selector: string): number[] {
	const out: number[] = [];
	let line = -1;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const el of container.querySelectorAll<HTMLElement>(selector)) {
		const top = el.offsetTop;
		const height = el.offsetHeight;
		if (line < 0 || top + height / 2 > bottom) {
			line++;
			bottom = top + height;
		} else bottom = Math.max(bottom, top + height);
		out.push(line);
	}
	return out;
}
