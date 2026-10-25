// TikTok cards of social-comment@1, drawn at tokcomment's CSS px (research/tokcomment-recon/ref/tiktok-reply and
// tiktok-video: computed-style dumps of every element, light and dark) with TikTok's real glyphs (glyphs.ts) and
// TikTok Sans instead of tokcomment's Proxima Nova / Roboto stand-ins. Deliberate differences from tokcomment and the
// tokcomment bugs fixed are listed in docs/wp-notes/social-comments.md "Template implementation".
import { formatCount, formatRepliesLabel, formatTime, SOCIAL_VARIANT_FONTS } from '@jasper/mg-templates';
import type { CSSProperties } from 'react';
import { TIKTOK_GLYPHS } from '../social/glyphs.ts';
import type { SocialCardProps, SocialVariantImpl } from './contract.ts';
import { CommentText, type EmojiMetrics, Glyph, INK_RING, SocialAvatar, TextWithEmoji } from './parts.tsx';

const FONT = `"${SOCIAL_VARIANT_FONTS['tiktok-comment']!.family}", sans-serif`;

/** Apple emoji images at 1.2 em, their centre on the text's middle (tokcomment: the OS emoji glyph at 1 em). */
const EMOJI: EmojiMetrics = { size: 1.2, shift: -0.22 };

/** Mentions and hashtags: TikTok's info text colour (tux `--ui-text-info`, light / dark). */
const LINK = { light: '#2B5DB9', dark: '#60B3FF' } as const;

// ------------------------------------------------------------------------------------------------- reply

/** tokcomment `.tiktok-reply-template` colours (styles_light/dark_verified-on.json). */
const REPLY_THEME = {
	light: { bg: '#FFFFFF', header: '#5A5A5A', text: '#000000' },
	dark: { bg: '#1E1E1E', header: '#C0C0C0', text: '#FFFFFF' },
} as const;

/** Height of the bubble tail below the bubble (tokcomment's `.triangle`, measured on the 2× captures: 21 px). */
const TAIL_H = 21;
/**
 * The tail: from the bubble's square bottom-left corner straight down the left edge, a 4 px rounded tip, and a
 * slightly concave edge back up to the bubble bottom 25.5 px in (traced from tokcomment's CSS triangle, which is a
 * stack of skewed squares, not a path). Its top overlaps the bubble by half a pixel so no seam shows when zoomed.
 */
const TAIL_PATH = 'M0 -0.5H25.5L12.2 15.6C10 18.4 7.6 21 4.2 21C1.9 21 0 19.4 0 16.6Z';

/**
 * Text sizes of the reply sticker: tokcomment's 20 px header and 31 px comment were set in Proxima Nova; TikTok Sans
 * has a 7 % (header, 600) and 5 % (comment, 700) taller cap height, so the sizes are scaled to keep the reference's
 * cap heights (measured on the 2× captures: "R" 27 px, "W" 42 px). TikTok Sans is also ≈ 9 % wider, so a line holds a
 * few characters less than on tokcomment.
 */
const HEADER_PX = 18.5;
const BODY_PX = 29.5;

function TikTokReplyCard({ params: p, text, anim, assets }: SocialCardProps) {
	const theme = REPLY_THEME[p.theme];
	return (
		<div
			data-social-variant="tiktok-reply"
			style={{ position: 'relative', width: 420, paddingBottom: TAIL_H, fontFamily: FONT }}
		>
			<div
				style={{
					position: 'relative',
					background: theme.bg,
					borderRadius: '10px 10px 10px 0',
					padding: '18px 18px 22px',
					display: 'flex',
					gap: 14,
				}}
			>
				{p.showProfile ? (
					<SocialAvatar
						avatar={p.avatar}
						platform="tiktok"
						size={50}
						name={p.displayName}
						fontFamily={FONT}
						assets={assets}
						style={{ marginTop: 20 }}
					/>
				) : null}
				<div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
					<div
						data-part="header"
						style={{
							fontSize: HEADER_PX,
							lineHeight: '30px',
							fontWeight: 600,
							color: theme.header,
							overflowWrap: 'anywhere',
						}}
					>
						{'Reply to '}
						<span data-template-param="displayName">
							<TextWithEmoji text={p.displayName} fontSize={HEADER_PX} emoji={EMOJI} assets={assets} />
						</span>
						{"'s"}
						{p.verified ? (
							<span
								style={{
									display: 'inline-block',
									verticalAlign: -2,
									margin: '0 2px 0 6px',
								}}
							>
								<Glyph glyph={TIKTOK_GLYPHS.verified} size={18} />
							</span>
						) : null}
						{' comment'}
					</div>
					<CommentText
						spans={text.spans}
						segments={text.segments}
						words={anim.words}
						colors={{ mention: LINK[p.theme], hashtag: LINK[p.theme] }}
						emoji={EMOJI}
						assets={assets}
						style={{
							marginTop: 2,
							fontSize: BODY_PX,
							fontWeight: 700,
							lineHeight: 1.2,
							letterSpacing: '-0.025em',
							color: theme.text,
						}}
					/>
				</div>
			</div>
			<svg
				viewBox={`0 -0.5 26 ${TAIL_H + 0.5}`}
				width={26}
				height={TAIL_H + 0.5}
				aria-hidden="true"
				style={{ position: 'absolute', left: 0, bottom: 0, display: 'block' }}
			>
				<path d={TAIL_PATH} fill={theme.bg} />
			</svg>
		</div>
	);
}

// ----------------------------------------------------------------------------------------------- comment

/** tokcomment `.tiktok-wrapper` colours (styles_light_verified-on / styles_dark_verified-on.json). */
const COMMENT_THEME = {
	light: {
		bg: '#FFFFFF',
		avatarBg: '#E5E7EB',
		name: '#161823',
		text: '#0F0F0F',
		time: '#888888',
		reply: '#888888',
		icons: '#A2A2A2',
		rule: '#D9D7D7',
		replies: '#888888',
	},
	dark: {
		bg: '#1E1E1E',
		avatarBg: '#1A1A1A',
		name: '#A2A2A2',
		text: '#F1F1F1',
		time: '#888888',
		reply: '#A5A5A5',
		icons: '#A2A2A2',
		rule: '#3A3939',
		replies: '#A5A5A5',
	},
} as const;

/** TikTok's liked heart (`heartFilled` colours: tux `--ui-text-primary-display`). */
const LIKED = TIKTOK_GLYPHS.heartFilled.defaultColor;

/** The like heart; while the like tick runs it thumps (`s`) and fills (`f`) in TikTok's liked colour. */
function LikeHeart({
	theme,
	heart,
	color,
}: {
	theme: 'light' | 'dark';
	heart: SocialCardProps['anim']['heart'];
	color: string;
}) {
	const size = 20;
	const box: CSSProperties = { position: 'relative', width: size, height: size, margin: '-1px -2px 0' };
	if (!heart) return <Glyph glyph={TIKTOK_GLYPHS.heartOutline} size={size} color={color} style={box} />;
	const f = Math.min(1, Math.max(0, heart.f));
	return (
		<span
			style={{
				...box,
				display: 'block',
				boxShadow: INK_RING,
				transform: `scale(${Math.round(heart.s * 1e4) / 1e4})`,
			}}
		>
			<Glyph
				glyph={TIKTOK_GLYPHS.heartOutline}
				size={size}
				color={color}
				style={{ position: 'absolute', inset: 0, opacity: Math.round((1 - f) * 1e4) / 1e4 }}
			/>
			<Glyph
				glyph={TIKTOK_GLYPHS.heartFilled}
				size={size}
				color={LIKED[theme]}
				style={{ position: 'absolute', inset: 0, opacity: Math.round(f * 1e4) / 1e4 }}
			/>
		</span>
	);
}

function TikTokCommentCard({ params: p, text, anim, assets }: SocialCardProps) {
	const theme = COMMENT_THEME[p.theme];
	const replies = formatRepliesLabel(p.variant, p.replies);
	return (
		<div
			data-social-variant="tiktok-comment"
			style={{
				width: 420,
				boxSizing: 'border-box',
				background: theme.bg,
				padding: '12px 10px 5px',
				borderRadius: 2,
				border: '1px solid rgba(0, 0, 0, 0.05)',
				boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
				fontFamily: FONT,
			}}
		>
			<div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
				{p.showProfile ? (
					<SocialAvatar
						avatar={p.avatar}
						platform="tiktok"
						size={38}
						name={p.displayName}
						fontFamily={FONT}
						assets={assets}
						style={{ background: theme.avatarBg }}
					/>
				) : null}
				<div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', paddingTop: 2 }}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2, minWidth: 0 }}>
						<span
							data-part="name"
							data-template-param="displayName"
							style={{
								fontSize: 13,
								lineHeight: '19.5px',
								fontWeight: 500,
								color: theme.name,
								whiteSpace: 'nowrap',
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								minWidth: 0,
							}}
						>
							<TextWithEmoji text={p.displayName} fontSize={13} emoji={EMOJI} assets={assets} />
						</span>
						{p.verified ? (
							<Glyph glyph={TIKTOK_GLYPHS.verified} size={10} style={{ margin: '-1px 0 0 1px' }} />
						) : null}
					</div>
					<CommentText
						spans={text.spans}
						segments={text.segments}
						words={anim.words}
						colors={{ mention: LINK[p.theme], hashtag: LINK[p.theme] }}
						emoji={EMOJI}
						assets={assets}
						style={{
							margin: '2px 0 10px',
							fontSize: 14,
							fontWeight: 500,
							lineHeight: 1.25,
							color: theme.text,
						}}
					/>
					<div
						data-part="meta"
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'space-between',
							gap: 12.96,
							fontSize: 12.96,
							lineHeight: '19.44px',
							whiteSpace: 'nowrap',
						}}
					>
						<div style={{ minWidth: 0, overflow: 'hidden' }}>
							<span style={{ fontSize: 11, lineHeight: '16.5px', fontWeight: 500, color: theme.time }}>
								{formatTime(p.variant, p.timeValue, p.timeUnit)}
							</span>
							<span
								style={{
									marginLeft: 21,
									fontSize: 12,
									lineHeight: '18px',
									fontWeight: 600,
									color: theme.reply,
								}}
							>
								Reply
							</span>
						</div>
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 18,
								paddingLeft: 3.24,
								flexShrink: 0,
								color: theme.icons,
							}}
						>
							<div style={{ display: 'flex', alignItems: 'center' }}>
								<LikeHeart theme={p.theme} heart={anim.heart} color={theme.icons} />
								<span
									data-part="likes"
									style={{ marginLeft: 5, fontSize: 12, lineHeight: '18px', fontWeight: 500 }}
								>
									{formatCount(p.variant, anim.likes, 'likes')}
								</span>
							</div>
							<Glyph
								glyph={TIKTOK_GLYPHS.dislike}
								size={17}
								color={theme.icons}
								style={{ margin: '0 -0.7px' }}
							/>
						</div>
					</div>
					{replies ? (
						<div
							data-part="replies"
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 10,
								marginTop: 5,
								fontSize: 12,
								lineHeight: '18px',
								fontWeight: 600,
								color: theme.replies,
								whiteSpace: 'nowrap',
							}}
						>
							<div style={{ width: 23, height: 1, background: theme.rule, flexShrink: 0 }} />
							<span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
								{replies}
								<Glyph glyph={TIKTOK_GLYPHS.chevronDown} size={12} color={theme.replies} />
							</span>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

export const TIKTOK_REPLY: SocialVariantImpl = { Card: TikTokReplyCard, growOrigin: '0% 100%' };
export const TIKTOK_COMMENT: SocialVariantImpl = {
	Card: TikTokCommentCard,
	growOrigin: '0% 0%',
	// the card's 0 25px 50px -12px shadow: 50 − 12 = 38 px around, moved 25 px down
	bleed: { top: 13, right: 38, bottom: 63, left: 38 },
};
