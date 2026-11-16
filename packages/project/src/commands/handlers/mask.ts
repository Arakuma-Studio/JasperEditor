// Masks are Opacity masks of a visual clip (`clip.masks`) or masks of one of its video effect instances
// (`effect.masks`, Premiere's per-effect masks). Paths are in layer-box-normalised coordinates; feather and
// expansion are layer pixels. Every mask property is also a ParamPath target (`["mask", id, prop]`, param.ts).
import type { Draft } from 'immer';
import { evaluate } from '../../keyframes.ts';
import { defaultMaskPath, newMask, nextMaskName } from '../../masks/model.ts';
import {
	appendVertexTo,
	type BezierPath,
	clonePath,
	convertVertices,
	insertVertexAt,
	type PathPoint,
	pathCentroid,
	removeVertices,
	segmentCount,
	similarityAffine,
	transformPath,
} from '../../path/model.ts';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import { CORNER_PIN_EFFECT_ID } from '../../render/scene.ts';
import type { Animatable, Keyframe } from '../../schema/common.ts';
import type { Mask } from '../../schema/mask.ts';
import type { Clip, EffectInstance } from '../../schema/sequence.ts';
import { type DClip, type DDoc, type DSeq, effectNotFoundMessage, type HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf, MaskPathOp, ParamAt } from '../schemas/index.ts';
import { finish } from './keyframe.ts';
import { locateMask, type MaskLocation, validateMaskPath } from './mask-location.ts';
import { locateEffect, newKeyframe } from './param.ts';
import type { HandlerMap } from './util.ts';
import { clone } from './util.ts';

type DMask = Draft<Mask>;
type DPathAnim = Draft<Animatable<BezierPath>>;

function mustLocate(doc: DDoc, maskId: string, h: HandlerContext): MaskLocation {
	const loc = locateMask(doc, maskId);
	if (!loc) return h.fail('E_NOT_FOUND', `Mask not found: ${maskId}`);
	assertUnlocked(findTrackIn(loc.seq, loc.clip.trackId)!.track, h);
	return loc;
}

/** The mask list of a clip's Opacity or of a clip's video effect (created when absent). */
function ownerList(
	doc: DDoc,
	target: { clipId?: string; effectId?: string },
	h: HandlerContext,
): { seq: DSeq; clip: DClip; fx: Draft<EffectInstance> | null; list: DMask[] } {
	if (!!target.clipId === !!target.effectId)
		h.fail('E_INVALID_PARAM', 'Give exactly one of clipId or effectId');
	if (target.clipId) {
		const { seq, clip } = h.clip(doc, target.clipId);
		if (!('opacity' in clip) || !('effects' in clip))
			h.fail('E_INVALID_PARAM', `${clip.kind} clips have no Opacity to mask`);
		assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
		const c = clip as { masks?: DMask[] };
		c.masks ??= [];
		return { seq, clip, fx: null, list: c.masks };
	}
	const found = locateEffect(doc, target.effectId!);
	if (!found) return h.fail('E_NOT_FOUND', effectNotFoundMessage(target.effectId!));
	if (!found.clip)
		return h.fail('E_INVALID_PARAM', 'Masks apply to effects of clips (not track or master effects)');
	const spec = h.registries.effects.get(found.fx.effectId, found.fx.effectVersion);
	if (spec && spec.appliesTo !== 'video') h.fail('E_INVALID_PARAM', 'Masks apply to video effects');
	if (found.fx.effectId === CORNER_PIN_EFFECT_ID)
		h.fail('E_INVALID_PARAM', 'Corner Pin is the layer geometry and cannot be masked');
	assertUnlocked(findTrackIn(found.seq, found.clip.trackId)!.track, h);
	const fx = found.fx as Draft<EffectInstance> & { masks?: DMask[] };
	fx.masks ??= [];
	return { seq: found.seq, clip: found.clip, fx, list: fx.masks };
}

function timeOf(loc: { seq: DSeq; clip: DClip }, h: HandlerContext, at: ParamAt | undefined): number {
	return h.clipContentTime(loc.seq, loc.clip, at);
}

/** Writes a path at time `t` with stopwatch semantics (a keyframe when animated, else the static value). */
function writePathAt(anim: DPathAnim, t: number, path: BezierPath, h: HandlerContext): void {
	if (anim.keyframes.length === 0) {
		anim.value = path as never;
		return;
	}
	const existing = anim.keyframes.find((k) => k.time === t);
	if (existing) existing.value = path as never;
	else anim.keyframes.push(newKeyframe(h, t, path, false) as never);
	finish([anim as never]);
}

/** Applies `f` to the static value and every keyframe (topology edits keep all keys matching). */
function mapAllPaths(anim: DPathAnim, f: (p: BezierPath) => BezierPath): void {
	anim.value = f(clone(anim.value as BezierPath)) as never;
	for (const k of anim.keyframes) k.value = f(clone(k.value as BezierPath)) as never;
}

/** Normalised ↔ layer px helpers for a clip's intrinsic box. */
function boxOf(doc: DDoc, seq: DSeq, clip: DClip): { width: number; height: number } {
	return intrinsicBoxOf({ clip: clip as Clip, doc: doc as never, seq: seq as never });
}

function applyShapeOp(
	p: BezierPath,
	op: MaskPathOp,
	box: { width: number; height: number },
	h: HandlerContext,
): BezierPath {
	const n = p.vertices.length;
	const checkIdx = (list: readonly number[]) => {
		for (const i of list) if (i >= n) h.fail('E_INVALID_PARAM', `No vertex ${i} (the path has ${n})`);
	};
	switch (op.op) {
		case 'set':
			return validateMaskPath(op.path, h);
		case 'moveVertices': {
			checkIdx(op.vertices);
			const out = clonePath(p);
			for (const i of new Set(op.vertices)) {
				const v = out.vertices[i]!;
				v.p = [v.p[0] + op.delta[0], v.p[1] + op.delta[1]];
			}
			return out;
		}
		case 'setVertex': {
			checkIdx([op.vertex]);
			const out = clonePath(p);
			const v = out.vertices[op.vertex]!;
			if (op.p) v.p = [op.p[0], op.p[1]];
			const keepOpposite = !op.breakHandles;
			// Pixel-space lengths: the mirrored handle keeps its on-screen length and the opposite direction.
			const mirror = (h0: PathPoint, other: PathPoint): PathPoint => {
				const len = Math.hypot(other[0] * box.width, other[1] * box.height);
				const dx = h0[0] * box.width;
				const dy = h0[1] * box.height;
				const l = Math.hypot(dx, dy);
				if (l < 1e-12) return other;
				return [(-dx / l) * (len / box.width), (-dy / l) * (len / box.height)];
			};
			if (op.in && op.out) {
				v.in = [op.in[0], op.in[1]];
				v.out = [op.out[0], op.out[1]];
			} else if (op.in) {
				const wasCorner = v.out[0] === 0 && v.out[1] === 0 && v.in[0] === 0 && v.in[1] === 0;
				v.in = [op.in[0], op.in[1]];
				if (keepOpposite) v.out = wasCorner ? [-op.in[0], -op.in[1]] : mirror(v.in, v.out);
			} else if (op.out) {
				const wasCorner = v.out[0] === 0 && v.out[1] === 0 && v.in[0] === 0 && v.in[1] === 0;
				v.out = [op.out[0], op.out[1]];
				if (keepOpposite) v.in = wasCorner ? [-op.out[0], -op.out[1]] : mirror(v.out, v.in);
			}
			return validateMaskPath(out, h);
		}
		case 'transform': {
			const idx = op.vertices ?? p.vertices.map((_, i) => i);
			checkIdx(idx);
			const sel = new Set(idx);
			const origin = op.origin ?? pathCentroid({ vertices: idx.map((i) => p.vertices[i]!) });
			// In layer pixels (rotations are rotations on screen), then back to normalised units.
			const W = box.width || 1;
			const H = box.height || 1;
			const toPx = (q: PathPoint): PathPoint => [q[0] * W, q[1] * H];
			const m = similarityAffine(toPx(origin), {
				...(op.scale !== undefined ? { scale: op.scale } : {}),
				...(op.rotation !== undefined ? { rotation: op.rotation } : {}),
				...(op.translate ? { translate: toPx(op.translate) } : {}),
			});
			const px = transformPath(
				{
					closed: p.closed,
					vertices: p.vertices.map((v) => ({ p: toPx(v.p), in: toPx(v.in), out: toPx(v.out) })),
				},
				m,
			);
			const out = clonePath(p);
			px.vertices.forEach((v, i) => {
				if (!sel.has(i)) return;
				out.vertices[i] = {
					p: [v.p[0] / W, v.p[1] / H],
					in: [v.in[0] / W, v.in[1] / H],
					out: [v.out[0] / W, v.out[1] / H],
				};
			});
			return validateMaskPath(out, h);
		}
		case 'convert': {
			checkIdx(op.vertices);
			// Smooth handles are computed in pixels so they point along the on-screen neighbours' direction.
			const W = box.width || 1;
			const H = box.height || 1;
			const px = convertVertices(
				{
					closed: p.closed,
					vertices: p.vertices.map((v) => ({ p: [v.p[0] * W, v.p[1] * H], in: v.in, out: v.out })),
				},
				op.vertices,
				op.to,
			);
			const out = clonePath(p);
			for (const i of op.vertices) {
				const v = px.vertices[i]!;
				out.vertices[i]!.in = op.to === 'corner' ? [0, 0] : [v.in[0] / W, v.in[1] / H];
				out.vertices[i]!.out = op.to === 'corner' ? [0, 0] : [v.out[0] / W, v.out[1] / H];
			}
			return out;
		}
		case 'setFeatherPoint': {
			const f = p.feather?.[op.index];
			if (!f) return h.fail('E_INVALID_PARAM', `No feather point ${op.index}`);
			const out = clonePath(p);
			out.feather![op.index] = {
				...f,
				...(op.radius !== undefined ? { radius: op.radius } : {}),
				...(op.tension !== undefined ? { tension: op.tension } : {}),
				...(op.t !== undefined ? { t: op.t } : {}),
			};
			return out;
		}
		default:
			return p;
	}
}

const TOPOLOGY_OPS = new Set([
	'insertVertex',
	'removeVertices',
	'appendVertex',
	'setClosed',
	'addFeatherPoint',
	'removeFeatherPoints',
]);

function applyTopologyOp(p: BezierPath, op: MaskPathOp, h: HandlerContext): BezierPath {
	switch (op.op) {
		case 'insertVertex': {
			if (op.segment >= segmentCount(p)) h.fail('E_INVALID_PARAM', `No segment ${op.segment}`);
			return insertVertexAt(p, op.segment, op.t).path;
		}
		case 'removeVertices': {
			const n = p.vertices.length;
			for (const i of op.vertices)
				if (i >= n) h.fail('E_INVALID_PARAM', `No vertex ${i} (the path has ${n})`);
			const left = n - new Set(op.vertices).size;
			if (p.closed && left < 3) h.fail('E_INVALID_PARAM', 'A closed mask keeps at least 3 vertices');
			if (left < 1) h.fail('E_INVALID_PARAM', 'A mask keeps at least one vertex');
			return removeVertices(p, op.vertices);
		}
		case 'appendVertex': {
			if (p.closed) h.fail('E_INVALID_PARAM', 'The path is closed: insert vertices on a segment instead');
			return appendVertexTo(p, op.p, op.in ?? [0, 0], op.out ?? [0, 0]);
		}
		case 'setClosed': {
			if (op.closed && p.vertices.length < 3)
				h.fail('E_INVALID_PARAM', 'A closed mask needs at least 3 vertices');
			const out = clonePath(p);
			out.closed = op.closed;
			// Feather points on the closing segment disappear when the path opens.
			if (!op.closed && out.feather) {
				const segs = segmentCount(out);
				out.feather = out.feather.filter((f) => f.segment < segs);
				if (out.feather.length === 0) delete out.feather;
			}
			return out;
		}
		case 'addFeatherPoint': {
			if (op.point.segment >= segmentCount(p)) h.fail('E_INVALID_PARAM', `No segment ${op.point.segment}`);
			const out = clonePath(p);
			out.feather = [...(out.feather ?? []), { ...op.point }];
			return out;
		}
		case 'removeFeatherPoints': {
			const drop = new Set(op.indices);
			const out = clonePath(p);
			out.feather = (out.feather ?? []).filter((_, i) => !drop.has(i));
			if (out.feather.length === 0) delete out.feather;
			return out;
		}
		default:
			return p;
	}
}

// the same path edits on vector shape path items (pixel units: box 1×1).
export {
	applyShapeOp as applyPathEditOp,
	applyTopologyOp as applyPathTopologyOp,
	mapAllPaths,
	TOPOLOGY_OPS as PATH_TOPOLOGY_OPS,
	writePathAt,
};

function copyMaskWithIds(m: Mask, h: HandlerContext): Mask {
	const copy = clone(m);
	copy.id = h.ids.next('msk');
	for (const prop of ['path', 'feather', 'opacity', 'expansion'] as const)
		for (const k of copy[prop].keyframes as Keyframe<unknown>[]) k.id = h.ids.next('kf');
	return copy;
}

export const maskHandlers = {
	'mask.add': (doc, cmd: CommandOf<'mask.add'>, h) => {
		const owner = ownerList(doc, cmd, h);
		const box = boxOf(doc, owner.seq, owner.clip);
		let path: BezierPath;
		if (cmd.path) path = validateMaskPath(cmd.path, h);
		else if (cmd.shape === 'bezier')
			return h.fail('E_INVALID_PARAM', 'A pen (bezier) mask needs `path` (its vertices)');
		else path = defaultMaskPath(cmd.shape, box.height > 0 ? box.width / box.height : 1);
		if (path.closed && path.vertices.length < 3)
			h.fail('E_INVALID_PARAM', 'A closed mask needs at least 3 vertices');
		if (path.vertices.length < 1) h.fail('E_INVALID_PARAM', 'A mask needs at least one vertex');
		const id = h.ids.next('msk');
		const mask = newMask({
			id,
			name: cmd.name ?? nextMaskName(owner.list),
			shape: cmd.shape,
			path,
			...(cmd.mode ? { mode: cmd.mode } : {}),
			...(cmd.inverted !== undefined ? { inverted: cmd.inverted } : {}),
			...(cmd.feather !== undefined ? { feather: cmd.feather } : {}),
			...(cmd.opacity !== undefined ? { opacity: cmd.opacity } : {}),
			...(cmd.expansion !== undefined ? { expansion: cmd.expansion } : {}),
			...(cmd.featherFalloff ? { featherFalloff: cmd.featherFalloff } : {}),
			...(cmd.trackMethod ? { trackMethod: cmd.trackMethod } : {}),
		});
		const at = Math.min(cmd.index ?? owner.list.length, owner.list.length);
		owner.list.splice(at, 0, mask as DMask);
		h.defineRef(cmd.ref, id);
		return {
			maskId: id,
			name: mask.name,
			index: at,
			owner: owner.fx ? { effectId: owner.fx.id } : { clipId: owner.clip.id },
		};
	},

	'mask.remove': (doc, cmd: CommandOf<'mask.remove'>, h) => {
		const ids = [...new Set(cmd.maskIds)];
		for (const id of ids) {
			const loc = mustLocate(doc, id, h);
			loc.list.splice(loc.index, 1);
			// text-animators: a text clip's Path Options on this mask go back to Path: None (as in AE).
			const po = (loc.clip as { pathOptions?: { maskId?: string } } | null)?.pathOptions;
			if (!loc.fx && po?.maskId === id) delete (loc.clip as { pathOptions?: unknown }).pathOptions;
			// An emptied list is dropped (absent = no masks), keeping documents minimal.
			if (loc.list.length === 0) {
				if (loc.fx) delete (loc.fx as { masks?: unknown }).masks;
				else delete (loc.clip as { masks?: unknown }).masks;
			}
		}
		return { removed: ids.length };
	},

	'mask.update': (doc, cmd: CommandOf<'mask.update'>, h) => {
		const { mask, list } = mustLocate(doc, cmd.maskId, h);
		if (cmd.name !== undefined) {
			if (list.some((m) => m !== mask && m.name === cmd.name))
				h.warn('W_DUPLICATE_NAME', `Another mask of this owner is named ${cmd.name}`);
			mask.name = cmd.name;
		}
		if (cmd.mode) mask.mode = cmd.mode;
		if (cmd.inverted !== undefined) mask.inverted = cmd.inverted;
		if (cmd.featherFalloff) {
			if (cmd.featherFalloff === 'smooth') delete mask.featherFalloff;
			else mask.featherFalloff = cmd.featherFalloff;
		}
		if (cmd.trackMethod) mask.trackMethod = cmd.trackMethod;
		if (cmd.locked !== undefined) {
			if (cmd.locked) mask.locked = true;
			else delete mask.locked;
		}
		return { maskId: mask.id };
	},

	'mask.reorder': (doc, cmd: CommandOf<'mask.reorder'>, h) => {
		const loc = mustLocate(doc, cmd.maskId, h);
		const to = Math.min(cmd.index, loc.list.length - 1);
		const [m] = loc.list.splice(loc.index, 1);
		loc.list.splice(to, 0, m!);
		return { maskId: cmd.maskId, index: to };
	},

	'mask.duplicate': (doc, cmd: CommandOf<'mask.duplicate'>, h) => {
		const created: string[] = [];
		const target =
			cmd.toClipId || cmd.toEffectId
				? ownerList(doc, { clipId: cmd.toClipId, effectId: cmd.toEffectId }, h)
				: null;
		for (const id of [...new Set(cmd.maskIds)]) {
			const loc = mustLocate(doc, id, h);
			const copy = copyMaskWithIds(clone(loc.mask) as Mask, h);
			const list = target ? target.list : loc.list;
			copy.name = target
				? list.some((m) => m.name === copy.name)
					? nextMaskName(list)
					: copy.name
				: nextMaskName(list);
			if (target) {
				// Pasting onto another clip keeps the shape in normalised units and retimes nothing: the keys are content
				// times of the source clip, which a different clip may not cover — keep the value at the source's first
				// key time when the target is another clip.
				if (target.clip.id !== loc.clip.id) {
					for (const prop of ['path', 'feather', 'opacity', 'expansion'] as const) {
						const a = copy[prop] as Animatable<unknown>;
						if (a.keyframes.length) {
							a.value = clone(evaluate(a, a.keyframes[0]!.time)) as never;
							a.keyframes = [];
						}
					}
				}
				list.push(copy as DMask);
			} else list.splice(loc.list.indexOf(loc.mask) + 1, 0, copy as DMask);
			created.push(copy.id);
		}
		return { maskIds: created };
	},

	'mask.editPath': (doc, cmd: CommandOf<'mask.editPath'>, h) => {
		const loc = mustLocate(doc, cmd.maskId, h);
		const anim = loc.mask.path as DPathAnim;
		const box = boxOf(doc, loc.seq, loc.clip);
		const t = timeOf(loc, h, cmd.at);
		for (const op of cmd.ops) {
			if (TOPOLOGY_OPS.has(op.op)) {
				mapAllPaths(anim, (p) => applyTopologyOp(p, op, h));
				continue;
			}
			if (cmd.allKeyframes && anim.keyframes.length > 0) {
				if (op.op === 'set') h.fail('E_INVALID_PARAM', 'set with allKeyframes would flatten the animation');
				mapAllPaths(anim, (p) => applyShapeOp(p, op, box, h));
				continue;
			}
			const cur = clone(evaluate(anim as Animatable<BezierPath>, t));
			writePathAt(anim, t, applyShapeOp(cur, op, box, h), h);
		}
		// Every key keeps one vertex structure (topology ops apply everywhere; `set` may change it — then the keys
		// interpolate through smart vertex matching).
		const value = evaluate(anim as Animatable<BezierPath>, t);
		return { maskId: loc.mask.id, vertices: value.vertices.length, closed: value.closed, time: t };
	},

	'mask.setPathKeys': (doc, cmd: CommandOf<'mask.setPathKeys'>, h) => {
		const loc = mustLocate(doc, cmd.maskId, h);
		const anim = loc.mask.path as DPathAnim;
		const keys = cmd.keys.map((k) => ({ time: timeOf(loc, h, k.at), path: validateMaskPath(k.path, h) }));
		const lo = Math.min(...keys.map((k) => k.time));
		const hi = Math.max(...keys.map((k) => k.time));
		if (cmd.clearSpan) anim.keyframes = anim.keyframes.filter((k) => k.time < lo || k.time > hi) as never;
		const byTime = new Map(anim.keyframes.map((k) => [k.time, k]));
		for (const k of keys) {
			const hit = byTime.get(k.time);
			if (hit) hit.value = k.path as never;
			else {
				const kf = newKeyframe(h, k.time, k.path, false);
				anim.keyframes.push(kf as never);
				byTime.set(k.time, anim.keyframes[anim.keyframes.length - 1]!);
			}
		}
		finish([anim as never]);
		return { maskId: loc.mask.id, keys: keys.length };
	},
} satisfies HandlerMap;
