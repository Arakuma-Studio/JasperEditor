// YouTube cards of social-comment@1, drawn at tokcomment's CSS px (research/tokcomment-recon/ref/youtube-video and
// youtube-shorts: computed-style dumps of every element, light and dark) with YouTube's real glyphs (glyphs.ts), Roboto
// (YouTube's comment font, bundled) and the live youtube.com measurements of 2026 where they differ from tokcomment
// (avatar size, the colours of the handle, counts, icons, thread line and "N replies"). Deliberate differences from
// tokcomment and the tokcomment bugs fixed are listed in docs/wp-notes/social-comments.md "YouTube cards".
import { formatCount, formatRepliesLabel, formatTime, SOCIAL_VARIANT_FONTS } from '@jasper/mg-templates';
import type { CSSProperties } from 'react';
import { PLATFORM_DEFAULT_AVATARS, YOUTUBE_GLYPHS } from '../social/glyphs.ts';
import type { SocialCardAssets, SocialCardProps, SocialVariantImpl } from './contract.ts';
import { CommentText, type EmojiMetrics, Glyph, SocialAvatar, TextWithEmoji } from './parts.tsx';

const FONT = `"${SOCIAL_VARIANT_FONTS['youtube-comment']!.family}", sans-serif`;

/**
 * Noto emoji images (YouTube's default pack) at 1.2 em, placed like the captures' Noto Color Emoji glyphs (2×: same
 * 32 px box, centre within 1 px of the reference on the comment and on the Shorts card).
 */
const EMOJI: EmojiMetrics = { size: 1.2, shift: -0.16 };
const SHORTS_EMOJI: EmojiMetrics = { size: 1.2, shift: -0.21 };

/**
 * Mentions and hashtags: YouTube draws them as links in its call-to-action blue (`--yt-spec-call-to-action`,
 * light / dark) [E: the logged-out capture had no mention; value of YouTube's web theme].
 */
const LINK = { light: '#065FD4', dark: '#3EA6FF' } as const;

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

// ------------------------------------------------------------------------------------------- default avatar

/** YouTube's default ("no photo") avatar: `yt3.ggpht.com/a/default-user` (240 px JPEG, recorded in glyphs.ts). */
const DEFAULT_AVATAR = PLATFORM_DEFAULT_AVATARS.youtube;
const DEFAULT_AVATAR_URL = DEFAULT_AVATAR.kind === 'remote' ? DEFAULT_AVATAR.image.url : null;

/**
 * The same picture as vectors, used while the raster is not resolved (`assets.imageUrls`): a #A0C2FF field with a
 * #4474E0 head (circle r 44.5 at 120, 92) and shoulders (150 wide, elliptical top from y 152), measured on the
 * 240 px file (sha256 9929d44d…).
 */
function YouTubeDefaultAvatar({ size, style }: { size: number; style?: CSSProperties }) {
	return (
		<div
			data-social-avatar="default"
			style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, ...style }}
		>
			<svg viewBox="0 0 240 240" width={size} height={size} aria-hidden="true" style={{ display: 'block' }}>
				<rect width="240" height="240" fill="#A0C2FF" />
				<circle cx="120" cy="92" r="44.5" fill="#4474E0" />
				<path d="M45 240V186A75 34 0 0 1 195 186V240Z" fill="#4474E0" />
			</svg>
		</div>
	);
}

/**
 * The author's avatar: the picture, a generated one (initials from the handle the card shows) or YouTube's default
 * (the resolved raster when the engine delivers it, else its vector twin above).
 */
function YouTubeAvatar(p: {
	params: SocialCardProps['params'];
	size: number;
	assets: SocialCardAssets;
	style?: CSSProperties;
}) {
	if (p.params.avatar === null && !(DEFAULT_AVATAR_URL && p.assets.imageUrls[DEFAULT_AVATAR_URL]))
		return <YouTubeDefaultAvatar size={p.size} {...(p.style ? { style: p.style } : {})} />;
	return (
		<SocialAvatar
			avatar={p.params.avatar}
			platform="youtube"
			size={p.size}
			name={p.params.handle}
			fontFamily={FONT}
			assets={p.assets}
			{...(p.style ? { style: p.style } : {})}
		/>
	);
}

/** `@handle`: the "@" outside the editable element, which holds exactly the handle (C5). */
function Handle({
	handle,
	fontSize,
	assets,
}: {
	handle: string;
	fontSize: number;
	assets: SocialCardAssets;
}) {
	return (
		<>
			{'@'}
			<span data-template-param="handle">
				<TextWithEmoji text={handle} fontSize={fontSize} emoji={EMOJI} assets={assets} />
			</span>
		</>
	);
}

// ------------------------------------------------------------------------------------------------ comment

/**
 * Colours: tokcomment `.youtube-wrapper` (styles_light_verified-on / styles_dark_verified-on.json) for the card;
 * [M] = youtube.com 2026 (research/platform-measurements, YouTube) where the live page differs from tokcomment.
 */
const COMMENT_THEME = {
	light: {
		bg: '#FFFFFF',
		border: 'rgba(0, 0, 0, 0.05)',
		handle: '#0F0F0F',
		text: '#0F0F0F',
		secondary: '#606060',
		icons: '#0F0F0F', // [M] (tokcomment #000)
		count: '#606060',
		thread: '#E5E5E5', // [M] (tokcomment rgba(0, 0, 0, .1))
		replies: '#0F0F0F', // [M] (tokcomment #606060)
	},
	dark: {
		bg: '#0F0F0F',
		border: 'rgba(255, 255, 255, 0.05)',
		handle: '#F1F1F1', // [M] (tokcomment #AAAAAA)
		text: '#F1F1F1', // [M] (tokcomment rgba(241, 241, 241, .97))
		secondary: '#AAAAAA',
		icons: '#F1F1F1', // [M] (tokcomment #FFF)
		count: '#AAAAAA', // [M] (tokcomment #FFF)
		thread: '#3F3F3F', // [M] (tokcomment #363636)
		replies: '#F1F1F1', // [M] (tokcomment #FFF)
	},
} as const;

/** Avatar: 36 px on youtube.com 2026 [M] (tokcomment 34); the 12 px gap keeps tokcomment's text column (x = 61). */
const AVATAR = 36;
const AVATAR_GAP = 12;
/** Card padding (tokcomment `pt-[12px] pb-[5px] px-[12px]`) and its 1 px border. */
const PAD = 12;
/** The thread line: 1 px [M] (tokcomment 2 px), from 8 px below the avatar down to the replies row. */
const THREAD_W = 1;
/**
 * Like / dislike thumbs: YouTube's 18-unit glyphs at 17 px match the ink of tokcomment's 16 px lucide thumbs (14 px
 * wide); the negative margins keep tokcomment's 16 px slots, so the count and the other buttons stay in place.
 */
const THUMB = 17;
const THUMB_MARGIN = -0.5;
/** …and its run to the right: it ends 6 px before the text column (tokcomment: 6 % of 420 from the avatar centre). */
const THREAD_RUN = PAD + AVATAR + AVATAR_GAP - 6 - (PAD + AVATAR / 2 - THREAD_W / 2);

/** The like thumb; while the like tick runs it thumps (`s`) and fills (`f`: outline → YouTube's liked thumb). */
function LikeThumb({
	heart,
	color,
	size,
}: {
	heart: SocialCardProps['anim']['heart'];
	color: string;
	size: number;
}) {
	if (!heart)
		return (
			<Glyph
				glyph={YOUTUBE_GLYPHS.thumbUp}
				size={size}
				color={color}
				style={{ margin: `0 ${THUMB_MARGIN}px` }}
			/>
		);
	const f = Math.min(1, Math.max(0, heart.f));
	return (
		<span
			data-part="like-icon"
			style={{
				position: 'relative',
				display: 'block',
				width: size,
				height: size,
				margin: `0 ${THUMB_MARGIN}px`,
				flexShrink: 0,
				transform: `scale(${r4(heart.s)})`,
			}}
		>
			<Glyph
				glyph={YOUTUBE_GLYPHS.thumbUp}
				size={size}
				color={color}
				style={{ position: 'absolute', inset: 0, opacity: r4(1 - f) }}
			/>
			<Glyph
				glyph={YOUTUBE_GLYPHS.thumbUpFilled}
				size={size}
				color={color}
				style={{ position: 'absolute', inset: 0, opacity: r4(f) }}
			/>
		</span>
	);
}

function YouTubeCommentCard({ params: p, text, anim, assets }: SocialCardProps) {
	const theme = COMMENT_THEME[p.theme];
	const replies = formatRepliesLabel(p.variant, p.replies);
	const thread = replies !== '' && p.showProfile;
	return (
		<div
			data-social-variant="youtube-comment"
			style={{
				position: 'relative',
				width: 420,
				boxSizing: 'border-box',
				background: theme.bg,
				border: `1px solid ${theme.border}`,
				borderRadius: 6,
				padding: `${PAD}px ${PAD}px 5px`,
				fontFamily: FONT,
			}}
		>
			<div style={{ display: 'flex', gap: AVATAR_GAP, alignItems: 'flex-start' }}>
				{p.showProfile ? <YouTubeAvatar params={p} size={AVATAR} assets={assets} /> : null}
				<div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
					<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
						<div
							data-part="header"
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 4.2,
								marginBottom: 1.5,
								minWidth: 0,
								flex: 1,
								whiteSpace: 'nowrap',
							}}
						>
							<span
								data-part="name"
								style={{
									fontSize: 13,
									lineHeight: '20px',
									fontWeight: 500,
									color: theme.handle,
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									minWidth: 0,
								}}
							>
								<Handle handle={p.handle} fontSize={13} assets={assets} />
							</span>
							{p.verified ? (
								<Glyph
									glyph={YOUTUBE_GLYPHS.verified}
									size={13}
									color={theme.secondary}
									style={{ margin: '0 -0.5px' }}
								/>
							) : null}
							<span
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 7,
									flexShrink: 0,
									fontSize: 12,
									lineHeight: '20px',
									color: theme.secondary,
								}}
							>
								<span
									style={{
										width: 3,
										height: 3,
										marginLeft: 4,
										borderRadius: '50%',
										background: theme.secondary,
									}}
								/>
								<span data-part="time">{formatTime(p.variant, p.timeValue, p.timeUnit)}</span>
							</span>
						</div>
						<Glyph glyph={YOUTUBE_GLYPHS.more} size={15} color={theme.icons} style={{ marginRight: -1 }} />
					</div>
					<CommentText
						spans={text.spans}
						segments={text.segments}
						words={anim.words}
						colors={{ mention: LINK[p.theme], hashtag: LINK[p.theme] }}
						emoji={EMOJI}
						assets={assets}
						style={{
							paddingRight: 19,
							fontSize: 15,
							fontWeight: 400,
							lineHeight: 1.4,
							color: theme.text,
						}}
					/>
					<div
						data-part="actions"
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 14,
							height: 24,
							marginTop: 9,
							whiteSpace: 'nowrap',
						}}
					>
						<div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
							<LikeThumb heart={anim.heart} color={theme.icons} size={THUMB} />
							<span
								data-part="likes"
								style={{
									marginBottom: -3,
									fontSize: 12,
									lineHeight: '15px',
									fontWeight: 400,
									color: theme.count,
								}}
							>
								{formatCount(p.variant, anim.likes, 'likes')}
							</span>
						</div>
						<Glyph
							glyph={YOUTUBE_GLYPHS.thumbDown}
							size={THUMB}
							color={theme.icons}
							style={{ margin: `0 ${THUMB_MARGIN}px -2px` }}
						/>
						<div style={{ padding: '6px 10.5px', marginLeft: 10, marginBottom: -3, flexShrink: 0 }}>
							<Glyph glyph={YOUTUBE_GLYPHS.reply} size={16} color={theme.icons} />
						</div>
					</div>
					{replies ? (
						<div
							data-part="replies"
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 4,
								width: 'fit-content',
								maxWidth: 'calc(100% + 12px)',
								boxSizing: 'border-box',
								marginTop: 22,
								marginLeft: -12,
								padding: '6px 14px',
								fontSize: 14,
								lineHeight: '21px',
								fontWeight: 500,
								color: theme.replies,
								whiteSpace: 'nowrap',
							}}
						>
							<span>{replies}</span>
							<Glyph glyph={YOUTUBE_GLYPHS.chevronDown} size={20} color={theme.replies} />
						</div>
					) : null}
				</div>
			</div>
			{thread ? (
				<div
					data-part="thread"
					aria-hidden="true"
					style={{
						position: 'absolute',
						// from 8 px below the avatar (padding-box px) to just above the replies text's middle (tokcomment)
						top: PAD + AVATAR + 8,
						bottom: 23,
						left: PAD + AVATAR / 2 - THREAD_W / 2,
						width: THREAD_RUN,
						borderLeft: `${THREAD_W}px solid ${theme.thread}`,
						borderBottom: `${THREAD_W}px solid ${theme.thread}`,
						// a quarter circle as wide as the run (tokcomment's 37 px radius, clamped by the box)
						borderBottomLeftRadius: THREAD_RUN,
						boxSizing: 'border-box',
					}}
				/>
			) : null}
		</div>
	);
}

// ------------------------------------------------------------------------------------------ shorts reply

/**
 * tokcomment's Shorts card (styles_light / styles_dark.json). The "Comment from @handle" line is the card colour at
 * 70 % (measured on the 2× captures: #565656 / #ADADAD).
 */
const SHORTS_THEME = {
	light: { bg: '#FFFFFF', header: '#565656', text: '#0F0F0F' },
	dark: { bg: '#0F0F0F', header: '#ADADAD', text: '#F1F1F1' },
} as const;

/**
 * Header: 12 px text tracked 0.025 em as on a 16 px / 24 px line (tokcomment's `text-inherit` block of the card's
 * `clamp(10px, 3.8cqw, 16px)` font): the captures' "Comment from @Username" is 155.5 px wide (2×: 311), its cap height
 * 8.5 px with the cap top 17 px below the card (the 12 px run sits on the 16 px line's baseline).
 */
const SHORTS_HEADER_PX = 12;
/**
 * The 12 px run's baseline on that 16 px line is 1.4 px lower than on a 12 px line of the same height (Roboto
 * ascent 0.928, descent 0.244: (0.928 − 0.244) / 2 × 4 px): the header is drawn at 12 px and moved down by it.
 */
const SHORTS_HEADER_DROP = 1.4;
const SHORTS_BODY_PX = 17;

function YouTubeShortsReplyCard({ params: p, text, anim, assets }: SocialCardProps) {
	const theme = SHORTS_THEME[p.theme];
	return (
		<div
			data-social-variant="youtube-shorts-reply"
			style={{
				width: 'fit-content',
				maxWidth: 305,
				boxSizing: 'border-box',
				display: 'flex',
				alignItems: 'flex-start',
				gap: 12,
				padding: '8px 20px 12px',
				borderRadius: 16,
				overflow: 'hidden',
				background: theme.bg,
				color: theme.text,
				fontFamily: FONT,
			}}
		>
			{p.showProfile ? (
				<div style={{ flexShrink: 0, paddingTop: 8 }}>
					<YouTubeAvatar params={p} size={34} assets={assets} />
				</div>
			) : null}
			<div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' }}>
				<div
					data-part="header"
					style={{
						// one line; a long handle ends in an ellipsis instead of pushing the comment down
						paddingTop: SHORTS_HEADER_DROP,
						marginBottom: -SHORTS_HEADER_DROP,
						fontSize: SHORTS_HEADER_PX,
						lineHeight: '24px',
						fontWeight: 400,
						letterSpacing: '0.025em',
						color: theme.header,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					}}
				>
					{'Comment from '}
					<Handle handle={p.handle} fontSize={SHORTS_HEADER_PX} assets={assets} />
				</div>
				<CommentText
					spans={text.spans}
					segments={text.segments}
					words={anim.words}
					colors={{ mention: LINK[p.theme], hashtag: LINK[p.theme] }}
					emoji={SHORTS_EMOJI}
					assets={assets}
					style={{
						fontSize: SHORTS_BODY_PX,
						fontWeight: 500,
						lineHeight: 1.3,
						letterSpacing: '-0.025em',
						color: theme.text,
					}}
				/>
			</div>
		</div>
	);
}

export const YOUTUBE_COMMENT: SocialVariantImpl = { Card: YouTubeCommentCard, growOrigin: '0% 0%' };
/** The Shorts card has no tail: it grows from its avatar corner. */
export const YOUTUBE_SHORTS_REPLY: SocialVariantImpl = { Card: YouTubeShortsReplyCard, growOrigin: '0% 0%' };
