import { z } from 'zod';

export const FontFileSchema = z.object({
	weight: z.number().int(),
	style: z.enum(['normal', 'italic']),
	url: z.string(),
	subset: z.string().optional(),
});
export const FontFamilySchema = z.object({
	family: z.string(),
	category: z.string().optional(),
	/**
	 * `remote` (social-comment §7.8): a platform font of the remote-asset manifest, downloaded by the engine on first
	 * use (network policy "Platform fonts & emoji for social templates") and served under `/fonts/remote/`. Remote
	 * families are for templates that declare them (`requiredAssets`); text clips do not resolve them.
	 */
	source: z.enum(['bundled', 'google', 'system', 'custom', 'remote']),
	weights: z.array(z.number().int()),
	styles: z.array(z.enum(['normal', 'italic'])),
	files: z.array(FontFileSchema),
	/** Text-animators: variation axes of a variable family (tag → user-unit range), for Variable Font Axes. */
	axes: z.record(z.string(), z.object({ min: z.number(), max: z.number(), default: z.number() })).optional(),
});
export type FontFamily = z.infer<typeof FontFamilySchema>;

/** social-comment §7.8: an emoji image pack of the remote-asset manifest (images under `/fonts/emoji/`). */
export const EmojiPackInfoSchema = z.object({
	id: z.string(),
	name: z.string(),
	version: z.string(),
	format: z.enum(['png', 'svg']),
	licence: z.string(),
	attribution: z.string().nullable(),
});
export type EmojiPackInfo = z.infer<typeof EmojiPackInfoSchema>;

export const FontCatalogSchema = z.object({
	fonts: z.array(FontFamilySchema),
	/** social-comment §7.8: emoji packs (absent on engines without the remote-asset service). */
	emojiPacks: z.array(EmojiPackInfoSchema).optional(),
});
export type FontCatalog = z.infer<typeof FontCatalogSchema>;

/** Route prefix of remote fonts (`/fonts/remote/<id>-<sha256 prefix>.<format>`). */
export const REMOTE_FONT_PREFIX = '/fonts/remote/';
/** Route prefix of emoji images (`/fonts/emoji/<pack>/<version>/<codepoint key>.<format>`). */
export const EMOJI_ROUTE_PREFIX = '/fonts/emoji/';

/** Engine-relative URL of an emoji image of a pack version (`key`: `emojiKey(grapheme)` of `@jasper/mg-templates`). */
export function emojiImagePath(pack: string, version: string, key: string, format: 'png' | 'svg'): string {
	return `${EMOJI_ROUTE_PREFIX}${encodeURIComponent(pack)}/${encodeURIComponent(version)}/${key}.${format}`;
}

/**
 * URL of a template font face in a catalogue: the family (case-insensitive; bundled families before remote ones) with
 * exactly this weight and style, its `latin` file when it has subsets. Null when the catalogue has no such face — a
 * template face is never replaced by another family, weight or style (AGENTS §4).
 */
export function catalogFaceUrl(
	catalog:
		| {
				fonts: readonly {
					family: string;
					source?: string;
					files: readonly { weight: number; style: string; url: string; subset?: string }[];
				}[];
		  }
		| null
		| undefined,
	face: { family: string; weight: number; style: 'normal' | 'italic' },
): string | null {
	const name = face.family.trim().toLowerCase();
	const families = (catalog?.fonts ?? [])
		.filter((f) => f.family.toLowerCase() === name)
		.sort((a, b) => Number(a.source === 'remote') - Number(b.source === 'remote'));
	for (const fam of families) {
		const files = fam.files.filter((f) => f.weight === face.weight && f.style === face.style);
		const file = files.find((f) => f.subset === 'latin') ?? files.find((f) => !f.subset) ?? files[0];
		if (file) return file.url;
	}
	return null;
}
