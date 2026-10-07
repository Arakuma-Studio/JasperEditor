// The camera solve pipeline of the 3D Camera Tracker. Port of EffectCraft `crates/track/src/camtrack/solver.rs`
// (MIT OR Apache-2.0; licenses/ported/three-d.md):
// 1. keyframes by parallax; 2. a two-view initialisation from the essential matrix (8-point RANSAC) or, for mostly
// flat scenes, a homography decomposition; incremental registration (resection) and triangulation of the other
// keyframes; sparse Levenberg–Marquardt bundle adjustment; the frames between keyframes resected last; inlier
// thresholds re-estimated from the residuals; 3. focal length: fixed (Specify Angle of View), searched (log scan +
// golden section) and adjusted as one shared parameter (Fixed Angle of View), or per frame with a smoothness prior
// (Variable Zoom); 4. tripod pans solved as pure rotations; Auto Detect keeps the tripod model when it explains the
// tracks as well; 5. radial lens distortion (k1, k2) solved jointly, then the solve repeated on undistorted tracks.
import { adjust, type BaCam, type BaObs, type BaOpts, cloneCam, type FocalMode, residual } from './bundle.ts';
import {
	decomposeEssential,
	decomposeHomography,
	type Pose,
	poseFromRt,
	poseIdentity,
	procrustes,
	ransacEssential,
	ransacHomography,
	rayAngle,
	reproj2,
	selectPose,
	triangulate,
} from './geometry.ts';
import {
	add,
	logRot,
	type M3,
	mm,
	mt,
	mtv,
	mv,
	norm,
	normalize,
	rodrigues,
	scale,
	slerpRot,
	sub,
	symEigen,
	type V3,
} from './linalg.ts';
import {
	type CameraSolve,
	type CameraTracks,
	type Distortion,
	distortionFor,
	NO_DISTORTION,
	type SolvedFrame,
	type SolvedPoint,
	SolveError,
	type SolveMethod,
	type SolveSettings,
	undistort,
} from './types.ts';

type P2 = [number, number];

/** Tracks in solver form: pixels relative to the principal point. */
class Data {
	readonly n: number;
	readonly w: number;
	/** (track id, first frame, positions). */
	readonly tracks: { id: number; start: number; pts: P2[] }[] = [];
	/** Per frame: (track index, position). */
	readonly byFrame: [number, P2][][];
	noise: number;
	constructor(t: CameraTracks, deleted: readonly number[]) {
		this.n = t.frames;
		this.w = t.size[0];
		const c: P2 = [t.size[0] * 0.5, t.size[1] * 0.5];
		const del = new Set(deleted);
		this.byFrame = Array.from({ length: this.n }, () => []);
		for (const tr of t.tracks) {
			if (del.has(tr.id) || tr.pts.length < 3) continue;
			const ti = this.tracks.length;
			const pts = tr.pts.map((p) => [p[0] - c[0], p[1] - c[1]] as P2);
			pts.forEach((p, k) => {
				const f = tr.start + k;
				if (f >= 0 && f < this.n) this.byFrame[f]!.push([ti, p]);
			});
			this.tracks.push({ id: tr.id, start: tr.start, pts });
		}
		this.noise = Math.max(0.5, 0.5 * t.factor);
	}
	at(ti: number, k: number): P2 | null {
		const t = this.tracks[ti]!;
		const i = k - t.start;
		return i >= 0 && i < t.pts.length ? t.pts[i]! : null;
	}
	inlierThr() {
		return 4 * this.noise;
	}
	huber() {
		return this.noise;
	}
}

/** Keyframes by parallax (1.5 % of the width), survival (< 70 %), 12 frames, or < 24 shared features. */
function keyframes(d: Data): number[] {
	let first = -1;
	for (let k = 0; k < d.n; k++)
		if (d.byFrame[k]!.length >= 8) {
			first = k;
			break;
		}
	if (first < 0) return [];
	const kf = [first];
	let last = first;
	let j = first + 1;
	while (j < d.n) {
		const base = d.byFrame[last]!;
		const disp: number[] = [];
		for (const [ti, p] of base) {
			const q = d.at(ti, j);
			if (q) disp.push(Math.hypot(q[0] - p[0], q[1] - p[1]));
		}
		if (disp.length < 24 && j > last + 1) {
			last = j - 1;
			kf.push(last);
			continue;
		}
		disp.sort((a, b) => a - b);
		const med = disp[disp.length >> 1] ?? 0;
		const ratio = disp.length / Math.max(1, base.length);
		if (med > 0.015 * d.w || ratio < 0.7 || disp.length < 24 || j - last >= 12) {
			last = j;
			kf.push(j);
		}
		j++;
	}
	for (let k = d.n - 1; k >= 0; k--)
		if (d.byFrame[k]!.length >= 8) {
			if (kf[kf.length - 1]! < k) kf.push(k);
			break;
		}
	return kf;
}

type Kind = 'general' | 'tripod';
type Cfg = { kind: Kind; perFrameF: boolean; distortion: boolean };
const F_PRIOR = 30;
const okey = (ti: number, k: number) => ti * 1_000_000 + k;

/** A (partial) reconstruction. */
class Recon {
	cams = new Map<number, BaCam>();
	pts = new Map<number, V3>();
	outliers = new Set<number>();

	clone(): Recon {
		const r = new Recon();
		for (const [k, c] of this.cams) r.cams.set(k, cloneCam(c));
		for (const [k, p] of this.pts) r.pts.set(k, [...p] as V3);
		for (const o of this.outliers) r.outliers.add(o);
		return r;
	}
	frames(): number[] {
		return [...this.cams.keys()].sort((a, b) => a - b);
	}
	observations(d: Data, frames: number[]): { cams: BaCam[]; pts: V3[]; obs: BaObs[]; ids: number[] } {
		const cams = frames.map((k) => cloneCam(this.cams.get(k)!));
		const pidx = new Map<number, number>();
		const pts: V3[] = [];
		const ids: number[] = [];
		const obs: BaObs[] = [];
		frames.forEach((k, ci) => {
			for (const [ti, uv] of d.byFrame[k]!) {
				const x = this.pts.get(ti);
				if (!x || this.outliers.has(okey(ti, k))) continue;
				let pi = pidx.get(ti);
				if (pi === undefined) {
					pi = pts.length;
					pidx.set(ti, pi);
					pts.push([...x] as V3);
					ids.push(ti);
				}
				obs.push({ cam: ci, pt: pi, uv });
			}
		});
		return { cams, pts, obs, ids };
	}
	adjust(d: Data, frames: number[], cfg: Cfg, focal: FocalMode, iters: number): number {
		const { cams, pts, obs, ids } = this.observations(d, frames);
		if (obs.length === 0) return Number.POSITIVE_INFINITY;
		const fixed = new Array<boolean>(cams.length).fill(false);
		fixed[0] = true;
		const rep = adjust(cams, pts, obs, {
			focal,
			fixPoints: false,
			fixCenters: cfg.kind === 'tripod',
			fixed,
			huber: d.huber(),
			maxIter: iters,
			distortion: cfg.distortion,
		});
		frames.forEach((k, i) => this.cams.set(k, cams[i]!));
		ids.forEach((ti, i) => this.pts.set(ti, pts[i]!));
		return rep.cost;
	}
	reject(d: Data): void {
		const thr2 = d.inlierThr() ** 2;
		const count = new Map<number, number>();
		for (const [k, c] of this.cams)
			for (const [ti, uv] of d.byFrame[k]!) {
				const x = this.pts.get(ti);
				if (!x || this.outliers.has(okey(ti, k))) continue;
				const r = residual(c, x, uv);
				if (r && r[0] * r[0] + r[1] * r[1] <= thr2) count.set(ti, (count.get(ti) ?? 0) + 1);
				else this.outliers.add(okey(ti, k));
			}
		for (const ti of [...this.pts.keys()]) if ((count.get(ti) ?? 0) < 2) this.pts.delete(ti);
	}
	triangulate(d: Data, kind: Kind, minAngleDeg: number, check: number): void {
		const seen = new Map<number, number[]>();
		for (const k of this.frames())
			for (const [ti] of d.byFrame[k]!)
				if (!this.pts.has(ti)) {
					const l = seen.get(ti);
					if (l) l.push(k);
					else seen.set(ti, [k]);
				}
		const thr2 = (d.inlierThr() * check) ** 2;
		for (const [ti, ks] of seen) {
			if (ks.length < 2) continue;
			const views: { pose: Pose; x: P2; c: BaCam; k: number }[] = [];
			let okv = true;
			for (const k of ks) {
				const c = this.cams.get(k)!;
				const uv = d.at(ti, k);
				if (!uv) {
					okv = false;
					break;
				}
				views.push({ pose: c.pose, x: [uv[0] / c.f, uv[1] / c.f], c, k });
			}
			if (!okv) continue;
			let x: V3 | null;
			if (kind === 'tripod') {
				let s: V3 = [0, 0, 0];
				for (const v of views) s = add(s, normalize(mtv(v.pose.r, [v.x[0], v.x[1], 1])));
				x = normalize(s);
			} else {
				x = triangulate(views.map((v) => ({ pose: v.pose, x: v.x })));
				if (!x) continue;
				const a = views[0]!.pose.c;
				const b = views[views.length - 1]!.pose.c;
				if ((rayAngle(a, b, x) * 180) / Math.PI < minAngleDeg) continue;
			}
			let good = true;
			for (const v of views) {
				const uv = d.at(ti, v.k)!;
				const r = residual(v.c, x, uv);
				if (!r || r[0] * r[0] + r[1] * r[1] > thr2) {
					good = false;
					break;
				}
			}
			if (good) this.pts.set(ti, x);
		}
	}
	/** Resect frame `k` from the existing points starting at `init`. */
	register(d: Data, k: number, init: BaCam, cfg: Cfg): boolean {
		const pts: V3[] = [];
		const obs: BaObs[] = [];
		const ids: number[] = [];
		for (const [ti, uv] of d.byFrame[k]!) {
			const x = this.pts.get(ti);
			if (x) {
				obs.push({ cam: 0, pt: pts.length, uv });
				pts.push(x);
				ids.push(ti);
			}
		}
		if (obs.length < 6) return false;
		const thr2 = d.inlierThr() ** 2;
		const opts = (huber: number): BaOpts => ({
			focal: cfg.perFrameF ? { kind: 'perCamera', prior: 0 } : { kind: 'fixed' },
			fixPoints: true,
			fixCenters: cfg.kind === 'tripod',
			fixed: [false],
			huber,
			maxIter: 40,
			distortion: false,
		});
		const inl = (c: BaCam, list: BaObs[]) =>
			list.filter((o) => {
				const r = residual(c, pts[o.pt]!, o.uv);
				return !!r && r[0] * r[0] + r[1] * r[1] <= thr2;
			});
		let best: { n: number; cam: BaCam } | null = null;
		let nearest: BaCam | null = null;
		let nd = Number.POSITIVE_INFINITY;
		for (const [kk, c] of this.cams)
			if (Math.abs(kk - k) < nd) {
				nd = Math.abs(kk - k);
				nearest = c;
			}
		for (const start of [init, ...(nearest ? [nearest] : [])]) {
			if (best && best.n >= 0.8 * obs.length) break;
			const cams = [cloneCam(start)];
			adjust(cams, pts.map((p) => [...p] as V3), obs, opts(d.inlierThr() * 4));
			adjust(cams, pts.map((p) => [...p] as V3), obs, opts(d.huber()));
			const n = inl(cams[0]!, obs).length;
			if (!best || n > best.n) best = { n, cam: cams[0]! };
		}
		if (!best || best.n < 6 || best.n < 0.5 * obs.length) return false;
		const keep = inl(best.cam, obs);
		const cams = [cloneCam(best.cam)];
		adjust(cams, pts.map((p) => [...p] as V3), keep, opts(d.huber()));
		const kept = new Set(inl(cams[0]!, obs));
		for (const o of obs) if (!kept.has(o)) this.outliers.add(okey(ids[o.pt]!, k));
		this.cams.set(k, cams[0]!);
		return true;
	}
	/** Mean reprojection error truncated at the inlier threshold (a missing point counts as the threshold). */
	score(d: Data): number {
		const thr = d.inlierThr();
		let s = 0;
		let n = 0;
		for (const [k, c] of this.cams)
			for (const [ti, uv] of d.byFrame[k]!) {
				n++;
				const x = this.pts.get(ti);
				const r = x ? residual(c, x, uv) : null;
				s += r ? Math.min(thr, Math.hypot(r[0], r[1])) : thr;
			}
		return n > 0 ? s / n : Number.POSITIVE_INFINITY;
	}
	error(d: Data): { err: number; n: number } {
		let s = 0;
		let n = 0;
		for (const [k, c] of this.cams)
			for (const [ti, uv] of d.byFrame[k]!) {
				const x = this.pts.get(ti);
				if (!x || this.outliers.has(okey(ti, k))) continue;
				const r = residual(c, x, uv);
				if (r) {
					s += Math.hypot(r[0], r[1]);
					n++;
				}
			}
		return { err: n > 0 ? s / n : Number.POSITIVE_INFINITY, n };
	}
}

/** Starting camera for frame `k` from the registered ones (interpolated / extrapolated). */
function predict(r: Recon, k: number): BaCam | null {
	const keys = r.frames();
	const before = keys.filter((x) => x < k);
	const after = keys.filter((x) => x > k);
	const ka = before[before.length - 1];
	const kb = after[0];
	if (ka !== undefined && kb !== undefined) {
		const a = r.cams.get(ka)!;
		const b = r.cams.get(kb)!;
		const t = (k - ka) / (kb - ka);
		return {
			pose: { r: slerpRot(a.pose.r, b.pose.r, t), c: add(scale(a.pose.c, 1 - t), scale(b.pose.c, t)) },
			f: a.f * (b.f / a.f) ** t,
			dist: { ...a.dist },
		};
	}
	if (ka !== undefined) {
		const a = r.cams.get(ka)!;
		const kp = before[before.length - 2];
		if (kp === undefined) return cloneCam(a);
		const p = r.cams.get(kp)!;
		const t = Math.min(2, (k - ka) / (ka - kp));
		const dr = logRot(mm(a.pose.r, mt(p.pose.r)));
		return {
			pose: { r: mm(rodrigues(scale(dr, t)), a.pose.r), c: add(a.pose.c, scale(sub(a.pose.c, p.pose.c), t)) },
			f: a.f,
			dist: { ...a.dist },
		};
	}
	if (kb !== undefined) {
		const b = r.cams.get(kb)!;
		const kn = after[1];
		if (kn === undefined) return cloneCam(b);
		const nx = r.cams.get(kn)!;
		const t = Math.min(2, (kb - k) / (kn - kb));
		const dr = logRot(mm(b.pose.r, mt(nx.pose.r)));
		return {
			pose: { r: mm(rodrigues(scale(dr, t)), b.pose.r), c: add(b.pose.c, scale(sub(b.pose.c, nx.pose.c), t)) },
			f: b.f,
			dist: { ...b.dist },
		};
	}
	return null;
}

function shared(d: Data, a: number, b: number): [number, P2, P2][] {
	const out: [number, P2, P2][] = [];
	for (const [ti, p] of d.byFrame[a]!) {
		const q = d.at(ti, b);
		if (q) out.push([ti, p, q]);
	}
	return out;
}

type Init = { pose: Pose; pts: Map<number, V3> };

/** Two-view initialisations of frames a, b at focal length f. */
function initPair(d: Data, a: number, b: number, f: number, useE: boolean, useH: boolean): Init[] {
	const sh = shared(d, a, b);
	if (sh.length < 12) return [];
	const x1 = sh.map((s) => [s[1][0] / f, s[1][1] / f] as P2);
	const x2 = sh.map((s) => [s[2][0] / f, s[2][1] / f] as P2);
	const thr = (2 * d.noise) / f;
	const cands: Pose[] = [];
	if (useE) {
		const r = ransacEssential(x1, x2, thr, 400, a * 7919 + b);
		if (r) {
			const p1 = x1.filter((_, i) => r.inliers[i]);
			const p2 = x2.filter((_, i) => r.inliers[i]);
			const sel = selectPose(decomposeEssential(r.e), p1, p2);
			if (sel) cands.push(sel.pose);
		}
	}
	if (useH) {
		const fit = ransacHomography(
			sh.map((s) => s[1]),
			sh.map((s) => s[2]),
			2 * d.noise,
			500,
			a * 31 + b,
		);
		if (fit) {
			const h = fit.h;
			const hn: M3 = [
				[h[0][0], h[0][1], h[0][2] / f],
				[h[1][0], h[1][1], h[1][2] / f],
				[h[2][0] * f, h[2][1] * f, h[2][2]],
			];
			const p1 = x1.filter((_, i) => fit.inliers[i]);
			const p2 = x2.filter((_, i) => fit.inliers[i]);
			for (const s of decomposeHomography(hn, p1, p2)) if (norm(s.t) > 1e-6) cands.push(poseFromRt(s.r, normalize(s.t)));
		}
	}
	const thr2 = (d.inlierThr() / f) ** 2;
	const out: Init[] = [];
	for (const pose of cands) {
		const pts = new Map<number, V3>();
		sh.forEach((s, i) => {
			const x = triangulate([
				{ pose: poseIdentity(), x: x1[i]! },
				{ pose, x: x2[i]! },
			]);
			if (!x) return;
			const e1 = reproj2(poseIdentity(), x, x1[i]!);
			const e2 = reproj2(pose, x, x2[i]!);
			if (e1 !== null && e1 < thr2 && e2 !== null && e2 < thr2 && (rayAngle([0, 0, 0], pose.c, x) * 180) / Math.PI > 0.3)
				pts.set(s[0], x);
		});
		if (pts.size >= 10 && pts.size * 3 >= sh.length) out.push({ pose, pts });
	}
	return out;
}

const focalMode = (cfg: Cfg, frames: number): FocalMode =>
	cfg.perFrameF && frames > 2 ? { kind: 'perCamera', prior: F_PRIOR } : { kind: 'fixed' };

/** Grows a reconstruction over keyframes from the initial pair (kfs[0], kfs[j]). */
function grow(d: Data, kfs: number[], j: number, init: Init, f: number, cfg: Cfg, cancelled: () => boolean): Recon | null {
	const a = kfs[0]!;
	const b = kfs[j]!;
	const r = new Recon();
	r.cams.set(a, { pose: poseIdentity(), f, dist: { ...NO_DISTORTION } });
	r.cams.set(b, { pose: { r: init.pose.r, c: init.pose.c }, f, dist: { ...NO_DISTORTION } });
	for (const [k, x] of init.pts) r.pts.set(k, [...x] as V3);
	const inner = (frames: number[]) => {
		r.adjust(d, frames, cfg, focalMode(cfg, frames.length), 10);
		r.reject(d);
	};
	inner([a, b]);
	const order = [...kfs.slice(1, j), ...kfs.slice(j + 1)];
	let done = 0;
	for (const k of order) {
		if (cancelled()) return null;
		const start = predict(r, k);
		if (!start) return null;
		if (!r.register(d, k, start, cfg)) break;
		r.triangulate(d, cfg.kind, 1, 1);
		done++;
		const frames = r.frames();
		if (done % 3 === 0 || frames.length <= 6) inner(frames);
	}
	inner(r.frames());
	return r.cams.size >= 2 && r.pts.size >= 8 ? r : null;
}

/** Tripod reconstruction over keyframes at focal length f. */
function growTripod(d: Data, kfs: number[], f: number, cfg: Cfg, cancelled: () => boolean): Recon | null {
	const r = new Recon();
	r.cams.set(kfs[0]!, { pose: poseIdentity(), f, dist: { ...NO_DISTORTION } });
	const ray = (p: P2): V3 => normalize([p[0] / f, p[1] / f, 1]);
	for (let i = 0; i + 1 < kfs.length; i++) {
		if (cancelled()) return null;
		const a = kfs[i]!;
		const b = kfs[i + 1]!;
		const sh = shared(d, a, b);
		if (sh.length < 6) break;
		const ra = sh.map((s) => ray(s[1]));
		const rb = sh.map((s) => ray(s[2]));
		let rel = procrustes(ra, rb);
		if (!rel) return null;
		const errs = ra.map((x, k) => norm(sub(rb[k]!, mv(rel!, x))));
		const sorted = [...errs].sort((x, y) => x - y);
		const lim = Math.max(sorted[sorted.length >> 1]! * 3, d.inlierThr() / f);
		const ia = ra.filter((_, k) => errs[k]! <= lim);
		const ib = rb.filter((_, k) => errs[k]! <= lim);
		if (ia.length >= 4) rel = procrustes(ia, ib) ?? rel;
		const pa = r.cams.get(a)!.pose.r;
		r.cams.set(b, { pose: { r: mm(rel, pa), c: [0, 0, 0] }, f, dist: { ...NO_DISTORTION } });
	}
	r.triangulate(d, 'tripod', 0, 20);
	const frames = r.frames();
	const focal = focalMode(cfg, frames.length);
	r.adjust(d, frames, cfg, focal, 15);
	r.reject(d);
	r.triangulate(d, 'tripod', 0, 1);
	r.adjust(d, frames, cfg, focal, 15);
	return r.cams.size >= 2 && r.pts.size >= 8 ? r : null;
}

/** Focal length (pixels) of a horizontal angle of view. */
export const focalOf = (w: number, hfov: number) =>
	(w * 0.5) / Math.tan(((Math.min(170, Math.max(1, hfov)) * Math.PI) / 180) * 0.5);

type Attempt = { recon: Recon; err: number; method: Exclude<SolveMethod, 'auto'> };

function bestInit(d: Data, kfs: number[], f: number, method: SolveMethod): { j: number; init: Init; isH: boolean } | null {
	const useE = method !== 'flat';
	const useH = method !== 'typical';
	let best: { score: number; j: number; init: Init; isH: boolean } | null = null;
	for (let j = 1; j < Math.min(kfs.length, 6); j++) {
		const cands = [
			...(useE ? initPair(d, kfs[0]!, kfs[j]!, f, true, false).map((c) => ({ c, isH: false })) : []),
			...(useH ? initPair(d, kfs[0]!, kfs[j]!, f, false, true).map((c) => ({ c, isH: true })) : []),
		];
		for (const { c, isH } of cands) {
			const ang = [...c.pts.values()].map((x) => (rayAngle([0, 0, 0], c.pose.c, x) * 180) / Math.PI).sort((a, b) => a - b);
			const med = ang[ang.length >> 1] ?? 0;
			const score = c.pts.size * Math.min(4, med);
			if (!best || score > best.score) best = { score, j, init: c, isH };
		}
	}
	return best ? { j: best.j, init: best.init, isH: best.isH } : null;
}

function initCandidates(d: Data, kfs: number[], f: number, method: SolveMethod) {
	const first = bestInit(d, kfs, f, method);
	if (!first) return [];
	const out = [first];
	if (method === 'auto' || method === 'flat')
		for (const c of initPair(d, kfs[0]!, kfs[first.j]!, f, false, true))
			if (out.every((o) => norm(logRot(mm(o.init.pose.r, mt(c.pose.r)))) > 1e-3 || norm(sub(o.init.pose.c, c.pose.c)) > 1e-3))
				out.push({ j: first.j, init: c, isH: true });
	return out;
}

function general(d: Data, kfs: number[], f: number, method: SolveMethod, cfg: Cfg, cancelled: () => boolean): Attempt | null {
	let best: Attempt | null = null;
	for (const { j, init, isH } of initCandidates(d, kfs, f, method)) {
		const r = grow(d, kfs, j, init, f, cfg, cancelled);
		if (!r) continue;
		if (r.error(d).n === 0) continue;
		const cover = r.cams.size / kfs.length;
		const a: Attempt = { recon: r, err: r.score(d) / Math.max(0.05, cover), method: isH ? 'flat' : 'typical' };
		if (!best || a.err < best.err) best = a;
	}
	return best;
}

function tripod(d: Data, kfs: number[], f: number, cfg: Cfg, cancelled: () => boolean): Attempt | null {
	const r = growTripod(d, kfs, f, cfg, cancelled);
	if (!r) return null;
	const cover = r.cams.size / kfs.length;
	return { recon: r, err: r.score(d) / Math.max(0.05, cover), method: 'tripod' };
}

/** The focal length minimising `evaluate(f)`: a log-spaced angle-of-view scan, then golden-section refinement. */
function searchFocal(w: number, evaluate: (f: number) => number): number {
	const fovs = [8, 12, 16, 20, 25, 30, 36, 43, 51, 60, 70, 82, 96, 112];
	const fs = fovs.map((a) => focalOf(w, a));
	const errs = fs.map((f) => evaluate(f));
	let i = 5;
	for (let k = 0; k < fs.length; k++) if (errs[k]! < errs[i]!) i = k;
	let lo = Math.log(fs[Math.min(fs.length - 1, i + 1)]!);
	let hi = Math.log(fs[Math.max(0, i - 1)]!);
	if (lo > hi) [lo, hi] = [hi, lo];
	const g = 0.61803398875;
	let x1 = hi - g * (hi - lo);
	let x2 = lo + g * (hi - lo);
	let e1 = evaluate(Math.exp(x1));
	let e2 = evaluate(Math.exp(x2));
	for (let k = 0; k < 7; k++) {
		if (e1 < e2) {
			hi = x2;
			x2 = x1;
			e2 = e1;
			x1 = hi - g * (hi - lo);
			e1 = evaluate(Math.exp(x1));
		} else {
			lo = x1;
			x1 = x2;
			e1 = e2;
			x2 = lo + g * (hi - lo);
			e2 = evaluate(Math.exp(x2));
		}
	}
	const best = e1 < e2 ? { x: x1, e: e1 } : { x: x2, e: e2 };
	return best.e <= errs[i]! ? Math.exp(best.x) : fs[i]!;
}

type Core = { d: Data; r: Recon; method: Exclude<SolveMethod, 'auto'>; kind: Kind; cfg: Cfg; focal: FocalMode; kfs: number[] };

function undistortedTracks(t: CameraTracks, dist: Distortion): CameraTracks {
	const c: P2 = [t.size[0] * 0.5, t.size[1] * 0.5];
	return {
		...t,
		tracks: t.tracks.map((tr) => ({
			...tr,
			pts: tr.pts.map((p) => {
				const q = undistort(dist, [p[0] - c[0], p[1] - c[1]]);
				return [q[0] + c[0], q[1] + c[1]] as P2;
			}),
		})),
	};
}

export type SolveProgress = (fraction: number, stage: string) => void;

/** Solves the camera of a tracked clip. Throws `SolveError` when it cannot. */
export function solveCamera(
	tracks: CameraTracks,
	s: SolveSettings,
	opts: { signal?: AbortSignal; onProgress?: SolveProgress } = {},
): CameraSolve {
	const cancelled = () => !!opts.signal?.aborted;
	const progress = opts.onProgress ?? (() => {});
	if (!s.lensDistortion) {
		const c = solveCore(tracks, s, cancelled, (f, st) => progress(f, st));
		return finish(c.d, tracks, s, c.r, c.method, c.kind);
	}
	let dist = distortionFor(tracks.size);
	let out: CameraSolve | null = null;
	for (let pass = 0; pass < 2; pass++) {
		const c = solveCore(pass > 0 ? undistortedTracks(tracks, dist) : tracks, s, cancelled, (f, st) =>
			progress(pass * 0.5 + f * 0.45, st),
		);
		const d = new Data(tracks, s.deleted);
		d.noise = c.d.noise;
		const r = c.r;
		for (const cam of r.cams.values()) cam.dist = { ...dist };
		const cfg: Cfg = { ...c.cfg, distortion: true };
		const all = r.frames();
		const frames = all.length <= 160 ? all : c.kfs.filter((k) => r.cams.has(k));
		if (frames.length < 2) throw new SolveError('the camera could not be solved (not enough parallax or features)');
		r.outliers.clear();
		r.adjust(d, frames, cfg, c.focal, 30);
		r.outliers.clear();
		r.reject(d);
		r.adjust(d, frames, cfg, c.focal, 30);
		dist = { ...r.cams.get(frames[0]!)!.dist };
		for (const cam of r.cams.values()) cam.dist = { ...dist };
		if (frames.length < all.length) {
			const base = r.clone();
			const rcfg: Cfg = { ...cfg, distortion: false };
			for (const k of all) {
				if (frames.includes(k)) continue;
				const local = base.clone();
				local.outliers.clear();
				const ok = local.register(d, k, local.cams.get(k)!, rcfg);
				if (ok) r.cams.set(k, local.cams.get(k)!);
			}
			r.reject(d);
		}
		if (cancelled()) throw new SolveError('cancelled');
		out = { ...finish(d, tracks, s, r, c.method, c.kind), distortion: dist };
	}
	if (!out) throw new SolveError('the camera could not be solved');
	return out;
}

function solveCore(tracks: CameraTracks, s: SolveSettings, isCancelled: () => boolean, progress: SolveProgress): Core {
	const cancelled = () => {
		if (isCancelled()) throw new SolveError('cancelled');
		return false;
	};
	cancelled();
	const d = new Data(tracks, s.deleted);
	if (d.n < 2) throw new SolveError('the clip must be at least two frames long');
	const kfs = keyframes(d);
	if (kfs.length < 2) throw new SolveError('not enough features were tracked to solve the camera');
	const fixedF = s.shot === 'specify' ? focalOf(d.w, s.hfov > 0 ? s.hfov : 40) : null;
	const variable = s.shot === 'variable';
	const gcfg: Cfg = { kind: 'general', perFrameF: variable, distortion: false };
	const tcfg: Cfg = { ...gcfg, kind: 'tripod' };
	const mini = kfs.slice(0, 10);
	const tryGeneral = s.method !== 'tripod';
	const tryTripod = s.method === 'auto' || s.method === 'tripod';
	const results: { a: Attempt; f: number }[] = [];
	progress(0.05, 'Solving camera (general)');
	if (tryGeneral) {
		const f =
			fixedF ?? searchFocal(d.w, (f) => general(d, mini, f, s.method, gcfg, cancelled)?.err ?? Number.POSITIVE_INFINITY);
		if (cancelled()) throw new SolveError('cancelled');
		const a = general(d, kfs, f, s.method, gcfg, cancelled);
		if (a) results.push({ a, f });
	}
	progress(0.35, 'Solving camera (tripod check)');
	let tripodPlausible = true;
	if (s.method === 'auto' && results[0]) {
		const quick = tripod(d, mini, results[0].f, { ...tcfg, perFrameF: false }, cancelled)?.err ?? Number.POSITIVE_INFINITY;
		tripodPlausible = quick <= 3 * results[0].a.err + d.noise;
	}
	if (tryTripod && tripodPlausible && !cancelled()) {
		const f = fixedF ?? searchFocal(d.w, (f) => tripod(d, mini, f, tcfg, cancelled)?.err ?? Number.POSITIVE_INFINITY);
		const a = tripod(d, kfs, f, tcfg, cancelled);
		if (a) results.push({ a, f });
	}
	if (cancelled()) throw new SolveError('cancelled');
	const gi = results.findIndex((r) => r.a.method !== 'tripod');
	const ti = results.findIndex((r) => r.a.method === 'tripod');
	let pick: number;
	if (gi >= 0 && ti >= 0) {
		const eg = results[gi]!.a.err;
		const et = results[ti]!.a.err;
		const rg = results[gi]!.a.recon;
		const cs = [...rg.cams.values()].map((c) => c.pose.c);
		let base = 0;
		for (const a of cs) for (const b of cs) base = Math.max(base, norm(sub(a, b)));
		const c0 = rg.cams.get(rg.frames()[0]!)?.pose.c ?? ([0, 0, 0] as V3);
		const depth = [...rg.pts.values()].map((x) => norm(sub(x, c0))).sort((a, b) => a - b);
		const med = depth[depth.length >> 1] ?? 1;
		pick = et <= Math.max(eg * 1.25, eg + 0.05 * d.noise) || base / med < 0.01 ? ti : gi;
	} else if (gi >= 0) pick = gi;
	else if (ti >= 0) pick = ti;
	else throw new SolveError('the camera could not be solved (not enough parallax or features)');
	const att = results[pick]!.a;
	const kind: Kind = att.method === 'tripod' ? 'tripod' : 'general';
	const cfg: Cfg = { kind, perFrameF: variable, distortion: false };
	const r = att.recon;
	const focal: FocalMode = fixedF !== null ? { kind: 'fixed' } : variable ? { kind: 'perCamera', prior: F_PRIOR } : { kind: 'shared' };
	progress(0.55, 'Adjusting keyframes');
	const kfFrames = r.frames();
	r.adjust(d, kfFrames, cfg, focal, 40);
	r.reject(d);
	const res: number[] = [];
	for (const [k, c] of r.cams)
		for (const [ti2, uv] of d.byFrame[k]!) {
			if (r.outliers.has(okey(ti2, k))) continue;
			const x = r.pts.get(ti2);
			const e = x ? residual(c, x, uv) : null;
			if (e) res.push(Math.hypot(e[0], e[1]));
		}
	if (res.length > 20) {
		res.sort((a, b) => a - b);
		const sigma = res[res.length >> 1]! / 1.1774;
		const floor = 0.05 * Math.max(1, tracks.factor);
		d.noise = Math.min(d.noise, Math.max(floor, 1.5 * sigma));
		r.outliers.clear();
		r.reject(d);
	}
	r.triangulate(d, kind, 1, 1);
	r.adjust(d, kfFrames, cfg, focal, 40);
	r.reject(d);
	r.adjust(d, kfFrames, cfg, focal, 20);
	if (cancelled()) throw new SolveError('cancelled');
	progress(0.75, 'Solving every frame');
	const todo = [...Array(d.n).keys()].filter((k) => !r.cams.has(k));
	const base = r.clone();
	const keys = base.frames();
	const dist = (k: number) => keys.reduce((m, c) => Math.min(m, Math.abs(c - k)), Number.POSITIVE_INFINITY);
	todo.sort((a, b) => dist(a) - dist(b));
	for (const k of todo) {
		if (cancelled()) throw new SolveError('cancelled');
		const local = new Recon();
		local.cams = new Map([...base.cams].map(([kk, c]) => [kk, cloneCam(c)]));
		local.pts = base.pts;
		const start = predict(local, k);
		if (start && local.register(d, k, start, cfg)) r.cams.set(k, local.cams.get(k)!);
	}
	progress(0.9, 'Final adjustment');
	r.triangulate(d, kind, 1, 1);
	const all = r.frames();
	r.reject(d);
	if (all.length <= 160) {
		r.adjust(d, all, cfg, focal, 25);
		r.reject(d);
	} else {
		const b2 = r.clone();
		for (const k of all) {
			if (kfFrames.includes(k)) continue;
			const local = new Recon();
			local.cams = new Map([...b2.cams].map(([kk, c]) => [kk, cloneCam(c)]));
			local.pts = b2.pts;
			if (local.register(d, k, local.cams.get(k)!, cfg)) r.cams.set(k, local.cams.get(k)!);
		}
		r.reject(d);
	}
	let method: Exclude<SolveMethod, 'auto'>;
	if (att.method === 'tripod') method = 'tripod';
	else if (s.method === 'auto') method = covRatio([...r.pts.values()]) < 0.08 ? 'flat' : 'typical';
	else method = s.method === 'tripod' ? 'tripod' : s.method;
	progress(1, 'Solved');
	return { d, r, method, kind, cfg, focal, kfs: kfFrames };
}

/** Thickness of a point cloud: √(smallest / middle eigenvalue of its covariance). */
function covRatio(p: V3[]): number {
	if (p.length < 3) return 1;
	const k = 1 / p.length;
	let c: V3 = [0, 0, 0];
	for (const q of p) c = add(c, q);
	c = scale(c, k);
	const cov = new Float64Array(9);
	for (const q of p) {
		const dd = sub(q, c);
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j]! += dd[i]! * dd[j]! * k;
	}
	const { vals } = symEigen(cov, 3);
	return Math.sqrt(Math.max(0, vals[0]!) / Math.max(1e-300, vals[1]!));
}

/** Canonical frame, per-frame output (unsolved frames interpolated), points and errors. */
function finish(d: Data, tracks: CameraTracks, s: SolveSettings, r: Recon, method: Exclude<SolveMethod, 'auto'>, kind: Kind): CameraSolve {
	const keys = r.frames();
	if (keys.length === 0) throw new SolveError('the camera could not be solved (no frame was solved)');
	const k0 = keys[0]!;
	const c0 = r.cams.get(k0)!;
	const depths = d.byFrame[k0]!.map(([ti]) => r.pts.get(ti))
		.filter((x): x is V3 => !!x)
		.map((x) => mv(c0.pose.r, sub(x, c0.pose.c))[2])
		.filter((z) => z > 0)
		.sort((a, b) => a - b);
	const sc = kind === 'tripod' ? 1 : (depths[depths.length >> 1] ?? 1) > 1e-12 ? (depths[depths.length >> 1] ?? 1) : 1;
	const r0 = c0.pose.r;
	const cc = c0.pose.c;
	const toWorld = (x: V3) => scale(mv(r0, sub(x, cc)), 1 / sc);
	const frames: SolvedFrame[] = Array.from({ length: d.n }, () => ({ rot: [0, 0, 0], center: [0, 0, 0], focal: 0, solved: false }));
	for (const [k, c] of r.cams) frames[k] = { rot: logRot(mm(c.pose.r, mt(r0))), center: toWorld(c.pose.c), focal: c.f, solved: true };
	const solved = [...Array(d.n).keys()].filter((k) => frames[k]!.solved);
	for (let k = 0; k < d.n; k++) {
		if (frames[k]!.solved) continue;
		const a = [...solved].reverse().find((x) => x < k);
		const b = solved.find((x) => x > k);
		if (a !== undefined && b !== undefined) {
			const t = (k - a) / (b - a);
			const fa = frames[a]!;
			const fb = frames[b]!;
			frames[k] = {
				rot: logRot(slerpRot(rodrigues(fa.rot), rodrigues(fb.rot), t)),
				center: add(scale(fa.center, 1 - t), scale(fb.center, t)),
				focal: fa.focal + (fb.focal - fa.focal) * t,
				solved: false,
			};
		} else if (a !== undefined) frames[k] = { ...frames[a]!, solved: false };
		else if (b !== undefined) frames[k] = { ...frames[b]!, solved: false };
	}
	const points: SolvedPoint[] = [];
	let esum = 0;
	let en = 0;
	for (const ti of [...r.pts.keys()].sort((a, b) => a - b)) {
		const x = r.pts.get(ti)!;
		const t = d.tracks[ti]!;
		let s1 = 0;
		let n1 = 0;
		t.pts.forEach((uv, i) => {
			const k = t.start + i;
			if (r.outliers.has(okey(ti, k))) return;
			const c = r.cams.get(k);
			const res = c ? residual(c, x, uv) : null;
			if (res) {
				s1 += Math.hypot(res[0], res[1]);
				n1++;
			}
		});
		if (n1 < 2) continue;
		esum += s1;
		en += n1;
		points.push({ id: t.id, pos: toWorld(x), error: s1 / n1, first: t.start, last: t.start + t.pts.length - 1 });
	}
	return {
		size: tracks.size,
		shot: s.shot,
		methodUsed: method,
		averageError: en > 0 ? esum / en : 0,
		frames,
		points,
		distortion: null,
	};
}

export const _internal = { keyframes, Data };
export type { Pose };
