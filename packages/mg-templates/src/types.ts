// Motion-graphic template definitions: the TS twins of the Rust `jasper-mg` templates
// (ARCHITECTURE §10.2, D-12). Each definition mirrors one Rust module in
// native/mg/crates/jasper-mg-templates/src (same id, version, param names, defaults and ranges).
import type { MgTemplatePreset, MgTemplateUi } from '@jasper/project';
import type { ZodType } from 'zod';
import type { EmojiPackId } from './emoji.ts';

export type { MgTemplateParamUi, MgTemplatePreset, MgTemplateUi } from '@jasper/project';

export type MgCanvas = { width: number; height: number };

export type MgSvgOptions = {
	/**
	 * Clip duration in frames. Outros are anchored to the end of the clip, so pass the clip duration
	 * whenever it is known. Default: the template's `defaultDurationSeconds` at `fps`.
	 */
	durationFrames?: number;
	/** Frames of the template timeline skipped at the head (clip sourceIn). Default 0. */
	sourceInFrames?: number;
	/**
	 * Prefix for element ids (clip paths). SVG ids are document-global when the markup is inlined, so
	 * give every layer its own prefix. Default `mg` (what the native renderer uses).
	 */
	idPrefix?: string;
};

/**
 * One step of a template's version upgrade path (S11:ATP-009): params of `fromVersion` → params of the next
 * version the definition carrying the step accepts.
 */
export type MgTemplateUpgradeStep = {
	fromVersion: number;
	migrate(params: Record<string, unknown>): Record<string, unknown>;
};

export type MgTemplateBase<P extends Record<string, unknown> = Record<string, unknown>> = {
	id: string;
	version: number;
	name: string;
	category: string;
	/** One-line description for the Motion Templates gallery. */
	description?: string;
	/** Strict object, every field defaulted (fframes: must mirror the Rust serde struct of the template). */
	paramsSchema: ZodType<P>;
	defaults: P;
	/** Frames kept intact when the clip duration changes ("Responsive Design – Time", S01:KND-009). */
	introFrames: number;
	outroFrames: number;
	/** Default clip length when the template is inserted (S05:MGT-002). */
	defaultDurationSeconds: number;
	/** Canvases the template is designed for (others are scaled). */
	canvases: MgCanvas[];
	/** Upgrade path from older versions of this template id to this version. */
	upgrades?: readonly MgTemplateUpgradeStep[];
	/**
	 * Named param presets: the Motion Templates gallery shows one card per preset instead of one for the template,
	 * `list_motion_templates` lists them and `add_motion_graphic` accepts `"<id>:<preset>"`. `params` holds what the
	 * preset changes; defaults ⊕ params must pass `paramsSchema` (checked by `createMgRegistry`).
	 */
	presets?: readonly MgTemplatePreset[];
	/** UI hints of the params: groups (ordered sub-sections), labels, tooltips, multi-line, visibility, controls. */
	ui?: MgTemplateUi;
	/**
	 * Optional fill hook (social-comments design §7.10), used when an agent omits params
	 * (`clip.addMotionGraphic {fill: {seed}}`, MCP `add_motion_graphic`): fills the params `partial` omits —
	 * never the given ones — deterministically for `seed` (a uint32). `params` = `partial` plus the filled values
	 * (the defaults are merged after, then the paramsSchema validates); `filled` = the names it filled. Return
	 * `{ok: false}` instead of throwing. Templates without a hook just merge their defaults.
	 */
	fill?(partial: Record<string, unknown>, seed: number): MgTemplateFillResult;
	/**
	 * Optional content name of a new clip ("X post · Luna Park"; `MgTemplateInfo.clipName` of @jasper/project): tells
	 * clips of this template apart in the timeline and export messages. Absent or empty = the template name. Pure.
	 */
	clipName?(params: Readonly<Record<string, unknown>>): string | undefined;
};

/** Result of `MgTemplateBase.fill` (the same shape as `MgTemplateFillResult` of @jasper/project). */
export type MgTemplateFillResult =
	| { ok: true; params: Record<string, unknown>; filled: string[] }
	| { ok: false; error: string; issues?: unknown };

/** fframes template (D-12): rendered by `jasper-mg`, previewed by its TS SVG twin. */
export type MgSvgTemplateDefinition<P extends Record<string, unknown> = Record<string, unknown>> =
	MgTemplateBase<P> & {
		/** Absent = fframes. */
		renderer?: 'fframes';
		/**
		 * SVG markup for one frame (straight alpha, transparent background). `frame` is the clip-local frame
		 * (0-based) at `fps`; the result is a complete `<svg>` element sized to `canvas`.
		 */
		renderSvg(params: P, frame: number, fps: number, canvas: MgCanvas, options?: MgSvgOptions): string;
	};

/**
 * Anime.js template — metadata only. The React implementation lives in
 * `@jasper/motion/templates` (`ANIME_TEMPLATE_IMPLS['id@version']`); this package never imports animejs.
 */
export type MgAnimeTemplateDefinition<P extends Record<string, unknown> = Record<string, unknown>> =
	MgTemplateBase<P> & {
		renderer: 'anime';
		/** Bumped whenever the implementation's pixels change (part of the layer-bake render key, S11:LBK-020). */
		renderVersion: number;
		/** Poster time in seconds of content time (gallery poster; default: middle of the default duration). */
		posterAt?: number;
		/**
		 * Fonts, emoji and remote images the implementation draws for `params` (social-comment design §7.8). Fonts resolve against the
		 * bundled catalogue first, then the remote-asset manifest; the render snapshot loads exactly these faces for
		 * preview and bake (a template never relies on a host font stack), the export planner blocks when one is
		 * unavailable, and the bake key covers their files. Must be pure and must not throw.
		 */
		requiredAssets?(params: P): TemplateRequiredAssets;
	};

/** A font face a template draws with. */
export type TemplateFontFace = { family: string; weight: number; style: 'normal' | 'italic' };

/**
 * What `requiredAssets` returns: font faces, the emoji graphemes drawn as images of one pack, and remote images of the
 * remote-asset manifest by id (platform default avatars…; resolved URLs in `AnimeTemplateProps.imageUrls`).
 */
export type TemplateRequiredAssets = {
	fonts: TemplateFontFace[];
	emoji?: { pack: EmojiPackId; graphemes: string[] };
	images?: string[];
};

export type MgTemplateDefinition<P extends Record<string, unknown> = Record<string, unknown>> =
	| MgSvgTemplateDefinition<P>
	| MgAnimeTemplateDefinition<P>;

export type AnyMgTemplate = MgTemplateDefinition;
export type AnySvgMgTemplate = MgSvgTemplateDefinition;
export type AnyAnimeMgTemplate = MgAnimeTemplateDefinition;

export function isAnimeTemplate(def: AnyMgTemplate): def is AnyAnimeMgTemplate {
	return def.renderer === 'anime';
}

export function isSvgTemplate(def: AnyMgTemplate): def is AnySvgMgTemplate {
	return def.renderer !== 'anime';
}
