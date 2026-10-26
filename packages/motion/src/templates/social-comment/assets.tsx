// Pictures and emoji of the social-comment cards: the touch points with the template media params (contract C1:
// `mediaUrls`, `TemplateImage`) and the remote emoji packs (contract C2: `emojiUrls`, `EmojiImage`, `splitEmoji`).
// Every card draws avatars and emoji through these components, so the cards never depend on how the URLs arrive.
import type { CSSProperties, ReactNode } from 'react';
import { EmojiImage } from '../assets.tsx';
import { TemplateImage } from '../image.tsx';
import type { SocialCardAssets } from './contract.ts';

/** URLs of the clip's media / emoji (props of the anime template; empty when the clip references none). */
export function socialAssetUrls(props: {
	mediaUrls?: Readonly<Record<string, string>>;
	emojiUrls?: Readonly<Record<string, string>>;
	imageUrls?: Readonly<Record<string, string>>;
}): Pick<SocialCardAssets, 'mediaUrls' | 'emojiUrls' | 'imageUrls'> {
	return {
		mediaUrls: props.mediaUrls ?? {},
		emojiUrls: props.emojiUrls ?? {},
		imageUrls: props.imageUrls ?? {},
	};
}

/**
 * An avatar picture (`mediaUrls[mediaId]`) through `TemplateImage` (contract C1): the render waits until it is
 * decoded; a missing or unreadable medium draws `TemplateImage`'s visible placeholder in the avatar's circle.
 */
export function AvatarPicture(p: { src: string | undefined; style: CSSProperties; fallback?: ReactNode }) {
	return (
		<TemplateImage
			src={p.src}
			style={{ objectFit: 'cover', ...p.style }}
			{...(p.fallback ? { fallback: p.fallback } : {})}
			data-testid="social-avatar-media"
		/>
	);
}

/**
 * One emoji grapheme as an image of the clip's pack, `size` px square (`EmojiImage`, contract C2: the render waits
 * for its decode; an emoji the pack does not have is a visible `MissingAssetMarker` in preview, reported to the
 * editor, and blocks the export).
 */
export function EmojiGlyph(p: {
	grapheme: string;
	size: number;
	assets: SocialCardAssets;
	style?: CSSProperties;
}) {
	return (
		<EmojiImage
			url={p.assets.emojiUrls[`${p.assets.emojiPack}:${p.grapheme}`]}
			size={p.size}
			alt={p.grapheme}
			pack={p.assets.emojiPack}
			style={p.style}
		/>
	);
}
