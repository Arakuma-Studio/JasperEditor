// Program Monitor motion path (S03:OVL-020, KF-030): geometry, hit testing and drag commands. The path is the
// shared evaluator (`evaluate`, S03:KF-010) sampled at every frame of the clip, so the dots are exactly where the
// composition draws the anchor point. Position values live in the layer's parent space, which is sequence space
// here (the layer map is M(q) = P + R·S·(q − A), so M(A) = P whatever the layer's anchor, scale and rotation);
// the same `toScreen` / `toSequence` mapping as the transform gizmo handles monitor zoom and pan.
import {
	type Command,
	contentTimeAt,
	effectiveTangents,
	evaluate,
	type Keyframe,
	type Rational,
	type RenderVisualClip,
	type SpatialInterpolation,
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
	/** Key value = position (sequence px). */
	pos: Vec2;
	mode: SpatialInterpolation;
	/** Absolute handle points (sequence px), null when the key has no handle on that side. */
	inHandle: Vec2 | null;
	outHandle: Vec2 | null;
	/** The key lies outside the clip's visible content range (KF-003: drawn, still shapes the path). */
	offClip: boolean;
};

export type MotionPath = {
	clipId: string;
	trackId: string;
	/** Evaluated position at every frame of the clip (sequence px); spacing encodes speed. */
	dots: Vec2[];
	keys: MotionPathKey[];
};

/** The motion path of a clip, or null when its position has fewer than two keys (OVL-020). */
export function buildMotionPath(clip: RenderVisualClip, fps: Rational): MotionPath | null {
	const anim = clip.transform?.position;
	if (!anim || anim.keyframes.length < 2) return null;
	const dots: Vec2[] = [];
	for (let f = 0; f < clip.duration; f++) {
		const v = evaluate(anim, contentTimeAt(clip, clip.start + f, fps));
		dots.push([v[0], v[1]]);
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
		const pos: Vec2 = [k.value[0], k.value[1]];
		const at = (t: Vec2): Vec2 => [pos[0] + t[0], pos[1] + t[1]];
		return {
			id: k.id,
			pos,
			mode,
			inHandle: curved && i > 0 ? at(tg.inTangent) : null,
			outHandle: curved && i < kfs.length - 1 ? at(tg.outTangent) : null,
			offClip: k.time < lo || k.time > hi,
		};
	});
	return { clipId: clip.clipId, trackId: clip.trackId, dots, keys };
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

/** A motion-path drag in progress: what was grabbed and where it started (sequence px). */
export type MotionPathDrag = { hit: PathHit; key: MotionPathKey; start: Vec2 };

export function startMotionPathDrag(path: MotionPath, hit: PathHit, start: Vec2): MotionPathDrag | null {
	const key = path.keys.find((k) => k.id === hit.keyId);
	return key ? { hit, key, start } : null;
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
): { commands: Command[]; readout: string } {
	if (d.hit.kind === 'key') {
		let dx = p[0] - d.start[0];
		let dy = p[1] - d.start[1];
		if (mods.shift) {
			if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
			else dx = 0;
		}
		const value: Vec2 = [d.key.pos[0] + dx, d.key.pos[1] + dy];
		return {
			commands: [{ type: 'keyframe.update', keyframeId: d.key.id, value } as Command],
			readout: `X ${fmt(value[0])}  Y ${fmt(value[1])}`,
		};
	}
	const handle0 = d.hit.side === 'in' ? d.key.inHandle : d.key.outHandle;
	const grab = handle0 ? [handle0[0] - d.start[0], handle0[1] - d.start[1]] : [0, 0];
	const tangent: Vec2 = [p[0] + grab[0]! - d.key.pos[0], p[1] + grab[1]! - d.key.pos[1]];
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

const fmt = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

/** SVG path data drawing every sample as a round 2 px dot (one element for the whole path). */
export function dotsPathData(path: MotionPath, view: View): string {
	let d = '';
	for (const p of path.dots) {
		const s = toScreen(view, p);
		d += `M${s[0].toFixed(1)} ${s[1].toFixed(1)}h0`;
	}
	return d;
}
