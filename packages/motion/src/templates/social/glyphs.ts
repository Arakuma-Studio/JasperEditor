// Platform icons, badges and default avatars for the social-comment templates (social-comment design §7.8a): the
// real glyphs as inline SVG path data, captured from the platforms' own web apps (the live DOM, their JavaScript
// icon bundles or their icon CDN; the legacy App Store web review stars from an archived copy of apps.apple.com) on
// 2026-10-25. Proprietary marks of their owners, used under the
// platform-template exception of AGENTS.md §3 item 1; per-glyph source URLs, capture date and method are in
// licenses/platform-assets.md. Raster default avatars are referenced by URL only (fetched at runtime, never
// committed). Pure data: no React, no DOM.

/** SVG `fill-rule` of a path (absent = `nonzero`). */
export type GlyphFillRule = 'evenodd' | 'nonzero';

/** One `<path>` of a glyph, in the glyph's `viewBox` coordinates. */
export interface GlyphPath {
	/** SVG path data. */
	readonly d: string;
	readonly fillRule?: GlyphFillRule;
	/**
	 * Fixed paint of this path: a CSS colour, or `url(#<id>)` naming one of the glyph's `gradients`. Absent: the
	 * path is painted with `currentColor` (the caller's colour, default `defaultColor`).
	 */
	readonly fill?: string;
	/** Fill opacity 0–1 (absent = 1). */
	readonly fillOpacity?: number;
}

export interface GlyphGradientStop {
	/** 0–1. */
	readonly offset: number;
	readonly color: string;
}

/** A `<linearGradient gradientUnits="userSpaceOnUse">` in the glyph's `viewBox` coordinates. */
export interface GlyphLinearGradient {
	/** Local id; scope it per rendered instance with `scopeGlyphIds` (SVG ids are document-global). */
	readonly id: string;
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
	readonly stops: readonly GlyphGradientStop[];
}

/**
 * How a glyph was obtained (licenses/platform-assets.md has the URL of each):
 * - `live-dom`: the inline SVG the platform's web app rendered on a public page;
 * - `live-bundle`: an icon component of the platform's own web JavaScript bundle (a state the logged-out page does
 *   not render, e.g. "liked");
 * - `live-cdn`: the platform's icon CDN file, byte-identical to what its page renders;
 * - `archived`: the platform's own asset file from an archived copy of its page (web.archive.org), for a design the
 *   live site no longer serves (the legacy App Store web review card);
 * - `derived`: transformed from a live glyph because the platform shows it only in its native app.
 */
export type GlyphOrigin = 'live-dom' | 'live-bundle' | 'live-cdn' | 'archived' | 'derived';

export interface PlatformGlyph {
	/** SVG `viewBox` (`"minX minY width height"`). */
	readonly viewBox: string;
	/** Painted in order (later paths on top). */
	readonly paths: readonly GlyphPath[];
	readonly gradients?: readonly GlyphLinearGradient[];
	/** The platform's colour for the `currentColor` paths, per theme. Absent when every path has its own `fill`. */
	readonly defaultColor?: { readonly light: string; readonly dark: string };
	readonly origin: GlyphOrigin;
}

/** A platform default avatar that exists only as a raster image on the platform's CDN (downloaded at runtime). */
export interface RemoteAvatarImage {
	readonly url: string;
	/** SHA-256 of the file when captured (2026-10-25). */
	readonly sha256: string;
	readonly width: number;
	readonly height: number;
	readonly format: 'png' | 'jpeg';
}

/** A platform's default ("no photo") avatar: vector, raster by URL, or unknown (no public, stable source). */
export type PlatformDefaultAvatar =
	| { readonly kind: 'glyph'; readonly glyph: PlatformGlyph }
	| { readonly kind: 'remote'; readonly image: RemoteAvatarImage }
	| { readonly kind: 'none'; readonly reason: string };

export type SocialPlatform = 'tiktok' | 'instagram' | 'youtube' | 'x' | 'play-store' | 'app-store';

/** TikTok comment-list glyphs (tiktok.com video page, comments panel; TikTok Sans UI). */
export const TIKTOK_GLYPHS = {
	/** Comment-row like button, not liked (tux icon rendered in the comment list). */
	heartOutline: {
		viewBox: '0 0 48 48',
		paths: [
			{
				d: 'M24 12.62c3.91-4.08 9.84-4.1 13.6-.42a9.48 9.48 0 0 1 0 13.63L25.06 38.07a1.5 1.5 0 0 1-2.1 0L10.4 25.83a9.48 9.48 0 0 1 0-13.63c3.77-3.68 9.7-3.66 13.61.42Zm-1.9 2.36c-2.8-3.2-6.99-3.2-9.61-.63a6.48 6.48 0 0 0 0 9.33L24 34.91l11.51-11.23a6.48 6.48 0 0 0 0-9.33c-2.62-2.56-6.8-2.56-9.6.63l-.05.05-.81.8a1.5 1.5 0 0 1-2.1 0l-.81-.8-.04-.05Z',
			},
		],
		defaultColor: { light: 'rgba(0, 0, 0, 0.48)', dark: 'rgba(255, 255, 255, 0.6)' },
		origin: 'live-dom',
	},
	/** Comment-row like button, liked: same contour as `heartOutline`, filled (tux icon bundle). */
	heartFilled: {
		viewBox: '0 0 48 48',
		paths: [
			{
				d: 'M10.4 12.2c3.76-3.68 9.69-3.66 13.6.42 3.91-4.08 9.84-4.1 13.6-.42a9.48 9.48 0 0 1 0 13.63L25.06 38.07a1.5 1.5 0 0 1-2.1 0L10.4 25.83a9.48 9.48 0 0 1 0-13.63Z',
			},
		],
		defaultColor: { light: '#FE2C55', dark: '#FF3B5C' },
		origin: 'live-bundle',
	},
	/** Comment-row dislike (app only, not on the web): TikTok's web thumbs-up rotated 180°. */
	dislike: {
		viewBox: '0 0 48 48',
		paths: [
			{
				d: 'M16.48 45.8a5.76 5.76 0 0 0 6.98-1.14l8.45-9.08 0.4-0.42a15 15 0 0 0 2.19-3.22H38.46a6.4 6.4 0 0 0 5.99-4.13 24.03 24.03 0 0 0 0.13-16.76l-0.1-0.29a6.57 6.57 0 0 0-6.18-4.32h-5.78a9.34 9.34 0 0 0-5.69-2.24l-10.47-0.43c-1.33-0.06-2.44-0.1-3.36-0.08a8.1 8.1 0 0 0-2.73 0.5 8 8 0 0 0-3.47 2.6 8.1 8.1 0 0 0-1.23 2.48c-0.28 0.88-0.55 1.96-0.87 3.26l-1.74 7.12c-0.4 1.61-0.72 2.95-0.89 4.05a7.27 7.27 0 0 0 0.12 3.33 7 7 0 0 0 3.06 3.9 7.27 7.27 0 0 0 3.2 0.91c1.12 0.1 2.5 0.1 4.15 0.1h3.95l-2.67 6.65a5.76 5.76 0 0 0 2.6 7.2Zm4.05-3.86a1.76 1.76 0 0 1-2.93-1.86l3.76-9.4a2 2 0 0 0-1.86-2.74h-6.8c-1.78 0-2.98 0-3.89-0.08-0.9-0.08-1.27-0.22-1.49-0.35a3 3 0 0 1-1.31-1.67c-0.08-0.24-0.12-0.65 0.01-1.53 0.14-0.9 0.43-2.07 0.85-3.8l1.7-6.96a47.09 47.09 0 0 1 0.8-3.04c0.23-0.7 0.42-1.05 0.6-1.3a4 4 0 0 1 1.74-1.3c0.3-0.11 0.69-0.2 1.42-0.22 0.75-0.02 1.71 0.02 3.14 0.08l10.4 0.43a5.36 5.36 0 0 1 5.02 4.28 39.39 39.39 0 0 1 0.5 12.66l-0.13 1.08-0.06 0.52a11 11 0 0 1-3.04 6.14l-8.43 9.06Zm14.74-31.5c0.14 0.4 0.25 0.81 0.34 1.24a43.38 43.38 0 0 1 0.56 13.95l-0.14 1.1a27.57 27.57 0 0 1-0.18 1.21H38.46c1 0 1.9-0.62 2.25-1.55a20.03 20.03 0 0 0 0.1-13.97l-0.1-0.29a2.57 2.57 0 0 0-2.41-1.69h-3.03 Z',
				fillRule: 'evenodd',
			},
		],
		defaultColor: { light: 'rgba(0, 0, 0, 0.48)', dark: 'rgba(255, 255, 255, 0.6)' },
		origin: 'derived',
	},
	/** Verified badge: white tick in a #20D5EC disc. */
	verified: {
		viewBox: '0 0 48 48',
		paths: [
			{ d: 'M0 24a24 24 0 1 1 48 0 24 24 0 0 1-48 0Z', fill: '#20D5EC' },
			{
				d: 'M37.12 15.88a3 3 0 0 1 0 4.24l-13.5 13.5a3 3 0 0 1-4.24 0l-8.5-8.5a3 3 0 1 1 4.24-4.24l6.38 6.38 11.38-11.38a3 3 0 0 1 4.24 0Z',
				fillRule: 'evenodd',
				fill: '#FFFFFF',
			},
		],
		origin: 'live-dom',
	},
	/** Ellipsis ("more") of a comment. */
	more: {
		viewBox: '0 0 48 48',
		paths: [
			{
				d: 'M5 24a4 4 0 1 1 8 0 4 4 0 0 1-8 0Zm15 0a4 4 0 1 1 8 0 4 4 0 0 1-8 0Zm15 0a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z',
			},
		],
		defaultColor: { light: 'rgba(0, 0, 0, 0.9)', dark: 'rgba(255, 255, 255, 0.9)' },
		origin: 'live-dom',
	},
	/** Chevron after "View N replies". */
	chevronDown: {
		viewBox: '0 0 48 48',
		paths: [
			{
				d: 'm24 27.76 13.17-13.17a1 1 0 0 1 1.42 0l2.82 2.82a1 1 0 0 1 0 1.42L25.06 35.18a1.5 1.5 0 0 1-2.12 0L6.59 18.83a1 1 0 0 1 0-1.42L9.4 14.6a1 1 0 0 1 1.42 0L24 27.76Z',
			},
		],
		defaultColor: { light: 'rgba(0, 0, 0, 0.48)', dark: 'rgba(255, 255, 255, 0.6)' },
		origin: 'live-dom',
	},
	/** "Liked by creator" badge (red disc with a white heart) on the creator's mini avatar. */
	creatorLiked: {
		viewBox: '0 0 48 48',
		paths: [
			{
				d: 'M24 48a24 24 0 1 0 0-48 24 24 0 0 0 0 48Z',
				fillRule: 'evenodd',
				fill: '#FE2C55',
			},
			{
				d: 'M24 15.9c2-2.52 4.76-3.48 7.5-2.92a8.3 8.3 0 0 1 4.85 3.42c1.4 2.08 2 5 .6 8.66-1.09 2.86-3.43 5.52-5.8 7.63a35.37 35.37 0 0 1-6.57 4.67l-.58.3-.58-.3a35.37 35.37 0 0 1-6.58-4.67c-2.36-2.11-4.7-4.77-5.8-7.63-1.4-3.66-.8-6.58.61-8.66a8.3 8.3 0 0 1 4.85-3.42c2.74-.56 5.5.4 7.5 2.92Z',
				fill: '#FFFFFF',
			},
		],
		origin: 'live-dom',
	},
} as const satisfies Readonly<Record<string, PlatformGlyph>>;

/** Instagram comment glyphs (instagram.com post page). */
export const INSTAGRAM_GLYPHS = {
	/** Comment like heart, not liked (IGDSHeartPanoOutlineIcon, the one the post "Like" button renders). */
	heartOutline: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M16.792 3.904A4.989 4.989 0 0 1 21.5 9.122c0 3.072-2.652 4.959-5.197 7.222-2.512 2.243-3.865 3.469-4.303 3.752-.477-.309-2.143-1.823-4.303-3.752C5.141 14.072 2.5 12.167 2.5 9.122a4.989 4.989 0 0 1 4.708-5.218 4.21 4.21 0 0 1 3.675 1.941c.84 1.175.98 1.763 1.12 1.763s.278-.588 1.11-1.766a4.17 4.17 0 0 1 3.679-1.938m0-2a6.04 6.04 0 0 0-4.797 2.127 6.052 6.052 0 0 0-4.787-2.127A6.985 6.985 0 0 0 .5 9.122c0 3.61 2.55 5.827 5.015 7.97.283.246.569.494.853.747l1.027.918a44.998 44.998 0 0 0 3.518 3.018 2 2 0 0 0 2.174 0 45.263 45.263 0 0 0 3.626-3.115l.922-.824c.293-.26.59-.519.885-.774 2.334-2.025 4.98-4.32 4.98-7.94a6.985 6.985 0 0 0-6.708-7.218Z',
			},
		],
		defaultColor: { light: '#8E8E8E', dark: '#8E8E8E' },
		origin: 'live-dom',
	},
	/** Comment like heart, liked (IGDSHeartPanoFilledIcon); Instagram paints it --ig-badge rgb(255, 48, 64). */
	heartFilled: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M17.075 1.987a5.852 5.852 0 0 0-5.07 2.66l-.008.012-.01-.014a5.878 5.878 0 0 0-5.062-2.658A6.719 6.719 0 0 0 .5 8.952c0 3.514 2.581 5.757 5.077 7.927.302.262.607.527.91.797l1.089.973c2.112 1.89 3.149 2.813 3.642 3.133a1.438 1.438 0 0 0 1.564 0c.472-.306 1.334-1.07 3.755-3.234l.978-.874c.314-.28.631-.555.945-.827 2.478-2.15 5.04-4.372 5.04-7.895a6.719 6.719 0 0 0-6.425-6.965Z',
			},
		],
		defaultColor: { light: '#FF3040', dark: '#FF3040' },
		origin: 'live-bundle',
	},
	/** Verified badge: scalloped rosette with a cut-out tick (the background shows through), fill rgb(0, 149, 246). */
	verified: {
		viewBox: '0 0 40 40',
		paths: [
			{
				d: 'M19.998 3.094 14.638 0l-2.972 5.15H5.432v6.354L0 14.64 3.094 20 0 25.359l5.432 3.137v5.905h5.975L14.638 40l5.36-3.094L25.358 40l3.232-5.6h6.162v-6.01L40 25.359 36.905 20 40 14.641l-5.248-3.03v-6.46h-6.419L25.358 0l-5.36 3.094Zm7.415 11.225 2.254 2.287-11.43 11.5-6.835-6.93 2.244-2.258 4.587 4.581 9.18-9.18Z',
				fillRule: 'evenodd',
				fill: '#0095F6',
			},
		],
		origin: 'live-dom',
	},
	/** "More options" (three dots). */
	more: {
		viewBox: '0 0 24 24',
		paths: [
			{ d: 'M10.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0Z' },
			{ d: 'M4.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0Z' },
			{ d: 'M16.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0Z' },
		],
		defaultColor: { light: '#000000', dark: '#F5F5F5' },
		origin: 'live-dom',
	},
} as const satisfies Readonly<Record<string, PlatformGlyph>>;

/** YouTube comment glyphs (youtube.com watch page, comments section). */
export const YOUTUBE_GLYPHS = {
	/** Comment like (18 px design), not liked. */
	thumbUp: {
		viewBox: '0 0 18 18',
		paths: [
			{
				d: 'm7.748.854.779.13a3 3 0 012.44 3.588L10.5 6.75h3.046a2.748 2.748 0 012.204 4.387l.015.066A2.862 2.862 0 0115 13.874v.033c0 .227-.037.452-.109.668l-.08.21a2.815 2.815 0 01-2.59 1.715H9.516l-.294-.005a9.002 9.002 0 01-3.918-1.041l-.256-.142-.204-.116a1.502 1.502 0 00-.55-.186L4.102 15H2.625l-.116-.006a1.126 1.126 0 01-1.003-1.005l-.006-.114v-4.5c0-.62.504-1.124 1.125-1.124h1.342a.75.75 0 00.66-.395l.048-.107 2.24-6.403a.75.75 0 01.833-.491ZM6.09 8.243A2.25 2.25 0 013.967 9.75H3v3.749h1.1a3 3 0 011.49.395l.202.116a7.503 7.503 0 003.724.99h2.703c.566 0 1.07-.363 1.248-.9a.61.61 0 00.032-.193v-.655l.44-.439a1.36 1.36 0 00.363-1.272l-.014-.065-.157-.675.413-.556a1.248 1.248 0 00-.999-1.995H10.5a1.501 1.501 0 01-1.467-1.815L9.5 4.257a1.5 1.5 0 00-1.22-1.794l-.157-.026L6.09 8.243Z',
			},
		],
		defaultColor: { light: '#0F0F0F', dark: '#F1F1F1' },
		origin: 'live-dom',
	},
	/** Comment like (18 px design), liked. */
	thumbUpFilled: {
		viewBox: '0 0 18 18',
		paths: [
			{
				d: 'M8.041 1.635a2.447 2.447 0 011.763 3.047l-.53 1.858a.75.75 0 00.72.956h3.968c.636 0 1.217.36 1.502.928l.135.269a1.34 1.34 0 01-.45 1.709.336.336 0 00-.149.278v.052c0 .094.03.186.087.26a1.78 1.78 0 01-.309 2.459l-.374.298a.284.284 0 00-.091.312l.051.155c.163.49.076 1.03-.234 1.443a2.1 2.1 0 01-1.68.84l-2.935-.002a9 9 0 01-4.464-1.188l-.205-.117a1.5 1.5 0 00-.744-.197H2.25a.75.75 0 01-.75-.75V9.747a.75.75 0 01.751-.75L4.341 9a.75.75 0 00.71-.501l2.265-6.472a.612.612 0 01.725-.392Z',
			},
		],
		defaultColor: { light: '#0F0F0F', dark: '#F1F1F1' },
		origin: 'live-cdn',
	},
	/** Comment dislike (18 px design), not disliked. */
	thumbDown: {
		viewBox: '0 0 18 18',
		paths: [
			{
				d: 'm8.482 1.5.294.005a9.01 9.01 0 013.918 1.04l.257.143.203.116c.17.097.357.16.55.185l.194.012h1.477l.115.006c.53.054.95.475 1.004 1.005l.006.114v4.499c0 .621-.504 1.125-1.125 1.125h-1.343a.75.75 0 00-.66.395l-.048.107-2.24 6.402a.75.75 0 01-.832.491l-.78-.13a3 3 0 01-2.439-3.587L7.5 11.25H4.454a2.749 2.749 0 01-2.683-2.151 2.762 2.762 0 01.479-2.237l-.016-.065A2.862 2.862 0 013 4.125v-.032c0-.227.037-.453.108-.668l.08-.211A2.816 2.816 0 015.78 1.5h2.703ZM5.78 3c-.566 0-1.069.362-1.248.9a.613.613 0 00-.031.193v.654l-.44.44c-.333.332-.47.813-.364 1.271l.015.065.157.675-.413.557a1.248 1.248 0 00.999 1.995H7.5a1.501 1.501 0 011.467 1.815L8.5 13.742a1.5 1.5 0 001.22 1.794l.157.027 2.031-5.806a2.25 2.25 0 012.124-1.507H15V4.501h-1.102a3.001 3.001 0 01-1.489-.396l-.202-.116A7.504 7.504 0 008.482 3H5.78Z',
			},
		],
		defaultColor: { light: '#0F0F0F', dark: '#F1F1F1' },
		origin: 'live-dom',
	},
	/** Comment dislike (18 px design), disliked. */
	thumbDownFilled: {
		viewBox: '0 0 18 18',
		paths: [
			{
				d: 'M8.485 1.502c1.566 0 3.105.41 4.464 1.187l.204.118a1.5 1.5 0 00.746.198h1.851a.75.75 0 01.75.75v4.497a.75.75 0 01-.752.75l-2.09-.004a.75.75 0 00-.71.502l-2.264 6.472a.612.612 0 01-.725.391 2.446 2.446 0 01-1.762-3.047l.53-1.857a.75.75 0 00-.722-.956H4.038a1.68 1.68 0 01-1.503-.929l-.133-.268a1.338 1.338 0 01.45-1.71A.336.336 0 003 7.319v-.051a.434.434 0 00-.087-.26 1.781 1.781 0 01.308-2.46l.374-.298a.285.285 0 00.093-.311l-.052-.156a1.575 1.575 0 01.233-1.442A2.1 2.1 0 015.55 1.5l2.935.002Z',
			},
		],
		defaultColor: { light: '#0F0F0F', dark: '#F1F1F1' },
		origin: 'live-cdn',
	},
	/** Comment / reply speech bubble (outline), e.g. the Shorts comment button. */
	reply: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M1 6a4 4 0 014-4h14a4 4 0 014 4v10a4 4 0 01-4 4h-4.8l-5.105 2.836A1.41 1.41 0 017 21.604V20H5a4 4 0 01-4-4V6Zm8 12v2.601l4.229-2.35.453-.251H19a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h4ZM7 8a1 1 0 000 2h10a1 1 0 100-2H7Zm-1 5a1 1 0 001 1h6a1 1 0 000-2H7a1 1 0 00-1 1Z',
			},
		],
		defaultColor: { light: '#0F0F0F', dark: '#F1F1F1' },
		origin: 'live-cdn',
	},
	/** Comment / reply speech bubble (filled). */
	replyFilled: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M5 2a4 4 0 00-4 4v10a4 4 0 004 4h2v1.604a1.41 1.41 0 002.095 1.232L14.2 20H19a4 4 0 004-4V6a4 4 0 00-4-4H5Zm2 6h10a1 1 0 110 2H7a1 1 0 010-2Zm-1 5a1 1 0 011-1h6a1 1 0 010 2H7a1 1 0 01-1-1Z',
			},
		],
		defaultColor: { light: '#0F0F0F', dark: '#F1F1F1' },
		origin: 'live-cdn',
	},
	/** Verified channel check (check_circle) after an author name; 12 px in the comment author badge. */
	verified: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1Zm5.707 7.293a1 1 0 010 1.414L10 17.414l-3.707-3.707a1 1 0 111.414-1.414L10 14.586l6.293-6.293a1 1 0 011.414 0Z',
			},
		],
		defaultColor: { light: '#606060', dark: '#AAAAAA' },
		origin: 'live-dom',
	},
	/** Comment action menu (vertical kebab). */
	more: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M12 4a2 2 0 100 4 2 2 0 000-4Zm0 6a2 2 0 100 4 2 2 0 000-4Zm0 6a2 2 0 100 4 2 2 0 000-4Z',
			},
		],
		defaultColor: { light: '#0F0F0F', dark: '#F1F1F1' },
		origin: 'live-dom',
	},
	/** Chevron of the "N replies" button. */
	chevronDown: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M18.707 8.793a1 1 0 00-1.414 0L12 14.086 6.707 8.793a1 1 0 10-1.414 1.414L12 16.914l6.707-6.707a1 1 0 000-1.414Z',
			},
		],
		defaultColor: { light: '#0F0F0F', dark: '#F1F1F1' },
		origin: 'live-dom',
	},
	/** Creator heart: the filled heart (13 px) over the creator's 24 px avatar. */
	creatorHeart: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M16.25 3.5c-1.697 0-3.206.765-4.25 1.96C10.956 4.265 9.447 3.5 7.75 3.5 4.527 3.5 2 6.235 2 9.5c0 3.99 2.53 6.996 4.862 8.929 2.355 1.95 4.703 2.972 4.74 2.988l.398.174.398-.174c.037-.016 2.385-1.038 4.74-2.988C19.471 16.495 22 13.49 22 9.5c0-3.265-2.527-6-5.75-6Z',
			},
		],
		defaultColor: { light: '#FF0033', dark: '#FF0033' },
		origin: 'live-dom',
	},
	/** Creator heart: the outline heart (15 px) drawn under `creatorHeart` as its white border. */
	creatorHeartBorder: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M16.25 2.5A6.56 6.56 0 0012 4.062 6.56 6.56 0 007.75 2.5C3.927 2.5 1 5.732 1 9.5c0 4.436 2.807 7.696 5.225 9.698a23.597 23.597 0 004.837 3.072l.095.044.029.013.01.004.005.003c.269-.61.535-1.222.799-1.834.797 1.834.799 1.834.799 1.834l.001-.001.003-.002.01-.004.03-.013.095-.044c.08-.037.19-.089.33-.157a23.6 23.6 0 004.507-2.915C20.193 17.196 23 13.936 23 9.5c0-3.768-2.927-7-6.75-7Zm0 2c2.623 0 4.75 2.239 4.75 5 0 7.089-9 11-9 11s-9-3.911-9-11c0-2.761 2.127-5 4.75-5a4.58 4.58 0 012.922 1.058A5 5 0 0112 7.265a5 5 0 011.328-1.707A4.58 4.58 0 0116.25 4.5Zm-3.453 17.834L12 20.5l-.797 1.834.797.347.797-.347Z',
			},
		],
		defaultColor: { light: '#FFFFFF', dark: '#FFFFFF' },
		origin: 'live-dom',
	},
	/** "Pinned by @creator" pin (12 px). */
	pin: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M21.007 6.298 11.7.924l-.077-.04a.85.85 0 00-.772 1.51l.735.425-3.394 5.878-1.718.46a1.5 1.5 0 00-.91.698l-1.012 1.753a.75.75 0 00.274 1.024l9.479 5.473a.75.75 0 001.024-.275l1.01-1.752a1.501 1.501 0 00.15-1.14l-.46-1.715 3.395-5.88.734.425a.85.85 0 00.849-1.47Zm-11.083 3.4 3.243-5.617 4.373 2.525-3.242 5.616a2 2 0 00-.2 1.518l.407 1.517-.283.49-7.313-4.22.283-.49 1.518-.41a2 2 0 001.214-.93ZM7.15 21.814l3.395-5.88-1.96-1.13-3.393 5.879-.152 2.525 2.11-1.394Z',
			},
		],
		defaultColor: { light: '#0F0F0F', dark: '#F1F1F1' },
		origin: 'live-dom',
	},
} as const satisfies Readonly<Record<string, PlatformGlyph>>;

/** X post glyphs (x.com post and profile timeline, 2026 web app). */
export const X_GLYPHS = {
	/** Reply (action bar). */
	reply: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z',
			},
		],
		defaultColor: { light: 'rgba(0, 0, 0, 0.6)', dark: 'rgba(255, 255, 255, 0.6)' },
		origin: 'live-dom',
	},
	/** Repost (action bar). */
	repost: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z',
			},
		],
		defaultColor: { light: 'rgba(0, 0, 0, 0.6)', dark: 'rgba(255, 255, 255, 0.6)' },
		origin: 'live-dom',
	},
	/** Like (action bar), not liked. */
	like: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z',
			},
		],
		defaultColor: { light: 'rgba(0, 0, 0, 0.6)', dark: 'rgba(255, 255, 255, 0.6)' },
		origin: 'live-dom',
	},
	/** Like (action bar), liked; X paints it --x-magenta-500 #F91880. */
	likeFilled: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M20.884 13.19c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z',
			},
		],
		defaultColor: { light: '#F91880', dark: '#F91880' },
		origin: 'live-bundle',
	},
	/** View count (bar chart). */
	views: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z',
			},
		],
		defaultColor: { light: 'rgba(0, 0, 0, 0.6)', dark: 'rgba(255, 255, 255, 0.6)' },
		origin: 'live-dom',
	},
	/** Bookmark (action bar). */
	bookmark: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zM6.5 4c-.276 0-.5.22-.5.5v14.56l6-4.29 6 4.29V4.5c0-.28-.224-.5-.5-.5h-11z',
			},
		],
		defaultColor: { light: 'rgba(0, 0, 0, 0.6)', dark: 'rgba(255, 255, 255, 0.6)' },
		origin: 'live-dom',
	},
	/** Share (action bar). */
	share: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z',
			},
		],
		defaultColor: { light: 'rgba(0, 0, 0, 0.6)', dark: 'rgba(255, 255, 255, 0.6)' },
		origin: 'live-dom',
	},
	/** "More" (horizontal dots) at the right of the header. */
	more: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z',
			},
		],
		defaultColor: { light: '#000000', dark: '#FFFFFF' },
		origin: 'live-dom',
	},
	/** Blue verified badge (Premium): the tick is cut out. */
	verifiedBlue: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M12 1.75c1.4 0 2.62.87 3.34 2.19 1.44-.43 2.92-.17 3.91.81s1.24 2.47.81 3.91c1.32.72 2.2 1.94 2.2 3.34s-.88 2.62-2.2 3.34c.43 1.44.18 2.92-.81 3.9-.99 1-2.47 1.25-3.91.82-.72 1.32-1.94 2.19-3.34 2.19s-2.62-.87-3.34-2.2c-1.44.44-2.92.18-3.9-.8-1-.99-1.24-2.47-.82-3.91-1.32-.72-2.19-1.95-2.19-3.34 0-1.4.87-2.62 2.2-3.34-.43-1.44-.18-2.92.8-3.9.99-1 2.47-1.25 3.91-.82.72-1.32 1.95-2.19 3.34-2.19M10.45 13.3l-2.23-2.25-1.42 1.4 3.7 3.75 6.24-6.77-1.47-1.36z',
				fillRule: 'evenodd',
				fill: '#1d9bf0',
			},
		],
		origin: 'live-dom',
	},
	/** Gold verified badge (Verified Organizations), with its two gradients. */
	verifiedGold: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M14.54 4.2 12 1.75 9.47 4.2l-3.5-.5-.6 3.48-3.12 1.65L3.8 12l-1.55 3.17 3.11 1.65.61 3.48 3.5-.5L12 22.25l2.54-2.45 3.49.5.6-3.48 3.12-1.65L20.2 12l1.55-3.17-3.11-1.65-.61-3.48zM6.8 12.46l3.74 3.74 6.2-6.77-1.47-1.36-4.8 5.23-2.26-2.26z',
				fillRule: 'evenodd',
				fill: 'url(#icon-verified-business-color_a)',
			},
			{
				d: 'M14.3 4.95 12 2.73 9.7 4.95 6.56 4.5 6 7.64l-2.82 1.5L4.58 12l-1.4 2.87L6 16.37l.55 3.13 3.16-.44L12 21.27l2.3-2.21 3.15.44.55-3.14 2.82-1.5-1.4-2.86 1.4-2.87L18 7.64l-.55-3.14zm-7.5 7.51 3.74 3.74 6.2-6.77-1.47-1.36-4.8 5.23-2.26-2.26z',
				fillRule: 'evenodd',
				fill: 'url(#icon-verified-business-color_b)',
			},
			{
				d: 'm6.8 12.46 3.74 3.74 6.2-6.77v1.53l-6.2 6.77-3.74-3.74z',
				fillRule: 'evenodd',
				fill: '#d18800',
			},
		],
		gradients: [
			{
				id: 'icon-verified-business-color_a',
				x1: 4.81,
				y1: 2.72,
				x2: 19.73,
				y2: 23.46,
				stops: [
					{ offset: 0, color: '#f4e72a' },
					{ offset: 0.54, color: '#cd8105' },
					{ offset: 0.68, color: '#cb7b00' },
					{ offset: 1, color: '#f4e72a' },
				],
			},
			{
				id: 'icon-verified-business-color_b',
				x1: 5.84,
				y1: 3.7,
				x2: 17.85,
				y2: 20.87,
				stops: [
					{ offset: 0, color: '#f9e87f' },
					{ offset: 0.41, color: '#e2b719' },
					{ offset: 0.99, color: '#e2b719' },
				],
			},
		],
		origin: 'live-dom',
	},
	/** Grey verified badge (government / multilateral). */
	verifiedGrey: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M11.38 2.1a2 2 0 0 1 1.24 0c.46.15.85.54 1.64 1.33l.91.91h1.29c1.12 0 1.68 0 2.1.22q.58.3.88.88c.22.42.22.98.22 2.1v1.29l.9.9c.8.8 1.2 1.2 1.34 1.65a2 2 0 0 1 0 1.24c-.15.45-.54.85-1.33 1.64l-.91.91v1.28c0 1.12 0 1.69-.22 2.11a2 2 0 0 1-.88.88c-.42.21-.98.21-2.1.21h-1.29l-.9.91c-.8.8-1.2 1.2-1.65 1.34a2 2 0 0 1-1.24 0c-.45-.15-.85-.54-1.64-1.34l-.91-.9H7.55c-1.12 0-1.69 0-2.11-.22a2 2 0 0 1-.88-.88c-.22-.42-.22-.99-.22-2.1v-1.29l-.9-.9c-.8-.8-1.2-1.2-1.34-1.65a2 2 0 0 1 0-1.24c.15-.46.54-.85 1.34-1.64l.9-.91V7.54c0-1.12 0-1.68.22-2.1a2 2 0 0 1 .88-.88c.42-.22.99-.22 2.1-.22h1.29l.9-.9c.8-.8 1.2-1.2 1.65-1.34m-.87 11.17-2.2-2.2-1.38 1.38 3.65 3.65 6.04-6.6-1.43-1.33z',
				fillRule: 'evenodd',
				fill: '#829aab',
			},
		],
		origin: 'live-dom',
	},
	/** Grok mark of the header's "Explain this post" button, left of "More" (shown to signed-in viewers when the post allows Grok analysis). */
	grok: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'm9.27 15.28 7.98-5.92c.39-.29.95-.18 1.13.27a6.6 6.6 0 0 1-1.4 7.2 6.5 6.5 0 0 1-7.15 1.42L7.1 19.5a9 9 0 0 0 13.95-9.41h.01c-.98-4.25.24-5.95 2.75-9.42L24 .43l-3.3 3.32v-.01zm-1.65 1.44c-2.79-2.68-2.3-6.83.07-9.22a6.6 6.6 0 0 1 7.17-1.43l2.7-1.26a8.95 8.95 0 0 0-11.58.97 9.1 9.1 0 0 0-1.96 9.8c1.02 2.5-.65 4.27-2.34 6.06-.6.63-1.2 1.26-1.68 1.93z',
			},
		],
		defaultColor: { light: '#000000', dark: '#FFFFFF' },
		origin: 'live-bundle',
	},
} as const satisfies Readonly<Record<string, PlatformGlyph>>;

/** Google Play review glyphs (play.google.com app page, review cards; Roboto UI). */
export const PLAY_STORE_GLYPHS = {
	/** Review rating star (inline SVG of the review card); filled and empty stars are the same path in two colours. */
	star: {
		viewBox: '0 0 24 24',
		paths: [
			{ d: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z' },
		],
		defaultColor: { light: '#01875F', dark: '#00A173' },
		origin: 'live-dom',
	},
	/** Review "More review actions" kebab: the `more_vert` outline of Play's Material Icons Extended font file. */
	more: {
		viewBox: '0 0 24 24',
		paths: [
			{
				d: 'M10.59 16.59Q10.59 16.59 10.9 16.29Q11.2 15.98 12 15.98Q12.8 15.98 13.41 16.59Q14.02 17.2 14.02 18Q14.02 18.8 13.41 19.41Q12.8 20.02 12 20.02Q11.2 20.02 10.59 19.41Q9.98 18.8 9.98 18Q9.98 17.2 10.59 16.59ZM10.59 10.59Q10.59 10.59 10.9 10.29Q11.2 9.98 12 9.98Q12.8 9.98 13.41 10.59Q14.02 11.2 14.02 12Q14.02 12.8 13.41 13.41Q12.8 14.02 12 14.02Q11.2 14.02 10.59 13.41Q9.98 12.8 9.98 12Q9.98 11.2 10.59 10.59ZM13.41 7.41Q13.41 7.41 13.1 7.71Q12.8 8.02 12 8.02Q11.2 8.02 10.59 7.41Q9.98 6.8 9.98 6Q9.98 5.2 10.59 4.59Q11.2 3.98 12 3.98Q12.8 3.98 13.41 4.59Q14.02 5.2 14.02 6Q14.02 6.8 13.41 7.41Z',
			},
		],
		defaultColor: { light: '#5F6368', dark: '#9AA0A6' },
		origin: 'live-cdn',
	},
} as const satisfies Readonly<Record<string, PlatformGlyph>>;

/** App Store review glyphs (apps.apple.com app page, "Ratings & Reviews"; the legacy design from web.archive.org). */
export const APP_STORE_GLYPHS = {
	/** Rating star, filled (current apps.apple.com review card; the iPhone app's layout). */
	star: {
		viewBox: '0 0 64 64',
		paths: [
			{
				d: 'M13.559 60.051c1.102.86 2.5.565 4.166-.645l14.218-10.455L46.19 59.406c1.666 1.21 3.037 1.505 4.166.645 1.102-.833 1.344-2.204.672-4.166l-5.618-16.718 14.353-10.32c1.666-1.183 2.338-2.42 1.908-3.764-.43-1.29-1.693-1.935-3.763-1.908l-17.605.108-5.348-16.8C34.308 4.496 33.34 3.5 31.944 3.5c-1.372 0-2.34.995-2.984 2.984L23.61 23.283l-17.605-.108c-2.07-.027-3.333.618-3.763 1.908-.457 1.344.242 2.58 1.909 3.763l14.352 10.321-5.617 16.718c-.672 1.962-.43 3.333.672 4.166',
			},
		],
		defaultColor: { light: '#FF9500', dark: '#FF9F0A' },
		origin: 'live-dom',
	},
	/** Rating star, empty: the outline star in the same orange (outer and inner contour, nonzero). */
	starOutline: {
		viewBox: '0 0 64 64',
		paths: [
			{
				d: 'M13.559 60.051c1.102.86 2.5.565 4.166-.645l14.218-10.455L46.19 59.406c1.666 1.21 3.037 1.505 4.166.645 1.102-.833 1.344-2.204.672-4.166l-5.618-16.718 14.353-10.32c1.666-1.183 2.338-2.42 1.908-3.764-.43-1.29-1.693-1.935-3.763-1.908l-17.605.108-5.348-16.8C34.308 4.496 33.34 3.5 31.944 3.5c-1.372 0-2.34.995-2.984 2.984L23.61 23.283l-17.605-.108c-2.07-.027-3.333.618-3.763 1.908-.457 1.344.242 2.58 1.909 3.763l14.352 10.321-5.617 16.718c-.672 1.962-.43 3.333.672 4.166m3.87-5.321c-.054-.054-.027-.081 0-.242l5.349-15.374c.376-1.049.161-1.882-.78-2.527L8.613 27.341c-.134-.08-.161-.134-.134-.215s.08-.08.242-.08l16.26.295c1.103.027 1.802-.43 2.151-1.532l4.677-15.562c.027-.162.08-.215.134-.215.08 0 .135.053.162.215l4.676 15.562c.35 1.102 1.048 1.559 2.15 1.532l16.261-.296c.162 0 .216 0 .243.081.027.08-.027.134-.135.215l-13.385 9.246c-.94.645-1.156 1.478-.78 2.527l5.35 15.374c.026.161.053.188 0 .242-.055.08-.135.026-.243-.054l-12.928-9.864c-.86-.672-1.855-.672-2.715 0l-12.928 9.864c-.107.08-.188.134-.242.054',
				fillRule: 'nonzero',
			},
		],
		defaultColor: { light: '#FF9500', dark: '#FF9F0A' },
		origin: 'live-dom',
	},
	/**
	 * Legacy web review star (2019–2025 apps.apple.com, `stars-lg` sprite, top half): drawn 24 × 25 px per star,
	 * stretched (the sprite's CSS `background-size: 24px 50px`).
	 */
	legacyStar: {
		viewBox: '0 0 13 14',
		paths: [
			{
				d: 'M6.496.173L4.521 5.251H.007l3.738 2.751-1.481 5.149 4.232-3.386 4.232 3.386-1.482-5.149 3.739-2.751H8.471z',
			},
		],
		defaultColor: { light: '#FF9500', dark: '#FF9F0A' },
		origin: 'archived',
	},
	/** Legacy empty star (the sprite's bottom half, moved up by its 14.15 offset into the same 13 × 14 box). */
	legacyStarEmpty: {
		viewBox: '0 0 13 14',
		paths: [
			{
				d: 'M6.5.2l-1.978 5.087H0l3.745 2.755-1.484 5.158L6.5 9.809l4.239 3.391-1.484-5.158L13 5.287H8.478z',
			},
		],
		defaultColor: { light: '#BFBFBF', dark: '#5A5A5E' },
		origin: 'archived',
	},
} as const satisfies Readonly<Record<string, PlatformGlyph>>;

/** Every platform's glyph set, by platform. */
export const PLATFORM_GLYPHS = {
	tiktok: TIKTOK_GLYPHS,
	instagram: INSTAGRAM_GLYPHS,
	youtube: YOUTUBE_GLYPHS,
	x: X_GLYPHS,
	'play-store': PLAY_STORE_GLYPHS,
	'app-store': APP_STORE_GLYPHS,
} as const;

/** TikTok's default avatar (grey disc, white head and shoulders at 75 %): the `Icon_Color-Default_Avatar` of its bundle. */
export const TIKTOK_DEFAULT_AVATAR: PlatformGlyph = {
	viewBox: '0 0 48 48',
	paths: [
		{ d: 'M0 24a24 24 0 1 0 48 0a24 24 0 1 0 -48 0Z', fill: '#D0D1D3' },
		{
			d: 'M8.28 42.14a18 18 0 0 1 31.38.05A23.9 23.9 0 0 1 24 48a23.9 23.9 0 0 1-15.72-5.86Z',
			fill: '#FFFFFF',
			fillOpacity: 0.75,
		},
		{
			d: 'M32.95 22.02a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
			fill: '#FFFFFF',
			fillOpacity: 0.75,
		},
	],
	origin: 'live-bundle',
};

/** Default avatars per platform. */
export const PLATFORM_DEFAULT_AVATARS: Readonly<Record<SocialPlatform, PlatformDefaultAvatar>> = {
	tiktok: { kind: 'glyph', glyph: TIKTOK_DEFAULT_AVATAR },
	x: {
		kind: 'remote',
		image: {
			url: 'https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png',
			sha256: '6d34bedb72ec3f2dc15085747d365fbb3f34319d5b549a8776438b92853344b6',
			width: 400,
			height: 400,
			format: 'png',
		},
	},
	youtube: {
		kind: 'remote',
		image: {
			url: 'https://yt3.ggpht.com/a/default-user=s240-c-k-c0x00ffffff-no-rj',
			sha256: '9929d44d4db47289e3be5904d05a3bcbd9d6af581b04d6e6f272f7f7317adca4',
			width: 240,
			height: 240,
			format: 'jpeg',
		},
	},
	instagram: {
		kind: 'none',
		reason:
			'Instagram serves its anonymous avatar only through signed, expiring fbcdn URLs; no stable public source exists.',
	},
	'play-store': {
		kind: 'none',
		reason:
			"Google Play shows each reviewer's Google account picture (googleusercontent URLs per account); there is no single public default image.",
	},
	'app-store': {
		kind: 'none',
		reason: 'App Store review cards show no avatar.',
	},
};

/** The glyph's colour for `currentColor` paths in a theme (`fallback` when the glyph has no `defaultColor`). */
export function glyphColor(glyph: PlatformGlyph, theme: 'light' | 'dark', fallback = 'currentColor'): string {
	return glyph.defaultColor?.[theme] ?? fallback;
}

/**
 * The glyph with its gradient ids prefixed by `scope` (and the `url(#…)` fills that name them), so several
 * instances in one document never share an id. `scope` may only hold letters, digits, `-` and `_`; anything else is
 * replaced by `_`. Glyphs without gradients are returned as they are.
 */
export function scopeGlyphIds(glyph: PlatformGlyph, scope: string): PlatformGlyph {
	const gradients = glyph.gradients;
	if (!gradients || gradients.length === 0) return glyph;
	const safe = String(scope).replace(/[^A-Za-z0-9_-]/g, '_');
	const ids = new Set(gradients.map((g) => g.id));
	const scoped = (id: string): string => `${safe}-${id}`;
	return {
		...glyph,
		gradients: gradients.map((g) => ({ ...g, id: scoped(g.id) })),
		paths: glyph.paths.map((p) => {
			const m = p.fill === undefined ? null : /^url\(#([^)]+)\)$/.exec(p.fill);
			return m?.[1] !== undefined && ids.has(m[1]) ? { ...p, fill: `url(#${scoped(m[1])})` } : p;
		}),
	};
}
