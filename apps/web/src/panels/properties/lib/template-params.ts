// WP7a: multi-param writes for custom template-param controls and group actions (`onChangeParams`): one patch per
// selected clip, planned through the same `param.set` path as a row edit (a keyframe at the playhead when the param is
// animated), applied as ONE undoable transaction. Pure planning + a small React helper used by both inspector panels.
import type {
	Clip,
	Command,
	MgTemplateRegistry,
	ProjectDocument,
	PropertySpec,
	Sequence,
} from '@jasper/project';
import type {
	TemplateParamControlDef,
	TemplateParamPatch,
	TemplateParamPatchInput,
	TemplateParamWriteOptions,
} from '../../../extensions/index.ts';
import { t } from '../../../i18n/runtime.ts';
import { bindProperty, makeRow, planSet } from './model.ts';
import type { InspectorOps } from './ops.ts';

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** The clip's static template params ({} for clips without). */
export const clipParams = (clip: Clip): Readonly<Record<string, unknown>> => {
	const p = (clip as { params?: unknown }).params;
	return isRecord(p) ? p : {};
};

/** At most this many params per patch (a control never needs more; a bad patch cannot blow up the plan). */
const MAX_PATCH_KEYS = 64;

/**
 * The commands writing `input` to `clips` at `frame`. A function input is called per clip (a throw or a non-object
 * result leaves that clip alone); names the clip's template does not have are skipped.
 */
export function planTemplateParamPatch(
	doc: ProjectDocument,
	seq: Sequence,
	clips: readonly Clip[],
	frame: number,
	mg: MgTemplateRegistry | undefined,
	input: TemplateParamPatchInput,
): { commands: Command[]; skipped: string[] } {
	const patches = new Map<string, TemplateParamPatch>();
	clips.forEach((clip, i) => {
		let patch: unknown;
		try {
			patch = typeof input === 'function' ? input(clipParams(clip), clip.id, i) : input;
		} catch (err) {
			console.warn('[properties] template param patch failed', err);
			patch = null;
		}
		if (isRecord(patch)) patches.set(clip.id, patch);
	});
	const names: string[] = [];
	for (const p of patches.values())
		for (const k of Object.keys(p)) if (!names.includes(k) && names.length < MAX_PATCH_KEYS) names.push(k);
	const commands: Command[] = [];
	const skipped = new Set<string>();
	for (const name of names) {
		const targets = clips.filter((c) => patches.get(c.id) && Object.hasOwn(patches.get(c.id)!, name));
		const row = makeRow(
			`params.${name}`,
			targets.map((c) => bindProperty(doc, seq, c, `params.${name}`, frame, mg)),
		);
		if (!row) continue;
		const plan = planSet(row, frame, (_base, b) => patches.get(b.clip.id)?.[name]);
		commands.push(...plan.commands);
		for (const id of plan.skipped) skipped.add(id);
	}
	return { commands, skipped: [...skipped] };
}

/** Applies a patch as one user transaction; true when applied (an empty plan counts as applied). */
export function applyTemplateParamPatch(
	ctx: {
		doc: ProjectDocument;
		seq: Sequence;
		ops: InspectorOps;
		/** Live playhead (writes key at it when the param is animated). */
		frame(): number;
		hint?(message: string): void;
	},
	clips: readonly Clip[],
	mg: MgTemplateRegistry | undefined,
	input: TemplateParamPatchInput,
	label: string,
	opts: TemplateParamWriteOptions = {},
): boolean {
	const plan = planTemplateParamPatch(ctx.doc, ctx.seq, clips, ctx.frame(), mg, input);
	if (plan.skipped.length) ctx.hint?.(t('Move the playhead over the clip to add a keyframe'));
	if (plan.commands.length === 0) return plan.skipped.length === 0;
	const r = ctx.ops.apply(
		opts.label ?? label,
		plan.commands,
		opts.coalesceKey ? { coalesceKey: opts.coalesceKey } : {},
	);
	return r?.ok === true;
}

const paramOf = (spec: Pick<PropertySpec, 'key'>) =>
	spec.key.startsWith('params.') ? spec.key.slice('params.'.length) : null;

/** The registered control a template param spec names, if any. */
export function controlOf(
	spec: Pick<PropertySpec, 'key' | 'ui'>,
	controls: readonly TemplateParamControlDef[],
): TemplateParamControlDef | undefined {
	const name = spec.ui.customControl;
	return name && paramOf(spec) !== null ? controls.find((c) => c.id === name) : undefined;
}

/**
 * Params whose rows are hidden because a shown row's control edits them too (`alsoEdits`, e.g. `timeUnit` under the
 * social time control on `timeValue`). A control never hides its own row.
 */
export function absorbedTemplateParams(
	specs: readonly Pick<PropertySpec, 'key' | 'ui'>[],
	controls: readonly TemplateParamControlDef[],
): Set<string> {
	const out = new Set<string>();
	for (const s of specs) {
		const own = paramOf(s);
		for (const name of controlOf(s, controls)?.alsoEdits ?? []) if (name !== own) out.add(name);
	}
	return out;
}
