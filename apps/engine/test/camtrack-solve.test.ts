// Accuracy of the 3D Camera Tracker's solver on synthetic scenes with a known camera path (the solve is compared after
// the best similarity transform, since a monocular solve is only defined up to one).
import { describe, expect, it } from 'vitest';
import { adjust, type BaCam, type BaObs } from '../src/camtrack/core/bundle.ts';
import {
	decomposeEssential,
	essential8pt,
	type P2,
	Rng,
	ransacHomography,
	selectPose,
	triangulate,
} from '../src/camtrack/core/geometry.ts';
import {
	cross,
	logRot,
	type M3,
	mm,
	mt,
	mv,
	norm,
	normalize,
	rodrigues,
	sub,
	umeyama,
	type V3,
} from '../src/camtrack/core/linalg.ts';
import { solveCamera } from '../src/camtrack/core/solver.ts';
import {
	type CameraTracks,
	type Distortion,
	frameR,
	type SolveSettings,
	solveFocal,
} from '../src/camtrack/core/types.ts';

const W = 1280;
const H = 720;

type Cam = { r: M3; c: V3; f: number };

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

/** Position error of the solved path after the best similarity, relative to the path's length. */
function pathError(truth: Cam[], solve: ReturnType<typeof solveCamera>): number {
	const src: V3[] = [];
	const dst: V3[] = [];
	solve.frames.forEach((f, k) => {
		if (!f.solved) return;
		src.push(f.center);
		dst.push(truth[k]!.c);
	});
	const sim = umeyama(src, dst);
	if (!sim) return Number.POSITIVE_INFINITY;
	let worst = 0;
	src.forEach((s, i) => {
		const p: V3 = [0, 1, 2].map((j) => sim.s * mv(sim.r, s)[j]! + sim.t[j]!) as V3;
		worst = Math.max(worst, norm(sub(p, dst[i]!)));
	});
	return worst / norm(sub(truth[truth.length - 1]!.c, truth[0]!.c));
}

/** Largest rotation error (degrees) between consecutive-frame relative rotations of solve and truth. */
function rotationError(truth: Cam[], solve: ReturnType<typeof solveCamera>): number {
	let worst = 0;
	const r0 = frameR(solve.frames[0]!);
	for (let k = 1; k < truth.length; k++) {
		const rs = mm(frameR(solve.frames[k]!), mt(r0));
		const rt = mm(truth[k]!.r, mt(truth[0]!.r));
		worst = Math.max(worst, (norm(logRot(mm(rs, mt(rt)))) * 180) / Math.PI);
	}
	return worst;
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
	it('recovers the relative pose from the essential matrix', () => {
		const pts = randomPoints(60, 3, { min: [-3, -2, 5], max: [3, 2, 10] });
		const a = lookAt([0, 0, 0], [0, 0, 8], 1);
		const b = lookAt([1, 0.2, 0.3], [0.3, 0, 8], 1);
		const n = (cam: Cam, x: V3): P2 => {
			const p = mv(cam.r, sub(x, cam.c));
			return [p[0] / p[2], p[1] / p[2]];
		};
		const x1 = pts.map((x) => n(a, x));
		const x2 = pts.map((x) => n(b, x));
		const e = essential8pt(x1, x2)!;
		const sel = selectPose(decomposeEssential(e), x1, x2)!;
		expect(sel.count).toBe(pts.length);
		const rel = mm(b.r, mt(a.r));
		expect((norm(logRot(mm(sel.pose.r, mt(rel)))) * 180) / Math.PI).toBeLessThan(1e-6);
		const dir = normalize(mv(a.r, sub(b.c, a.c)));
		expect(norm(sub(normalize(sel.pose.c), dir))).toBeLessThan(1e-6);
		const x = triangulate([
			{
				pose: {
					r: [
						[1, 0, 0],
						[0, 1, 0],
						[0, 0, 1],
					],
					c: [0, 0, 0],
				},
				x: x1[0]!,
			},
			{ pose: sel.pose, x: x2[0]! },
		])!;
		expect(x[2]).toBeGreaterThan(0);
	});

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

	it('bundle adjustment converges from a perturbed start', () => {
		const truth = movingCamera(6, () => 900);
		const pts = randomPoints(80, 5, { min: [-3, -2, 5], max: [3, 2, 11] });
		const cams: BaCam[] = truth.map((c, i) => ({
			pose: {
				r: i === 0 ? c.r : mm(rodrigues([0.01, -0.02, 0.01]), c.r),
				c: i === 0 ? c.c : ([c.c[0] + 0.05, c.c[1] - 0.05, c.c[2] + 0.05] as V3),
			},
			f: 900,
			dist: { k1: 0, k2: 0, radius: 0 },
		}));
		const start = pts.map((p) => [p[0] + 0.05, p[1] - 0.05, p[2] + 0.1] as V3);
		const obs: BaObs[] = [];
		truth.forEach((c, ci) => {
			pts.forEach((x, pi) => {
				const p = mv(c.r, sub(x, c.c));
				obs.push({ cam: ci, pt: pi, uv: [(c.f * p[0]) / p[2], (c.f * p[1]) / p[2]] });
			});
		});
		const fixed = truth.map((_, i) => i < 2);
		cams[1] = { pose: { r: truth[1]!.r, c: truth[1]!.c }, f: 900, dist: cams[1]!.dist };
		const rep = adjust(cams, start, obs, {
			focal: { kind: 'fixed' },
			fixPoints: false,
			fixCenters: false,
			fixed,
			huber: 1,
			maxIter: 50,
			distortion: false,
		});
		expect(rep.cost).toBeLessThan(rep.initialCost * 1e-6);
		for (let i = 2; i < truth.length; i++) expect(norm(sub(cams[i]!.pose.c, truth[i]!.c))).toBeLessThan(1e-3);
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
		expect(pathError(truth, solve)).toBeLessThan(0.02);
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
		expect(pathError(truth, solve)).toBeLessThan(0.02);
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
		expect(pathError(truth, solve)).toBeLessThan(0.04);
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
		for (const fr of solve.frames) expect(norm(fr.center)).toBeLessThan(1e-9);
	}, 120_000);

	it('Auto Detect: a scene of one plane is solved (Flat)', () => {
		const f = 1372.484429126117 /* 1280 / (2 tan(50° / 2)) */;
		const truth = movingCamera(30, () => f);
		const rng = new Rng(17);
		const ground: V3[] = Array.from({ length: 220 }, () => [-8 + 16 * rng.unit(), 1.6, 3 + 14 * rng.unit()]);
		const solve = solveCamera(tracksOf(truth, ground, 0.1, 5), settings({ shot: 'specify', hfov: 50 }));
		expect(solve.methodUsed).toBe('flat');
		expect(pathError(truth, solve)).toBeLessThan(0.03);
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
