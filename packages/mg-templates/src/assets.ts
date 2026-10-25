// Template assets (social-comment design §7.8): the fonts and emoji an anime template declares through
// `requiredAssets`, collected for the render snapshot (`SnapshotOptions.templateAssets`), validated and bounded
// (template code must never crash or flood a snapshot).
import type { Keyframe, RenderTemplateAssets, SnapshotOptions, TemplateFaceFile } from '@jasper/project';
import { z } from 'zod';
import { EMOJI_PACK_IDS, isEmojiGrapheme, MAX_EMOJI_CODEPOINTS } from './emoji.ts';
import type { MgRegistry } from './registry.ts';
import { type AnyMgTemplate, isAnimeTemplate, type TemplateRequiredAssets } from './types.ts';

/** Faces one clip may declare (every variant of its keyframed params together). */
export const MAX_TEMPLATE_FONTS = 32;
/** Distinct emoji graphemes one clip may declare per pack. */
export const MAX_TEMPLATE_EMOJI = 512;
/** Keyframed param values `requiredAssets` is evaluated for, per clip. */
const MAX_VARIANTS = 64;

const FaceSchema = z.object({
	family: z.string().trim().min(1).max(128),
	weight: z.number().int().min(1).max(1000),
	style: z.enum(['normal', 'italic']),
});

/** zod schema of what `requiredAssets` may return (checked at the boundary, AGENTS §0). */
export const TemplateRequiredAssetsSchema = z.object({
	fonts: z.array(FaceSchema).max(MAX_TEMPLATE_FONTS),
	emoji: z
		.object({
			pack: z.enum(EMOJI_PACK_IDS),
			graphemes: z
				.array(
					z
						.string()
						.min(1)
						.max(MAX_EMOJI_CODEPOINTS * 2),
				)
				.max(MAX_TEMPLATE_EMOJI * 4),
		})
		.optional(),
});

/**
 * Params of a template for drawing: the schema's parse (defaults merged), or — when the params do not parse (a newer
 * document, a partial object) — the defaults with every field that parses on its own.
 */
export function resolveTemplateParams(
	def: AnyMgTemplate,
	params: Record<string, unknown>,
): Record<string, unknown> {
	const parsed = def.paramsSchema.safeParse(params);
	if (parsed.success) return parsed.data as Record<string, unknown>;
	const merged: Record<string, unknown> = { ...def.defaults };
	for (const [k, v] of Object.entries(params ?? {})) {
		if (!(k in merged)) continue;
		const probe = def.paramsSchema.safeParse({ ...def.defaults, [k]: v });
		if (probe.success) merged[k] = v;
	}
	return merged;
}

function callRequired(def: AnyMgTemplate, params: Record<string, unknown>): TemplateRequiredAssets | null {
	if (!isAnimeTemplate(def) || !def.requiredAssets) return null;
	try {
		const r = TemplateRequiredAssetsSchema.safeParse(def.requiredAssets(resolveTemplateParams(def, params)));
		return r.success ? r.data : null;
	} catch {
		return null;
	}
}

/**
 * The assets a template clip draws over its whole length: `requiredAssets` of its params and of the params with each
 * keyframe value substituted (a keyframed text or emoji style changes what is drawn), merged, deduplicated and
 * bounded. Emoji graphemes that are not emoji (a template bug) are dropped. Null when the template declares none.
 */
export function templateRequiredAssets(
	def: AnyMgTemplate,
	params: Record<string, unknown>,
	paramKeyframes?: Record<string, readonly Keyframe<unknown>[]>,
): RenderTemplateAssets | null {
	if (!isAnimeTemplate(def) || !def.requiredAssets) return null;
	const variants: Record<string, unknown>[] = [params];
	for (const [name, keys] of Object.entries(paramKeyframes ?? {}))
		for (const k of keys ?? []) {
			if (variants.length >= MAX_VARIANTS) break;
			variants.push({ ...params, [name]: k.value });
		}
	const fonts = new Map<string, RenderTemplateAssets['fonts'][number]>();
	const emoji = new Map<string, Set<string>>();
	for (const v of variants) {
		const r = callRequired(def, v);
		if (!r) continue;
		for (const f of r.fonts) {
			if (fonts.size >= MAX_TEMPLATE_FONTS) break;
			const face = { family: f.family.trim(), weight: f.weight, style: f.style };
			fonts.set(`${face.family}|${face.weight}|${face.style}`, face);
		}
		if (r.emoji) {
			let set = emoji.get(r.emoji.pack);
			if (!set) emoji.set(r.emoji.pack, (set = new Set()));
			for (const g of r.emoji.graphemes) {
				if (set.size >= MAX_TEMPLATE_EMOJI) break;
				if (isEmojiGrapheme(g)) set.add(g);
			}
		}
	}
	const out: RenderTemplateAssets = {
		fonts: [...fonts.values()],
		emoji: [...emoji].filter(([, set]) => set.size > 0).map(([pack, set]) => ({ pack, graphemes: [...set] })),
	};
	return out.fonts.length || out.emoji.length ? out : null;
}

/**
 * `SnapshotOptions.templateAssets` bound to a template registry: `required` looks the clip's template up (not
 * installed / no hook → none) and collects its assets; `font` / `emoji` resolve URLs (consumer specific: the engine's
 * catalogue and asset routes).
 */
export function templateAssetOptions(
	registry: Pick<MgRegistry, 'getDefinition'>,
	resolve: {
		font(face: RenderTemplateAssets['fonts'][number]): string | readonly TemplateFaceFile[] | null;
		emoji(pack: string, grapheme: string): string | null;
	},
): NonNullable<SnapshotOptions['templateAssets']> {
	return {
		required: (mg) => {
			const def = registry.getDefinition(mg.template.id, mg.template.version);
			return def ? templateRequiredAssets(def, mg.params, mg.paramKeyframes) : null;
		},
		font: resolve.font,
		emoji: resolve.emoji,
	};
}
