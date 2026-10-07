// High-level expression API for the editor, the engine and agents.
import {
	type ExpressionRef,
	type ExpressionWorldData,
	expressionBindingOf,
	flicksPerFrame,
	installExpressionSupport,
	locateExpressionTarget,
	type ProjectDocument,
	type Rational,
	type TextSelectorExpressionHost,
} from '@jasper/project';
import { bindDocumentExpressions, bindWorld, worldOfDocument } from './bind.ts';
import {
	checkExpressionSyntax,
	isExpressionEngineLoaded,
	loadExpressionEngine as loadRuntime,
} from './runtime.ts';
import type { PropKind } from './values.ts';
import type { SelectorInput, World } from './world.ts';

/**
 * Loads the QuickJS engine and installs expression support into @jasper/project (`bindExpressions`, used by
 * `buildRenderSnapshot` and the agent queries). Idempotent; await it before rendering or exporting.
 */
export async function loadExpressionEngine(): Promise<void> {
	await loadRuntime();
	installExpressionSupport({
		bind: bindDocumentExpressions,
		status: (doc, ref, t) => {
			const st = propertyStatusAt(doc, ref, t);
			return st ? { value: st.value, error: st.expressionError } : null;
		},
	});
}

export type PropertyStatus = {
	/** What renders (post-expression; the keyframed value when the expression fails or is disabled). */
	value: unknown;
	/** The keyframed (pre-expression) value. */
	keyframedValue: unknown;
	/** The stored expression, if any. */
	expression: { text: string; enabled: boolean } | null;
	/** Error of the expression at this time (`null` = it ran, or there is none / it is disabled). */
	expressionError: string | null;
	kind: PropKind;
	name: string;
};

/** Content (stored) time of a sequence frame for a property's owner. */
export function storedTimeAtFrame(doc: ProjectDocument, ref: ExpressionRef, frame: number): number {
	const world = worldOfDocument(doc);
	const p = world.prop(ref);
	const seq = doc.sequences[ref.seq];
	if (!p || !seq) return 0;
	const F = flicksPerFrame(seq.settings.frameRate as Rational);
	return p.time.toStored((frame * F) / 705_600_000);
}

/** Value, keyframed value and expression error of a property at stored time `t`. */
export function propertyStatusAt(doc: ProjectDocument, ref: ExpressionRef, t: number): PropertyStatus | null {
	const world = worldOfDocument(doc);
	const p = world.prop(ref);
	if (!p) return null;
	const keyframedValue = world.pre(p, t);
	const st = world.evaluate(ref, t);
	return {
		value: st.value,
		keyframedValue,
		expression: p.expression ? { text: p.expression.text, enabled: p.expression.enabled } : null,
		expressionError: st.error,
		kind: p.kind,
		name: p.name,
	};
}

/**
 * Evaluates `text` as the expression of the property at `ref` without storing it (the editor's live preview, the
 * MCP `test_expression` tool). Syntax errors come back without running.
 */
export function evaluateExpressionText(
	doc: ProjectDocument,
	ref: ExpressionRef,
	text: string,
	t: number,
): { value: unknown; error: string | null } {
	const syntax = checkExpressionSyntax(text);
	if (syntax) {
		const world = worldOfDocument(doc);
		const p = world.prop(ref);
		return { value: p ? world.pre(p, t) : undefined, error: syntax };
	}
	return worldOfDocument(doc).evaluateText(ref, text, t);
}

/** Status of a bound Animatable (Effect Controls rows evaluate the anim they render). */
export function boundStatus(anim: unknown, t: number): { value: unknown; error: string | null } | null {
	const b = expressionBindingOf(anim);
	return b ? b.evaluateWithStatus(t) : null;
}

// ---------------------------------------------------------------- text Expression Selector

export type SelectorAmount = { ok: true; amount: [number, number, number] } | { ok: false; error: string };

/**
 * The text animators' Expression Selector (AE): evaluates `text` for one character/word/line of a text clip.
 * `textIndex` (1-based) and `textTotal` count the selector's units, `selectorValue` is the amount of the selectors
 * above it (percent, three components). The result (a number, an array of up to three numbers or a boolean) is
 * the unit's amount in percent; a number applies to all three components. `time`, `value`, `thisLayer`, `wiggle`,
 * `random` (seeded per selector and unit), … work as in any expression. `contentTime` = the clip's content time
 * (flicks); `selectorId` seeds the randomness (e.g. the animator id).
 */
export function evaluateSelectorExpression(
	doc: ProjectDocument,
	at: { sequenceId: string; clipId: string; selectorId: string },
	text: string,
	contentTime: number,
	input: Omit<SelectorInput, 'seedKey'>,
): SelectorAmount {
	const syntax = checkExpressionSyntax(text);
	if (syntax) return { ok: false, error: syntax };
	return selectorAmount(worldOfDocument(doc), at, text, contentTime, input);
}

function selectorAmount(
	world: World,
	at: { sequenceId: string; clipId: string; selectorId: string },
	text: string,
	contentTime: number,
	input: Omit<SelectorInput, 'seedKey'>,
): SelectorAmount {
	const ref = { seq: at.sequenceId, owner: at.clipId, path: 'text.content' };
	if (!world.prop(ref)) return { ok: false, error: 'Error: the Expression Selector needs a text clip' };
	const r = world.evaluateText(ref, text, contentTime, { ...input, seedKey: `selector:${at.selectorId}` });
	if (r.error) return { ok: false, error: r.error };
	const num = (x: unknown): number | null =>
		typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'boolean' ? (x ? 100 : 0) : null;
	const v = r.value;
	let out: (number | null)[];
	if (Array.isArray(v)) {
		const first = num(v[0]);
		out = [first, v.length > 1 ? num(v[1]) : first, v.length > 2 ? num(v[2]) : first];
	} else {
		const x = num(v);
		out = [x, x, x];
	}
	if (out.some((x) => x === null))
		return { ok: false, error: 'Error: expression selector amount must be a number or an array of numbers' };
	return { ok: true, amount: out as [number, number, number] };
}

/**
 * The Expression Selector host of a text clip for the renderer (`AnimatorEvalContext.expressions`): evaluates
 * selector expressions in the world of a render snapshot (`snapshot.expressions`, so it works after JSON, in the
 * Remotion renderer) or of a document. Null when the engine is not loaded or the clip is not in the world. Failing
 * expressions return null (the selector falls back to its static Amount) and report the error once per text.
 */
export function textSelectorExpressionHost(
	data: ExpressionWorldData | ProjectDocument,
	clipId: string,
): TextSelectorExpressionHost | null {
	if (!isExpressionEngineLoaded()) return null;
	const world =
		'version' in data && 'boxes' in data
			? bindWorld(data as ExpressionWorldData).world
			: worldOfDocument(data as ProjectDocument);
	const sequences =
		'version' in data && 'boxes' in data
			? (data as ExpressionWorldData).sequences
			: (data as ProjectDocument).sequences;
	const sequenceId = Object.keys(sequences).find((id) => sequences[id]!.clips[clipId]);
	if (!sequenceId) return null;
	const reported = new Set<string>();
	return (q) => {
		const r = selectorAmount(world, { sequenceId, clipId, selectorId: q.selectorId }, q.text, q.time, {
			textIndex: q.textIndex,
			textTotal: q.textTotal,
			selectorValue: q.selectorValue,
		});
		if (r.ok) return r.amount;
		if (!reported.has(q.text)) {
			reported.add(q.text);
			console.warn(`[expressions] text selector ${q.selectorId}: ${r.error}`);
		}
		return null;
	};
}

// ---------------------------------------------------------------- pick-whip

const quote = (s: string) => JSON.stringify(s);

/**
 * The expression text that reads property `to` from the expression of property `from` (AE's pick-whip): the
 * shortest AE form (`transform.position`, `effect("Slider Control")("Slider")`, `thisComp.layer("Title")…`,
 * `comp("Other")…`). Null when `to` cannot be referenced.
 */
export function pickWhipExpression(
	doc: ProjectDocument,
	from: ExpressionRef,
	to: ExpressionRef,
): string | null {
	const world = worldOfDocument(doc);
	const target = world.prop(to);
	if (!target) return null;
	const info = world.owner(to.seq, to.owner);
	if (!info) return null;
	let layer = '';
	if (to.owner !== from.owner || to.seq !== from.seq) {
		if (info.kind !== 'clip') return null;
		const comp =
			to.seq === from.seq ? 'thisComp' : `comp(${quote(doc.items ? nameOfSequence(doc, to.seq) : to.seq)})`;
		const clip = info.clip;
		const sameName = world.layers(to.seq).filter((id) => info.seq.clips[id]?.name === clip.name);
		const key =
			sameName.length === 1 && sameName[0] === clip.id
				? quote(clip.name)
				: String(world.layers(to.seq).indexOf(clip.id) + 1);
		layer = `${comp}.layer(${key}).`;
	} else if (info.kind !== 'clip' && info.kind !== 'track' && info.kind !== 'master') return null;
	if (to.owner === from.owner && to.seq === from.seq && to.path === from.path) return 'value';
	const path = to.path;
	if (path.startsWith('effects.')) {
		const [, fxId, ...rest] = path.split('.');
		const fxNode = world.children(info, 'effects').find((n) => n.path === `effects.${fxId}`);
		if (!fxNode) return null;
		const effectCall = layer ? `${layer}effect(${quote(fxNode.name)})` : `effect(${quote(fxNode.name)})`;
		return `${effectCall}(${quote(target.name || rest.join('.'))})`;
	}
	if (path.startsWith('masks.')) {
		const [, maskId, prop] = path.split('.');
		const node = world.children(info, 'masks').find((n) => n.path === `masks.${maskId}`);
		if (!node) return null;
		const attr = { feather: 'maskFeather', opacity: 'maskOpacity', expansion: 'maskExpansion' }[
			prop as 'feather'
		];
		return attr ? `${layer}mask(${quote(node.name)}).${attr}` : null;
	}
	const short: Record<string, string> = {
		'transform.position': 'transform.position',
		'transform.anchor': 'transform.anchorPoint',
		'transform.scale': 'transform.scale',
		'transform.scaleWidth': 'transform.scaleWidth',
		'transform.rotation': 'transform.rotation',
		opacity: 'transform.opacity',
		'shape.size': 'shape.size',
		'shape.fill': 'shape.fillColor',
		'shape.stroke.color': 'shape.strokeColor',
		'shape.stroke.width': 'shape.strokeWidth',
		'shape.cornerRadius': 'shape.cornerRadius',
		volumeDb: 'audio.audioLevels',
		pan: 'audio.pan',
		'text.content': 'text.sourceText',
	};
	const s =
		short[path] ??
		(path.startsWith('params.') ? `${layer ? '' : 'thisLayer.'}params(${quote(path.slice(7))})` : null);
	if (!s) return null;
	if (!layer && (info.kind === 'track' || info.kind === 'master')) return null;
	return layer ? `${layer}${s}` : s;
}

function nameOfSequence(doc: ProjectDocument, seqId: string): string {
	for (const it of Object.values(doc.items))
		if (it.kind === 'sequence' && it.sequenceId === seqId) return it.name;
	return seqId;
}

/** True when `ref` addresses a property that can hold an expression in `doc`. */
export function canHaveExpression(doc: ProjectDocument, ref: ExpressionRef): boolean {
	const loc = locateExpressionTarget(doc, ref);
	if (loc) return true;
	const p = worldOfDocument(doc).prop(ref);
	return !!p && p.kind !== 'other' && !ref.path.startsWith('params.');
}
