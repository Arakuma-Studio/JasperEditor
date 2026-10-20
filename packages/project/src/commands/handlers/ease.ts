// Keyframe assistant (easing) commands — docs/wp-notes/easing.md. Every command edits plain copies of the selected
// properties' keys (`selectionGroups`), writes them back and runs `finish` (auto-bezier refresh, roving re-timing), so
// each is one undoable document edit. Refusals: E_NOT_FOUND (ids), E_TRACK_LOCKED (via target resolution),
// E_INVALID_PARAM (nothing applicable, wrong property types). Warnings: W_EASE_SKIPPED, W_EASE_FLAT_SEGMENT,
// W_EASE_CLAMPED, W_EASE_COUNT_MISMATCH, W_EASE_ROVING_CLEARED, W_VALUE_CLAMPED.
import type { Draft } from 'immer';
import { type CubicEase, cubicToEases, type MultiEase } from '../../ease/curve.ts';
import { applyMultiEase, MultiEaseError, spatialFor } from '../../ease/multi.ts';
import { planPathCleanup } from '../../ease/path-fit.ts';
import {
	captureEases,
	easeProgressRange,
	LINEAR_EASE,
	spanAverageVelocity,
	spanEases,
	spanLeaving,
	writeSpan,
} from '../../ease/segments.ts';
import { rovingRuns, stopRoving } from '../../keyframes.ts';
import { effectiveTangents } from '../../keyframes-spatial.ts';
import { SLIDER_CONTROL_ID } from '../../registry/expression-controls.ts';
import type { Animatable, Ease, Keyframe } from '../../schema/common.ts';
import type { EffectInstance } from '../../schema/sequence.ts';
import type { DDoc, HandlerContext } from '../context.ts';
import type { CommandOf } from '../schemas/index.ts';
import {
	describeEaseGroup,
	type EaseGroup,
	isPointGroup,
	isSteppingGroup,
	sectionSpans,
	selectionGroups,
} from './ease-read.ts';
import { effectHandlers } from './effect.ts';
import { finish } from './keyframe.ts';
import { validateValue } from './param.ts';
import type { HandlerMap } from './util.ts';
import { clone } from './util.ts';

export const EASE_OWNER = 'keyframe-ease' as const;

type Keys = Keyframe<unknown>[];

const EASY_EASE: Ease = { influence: 1 / 3, slope: 0 };
/** Default Clean Up Path tolerance (sequence px for Motion). */
export const DEFAULT_CLEANUP_TOLERANCE = 0.5;

/** Ids created / removed / changed by a command (result of the ease commands). */
class Changes {
	readonly created: string[] = [];
	readonly removed: string[] = [];
	private readonly before = new Map<string, string>();
	private readonly committed: EaseGroup[] = [];
	track(g: EaseGroup): void {
		for (const k of g.kfs) if (!this.before.has(k.id)) this.before.set(k.id, JSON.stringify(k));
	}
	/** Writes a group's keys back to the document and re-derives what `finish` maintains. */
	commit(g: EaseGroup, keys: Keys = g.kfs): void {
		g.loc.anim.keyframes = keys as never;
		finish([g.loc.anim]);
		this.committed.push(g);
	}
	result() {
		const created = new Set(this.created);
		const affected: string[] = [];
		for (const g of this.committed)
			for (const k of clone(g.loc.anim.keyframes) as Keys) {
				const was = this.before.get(k.id);
				if (!created.has(k.id) && was !== undefined && was !== JSON.stringify(k)) affected.push(k.id);
			}
		return { affected: [...new Set(affected)], created: [...this.created], removed: [...this.removed] };
	}
}

/** Fails when nothing could be applied; otherwise reports what was skipped. */
function settle(applied: number, skipped: string[], h: HandlerContext, what: string): void {
	if (!applied)
		h.fail(
			'E_INVALID_PARAM',
			skipped.length ? `Nothing to ${what}: ${skipped.join('; ')}` : `Nothing to ${what} in the selection`,
		);
	if (skipped.length) h.warn('W_EASE_SKIPPED', `Skipped ${skipped.join('; ')}`);
}

const isOrientation = (g: EaseGroup) => g.loc.path[g.loc.path.length - 1] === 'orientation';

/** 3D Orientation turns spherically with progress clamped to [0, 1] (`three-d/scene.ts`): report overshoot. */
function warnOrientation(g: EaseGroup, eases: readonly { out: Ease; in: Ease }[], h: HandlerContext): void {
	if (!isOrientation(g)) return;
	const leaves = eases.some((e) => {
		const [lo, hi] = easeProgressRange(e.out, e.in);
		return lo < -1e-9 || hi > 1 + 1e-9;
	});
	if (leaves)
		h.warn(
			'W_EASE_CLAMPED',
			`${g.target.label}: Orientation turns between its keys without overshoot, so the curve's overshoot is clamped`,
		);
}

/** A cubic on the chosen spans of one property; returns a skip reason or null. */
function applyCubic(
	g: EaseGroup,
	curve: CubicEase,
	sections: readonly string[] | undefined,
	h: HandlerContext,
) {
	const spans = sectionSpans(g, sections);
	if (!spans.length) return 'no segment in the chosen sections';
	const { easeOut, easeIn } = cubicToEases(curve);
	for (const sp of spans) writeSpan(g.kfs, sp.a, sp.b, easeOut, easeIn);
	warnOrientation(g, [{ out: easeOut, in: easeIn }], h);
	return null;
}

/** Stops roving on the span's end keys (keeping their times and speed) and clears it inside; true if any roved. */
function clearRoving(kfs: Keys, a: number, b: number): boolean {
	let any = false;
	for (let i = a; i <= b; i++) if (kfs[i]!.roving) any = true;
	if (!any) return false;
	// Fresh array copies: roving runs are cached per array.
	for (const i of [a, b]) if (kfs[i]!.roving) stopRoving([...kfs], i);
	for (let i = a; i <= b; i++) delete kfs[i]!.roving;
	return true;
}

/** A multi-point curve over the span first … last selected key; returns a skip reason or null. */
function applyMulti(g: EaseGroup, curve: MultiEase, h: HandlerContext, changes: Changes): string | null {
	const sel = g.selected;
	if (sel.length < 2) return 'a multi-point curve needs two or more selected keyframes of the property';
	const label = g.target.label;
	const kfs = g.kfs;
	const a = sel[0]!;
	const b = sel[sel.length - 1]!;
	const roved = clearRoving(kfs, a, b);
	let r: ReturnType<typeof applyMultiEase>;
	try {
		r = applyMultiEase({
			kfs,
			a,
			b,
			curve,
			spatial: isPointGroup(g),
			newId: () => h.ids.next('kf'),
			validate: (v) => validateValue(v, g.target.rule, h, label),
		});
	} catch (e) {
		if (e instanceof MultiEaseError) return e.message;
		throw e;
	}
	if (roved)
		h.warn(
			'W_EASE_ROVING_CLEARED',
			`${label}: keys in the eased span no longer rove (the span's end keys keep their times)`,
		);
	if (r.flat)
		h.warn(
			'W_EASE_FLAT_SEGMENT',
			`${label}: ${r.flat} piece(s) of the curve start and end at the same value, so they cannot hold a shaped ease; they are linear`,
		);
	if (r.clamped)
		h.warn('W_VALUE_CLAMPED', `${label}: values of the curve were clamped to the property's range`);
	warnOrientation(g, r.eases, h);
	changes.created.push(...r.created);
	changes.removed.push(...r.removed);
	g.kfs = r.keys;
	return null;
}

/** Applies a curve to every group (keyframe.applyEase, keyframe.pasteEase with a curve). */
function applyCurve(
	doc: DDoc,
	ids: readonly string[],
	curve: CubicEase | MultiEase,
	sections: readonly string[] | undefined,
	h: HandlerContext,
	what: string,
) {
	if (curve.kind === 'multi' && sections && !sections.includes('middle'))
		h.fail(
			'E_INVALID_PARAM',
			'A multi-point curve spans the keys from the first to the last selected one: include the "middle" section',
		);
	const groups = selectionGroups(doc, ids, h);
	const changes = new Changes();
	const skipped: string[] = [];
	let applied = 0;
	for (const g of groups) {
		changes.track(g);
		const reason = isSteppingGroup(g)
			? 'its values do not interpolate'
			: curve.kind === 'cubic'
				? applyCubic(g, curve, sections, h)
				: applyMulti(g, curve, h, changes);
		if (reason) {
			skipped.push(`${g.target.label} (${reason})`);
			continue;
		}
		changes.commit(g);
		applied++;
	}
	settle(applied, skipped, h, what);
	return changes.result();
}

/** Pastes one key's eases onto key i (both sides; neighbouring holds keep holding). */
function pasteKeyEase(g: EaseGroup, i: number, clip: { easeIn: Ease; easeOut: Ease }): boolean {
	const kfs = g.kfs;
	const runs = rovingRuns([...kfs]);
	if (runs.some((r) => i > r.a && i < r.b)) return false; // a roving key's eases are its run's
	const before = spanLeaving(kfs, i - 1, runs);
	const prev = before ? spanEases(kfs, before.a, before.b) : null;
	if (before && prev && !prev.hold) writeSpan(kfs, before.a, before.b, prev.out, clip.easeIn);
	else kfs[i]!.easeIn = { ...clip.easeIn };
	const after = spanLeaving(kfs, i, runs);
	if (after) {
		const next = spanEases(kfs, after.a, after.b);
		writeSpan(kfs, after.a, after.b, clip.easeOut, next.hold ? LINEAR_EASE : next.in);
	} else kfs[i]!.easeOut = { ...clip.easeOut };
	return true;
}

export const easeHandlers = {
	'keyframe.applyEase': (doc, cmd: CommandOf<'keyframe.applyEase'>, h: HandlerContext) =>
		applyCurve(doc, cmd.keyframeIds, cmd.curve as CubicEase | MultiEase, cmd.sections, h, 'ease'),

	'keyframe.pasteEase': (doc, cmd: CommandOf<'keyframe.pasteEase'>, h: HandlerContext) => {
		const clip = cmd.clip;
		if (clip.kind === 'segments' && clip.curve && cmd.mode !== 'segments')
			return applyCurve(
				doc,
				cmd.keyframeIds,
				clip.curve as MultiEase,
				cmd.sections,
				h,
				'paste the ease onto',
			);
		if (cmd.mode === 'curve')
			h.fail(
				'E_INVALID_PARAM',
				'The copied ease has no multi-point curve (copy three or more keyframes of one property for one)',
			);
		const groups = selectionGroups(doc, cmd.keyframeIds, h);
		const changes = new Changes();
		const skipped: string[] = [];
		let applied = 0;
		if (clip.kind === 'key') {
			for (const g of groups) {
				changes.track(g);
				if (isSteppingGroup(g)) {
					skipped.push(`${g.target.label} (its values do not interpolate)`);
					continue;
				}
				let n = 0;
				for (const i of g.selected) if (pasteKeyEase(g, i, clip)) n++;
				if (!n) {
					skipped.push(`${g.target.label} (roving keys take their run's ease)`);
					continue;
				}
				changes.commit(g);
				applied++;
			}
			settle(applied, skipped, h, 'paste the ease onto');
			return changes.result();
		}
		const targets: { g: EaseGroup; a: number; b: number }[] = [];
		for (const g of groups) {
			changes.track(g);
			if (isSteppingGroup(g)) {
				skipped.push(`${g.target.label} (its values do not interpolate)`);
				continue;
			}
			for (const sp of sectionSpans(g, cmd.sections)) targets.push({ g, a: sp.a, b: sp.b });
		}
		const n = clip.segments.length;
		if (!targets.length) settle(0, skipped, h, 'paste the ease onto');
		const count = n === 1 ? targets.length : Math.min(n, targets.length);
		if (n !== 1 && n !== targets.length)
			h.warn(
				'W_EASE_COUNT_MISMATCH',
				`${n} copied segment eases onto ${targets.length} segments: the first ${count} were pasted`,
			);
		const touched = new Set<EaseGroup>();
		for (let k = 0; k < count; k++) {
			const t = targets[k]!;
			const e = cubicToEases(clip.segments[n === 1 ? 0 : k]!);
			writeSpan(t.g.kfs, t.a, t.b, e.easeOut, e.easeIn);
			warnOrientation(t.g, [{ out: e.easeOut, in: e.easeIn }], h);
			touched.add(t.g);
		}
		for (const g of touched) changes.commit(g);
		settle(touched.size, skipped, h, 'paste the ease onto');
		return changes.result();
	},

	'keyframe.pasteValues': (doc, cmd: CommandOf<'keyframe.pasteValues'>, h: HandlerContext) => {
		const groups = selectionGroups(doc, cmd.keyframeIds, h);
		const targets = groups.flatMap((g) => g.selected.map((i) => ({ g, i })));
		const n = Math.min(cmd.values.length, targets.length);
		if (cmd.values.length !== targets.length)
			h.warn(
				'W_EASE_COUNT_MISMATCH',
				`${cmd.values.length} copied values onto ${targets.length} keyframes: the first ${n} were pasted`,
			);
		const changes = new Changes();
		for (const g of groups) changes.track(g);
		const touched = new Set<EaseGroup>();
		for (let k = 0; k < n; k++) {
			const { g, i } = targets[k]!;
			const v = validateValue(cmd.values[k], g.target.rule, h, g.target.label);
			if (v.clamped) h.warn('W_VALUE_CLAMPED', `${g.target.label} clamped to ${JSON.stringify(v.value)}`);
			g.kfs[i]!.value = v.value;
			touched.add(g);
		}
		for (const g of touched) changes.commit(g);
		return { ...changes.result(), pasted: n };
	},

	'keyframe.setVelocity': (doc, cmd: CommandOf<'keyframe.setVelocity'>, h: HandlerContext) => {
		if (cmd.speed === undefined && cmd.influence === undefined)
			h.fail('E_INVALID_PARAM', 'Give a speed, an influence or both');
		const [g] = selectionGroups(doc, [cmd.keyframeId], h);
		const label = g!.target.label;
		if (isSteppingGroup(g!)) h.fail('E_INVALID_PARAM', `${label} holds its values: it has no speed`);
		const kfs = g!.kfs;
		const i = g!.selected[0]!;
		const runs = rovingRuns([...kfs]);
		if (runs.some((r) => i > r.a && i < r.b))
			h.fail(
				'E_INVALID_PARAM',
				'The keyframe roves across time: its speed follows its run (turn Rove Across Time off first)',
			);
		const sides = cmd.side === 'both' ? (['in', 'out'] as const) : [cmd.side];
		let applied = 0;
		for (const side of sides) {
			const sp = spanLeaving(kfs, side === 'in' ? i - 1 : i, runs);
			const why = !sp
				? `there is no keyframe ${side === 'in' ? 'before' : 'after'} it`
				: spanEases(kfs, sp.a, sp.b).hold
					? `the segment ${side === 'in' ? 'before' : 'after'} it holds`
					: null;
			if (why || !sp) {
				if (cmd.side !== 'both') h.fail('E_INVALID_PARAM', `No ${side} speed: ${why}`);
				continue;
			}
			const e = spanEases(kfs, sp.a, sp.b) as { hold: false; out: Ease; in: Ease };
			const cur = side === 'in' ? e.in : e.out;
			const avg = spanAverageVelocity(kfs, sp.a, sp.b);
			let slope = cur.slope;
			if (cmd.speed !== undefined) {
				if (avg === 0 && cmd.speed !== 0)
					h.fail(
						'E_INVALID_PARAM',
						`The segment ${side === 'in' ? 'before' : 'after'} the keyframe does not change the value (both keys are equal), so it cannot move at a speed: speeds are relative to the segment's change`,
					);
				slope = avg === 0 ? 0 : cmd.speed / avg;
			}
			const next: Ease = {
				influence: cmd.influence !== undefined ? cmd.influence / 100 : cur.influence,
				slope,
			};
			if (side === 'in') writeSpan(kfs, sp.a, sp.b, e.out, next);
			else writeSpan(kfs, sp.a, sp.b, next, e.in);
			applied++;
		}
		if (!applied) h.fail('E_INVALID_PARAM', 'The keyframe has no segment to set a speed on');
		const changes = new Changes();
		changes.commit(g!);
		const after = clone(g!.loc.anim.keyframes) as Keys;
		const key = describeEaseGroup({
			...g!,
			kfs: after,
			selected: [after.findIndex((k) => k.id === cmd.keyframeId)],
		}).keys[0]!;
		return { keyframeId: cmd.keyframeId, easeIn: key.easeIn, easeOut: key.easeOut };
	},

	'keyframe.createPathController': (
		doc,
		cmd: CommandOf<'keyframe.createPathController'>,
		h: HandlerContext,
	) => {
		const groups = selectionGroups(doc, cmd.keyframeIds, h);
		if (groups.length !== 1)
			h.fail('E_INVALID_PARAM', 'Select keyframes of one point property (a position with a motion path)');
		const g = groups[0]!;
		const label = g.target.label;
		if (!isPointGroup(g) || isSteppingGroup(g))
			h.fail('E_INVALID_PARAM', `${label} is not a point property with a motion path`);
		const clip = g.loc.clip;
		if (!clip)
			h.fail(
				'E_INVALID_PARAM',
				`${label} does not belong to a clip: the controller is an effect on the clip`,
			);
		if (g.selected.length < 2) h.fail('E_INVALID_PARAM', 'Select two or more keyframes of the property');
		const anim = g.loc.anim as Draft<Animatable<unknown>>;
		if (anim.expression && anim.expression.text.trim() !== '' && cmd.replaceExpression !== true)
			h.fail(
				'E_INVALID_PARAM',
				`${label} already has an expression; pass replaceExpression: true to replace it`,
			);
		const changes = new Changes();
		changes.track(g);
		const kfs = g.kfs;
		const a = g.selected[0]!;
		const b = g.selected[g.selected.length - 1]!;
		const A = kfs[a]!;
		const B = kfs[b]!;
		// Constant speed along the path between A and B: the keys between rove, the run is linear.
		if (A.roving || B.roving) clearRoving(kfs, a, b);
		const rovingIds: string[] = [];
		for (let i = a + 1; i < b; i++) {
			kfs[i]!.interpolation = 'linear';
			kfs[i]!.roving = true;
			rovingIds.push(kfs[i]!.id);
		}
		writeSpan(kfs, a, b, LINEAR_EASE, LINEAR_EASE, captureEases(kfs, a, b));
		changes.commit(g);
		// The Slider Control, keyed 0 → 100 with Easy Ease over the same span.
		const added = (effectHandlers['effect.add'] as (d: DDoc, c: unknown, hh: HandlerContext) => unknown)(
			doc,
			{ type: 'effect.add', target: { clipId: clip.id }, effectId: SLIDER_CONTROL_ID },
			h,
		) as { effectInstanceId: string };
		const effects = (clip as { effects?: Draft<EffectInstance>[] }).effects ?? [];
		const fx = effects.find((e) => e.id === added.effectInstanceId)!;
		const names = new Set(
			effects
				.filter((e) => e !== fx)
				.map((e) => e.name ?? h.registries.effects.get(e.effectId, e.effectVersion)?.label ?? e.effectId),
		);
		let name = 'Path Progress';
		for (let n = 2; names.has(name); n++) name = `Path Progress ${n}`;
		fx.name = name;
		const slider = fx.params.slider as Draft<Animatable<unknown>>;
		const sliderKeys: Keys = [
			{
				id: h.ids.next('kf'),
				time: A.time,
				value: 0,
				interpolation: 'bezier',
				easeIn: { ...EASY_EASE },
				easeOut: { ...EASY_EASE },
			},
			{
				id: h.ids.next('kf'),
				time: B.time,
				value: 100,
				interpolation: 'bezier',
				easeIn: { ...EASY_EASE },
				easeOut: { ...EASY_EASE },
			},
		];
		slider.keyframes = sliderKeys as never;
		finish([slider]);
		// Key numbers (1-based) of the span ends in the property's final key list.
		const finalKeys = anim.keyframes;
		const ka = finalKeys.findIndex((k) => k.id === A.id) + 1;
		const kb = finalKeys.findIndex((k) => k.id === B.id) + 1;
		const text = [
			`// Path Progress: ${label} follows its motion path at the progress (0 … 100) of "${name}".`,
			`var p = effect(${JSON.stringify(name)})("Slider");`,
			`var tA = key(${ka}).time, tB = key(${kb}).time;`,
			'var lo = Math.min(tA, tB), hi = Math.max(tA, tB);',
			'(time < lo || time > hi) ? value : valueAtTime(linear(p, 0, 100, tA, tB))',
		].join('\n');
		anim.expression = { text, enabled: true };
		changes.created.push(...sliderKeys.map((k) => k.id));
		return {
			...changes.result(),
			effectInstanceId: fx.id,
			effectName: name,
			sliderKeyframeIds: sliderKeys.map((k) => k.id),
			rovingKeyframeIds: rovingIds,
			expression: text,
		};
	},

	'keyframes.cleanupPath': (doc, cmd: CommandOf<'keyframes.cleanupPath'>, h: HandlerContext) => {
		const tolerance = cmd.tolerance ?? DEFAULT_CLEANUP_TOLERANCE;
		const groups = selectionGroups(doc, cmd.keyframeIds, h);
		const changes = new Changes();
		const skipped: string[] = [];
		const properties: {
			path: string[];
			label: string;
			before: number;
			after: number;
			removed: string[];
			maxError: number;
		}[] = [];
		for (const g of groups) {
			changes.track(g);
			const label = g.target.label;
			if (!isPointGroup(g) || isSteppingGroup(g)) {
				skipped.push(`${label} (not a point property with a motion path)`);
				continue;
			}
			if (g.selected.length < 2) {
				skipped.push(`${label} (select two or more keyframes)`);
				continue;
			}
			const kfs = g.kfs;
			const a = g.selected[0]!;
			const b = g.selected[g.selected.length - 1]!;
			if (clearRoving(kfs, a, b))
				h.warn('W_EASE_ROVING_CLEARED', `${label}: keys in the cleaned span no longer rove`);
			const plan = planPathCleanup(kfs, a, b, tolerance);
			const captured = captureEases(kfs, a, b);
			const aTan = effectiveTangents(kfs, a);
			const bTan = effectiveTangents(kfs, b);
			const prevEases = a > 0 && !['linear', 'hold'].includes(kfs[a - 1]!.interpolation);
			const keptSet = new Set(plan.kept);
			const removed = kfs.slice(a, b + 1).filter((_, j) => !keptSet.has(a + j));
			const keys: Keys = [];
			kfs.forEach((k, i) => {
				if (i < a || i > b) {
					keys.push(k);
					return;
				}
				if (!keptSet.has(i)) return;
				const t = plan.tangents.get(i)!;
				k.spatial =
					i === a
						? spatialFor(aTan.inTangent, t.out)
						: i === b
							? spatialFor(t.in, bTan.outTangent)
							: spatialFor(t.in, t.out);
				if (i === b) {
					// B's own segment (after the span) is kept: an Auto Bezier B freezes its current eases.
					if (k.interpolation === 'auto-bezier') {
						k.interpolation = 'bezier';
						if (captured.bOut) k.easeOut = { ...captured.bOut };
						k.easeIn = { ...LINEAR_EASE };
					}
				} else if (i === a && prevEases) {
					// The segment arriving at A keeps its ease: A stays Bezier with a linear out ease.
					k.interpolation = 'bezier';
					if (captured.aIn) k.easeIn = { ...captured.aIn };
					k.easeOut = { ...LINEAR_EASE };
				} else {
					k.interpolation = 'linear';
					k.easeIn = { ...LINEAR_EASE };
					k.easeOut = { ...LINEAR_EASE };
				}
				keys.push(k);
			});
			changes.removed.push(...removed.map((k) => k.id));
			changes.commit(g, keys);
			properties.push({
				path: [...g.loc.path],
				label,
				before: b - a + 1,
				after: plan.kept.length,
				removed: removed.map((k) => k.id),
				maxError: plan.maxError,
			});
		}
		settle(properties.length, skipped, h, 'clean up');
		return { ...changes.result(), tolerance, properties };
	},
} satisfies HandlerMap;
