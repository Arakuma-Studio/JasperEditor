// Accuracy of the 3D Camera Tracker's solver on synthetic scenes with a known camera path (the solve is compared after
// eliminating the unobservable global translation, rotation and scale of a monocular solve).
import { describe, expect, it } from 'vitest';
import { type P2, Rng, ransacHomography } from '../src/camtrack/core/geometry.ts';
import { cross, type M3, mv, normalize, sub, type V3 } from '../src/camtrack/core/linalg.ts';
import { solveCamera } from '../src/camtrack/core/solver.ts';
import type { CameraSolve, CameraTracks, Distortion, SolveSettings } from '../src/camtrack/core/types.ts';
import { collinearPathError } from './camera-path-oracle.ts';

const W = 1280;
const H = 720;

type Cam = { r: M3; c: V3; f: number };

/** Median focal length of the solved frames (pixels). */
function solveFocal(s: Pick<CameraSolve, 'frames'>): number {
	const f = s.frames.filter((c) => c.solved).map((c) => c.focal);
	if (f.length === 0) return 0;
	f.sort((a, b) => a - b);
	return f[f.length >> 1]!;
}

/** A camera at `c` looking at `target` (y down). */
function lookAt(c: V3, target: V3, f: number): Cam {
	const z = normalize(sub(target, c));
	const x = normalize(cross([0, 1, 0], z));
	const y = cross(z, x);
	return { r: [x, y, z], c, f };
}

/** Gaussian noise (Box–Muller). */
function gauss(rng: Rng): number {
	const u = Math.max(1e-12, rng.unit());
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.unit());
}

function project(cam: Cam, x: V3, dist?: Distortion): P2 | null {
	const p = mv(cam.r, sub(x, cam.c));
	if (p[2] < 0.1) return null;
	const q: P2 = [(cam.f * p[0]) / p[2], (cam.f * p[1]) / p[2]];
	// Brown radial model, independently applied to generate observed image coordinates.
	const radiusSquared = dist ? (q[0] ** 2 + q[1] ** 2) / dist.radius ** 2 : 0;
	const radialScale = dist ? 1 + dist.k1 * radiusSquared + dist.k2 * radiusSquared ** 2 : 1;
	const d: P2 = [q[0] * radialScale, q[1] * radialScale];
	const u = d[0] + W / 2;
	const v = d[1] + H / 2;
	return u >= 0 && u < W && v >= 0 && v < H ? [u, v] : null;
}

/** Feature tracks of `pts` seen by `cams`: a track per visible run, noise σ pixels. */
function tracksOf(cams: Cam[], pts: V3[], sigma: number, seed: number, dist?: Distortion): CameraTracks {
	const rng = new Rng(seed);
	const tracks: CameraTracks['tracks'] = [];
	pts.forEach((x) => {
		let cur: CameraTracks['tracks'][number] | null = null;
		cams.forEach((cam, k) => {
			const p = project(cam, x, dist);
			if (!p) {
				cur = null;
				return;
			}
			if (!cur) {
				cur = { id: tracks.length, start: k, pts: [] };
				tracks.push(cur);
			}
			cur.pts.push([p[0] + sigma * gauss(rng), p[1] + sigma * gauss(rng)]);
		});
	});
	return { size: [W, H], frames: cams.length, factor: 1, detailed: false, tracks };
}

function randomPoints(n: number, seed: number, box: { min: V3; max: V3 }): V3[] {
	const rng = new Rng(seed);
	return Array.from(
		{ length: n },
		() => [0, 1, 2].map((i) => box.min[i]! + (box.max[i]! - box.min[i]!) * rng.unit()) as V3,
	);
}

/** A dolly with a pan: the camera moves sideways and forwards while turning toward a point of interest. */
function movingCamera(n: number, f: (k: number) => number): Cam[] {
	return Array.from({ length: n }, (_, k) => {
		const t = k / (n - 1);
		return lookAt([-2 + 4 * t, -0.5 + 0.3 * t, -1 + 1.2 * t], [0.4 * t, 0, 8], f(k));
	});
}

/** Decode the serialized axis-angle via a unit quaternion, independently of the solver's Rodrigues helpers. */
function rotationMatrix(rot: V3): M3 {
	const theta = Math.hypot(...rot);
	const s = theta === 0 ? 0.5 : Math.sin(theta / 2) / theta;
	const [x, y, z] = rot.map((v) => v * s) as V3;
	const w = Math.cos(theta / 2);
	return [
		[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
		[2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
		[2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
	];
}

/** ||A-B||F = 2√2 sin(θ/2), avoiding the implementation's rotation logarithm and vector norm. */
function rotationDegrees(a: M3, b: M3): number {
	const chord = Math.hypot(...a.flatMap((row, i) => row.map((v, j) => v - b[i]![j]!)));
	return (2 * Math.asin(Math.min(1, chord / (2 * Math.SQRT2))) * 180) / Math.PI;
}

/** Compare both camera paths relative to their first frame, as in the original accuracy metric. */
function rotationError(truth: Cam[], solve: ReturnType<typeof solveCamera>): number {
	const first = rotationMatrix(solve.frames[0]!.rot);
	return Math.max(
		...truth.slice(1).map((cam, index) => {
			const actual = rotationMatrix(solve.frames[index + 1]!.rot).map((row) =>
				first.map((firstRow) => row.reduce((sum, v, j) => sum + v * firstRow[j]!, 0)),
			) as M3;
			const expected = cam.r.map((row) =>
				truth[0]!.r.map((firstRow) => row.reduce((sum, v, j) => sum + v * firstRow[j]!, 0)),
			) as M3;
			return rotationDegrees(actual, expected);
		}),
	);
}

const settings = (s: Partial<SolveSettings> = {}): SolveSettings => ({
	shot: 'fixed',
	hfov: 0,
	method: 'auto',
	deleted: [],
	lensDistortion: false,
	...s,
});

describe('camtrack geometry', () => {
	it('fits a homography with RANSAC despite outliers', () => {
		const rng = new Rng(9);
		const h: M3 = [
			[1.1, 0.05, 20],
			[-0.03, 0.95, -10],
			[1e-4, -5e-5, 1],
		];
		const src: P2[] = Array.from({ length: 80 }, () => [rng.unit() * 600, rng.unit() * 400]);
		const dst = src.map((p, i): P2 => {
			if (i % 5 === 0) return [rng.unit() * 600, rng.unit() * 400];
			const q = mv(h, [p[0], p[1], 1]);
			return [q[0] / q[2], q[1] / q[2]];
		});
		const fit = ransacHomography(src, dst, 1, 400, 4)!;
		expect(fit.inliers.filter(Boolean).length).toBeGreaterThanOrEqual(64);
		const k = h[2][2] / fit.h[2][2];
		for (let i = 0; i < 3; i++)
			for (let j = 0; j < 3; j++) expect(fit.h[i]![j]! * k).toBeCloseTo(h[i]![j]!, 3);
	});
});

describe('camtrack solve (synthetic scenes)', () => {
	const pts3d = randomPoints(260, 11, { min: [-6, -3, 4], max: [6, 3, 16] });

	it('Fixed Angle of View: finds the focal length and the path of a dolly', () => {
		const f = 1372.484429126117 /* 1280 / (2 tan(50° / 2)) */;
		const truth = movingCamera(40, () => f);
		const solve = solveCamera(tracksOf(truth, pts3d, 0.1, 1), settings());
		expect(solve.methodUsed).toBe('typical');
		expect(solve.frames.every((fr) => fr.solved)).toBe(true);
		expect(Math.abs(solveFocal(solve) / f - 1)).toBeLessThan(0.03);
		expect(
			collinearPathError(
				solve.frames.map((fr) => (fr.solved ? fr.center : null)),
				truth.length,
			),
		).toBeLessThan(0.02);
		expect(rotationError(truth, solve)).toBeLessThan(0.3);
		expect(solve.averageError).toBeLessThan(0.5);
		expect(solve.points.length).toBeGreaterThan(150);
	}, 120_000);

	it('Specify Angle of View: uses the given focal length', () => {
		const f = 1758.385548450958 /* 1280 / (2 tan(40° / 2)) */;
		const truth = movingCamera(30, () => f);
		const solve = solveCamera(
			tracksOf(truth, pts3d, 0.1, 2),
			settings({ shot: 'specify', hfov: 40, method: 'typical' }),
		);
		expect(solveFocal(solve)).toBeCloseTo(f, 6);
		expect(
			collinearPathError(
				solve.frames.map((fr) => (fr.solved ? fr.center : null)),
				truth.length,
			),
		).toBeLessThan(0.02);
	}, 120_000);

	it('Variable Zoom: follows a zoom during the move', () => {
		const f0 = 1229.428561261546 /* 1280 / (2 tan(55° / 2)) */;
		const n = 36;
		const zoom = (k: number) => f0 * (1 + (0.3 * k) / (n - 1));
		const truth = movingCamera(n, zoom);
		const solve = solveCamera(tracksOf(truth, pts3d, 0.1, 3), settings({ shot: 'variable' }));
		let worst = 0;
		solve.frames.forEach((fr, k) => {
			if (fr.solved) worst = Math.max(worst, Math.abs(fr.focal / zoom(k) - 1));
		});
		expect(worst).toBeLessThan(0.06);
		expect(
			collinearPathError(
				solve.frames.map((fr) => (fr.solved ? fr.center : null)),
				truth.length,
			),
		).toBeLessThan(0.04);
	}, 180_000);

	it('Auto Detect: a pan from a tripod is solved as a pure rotation', () => {
		const f = 1545.096679918781 /* 1280 / (2 tan(45° / 2)) */;
		const n = 30;
		const truth: Cam[] = Array.from({ length: n }, (_, k) => {
			const a = -0.25 + (0.5 * k) / (n - 1);
			return lookAt([0, 0, 0], [8 * Math.sin(a), 0.4 * Math.sin(2 * a), 8 * Math.cos(a)], f);
		});
		const far = randomPoints(300, 13, { min: [-12, -4, 6], max: [12, 4, 20] });
		const solve = solveCamera(tracksOf(truth, far, 0.1, 4), settings());
		expect(solve.methodUsed).toBe('tripod');
		expect(Math.abs(solveFocal(solve) / f - 1)).toBeLessThan(0.03);
		expect(rotationError(truth, solve)).toBeLessThan(0.3);
		for (const fr of solve.frames) expect(Math.hypot(...fr.center)).toBeLessThan(1e-9);
	}, 120_000);

	it('Auto Detect: a scene of one plane is solved (Flat)', () => {
		const f = 1372.484429126117 /* 1280 / (2 tan(50° / 2)) */;
		const truth = movingCamera(30, () => f);
		const rng = new Rng(17);
		const ground: V3[] = Array.from({ length: 220 }, () => [-8 + 16 * rng.unit(), 1.6, 3 + 14 * rng.unit()]);
		const solve = solveCamera(tracksOf(truth, ground, 0.1, 5), settings({ shot: 'specify', hfov: 50 }));
		expect(solve.methodUsed).toBe('flat');
		expect(
			collinearPathError(
				solve.frames.map((fr) => (fr.solved ? fr.center : null)),
				truth.length,
			),
		).toBeLessThan(0.03);
	}, 120_000);

	it('solves radial lens distortion', () => {
		const f = 1108.512516844082 /* 1280 / (2 tan(60° / 2)) */;
		const truth = movingCamera(30, () => f);
		const dist: Distortion = { k1: -0.06, k2: 0, radius: 0.5 * Math.hypot(W, H) };
		const solve = solveCamera(tracksOf(truth, pts3d, 0.1, 6, dist), settings({ lensDistortion: true }));
		expect(solve.distortion).not.toBeNull();
		expect(solve.distortion!.k1).toBeGreaterThan(-0.09);
		expect(solve.distortion!.k1).toBeLessThan(-0.03);
		expect(Math.abs(solveFocal(solve) / f - 1)).toBeLessThan(0.05);
		expect(solve.averageError).toBeLessThan(0.5);
	}, 240_000);

	it('can be cancelled', () => {
		const truth = movingCamera(20, () => 900);
		const ac = new AbortController();
		ac.abort();
		expect(() => solveCamera(tracksOf(truth, pts3d, 0.1, 7), settings(), { signal: ac.signal })).toThrow(
			/cancelled/,
		);
	});

	it('refuses clips without features', () => {
		expect(() =>
			solveCamera({ size: [W, H], frames: 10, factor: 1, detailed: false, tracks: [] }, settings()),
		).toThrow(/not enough features/);
	});
});
