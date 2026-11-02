// Media referenced from motion-graphic template params (social comments: avatars; docs/wp-notes/social-comments.md
// "Template media params"). A template param holds `{mediaId}` (or null = none), possibly nested inside arrays or
// objects. Every reference-integrity path (orphan collection, item delete, usage, Project Manager, relink, paste,
// invariants and repair) reads them through these helpers, so a medium used only by a template is never dropped.
import type { Clip } from './schema/sequence.ts';

/**
 * JSON-schema metadata of a template media param (`mediaParam()` of @jasper/mg-templates): `x-jasper-kind: "media"`
 * and the media kinds it takes (`x-jasper-media-kinds`, e.g. `["image"]`). `paramsPropertySpecs` maps such a param
 * to the media picker; `validateMgParams` checks the kinds.
 */
export const TEMPLATE_PARAM_KIND_KEY = 'x-jasper-kind';
export const TEMPLATE_MEDIA_KIND = 'media';
export const TEMPLATE_MEDIA_KINDS_KEY = 'x-jasper-media-kinds';

/** Deepest nesting a walk follows (template params are flat records; anything deeper is ignored). */
export const PARAM_MEDIA_MAX_DEPTH = 32;
/** Most values a walk visits (bounds the work on hostile or damaged params). */
export const PARAM_MEDIA_MAX_NODES = 100_000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

/** The id of a `{mediaId: string}` reference object (non-empty), else null. */
export function paramMediaRef(v: unknown): string | null {
	if (!isObject(v) || Array.isArray(v)) return null;
	const id = (v as { mediaId?: unknown }).mediaId;
	return typeof id === 'string' && id !== '' ? id : null;
}

/** Visits every `{mediaId}` reference inside `value` with its dotted path (bounded, cycle-safe). */
function walkRefs(value: unknown, visit: (mediaId: string, path: string[]) => void): void {
	const seen = new WeakSet<object>();
	let nodes = 0;
	const walk = (v: unknown, path: string[]): void => {
		if (!isObject(v) || path.length > PARAM_MEDIA_MAX_DEPTH || nodes >= PARAM_MEDIA_MAX_NODES || seen.has(v))
			return;
		seen.add(v);
		nodes++;
		const id = paramMediaRef(v);
		if (id !== null) visit(id, path);
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) walk(v[i], [...path, String(i)]);
		} else for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
	};
	walk(value, []);
}

/**
 * Every media id referenced by a `{mediaId: string}` object anywhere inside `value` (first-seen order, no
 * duplicates; `''` is "none" and skipped). Bounded (depth ≤ {@link PARAM_MEDIA_MAX_DEPTH}, ≤
 * {@link PARAM_MEDIA_MAX_NODES} values) and cycle-safe.
 */
export function collectParamMediaIds(value: unknown): string[] {
	const out = new Set<string>();
	walkRefs(value, (id) => out.add(id));
	return [...out];
}

/** Every `{mediaId}` reference inside `value` with its dotted path (`avatar`, `gallery.0`), same bounds. */
export function templateMediaRefs(value: unknown): { path: string; mediaId: string }[] {
	const out: { path: string; mediaId: string }[] = [];
	walkRefs(value, (mediaId, path) => out.push({ path: path.join('.'), mediaId }));
	return out;
}

/**
 * `{mediaId}` values of effect parameters (LUTs, depth maps, reflection images, mattes), keyframes included
 * (`''` = None is skipped). Bounded by {@link PARAM_MEDIA_MAX_NODES}.
 */
export function effectMediaRefs(
	effects: readonly { id?: unknown; params?: unknown }[] | undefined,
): { effectId: string; param: string; mediaId: string }[] {
	const out: { effectId: string; param: string; mediaId: string }[] = [];
	if (!Array.isArray(effects)) return out;
	let nodes = 0;
	for (const fx of effects) {
		if (!isObject(fx) || !isObject(fx.params)) continue;
		for (const [param, a] of Object.entries(fx.params as Record<string, unknown>)) {
			if (!isObject(a) || ++nodes > PARAM_MEDIA_MAX_NODES) continue;
			const { value, keyframes } = a as { value?: unknown; keyframes?: unknown };
			const values = [value];
			if (Array.isArray(keyframes))
				for (const k of keyframes) values.push(isObject(k) ? (k as { value?: unknown }).value : undefined);
			for (const v of values) {
				const mediaId = paramMediaRef(v);
				if (mediaId !== null) out.push({ effectId: String(fx.id ?? ''), param, mediaId });
			}
		}
	}
	return out;
}

/**
 * Media ids a clip references besides its own source, each once: motion-graphic template params, a light's
 * environment image (`light.environmentMediaId`) and the `{mediaId}` params of its effects (any clip kind). Every
 * reference-integrity path counts these as uses (orphans, item delete, usage, Project Manager, invariants).
 */
export function clipParamMediaIds(clip: Pick<Clip, 'kind'>): string[] {
	const r = clip as { params?: unknown; light?: unknown; effects?: unknown };
	const out = new Set<string>();
	if (clip.kind === 'motion-graphic') for (const id of collectParamMediaIds(r.params)) out.add(id);
	if (clip.kind === 'light' && isObject(r.light)) {
		const env = (r.light as { environmentMediaId?: unknown }).environmentMediaId;
		if (typeof env === 'string' && env !== '') out.add(env);
	}
	for (const ref of effectMediaRefs(r.effects as never)) out.add(ref.mediaId);
	return [...out];
}

/**
 * Sets every effect `{mediaId}` value (and key) naming a medium in `gone` to None (`{mediaId: ''}`: effect params
 * have no null), in place. Returns the cleared `effects.<effect id>.<param>` paths. Works on drafts.
 */
export function clearEffectMedia(
	effects: readonly { id?: unknown; params?: unknown }[] | undefined,
	gone: (mediaId: string) => boolean,
): string[] {
	const cleared: string[] = [];
	if (!Array.isArray(effects)) return cleared;
	for (const fx of effects) {
		if (!isObject(fx) || !isObject(fx.params)) continue;
		for (const [param, a] of Object.entries(fx.params as Record<string, unknown>)) {
			if (!isObject(a)) continue;
			const holder = a as { value?: unknown; keyframes?: unknown };
			let hit = false;
			const fix = (v: unknown): unknown => {
				const id = paramMediaRef(v);
				if (id === null || !gone(id)) return v;
				hit = true;
				return { ...(v as object), mediaId: '' };
			};
			holder.value = fix(holder.value);
			if (Array.isArray(holder.keyframes))
				for (const k of holder.keyframes)
					if (isObject(k)) (k as { value?: unknown }).value = fix((k as { value?: unknown }).value);
			if (hit) cleared.push(`effects.${String(fx.id)}.${param}`);
		}
	}
	return cleared;
}

/**
 * Returns `value` with its `{mediaId}` references rewritten: `map(id)` returns the new id, `null` to clear the
 * reference (the object becomes `null`, a template's "none") or `undefined` to keep it. Untouched branches keep
 * their identity; `changed` lists the dotted paths that were rewritten. Same bounds as
 * {@link collectParamMediaIds} (deeper / further values are kept as they are).
 */
export function rewriteParamMedia<T>(
	value: T,
	map: (mediaId: string) => string | null | undefined,
): { value: T; changed: string[] } {
	const changed: string[] = [];
	const seen = new WeakSet<object>();
	let nodes = 0;
	const walk = (v: unknown, path: string[]): unknown => {
		if (!isObject(v) || path.length > PARAM_MEDIA_MAX_DEPTH || nodes >= PARAM_MEDIA_MAX_NODES || seen.has(v))
			return v;
		seen.add(v);
		nodes++;
		const id = paramMediaRef(v);
		if (id !== null) {
			const next = map(id);
			if (next === null) {
				changed.push(path.join('.'));
				return null;
			}
			if (next !== undefined && next !== id) {
				changed.push(path.join('.'));
				return { ...v, mediaId: next };
			}
		}
		let copy: unknown[] | Record<string, unknown> | null = null;
		if (Array.isArray(v)) {
			v.forEach((x, i) => {
				const y = walk(x, [...path, String(i)]);
				if (y !== x) {
					copy ??= [...v];
					(copy as unknown[])[i] = y;
				}
			});
		} else {
			for (const [k, x] of Object.entries(v)) {
				const y = walk(x, [...path, k]);
				if (y !== x) {
					copy ??= { ...v };
					(copy as Record<string, unknown>)[k] = y;
				}
			}
		}
		return copy ?? v;
	};
	return { value: walk(value, []) as T, changed };
}
