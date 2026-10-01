// Motion-graphic templates in the command layer (M2, ARCHITECTURE §20.1). Owner: wp-m2-anime-templates.
// - S11:ATP-009 (FIX-005): `clip.update {template: {version}}` upgrades a clip through the registry's upgrade path
//   (params migrated and validated, renderer re-stamped, keyframes of params that no longer exist dropped).
// - S11:ATP-006: the draft-side Animatable view of a keyframable anime template param (`params[name]` +
//   `paramKeyframes[name]`), used by param.set / param.setAnimated (param.ts) and the keyframe handlers.
import type { Draft } from 'immer';
import type { MgTemplateInfo } from '../../registry/mg.ts';
import { paramsPropertySpecs } from '../../registry/properties.ts';
import type { Animatable, Keyframe } from '../../schema/common.ts';
import type { Clip } from '../../schema/sequence.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import type { ClipPatch } from '../schemas/clip.ts';

export const MG_TEMPLATE_OWNER = 'wp-m2-anime-templates';

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
		get value(): unknown {
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

/** clip.update `{template: {version}}` (S11:ATP-009). Returns true when it handled the patch. */
export function applyTemplatePatch(
	_doc: DDoc,
	_seq: DSeq,
	clip: DClip,
	p: Pick<ClipPatch, 'template'>,
	h: HandlerContext,
): boolean {
	if (p.template === undefined) return false;
	if (clip.kind !== 'motion-graphic')
		return h.fail('E_INVALID_PARAM', `template does not apply to ${clip.kind} clips`);
	const mg = clip as DMgClip;
	const id = mg.template.id;
	const from = mg.template.version;
	const to = p.template.version;
	if (to === from) return true;
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
			JSON.parse(JSON.stringify(mg.paramKeyframes)) as Record<string, Keyframe<unknown>[]>,
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
	return true;
}
