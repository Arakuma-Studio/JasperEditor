// Remote-asset manifest (social-comment design §7.8): platform fonts and emoji image packs the app may not bundle.
// `manifest.json` next to this file ships with the app; `<appdir>/assets/remote-manifest.override.json` (same schema)
// replaces entries by id so a moved file can be fixed without a release. Validated with zod at load (AGENTS §0).
import { EMOJI_PACK_IDS } from '@jasper/mg-templates';
import { z } from 'zod';

/** Manifest files larger than this are refused (the shipped one is a few kB; a names map stays well below). */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

const httpUrl = (v: string): boolean => {
	try {
		const u = new URL(v);
		return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && !u.username && !u.password;
	} catch {
		return false;
	}
};

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'a lower-case hex SHA-256');
const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'lower-case letters, digits and "-"');

export const RemoteFontEntrySchema = z.object({
	id: IdSchema,
	family: z.string().trim().min(1).max(128),
	weight: z.number().int().min(1).max(1000),
	style: z.enum(['normal', 'italic']),
	format: z.enum(['woff2', 'woff', 'ttf', 'otf']),
	url: z.string().max(2048).refine(httpUrl, 'an http(s) URL without credentials'),
	/** The file's SHA-256, pinned: a download that differs is refused. */
	sha256: Sha256Schema,
	licence: z.string().min(1).max(500),
	/** Where the file was found (provenance note). */
	source: z.string().min(1).max(500),
});
export type RemoteFontEntry = z.infer<typeof RemoteFontEntrySchema>;

/** `{cp}` / `{name}` placeholders of an emoji pack's URL template. */
const PLACEHOLDER = /\{(cp|name)\}/g;

export const RemoteEmojiPackSchema = z
	.object({
		id: z.enum(EMOJI_PACK_IDS),
		name: z.string().min(1).max(64),
		/** Pack version: part of cache paths, image URLs and layer-bake keys. */
		version: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/, 'letters, digits, ".", "_" and "-" (max 32)'),
		/**
		 * Image URL with `{cp}` = the grapheme's code points, lower-case hex joined by `cpJoin` ("-"), and optionally
		 * `{name}` = the grapheme's entry in `names` (packs whose file names carry a slug).
		 */
		urlTemplate: z.string().max(2048),
		/** How U+FE0F appears in `{cp}`: kept, stripped, or tried with it first and then without. */
		fe0f: z.enum(['keep', 'strip', 'try-both']),
		format: z.enum(['png', 'svg']),
		/** Pixel size of the images (null for svg). */
		pixelSize: z.number().int().min(1).max(4096).nullable(),
		licence: z.string().min(1).max(500),
		attribution: z.string().max(500).nullable(),
		/** Separator between code points in `{cp}` (default "-"). */
		cpJoin: z.string().max(3).optional(),
		/** Minimum hex digits per code point in `{cp}`, zero-padded (default 1: no padding). */
		cpMinDigits: z.number().int().min(1).max(8).optional(),
		/** `{name}` values by canonical code point key (`emojiKey`, every code point, "-" joined). */
		names: z
			.record(
				z.string().regex(/^[0-9a-f]{1,6}(?:-[0-9a-f]{1,6}){0,15}$/),
				z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/),
			)
			.optional(),
	})
	.superRefine((p, ctx) => {
		const holders: string[] = p.urlTemplate.match(PLACEHOLDER) ?? [];
		if (!holders.includes('{cp}') && !holders.includes('{name}'))
			ctx.addIssue({ code: 'custom', path: ['urlTemplate'], message: 'needs a {cp} or {name} placeholder' });
		if (holders.includes('{name}') && !p.names)
			ctx.addIssue({ code: 'custom', path: ['names'], message: '{name} needs a names map' });
		if (!httpUrl(p.urlTemplate.replace(PLACEHOLDER, '1f600')))
			ctx.addIssue({ code: 'custom', path: ['urlTemplate'], message: 'not an http(s) URL template' });
		if ((p.format === 'svg') !== (p.pixelSize === null))
			ctx.addIssue({ code: 'custom', path: ['pixelSize'], message: 'null exactly for svg packs' });
	});
export type RemoteEmojiPack = z.infer<typeof RemoteEmojiPackSchema>;

export const RemoteManifestSchema = z
	.object({
		version: z.literal(1),
		fonts: z.array(RemoteFontEntrySchema).max(256),
		emojiPacks: z.array(RemoteEmojiPackSchema).max(16),
	})
	.superRefine((m, ctx) => {
		const dup = (ids: string[], path: string) => {
			const seen = new Set<string>();
			ids.forEach((id, i) => {
				if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [path, i, 'id'], message: `duplicate id ${id}` });
				seen.add(id);
			});
		};
		dup(
			m.fonts.map((f) => f.id),
			'fonts',
		);
		dup(
			m.emojiPacks.map((p) => p.id),
			'emojiPacks',
		);
	});
export type RemoteManifest = z.infer<typeof RemoteManifestSchema>;
