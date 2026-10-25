// Resolving the params of a new motion-graphic clip (social-comments design §7.9–7.10): the template's fill hook
// fills what the caller left out (deterministic for a seed), the given values win, the defaults are merged under,
// the params schema validates and template media params must name media of the project of a kind they take. Pure:
// `clip.addMotionGraphic`, `clip.duplicateMotionGraphic` ("Add another") and the bulk-import preview all resolve
// through this one function, so a preview shows exactly what the command will store.
import type { ErrorCode } from '../commands/types.ts';
import { templateMediaRefs } from '../param-media.ts';
import type { MediaAsset } from '../schema/media.ts';
import type { MgTemplateInfo } from './mg.ts';
import { templateMediaKindsAt } from './properties.ts';

export type MgParamsResolution =
	| { ok: true; params: Record<string, unknown>; filled: string[] }
	| {
			ok: false;
			code: Extract<ErrorCode, 'E_INVALID_PARAM' | 'E_NOT_FOUND'>;
			message: string;
			path?: string[];
	  };

type MediaKinds = Readonly<Record<string, Pick<MediaAsset, 'kind'> | undefined>>;

const invalid = (message: string, path?: string[]): MgParamsResolution => ({
	ok: false,
	code: 'E_INVALID_PARAM',
	message,
	...(path ? { path } : {}),
});

/**
 * Runs the template's fill hook on `given` (the params it omits, deterministically for `seed`); the given values
 * win whatever the hook returns. Templates without a hook: `given` unchanged, nothing filled. Never throws.
 */
export function fillTemplateParams(
	info: MgTemplateInfo,
	given: Record<string, unknown>,
	seed: number,
): MgParamsResolution {
	if (!info.fill) return { ok: true, params: given, filled: [] };
	const label = `${info.id}@${info.version}`;
	let r: ReturnType<NonNullable<MgTemplateInfo['fill']>>;
	try {
		r = info.fill({ ...given }, seed);
	} catch (e) {
		return invalid(`Could not fill the params of ${label}: ${(e as Error)?.message ?? e}`);
	}
	if (!r || typeof r !== 'object') return invalid(`The fill of ${label} returned nothing`);
	if (!r.ok) {
		const issues = Array.isArray(r.issues)
			? `: ${r.issues
					.slice(0, 10)
					.map((i) => (i && typeof i === 'object' && 'message' in i ? String(i.message) : JSON.stringify(i)))
					.join('; ')}`
			: '';
		return invalid(`Invalid params for ${label}: ${r.error}${issues}`);
	}
	const params = r.params;
	if (!params || typeof params !== 'object' || Array.isArray(params))
		return invalid(`The fill of ${label} returned no params object`);
	// The hook fills omitted params only: the given values win whatever it returned.
	return {
		ok: true,
		params: { ...params, ...given },
		filled: (Array.isArray(r.filled) ? r.filled : []).filter(
			(n): n is string => typeof n === 'string' && !Object.hasOwn(given, n),
		),
	};
}

/**
 * The first template media problem of `params`: a `{mediaId}` that is not in `media` (E_NOT_FOUND) or of a kind its
 * param does not take (E_INVALID_PARAM); null when every reference is fine.
 */
export function templateMediaIssue(
	media: MediaKinds,
	template: MgTemplateInfo,
	params: Record<string, unknown>,
): Extract<MgParamsResolution, { ok: false }> | null {
	for (const ref of templateMediaRefs(params)) {
		const path = ['params', ...ref.path.split('.')];
		const asset = media[ref.mediaId];
		if (!asset)
			return {
				ok: false,
				code: 'E_NOT_FOUND',
				message: `Media not found: ${ref.mediaId} (params.${ref.path})`,
				path,
			};
		const kinds = templateMediaKindsAt(template, ref.path.split('.'));
		if (kinds && kinds.length > 0 && !kinds.includes(asset.kind))
			return {
				ok: false,
				code: 'E_INVALID_PARAM',
				message: `params.${ref.path} takes ${kinds.join(' or ')} media, not ${asset.kind} (${ref.mediaId})`,
				path,
			};
	}
	return null;
}

/** Params schema → template media checks against `media` (no defaults merged, no fill). Never throws. */
export function validateTemplateParams(
	info: MgTemplateInfo,
	params: Record<string, unknown>,
	media: MediaKinds,
): MgParamsResolution {
	let parsed: ReturnType<MgTemplateInfo['paramsSchema']['safeParse']>;
	try {
		parsed = info.paramsSchema.safeParse(params);
	} catch (e) {
		return invalid(`Invalid params for ${info.id}@${info.version}: ${(e as Error)?.message ?? e}`);
	}
	if (!parsed.success) {
		const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
		return invalid(`Invalid params for ${info.id}@${info.version}: ${msg}`);
	}
	const out = parsed.data as Record<string, unknown>;
	return templateMediaIssue(media, info, out) ?? { ok: true, params: out, filled: [] };
}

/**
 * The params a new clip of `info` stores: fill (when `seed` is given) → defaults merged under → params schema →
 * template media checks against `media`. `filled` lists what the fill hook filled. Never throws.
 */
export function resolveMgTemplateParams(
	info: MgTemplateInfo,
	given: Record<string, unknown>,
	opts: { seed?: number; media: MediaKinds },
): MgParamsResolution {
	const fill = opts.seed === undefined ? null : fillTemplateParams(info, given, opts.seed);
	if (fill && !fill.ok) return fill;
	const r = validateTemplateParams(info, { ...info.defaults, ...(fill ? fill.params : given) }, opts.media);
	return r.ok ? { ...r, filled: fill ? fill.filled : [] } : r;
}

/**
 * What the per-instance rule reads of a template: a registry template (`MgTemplateInfo`) or its JSON view (the
 * engine catalogue entry, `MgImportTemplate`). JSON views carry no hook: the registry accepts `ui.addAnother` only on a
 * template with a fill hook, so their list stands; a registry template whose `fill` is absent re-randomizes nothing.
 */
export type MgInstanceTemplate = {
	ui?: { addAnother?: { reroll: readonly string[] } | undefined } | undefined;
	fill?: unknown;
};

/**
 * The per-instance params of a template (`ui.addAnother.reroll`: a comment's identity and stats): every new instance
 * gets its own from the fill hook. Empty for a registry template without a fill hook.
 */
export function mgRerollParams(info: MgInstanceTemplate): string[] {
	if (Object.hasOwn(info, 'fill') && typeof info.fill !== 'function') return [];
	const list = info.ui?.addAnother?.reroll;
	return Array.isArray(list) ? [...new Set(list.filter((n): n is string => typeof n === 'string'))] : [];
}

/**
 * The one layering rule of a new instance of a template (social-comments design §7.9–7.10, "presets set the look"):
 * `base` — a preset's params, or the params of the clip "Add another" copies — without the per-instance params
 * (`mgRerollParams`) the caller does not give, then `given` over it. The template's fill hook (deterministic for the
 * instance's seed) fills the dropped ones, so every instance gets its own identity and stats while the look (variant,
 * theme, text, toggles, animation) comes from `base`. `reroll` lists the dropped params. Used by MCP
 * `add_motion_graphic` (presets), the bulk import (`planMgImport`: web dialog and MCP) and `clip.duplicateMotionGraphic`
 * (Add another). Never throws.
 */
export function mgInstanceParams(
	template: MgInstanceTemplate,
	base: Readonly<Record<string, unknown>> | undefined,
	given: Readonly<Record<string, unknown>> | undefined,
): { params: Record<string, unknown>; reroll: string[] } {
	const own = given ?? {};
	const reroll = mgRerollParams(template).filter((n) => !Object.hasOwn(own, n));
	const params: Record<string, unknown> = { ...(base ?? {}) };
	for (const n of reroll) delete params[n];
	return { params: { ...params, ...own }, reroll };
}

/** Longest content name of a motion-graphic clip (`mgClipName`). */
export const MG_CLIP_NAME_MAX = 80;

/**
 * The name a new clip of `info` with `params` gets: the template's `clipName` hook (whitespace and control
 * characters collapsed, cut to `MG_CLIP_NAME_MAX` with "…"), else the template name. Never throws.
 */
export function mgClipName(
	info: Pick<MgTemplateInfo, 'name' | 'clipName'>,
	params: Record<string, unknown>,
): string {
	let raw: unknown;
	try {
		raw = info.clipName?.(params);
	} catch {
		raw = undefined;
	}
	if (typeof raw !== 'string') return info.name;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
	const name = raw.replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim();
	if (!name) return info.name;
	const chars = [...name];
	return chars.length <= MG_CLIP_NAME_MAX
		? name
		: `${chars
				.slice(0, MG_CLIP_NAME_MAX - 1)
				.join('')
				.trimEnd()}…`;
}

/**
 * Whether `name` is an automatic name of a clip of `info` with `params` (the template name — what clips were named
 * before content names — or `mgClipName`), so it may follow the params; false once the user renamed the clip.
 */
export function isMgAutoClipName(
	info: Pick<MgTemplateInfo, 'name' | 'clipName'>,
	name: string,
	params: Record<string, unknown>,
): boolean {
	return name === info.name || name === mgClipName(info, params);
}
