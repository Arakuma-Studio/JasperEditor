// X card of social-comment@1 (`x-post`), drawn at tokcomment's CSS px (research/tokcomment-recon/ref/x-post:
// computed-style dumps of every element, light and dark) with X's real glyphs (glyphs.ts), Chirp (X's UI font, from
// the remote-asset manifest) and the live x.com measurements of 2026 where they differ from tokcomment (colours, the
// action bar's equal columns, counts at 400, zero counts hidden). Deliberate differences from tokcomment and the
// tokcomment bugs fixed are listed in docs/wp-notes/social-comments.md "X card".
import {
	avatarNameFor,
	formatCount,
	formatTime,
	REMOTE_IMAGE_IDS,
	SOCIAL_VARIANT_FONTS,
} from '@jasper/mg-templates';
import type { CSSProperties, ReactNode } from 'react';
import { editableParamProps } from '../editable.ts';
import { X_GLYPHS } from '../social/glyphs.ts';
import { AvatarPicture } from './assets.tsx';
import type { SocialCardAssets, SocialCardProps, SocialVariantImpl } from './contract.ts';
import { CommentText, type EmojiMetrics, Glyph, INK_RING, SocialAvatar, TextWithEmoji } from './parts.tsx';

const FONT = `"${SOCIAL_VARIANT_FONTS['x-post']!.family}", sans-serif`;

const r4 = (n: number) => (Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : 0);

/**
 * Apple emoji images (X shows the viewer's OS emoji since its 2026 web app: Apple on iPhone / Mac [M]) at 1.2 em,
 * placed like the captures' emoji glyph (2×: 34 × 32 px box, top within 1 px).
 */
const EMOJI: EmojiMetrics = { size: 1.2, shift: -0.22 };

/**
 * Colours: tokcomment `.twitter-wrapper` (styles_light_verified-on / styles_dark_verified-on.json) for the card;
 * [M] = x.com 2026 (research/platform-measurements, X) where the live page differs from tokcomment.
 */
const X_THEME = {
	light: {
		bg: '#FFFFFF',
		border: 'rgba(0, 0, 0, 0.05)',
		avatarBg: '#E5E7EB',
		name: '#000000', // [M] text-primary (tokcomment #0F0F0F)
		text: '#000000', // [M] (tokcomment #0F0F0F)
		secondary: 'rgba(0, 0, 0, 0.6)', // [M] --x-fg-secondary: handle, time, icons, counts (tokcomment #737479 / #767779)
		primary: '#000000', // [M] the header buttons (Grok, More)
	},
	dark: {
		bg: '#000000',
		border: 'rgba(255, 255, 255, 0.05)',
		avatarBg: '#1A1A1A',
		name: '#FFFFFF', // [M] (tokcomment #DADADA)
		text: '#FFFFFF',
		secondary: 'rgba(255, 255, 255, 0.6)', // [M] (tokcomment #737479 / #71767B / #767779)
		primary: '#FFFFFF', // [M] (tokcomment's dark ellipsis #71767B)
	},
} as const;

/** Mentions, hashtags and links: X's brand blue in both themes [M]. */
const LINK = '#1D9BF0';
/** The liked heart and its count: `--x-magenta-500` [M-css]. */
const LIKED = X_GLYPHS.likeFilled.defaultColor.light;

/** Avatar 52 px and a 12 px gap (tokcomment); the text column starts 64 px after the padding. */
const AVATAR = 52;
const AVATAR_GAP = 12;
/**
 * Text sizes: tokcomment's 14 px header and 16 px comment were rendered in the capture host's Liberation Sans; Chirp has
 * a lower cap height, so the sizes are scaled to keep the reference's cap heights (2× captures: "D" 19 px, "W" 22 px).
 */
const NAME_PX = 14;
const BODY_PX = 16;
/**
 * Chirp sits higher in its line box than the captures' font: the header's text moves 1 px down to keep the
 * reference's baseline (2× captures: cap tops at y = 32 – 33).
 */
const HEADER_SHIFT = 1;
/** Counts: 13 px / 400 on x.com [M] (tokcomment 12.96 px / 500). */
const COUNT_PX = 13;
/**
 * Action icons: X's 24-unit glyphs at 15 px draw the captures' ink (2×: 24–26 px for tokcomment's 14 px lucide icons
 * with their 2 px strokes).
 */
const ICON = 15;
/** The verified badge: 1 em of the name (x.com [M]); its 20.5-unit disc draws the captures' 12 px badge. */
const BADGE = 14;
/** Header buttons: Grok mark and "More", sized to the captures' ink (2×: 26 × 24 and 22 px wide). */
const GROK = 15;
const MORE = 15;

/** The share of an rgba / hex colour mixed toward `to` by `t` (0…1), for the liked count's colour. */
function mixColor(from: string, to: string, t: number): string {
	const parse = (c: string): [number, number, number, number] => {
		const m = /^rgba?\(([^)]+)\)$/.exec(c);
		if (m) {
			const [r = 0, g = 0, b = 0, a = 1] = m[1]!.split(',').map((v) => Number(v.trim()));
			return [r, g, b, a];
		}
		const h = c.replace('#', '');
		return [
			Number.parseInt(h.slice(0, 2), 16),
			Number.parseInt(h.slice(2, 4), 16),
			Number.parseInt(h.slice(4, 6), 16),
			1,
		];
	};
	const k = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
	if (k <= 0) return from;
	if (k >= 1) return to;
	const a = parse(from);
	const b = parse(to);
	const v = a.map((x, i) => x + (b[i]! - x) * k);
	return `rgba(${Math.round(v[0]!)}, ${Math.round(v[1]!)}, ${Math.round(v[2]!)}, ${r4(v[3]!)})`;
}

// ------------------------------------------------------------------------------------------- default avatar

/**
 * X's default profile picture (`default_profile_400x400.png`, recorded in glyphs.ts; a manifest image, delivered as
 * `imageUrls[REMOTE_IMAGE_IDS.xDefaultAvatar]`) as vectors, drawn while the raster is not resolved: a #CCD6DD field,
 * a #657786 head (a rounded square 152 × 165 at 124, 89) and shoulders (circle r 132 at 200, 410), measured on the
 * 400 px file (sha256 6d34bedb…).
 */
function XDefaultAvatar({ size, style }: { size: number; style?: CSSProperties }) {
	return (
		<div
			data-social-avatar="default"
			style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, ...style }}
		>
			<svg viewBox="0 0 400 400" width={size} height={size} aria-hidden="true" style={{ display: 'block' }}>
				<rect width="400" height="400" fill="#CCD6DD" />
				<path
					d="M124 161A76 72 0 0 1 200 89A76 72 0 0 1 276 161V204A70 50 0 0 1 206 254H194A70 50 0 0 1 124 204Z"
					fill="#657786"
				/>
				<circle cx="200" cy="410" r="132" fill="#657786" />
			</svg>
		</div>
	);
}

/**
 * The author's avatar: the picture, a generated one (initials from the display name) or X's default (the manifest
 * raster when the engine resolved it, else its vector twin above).
 */
function XAvatar({
	params,
	assets,
	style,
}: {
	params: SocialCardProps['params'];
	assets: SocialCardAssets;
	style: CSSProperties;
}) {
	if (params.avatar === null) {
		const url = assets.imageUrls[REMOTE_IMAGE_IDS.xDefaultAvatar];
		const box: CSSProperties = {
			width: AVATAR,
			height: AVATAR,
			borderRadius: '50%',
			flexShrink: 0,
			...style,
		};
		return url ? (
			// round by its own radius, not an `overflow: hidden` clip (see SocialAvatar: renderFrames = renderStill)
			<div data-social-avatar="default" style={box}>
				<AvatarPicture
					src={url}
					style={{ display: 'block', width: AVATAR, height: AVATAR, borderRadius: '50%' }}
				/>
			</div>
		) : (
			<XDefaultAvatar size={AVATAR} style={style} />
		);
	}
	return (
		<SocialAvatar
			avatar={params.avatar}
			platform="x"
			size={AVATAR}
			name={avatarNameFor(params.variant, params)}
			fontFamily={FONT}
			assets={assets}
			style={style}
		/>
	);
}

// ------------------------------------------------------------------------------------------------ actions

/** The like heart; while the like tick runs it thumps (`s`) and fills (`f`: outline → X's magenta heart). */
function LikeHeart({ heart, color }: { heart: SocialCardProps['anim']['heart']; color: string }) {
	if (!heart) return <Glyph glyph={X_GLYPHS.like} size={ICON} color={color} />;
	const f = Math.min(1, Math.max(0, heart.f));
	return (
		<span
			data-part="like-icon"
			style={{
				position: 'relative',
				display: 'block',
				width: ICON,
				height: ICON,
				flexShrink: 0,
				boxShadow: INK_RING,
				transform: `scale(${r4(heart.s)})`,
			}}
		>
			<Glyph
				glyph={X_GLYPHS.like}
				size={ICON}
				color={color}
				style={{ position: 'absolute', inset: 0, opacity: r4(1 - f) }}
			/>
			<Glyph
				glyph={X_GLYPHS.likeFilled}
				size={ICON}
				color={LIKED}
				style={{ position: 'absolute', inset: 0, opacity: r4(f) }}
			/>
		</span>
	);
}

/** Least space between a count and the next icon (App QA N6: a six-character repost count touched the heart). */
export const X_COUNT_GAP = 6;
/** Icon → count space: 8 px (tokcomment's `p-[0.5em]` icon box), 4 px when long counts need the room. */
const COUNT_INSET = 8;
const COUNT_INSET_TIGHT = 4;
/** Smallest count size when four long counts share the bar (x.com's 13 px otherwise). */
const COUNT_PX_MIN = 10;
/** The card's outer width (tokcomment), its border and side padding. */
const CARD_W = 420;
const CARD_INSET = 2 * 1 + 2 * 16;
/** The bookmark and share group after the four columns: two icons 12 px apart. */
const END_GROUP_GAP = 12;

/** Width of the four engagement columns: the text column minus the bookmark and share group. */
export function xActionsWidth(showProfile: boolean): number {
	return CARD_W - CARD_INSET - (showProfile ? AVATAR + AVATAR_GAP : 0) - (2 * ICON + END_GROUP_GAP);
}

/**
 * Upper bound of a count's advance in em: Chirp 400 measured in Chrome (digits 0.62 — tabular, "." 0.27, "," 0.28,
 * K 0.66, B 0.66, M 0.87) and the fallback face within the same bounds (test/social-x-fit.test.tsx measures both).
 */
export function xCountEm(text: string): number {
	let em = 0;
	for (const ch of text)
		em += /[0-9]/.test(ch)
			? 0.63
			: ch === '.' || ch === ','
				? 0.3
				: ch === 'M'
					? 0.88
					: ch === 'K' || ch === 'B'
						? 0.68
						: 0.9;
	return em;
}

export type XActionLayout = { countPx: number; inset: number; minWidths: number[] };

/**
 * Room of the four engagement columns for the widest count each can show (`''` = none): every column keeps its
 * icon, the icon → count space, the count and `X_COUNT_GAP` before the next icon (`minWidths`, CSS px; the columns
 * still share the bar equally when that is wider, as on x.com). When the counts need more than the bar, the
 * icon → count space tightens to 4 px, then the counts get smaller (never below 10 px) until they fit.
 */
export function xActionLayout(counts: readonly string[], showProfile: boolean): XActionLayout {
	const width = xActionsWidth(showProfile);
	const ems = counts.map(xCountEm);
	const totalEm = ems.reduce((a, b) => a + b, 0);
	const fixed = (inset: number) =>
		counts.reduce((a, c) => a + ICON + X_COUNT_GAP + (c === '' ? 0 : inset), 0);
	let inset = COUNT_INSET;
	let countPx = COUNT_PX;
	if (fixed(inset) + totalEm * countPx > width) inset = COUNT_INSET_TIGHT;
	if (fixed(inset) + totalEm * countPx > width && totalEm > 0)
		countPx = Math.max(COUNT_PX_MIN, Math.floor(((width - fixed(inset)) / totalEm) * 100) / 100);
	const minWidths = counts.map(
		(c, i) => Math.ceil((ICON + X_COUNT_GAP + (c === '' ? 0 : inset + ems[i]! * countPx)) * 100) / 100,
	);
	return { countPx, inset, minWidths };
}

/**
 * One engagement column: the icon and its count. x.com hides a zero count (the icon stays). The columns share the
 * row equally (x.com's `flex-1` columns) but never get narrower than their count needs (`xActionLayout`), so a
 * count keeps `X_COUNT_GAP` from the next icon; the column still clips as a last guard, so no count can push the
 * bookmark and share icons out of the card.
 */
function Engagement(p: {
	part: string;
	icon: ReactNode;
	count: string;
	color: string;
	minWidth: number;
	countPx: number;
	inset: number;
}) {
	return (
		<div
			data-part={`${p.part}-action`}
			style={{
				flex: '1 1 0',
				minWidth: p.minWidth,
				display: 'flex',
				alignItems: 'center',
				overflow: 'hidden',
			}}
		>
			{p.icon}
			{p.count !== '' ? (
				<span
					data-part={p.part}
					style={{
						marginLeft: p.inset,
						fontSize: p.countPx,
						lineHeight: '19.5px',
						fontWeight: 400,
						fontVariantNumeric: 'tabular-nums',
						color: p.color,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'clip',
						minWidth: 0,
					}}
				>
					{p.count}
				</span>
			) : null}
		</div>
	);
}

/** A count as x.com shows it: formatted ("1.2K"), and nothing for 0. */
const shownCount = (n: number, field: 'likes' | 'replies' | 'reposts' | 'views') =>
	n >= 1 ? formatCount('x-post', n, field) : '';

/**
 * The widest like count the clip shows: the like tick runs 0 → `likes` through "999", "999.9K" and "999.9M" when
 * the final count is past them, so the bar is laid out for the widest (it does not move while the count ticks).
 */
function widestLikes(likes: number): string {
	let widest = '';
	for (const n of [999, 999_999, 999_999_999, likes]) {
		const text = shownCount(Math.min(n, likes), 'likes');
		if (xCountEm(text) > xCountEm(widest)) widest = text;
	}
	return widest;
}

// ---------------------------------------------------------------------------------------------------- card

function XPostCard({ params: p, text, anim, assets }: SocialCardProps) {
	const theme = X_THEME[p.theme];
	const liked = anim.heart ? Math.min(1, Math.max(0, anim.heart.f)) : 0;
	const icon = (glyph: (typeof X_GLYPHS)[keyof typeof X_GLYPHS]) => (
		<Glyph glyph={glyph} size={ICON} color={theme.secondary} />
	);
	const counts = {
		replies: shownCount(p.replies, 'replies'),
		reposts: p.showReposts ? shownCount(p.reposts, 'reposts') : '',
		views: p.showViews ? shownCount(p.views, 'views') : '',
	};
	const bar = xActionLayout(
		[counts.replies, counts.reposts, widestLikes(p.likes), counts.views],
		p.showProfile,
	);
	const column = (i: number) => ({ minWidth: bar.minWidths[i]!, countPx: bar.countPx, inset: bar.inset });
	const secondary: CSSProperties = {
		fontSize: NAME_PX,
		lineHeight: '21px',
		fontWeight: 400,
		color: theme.secondary,
		position: 'relative',
		top: HEADER_SHIFT,
		whiteSpace: 'nowrap',
	};
	return (
		<div
			data-social-variant="x-post"
			style={{
				width: 420,
				boxSizing: 'border-box',
				background: theme.bg,
				padding: '10px 16px 8px',
				borderRadius: 1,
				border: `1px solid ${theme.border}`,
				boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
				fontFamily: FONT,
			}}
		>
			<div style={{ display: 'flex', gap: AVATAR_GAP, alignItems: 'flex-start' }}>
				{p.showProfile ? <XAvatar params={p} assets={assets} style={{ background: theme.avatarBg }} /> : null}
				<div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
					<div
						data-part="header"
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 4,
							marginBottom: 2,
							minWidth: 0,
							height: 21,
						}}
					>
						<span
							data-part="name"
							{...editableParamProps('displayName')}
							style={{
								fontSize: NAME_PX,
								lineHeight: '21px',
								fontWeight: 700,
								position: 'relative',
								top: HEADER_SHIFT,
								color: theme.name,
								whiteSpace: 'nowrap',
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								minWidth: 0,
								flexShrink: 1,
							}}
						>
							<TextWithEmoji text={p.displayName} fontSize={NAME_PX} emoji={EMOJI} assets={assets} />
						</span>
						{p.verified ? (
							<Glyph
								glyph={X_GLYPHS.verifiedBlue}
								size={BADGE}
								scope={assets.idScope}
								style={{ margin: '0 1px' }}
							/>
						) : null}
						<span
							data-part="handle"
							style={{
								...secondary,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								minWidth: 0,
								flexShrink: 1,
							}}
						>
							{'@'}
							<span {...editableParamProps('handle')}>
								<TextWithEmoji text={p.handle} fontSize={NAME_PX} emoji={EMOJI} assets={assets} />
							</span>
						</span>
						<span
							aria-hidden="true"
							style={{
								width: 2,
								height: 2,
								margin: '0 2px',
								borderRadius: '50%',
								background: theme.secondary,
								flexShrink: 0,
							}}
						/>
						<span data-part="time" style={{ ...secondary, flexShrink: 0 }}>
							{formatTime(p.variant, p.timeValue, p.timeUnit)}
						</span>
						<div
							style={{
								marginLeft: 'auto',
								paddingLeft: 12,
								display: 'flex',
								alignItems: 'center',
								gap: 8,
								flexShrink: 0,
							}}
						>
							<Glyph glyph={X_GLYPHS.grok} size={GROK} color={theme.primary} />
							<Glyph glyph={X_GLYPHS.more} size={MORE} color={theme.primary} />
						</div>
					</div>
					<CommentText
						spans={text.spans}
						segments={text.segments}
						words={anim.words}
						colors={{ mention: LINK, hashtag: LINK }}
						emoji={EMOJI}
						assets={assets}
						style={{
							marginBottom: 3,
							fontSize: BODY_PX,
							fontWeight: 400,
							lineHeight: '20px',
							color: theme.text,
						}}
					/>
					<div data-part="actions" style={{ display: 'flex', alignItems: 'center', height: 30 }}>
						<Engagement
							part="replies"
							icon={icon(X_GLYPHS.reply)}
							count={counts.replies}
							color={theme.secondary}
							{...column(0)}
						/>
						{/* showReposts off hides the count; the icon stays (the param's contract) */}
						<Engagement
							part="reposts"
							icon={icon(X_GLYPHS.repost)}
							count={counts.reposts}
							color={theme.secondary}
							{...column(1)}
						/>
						<Engagement
							part="likes"
							icon={<LikeHeart heart={anim.heart} color={theme.secondary} />}
							count={shownCount(anim.likes, 'likes')}
							color={mixColor(theme.secondary, LIKED, liked)}
							{...column(2)}
						/>
						{/* showViews off hides the count; the icon stays (the param's contract) */}
						<Engagement
							part="views"
							icon={icon(X_GLYPHS.views)}
							count={counts.views}
							color={theme.secondary}
							{...column(3)}
						/>
						<div
							data-part="end-actions"
							style={{ display: 'flex', alignItems: 'center', gap: END_GROUP_GAP, flexShrink: 0 }}
						>
							{icon(X_GLYPHS.bookmark)}
							{icon(X_GLYPHS.share)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

export const X_POST: SocialVariantImpl = {
	Card: XPostCard,
	// no tail: the card grows from the avatar's corner
	growOrigin: '0% 0%',
	// the card's 0 25px 50px -12px shadow (tokcomment): 50 − 12 = 38 px around, moved 25 px down
	bleed: { top: 13, right: 38, bottom: 63, left: 38 },
};
