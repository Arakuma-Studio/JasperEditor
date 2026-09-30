// Applying a track to a target clip (S09:TRK-020…022): for every sequence frame of the range
//   plate content time → tracker sample (interpolated, smoothed) → media px
//   → sequence px through the plate's layer map at that frame (its Motion and own corner pin)
//   → target layer px through the inverse of the target's Motion (corner pin) / Motion values (transform).
// Pure: the handler (commands/handlers/tracker.ts) turns the result into keyframes.
import { evaluate } from '../keyframes.ts';
import { applyMat3, invertMat3, type Mat3, mat3FromMat2D, type Quad } from '../render/homography.ts';
import { clipContentTime, layerMapOf, resolveLayerProps } from '../render/scene.ts';
import type { RenderVisualClip } from '../render/snapshot.ts';
import type { Animatable, Vec2 } from '../schema/common.ts';
import type { ClipTracker, EffectInstance, Speed, Transform } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import { smoothSamples, trackerGeometryAt } from './samples.ts';

/** The parts of a document clip the apply pipeline evaluates. */
export type TrackLayer = {
	start: number;
	duration: number;
	sourceIn: number;
	speed: Speed;
	transform: Transform | null;
	opacity: Animatable<number>;
	effects: readonly EffectInstance[];
	/** Intrinsic layer box (media px for video/stills). */
	box: { width: number; height: number };
};

export type ApplyComponent = 'position' | 'scale' | 'rotation';

export type TrackingApplyInput = {
	fps: Rational;
	plate: TrackLayer;
	target: TrackLayer;
	tracker: Pick<ClipTracker, 'kind' | 'reference' | 'samples' | 'smoothing'>;
	mode: 'corner-pin' | 'transform';
	components?: readonly ApplyComponent[];
	/** Sequence frames [start, end). */
	range: { start: number; end: number };
	/** Overrides `tracker.smoothing`. */
	smoothing?: number;
	/** Effect instance id of the target's corner pin (excluded from the target's own map). */
	cornerPinId?: string;
};

export type CornerPinKey = { frame: number; time: number; corners: Quad };
export type TransformKey = {
	frame: number;
	time: number;
	position?: Vec2;
	scale?: number;
	scaleWidth?: number;
	rotation?: number;
};

export type TrackingApplyResult =
	| { mode: 'corner-pin'; keys: CornerPinKey[]; timeRange: [number, number]; warnings: string[] }
	| { mode: 'transform'; keys: TransformKey[]; timeRange: [number, number]; warnings: string[] };

function asLayer(l: TrackLayer, effects: readonly EffectInstance[]): RenderVisualClip {
	return {
		start: l.start,
		duration: l.duration,
		sourceIn: l.sourceIn,
		speed: l.speed,
		transform: l.transform,
		opacity: l.opacity,
		effects: effects as EffectInstance[],
		intrinsicBox: l.box,
	} as RenderVisualClip;
}

/** Content time of a layer at a sequence frame, rounded to integer flicks. */
export function layerTimeAt(
	l: Pick<TrackLayer, 'start' | 'duration' | 'sourceIn' | 'speed'>,
	frame: number,
	fps: Rational,
): number {
	return Math.round(clipContentTime(l, frame, fps));
}

/** Plate map (media px → sequence px) at content time `t` of the plate. */
export function plateMapAt(plate: TrackLayer, t: number): Mat3 {
	return layerMapOf(resolveLayerProps(asLayer(plate, plate.effects), t));
}

/** The target's Motion only (layer px → sequence px), without any corner pin. */
export function motionMapAt(target: TrackLayer, t: number): Mat3 {
	const props = resolveLayerProps(asLayer(target, []), t);
	return mat3FromMat2D(props.matrix);
}

/** Intersection of the quad's diagonals (the projected centre of the tracked plane). */
export function quadCentre(q: Quad): Vec2 {
	const [p0, p1, p2, p3] = q;
	const d1x = p2[0] - p0[0];
	const d1y = p2[1] - p0[1];
	const d2x = p3[0] - p1[0];
	const d2y = p3[1] - p1[1];
	const den = d1x * d2y - d1y * d2x;
	if (Math.abs(den) < 1e-12)
		return [(p0[0] + p1[0] + p2[0] + p3[0]) / 4, (p0[1] + p1[1] + p2[1] + p3[1]) / 4];
	const s = ((p1[0] - p0[0]) * d2y - (p1[1] - p0[1]) * d2x) / den;
	return [p0[0] + s * d1x, p0[1] + s * d1y];
}

function diagonal(q: Quad): number {
	return (
		(Math.hypot(q[2][0] - q[0][0], q[2][1] - q[0][1]) + Math.hypot(q[3][0] - q[1][0], q[3][1] - q[1][1])) / 2
	);
}

function topAngle(q: Quad): number {
	return (Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180) / Math.PI;
}

/** Sequence frame at which the plate shows content time `t` (clamped to the plate). */
export function plateFrameOf(plate: TrackLayer, t: number, fps: Rational): number {
	const F = flicksPerFrame(fps) * plate.speed.rate;
	const i = Math.round((t - plate.sourceIn) / F);
	const local = plate.speed.reverse ? plate.duration - 1 - i : i;
	return plate.start + Math.min(plate.duration - 1, Math.max(0, local));
}

/** Computes the keyframes of `tracker.apply` (see the header). Throws on unusable input. */
export function computeTrackingApply(input: TrackingApplyInput): TrackingApplyResult {
	const { fps, plate, target, tracker, mode, range } = input;
	const warnings: string[] = [];
	const radius = input.smoothing ?? tracker.smoothing ?? 0;
	const samples = tracker.samples && radius > 0 ? smoothSamples(tracker.samples, radius) : tracker.samples;
	const geometryAt = (t: number) => trackerGeometryAt(tracker, t, { samples, smoothing: 0 });
	const targetEffects = target.effects.filter((e) => e.id !== input.cornerPinId);
	const frames: number[] = [];
	for (let f = range.start; f < range.end; f++) frames.push(f);
	let tMin = Number.POSITIVE_INFINITY;
	let tMax = Number.NEGATIVE_INFINITY;
	const seen = new Set<number>();

	if (mode === 'corner-pin') {
		if (tracker.kind !== 'planar') throw new Error('A corner pin needs a planar tracker');
		if (!target.transform) throw new Error('The target clip has no Motion');
		const keys: CornerPinKey[] = [];
		for (const f of frames) {
			const tp = layerTimeAt(plate, f, fps);
			const tt = layerTimeAt(target, f, fps);
			if (seen.has(tt)) continue;
			seen.add(tt);
			const g = geometryAt(tp);
			if (!g.corners) throw new Error('The tracker has no corners');
			const P = plateMapAt(plate, tp);
			const M = mat3FromMat2D(resolveLayerProps(asLayer(target, targetEffects), tt).matrix);
			const Mi = invertMat3(M);
			if (!Mi) throw new Error('The target has a zero scale at a frame of the range');
			const corners = g.corners.map((p) => {
				const q = applyMat3(Mi, applyMat3(P, p));
				return [q[0] / target.box.width, q[1] / target.box.height] as Vec2;
			}) as Quad;
			keys.push({ frame: f, time: tt, corners });
			tMin = Math.min(tMin, tt);
			tMax = Math.max(tMax, tt);
		}
		return { mode, keys, timeRange: [tMin, tMax], warnings };
	}

	if (!target.transform) throw new Error('The target clip has no Motion');
	const want = new Set<ApplyComponent>(input.components ?? ['position', 'scale', 'rotation']);
	if (tracker.kind === 'point' && (want.has('scale') || want.has('rotation'))) {
		warnings.push('A point tracker only drives Position; Scale and Rotation are left as they are');
		want.delete('scale');
		want.delete('rotation');
	}
	const seqQuad = (t: number): { centre: Vec2; quad: Quad | null } => {
		const g = geometryAt(t);
		const P = plateMapAt(plate, t);
		if (g.corners) {
			const quad = g.corners.map((p) => applyMat3(P, p)) as Quad;
			return { centre: quadCentre(quad), quad };
		}
		return { centre: applyMat3(P, g.point ?? [0, 0]), quad: null };
	};
	// Reference: the plate frame showing the tracker's reference time (clamped into the range); the target's
	// Motion there is the base the ratios multiply, so re-applying is idempotent.
	const refFrame = Math.min(
		range.end - 1,
		Math.max(range.start, plateFrameOf(plate, tracker.reference.time, fps)),
	);
	const ref = seqQuad(tracker.reference.time);
	const tRefTarget = layerTimeAt(target, refFrame, fps);
	const tr = target.transform;
	const baseScale = evaluate(tr.scale, tRefTarget);
	const baseScaleWidth = evaluate(tr.scaleWidth, tRefTarget);
	const baseRotation = evaluate(tr.rotation, tRefTarget);
	const refDiag = ref.quad ? diagonal(ref.quad) : 0;
	const refAngle = ref.quad ? topAngle(ref.quad) : 0;
	const keys: TransformKey[] = [];
	let lastAngle = refAngle;
	let unwrap = 0;
	for (const f of frames) {
		const tp = layerTimeAt(plate, f, fps);
		const tt = layerTimeAt(target, f, fps);
		if (seen.has(tt)) continue;
		seen.add(tt);
		const s = seqQuad(tp);
		const key: TransformKey = { frame: f, time: tt };
		if (want.has('position')) key.position = s.centre;
		if (s.quad && refDiag > 0) {
			if (want.has('scale')) {
				const k = diagonal(s.quad) / refDiag;
				key.scale = baseScale * k;
				key.scaleWidth = baseScaleWidth * k;
			}
			if (want.has('rotation')) {
				let a = topAngle(s.quad);
				// Keep the angle continuous across ±180°.
				while (a + unwrap - lastAngle > 180) unwrap -= 360;
				while (a + unwrap - lastAngle < -180) unwrap += 360;
				a += unwrap;
				lastAngle = a;
				key.rotation = baseRotation + (a - refAngle);
			}
		}
		keys.push(key);
		tMin = Math.min(tMin, tt);
		tMax = Math.max(tMax, tt);
	}
	return { mode: 'transform', keys, timeRange: [tMin, tMax], warnings };
}
