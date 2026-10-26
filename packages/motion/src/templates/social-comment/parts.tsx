// Shared parts of the social-comment cards: platform glyphs (icons, badges), avatars (picture, generated, platform
// default), the comment text (word marks, mention / hashtag colours, emoji images, word reveal) and plain text with
// emoji (names). Inline styles only (D-14); sizes in the card's reference px.
import {
	type CommentSpan,
	generatedAvatar,
	SOCIAL_DEFAULT_AVATAR_IMAGES,
	type SocialAvatar as SocialAvatarParam,
	type SocialTextSegment,
	splitEmoji,
} from '@jasper/mg-templates';
import type { CSSProperties, ReactNode } from 'react';
import { editableParamProps } from '../editable.ts';
import { PLATFORM_DEFAULT_AVATARS, type PlatformGlyph, type SocialPlatform } from '../social/glyphs.ts';
import { AvatarPicture, EmojiGlyph } from './assets.tsx';
import type { SocialCardAssets, SocialWordValues } from './contract.ts';
import { VectorImage } from './vector.tsx';

const r3 = (n: number) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0);

/**
 * A platform glyph (glyphs.ts) as a vector image (`VectorImage`: rasterized whole, the same in every render): paths in
 * order, the `currentColor` paths in `color` (default black), fixed fills and gradients kept.
 */
export function Glyph(p: {
	glyph: PlatformGlyph;
	/** Square size, or `[width, height]` in px. */
	size: number | readonly [number, number];
	color?: string;
	/** Kept for callers; an image's gradient ids are its own, so no scoping is needed. */
	scope?: string;
	style?: CSSProperties;
}) {
	const g = p.glyph;
	const [w, h] = typeof p.size === 'number' ? [p.size, p.size] : p.size;
	return (
		<VectorImage
			name="glyph"
			viewBox={g.viewBox}
			width={w}
			height={h}
			paths={g.paths.map((path) => ({
				d: path.d,
				fill: path.fill ?? p.color ?? '#000000',
				...(path.fillRule ? { fillRule: path.fillRule } : {}),
				...(path.fillOpacity !== undefined ? { fillOpacity: path.fillOpacity } : {}),
			}))}
			{...(g.gradients?.length ? { gradients: g.gradients } : {})}
			{...(p.style ? { style: p.style } : {})}
		/>
	);
}

/** A neutral head-and-shoulders figure (generated avatars without initials, platforms without a default avatar). */
function Silhouette({ size, color }: { size: number; color: string }) {
	return (
		<VectorImage
			name="silhouette"
			viewBox="0 0 48 48"
			width={size}
			height={size}
			paths={[
				{ d: 'M15.5 19a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0 -17 0Z', fill: color },
				{ d: 'M8.3 42.1a18 18 0 0 1 31.4 0A23.9 23.9 0 0 1 24 48a23.9 23.9 0 0 1-15.7-5.9Z', fill: color },
			]}
		/>
	);
}

/**
 * The avatar of a card, `size` px round: the user's picture (`{ mediaId }`, from `assets.mediaUrls`; a missing medium
 * shows a visible placeholder), a generated one (`{ generated: seed }`: gradient with initials or a silhouette, see
 * `generatedAvatar`), or the platform's default (`null`): TikTok's own vector, the raster X / YouTube defaults when
 * their image is resolved, otherwise a grey silhouette.
 */
export function SocialAvatar(p: {
	avatar: SocialAvatarParam;
	platform: SocialPlatform;
	size: number;
	/** Name the initials of a generated avatar come from. */
	name: string;
	fontFamily: string;
	assets: SocialCardAssets;
	style?: CSSProperties;
}) {
	const box: CSSProperties = {
		width: p.size,
		height: p.size,
		// no `overflow: hidden` clip: every avatar is round by itself (the picture by its own radius, the glyphs are
		// discs). A rounded clip inside the scaled / rotated entrance made Chrome rasterize the avatar edge differently
		// depending on the frames visited before (renderStill ≠ renderFrames on ~70 px, S11:ANM-014).
		borderRadius: '50%',
		flexShrink: 0,
		...p.style,
	};
	const a = p.avatar;
	if (a && 'mediaId' in a)
		return <AvatarPicture src={p.assets.mediaUrls[a.mediaId]} style={{ ...box, objectFit: 'cover' }} />;
	if (a && 'generated' in a) {
		const g = generatedAvatar(a.generated, p.name);
		return (
			<div
				data-social-avatar="generated"
				style={{
					...box,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					background: `linear-gradient(${g.background.angleDeg}deg, ${g.background.from}, ${g.background.to})`,
				}}
			>
				{g.style === 'initials' ? (
					<span
						style={{
							color: g.foreground,
							fontFamily: p.fontFamily,
							fontWeight: 600,
							fontSize: r3(p.size * (g.initials.length > 1 ? 0.38 : 0.44)),
							lineHeight: 1,
							letterSpacing: 0,
							whiteSpace: 'nowrap',
						}}
					>
						{g.initials}
					</span>
				) : (
					<Silhouette size={p.size} color={g.foreground} />
				)}
			</div>
		);
	}
	const def = PLATFORM_DEFAULT_AVATARS[p.platform];
	if (def.kind === 'glyph')
		return (
			<div data-social-avatar="default" style={box}>
				<Glyph glyph={def.glyph} size={p.size} scope={p.assets.idScope} />
			</div>
		);
	const silhouette = (
		<div data-social-avatar="default" style={{ ...box, background: '#D0D1D3' }}>
			<Silhouette size={p.size} color="rgba(255, 255, 255, 0.75)" />
		</div>
	);
	if (def.kind === 'remote') {
		// the manifest image (`requiredAssets().images`); not available yet: the silhouette (the layer marks it)
		const id = SOCIAL_DEFAULT_AVATAR_IMAGES[p.platform];
		const url = id ? p.assets.imageUrls[id] : undefined;
		return url ? (
			<AvatarPicture src={url} style={{ ...box, objectFit: 'cover' }} fallback={silhouette} />
		) : (
			silhouette
		);
	}
	return silhouette;
}

/** Side bearing of an emoji image (em): adjacent emoji keep a hairline gap, as OS emoji glyphs do. */
const EMOJI_GAP = 0.03;

/** Emoji drawing inside a text run: image size and baseline shift as fractions of the font size. */
export type EmojiMetrics = { size: number; shift: number };

/** Plain text with its emoji drawn as images (names, labels). */
export function TextWithEmoji(p: {
	text: string;
	fontSize: number;
	emoji: EmojiMetrics;
	assets: SocialCardAssets;
}): ReactNode {
	return splitEmoji(p.text).map((piece, i) =>
		piece.kind === 'text' ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: pieces of a static string
			<span key={i}>{piece.text}</span>
		) : (
			<EmojiGlyph
				// biome-ignore lint/suspicious/noArrayIndexKey: pieces of a static string
				key={i}
				grapheme={piece.grapheme}
				size={r3(p.fontSize * p.emoji.size)}
				assets={p.assets}
				style={{
					verticalAlign: `${r3(p.emoji.shift * p.fontSize)}px`,
					margin: `0 ${r3(EMOJI_GAP * p.fontSize)}px`,
				}}
			/>
		),
	);
}

/**
 * A transparent ring that widens an animated element's ink overflow by 3 px. Chrome repaints a transformed element
 * within its ink rect; without the ring the anti-aliased edges just outside it kept the previous frame's pixels, so a
 * frame painted after an animation differed from the same frame painted alone (renderFrames ≠ renderStill,
 * S11:ANM-014). Every element a card transforms per frame carries it.
 */
export const INK_RING = '0 0 0 3px transparent';

const q3 = (n: number | undefined, d: number) =>
	n !== undefined && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : d;

/**
 * The style of an element a card animates per frame (scale `s`, opacity `o`, drop `y` px, tilt `r` deg): while it
 * moves, its transform, opacity and `INK_RING`; at rest NOTHING, so the rest state is the un-animated DOM (S11:ANM-009)
 * and no transform left over from an earlier frame (a hair off identity, `rotate(-0.003deg)`) can keep Chrome from
 * repainting it: every rest frame paints the same however it is reached (renderFrames = renderStill).
 */
export function motionStyle(
	v: { s?: number; o?: number; y?: number; r?: number },
	origin?: string,
): CSSProperties {
	const s = q3(v.s, 1);
	const o = q3(v.o, 1);
	const y = q3(v.y, 0);
	const r = q3(v.r, 0);
	if (s === 1 && o === 1 && y === 0 && r === 0) return {};
	const transform = [
		y !== 0 ? `translateY(${y}px)` : '',
		r !== 0 ? `rotate(${r}deg)` : '',
		s !== 1 ? `scale(${s})` : '',
	]
		.filter(Boolean)
		.join(' ');
	return {
		boxShadow: INK_RING,
		...(transform ? { transform, ...(origin ? { transformOrigin: origin } : {}) } : {}),
		...(o !== 1 ? { opacity: o } : {}),
	};
}

/** tokcomment's highlight pill: #FFE500, black text, 6 px radius, padding .05em .35em (one pill per run). */
export const HIGHLIGHT_STYLE: CSSProperties = {
	background: '#FFE500',
	color: '#000000',
	borderRadius: 6,
	padding: '0.05em 0.35em',
	boxDecorationBreak: 'clone',
	WebkitBoxDecorationBreak: 'clone',
};

/**
 * tokcomment's blur mark, `blur(4px)` at reference size (the card's zoom scales it with the card). Drawn as a text
 * shadow of the same Gaussian (a shadow blur radius is twice the standard deviation: 8 px) under transparent glyphs:
 * a CSS `filter` on the words made Chrome composite them, and a frame painted after an entrance then differed from the
 * same frame painted alone (renderFrames ≠ renderStill, S11:ANM-014). Emoji inside a blurred word keep the filter.
 */
export const BLUR_PX = 4;
const BLURRED_TEXT_STYLE: CSSProperties = {
	WebkitTextFillColor: 'transparent',
	textShadow: `0 0 ${2 * BLUR_PX}px currentColor`,
};

type Piece = CommentSpan & { start: number };

/** The spans overlapping `[start, end)` of the visible text, cut to it. */
function piecesOf(spans: readonly Piece[], start: number, end: number): Piece[] {
	const out: Piece[] = [];
	for (const sp of spans) {
		const a = Math.max(start, sp.start);
		const b = Math.min(end, sp.start + sp.text.length);
		if (b > a) out.push({ ...sp, text: sp.text.slice(a - sp.start, b - sp.start), start: a });
	}
	return out;
}

/**
 * The comment text: whitespace runs as text (they wrap), word units as spans (inline-block, popping, while word
 * reveal runs), each cut into its styled spans:
 * - highlight: tokcomment's yellow pill; a unit that is one highlighted run carries one pill;
 * - blur: the glyphs blurred like `blur(4px)` (a text shadow under transparent glyphs); remove: invisible, the gap kept;
 * - mentions / hashtags in the variant's colours (black inside a highlight);
 * - emoji as images of the clip's pack (`emoji` metrics relative to the font size).
 * `style` is the text block's style (font, size, line height, colour); its `fontSize` must be a number.
 */
export function CommentText(p: {
	spans: readonly CommentSpan[];
	segments: readonly SocialTextSegment[];
	words: readonly SocialWordValues[] | null;
	colors: { mention: string; hashtag: string };
	emoji: EmojiMetrics;
	assets: SocialCardAssets;
	style: CSSProperties & { fontSize: number };
}) {
	let offset = 0;
	const spans: Piece[] = p.spans.map((sp) => {
		const piece = { ...sp, start: offset };
		offset += sp.text.length;
		return piece;
	});
	const fontSize = p.style.fontSize;
	const emojiPx = r3(fontSize * p.emoji.size);
	const emojiStyle: CSSProperties = {
		verticalAlign: `${r3(p.emoji.shift * fontSize)}px`,
		margin: `0 ${r3(EMOJI_GAP * fontSize)}px`,
	};
	const drawPiece = (piece: Piece, inPill: boolean, key: string) => {
		const style: CSSProperties = {};
		if (!inPill && piece.mark !== 'highlight' && piece.role !== 'plain') style.color = p.colors[piece.role];
		if (piece.mark === 'highlight' && !inPill) Object.assign(style, HIGHLIGHT_STYLE);
		if (piece.mark === 'blur') Object.assign(style, BLURRED_TEXT_STYLE);
		if (piece.mark === 'remove') style.opacity = 0;
		return (
			<span key={key} data-mark={piece.mark === 'none' ? undefined : piece.mark} style={style}>
				{splitEmoji(piece.text).map((e, i) =>
					e.kind === 'text' ? (
						e.text
					) : (
						<EmojiGlyph
							// biome-ignore lint/suspicious/noArrayIndexKey: pieces of a static string
							key={i}
							grapheme={e.grapheme}
							size={emojiPx}
							assets={p.assets}
							style={piece.mark === 'blur' ? { ...emojiStyle, filter: `blur(${BLUR_PX}px)` } : emojiStyle}
						/>
					),
				)}
			</span>
		);
	};
	return (
		<div
			// Program-monitor inline editing (WP7b): the element whose box is the visible comment, marks-aware
			{...editableParamProps('text', { marks: true })}
			style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...p.style }}
		>
			{p.segments.map((seg) => {
				const key = `o${seg.start}`;
				const pieces = piecesOf(spans, seg.start, seg.start + seg.text.length);
				if (seg.unit < 0) return <span key={key}>{pieces.map((pc) => pc.text).join('')}</span>;
				const v = p.words?.[seg.unit];
				const unitStyle: CSSProperties = seg.highlight ? { ...HIGHLIGHT_STYLE } : {};
				if (v) {
					// inline-block whenever word reveal is on (the layout never changes between frames); animated until rest
					unitStyle.display = 'inline-block';
					unitStyle.maxWidth = '100%';
					Object.assign(unitStyle, motionStyle(v));
				}
				return (
					<span key={key} data-unit={seg.unit} style={unitStyle}>
						{pieces.map((pc, i) => drawPiece(pc, seg.highlight, `${key}-${i}`))}
					</span>
				);
			})}
		</div>
	);
}
