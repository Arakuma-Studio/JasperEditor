// Instagram cards of social-comment@1, drawn at tokcomment's CSS px (research/tokcomment-recon/ref/instagram-post and
// instagram-reels: computed-style dumps of every element, light and dark) with Instagram's real glyphs (glyphs.ts),
// SF Pro Text (the iPhone app's system font) instead of the capture host's Liberation Sans fallback, and the
// platform's weights, tracking and link colours (WP5 measurements). Deliberate differences from tokcomment and the
// tokcomment bugs fixed are listed in docs/wp-notes/social-comments.md "Instagram cards: calibration".
import { formatCount, formatRepliesLabel, formatTime, SOCIAL_VARIANT_FONTS } from '@jasper/mg-templates';
import type { CSSProperties } from 'react';
import { INSTAGRAM_GLYPHS } from '../social/glyphs.ts';
import type { SocialCardProps, SocialVariantImpl } from './contract.ts';
import { CommentText, type EmojiMetrics, Glyph, SocialAvatar, TextWithEmoji } from './parts.tsx';

const FONT = `"${SOCIAL_VARIANT_FONTS['instagram-post']!.family}", sans-serif`;

/** Apple emoji images, sized and centred on the text like iOS draws them next to SF Pro (calibrated, see the note). */
const EMOJI: EmojiMetrics = { size: 1.2, shift: -0.22 };

/** Mentions and hashtags: Instagram's link colour, `--ig-link` rgb(0, 55, 107) / rgb(224, 241, 255) [M-css]. */
const LINK = { light: '#00376B', dark: '#E0F1FF' } as const;

/**
 * SF Pro's tracking per point size (Apple HIG, Typography ▸ Tracking values for SF Pro): iOS applies it to the system
 * font, so text set in SF Pro at these sizes carries it.
 */
const TRACK: Readonly<Record<number, number>> = { 11: 0.06, 12: 0, 13: -0.08, 14: -0.15, 15: -0.23 };
const track = (px: number) => `${TRACK[px] ?? 0}px`;

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Instagram's default ("no photo") avatar: a white head-and-shoulders figure on a neutral grey disc. Instagram serves
 * its own only through signed, expiring CDN URLs (WP5), so it is drawn here as a vector in the same style [E]: the
 * head a circle above the centre, the shoulders a dome (radius 17) whose foot follows the disc. The disc is SVG geometry,
 * not a CSS rounded clip, so its edge rasterises the same in every render (preview, still, frames).
 */
function InstagramDefaultAvatar({ size, style }: { size: number; style?: CSSProperties }) {
	const a = INSTAGRAM_DEFAULT_AVATAR;
	return (
		<div data-social-avatar="default" style={{ width: size, height: size, flexShrink: 0, ...style }}>
			<svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" style={{ display: 'block' }}>
				<path d={a.disc} fill={a.background} />
				<path d={a.head} fill={a.figure} />
				<path d={a.shoulders} fill={a.figure} />
			</svg>
		</div>
	);
}

/** The default avatar's colours and paths (48 × 48 box). */
export const INSTAGRAM_DEFAULT_AVATAR = {
	background: '#C7C7C7',
	figure: '#FFFFFF',
	disc: 'M0 24a24 24 0 1 0 48 0a24 24 0 1 0 -48 0Z',
	head: 'M15.6 18.6a8.4 8.4 0 1 0 16.8 0a8.4 8.4 0 1 0 -16.8 0Z',
	// the dome of a radius-17 circle centred at (24, 47.5), closed along the disc between their intersections
	shoulders: 'M7.964 41.856A17 17 0 0 1 40.036 41.856A24 24 0 0 1 7.964 41.856Z',
} as const;

/** The avatar of an Instagram card: the user's picture, a generated one, or Instagram's default look (`null`). */
function InstagramAvatar(p: {
	params: SocialCardProps['params'];
	size: number;
	assets: SocialCardProps['assets'];
	backdrop: string;
}) {
	if (p.params.avatar === null) return <InstagramDefaultAvatar size={p.size} />;
	return (
		<SocialAvatar
			avatar={p.params.avatar}
			platform="instagram"
			size={p.size}
			// Instagram shows the handle, so a generated avatar's initials come from it
			name={p.params.handle}
			fontFamily={FONT}
			assets={p.assets}
			style={{ background: p.backdrop }}
		/>
	);
}

// --------------------------------------------------------------------------------------------- post comment

/**
 * tokcomment `.instagram-wrapper` colours (styles_light_verified-on / styles_dark_verified-on.json). The dark username
 * is white: tokcomment's `text-black` wins over its `text-[#ffffff]` and draws it black on the dark card (its bug).
 */
const POST_THEME = {
	light: {
		bg: '#FFFFFF',
		border: 'rgba(0, 0, 0, 0.05)',
		avatarBg: '#E5E7EB',
		name: '#000000',
		text: '#0F0F0F',
		muted: '#888888',
		rule: '#B5B5B5',
	},
	dark: {
		bg: '#222328',
		border: 'rgba(255, 255, 255, 0.05)',
		avatarBg: '#1A1A1A',
		name: '#FFFFFF',
		text: '#FFFFFF',
		muted: '#A3A9AF',
		rule: '#383838',
	},
} as const;

/** Instagram's liked heart, `--ig-badge` rgb(255, 48, 64) [M-css]. */
const LIKED = INSTAGRAM_GLYPHS.heartFilled.defaultColor;

/**
 * Like heart box (reference px): Instagram's heart fills 96 % of its 24-unit box where tokcomment's lucide heart (16 px
 * box, 2 px stroke) inks ≈ 15 px, so the glyph is drawn at 15.5 px, centred in tokcomment's 16 px slot.
 */
const HEART_PX = 15.5;

/** The like heart; while the like tick runs it thumps (`s`) and fills (`f`) in Instagram's liked red. */
function LikeHeart({
	theme,
	heart,
	color,
}: {
	theme: 'light' | 'dark';
	heart: SocialCardProps['anim']['heart'];
	color: string;
}) {
	const box: CSSProperties = {
		position: 'relative',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 16,
		height: 16,
	};
	if (!heart)
		return (
			<span data-part="heart" style={box}>
				<Glyph glyph={INSTAGRAM_GLYPHS.heartOutline} size={HEART_PX} color={color} />
			</span>
		);
	const f = Math.min(1, Math.max(0, heart.f));
	const layer: CSSProperties = {
		position: 'absolute',
		left: (16 - HEART_PX) / 2,
		top: (16 - HEART_PX) / 2,
	};
	return (
		<span data-part="heart" style={{ ...box, transform: `scale(${round4(heart.s)})` }}>
			<Glyph
				glyph={INSTAGRAM_GLYPHS.heartOutline}
				size={HEART_PX}
				color={color}
				style={{ ...layer, opacity: round4(1 - f) }}
			/>
			<Glyph
				glyph={INSTAGRAM_GLYPHS.heartFilled}
				size={HEART_PX}
				color={LIKED[theme]}
				style={{ ...layer, opacity: round4(f) }}
			/>
		</span>
	);
}

function InstagramPostCard({ params: p, text, anim, assets }: SocialCardProps) {
	const theme = POST_THEME[p.theme];
	const replies = formatRepliesLabel(p.variant, p.replies);
	return (
		<div
			data-social-variant="instagram-post"
			style={{
				width: 420,
				boxSizing: 'border-box',
				background: theme.bg,
				padding: '16px 14px 6px',
				borderRadius: 2,
				border: `1px solid ${theme.border}`,
				fontFamily: FONT,
			}}
		>
			<div style={{ display: 'flex', gap: 13, alignItems: 'flex-start' }}>
				{p.showProfile ? (
					<InstagramAvatar params={p} size={36} assets={assets} backdrop={theme.avatarBg} />
				) : null}
				<div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
					<div
						data-part="header"
						style={{
							display: 'flex',
							alignItems: 'baseline',
							gap: 2,
							marginBottom: 1.5,
							minWidth: 0,
							fontSize: 12,
							lineHeight: '18px',
							letterSpacing: track(12),
							whiteSpace: 'nowrap',
						}}
					>
						<span
							data-part="name"
							data-template-param="handle"
							style={{
								fontWeight: 600,
								color: theme.name,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								minWidth: 0,
							}}
						>
							<TextWithEmoji text={p.handle} fontSize={12} emoji={EMOJI} assets={assets} />
						</span>
						{p.verified ? (
							<Glyph
								glyph={INSTAGRAM_GLYPHS.verified}
								size={10.5}
								style={{ alignSelf: 'center', margin: '0 0 0 1px' }}
							/>
						) : null}
						<span
							data-part="time"
							style={{ marginLeft: 3, fontWeight: 400, color: theme.muted, flexShrink: 0 }}
						>
							{formatTime(p.variant, p.timeValue, p.timeUnit)}
						</span>
					</div>
					<CommentText
						spans={text.spans}
						segments={text.segments}
						words={anim.words}
						colors={{ mention: LINK[p.theme], hashtag: LINK[p.theme] }}
						emoji={EMOJI}
						assets={assets}
						style={{
							margin: '3px 0 5.25px',
							fontSize: 14,
							fontWeight: 400,
							lineHeight: 1.3,
							letterSpacing: track(14),
							color: theme.text,
						}}
					/>
					<div
						data-part="meta"
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 12,
							marginTop: 3,
							fontSize: 12,
							lineHeight: '18px',
							fontWeight: 600,
							letterSpacing: track(12),
							color: theme.muted,
							whiteSpace: 'nowrap',
						}}
					>
						<span>Reply</span>
					</div>
					{replies ? (
						<div
							data-part="replies"
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 6,
								marginTop: 10,
								fontSize: 12,
								lineHeight: '18px',
								fontWeight: 600,
								letterSpacing: track(12),
								color: theme.muted,
								whiteSpace: 'nowrap',
							}}
						>
							<div style={{ width: 25, height: 1, marginRight: 5, background: theme.rule, flexShrink: 0 }} />
							<span>{replies}</span>
						</div>
					) : null}
				</div>
				<div
					data-part="like"
					style={{
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
						gap: 4,
						// tokcomment's 8 px, plus 1.5 px: Instagram's heart inks higher in its box than lucide's
						padding: '9.5px 0 0 8px',
						// a fixed column (tokcomment's width with "114"), as on Instagram: a longer count stays centred under the
						// heart (it may spill into the gap and the card's padding) instead of narrowing the comment
						boxSizing: 'border-box',
						width: 25.6,
						flexShrink: 0,
						color: theme.muted,
					}}
				>
					<LikeHeart theme={p.theme} heart={anim.heart} color={theme.muted} />
					{/* Instagram shows no number under the heart of a comment nobody liked */}
					{p.likes > 0 ? (
						<span
							data-part="likes"
							style={{
								marginTop: 6,
								fontSize: 11.04,
								lineHeight: '16.56px',
								fontWeight: 400,
								letterSpacing: track(11),
								whiteSpace: 'nowrap',
							}}
						>
							{formatCount(p.variant, anim.likes, 'likes')}
						</span>
					) : null}
				</div>
			</div>
		</div>
	);
}

// ------------------------------------------------------------------------------------------------ reel reply

/** tokcomment Reels card colours (styles_light.json / styles_dark.json). */
const REEL_THEME = {
	light: { bg: '#FFFFFF', border: 'none', text: '#000000', muted: '#888888' },
	dark: { bg: '#222328', border: '1px solid rgba(255, 255, 255, 0.05)', text: '#FFFFFF', muted: '#A8A8A8' },
} as const;

function InstagramReelReplyCard({ params: p, text, anim, assets }: SocialCardProps) {
	const theme = REEL_THEME[p.theme];
	return (
		<div
			data-social-variant="instagram-reel-reply"
			style={{
				display: 'flex',
				gap: 11,
				alignItems: 'flex-start',
				boxSizing: 'border-box',
				width: 'fit-content',
				maxWidth: 255,
				padding: 16,
				borderRadius: 6,
				border: theme.border,
				boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
				background: theme.bg,
				fontFamily: FONT,
			}}
		>
			{p.showProfile ? <InstagramAvatar params={p} size={36} assets={assets} backdrop="#F3F4F6" /> : null}
			<div
				style={{
					flex: 1,
					minWidth: 0,
					display: 'flex',
					flexDirection: 'column',
					justifyContent: 'center',
				}}
			>
				<CommentText
					spans={text.spans}
					segments={text.segments}
					words={anim.words}
					colors={{ mention: LINK[p.theme], hashtag: LINK[p.theme] }}
					emoji={EMOJI}
					assets={assets}
					style={{
						marginBottom: 3,
						fontSize: 15,
						fontWeight: 400,
						lineHeight: 1.375,
						letterSpacing: track(15),
						color: theme.text,
					}}
				/>
				<div
					data-part="replying"
					style={{
						fontSize: 13,
						lineHeight: '19.5px',
						fontWeight: 400,
						letterSpacing: track(13),
						color: theme.muted,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					}}
				>
					{'Replying to '}
					<span data-template-param="handle">{p.handle}</span>
				</div>
			</div>
		</div>
	);
}

export const INSTAGRAM_POST: SocialVariantImpl = { Card: InstagramPostCard, growOrigin: '0% 0%' };
export const INSTAGRAM_REEL_REPLY: SocialVariantImpl = {
	Card: InstagramReelReplyCard,
	growOrigin: '0% 0%',
	// the card's 0 1px 2px shadow: 2 px around, moved 1 px down
	bleed: { top: 1, right: 2, bottom: 3, left: 2 },
};
