// Program Monitor motion path (S03:OVL-020, KF-030): geometry, hit testing and drag commands. The path is the
// shared evaluator (`evaluate`, S03:KF-010) sampled at every frame of the clip, so the dots are exactly where the
// composition draws the anchor point. Position values live in the layer's parent space, which is sequence space
// here (the layer map is M(q) = P + R·S·(q − A), so M(A) = P whatever the layer's anchor, scale and rotation);
// the same `toScreen` / `toSequence` mapping as the transform gizmo handles monitor zoom and pan.
// Anchor Point paths too (values in layer space, drawn through the layer map at the playhead, as After
// Effects shows an anchor path over its layer), snapping and multi-key drags, Pen-tool vertex conversion.
// spatial-points: the paths of effect point params (Transform's Position / Anchor Point, Offset's Shift Center To, …:
// values normalised to the layer box) are drawn through the layer map at the playhead too, evaluated with the box's
// metric exactly as the renderers do (`buildEffectPointPath`).
import {
	applyMatrix,
	type Command,
	contentTimeAt,
	effectiveTangents,
	evaluate,
	invertMatrix,
	type Keyframe,
	type Mat2D,
	type Rational,
	type RenderVisualClip,
	type SpatialInterpolation,
	type SpatialMetric,
	spatialModeOf,
	type Vec2,
} from '@jasper/project';
import { toScreen, type View } from './viewport.ts';

/** Screen radius (px) within which a key square or a tangent handle is grabbed. */
const PATH_HIT = 6;
/** Tangent handles are drawn for at most this many keys (dense tracking keys show squares only). */
const MAX_HANDLE_KEYS = 200;

type MotionPathKey = {
	id: string;
	/** Key position in sequence px (the value itself for Position; mapped through the layer for Anchor Point). */
	pos: Vec2;
	/** The key's value (property space). */
	value: Vec2;
	mode: SpatialInterpolation;
	/** Absolute handle points (sequence px), null when the key has no handle on that side. */
	inHandle: Vec2 | null;
	outHandle: Vec2 | null;
	/** The key lies outside the clip's visible content range (KF-003: drawn, still shapes the path). */
	offClip: boolean;
};

/** Which point property the path animates (`effect` = an effect point param, `effect` names it). */
type MotionPathProperty = 'position' | 'anchor' | 'effect';

export type MotionPath = {
	clipId: string;
	trackId: string;
	property: MotionPathProperty;
	/** spatial-points: the effect instance and point param of an `effect` path. */
	effect?: { fxId: string; param: string; label: string };
	/** Property space (value units) → sequence px, and sequence-px vectors → property-space vectors. */
	toSeq(v: Vec2): Vec2;
	vecFromSeq(d: Vec2): Vec2;
	/**
	 * spatial-points: sequence px → property space for maps that are not affine (a corner-pinned layer's projective
	 * map); drags then turn pointer positions into values through it. Absent = `vecFromSeq` (affine maps).
	 */
	fromSeq?(p: Vec2): Vec2 | null;
	/** Evaluated position at every frame of the clip (sequence px); spacing encodes speed. */
	dots: Vec2[];
	keys: MotionPathKey[];
};

/**
 * The motion path of a clip's Position (or Anchor Point, `layerMap` = the layer map at the playhead: layer px →
 * sequence px), or null when the property has fewer than two keys (OVL-020).
 */
export function buildMotionPath(
	clip: RenderVisualClip,
	fps: Rational,
	property: MotionPathProperty = 'position',
	layerMap?: Mat2D | null,
): MotionPath | null {
	const anim = property === 'anchor' ? clip.transform?.anchor : clip.transform?.position;
	if (!anim || anim.keyframes.length < 2) return null;
	if (property === 'anchor' && !layerMap) return null;
	const inv = property === 'anchor' ? invertMatrix(layerMap!) : null;
	if (property === 'anchor' && !inv) return null;
	const toSeq = (v: Vec2): Vec2 => (property === 'anchor' ? applyMatrix(layerMap!, v) : [v[0], v[1]]);
	const vecFromSeq = (d: Vec2): Vec2 =>
		inv ? [inv.a * d[0] + inv.c * d[1], inv.b * d[0] + inv.d * d[1]] : [d[0], d[1]];
	const dots: Vec2[] = [];
	for (let f = 0; f < clip.duration; f++) {
		const v = evaluate(anim, contentTimeAt(clip, clip.start + f, fps));
		dots.push(toSeq([v[0], v[1]]));
	}
	const t0 = contentTimeAt(clip, clip.start, fps);
	const t1 = contentTimeAt(clip, clip.start + clip.duration - 1, fps);
	const [lo, hi] = [Math.min(t0, t1), Math.max(t0, t1)];
	const kfs = anim.keyframes as readonly Keyframe<unknown>[];
	const handles = kfs.length <= MAX_HANDLE_KEYS;
	const keys = anim.keyframes.map((k, i): MotionPathKey => {
		const mode = spatialModeOf(k);
		const tg = effectiveTangents(kfs, i);
		const curved = handles && mode !== 'linear';
		const value: Vec2 = [k.value[0], k.value[1]];
		const pos = toSeq(value);
		const at = (t: Vec2): Vec2 => toSeq([value[0] + t[0], value[1] + t[1]]);
		return {
			id: k.id,
			pos,
			value,
			mode,
			inHandle: curved && i > 0 ? at(tg.inTangent) : null,
			outHandle: curved && i < kfs.length - 1 ? at(tg.outTangent) : null,
			offClip: k.time < lo || k.time > hi,
		};
	});
	return { clipId: clip.clipId, trackId: clip.trackId, property, toSeq, vecFromSeq, dots, keys };
}

/**
 * spatial-points: the motion path of an effect point param (values normalised to the layer box, ≥ 2 keys), drawn through
 * `map` (the layer's map at the playhead: normalised point ↔ sequence px). Evaluated with the box's `metric`, so the
 * dots (one per clip frame) sit exactly where the renderers put the point, and Auto Bezier handles are the ones the
 * evaluator uses.
 */
export function buildEffectPointPath(
	clip: RenderVisualClip,
	fps: Rational,
	effect: { fxId: string; param: string; label: string },
	map: { toSeq(n: Vec2): Vec2; fromSeq(p: Vec2): Vec2 | null },
	metric?: SpatialMetric,
): MotionPath | null {
	const fx = clip.effects.find((e) => e.id === effect.fxId);
	const anim = fx?.params[effect.param];
	if (!anim || anim.keyframes.length < 2) return null;
	const kfs = anim.keyframes as readonly Keyframe<unknown>[];
	if (!kfs.every((k) => Array.isArray(k.value) && k.value.length === 2)) return null;
	const opts = metric ? { metric } : undefined;
	const dots: Vec2[] = [];
	for (let f = 0; f < clip.duration; f++) {
		const v = evaluate(anim, contentTimeAt(clip, clip.start + f, fps), opts) as Vec2;
		dots.push(map.toSeq([v[0], v[1]]));
	}
	const t0 = contentTimeAt(clip, clip.start, fps);
	const t1 = contentTimeAt(clip, clip.start + clip.duration - 1, fps);
	const [lo, hi] = [Math.min(t0, t1), Math.max(t0, t1)];
	const handles = kfs.length <= MAX_HANDLE_KEYS;
	const keys = kfs.map((k, i): MotionPathKey => {
		const mode = spatialModeOf(k);
		const tg = effectiveTangents(kfs, i, metric);
		const curved = handles && mode !== 'linear';
		const value: Vec2 = [(k.value as Vec2)[0], (k.value as Vec2)[1]];
		const at = (t: Vec2): Vec2 => map.toSeq([value[0] + t[0], value[1] + t[1]]);
		return {
			id: k.id,
			pos: map.toSeq(value),
			value,
			mode,
			inHandle: curved && i > 0 ? at(tg.inTangent) : null,
			outHandle: curved && i < kfs.length - 1 ? at(tg.outTangent) : null,
			offClip: k.time < lo || k.time > hi,
		};
	});
	// Vectors through the map's local linearisation at the box centre (only used without `fromSeq`).
	const c = map.toSeq([0.5, 0.5]);
	const ex = map.toSeq([1.5, 0.5]);
	const ey = map.toSeq([0.5, 1.5]);
	const inv = invertMatrix({
		a: ex[0] - c[0],
		b: ex[1] - c[1],
		c: ey[0] - c[0],
		d: ey[1] - c[1],
		e: 0,
		f: 0,
	});
	return {
		clipId: clip.clipId,
		trackId: clip.trackId,
		property: 'effect',
		effect,
		toSeq: map.toSeq,
		vecFromSeq: (d) => (inv ? [inv.a * d[0] + inv.c * d[1], inv.b * d[0] + inv.d * d[1]] : [0, 0]),
		fromSeq: map.fromSeq,
		dots,
		keys,
	};
}

/**
 * The property-space offset of a sequence point from a key: through `fromSeq` when the path has one (projective maps),
 * else the affine vector map.
 */
function offsetFrom(path: MotionPath, key: MotionPathKey, at: Vec2): Vec2 {
	if (path.fromSeq) {
		const v = path.fromSeq(at);
		if (v) return [v[0] - key.value[0], v[1] - key.value[1]];
	}
	return path.vecFromSeq([at[0] - key.pos[0], at[1] - key.pos[1]]);
}

type PathHit = { kind: 'key'; keyId: string } | { kind: 'tangent'; keyId: string; side: 'in' | 'out' };

/** The handle or key square under a screen point (handles win ties: they sit on top), or null. */
export function hitMotionPath(path: MotionPath, view: View, screen: Vec2, radius = PATH_HIT): PathHit | null {
	const candidates: [Vec2 | null, PathHit, number][] = path.keys.flatMap((k) => [
		[k.inHandle, { kind: 'tangent', keyId: k.id, side: 'in' }, 0],
		[k.outHandle, { kind: 'tangent', keyId: k.id, side: 'out' }, 0],
		[k.pos, { kind: 'key', keyId: k.id }, 0.5],
	]);
	let best: PathHit | null = null;
	let bestD = Number.POSITIVE_INFINITY;
	for (const [p, hit, bias] of candidates) {
		if (!p) continue;
		const s = toScreen(view, p);
		const d = Math.hypot(s[0] - screen[0], s[1] - screen[1]);
		if (d <= radius && d + bias < bestD) {
			best = hit;
			bestD = d + bias;
		}
	}
	return best;
}

/**
 * A motion-path drag in progress: what was grabbed, where it started (sequence px), the keys that move with it (a key
 * drag moves every selected key of the path by the same offset, keyframes-blend) and the path.
 */
export type MotionPathDrag = {
	hit: PathHit;
	key: MotionPathKey;
	start: Vec2;
	group: MotionPathKey[];
	path: MotionPath;
	/** Pen-tool / Ctrl-drag from a key: pull out Continuous Bezier handles instead of moving it. */
	pull?: boolean;
};

export function startMotionPathDrag(
	path: MotionPath,
	hit: PathHit,
	start: Vec2,
	selected: ReadonlySet<string> = new Set(),
	opts: { pull?: boolean } = {},
): MotionPathDrag | null {
	const key = path.keys.find((k) => k.id === hit.keyId);
	if (!key) return null;
	const group =
		hit.kind === 'key' && selected.has(key.id) ? path.keys.filter((k) => selected.has(k.id)) : [key];
	return { hit, key, start, group, path, ...(opts.pull ? { pull: true } : {}) };
}

/**
 * Pen tool / Ctrl-click (Cmd on macOS) on a path key (keyframes-blend; After Effects' Convert Vertex): a corner
 * (Linear spatial) becomes smooth (Auto Bezier), a smooth key becomes a corner.
 */
export function convertVertexCommand(key: Pick<MotionPathKey, 'id' | 'mode'>): Command {
	return {
		type: 'keyframe.setSpatialInterpolation',
		keyframeIds: [key.id],
		mode: key.mode === 'linear' ? 'auto-bezier' : 'linear',
	} as Command;
}

/**
 * Commands for the drag at pointer `p` (sequence px). Absolute values from the drag start, so the session
 * gesture re-applies them to its base document (one undo entry per drag, S01:SES-006). Shift locks a key drag
 * to the dominant axis; Alt breaks tangent continuity (OVL-020).
 */
export function motionPathDragCommands(
	d: MotionPathDrag,
	p: Vec2,
	mods: { alt: boolean; shift: boolean },
	/** Snaps the grabbed key's new sequence position (keyframes-blend); returns the corrected position. */
	snap?: (at: Vec2) => Vec2,
): { commands: Command[]; readout: string } {
	// spatial-points: effect points are normalised to the layer box (3 decimals, as Effect Controls shows them).
	const fmt = d.path.property === 'effect' ? fmtPoint : fmtPx;
	if (d.hit.kind === 'key' && d.pull) {
		// Pull Continuous Bezier handles out of the key: the out handle follows the pointer, the in one opposite.
		const out = offsetFrom(d.path, d.key, p);
		return {
			commands: [
				{
					type: 'keyframe.setTangents',
					keyframeId: d.key.id,
					inTangent: [0 - out[0], 0 - out[1]],
					outTangent: out,
				} as Command,
			],
			readout: `Tangent ${fmt(out[0])}, ${fmt(out[1])}`,
		};
	}
	if (d.hit.kind === 'key') {
		let dx = p[0] - d.start[0];
		let dy = p[1] - d.start[1];
		if (mods.shift) {
			if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
			else dx = 0;
		}
		if (snap) {
			const at = snap([d.key.pos[0] + dx, d.key.pos[1] + dy]);
			if (!(mods.shift && dx === 0)) dx = at[0] - d.key.pos[0];
			if (!(mods.shift && dy === 0)) dy = at[1] - d.key.pos[1];
		}
		const dv = offsetFrom(d.path, d.key, [d.key.pos[0] + dx, d.key.pos[1] + dy]);
		const commands = d.group.map(
			(k) =>
				({
					type: 'keyframe.update',
					keyframeId: k.id,
					value: [k.value[0] + dv[0], k.value[1] + dv[1]],
				}) as Command,
		);
		const lead: Vec2 = [d.key.value[0] + dv[0], d.key.value[1] + dv[1]];
		return {
			commands,
			readout: `${d.group.length > 1 ? `${d.group.length} keys · ` : ''}X ${fmt(lead[0])}  Y ${fmt(lead[1])}`,
		};
	}
	const handle0 = d.hit.side === 'in' ? d.key.inHandle : d.key.outHandle;
	const grab = handle0 ? [handle0[0] - d.start[0], handle0[1] - d.start[1]] : [0, 0];
	const tangent: Vec2 = offsetFrom(d.path, d.key, [p[0] + grab[0]!, p[1] + grab[1]!]);
	return {
		commands: [
			{
				type: 'keyframe.setTangents',
				keyframeId: d.key.id,
				[d.hit.side === 'in' ? 'inTangent' : 'outTangent']: tangent,
				...(mods.alt ? { breakContinuity: true } : {}),
			} as Command,
		],
		readout: `Tangent ${fmt(tangent[0])}, ${fmt(tangent[1])}`,
	};
}

const fmtPx = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const fmtPoint = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);

/** SVG path data drawing every sample as a round 2 px dot (one element for the whole path). */
export function dotsPathData(path: MotionPath, view: View): string {
	let d = '';
	for (const p of path.dots) {
		const s = toScreen(view, p);
		d += `M${s[0].toFixed(1)} ${s[1].toFixed(1)}h0`;
	}
	return d;
}
