import type { MgCanvas } from '@jasper/mg-templates';
// Props of an anime template implementation (S11:ATP-005, ARCHITECTURE §20.2).

/** Times in ms of content time (S11:ATP-004). */
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
	canvas: MgCanvas;
	/** `hash32(clipId, 'template')`. */
	seed: number;
	isPreview: boolean;
	/**
	 * social-comment §7.8: image URL of every emoji the template declared (`requiredAssets`) that is available, keyed
	 * `${pack}:${grapheme}` (`emojiUrlOf`); a missing one is absent — draw it with `EmojiImage`, which shows
	 * `MissingAssetMarker` for it. Empty when the template declares none.
	 */
	emojiUrls: Readonly<Record<string, string>>;
	/**
	 * social-comment §7.8: URL of every remote image the template declared (`requiredAssets().images`, manifest ids:
	 * platform default avatars…) that is available, keyed by id; a missing one is absent (the layer marks it).
	 */
	imageUrls: Readonly<Record<string, string>>;
	/**
	 * Template media params (`mediaParam()`, e.g. avatars): the URL of every medium the clip's params reference, by
	 * media id (the render snapshot's media handle: an engine URL, signed in renders). A medium that is missing or
	 * offline is absent; empty when the params reference none. Draw them with `TemplateImage`.
	 */
	mediaUrls: Readonly<Record<string, string>>;
};
