// The 3D Camera Tracker's data: feature tracks, the lens distortion model, settings and the solve. Port of EffectCraft
// `crates/track/src/camtrack/mod.rs` (MIT OR Apache-2.0). The camera model has square pixels and the principal point
// at the frame centre; camera space is x right, y down, z forward (After Effects'); a camera is `(R, C, f)` with
// `X_cam = R (X − C)` and pixel `u = f x / z + w / 2`. The solve is stored in a canonical frame: the first solved
// frame's camera at the origin looking along +z, scaled so the median depth of the points it sees is 1.
import type { V3 } from './linalg.ts';

/** One feature track: positions (frame pixels) on consecutive frames from `start`. */
export type Track2D = { id: number; start: number; pts: [number, number][] };

/** The tracked features of a clip. */
export type CameraTracks = {
	/** Frame size (pixels). */
	size: [number, number];
	frames: number;
	/** Analysis downsampling (image pixels per analysis pixel): the tracking noise scale. */
	factor: number;
	detailed: boolean;
	tracks: Track2D[];
};

/** Radial lens distortion `p_d = p (1 + k1 ρ² + k2 ρ⁴)`, ρ = distance from the principal point / `radius`. */
export type Distortion = { k1: number; k2: number; radius: number };
export const NO_DISTORTION: Distortion = { k1: 0, k2: 0, radius: 0 };
export const distortionFor = (size: [number, number]): Distortion => ({
	k1: 0,
	k2: 0,
	radius: 0.5 * Math.hypot(size[0], size[1]),
});
export const isNoDistortion = (d: Distortion) => d.radius <= 0 || (d.k1 === 0 && d.k2 === 0);

/** Ideal → distorted (pixels relative to the principal point). */
export function distort(d: Distortion, p: [number, number]): [number, number] {
	if (d.radius <= 0) return p;
	const r2 = (p[0] * p[0] + p[1] * p[1]) / (d.radius * d.radius);
	const k = 1 + d.k1 * r2 + d.k2 * r2 * r2;
	return [p[0] * k, p[1] * k];
}
/** Distorted → ideal (fixed-point iteration). */
export function undistort(d: Distortion, q: [number, number]): [number, number] {
	if (isNoDistortion(d)) return q;
	let p = q;
	for (let i = 0; i < 30; i++) {
		const r2 = (p[0] * p[0] + p[1] * p[1]) / (d.radius * d.radius);
		const k = 1 + d.k1 * r2 + d.k2 * r2 * r2;
		if (Math.abs(k) < 1e-6) break;
		p = [q[0] / k, q[1] / k];
	}
	return p;
}
/** `d distort / d p` (2×2) and `d distort / d (k1, k2)` (rows x, y). */
export function distortionJacobian(
	d: Distortion,
	p: [number, number],
): { j: [[number, number], [number, number]]; k: [[number, number], [number, number]] } {
	if (d.radius <= 0)
		return {
			j: [
				[1, 0],
				[0, 1],
			],
			k: [
				[0, 0],
				[0, 0],
			],
		};
	const R2 = d.radius * d.radius;
	const r2 = (p[0] * p[0] + p[1] * p[1]) / R2;
	const dd = 1 + d.k1 * r2 + d.k2 * r2 * r2;
	const g = ((d.k1 + 2 * d.k2 * r2) * 2) / R2;
	return {
		j: [
			[dd + p[0] * g * p[0], p[0] * g * p[1]],
			[p[1] * g * p[0], dd + p[1] * g * p[1]],
		],
		k: [
			[p[0] * r2, p[0] * r2 * r2],
			[p[1] * r2, p[1] * r2 * r2],
		],
	};
}

/** 3D Camera Tracker ▸ Shot Type. */
export type ShotType = 'fixed' | 'variable' | 'specify';
/** 3D Camera Tracker ▸ Advanced ▸ Solve Method (and Method Used). */
export type SolveMethod = 'auto' | 'typical' | 'flat' | 'tripod';

export type SolveSettings = {
	shot: ShotType;
	/** Horizontal angle of view (degrees) for `specify`. */
	hfov: number;
	method: SolveMethod;
	/** Track ids the user deleted. */
	deleted: number[];
	/** Solve radial lens distortion jointly with the cameras. */
	lensDistortion: boolean;
};

/** The solved camera of one frame: world → camera rotation (axis-angle), centre, focal length (pixels). */
export type SolvedFrame = { rot: V3; center: V3; focal: number; solved: boolean };
/** A solved 3D track point (id = its feature track). */
export type SolvedPoint = { id: number; pos: V3; error: number; first: number; last: number };

export type CameraSolve = {
	size: [number, number];
	shot: ShotType;
	methodUsed: Exclude<SolveMethod, 'auto'>;
	/** Average reprojection error (pixels) over the solved observations. */
	averageError: number;
	frames: SolvedFrame[];
	points: SolvedPoint[];
	distortion: Distortion | null;
};

/** Median focal length of the solved frames (pixels). */
export function solveFocal(s: Pick<CameraSolve, 'frames'>): number {
	const f = s.frames.filter((c) => c.solved).map((c) => c.focal);
	if (f.length === 0) return 0;
	f.sort((a, b) => a - b);
	return f[f.length >> 1]!;
}

export class SolveError extends Error {}
