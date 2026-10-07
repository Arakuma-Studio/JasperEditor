// Expressions in the pure model (wave expressions, docs/wp-notes/expressions.md). The engine that evaluates them
// (QuickJS-wasm, the After Effects object model) lives in `@jasper/expressions`; this module only knows where
// expressions are stored, how they are addressed, and the injection hook that lets `buildRenderSnapshot` and the
// agent queries bind them without depending on the engine (ARCHITECTURE §3.1: project → zod, immer only).
//
// Storage: `Animatable.expression` on every animatable property (clip Motion/Opacity, effect params of clips,
// tracks and the master, shape geometry and paint, clip/track/master audio, transition params) and
// `TextContent.expression` for a text clip's Source Text.
//
// Addressing (`ExpressionRef`): `{seq, owner, path}` with `owner` = a clip id, `track:<id>`, `master` or
// `transition:<id>`, and `path` = the property-registry key (`transform.position`, `opacity`,
// `effects.<fxId>.<param>`, `shape.size`, `volumeDb`, `text.content`, …; transitions: the param name).

import { EXPRESSION_BINDING, type ExpressionBinding, hasActiveExpression } from './keyframes.ts';
import { intrinsicBoxOf } from './registry/properties.ts';
import type { Animatable, Expression } from './schema/common.ts';
import type { ProjectDocument } from './schema/document.ts';
import type { EffectInstance, Sequence, TextContent } from './schema/sequence.ts';
import type { ShapeItem } from './schema/shapes.ts';
import { shapeItemAnimatables } from './vector/properties.ts';
import type { TextAnimatorGroup } from './schema/text-animators.ts';

export type ExpressionRef = { seq: string; owner: string; path: string };

/** One stored animatable (or Source Text) of a sequence. `at` = property path from the sequence object. */
export type AnimLocation = {
	ref: ExpressionRef;
	at: (string | number)[];
	/**
	 * `text` = a TextContent (Source Text); `anim` = an Animatable; `selector` = a text Expression Selector's Amount
	 * (evaluated per character by the selector, not bound as a property).
	 */
	kind: 'anim' | 'text' | 'selector';
	target: Animatable<unknown> | TextContent;
};

const TRANSFORM_KEYS = ['position', 'anchor', 'scale', 'scaleWidth', 'rotation'] as const;

function* effectAnims(
	seq: string,
	owner: string,
	effects: readonly EffectInstance[] | undefined,
	at: (string | number)[],
): Generator<AnimLocation> {
	if (!effects) return;
	for (let i = 0; i < effects.length; i++) {
		const fx = effects[i]!;
		for (const [name, a] of Object.entries(fx.params ?? {}))
			yield {
				ref: { seq, owner, path: `effects.${fx.id}.${name}` },
				at: [...at, i, 'params', name],
				kind: 'anim',
				target: a as Animatable<unknown>,
			};
	}
}

type MaskLike = {
	id: string;
	feather?: Animatable<unknown>;
	opacity?: Animatable<unknown>;
	expansion?: Animatable<unknown>;
};

/** Expression-capable mask properties (the path is a Bezier shape: no expressions). */
export const MASK_EXPRESSION_PROPS = ['feather', 'opacity', 'expansion'] as const;

function* maskAnims(
	seq: string,
	owner: string,
	masks: readonly MaskLike[] | undefined,
	at: (string | number)[],
): Generator<AnimLocation> {
	if (!masks) return;
	for (let i = 0; i < masks.length; i++) {
		const m = masks[i]!;
		for (const k of MASK_EXPRESSION_PROPS) {
			const a = m[k];
			if (a)
				yield { ref: { seq, owner, path: `masks.${m.id}.${k}` }, at: [...at, i, k], kind: 'anim', target: a };
		}
	}
}

/** Every stored animatable property of a sequence (clips, tracks, master, transitions), in a stable order. */
export function* sequenceAnimatables(seqId: string, seq: Sequence): Generator<AnimLocation> {
	for (const [id, clip] of Object.entries(seq.clips)) {
		const c = clip as Record<string, unknown>;
		const at = ['clips', id];
		const tr = c.transform as Record<string, Animatable<unknown>> | undefined;
		if (tr)
			for (const k of TRANSFORM_KEYS)
				if (tr[k])
					yield {
						ref: { seq: seqId, owner: id, path: `transform.${k}` },
						at: [...at, 'transform', k],
						kind: 'anim',
						target: tr[k]!,
					};
		for (const k of ['opacity', 'volumeDb', 'pan'] as const) {
			const a = c[k] as Animatable<unknown> | undefined;
			if (a && typeof a === 'object' && Array.isArray(a.keyframes))
				yield { ref: { seq: seqId, owner: id, path: k }, at: [...at, k], kind: 'anim', target: a };
		}
		const shape = c.shape as Record<string, unknown> | undefined;
		// wp shapes: every number / point / colour property of a vector shape's items.
		if (shape?.type === 'vector' && Array.isArray(shape.contents))
			for (const x of shapeItemAnimatables(shape.contents as ShapeItem[]))
				yield {
					ref: { seq: seqId, owner: id, path: x.key },
					at: [...at, 'shape', 'contents', ...x.path],
					kind: 'anim',
					target: x.anim as Animatable<unknown>,
				};
		if (shape && shape.type !== 'vector') {
			for (const k of ['size', 'fill', 'cornerRadius'] as const) {
				const a = shape[k] as Animatable<unknown> | null | undefined;
				if (a)
					yield {
						ref: { seq: seqId, owner: id, path: `shape.${k}` },
						at: [...at, 'shape', k],
						kind: 'anim',
						target: a,
					};
			}
			const stroke = shape.stroke as Record<string, Animatable<unknown>> | null | undefined;
			if (stroke)
				for (const k of ['color', 'width'] as const)
					if (stroke[k])
						yield {
							ref: { seq: seqId, owner: id, path: `shape.stroke.${k}` },
							at: [...at, 'shape', 'stroke', k],
							kind: 'anim',
							target: stroke[k]!,
						};
		}
		if (clip.kind === 'text' && c.content)
			yield {
				ref: { seq: seqId, owner: id, path: 'text.content' },
				at: [...at, 'content'],
				kind: 'text',
				target: c.content as TextContent,
			};
		// text-animators: animator properties, selector fields, Path / More Options (keys of
		// registry/text-animator-properties.ts). Expression Selector amounts are `selector` locations: they run per
		// unit through the Expression Selector, never as a per-frame property binding.
		if (clip.kind === 'text') yield* textAnimatorAnims(seqId, id, c, at);
		yield* effectAnims(seqId, id, c.effects as EffectInstance[] | undefined, [...at, 'effects']);
		// wp masks: Mask Feather / Opacity / Expansion of the clip's masks and of its effects' masks.
		yield* maskAnims(seqId, id, c.masks as MaskLike[] | undefined, [...at, 'masks']);
		const fxs = (c.effects as (EffectInstance & { masks?: MaskLike[] })[] | undefined) ?? [];
		for (let i = 0; i < fxs.length; i++)
			yield* maskAnims(seqId, id, fxs[i]!.masks, [...at, 'effects', i, 'masks']);
	}
	for (const [list, name] of [
		[seq.videoTracks, 'videoTracks'],
		[seq.audioTracks, 'audioTracks'],
	] as const) {
		for (let i = 0; i < list.length; i++) {
			const t = list[i]!;
			const owner = `track:${t.id}`;
			for (const k of ['volumeDb', 'pan'] as const)
				if (t[k])
					yield { ref: { seq: seqId, owner, path: k }, at: [name, i, k], kind: 'anim', target: t[k]! };
			yield* effectAnims(seqId, owner, t.effects, [name, i, 'effects']);
		}
	}
	yield {
		ref: { seq: seqId, owner: 'master', path: 'volumeDb' },
		at: ['master', 'volumeDb'],
		kind: 'anim',
		target: seq.master.volumeDb,
	};
	yield* effectAnims(seqId, 'master', seq.master.effects, ['master', 'effects']);
	for (const [id, t] of Object.entries(seq.transitions))
		for (const [name, a] of Object.entries(t.params ?? {}))
			yield {
				ref: { seq: seqId, owner: `transition:${id}`, path: name },
				at: ['transitions', id, 'params', name],
				kind: 'anim',
				target: a as Animatable<unknown>,
			};
}

const isAnimObj = (v: unknown): v is Animatable<unknown> =>
	!!v &&
	typeof v === 'object' &&
	Array.isArray((v as Animatable<unknown>).keyframes) &&
	'value' in (v as object);

function* textAnimatorAnims(
	seq: string,
	owner: string,
	c: Record<string, unknown>,
	at: (string | number)[],
): Generator<AnimLocation> {
	const animators = Array.isArray(c.animators) ? (c.animators as TextAnimatorGroup[]) : [];
	for (let ai = 0; ai < animators.length; ai++) {
		const a = animators[ai]!;
		// Malformed animators (repairDocument drops them) are skipped.
		if (!a || typeof a !== 'object' || !a.properties || !Array.isArray(a.selectors)) continue;
		const base = `textAnimators.${a.id}`;
		for (const [key, v] of Object.entries(a.properties)) {
			if (key === 'axes') {
				for (const [tag, x] of Object.entries((v as Record<string, Animatable<unknown>>) ?? {}))
					if (isAnimObj(x))
						yield {
							ref: { seq, owner, path: `${base}.properties.axes.${tag}` },
							at: [...at, 'animators', ai, 'properties', 'axes', tag],
							kind: 'anim',
							target: x,
						};
				continue;
			}
			if (isAnimObj(v))
				yield {
					ref: { seq, owner, path: `${base}.properties.${key}` },
					at: [...at, 'animators', ai, 'properties', key],
					kind: 'anim',
					target: v,
				};
		}
		for (let si = 0; si < a.selectors.length; si++) {
			const sel = a.selectors[si]! as unknown as Record<string, unknown> & { id: string; kind: string };
			if (!sel || typeof sel !== 'object') continue;
			for (const [key, v] of Object.entries(sel))
				if (isAnimObj(v))
					yield {
						ref: { seq, owner, path: `${base}.selectors.${sel.id}.${key}` },
						at: [...at, 'animators', ai, 'selectors', si, key],
						kind: sel.kind === 'expression' && key === 'amount' ? 'selector' : 'anim',
						target: v,
					};
		}
	}
	for (const [group, prefix] of [
		['pathOptions', 'textPath'],
		['moreOptions', 'textMore'],
	] as const) {
		const g = c[group] as Record<string, unknown> | undefined;
		for (const [key, v] of Object.entries(g ?? {}))
			if (isAnimObj(v))
				yield {
					ref: { seq, owner, path: `${prefix}.${key}` },
					at: [...at, group, key],
					kind: 'anim',
					target: v,
				};
	}
}

/** The expression of a location (Animatable or Source Text), if any. */
export function expressionOf(loc: Pick<AnimLocation, 'target'>): Expression | undefined {
	return (loc.target as { expression?: Expression }).expression;
}

/** Every stored expression of a document (enabled or not). */
export function* documentExpressions(
	doc: Pick<ProjectDocument, 'sequences'>,
): Generator<AnimLocation & { expression: Expression }> {
	for (const [seqId, seq] of Object.entries(doc.sequences))
		for (const loc of sequenceAnimatables(seqId, seq)) {
			const expression = expressionOf(loc);
			if (expression) yield { ...loc, expression };
		}
}

const activeCache = new WeakMap<object, boolean>();

/** True when any sequence of the document has an active (enabled, non-empty) expression. Cached per sequences map. */
export function documentHasActiveExpressions(doc: Pick<ProjectDocument, 'sequences'>): boolean {
	const key = doc.sequences as object;
	const hit = activeCache.get(key);
	if (hit !== undefined) return hit;
	let found = false;
	outer: for (const [seqId, seq] of Object.entries(doc.sequences))
		for (const loc of sequenceAnimatables(seqId, seq))
			if (hasActiveExpression(loc.target as { expression?: Expression })) {
				found = true;
				break outer;
			}
	activeCache.set(key, found);
	return found;
}

// ---------------------------------------------------------------- ParamPath ↔ ExpressionRef

/** Command address (S01:CMD-010 ParamPath) of an expression location. */
export function expressionRefToParamPath(ref: ExpressionRef): string[] {
	if (ref.owner === 'master') return ['master', ref.seq, ref.path];
	if (ref.path.startsWith('masks.')) {
		const [, maskId, prop] = ref.path.split('.');
		return ['mask', maskId!, prop!];
	}
	if (ref.path.startsWith('effects.')) {
		const [, fxId, ...param] = ref.path.split('.');
		return ['effect', fxId!, param.join('.')];
	}
	if (ref.owner.startsWith('track:')) return ['track', ref.owner.slice(6), ref.path];
	if (ref.owner.startsWith('transition:')) return ['transition', ref.owner.slice(11), ref.path];
	return ['clip', ref.owner, ...ref.path.split('.')];
}

/** The location of a ParamPath in a document (null when it does not exist / is not expression-capable). */
export function paramPathToExpressionRef(
	doc: Pick<ProjectDocument, 'sequences'>,
	target: readonly string[],
	sequenceId?: string,
): ExpressionRef | null {
	const [head, a, ...rest] = target;
	if (!a) return null;
	if (head === 'clip') {
		for (const [seqId, seq] of Object.entries(doc.sequences))
			if (seq.clips[a]) return { seq: seqId, owner: a, path: rest.join('.') };
		return null;
	}
	if (head === 'effect') {
		const path = `effects.${a}.${rest.join('.')}`;
		for (const [seqId, seq] of Object.entries(doc.sequences)) {
			for (const [id, c] of Object.entries(seq.clips))
				if (((c as { effects?: EffectInstance[] }).effects ?? []).some((e) => e.id === a))
					return { seq: seqId, owner: id, path };
			for (const t of [...seq.videoTracks, ...seq.audioTracks])
				if ((t.effects ?? []).some((e) => e.id === a)) return { seq: seqId, owner: `track:${t.id}`, path };
			if (seq.master.effects.some((e) => e.id === a)) return { seq: seqId, owner: 'master', path };
		}
		return null;
	}
	if (head === 'transition') {
		for (const [seqId, seq] of Object.entries(doc.sequences))
			if (seq.transitions[a]) return { seq: seqId, owner: `transition:${a}`, path: rest.join('.') };
		return null;
	}
	if (head === 'mask') {
		const has = (ms: unknown) => Array.isArray(ms) && ms.some((m) => (m as { id?: string }).id === a);
		for (const [seqId, seq] of Object.entries(doc.sequences))
			for (const [id, c] of Object.entries(seq.clips)) {
				const cc = c as { masks?: unknown; effects?: { masks?: unknown }[] };
				if (has(cc.masks) || (cc.effects ?? []).some((fx) => has(fx.masks)))
					return { seq: seqId, owner: id, path: `masks.${a}.${rest.join('.')}` };
			}
		return null;
	}
	if (head === 'track') {
		for (const [seqId, seq] of Object.entries(doc.sequences)) {
			if (sequenceId && seqId !== sequenceId) continue;
			if ([...seq.videoTracks, ...seq.audioTracks].some((t) => t.id === a))
				return { seq: seqId, owner: `track:${a}`, path: rest.join('.') };
		}
		return null;
	}
	if (head === 'master') {
		const [seqId, key] = rest.length ? [a, rest[0]!] : [sequenceId, a];
		if (!seqId || !doc.sequences[seqId]) return null;
		return { seq: seqId, owner: 'master', path: key };
	}
	return null;
}

/** The stored animatable (or Source Text) at a ref, read from the raw document (null when absent). */
export function locateExpressionTarget(
	doc: Pick<ProjectDocument, 'sequences'>,
	ref: ExpressionRef,
): AnimLocation | null {
	const seq = doc.sequences[ref.seq];
	if (!seq) return null;
	for (const loc of sequenceAnimatables(ref.seq, seq))
		if (loc.ref.owner === ref.owner && loc.ref.path === ref.path) return loc;
	return null;
}

// ---------------------------------------------------------------- Source Text

/**
 * The text a text clip shows at content time `t`: its Source Text expression's result when the content is bound
 * (see `EXPRESSION_BINDING`), else the stored text.
 */
export function sourceTextAt(content: TextContent, t: number): string {
	const b = (content as { [EXPRESSION_BINDING]?: ExpressionBinding })[EXPRESSION_BINDING];
	if (b) {
		const v = b.evaluate(t);
		return typeof v === 'string' ? v : content.text;
	}
	return content.text;
}

// ---------------------------------------------------------------- engine injection

/**
 * Serializable data an expression evaluator needs besides the snapshot: every sequence (layers of other sequences
 * are reachable with `comp(name)`), sequence names and the layer boxes (`width`/`height`). Embedded in render
 * snapshots (`RenderSnapshot.expressions`) so the Remotion renderer can evaluate expressions with no document.
 */
export type ExpressionWorldData = {
	version: 1;
	sequences: Record<string, Sequence>;
	names: Record<string, string>;
	boxes: Record<string, { width: number; height: number }>;
	/** Colours of colour-matte synthetics by id (`sampleImage` on solid clips). */
	solids: Record<string, [number, number, number, number]>;
};

const worldCache = new WeakMap<object, ExpressionWorldData>();

/** World data of a document (memoized per document object). */
export function buildExpressionWorldData(
	doc: Pick<ProjectDocument, 'sequences' | 'items' | 'media' | 'synthetics'>,
): ExpressionWorldData {
	const hit = worldCache.get(doc);
	if (hit) return hit;
	const names: Record<string, string> = {};
	for (const it of Object.values(doc.items ?? {}))
		if (it.kind === 'sequence' && !(it.sequenceId in names)) names[it.sequenceId] = it.name;
	const boxes: Record<string, { width: number; height: number }> = {};
	for (const seq of Object.values(doc.sequences))
		for (const clip of Object.values(seq.clips)) {
			try {
				boxes[clip.id] = intrinsicBoxOf({ doc, seq, clip });
			} catch {
				boxes[clip.id] = { width: seq.settings.width, height: seq.settings.height };
			}
		}
	const solids: Record<string, [number, number, number, number]> = {};
	for (const [id, syn] of Object.entries(doc.synthetics ?? {})) {
		const sy = syn as { kind: string; color?: [number, number, number, number] };
		if (sy.kind === 'color-matte' && sy.color) solids[id] = [...sy.color];
		else if (sy.kind === 'transparent') solids[id] = [0, 0, 0, 0];
		else if (sy.kind === 'black-video') solids[id] = [0, 0, 0, 1];
	}
	const out: ExpressionWorldData = { version: 1, sequences: doc.sequences, names, boxes, solids };
	worldCache.set(doc, out);
	return out;
}

/** What `@jasper/expressions` installs (see `installExpressionSupport`). */
export type ExpressionSupport = {
	/** The document with its active expressions bound (memoized per document; identity without expressions). */
	bind(doc: ProjectDocument): ProjectDocument;
	/** Post-expression value and error of a property at stored time `t` (null: no such property). */
	status(
		doc: ProjectDocument,
		ref: ExpressionRef,
		t: number,
	): { value: unknown; error: string | null } | null;
};

let support: ExpressionSupport | null = null;

/**
 * Installed by `@jasper/expressions` once its engine is loaded. Until then (and in environments that never load it)
 * expressions are not evaluated and properties render their keyframed values.
 */
export function installExpressionSupport(s: ExpressionSupport | null): void {
	support = s;
}

export function expressionSupportInstalled(): boolean {
	return support !== null;
}

/** The document with expressions bound when the engine is installed and the document has active expressions. */
export function bindExpressions(doc: ProjectDocument): ProjectDocument {
	if (!support || !documentHasActiveExpressions(doc)) return doc;
	return support.bind(doc);
}

/** World data for a snapshot of `doc` (null without active expressions). */
export function expressionWorldData(doc: ProjectDocument): ExpressionWorldData | null {
	if (!documentHasActiveExpressions(doc)) return null;
	return buildExpressionWorldData(doc);
}

// ---------------------------------------------------------------- invariants and repair

const MAX_TEXT = 65_536;

/** Where expressions may live: clip properties (no audio effects), transition params, Source Text. */
function allowedTargets(
	seqId: string,
	seq: Sequence,
	audioEffect: (effectId: string) => boolean,
): Set<object> {
	const out = new Set<object>();
	for (const loc of sequenceAnimatables(seqId, seq)) {
		const o = loc.ref.owner;
		if (o === 'master' || o.startsWith('track:')) continue;
		if (loc.ref.path.startsWith('effects.') && !o.startsWith('transition:')) {
			const fxId = loc.ref.path.split('.')[1];
			const fx = ((seq.clips[o] as { effects?: EffectInstance[] } | undefined)?.effects ?? []).find(
				(e) => e.id === fxId,
			);
			if (!fx || audioEffect(fx.effectId)) continue;
		}
		out.add(loc.target as object);
	}
	return out;
}

/** Every object of a sequence carrying an `expression` field, with its path. */
function* expressionHolders(
	root: unknown,
	path: (string | number)[],
): Generator<{ holder: Record<string, unknown>; path: (string | number)[] }> {
	if (!root || typeof root !== 'object') return;
	if (Array.isArray(root)) {
		for (let i = 0; i < root.length; i++) yield* expressionHolders(root[i], [...path, i]);
		return;
	}
	const o = root as Record<string, unknown>;
	if ('expression' in o && o.expression !== undefined) yield { holder: o, path };
	for (const [k, v] of Object.entries(o)) if (k !== 'expression') yield* expressionHolders(v, [...path, k]);
}

function wellFormed(e: unknown): e is Expression {
	return (
		!!e &&
		typeof e === 'object' &&
		typeof (e as Expression).text === 'string' &&
		typeof (e as Expression).enabled === 'boolean' &&
		(e as Expression).text.length <= MAX_TEXT
	);
}

/**
 * INV-EXPR: an expression is `{text: string, enabled: boolean}` (text ≤ 64 Ki characters) and sits on a property that
 * takes expressions (clip properties except audio effect params and mask paths, transition params, Source Text).
 */
export function expressionIssues(
	doc: Pick<ProjectDocument, 'sequences'>,
	audioEffect: (effectId: string) => boolean,
): { message: string; path: string[] }[] {
	const out: { message: string; path: string[] }[] = [];
	for (const [seqId, seq] of Object.entries(doc.sequences)) {
		const allowed = allowedTargets(seqId, seq, audioEffect);
		for (const { holder, path } of expressionHolders(seq, ['sequences', seqId])) {
			const p = path.map(String);
			if (!wellFormed(holder.expression))
				out.push({ message: 'Malformed expression (expected {text, enabled})', path: p });
			else if (!allowed.has(holder))
				out.push({ message: 'This property does not take expressions', path: p });
		}
	}
	return out;
}

/** Drops malformed or misplaced expressions (mutates `doc`); returns what was removed. */
export function repairExpressions(
	doc: Pick<ProjectDocument, 'sequences'>,
	audioEffect: (effectId: string) => boolean,
): { entity: string; detail: string }[] {
	const out: { entity: string; detail: string }[] = [];
	for (const [seqId, seq] of Object.entries(doc.sequences)) {
		const allowed = allowedTargets(seqId, seq, audioEffect);
		for (const { holder, path } of [...expressionHolders(seq, [])]) {
			if (wellFormed(holder.expression) && allowed.has(holder)) continue;
			delete holder.expression;
			out.push({ entity: seqId, detail: `${path.join('.')}: unusable expression removed` });
		}
	}
	return out;
}

/**
 * Expression info of a property for agents (`clip.properties`, `param.get`): the stored expression and, when it
 * is active and the engine is installed, its value and error at stored time `t`. Null without an expression.
 */
export function expressionInfoAt(
	doc: ProjectDocument,
	target: readonly string[],
	sequenceId: string | undefined,
	t: number,
): { expression: Expression; value?: unknown; error?: string | null } | null {
	const ref = paramPathToExpressionRef(doc, target, sequenceId);
	if (!ref) return null;
	const loc = locateExpressionTarget(doc, ref);
	const expression = (loc?.target as { expression?: Expression } | undefined)?.expression;
	if (!expression) return null;
	const active = expression.enabled && expression.text.trim().length > 0;
	if (!active || !support) return { expression: { text: expression.text, enabled: expression.enabled } };
	const st = support.status(doc, ref, t);
	return st
		? { expression: { text: expression.text, enabled: expression.enabled }, value: st.value, error: st.error }
		: { expression: { text: expression.text, enabled: expression.enabled } };
}
