// Template upgrades migrate and validate params, update the renderer, and drop keys for deleted params.
// Animated template params split their static values and keys between params[name] and paramKeyframes[name].
import type { Draft } from 'immer';
import { templateMediaRefs } from '../../param-media.ts';
import type { MgTemplateInfo } from '../../registry/mg.ts';
import { paramsPropertySpecs, templateMediaKindsAt } from '../../registry/properties.ts';
import type { Animatable, Keyframe } from '../../schema/common.ts';
import type { MediaAsset } from '../../schema/media.ts';
import type { Clip } from '../../schema/sequence.ts';
import type { DClip, DSeq, HandlerContext } from '../context.ts';
import type { ClipPatch } from '../schemas/clip.ts';

type MgClip = Extract<Clip, { kind: 'motion-graphic' }>;
type DMgClip = Draft<MgClip>;

/** Removes an emptied keyframe list (and an empty `paramKeyframes`) after an edit; see `finish` in keyframe.ts. */
export const PRUNE_EMPTY_KEYFRAMES = Symbol('pruneEmptyKeyframes');

/**
 * The Animatable view of one keyframable param on a draft motion-graphic clip. Reads and writes go to
 * `params[name]` (static value; `validate` checks it against the template, e.g. with `h.fail`) and
 * `paramKeyframes[name]` (keyframes). The keyframe list is attached to the document only when a key is pushed,
 * so a plain `param.set` on a static param leaves no empty list behind.
 */
export function templateParamDraftAnim(
	clip: DClip,
	name: string,
	validate?: (next: Record<string, unknown>) => void,
): Draft<Animatable<unknown>> {
	const mg = clip as DMgClip;
	const attach = (): Draft<Keyframe<unknown>>[] => {
		mg.paramKeyframes ??= {};
		mg.paramKeyframes[name] ??= [];
		return mg.paramKeyframes[name] as Draft<Keyframe<unknown>>[];
	};
	// Reads see an empty list; `push` attaches the real one first.
	const empty = new Proxy([] as Draft<Keyframe<unknown>>[], {
		get(target, prop, receiver) {
			if (prop === 'push') return (...items: Draft<Keyframe<unknown>>[]) => attach().push(...items);
			return Reflect.get(target, prop, receiver);
		},
	});
	const prune = () => {
		const kf = mg.paramKeyframes;
		if (!kf) return;
		if (kf[name] && kf[name]!.length === 0) delete kf[name];
		if (Object.keys(kf).length === 0) delete mg.paramKeyframes;
	};
	const anim = {
		get value() {
			return (mg.params as Record<string, unknown>)[name];
		},
		set value(v: unknown) {
			const params = mg.params as Record<string, unknown>;
			validate?.({ ...params, [name]: v });
			params[name] = v;
		},
		get keyframes(): Draft<Keyframe<unknown>>[] {
			return (mg.paramKeyframes?.[name] as Draft<Keyframe<unknown>>[] | undefined) ?? empty;
		},
		set keyframes(list: Draft<Keyframe<unknown>>[]) {
			if (list.length === 0) {
				if (mg.paramKeyframes?.[name]) mg.paramKeyframes[name] = [];
				prune();
				return;
			}
			mg.paramKeyframes ??= {};
			mg.paramKeyframes[name] = list as never;
		},
		[PRUNE_EMPTY_KEYFRAMES]: prune,
	};
	return anim as unknown as Draft<Animatable<unknown>>;
}

/** Validator for `templateParamDraftAnim`: the whole params object must pass the template schema. */
export function templateParamsValidator(
	template: MgTemplateInfo,
	label: string,
	h: HandlerContext,
): (next: Record<string, unknown>) => void {
	return (next) => {
		if (!template.paramsSchema.safeParse(next).success)
			h.fail('E_INVALID_PARAM', `Invalid value for ${label}`);
	};
}

/**
 * Template media params (avatars, `mediaParam()`): every `{mediaId}` in `params` names a medium of the project
 * (else E_NOT_FOUND) of a kind its param takes (else E_INVALID_PARAM).
 */
export function assertTemplateMedia(
	media: Readonly<Record<string, Pick<MediaAsset, 'kind'> | undefined>>,
	template: MgTemplateInfo,
	params: Record<string, unknown>,
	h: HandlerContext,
): void {
	for (const ref of templateMediaRefs(params)) {
		const path = ['params', ...ref.path.split('.')];
		const asset = media[ref.mediaId];
		if (!asset) h.fail('E_NOT_FOUND', `Media not found: ${ref.mediaId} (params.${ref.path})`, { path });
		const kinds = templateMediaKindsAt(template, ref.path.split('.'));
		if (kinds && kinds.length > 0 && !kinds.includes(asset.kind))
			h.fail(
				'E_INVALID_PARAM',
				`params.${ref.path} takes ${kinds.join(' or ')} media, not ${asset.kind} (${ref.mediaId})`,
				{ path },
			);
	}
}

/** Keyframes of params that stay keyframable (same value shape) in `info`; the others are dropped. */
function keptParamKeyframes(
	info: MgTemplateInfo,
	params: Record<string, unknown>,
	kf: Record<string, Keyframe<unknown>[]>,
): { kept: Record<string, Keyframe<unknown>[]>; dropped: string[] } {
	const specs = new Map(
		paramsPropertySpecs(info)
			.filter((s) => s.animatable !== 'no')
			.map((s) => [s.key.slice('params.'.length), s]),
	);
	const kept: Record<string, Keyframe<unknown>[]> = {};
	const dropped: string[] = [];
	for (const [name, list] of Object.entries(kf)) {
		if (list.length === 0) continue;
		const s = specs.get(name);
		const shape = (v: unknown) => (Array.isArray(v) ? `a${v.length}` : typeof v);
		const want = shape(params[name]);
		if (s && list.every((k) => shape(k.value) === want)) kept[name] = JSON.parse(JSON.stringify(list));
		else dropped.push(name);
	}
	return { kept, dropped };
}

/** Aspect ratios closer than this (|ln(a/b)|, ≈ 0.5 %) are the same design canvas (1280×720 ≈ 1920×1080). */
const ASPECT_EPS = 0.005;

/**
 * True when a template draws `size` with one of its design canvases (same aspect ratio; the design is fitted
 * uniformly, so the scale does not matter). Templates that list no canvases accept any size.
 */
function templateSupportsCanvas(
	info: Pick<MgTemplateInfo, 'canvases'>,
	size: { width: number; height: number },
): boolean {
	if (!info.canvases?.length) return true;
	const ar = Math.log(Math.max(1, size.width) / Math.max(1, size.height));
	return info.canvases.some((c) => Math.abs(ar - Math.log(c.width / c.height)) < ASPECT_EPS);
}

/** clip.update `{template: {version}}` (S11:ATP-009). */
export function applyTemplatePatch(
	seq: DSeq,
	clip: DClip,
	p: Pick<ClipPatch, 'template' | 'canvas'>,
	h: HandlerContext,
): void {
	if (p.template === undefined) return;
	if (clip.kind !== 'motion-graphic')
		h.fail('E_INVALID_PARAM', `template does not apply to ${clip.kind} clips`);
	const mg = clip as DMgClip;
	const id = mg.template.id;
	const from = mg.template.version;
	const to = p.template.version;
	if (to === from) return;
	if (to < from)
		h.fail('E_INVALID_PARAM', `Template ${id} cannot go back from version ${from} to ${to}`, {
			path: ['template', 'version'],
		});
	const reg = h.registries.mgTemplates;
	const info = reg.get(id, to);
	if (!info)
		h.fail('E_INVALID_PARAM', `Template ${id}@${to} is not installed`, { path: ['template', 'version'] });
	const up = reg.upgrade?.(id, from, { ...(mg.params as Record<string, unknown>) }, to) ?? null;
	if (!up || up.version !== to)
		h.fail('E_INVALID_PARAM', `No upgrade path from ${id}@${from} to ${id}@${to}`, {
			path: ['template', 'version'],
		});
	const parsed = info.paramsSchema.safeParse(up.params);
	if (!parsed.success)
		h.fail('E_INVALID_PARAM', `The upgrade of ${id} to version ${to} produced invalid params`, {
			path: ['template', 'version'],
		});
	// The clip's canvas (the one a `canvas` in the same patch sets) must be one the new version draws, when the old
	// version did: refuse instead of silently letterboxing a design the clip used to fill.
	const target = (p.canvas ?? mg.canvas) as MgClip['canvas'];
	const canvas =
		target === 'sequence'
			? { width: seq.settings.width, height: seq.settings.height }
			: { width: target.width, height: target.height };
	const old = reg.get(id, from);
	if (!templateSupportsCanvas(info, canvas) && (!old || templateSupportsCanvas(old, canvas)))
		h.fail(
			'E_INVALID_PARAM',
			`Template ${id}@${to} has no ${canvas.width}×${canvas.height} canvas (it draws ${(info.canvases ?? [])
				.map((c) => `${c.width}×${c.height}`)
				.join(', ')}); change the clip's canvas first or in the same patch`,
			{ path: ['template', 'version'] },
		);
	const params = parsed.data as Record<string, unknown>;
	mg.template.version = to;
	// S11:ATP-002: the renderer stamp follows the registry entry.
	if (info.renderer === 'anime') mg.template.renderer = 'anime';
	else delete mg.template.renderer;
	mg.params = params as never;
	if (mg.paramKeyframes) {
		const { kept, dropped } = keptParamKeyframes(
			info,
			params,
			mg.paramKeyframes as Record<string, Keyframe<unknown>[]>,
		);
		if (Object.keys(kept).length > 0) mg.paramKeyframes = kept as never;
		else delete mg.paramKeyframes;
		if (dropped.length > 0)
			h.warn(
				'W_KEYFRAMES_DROPPED',
				`Keyframes dropped by the upgrade to ${id}@${to}: ${dropped.join(', ')}`,
				['paramKeyframes'],
			);
	}
}
