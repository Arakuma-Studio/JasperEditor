// Shared parts of the social-comment cards: platform glyphs (icons, badges), avatars (picture, generated, platform
// default), the comment text (word marks, mention / hashtag colours, emoji images, word reveal) and plain text with
// emoji (names). Inline styles only (D-14); sizes in the card's reference px.
import {
	type CommentSpan,
	generatedAvatar,
	type SocialAvatar as SocialAvatarParam,
	type SocialTextSegment,
} from '@jasper/mg-templates';
import type { CSSProperties, ReactNode } from 'react';
import {
	PLATFORM_DEFAULT_AVATARS,
	type PlatformGlyph,
	type SocialPlatform,
	scopeGlyphIds,
} from '../social/glyphs.ts';
import { AvatarPicture, EmojiGlyph, splitEmojiPieces } from './assets.tsx';
import type { SocialCardAssets, SocialWordValues } from './contract.ts';

const r3 = (n: number) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0);

/**
 * A platform glyph (glyphs.ts) as inline SVG: paths in order, `currentColor` paths in `color`, fixed fills kept,
 * gradients scoped per instance (`scope`, SVG ids are document-global).
 */
export function Glyph(p: {
	glyph: PlatformGlyph;
	/** Square size, or `[width, height]` in px. */
	size: number | readonly [number, number];
	color?: string;
	scope?: string;
	style?: CSSProperties;
}) {
	const g = p.scope && p.glyph.gradients?.length ? scopeGlyphIds(p.glyph, p.scope) : p.glyph;
	const [w, h] = typeof p.size === 'number' ? [p.size, p.size] : p.size;
	return (
		<svg
			viewBox={g.viewBox}
			width={w}
			height={h}
			aria-hidden="true"
			style={{ display: 'block', flexShrink: 0, overflow: 'visible', color: p.color, ...p.style }}
		>
			{g.gradients?.length ? (
				<defs>
					{g.gradients.map((gr) => (
						<linearGradient
							key={gr.id}
							id={gr.id}
							gradientUnits="userSpaceOnUse"
							x1={gr.x1}
							y1={gr.y1}
							x2={gr.x2}
							y2={gr.y2}
						>
							{gr.stops.map((s) => (
								<stop key={`${s.offset}-${s.color}`} offset={s.offset} stopColor={s.color} />
							))}
						</linearGradient>
					))}
				</defs>
			) : null}
			{g.paths.map((path, i) => (
				<path
					// biome-ignore lint/suspicious/noArrayIndexKey: a glyph's paths are static and ordered
					key={i}
					d={path.d}
					fill={path.fill ?? 'currentColor'}
					fillRule={path.fillRule}
					fillOpacity={path.fillOpacity}
				/>
			))}
		</svg>
	);
}

/** A neutral head-and-shoulders figure (generated avatars without initials, platforms without a default avatar). */
function Silhouette({ size, color }: { size: number; color: string }) {
	return (
		<svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" style={{ display: 'block' }}>
			<circle cx="24" cy="19" r="8.5" fill={color} />
			<path d="M8.3 42.1a18 18 0 0 1 31.4 0A23.9 23.9 0 0 1 24 48a23.9 23.9 0 0 1-15.7-5.9Z" fill={color} />
		</svg>
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
		borderRadius: '50%',
		overflow: 'hidden',
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
		const url = p.assets.imageUrls[def.image.url];
		return url ? <AvatarPicture src={url} style={{ ...box, objectFit: 'cover' }} /> : silhouette;
	}
	return silhouette;
}

/** Emoji drawing inside a text run: image size and baseline shift as fractions of the font size. */
export type EmojiMetrics = { size: number; shift: number };

/** Plain text with its emoji drawn as images (names, labels). */
export function TextWithEmoji(p: {
	text: string;
	fontSize: number;
	emoji: EmojiMetrics;
	assets: SocialCardAssets;
}): ReactNode {
	return splitEmojiPieces(p.text).map((piece, i) =>
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
				style={{ verticalAlign: `${r3(p.emoji.shift * p.fontSize)}px` }}
			/>
		),
	);
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

/** tokcomment's blur mark: `blur(4px)` at reference size (the card's zoom scales it with the card). */
export const BLUR_PX = 4;

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
 * - blur: `blur(4px)` (inline-block); remove: invisible, the gap kept;
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
	const emojiStyle: CSSProperties = { verticalAlign: `${r3(p.emoji.shift * fontSize)}px` };
	const drawPiece = (piece: Piece, inPill: boolean, key: string) => {
		const style: CSSProperties = {};
		if (!inPill && piece.mark !== 'highlight' && piece.role !== 'plain') style.color = p.colors[piece.role];
		if (piece.mark === 'highlight' && !inPill) Object.assign(style, HIGHLIGHT_STYLE);
		if (piece.mark === 'blur') Object.assign(style, { display: 'inline-block', filter: `blur(${BLUR_PX}px)` });
		if (piece.mark === 'remove') style.opacity = 0;
		return (
			<span key={key} data-mark={piece.mark === 'none' ? undefined : piece.mark} style={style}>
				{splitEmojiPieces(piece.text).map((e, i) =>
					e.kind === 'text' ? (
						e.text
					) : (
						<EmojiGlyph
							// biome-ignore lint/suspicious/noArrayIndexKey: pieces of a static string
							key={i}
							grapheme={e.grapheme}
							size={emojiPx}
							assets={p.assets}
							style={emojiStyle}
						/>
					),
				)}
			</span>
		);
	};
	return (
		<div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...p.style }}>
			{p.segments.map((seg) => {
				const key = `o${seg.start}`;
				const pieces = piecesOf(spans, seg.start, seg.start + seg.text.length);
				if (seg.unit < 0) return <span key={key}>{pieces.map((pc) => pc.text).join('')}</span>;
				const v = p.words?.[seg.unit];
				const unitStyle: CSSProperties = seg.highlight ? { ...HIGHLIGHT_STYLE } : {};
				if (v) {
					unitStyle.display = 'inline-block';
					unitStyle.maxWidth = '100%';
					unitStyle.opacity = r3(v.o);
					unitStyle.transform = `scale(${r3(v.s)})`;
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
