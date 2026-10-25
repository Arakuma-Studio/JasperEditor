// Pictures and emoji of the social-comment cards: the touch points with the template media params (contract C1:
// `mediaUrls`, `TemplateImage`) and the remote emoji packs (contract C2: `emojiUrls`, `EmojiImage`, `splitEmoji`).
// Every card draws avatars and emoji through these components, so the cards never depend on how the URLs arrive.
import type { CSSProperties, ReactNode } from 'react';
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

/** Text and emoji pieces of a string (emoji graphemes are drawn as images of the pack). */
export type EmojiPiece = { kind: 'text'; text: string } | { kind: 'emoji'; grapheme: string };

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** Splits `text` into text runs and emoji graphemes (Intl.Segmenter graphemes). */
export function splitEmojiPieces(text: string): EmojiPiece[] {
	const out: EmojiPiece[] = [];
	const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
	const graphemes = Segmenter
		? Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment)
		: Array.from(text);
	for (const g of graphemes) {
		if (EMOJI.test(g)) out.push({ kind: 'emoji', grapheme: g });
		else {
			const last = out[out.length - 1];
			if (last?.kind === 'text') last.text += g;
			else out.push({ kind: 'text', text: g });
		}
	}
	return out;
}

/** One emoji grapheme as an image of the clip's pack, `size` px square. */
export function EmojiGlyph(p: {
	grapheme: string;
	size: number;
	assets: SocialCardAssets;
	style?: CSSProperties;
}) {
	const url = p.assets.emojiUrls[`${p.assets.emojiPack}:${p.grapheme}`];
	if (!url)
		return (
			<span data-emoji-text={p.grapheme} style={p.style}>
				{p.grapheme}
			</span>
		);
	return (
		<img
			src={url}
			alt={p.grapheme}
			width={p.size}
			height={p.size}
			draggable={false}
			data-emoji={p.grapheme}
			style={{ display: 'inline-block', width: p.size, height: p.size, objectFit: 'contain', ...p.style }}
		/>
	);
}
