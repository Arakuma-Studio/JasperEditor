// keyframes.simplify (M3, S09:TRK-023, S01:KF-010): resolves the parameters to simplify (selected keys, whole
// parameters or clips), plans with `animation/simplify-doc.ts` and writes the reduced keyframes in place (one
// transaction = one History entry; a dry run previews the report). Shared with `tracker.apply {simplify}`.
import type { Draft } from 'immer';
import { planSimplify, type SimplifyReport, type SimplifyTarget } from '../../animation/simplify-doc.ts';
import { resolvePropertySpec } from '../../registry/properties.ts';
import { CORNER_PIN_EFFECT_ID, CORNER_PIN_PARAMS } from '../../render/scene.ts';
import type { Animatable, Keyframe } from '../../schema/common.ts';
import type { Clip, EffectInstance, ProjectDocument, Sequence, TrackedBy } from '../../schema/index.ts';
import type { DClip, DDoc, HandlerContext } from '../context.ts';
import type { CommandOf } from '../schemas/index.ts';
import { type AnimLocation, allAnimatables, clipAnimatables, finish, locate, targetOf } from './keyframe.ts';
import { locateEffect } from './param.ts';
import type { HandlerMap } from './util.ts';

type DAnim = Draft<Animatable<unknown>>;

/** A parameter to simplify: where it lives and (optionally) which of its keys may go. */
export type SimplifyLocation = { loc: AnimLocation; selected?: Set<string> };

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function pathKey(p: readonly string[]): string {
	return p.join('\u0000');
}

/** Unit and label of a location (for reports and value groups). */
function describe(doc: DDoc, loc: AnimLocation, h: HandlerContext): { unit: string; label: string } {
	const [head, id, ...rest] = loc.path;
	if (head === 'clip') {
		const spec = resolvePropertySpec(rest.join('.'), undefined, undefined, loc.clip as unknown as Clip);
		return { unit: spec?.unit ?? '', label: spec?.label ?? rest.join('.') };
	}
	if (head === 'effect') {
		const fx = locateEffect(doc, id!)?.fx;
		const spec = fx ? h.registries.effects.get(fx.effectId, fx.effectVersion) : undefined;
		const p = spec?.params.find((x) => x.name === rest[0]);
		return {
			unit: p?.unit ?? '',
			label: `${spec?.label ?? fx?.effectId ?? 'Effect'} › ${p?.label ?? rest[0]}`,
		};
	}
	const spec = resolvePropertySpec(rest[0] ?? id ?? '');
	return { unit: spec?.unit ?? '', label: loc.path.join('.') };
}

/** Parameters `tracker.apply` writes on a target (its `trackedBy`): the corner pin corners or Motion. */
export function trackedLocations(clipLocs: readonly AnimLocation[], clip: DClip): AnimLocation[] {
	const tb = (clip as { trackedBy?: TrackedBy }).trackedBy;
	if (!tb) return [];
	if (tb.mode === 'corner-pin') {
		const effects = (clip as { effects?: Draft<EffectInstance>[] }).effects ?? [];
		const pin =
			effects.find((e) => e.id === tb.effectInstanceId) ??
			effects.find((e) => e.effectId === CORNER_PIN_EFFECT_ID);
		if (!pin) return [];
		return clipLocs.filter(
			(l) =>
				l.path[0] === 'effect' &&
				l.path[1] === pin.id &&
				(CORNER_PIN_PARAMS as readonly string[]).includes(l.path[2]!),
		);
	}
	const keys = new Set([
		'transform.position',
		'transform.scale',
		'transform.scaleWidth',
		'transform.rotation',
	]);
	return clipLocs.filter((l) => l.path[0] === 'clip' && keys.has(l.path.slice(2).join('.')));
}

/** Resolves the command's selection to locations (each parameter once). */
function resolveLocations(
	doc: DDoc,
	cmd: CommandOf<'keyframes.simplify'>,
	h: HandlerContext,
): SimplifyLocation[] {
	const modes = [cmd.keyframeIds, cmd.targets, cmd.clipIds].filter((x) => x !== undefined).length;
	if (modes !== 1)
		h.fail('E_INVALID_PARAM', 'Give exactly one of keyframeIds, targets or clipIds to simplify');
	if (cmd.trackedOnly && !cmd.clipIds) h.fail('E_INVALID_PARAM', 'trackedOnly applies to clipIds');
	const out = new Map<string, SimplifyLocation>();
	if (cmd.keyframeIds) {
		for (const l of locate(doc, cmd.keyframeIds, h)) {
			const k = pathKey(l.path);
			const cur = out.get(k) ?? { loc: l, selected: new Set<string>() };
			cur.selected!.add(l.key.id);
			out.set(k, cur);
		}
	} else if (cmd.targets) {
		const all = allAnimatables(doc);
		for (const target of cmd.targets) {
			// Normalise ['clip', id, 'transform.position'] and ['clip', id, 'transform', 'position'].
			const want =
				target[0] === 'clip' ? ['clip', target[1]!, ...target.slice(2).join('.').split('.')] : target;
			const loc = all.find((l) => pathKey(l.path) === pathKey(want));
			if (!loc) h.fail('E_NOT_FOUND', `No keyframed parameter at ${JSON.stringify(target)}`);
			out.set(pathKey(loc.path), { loc });
		}
	} else {
		for (const id of cmd.clipIds!) {
			const { seq, clip } = h.clip(doc, id);
			const locs = clipAnimatables(seq, clip).filter((l) => l.anim.keyframes.length > 0);
			for (const loc of cmd.trackedOnly ? trackedLocations(locs, clip) : locs)
				out.set(pathKey(loc.path), { loc });
		}
	}
	return [...out.values()];
}

/**
 * Simplifies the given locations in place and returns the report (S09:TRK-023). Hold-only parameters and ones
 * with fewer than three keys in their span are reported as skipped.
 */
export function simplifyLocations(
	doc: DDoc,
	locations: readonly SimplifyLocation[],
	tolerance: number,
	h: HandlerContext,
	opts: { details?: boolean } = {},
): SimplifyReport {
	const targets: SimplifyTarget[] = [];
	const anims: DAnim[] = [];
	const skipped: SimplifyReport['skipped'] = [];
	for (const { loc, selected } of locations) {
		const t = targetOf(doc, loc, h); // lock check, value rule
		if (t.rule.holdOnly) {
			skipped.push({ path: [...loc.path], reason: 'hold-only parameter' });
			continue;
		}
		const d = describe(doc, loc, h);
		targets.push({
			path: [...loc.path],
			anim: { value: plain(loc.anim.value), keyframes: plain(loc.anim.keyframes) as Keyframe<unknown>[] },
			seq: loc.seq as unknown as Sequence,
			clip: (loc.clip as unknown as Clip) ?? null,
			...(selected ? { selected } : {}),
			unit: d.unit,
			label: d.label,
		});
		anims.push(loc.anim);
	}
	let plan: ReturnType<typeof planSimplify>;
	try {
		plan = planSimplify(doc as unknown as ProjectDocument, targets, tolerance, opts);
	} catch (e) {
		return h.fail('E_INVALID_PARAM', (e as Error).message);
	}
	const touched: DAnim[] = [];
	plan.keys.forEach((keys, i) => {
		if (!keys || keys.length === targets[i]!.anim.keyframes.length) return;
		anims[i]!.keyframes = keys as never;
		touched.push(anims[i]!);
	});
	finish(touched);
	return { ...plan.report, skipped: [...skipped, ...plan.report.skipped] };
}

export const simplifyHandlers: HandlerMap = {
	'keyframes.simplify': (doc, cmd: CommandOf<'keyframes.simplify'>, h: HandlerContext) => {
		const locations = resolveLocations(doc, cmd, h);
		if (!locations.length) h.fail('E_INVALID_PARAM', 'Nothing to simplify: no keyframed parameters selected');
		const report = simplifyLocations(doc, locations, cmd.tolerance, h, { details: cmd.details === true });
		// Simplifying the tracked keys of a target remembers the tolerance: re-applying the tracker from the UI
		// simplifies again (S09:TRK-023).
		if (cmd.trackedOnly)
			for (const id of cmd.clipIds ?? []) {
				const tb = (h.clip(doc, id).clip as { trackedBy?: Draft<TrackedBy> }).trackedBy;
				if (tb) tb.simplify = { tolerance: cmd.tolerance };
			}
		if (report.properties.length === 0)
			h.warn('W_NOTHING_TO_SIMPLIFY', 'No parameter has three or more keyframes to simplify');
		return report;
	},
};
