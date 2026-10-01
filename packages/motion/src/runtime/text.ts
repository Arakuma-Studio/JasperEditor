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

/** Grapheme approximation for engines without Intl.Segmenter. */
const GRAPHEME_APPROX =
	/\r\n|\p{Regional_Indicator}{2}|.(?:\p{M}|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}]|\u200D.)*/gsu;

type RawSegment = { segment: string; isWordLike?: boolean };

function rawSegments(text: string, granularity: 'grapheme' | 'word', locale?: string): RawSegment[] {
	const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
	if (Segmenter) return [...new Segmenter(locale, { granularity }).segment(text)];
	// Fallback without Intl.Segmenter: approximate clusters (a base with its marks, emoji modifier and ZWJ
	// sequences, flag pairs, CR LF) / whitespace-separated runs.
	if (granularity === 'grapheme') return (text.match(GRAPHEME_APPROX) ?? []).map((segment) => ({ segment }));
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
 * Text whose glyphs change shape with their neighbours or that runs right-to-left: per-character spans would break
 * shaping/bidi, so `char` units fall back to `word` (S11:TXA-010). Matches
 * - every right-to-left character (Hebrew, Arabic, Syriac, Thaana, N'Ko, Samaritan, Mandaic, Adlam, Hanifi Rohingya,
 *   historic RTL scripts…: the RTL blocks U+0590–U+08FF, U+FB1D–U+FDFF, U+FE70–U+FEFF, U+10800–U+10FFF,
 *   U+1E800–U+1EFFF) and the bidi controls (U+200E/F, U+202A–U+202E, U+2066–U+2069);
 * - the scripts that shape clusters or join letters: Brahmic/Indic, South-East Asian, Tibetan, Mongolian…;
 * - joiners (ZWJ/ZWNJ outside emoji sequences matter for Indic and Persian shaping).
 * Script names are limited to Unicode ≤ 13 so the pattern compiles in every supported engine.
 */
const NEEDS_SHAPING = new RegExp(
	[
		'[\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFF\\u{10800}-\\u{10FFF}\\u{1E800}-\\u{1EFFF}]',
		'[\\u200C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]',
		'\\u200D(?!\\p{Extended_Pictographic})',
		...[
			'Devanagari',
			'Bengali',
			'Gurmukhi',
			'Gujarati',
			'Oriya',
			'Tamil',
			'Telugu',
			'Kannada',
			'Malayalam',
			'Sinhala',
			'Thai',
			'Lao',
			'Tibetan',
			'Myanmar',
			'Khmer',
			'Mongolian',
			'Javanese',
			'Balinese',
			'Sundanese',
			'Batak',
			'Buginese',
			'Makasar',
			'Lepcha',
			'Limbu',
			'Tai_Le',
			'New_Tai_Lue',
			'Tai_Tham',
			'Tai_Viet',
			'Cham',
			'Kayah_Li',
			'Rejang',
			'Saurashtra',
			'Syloti_Nagri',
			'Phags_Pa',
			'Meetei_Mayek',
			'Chakma',
			'Brahmi',
			'Kaithi',
			'Sharada',
			'Grantha',
			'Tirhuta',
			'Newa',
			'Modi',
			'Takri',
			'Ahom',
			'Dogra',
			'Siddham',
			'Khojki',
			'Khudawadi',
			'Mahajani',
			'Multani',
			'Bhaiksuki',
			'Marchen',
			'Masaram_Gondi',
			'Gunjala_Gondi',
			'Soyombo',
			'Zanabazar_Square',
			'Nandinagari',
			'Dives_Akuru',
			'Tagalog',
			'Hanunoo',
			'Buhid',
			'Tagbanwa',
		].map((script) => `\\p{Script=${script}}`),
	].join('|'),
	'u',
);

export function needsShaping(text: string): boolean {
	return NEEDS_SHAPING.test(text);
}

/** Top of an element's layout box in page space: the offsetTop chain (ignores CSS transforms, R-ANM §2). */
function layoutTop(el: HTMLElement): number {
	let y = 0;
	for (let n: HTMLElement | null = el; n && 'offsetTop' in n; n = n.offsetParent as HTMLElement | null)
		y += n.offsetTop;
	return y;
}

/**
 * Line index of every element matching `selector` inside `container`, in document order, from layout boxes
 * (`offsetTop`/`offsetHeight` summed along the offset-parent chain, so units nested in positioned wrappers, e.g.
 * per-line masks, compare in one space; ancestor transforms — rotation, flip, corner pin, monitor zoom — are
 * ignored). An element starts a new line when its vertical centre lies below the bottom of the current line
 * (robust to mixed font sizes on one line and to line-height < 1). Call it after layout, on a displayed
 * container (`display: none` has no layout boxes: everything lands on line 0).
 */
export function groupLines(container: HTMLElement, selector: string): number[] {
	const out: number[] = [];
	const origin = layoutTop(container);
	let line = -1;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const el of container.querySelectorAll<HTMLElement>(selector)) {
		const top = layoutTop(el) - origin;
		const height = el.offsetHeight;
		if (line < 0 || top + height / 2 > bottom) {
			line++;
			bottom = top + height;
		} else bottom = Math.max(bottom, top + height);
		out.push(line);
	}
	return out;
}
