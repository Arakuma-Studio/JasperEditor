// Spec 19 TL-053: which face a look gives a text clip. A look names a family and how to fall back:
//   1. Text in Japanese takes the look's `ja` face: a Latin display family has no kana, and the browser would pick a system
//      face that differs per machine. Latin tracking does not carry over: kana are set solid.
//   2. Where the caller knows the installed families and the chosen one is missing, `fallback` takes over when it is there.
//   3. Otherwise the family stands as named. A missing font then follows the render path's `FONT_FALLBACK` (a warning that
//      names it, and the default family), and the text corrects itself when the font is installed.
import type { FontRef } from '../schema/media.ts';
import type { LookFont } from './model.ts';

/** Kana, CJK ideographs and half-width katakana. */
const JAPANESE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;

export const hasJapanese = (text: string): boolean => JAPANESE.test(text);

export type ChosenLookFont = { family: string; weight?: number; italic?: boolean; trackingEm?: number };

/** The face for `text`. `available`: installed families (any case), when the caller knows them. */
export function chooseLookFont(
	font: LookFont | FontRef,
	text: string,
	available?: readonly string[],
): ChosenLookFont {
	const f = font as LookFont;
	const out: ChosenLookFont =
		f.ja && hasJapanese(text)
			? { family: f.ja.family, ...(f.ja.weight !== undefined ? { weight: f.ja.weight } : {}) }
			: {
					family: f.family,
					...(f.weight !== undefined ? { weight: f.weight } : {}),
					...(f.italic !== undefined ? { italic: f.italic } : {}),
					...(f.trackingEm !== undefined ? { trackingEm: f.trackingEm } : {}),
				};
	if (!available) return out;
	const has = (family: string) => available.some((a) => a.toLowerCase() === family.toLowerCase());
	if (f.fallback && !has(out.family) && has(f.fallback)) return { ...out, family: f.fallback };
	return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const rec = (v: unknown): Record<string, unknown> | null =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * The families the looks of a stored document name (`doc.titleLooks[*].appearance.font`: the family, its fallback
 * and its Japanese face), each once. A look applies its font when it is applied, so until then the project's font table
 * does not list it: whatever asks "does a project use this font" (removing a font of the user library) reads these too.
 * Read raw and never throws: the document may be unvalidated.
 */
export function projectLookFontFamilies(doc: unknown): string[] {
	const looks = rec(rec(doc)?.titleLooks);
	const out = new Set<string>();
	for (const look of Object.values(looks ?? {})) {
		const font = rec(rec(rec(look)?.appearance)?.font);
		if (!font) continue;
		for (const f of [str(font.family), str(font.fallback), str(rec(font.ja)?.family)]) if (f) out.add(f);
	}
	return [...out];
}
