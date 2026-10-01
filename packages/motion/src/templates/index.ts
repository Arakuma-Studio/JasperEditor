// @jasper/motion/templates — React implementations of the anime templates (S11 §5, ARCHITECTURE §20.2), keyed
// `id@version` like the `renderer: 'anime'` entries of @jasper/mg-templates (a test asserts both lists match).
// Owner: wp-m2-anime-templates.
import type { ComponentType } from 'react';

/** Props of an anime template implementation (S11:ATP-005). Times in ms of content time (S11:ATP-004). */
export type AnimeTemplateProps = {
	/** Params parsed by the template's schema (defaults merged; keyframed params evaluated for this frame). */
	params: Record<string, unknown>;
	/** Seek time: content frame → ms (S11:ANM-003). */
	timeMs: number;
	/** Content length of the clip. */
	totalMs: number;
	/** Intro anchored at content time 0, outro at the content end; the hold stretches. */
	introMs: number;
	outroMs: number;
	fps: number;
	/** Render size (the clip's canvas); design pixels are fitted with `fitCanvas`. */
	canvas: { width: number; height: number };
	/** `hash32(clipId, 'template')`. */
	seed: number;
	isPreview: boolean;
};

/** The shipped implementations. Empty until wp-m2-anime-templates lands. */
export const ANIME_TEMPLATE_IMPLS: Readonly<Record<string, ComponentType<AnimeTemplateProps>>> = {};
