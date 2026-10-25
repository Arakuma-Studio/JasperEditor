// Store review cards of social-comment@1 (design §11): Google Play, the App Store web / Mac card and the iPhone App
// Store app's Ratings & Reviews card. Blueprints (measurements in docs/wp-notes/social-comments.md "Store reviews"):
// - Play: the requester's screenshot, the 2018 Android Play Store app card, in dp (image px ÷ 3.525: Roboto 14 / 12 sp
//   fit the screenshot's text at that scale, and the card is a 411 dp phone minus 16 dp margins); glyphs and dark
//   colours from play.google.com today [M];
// - App Store web: the legacy apps.apple.com review card the requester's screenshot shows, in CSS px from archived
//   copies of the page (web.archive.org, 2021–2025) [M];
// - iPhone: the requester's screenshot (iOS ≤ 14 on a 390 pt iPhone; fonts fit 15 pt at 0.769 px/pt), in pt, with the
//   current apps.apple.com card (the same layout) for the star glyphs and colours [M] and Apple's system colours.
// The like-tick extra fills the stars one by one (`socialStarFill`) and pulses them with the thump (`anim.heart.s`).
// The long-review clamp (`truncate`) is measured from the laid-out text (like the stage's fit), before paint.
import {
	formatReviewAge,
	formatReviewDate,
	SOCIAL_STAR_COUNT,
	SOCIAL_VARIANT_FONTS,
	socialStarFill,
} from '@jasper/mg-templates';
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { editableParamProps } from '../editable.ts';
import { APP_STORE_GLYPHS, PLAY_STORE_GLYPHS, type PlatformGlyph } from '../social/glyphs.ts';
import type { SocialCardProps, SocialVariantImpl } from './contract.ts';
import { CommentText, type EmojiMetrics, Glyph, SocialAvatar, TextWithEmoji } from './parts.tsx';

const r3 = (n: number) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0);
const r4 = (n: number) => (Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : 0);
const fontOf = (variant: keyof typeof SOCIAL_VARIANT_FONTS, fallback: string) =>
	`"${SOCIAL_VARIANT_FONTS[variant]?.family ?? fallback}", ${fallback}, sans-serif`;

/** Emoji drawn as images of the clip's pack at 1.2 em, centred on the text (the TikTok calibration). */
const EMOJI: EmojiMetrics = { size: 1.2, shift: -0.22 };
/** Review text has no links on the stores: mentions and hashtags keep the text colour. */
const plain = (color: string) => ({ mention: color, hashtag: color });

// ------------------------------------------------------------------------------------------------- stars

/** Scale of the stars while the thump runs: a third of the heart's (1 → 1.1 → 1). */
function starPulse(heart: SocialCardProps['anim']['heart']): number {
	return heart ? r4(1 + (heart.s - 1) / 3) : 1;
}

/**
 * One rating star: the empty glyph, with the filled glyph over it clipped to `fill` of its width (0 … 1, left to right:
 * how the stores draw partial stars). `stretch` draws the glyph into the box without keeping its aspect (the legacy
 * App Store sprite).
 */
function Star(p: {
	empty: PlatformGlyph;
	filled: PlatformGlyph;
	emptyColor: string;
	filledColor: string;
	fill: number;
	width: number;
	height: number;
	stretch?: boolean;
	style?: CSSProperties;
}) {
	const f = Math.min(1, Math.max(0, Number.isFinite(p.fill) ? p.fill : 0));
	const glyph = (g: PlatformGlyph, color: string, style: CSSProperties) => (
		<svg
			viewBox={g.viewBox}
			width={p.width}
			height={p.height}
			preserveAspectRatio={p.stretch ? 'none' : undefined}
			aria-hidden="true"
			style={{ position: 'absolute', left: 0, top: 0, display: 'block', overflow: 'visible', ...style }}
		>
			{g.paths.map((path, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a glyph's paths are static and ordered
				<path key={i} d={path.d} fill={path.fill ?? color} fillRule={path.fillRule} />
			))}
		</svg>
	);
	return (
		<span
			data-star={f >= 1 ? 'filled' : f > 0 ? 'partial' : 'empty'}
			style={{
				position: 'relative',
				display: 'block',
				flexShrink: 0,
				width: p.width,
				height: p.height,
				...p.style,
			}}
		>
			{f < 1 ? glyph(p.empty, p.emptyColor, {}) : null}
			{f > 0
				? glyph(p.filled, p.filledColor, f < 1 ? { clipPath: `inset(0 ${r3((1 - f) * 100)}% 0 0)` } : {})
				: null}
		</span>
	);
}

/** The five stars of a rating (`socialStarFill` at the tick progress), pulsing with the thump. */
function StarRow(p: {
	rating: number;
	anim: SocialCardProps['anim'];
	star: (fill: number, i: number) => ReactNode;
	gap: number;
	style?: CSSProperties;
}) {
	const fill = socialStarFill(p.rating, p.anim.tick ?? 1);
	const s = starPulse(p.anim.heart);
	return (
		<span
			data-part="stars"
			role="img"
			aria-label={`${Math.round(p.rating)} of ${SOCIAL_STAR_COUNT} stars`}
			style={{
				display: 'flex',
				gap: p.gap,
				flexShrink: 0,
				transformOrigin: '0% 50%',
				transform: s === 1 ? undefined : `scale(${s})`,
				...p.style,
			}}
		>
			{fill.map((f, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the five star slots are fixed
				<span key={i} style={{ display: 'contents' }}>
					{p.star(f, i)}
				</span>
			))}
		</span>
	);
}

// ------------------------------------------------------------------------------------------------- clamp

/** What the clamp measured: the text overflows its lines, and where the last visible line's text ends (0 … 1). */
type ClampMeasure = { over: boolean; lastEnd: number };

/** Measurement passes per layout (never loops). */
const CLAMP_PASSES = 3;

/**
 * Long-review clamp: the text block cut after `lines` lines (`truncate`), and `overflow(m)` drawn over the box when it
 * was cut (Play's fade, the App Store's "more"). Measured with layout boxes (`offset*`: unaffected by the entrance
 * transforms, the word-reveal scales and the stage zoom, as fractions of the box) in a layout effect, so every frame —
 * Player, still or export — is drawn with the measured clamp. `mask` is the CSS mask of the cut text (App Store).
 */
function ClampBox(p: {
	truncate: boolean;
	lines: number;
	lineHeight: number;
	layoutKey: string;
	mask?: string;
	overflow: (m: ClampMeasure) => ReactNode;
	children: ReactNode;
}) {
	const box = useRef<HTMLDivElement>(null);
	const [m, setM] = useState<{ key: string; passes: number } & ClampMeasure>({
		key: '',
		passes: 0,
		over: false,
		lastEnd: 1,
	});
	const key = `${p.layoutKey}|${p.truncate}|${p.lines}|${p.lineHeight}`;
	const current = m.key === key ? m : { key, passes: 0, over: false, lastEnd: 1 };
	useLayoutEffect(() => {
		const el = box.current;
		const text = el?.firstElementChild as HTMLElement | null;
		if (!el || !text || current.passes >= CLAMP_PASSES) return;
		const over = p.truncate && text.offsetHeight > el.clientHeight + 0.5;
		let lastEnd = 1;
		if (over && el.clientHeight > 0 && text.offsetWidth > 0) {
			const line = el.clientHeight / p.lines;
			let right = 0;
			for (const u of Array.from(text.querySelectorAll<HTMLElement>('[data-unit]'))) {
				const mid = u.offsetTop - text.offsetTop + u.offsetHeight / 2;
				if (Math.floor(mid / line) === p.lines - 1)
					right = Math.max(right, u.offsetLeft - text.offsetLeft + u.offsetWidth);
			}
			lastEnd = r4(Math.min(1, right / text.offsetWidth));
		}
		if (m.key !== key || over !== m.over || Math.abs(lastEnd - m.lastEnd) > 1e-3)
			setM({ key, passes: current.passes + 1, over, lastEnd });
	});
	const clipped = p.truncate && current.over;
	return (
		<div
			ref={box}
			data-part="clamp"
			data-clamped={clipped ? 'true' : undefined}
			style={{
				position: 'relative',
				maxHeight: p.truncate ? p.lines * p.lineHeight : undefined,
				overflow: p.truncate ? 'hidden' : undefined,
			}}
		>
			<div
				style={
					clipped && p.mask
						? {
								WebkitMaskImage: p.mask,
								maskImage: p.mask,
								WebkitMaskSize: '100% 100%',
								maskSize: '100% 100%',
							}
						: undefined
				}
			>
				{p.children}
			</div>
			{clipped ? p.overflow(current) : null}
		</div>
	);
}

// --------------------------------------------------------------------------------------------- Google Play

/** The 2018 Play app card [screenshot] in light; Play's current dark theme tokens (`body.P9KVBf`) in dark [M-css]. */
const PLAY_THEME = {
	light: {
		bg: '#FFFFFF',
		border: '#E1E1E1',
		name: '#212121',
		text: '#616161',
		meta: '#616161',
		more: '#616161',
		starOn: '#479B5F',
		starOff: '#BABABA',
	},
	dark: {
		bg: '#202124',
		border: '#3C4043',
		name: '#E8EAED',
		text: '#9AA0A6',
		meta: '#9AA0A6',
		more: '#9AA0A6',
		starOn: '#00A173',
		starOff: '#3C4043',
	},
} as const;

const PLAY_FONT = fontOf('play-store-review', 'Roboto');
/** Card width: a 411 dp phone minus 16 dp margins (the screenshot's 1338 px ÷ 3.525). */
const PLAY_W = 380;
const PLAY_LINE = 22.27;
/** Lines of a clamped review (the screenshot's three, the last fading). */
const PLAY_LINES = 3;
/** The fade over the end of the last line: from 29.8 dp before the text's end to 2.6 dp after it [screenshot]. */
const PLAY_FADE = { before: 29.8, after: 2.6 };
/** The star's ink inside Material's 24-unit box (x 2–22, y 2–21.02): the screenshot draws the ink 11.63 dp wide. */
const PLAY_STAR_BOX = '2 2 20 19.02';

function PlayStoreCard({ params: p, text, anim, assets }: SocialCardProps) {
	const theme = PLAY_THEME[p.theme];
	const star: PlatformGlyph = { ...PLAY_STORE_GLYPHS.star, viewBox: PLAY_STAR_BOX };
	const date = formatReviewDate('play-store', p.date);
	return (
		<div
			data-social-variant="play-store-review"
			style={{
				width: PLAY_W,
				boxSizing: 'border-box',
				background: theme.bg,
				border: `1px solid ${theme.border}`,
				borderRadius: 4,
				padding: '15px 15px 17px',
				fontFamily: PLAY_FONT,
			}}
		>
			<div data-part="header" style={{ display: 'flex', alignItems: 'center', height: 32 }}>
				{p.showProfile ? (
					<SocialAvatar
						avatar={p.avatar}
						platform="play-store"
						size={32}
						name={p.displayName}
						fontFamily={PLAY_FONT}
						assets={assets}
						style={{ marginRight: 16 }}
					/>
				) : null}
				<span
					data-part="name"
					{...editableParamProps('displayName')}
					style={{
						flex: '0 1 auto',
						minWidth: 0,
						fontSize: 14,
						lineHeight: '20px',
						fontWeight: 500,
						color: theme.name,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					}}
				>
					<TextWithEmoji text={p.displayName} fontSize={14} emoji={EMOJI} assets={assets} />
				</span>
				<span style={{ flex: 1 }} />
				<Glyph
					glyph={PLAY_STORE_GLYPHS.more}
					size={21}
					color={theme.more}
					style={{ marginRight: -2.1, flexShrink: 0 }}
				/>
			</div>
			<div
				data-part="rating"
				style={{ display: 'flex', alignItems: 'baseline', marginTop: 14.5, height: 20, lineHeight: '20px' }}
			>
				<StarRow
					rating={p.rating}
					anim={anim}
					gap={2.13}
					star={(f) => (
						<Star
							empty={star}
							filled={star}
							emptyColor={theme.starOff}
							filledColor={theme.starOn}
							fill={f}
							width={11.63}
							height={11.06}
						/>
					)}
				/>
				{date ? (
					<span
						data-part="date"
						style={{ marginLeft: 6.8, fontSize: 12, color: theme.meta, whiteSpace: 'nowrap' }}
					>
						{date}
					</span>
				) : null}
			</div>
			<div style={{ marginTop: 6.1 }}>
				<ClampBox
					truncate={p.truncate}
					lines={PLAY_LINES}
					lineHeight={PLAY_LINE}
					layoutKey={p.text}
					overflow={(m) => (
						<span
							data-part="fade"
							style={{
								position: 'absolute',
								top: `${r3(((PLAY_LINES - 1) / PLAY_LINES) * 100)}%`,
								height: `${r3(100 / PLAY_LINES)}%`,
								left: `calc(${r3(m.lastEnd * 100)}% - ${PLAY_FADE.before}px)`,
								width: PLAY_FADE.before + PLAY_FADE.after + 8,
								background: `linear-gradient(to right, ${theme.bg}00 0, ${theme.bg} ${PLAY_FADE.before + PLAY_FADE.after}px)`,
							}}
						/>
					)}
				>
					<CommentText
						spans={text.spans}
						segments={text.segments}
						words={anim.words}
						colors={plain(theme.text)}
						emoji={EMOJI}
						assets={assets}
						style={{ fontSize: 14, lineHeight: `${PLAY_LINE}px`, fontWeight: 400, color: theme.text }}
					/>
				</ClampBox>
			</div>
		</div>
	);
}

// ----------------------------------------------------------------------------------------- App Store web

/**
 * The legacy apps.apple.com card [M, archived]. It had no dark mode; the Mac App Store has one: dark uses the current
 * apps.apple.com dark tokens (card rgba(255,255,255,.05) on #151515, text .92 / .64 white, orange #FF9F0A) [M-css] and
 * an estimated empty-star grey [E].
 */
const WEB_THEME = {
	light: {
		bg: '#F8F8F8',
		meta: '#636366',
		title: '#1D1D1F',
		text: '#1D1D1F',
		more: '#0070C9',
		starOn: '#FF9500',
		starOff: '#BFBFBF',
	},
	dark: {
		bg: '#202020',
		meta: 'rgba(255, 255, 255, 0.64)',
		title: 'rgba(255, 255, 255, 0.92)',
		text: 'rgba(255, 255, 255, 0.92)',
		more: '#0A84FF',
		starOn: '#FF9F0A',
		starOff: '#5A5A5E',
	},
} as const;

const APPLE_FONT = fontOf('app-store-review', 'SF Pro Text');
const WEB_W = 314;
const WEB_LINE = 18;
const WEB_LINES = 4;
/** The legacy clamp mask: the last line hidden under "more" (32.8 px) and fading in over 36 px (2 lines) [M]. */
const WEB_MASK = `linear-gradient(0deg, #0000 0, #0000 ${WEB_LINE}px, #000 ${WEB_LINE}px), linear-gradient(270deg, #0000 0, #0000 32.8px, #000 68.8px)`;

function AppStoreWebCard({ params: p, text, anim, assets }: SocialCardProps) {
	const theme = WEB_THEME[p.theme];
	const date = formatReviewDate('app-store', p.date);
	return (
		<div
			data-social-variant="app-store-review"
			style={{
				width: WEB_W,
				minHeight: 184,
				boxSizing: 'border-box',
				background: theme.bg,
				borderRadius: 6,
				padding: '13px 16px 16px',
				fontFamily: APPLE_FONT,
			}}
		>
			<div style={{ height: 30, marginBottom: 3 }}>
				<StarRow
					rating={p.rating}
					anim={anim}
					gap={0}
					star={(f) => (
						<Star
							empty={APP_STORE_GLYPHS.legacyStarEmpty}
							filled={APP_STORE_GLYPHS.legacyStar}
							emptyColor={theme.starOff}
							filledColor={theme.starOn}
							fill={f}
							width={24}
							height={25}
							stretch
						/>
					)}
				/>
			</div>
			<div
				data-part="byline"
				style={{
					display: 'flex',
					fontSize: 12,
					lineHeight: '16px',
					fontWeight: 600,
					color: theme.meta,
					marginBottom: 15,
					whiteSpace: 'nowrap',
				}}
			>
				<span
					data-part="name"
					{...editableParamProps('displayName')}
					style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
				>
					<TextWithEmoji text={p.displayName} fontSize={12} emoji={EMOJI} assets={assets} />
				</span>
				{date ? <span style={{ flexShrink: 0, whiteSpace: 'pre' }}>{`, ${date}`}</span> : null}
			</div>
			{p.title ? (
				<div
					data-part="title"
					{...editableParamProps('title')}
					style={{
						fontSize: 13,
						lineHeight: '18px',
						fontWeight: 600,
						letterSpacing: '-0.005em',
						color: theme.title,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					}}
				>
					<TextWithEmoji text={p.title} fontSize={13} emoji={EMOJI} assets={assets} />
				</div>
			) : null}
			<ClampBox
				truncate={p.truncate}
				lines={WEB_LINES}
				lineHeight={WEB_LINE}
				layoutKey={`${p.text}|${p.title}`}
				mask={WEB_MASK}
				overflow={() => (
					<span
						data-part="more"
						style={{
							position: 'absolute',
							right: 0,
							bottom: 0,
							fontSize: 13,
							lineHeight: `${WEB_LINE}px`,
							fontWeight: 400,
							color: theme.more,
						}}
					>
						more
					</span>
				)}
			>
				<CommentText
					spans={text.spans}
					segments={text.segments}
					words={anim.words}
					colors={plain(theme.text)}
					emoji={EMOJI}
					assets={assets}
					style={{
						fontSize: 13,
						lineHeight: `${WEB_LINE}px`,
						fontWeight: 400,
						letterSpacing: '-0.005em',
						color: theme.text,
						wordBreak: 'break-word',
					}}
				/>
			</ClampBox>
		</div>
	);
}

// --------------------------------------------------------------------------------------------- iPhone app

/** iOS system colours: secondarySystemBackground-like card (systemGray6), label, secondaryLabel, systemOrange, tint. */
const IOS_THEME = {
	light: {
		bg: '#F2F2F7',
		title: '#000000',
		text: '#000000',
		meta: 'rgba(60, 60, 67, 0.6)',
		star: '#FF9500',
		more: '#007AFF',
	},
	dark: {
		bg: '#1C1C1E',
		title: '#FFFFFF',
		text: '#FFFFFF',
		meta: 'rgba(235, 235, 245, 0.6)',
		star: '#FF9F0A',
		more: '#0A84FF',
	},
} as const;

const IOS_FONT = fontOf('app-store-review-ios', 'SF Pro Text');
/** Card width: a 390 pt iPhone minus 20 pt margins (the screenshot's 268 px at 0.769 px/pt). */
const IOS_W = 350;
const IOS_LINE = 20;
/** A clamped review (the product page's card; the "See All" list of the screenshot shows the whole text). */
const IOS_LINES = 5;
/** The clamp mask of the current App Store card (the same layout): the last line under "more", fading over 32 px [M]. */
const IOS_MASK = `linear-gradient(0deg, #0000 0, #0000 ${IOS_LINE}px, #000 ${IOS_LINE}px), linear-gradient(270deg, #0000 0, #0000 36px, #000 68px)`;

function AppStoreIosCard({ params: p, text, anim, assets }: SocialCardProps) {
	const theme = IOS_THEME[p.theme];
	const meta: CSSProperties = {
		fontSize: 15,
		lineHeight: `${IOS_LINE}px`,
		fontWeight: 400,
		color: theme.meta,
		whiteSpace: 'nowrap',
	};
	return (
		<div
			data-social-variant="app-store-review-ios"
			style={{
				width: IOS_W,
				boxSizing: 'border-box',
				background: theme.bg,
				borderRadius: 8,
				padding: '12.6px 20px 20px',
				fontFamily: IOS_FONT,
			}}
		>
			<div data-part="header" style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
				<div
					data-part="title"
					{...(p.title ? editableParamProps('title') : {})}
					style={{
						flex: '1 1 auto',
						minWidth: 0,
						fontSize: 15,
						lineHeight: `${IOS_LINE}px`,
						fontWeight: 600,
						color: theme.title,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					}}
				>
					{p.title ? <TextWithEmoji text={p.title} fontSize={15} emoji={EMOJI} assets={assets} /> : ' '}
				</div>
				<span data-part="date" style={{ ...meta, flexShrink: 0 }}>
					{formatReviewAge(p.timeValue, p.timeUnit, p.edited)}
				</span>
			</div>
			<div
				data-part="rating"
				style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 3.4, height: IOS_LINE }}
			>
				<StarRow
					rating={p.rating}
					anim={anim}
					gap={2}
					style={{ marginTop: 1.2 }}
					star={(f) => (
						<Star
							empty={APP_STORE_GLYPHS.starOutline}
							filled={APP_STORE_GLYPHS.star}
							emptyColor={theme.star}
							filledColor={theme.star}
							fill={f}
							width={13}
							height={13}
						/>
					)}
				/>
				<span style={{ flex: 1 }} />
				<span
					data-part="name"
					{...editableParamProps('displayName')}
					style={{ ...meta, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
				>
					<TextWithEmoji text={p.displayName} fontSize={15} emoji={EMOJI} assets={assets} />
				</span>
			</div>
			<div style={{ marginTop: 12.5 }}>
				<ClampBox
					truncate={p.truncate}
					lines={IOS_LINES}
					lineHeight={IOS_LINE}
					layoutKey={p.text}
					mask={IOS_MASK}
					overflow={() => (
						<span
							data-part="more"
							style={{
								position: 'absolute',
								right: 0,
								bottom: 0,
								fontSize: 15,
								lineHeight: `${IOS_LINE}px`,
								fontWeight: 400,
								color: theme.more,
							}}
						>
							more
						</span>
					)}
				>
					<CommentText
						spans={text.spans}
						segments={text.segments}
						words={anim.words}
						colors={plain(theme.text)}
						emoji={EMOJI}
						assets={assets}
						style={{ fontSize: 15, lineHeight: `${IOS_LINE}px`, fontWeight: 400, color: theme.text }}
					/>
				</ClampBox>
			</div>
		</div>
	);
}

export const PLAY_STORE_REVIEW: SocialVariantImpl = { Card: PlayStoreCard, growOrigin: '0% 0%' };
export const APP_STORE_REVIEW: SocialVariantImpl = { Card: AppStoreWebCard, growOrigin: '0% 0%' };
export const APP_STORE_REVIEW_IOS: SocialVariantImpl = { Card: AppStoreIosCard, growOrigin: '0% 0%' };
