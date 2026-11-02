// Binding: attaching expression evaluators to the Animatables of a document or a render snapshot, so the shared
// `evaluate()` (and `sourceTextAt()`) of @jasper/project return post-expression values everywhere (preview,
// overlays, native sampling, graphs, agents). Bound objects are fresh copies (copy-on-write along their path):
// documents are immutable and frozen, and an Animatable shared by two document versions must not carry either
// version's evaluator.
import {
	type AnimLocation,
	type Appearance,
	appearanceSlots,
	buildExpressionWorldData,
	documentHasActiveExpressions,
	type EffectInstance,
	type EvaluateOptions,
	EXPRESSION_BINDING,
	type ExpressionBinding,
	type ExpressionRef,
	type ExpressionWorldData,
	expressionBindingOf,
	hasActiveExpression,
	type Mask,
	mapShapeItemAnimatables,
	type ProjectDocument,
	PUPPET_PIN_PROPS,
	type RenderSnapshot,
	type Sequence,
	sequenceAnimatables,
} from '@jasper/project';
import { isExpressionEngineLoaded } from './runtime.ts';
import { World } from './world.ts';

type Bound = { world: World; sequences: Record<string, Sequence> };

function binding(world: World, ref: ExpressionRef): ExpressionBinding {
	return {
		evaluate: (t: number, opts?: EvaluateOptions) => world.evaluate(ref, t, opts).value,
		evaluateWithStatus: (t: number, opts?: EvaluateOptions) => world.evaluate(ref, t, opts),
	};
}

function withBinding<T extends object>(target: T, b: ExpressionBinding): T {
	const copy = Array.isArray(target) ? ([...target] as T) : ({ ...target } as T);
	Object.defineProperty(copy, EXPRESSION_BINDING, { value: b, enumerable: false, configurable: true });
	return copy;
}

/** Copy-on-write `root` with `value` at `path`. */
function setIn<T>(root: T, path: readonly (string | number)[], value: unknown): T {
	if (path.length === 0) return value as T;
	const [k, ...rest] = path;
	const cur = root as Record<string | number, unknown>;
	const next = setIn(cur[k!], rest, value);
	if (Array.isArray(root)) {
		const copy = [...root];
		copy[k as number] = next;
		return copy as T;
	}
	return { ...(root as object), [k!]: next } as T;
}

const worldCache = new WeakMap<ExpressionWorldData, Bound>();

/** Binds every active expression of the world's sequences (memoized per world data object). */
export function bindWorld(data: ExpressionWorldData): Bound {
	const hit = worldCache.get(data);
	if (hit) return hit;
	const world = new World(data);
	const sequences: Record<string, Sequence> = {};
	for (const [seqId, seq] of Object.entries(data.sequences)) {
		let s = seq;
		for (const loc of sequenceAnimatables(seqId, seq)) {
			// Expression Selector amounts run per character.
			if (loc.kind === 'selector') continue;
			if (!hasActiveExpression(loc.target as { expression?: { text: string; enabled: boolean } })) continue;
			s = setIn(s, loc.at, withBinding(loc.target as object, binding(world, loc.ref)));
		}
		sequences[seqId] = s;
	}
	world.bound = sequences;
	const out = { world, sequences };
	worldCache.set(data, out);
	return out;
}

const docCache = new WeakMap<ProjectDocument, ProjectDocument>();
const docWorld = new WeakMap<ProjectDocument, World>();

/**
 * The document with its active expressions bound (identity when it has none or the engine is not loaded yet).
 * Memoized per document object.
 */
export function bindDocumentExpressions(doc: ProjectDocument): ProjectDocument {
	if (!isExpressionEngineLoaded() || !documentHasActiveExpressions(doc)) return doc;
	const hit = docCache.get(doc);
	if (hit) return hit;
	const { world, sequences } = bindWorld(buildExpressionWorldData(doc));
	const out: ProjectDocument = { ...doc, sequences };
	docCache.set(doc, out);
	docCache.set(out, out);
	docWorld.set(doc, world);
	docWorld.set(out, world);
	return out;
}

/** The evaluation world of a document (bound or raw). */
export function worldOfDocument(doc: ProjectDocument): World {
	const w = docWorld.get(doc);
	if (w) return w;
	if (isExpressionEngineLoaded() && documentHasActiveExpressions(doc)) {
		bindDocumentExpressions(doc);
		const bound = docWorld.get(doc);
		if (bound) return bound;
	}
	// No active expressions: a world still answers property reads (adhoc evaluations, the pick-whip).
	const { world } = bindWorld(buildExpressionWorldData(doc));
	docWorld.set(doc, world);
	return world;
}

const snapCache = new WeakMap<RenderSnapshot, RenderSnapshot>();

function boundAt(
	seq: Sequence | undefined,
	path: readonly (string | number)[],
): ExpressionBinding | undefined {
	let cur: unknown = seq;
	for (const k of path) cur = (cur as Record<string | number, unknown> | null | undefined)?.[k];
	return expressionBindingOf(cur);
}

/**
 * Binds the expressions of a render snapshot (`snapshot.expressions` carries the world, so this works on a snapshot
 * that went through JSON, e.g. in the Remotion renderer). Animatables already bound (in-process snapshots built
 * from a bound document) are kept. Identity without expressions or before the engine is loaded.
 */
export function bindSnapshotExpressions(snap: RenderSnapshot): RenderSnapshot {
	const data = snap.expressions;
	if (!data || !isExpressionEngineLoaded()) return snap;
	const hit = snapCache.get(snap);
	if (hit) return hit;
	const { sequences } = bindWorld(data);
	const seq = sequences[snap.sequenceId];
	const locs = new Map<string, AnimLocation>();
	const textLocs = new Map<string, AnimLocation[]>();
	if (seq)
		for (const loc of sequenceAnimatables(snap.sequenceId, seq)) {
			locs.set(`${loc.ref.owner}|${loc.ref.path}`, loc);
			if (loc.kind === 'anim' && /^(textAnimators|textPath|textMore)\./.test(loc.ref.path))
				textLocs.set(loc.ref.owner, [...(textLocs.get(loc.ref.owner) ?? []), loc]);
		}
	const bind = <T>(anim: T, owner: string, path: string): T => {
		if (!anim || typeof anim !== 'object' || expressionBindingOf(anim)) return anim;
		if (!hasActiveExpression(anim as { expression?: { text: string; enabled: boolean } })) return anim;
		const loc = locs.get(`${owner}|${path}`);
		const b = loc ? boundAt(seq, loc.at) : undefined;
		return b ? (withBinding(anim as object, b) as T) : anim;
	};
	const bindMasks = (masks: Mask[] | undefined, owner: string): Mask[] | undefined => {
		if (!masks) return masks;
		let changed = false;
		const out = masks.map((m) => {
			let mm = m;
			for (const k of ['feather', 'opacity', 'expansion'] as const) {
				const a = m[k];
				const b = bind(a, owner, `masks.${m.id}.${k}`);
				if (b !== a) mm = { ...mm, [k]: b };
			}
			if (mm !== m) changed = true;
			return mm;
		});
		return changed ? out : masks;
	};
	const bindEffects = (fxs: EffectInstance[], owner: string): EffectInstance[] =>
		fxs.map((fx) => {
			let params = fx.params;
			for (const [k, a] of Object.entries(fx.params)) {
				const b = bind(a, owner, `effects.${fx.id}.${k}`);
				if (b !== a) params = { ...params, [k]: b };
			}
			const masks = bindMasks(fx.masks, owner);
			const pup = fx.puppet;
			let puppet = pup;
			if (pup) {
				const pins = pup.pins.map((pin) => {
					let pp = pin;
					for (const k of PUPPET_PIN_PROPS) {
						const b = bind(pin[k], owner, `puppet.${pin.id}.${k}`);
						if (b !== pin[k]) pp = { ...pp, [k]: b };
					}
					return pp;
				});
				if (pins.some((q, i) => q !== pup.pins[i])) puppet = { ...pup, pins };
			}
			// spec 19: what an appearance animates.
			let appearance = fx.appearance as Appearance | undefined;
			if (appearance)
				for (const s of appearanceSlots(fx.id, appearance)) {
					const b = bind(s.anim, owner, s.key);
					if (b !== s.anim) appearance = setIn(appearance, s.at.slice(1), b) as Appearance;
				}
			return params === fx.params &&
				masks === fx.masks &&
				puppet === pup &&
				appearance === (fx.appearance as Appearance | undefined)
				? fx
				: {
						...fx,
						params,
						...(masks ? { masks } : {}),
						...(puppet ? { puppet } : {}),
						...(appearance ? { appearance } : {}),
					};
		});
	const videoTracks = snap.videoTracks.map((track) => ({
		...track,
		clips: track.clips.map((c) => {
			const o = c.clipId;
			let out = c;
			// spec 19 TL-017: the sequence's light a look follows.
			if (c.sequenceLight) {
				const angle = bind(c.sequenceLight.angle, 'master', 'globalLight.angle');
				const altitude = bind(c.sequenceLight.altitude, 'master', 'globalLight.altitude');
				if (angle !== c.sequenceLight.angle || altitude !== c.sequenceLight.altitude)
					out = { ...out, sequenceLight: { ...c.sequenceLight, angle, altitude } };
			}
			if (c.transform) {
				let tr = c.transform;
				for (const k of ['position', 'anchor', 'scale', 'scaleWidth', 'rotation'] as const) {
					const b = bind(tr[k], o, `transform.${k}`);
					if (b !== tr[k]) tr = { ...tr, [k]: b };
				}
				// A bake's render-rect shift applies to the expression's result too.
				const shift = c.expressionPositionShift;
				const pb = shift ? expressionBindingOf(tr.position) : undefined;
				if (shift && pb) {
					const add = (v: unknown) =>
						Array.isArray(v) ? [Number(v[0]) + shift[0], Number(v[1]) + shift[1]] : v;
					tr = {
						...tr,
						position: withBinding(tr.position, {
							evaluate: (t, opts) => add(pb.evaluate(t, opts)),
							evaluateWithStatus: (t, opts) => {
								const r = pb.evaluateWithStatus(t, opts);
								return { value: add(r.value), error: r.error };
							},
						}),
					};
				}
				if (tr !== c.transform) out = { ...out, transform: tr };
			}
			const op = bind(c.opacity, o, 'opacity');
			if (op !== c.opacity) out = { ...out, opacity: op };
			const effects = bindEffects(c.effects, o);
			if (effects.some((e, i) => e !== c.effects[i])) out = { ...out, effects };
			const masks = bindMasks(c.masks, o);
			if (masks !== c.masks) out = { ...out, masks };
			const src = c.source;
			if ('shape' in src) {
				const sh = src.shape;
				if (sh.type === 'vector') {
					const contents = mapShapeItemAnimatables(sh.contents, (a, key) => bind(a, o, key));
					if (contents !== sh.contents) out = { ...out, source: { ...src, shape: { ...sh, contents } } };
				} else {
					let shape = sh;
					for (const k of ['size', 'fill', 'cornerRadius'] as const) {
						const b = bind(sh[k], o, `shape.${k}`);
						if (b !== sh[k]) shape = { ...shape, [k]: b };
					}
					const stroke = sh.stroke;
					if (stroke) {
						let st = stroke;
						for (const k of ['color', 'width'] as const) {
							const b = bind(stroke[k], o, `shape.stroke.${k}`);
							if (b !== stroke[k]) st = { ...st, [k]: b };
						}
						if (st !== stroke) shape = { ...shape, stroke: st };
					}
					if (shape !== sh) out = { ...out, source: { ...src, shape } };
				}
			}
			if ('text' in src) {
				const b = bind(src.text, o, 'text.content');
				let source = b === src.text ? src : { ...src, text: b };
				for (const loc of textLocs.get(o) ?? []) {
					const rel = loc.at.slice(2);
					let cur: unknown = source;
					for (const k of rel) cur = (cur as Record<string | number, unknown> | undefined)?.[k];
					const bb = bind(cur, o, loc.ref.path);
					if (bb !== cur) source = setIn(source, rel, bb);
				}
				if (source !== src) out = { ...out, source };
			}
			return out;
		}),
		...(track.transitions
			? {
					transitions: track.transitions.map((tr) => {
						let params = tr.params;
						for (const [k, a] of Object.entries(tr.params)) {
							const b = bind(a, `transition:${tr.id}`, k);
							if (b !== a) params = { ...params, [k]: b };
						}
						return params === tr.params ? tr : { ...tr, params };
					}),
				}
			: {}),
	}));
	const audioClips = snap.audioClips.map((a) => {
		let out = a;
		for (const k of ['volumeDb', 'pan'] as const) {
			const b = bind(a[k], a.clipId, k);
			if (b !== a[k]) out = { ...out, [k]: b };
		}
		const effects = bindEffects(a.effects, a.clipId);
		if (effects.some((e, i) => e !== a.effects[i])) out = { ...out, effects };
		let track = a.track;
		for (const k of ['volumeDb', 'pan'] as const) {
			const b = bind(track[k], `track:${a.trackId}`, k);
			if (b !== track[k]) track = { ...track, [k]: b };
		}
		if (track !== a.track) out = { ...out, track };
		return out;
	});
	const master = { ...snap.master, volumeDb: bind(snap.master.volumeDb, 'master', 'volumeDb') };
	const out: RenderSnapshot = { ...snap, videoTracks, audioClips, master };
	snapCache.set(snap, out);
	snapCache.set(out, out);
	return out;
}
