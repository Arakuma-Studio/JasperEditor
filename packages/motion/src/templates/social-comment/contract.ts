// The contract between the social-comment template frame (index.tsx: params, timing, entrance, fit) and the
// per-variant cards (tiktok.tsx, …). A variant is a React component that draws ONE card at reference size — the
// tokcomment CSS px of its blueprint, so its numbers can be copied from the reference dumps — plus the corner its
// "grow from tail" entrance grows from. The frame zooms the card as a unit (`socialCardScale`, shrunk to fit long
// comments), centres it on the design stage and applies the entrance and exit; a card never animates itself except
// through `anim` (word reveal, like tick), so every card gets every entrance and extra for free.
import type {
	CommentSpan,
	SocialCommentParams,
	SocialEmojiPack,
	SocialTextSegment,
} from '@jasper/mg-templates';
import type { ComponentType } from 'react';

/** Values of one animated word unit (`s` scale 0.5 → 1, `o` opacity 0 → 1). */
export type SocialWordValues = Readonly<{ s: number; o: number }>;

/** The extras a card draws; at rest (and with the extras off) the card shows its hold state. */
export type SocialCardAnim = {
	/** Word reveal: values per word unit (index = `SocialTextSegment.unit`); null when word reveal is off. */
	words: readonly SocialWordValues[] | null;
	/** The like count to show (the final `likes`, or the ticking value while the like tick runs). */
	likes: number;
	/** Like tick: the heart's thump scale `s` and fill `f` (0 outline … 1 liked); null when the likes don't tick. */
	heart: Readonly<{ s: number; f: number }> | null;
	/**
	 * Progress of the like tick, 0 → 1 (eased like the count; 1 at rest and when the likes don't tick). Store review
	 * cards fill their stars from it (`socialStarFill(rating, tick)`) and pulse them with `heart.s`. Optional for
	 * cards and callers written before it (read it as 1 when absent).
	 */
	tick?: number;
};

/** Resolved pictures and the emoji pack of the clip. */
export type SocialCardAssets = {
	/** URL per media id of the clip's params (avatars), from the render snapshot; missing media are absent. */
	mediaUrls: Readonly<Record<string, string>>;
	/**
	 * URL per source URL of the remote platform images the clip uses (the raster X / YouTube default avatars), when
	 * the engine resolved them; absent ones draw a neutral silhouette.
	 */
	imageUrls: Readonly<Record<string, string>>;
	/** URL per `${pack}:${grapheme}` of every emoji the clip declared; a missing one is absent. */
	emojiUrls: Readonly<Record<string, string>>;
	/** The emoji pack the card draws (`resolveEmojiStyle(variant, emojiStyle)`). */
	emojiPack: SocialEmojiPack;
	/** Unique per rendered card: prefix of SVG ids (gradients) so several cards can share a frame. */
	idScope: string;
};

/** The comment split for drawing (`socialCommentSegments`): styled spans and word segments. */
export type SocialCardText = {
	spans: readonly CommentSpan[];
	segments: readonly SocialTextSegment[];
	units: number;
};

export type SocialCardProps = {
	params: SocialCommentParams;
	text: SocialCardText;
	anim: SocialCardAnim;
	assets: SocialCardAssets;
};

export type SocialVariantImpl = {
	/** Draws the card at reference size (CSS px of the tokcomment blueprint), its own width included. */
	Card: ComponentType<SocialCardProps>;
	/**
	 * `transform-origin` of the "grow from tail" entrance in the card's box: the bubble tail's corner on bubble
	 * variants (TikTok reply: `0% 100%`), the avatar's corner on the others.
	 */
	growOrigin: string;
	/**
	 * Reference px the card paints outside its box (a drop shadow), per side: the fit keeps them on the stage too.
	 * Absent: none.
	 */
	bleed?: Readonly<{ top: number; right: number; bottom: number; left: number }>;
};
