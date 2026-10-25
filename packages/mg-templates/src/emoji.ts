// Emoji in templates (social-comment design §7.8): text is split into plain runs and emoji graphemes, and every emoji
// grapheme is drawn as an image of the selected pack, so rendering never depends on the host's emoji font. Pure:
// shared by the templates (`@jasper/motion`), the render snapshot's asset requirements and the engine's asset
// service (codepoint keys of the cached images and of the pack URLs).
//
// Grapheme clusters come from `segmentText` (Intl.Segmenter, Unicode extended grapheme clusters), so ZWJ sequences,
// skin-tone modifiers, flags (regional-indicator pairs and tag sequences), keycaps and VS16 forms are one unit each.
import { segmentText } from './text-units.ts';

/** Emoji image packs a template may draw with (data of each pack: the engine's remote-asset manifest). */
export const EMOJI_PACK_IDS = ['apple', 'twemoji', 'noto'] as const;
export type EmojiPackId = (typeof EMOJI_PACK_IDS)[number];

export function isEmojiPackId(v: unknown): v is EmojiPackId {
	return typeof v === 'string' && (EMOJI_PACK_IDS as readonly string[]).includes(v);
}

export type EmojiPiece = { kind: 'text'; text: string } | { kind: 'emoji'; grapheme: string };

/** Longest emoji grapheme accepted, in code points (the longest RGI sequences have 10; tag flags 7). */
export const MAX_EMOJI_CODEPOINTS = 16;

const VS15 = '︎';
const VS16 = '️';
const ZWJ = '‍';
const KEYCAP = /^[0-9#*]️?⃣$/u;
const REGIONAL = /^\p{Regional_Indicator}+$/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const MODIFIER = /\p{Emoji_Modifier}/u;
const TAG = /[\u{E0020}-\u{E007F}]/u;
const PRESENTATION_FIRST = /^\p{Emoji_Presentation}/u;

/**
 * Whether a grapheme cluster is drawn as an emoji (emoji presentation, UTS #51):
 * - keycaps (`#️⃣`, `1⃣`), regional-indicator flags (and a lone indicator), tag-sequence flags;
 * - pictographs with VS16, a ZWJ sequence or a skin-tone modifier; a lone skin-tone swatch;
 * - pictographs whose first code point defaults to emoji presentation (`😀`).
 * Text-presentation pictographs (`©`, `™`, `☺` without VS16) and anything with VS15 stay text.
 */
export function isEmojiGrapheme(g: string): boolean {
	if (!g || [...g].length > MAX_EMOJI_CODEPOINTS) return false;
	if (KEYCAP.test(g)) return true;
	if (g.includes(VS15)) return false;
	if (REGIONAL.test(g)) return true;
	if (MODIFIER.test(g) && [...g].length === 1) return true;
	if (!PICTOGRAPHIC.test(g)) return false;
	if (g.includes(VS16) || g.includes(ZWJ) || MODIFIER.test(g) || TAG.test(g)) return true;
	return PRESENTATION_FIRST.test(g);
}

/**
 * Splits text into plain runs and emoji graphemes, in order; concatenating the pieces (`text` / `grapheme`) gives
 * the input back. Adjacent plain graphemes (whitespace included) are merged into one text piece.
 */
export function splitEmoji(text: string): EmojiPiece[] {
	const out: EmojiPiece[] = [];
	let run = '';
	for (const s of segmentText(text, 'char')) {
		if (!s.space && isEmojiGrapheme(s.text)) {
			if (run) out.push({ kind: 'text', text: run });
			run = '';
			out.push({ kind: 'emoji', grapheme: s.text });
		} else run += s.text;
	}
	if (run) out.push({ kind: 'text', text: run });
	return out;
}

/** The distinct emoji graphemes of a text, in first-appearance order (at most `limit`). */
export function emojiGraphemes(text: string, limit = Number.POSITIVE_INFINITY): string[] {
	const seen = new Set<string>();
	for (const p of splitEmoji(text)) {
		if (seen.size >= limit) break;
		if (p.kind === 'emoji') seen.add(p.grapheme);
	}
	return [...seen];
}

/** How a pack names U+FE0F in its file names (`try-both`: with it first, then without). */
export type EmojiFe0fRule = 'keep' | 'strip' | 'try-both';

export type CodepointKeyOptions = {
	/** Drop every U+FE0F. Default false. */
	stripFe0f?: boolean;
	/** Separator between code points. Default "-". */
	join?: string;
	/** Minimum hex digits (zero-padded). Default 1 (no padding). */
	minDigits?: number;
};

/** The code points of a grapheme as lower-case hex joined by "-" (`1f44d-1f3fd`), per the options. */
export function emojiCodepointKey(grapheme: string, o: CodepointKeyOptions = {}): string {
	const join = o.join ?? '-';
	const digits = Math.max(1, Math.min(8, Math.floor(o.minDigits ?? 1)));
	const cps: string[] = [];
	for (const ch of grapheme) {
		const cp = ch.codePointAt(0)!;
		if (o.stripFe0f && cp === 0xfe0f) continue;
		cps.push(cp.toString(16).padStart(digits, '0'));
	}
	return cps.join(join);
}

/** The `{cp}` values to try for a grapheme under a pack's U+FE0F rule (distinct, in order). */
export function emojiCodepointCandidates(
	grapheme: string,
	rule: EmojiFe0fRule,
	o: Omit<CodepointKeyOptions, 'stripFe0f'> = {},
): string[] {
	const keep = emojiCodepointKey(grapheme, o);
	const strip = emojiCodepointKey(grapheme, { ...o, stripFe0f: true });
	if (rule === 'keep') return [keep];
	if (rule === 'strip') return [strip];
	return keep === strip ? [keep] : [keep, strip];
}

/** Canonical key of a grapheme (every code point, "-" joined): the cache and route name of its image. */
export function emojiKey(grapheme: string): string {
	return emojiCodepointKey(grapheme);
}

/**
 * The grapheme of a canonical key, or null when the key is malformed or does not name one emoji grapheme
 * (validates route input before anything is fetched).
 */
export function graphemeOfEmojiKey(key: string): string | null {
	if (typeof key !== 'string' || key.length > MAX_EMOJI_CODEPOINTS * 7) return null;
	if (!/^[0-9a-f]{1,6}(?:-[0-9a-f]{1,6})*$/.test(key)) return null;
	const parts = key.split('-');
	if (parts.length > MAX_EMOJI_CODEPOINTS) return null;
	let s = '';
	for (const p of parts) {
		const cp = Number.parseInt(p, 16);
		if (!Number.isInteger(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
		s += String.fromCodePoint(cp);
	}
	// One grapheme, and the key is its canonical form (no leading zeros or other spellings).
	const segs = segmentText(s, 'char');
	if (segs.length !== 1 || segs[0]!.space) return null;
	if (emojiKey(s) !== key || !isEmojiGrapheme(s)) return null;
	return s;
}
