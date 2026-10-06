// Binding: attaching expression evaluators to the Animatables of a document or a render snapshot, so the shared
// `evaluate()` (and `sourceTextAt()`) of @jasper/project return post-expression values everywhere (preview,
// overlays, native sampling, graphs, agents). Bound objects are fresh copies (copy-on-write along their path):
// documents are immutable and frozen, and an Animatable shared by two document versions must not carry either
// version's evaluator.
import {
	type AnimLocation,
	buildExpressionWorldData,
	documentHasActiveExpressions,
	EXPRESSION_BINDING,
	type EvaluateOptions,
	type ExpressionBinding,
	type ExpressionRef,
	type ExpressionWorldData,
	expressionBindingOf,
	hasActiveExpression,
	type ProjectDocument,
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

// ---------------------------------------------------------------- snapshots

const snapCache = new WeakMap<RenderSnapshot, RenderSnapshot>();

function boundAt(seq: Sequence | undefined, path: readonly (string | number)[]): ExpressionBinding | undefined {
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
	const data = (snap as { expressions?: ExpressionWorldData | null }).expressions;
	if (!data || !isExpressionEngineLoaded()) return snap;
	const hit = snapCache.get(snap);
	if (hit) return hit;
	const { sequences } = bindWorld(data);
	const seq = sequences[snap.sequenceId];
	const locs = new Map<string, AnimLocation>();
	if (seq) for (const loc of sequenceAnimatables(snap.sequenceId, seq)) locs.set(`${loc.ref.owner}|${loc.ref.path}`, loc);
	const bind = <T>(anim: T, owner: string, path: string): T => {
		if (!anim || typeof anim !== 'object' || expressionBindingOf(anim)) return anim;
		if (!hasActiveExpression(anim as { expression?: { text: string; enabled: boolean } })) return anim;
		const loc = locs.get(`${owner}|${path}`);
		const b = loc ? boundAt(seq, loc.at) : undefined;
		return b ? withBinding(anim as object, b) as T : anim;
	};
	const bindEffects = <T extends { id: string; params: Record<string, unknown> }>(fxs: T[], owner: string): T[] =>
		fxs.map((fx) => {
			let params = fx.params;
			for (const [k, a] of Object.entries(fx.params)) {
				const b = bind(a, owner, `effects.${fx.id}.${k}`);
				if (b !== a) params = { ...params, [k]: b };
			}
			return params === fx.params ? fx : { ...fx, params };
		});
	const videoTracks = snap.videoTracks.map((track) => ({
		...track,
		clips: track.clips.map((c) => {
			const o = c.clipId;
			let out = c;
			if (c.transform) {
				let tr = c.transform;
				for (const k of ['position', 'anchor', 'scale', 'scaleWidth', 'rotation'] as const) {
					const b = bind(tr[k], o, `transform.${k}`);
					if (b !== tr[k]) tr = { ...tr, [k]: b };
				}
				if (tr !== c.transform) out = { ...out, transform: tr };
			}
			const op = bind(c.opacity, o, 'opacity');
			if (op !== c.opacity) out = { ...out, opacity: op };
			const effects = bindEffects(c.effects, o);
			if (effects.some((e, i) => e !== c.effects[i])) out = { ...out, effects };
			const src = c.source as Record<string, unknown>;
			if (src.shape) {
				const sh = src.shape as Record<string, unknown>;
				let shape = sh;
				for (const k of ['size', 'fill', 'cornerRadius'] as const) {
					const b = bind(sh[k], o, `shape.${k}`);
					if (b !== sh[k]) shape = { ...shape, [k]: b };
				}
				const stroke = sh.stroke as Record<string, unknown> | null;
				if (stroke) {
					let st = stroke;
					for (const k of ['color', 'width'] as const) {
						const b = bind(stroke[k], o, `shape.stroke.${k}`);
						if (b !== stroke[k]) st = { ...st, [k]: b };
					}
					if (st !== stroke) shape = { ...shape, stroke: st };
				}
				if (shape !== sh) out = { ...out, source: { ...src, shape } as never };
			}
			if (src.text) {
				const b = bind(src.text, o, 'text.content');
				if (b !== src.text) out = { ...out, source: { ...(out.source as object), text: b } as never };
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
