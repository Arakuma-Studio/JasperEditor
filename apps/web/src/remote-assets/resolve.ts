// social-comment §7.8: where the editor's Player finds the fonts and emoji anime templates declare — the engine's font
// catalogue (`GET /api/fonts`: bundled families, then the remote-asset manifest's `source: 'remote'` families and its
// emoji packs). URLs are the engine's font routes (`/fonts/remote/…`, `/fonts/emoji/…`), which download on first
// request when Settings ▸ Privacy & Network allows it; the export planner resolves the same faces engine-side.
import { catalogFaceUrl, type EmojiPackInfo, emojiImagePath } from '@jasper/api';
import { emojiKey, isEmojiGrapheme, mgRegistry, templateAssetOptions } from '@jasper/mg-templates';
import type { RenderTemplateAssets, SnapshotOptions } from '@jasper/project';

export type CatalogForAssets = {
	fonts: readonly {
		family: string;
		source?: string;
		files: readonly { weight: number; style: string; url: string; subset?: string }[];
	}[];
	emojiPacks?: readonly EmojiPackInfo[];
};

export type TemplateAssetResolver = {
	font(face: RenderTemplateAssets['fonts'][number]): string | null;
	emoji(pack: string, grapheme: string): string | null;
};

const resolvers = new WeakMap<object, TemplateAssetResolver>();
const NO_CATALOG: TemplateAssetResolver = { font: () => null, emoji: () => null };

/** Resolver over a catalogue (stable per catalogue object; null catalogue: nothing resolves). */
export function catalogAssetResolver(catalog: CatalogForAssets | null): TemplateAssetResolver {
	if (!catalog) return NO_CATALOG;
	let r = resolvers.get(catalog);
	if (!r) {
		r = {
			font: (face) => catalogFaceUrl(catalog, face),
			emoji: (pack, grapheme) => {
				const p = catalog.emojiPacks?.find((x) => x.id === pack);
				return p && isEmojiGrapheme(grapheme)
					? emojiImagePath(p.id, p.version, emojiKey(grapheme), p.format)
					: null;
			},
		};
		resolvers.set(catalog, r);
	}
	return r;
}

/** `SnapshotOptions.templateAssets` of the editor's Player. */
export function catalogTemplateAssets(
	catalog: CatalogForAssets | null,
): NonNullable<SnapshotOptions['templateAssets']> {
	return templateAssetOptions(mgRegistry, catalogAssetResolver(catalog));
}
