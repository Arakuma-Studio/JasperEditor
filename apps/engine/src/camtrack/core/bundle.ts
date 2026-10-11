// Sparse bundle adjustment: Levenberg–Marquardt over cameras and points with the Schur complement eliminating the
// points (Triggs, McLauchlan, Hartley & Fitzgibbon, "Bundle Adjustment — A Modern Synthesis", 2000, §6; H&Z
// Appendix 6). Residuals are reprojection errors in pixels with a Huber robust loss (IRLS). Cameras are `(R, C, f)`;
// rotations update multiplicatively (`R ← exp([δ]×) R`), focal lengths in log space. Port of EffectCraft
// `crates/track/src/camtrack/bundle.rs` (MIT OR Apache-2.0).
import type { Pose } from './geometry.ts';
import {
	add,
	choleskySolve,
	dot,
	inv3,
	type M3,
	mm,
	mtv,
	mv,
	rodrigues,
	scale,
	skew,
	sub,
	type V3,
} from './linalg.ts';
import { type Distortion, distort, distortionJacobian } from './types.ts';

export type BaCam = { pose: Pose; f: number; dist: Distortion };
/** Camera `cam` sees point `pt` at `uv` (pixels relative to the principal point). */
export type BaObs = { cam: number; pt: number; uv: [number, number] };
export type FocalMode = { kind: 'fixed' } | { kind: 'shared' } | { kind: 'perCamera'; prior: number };

export type BaOpts = {
	focal: FocalMode;
	fixPoints: boolean;
	fixCenters: boolean;
	/** Cameras held fixed (gauge), by index. */
	fixed: boolean[];
	/** Huber threshold (pixels). */
	huber: number;
	maxIter: number;
	distortion: boolean;
};

const BEHIND = 1e6;
const huberCost = (e2: number, k: number) => (e2 <= k * k ? e2 : 2 * k * Math.sqrt(e2) - k * k);

export function cloneCam(c: BaCam): BaCam {
	return {
		pose: { r: c.pose.r.map((r) => [...r]) as M3, c: [...c.pose.c] as V3 },
		f: c.f,
		dist: { ...c.dist },
	};
}

/** Residual (pixels) of one observation; null behind the camera. */
export function residual(c: BaCam, x: V3, uv: [number, number]): [number, number] | null {
	const p = mv(c.pose.r, sub(x, c.pose.c));
	if (p[2] <= 1e-9) return null;
	const q = distort(c.dist, [(c.f * p[0]) / p[2], (c.f * p[1]) / p[2]]);
	return [q[0] - uv[0], q[1] - uv[1]];
}

function priorCost(cams: BaCam[], o: BaOpts): number {
	if (o.focal.kind !== 'perCamera') return 0;
	let s = 0;
	for (let i = 0; i + 1 < cams.length; i++)
		s += (o.focal.prior * (Math.log(cams[i]!.f) - Math.log(cams[i + 1]!.f))) ** 2;
	return s;
}

/** Total robust cost. */
function baCost(cams: BaCam[], pts: V3[], obs: BaObs[], o: BaOpts): number {
	let c = 0;
	for (const ob of obs) {
		const r = residual(cams[ob.cam]!, pts[ob.pt]!, ob.uv);
		c += r ? huberCost(r[0] * r[0] + r[1] * r[1], o.huber) : BEHIND;
	}
	return c + priorCost(cams, o);
}

type Layout = {
	start: number[];
	fidx: number[];
	shared: number | null;
	dist: number | null;
	n: number;
	rotOnly: boolean;
};

const NONE = -1;

function layout(ncam: number, o: BaOpts): Layout {
	const perCamF = o.focal.kind === 'perCamera';
	const d = o.fixCenters ? 3 : 6;
	const start = new Array<number>(ncam).fill(NONE);
	const fidx = new Array<number>(ncam).fill(NONE);
	let n = 0;
	for (let i = 0; i < ncam; i++) {
		if (!o.fixed[i]) {
			start[i] = n;
			n += d;
		}
		if (perCamF) fidx[i] = n++;
	}
	const shared = o.focal.kind === 'shared' ? n++ : null;
	let dist: number | null = null;
	if (o.distortion) {
		dist = n;
		n += 2;
	}
	return { start, fidx, shared, dist, n, rotOnly: o.fixCenters };
}

type BaReport = { initialCost: number; cost: number; iterations: number };

type PtSys = { v: M3; bp: V3; w: [number, V3][] };

/** Runs Levenberg–Marquardt; `cams` and `pts` are updated in place. */
export function adjust(cams: BaCam[], pts: V3[], obs: BaObs[], o: BaOpts): BaReport {
	const l = layout(cams.length, o);
	const npts = pts.length;
	const byPt: number[][] = Array.from({ length: npts }, () => []);
	obs.forEach((ob, i) => {
		byPt[ob.pt]!.push(i);
	});
	let cur = baCost(cams, pts, obs, o);
	const initial = cur;
	let lambda = 1e-4;
	let iters = 0;
	const n = l.n;
	if (n === 0 && o.fixPoints) return { initialCost: initial, cost: cur, iterations: 0 };
	const jc: [number, [number, number]][] = [];
	for (let it = 0; it < o.maxIter; it++) {
		iters++;
		const S = new Float64Array(n * n);
		const bc = new Float64Array(n);
		const systems: PtSys[] = [];
		for (let j = 0; j < npts; j++) {
			const ps: PtSys = {
				v: [
					[0, 0, 0],
					[0, 0, 0],
					[0, 0, 0],
				],
				bp: [0, 0, 0],
				w: [],
			};
			for (const oi of byPt[j]!) {
				const ob = obs[oi]!;
				const ci = ob.cam;
				const c = cams[ci]!;
				const xc = mv(c.pose.r, sub(pts[j]!, c.pose.c));
				if (xc[2] <= 1e-9) continue;
				const iz = 1 / xc[2];
				const p0: [number, number] = [c.f * xc[0] * iz, c.f * xc[1] * iz];
				const pd = distort(c.dist, p0);
				const r = [pd[0] - ob.uv[0], pd[1] - ob.uv[1]] as const;
				const e = Math.hypot(r[0], r[1]);
				const w = e <= o.huber ? 1 : o.huber / e;
				const a0 = [
					[c.f * iz, 0, -c.f * xc[0] * iz * iz],
					[0, c.f * iz, -c.f * xc[1] * iz * iz],
				];
				const { j: dj, k: dk } = distortionJacobian(c.dist, p0);
				const a: [V3, V3] = [0, 1].map(
					(i) => [0, 1, 2].map((k) => dj[i]![0] * a0[0]![k]! + dj[i]![1] * a0[1]![k]!) as V3,
				) as [V3, V3];
				const p: [number, number] = [
					dj[0][0] * p0[0] + dj[0][1] * p0[1],
					dj[1][0] * p0[0] + dj[1][1] * p0[1],
				];
				// Camera-side Jacobian.
				jc.length = 0;
				const s = l.start[ci]!;
				if (s !== NONE) {
					const sk = skew(xc);
					for (let k = 0; k < 3; k++) {
						const g: V3 = [-sk[0][k], -sk[1][k], -sk[2][k]];
						jc.push([s + k, [dot(a[0], g), dot(a[1], g)]]);
					}
					if (!l.rotOnly)
						for (let k = 0; k < 3; k++) {
							const g: V3 = [-c.pose.r[0][k], -c.pose.r[1][k], -c.pose.r[2][k]];
							jc.push([s + 3 + k, [dot(a[0], g), dot(a[1], g)]]);
						}
				}
				if (l.fidx[ci]! !== NONE) jc.push([l.fidx[ci]!, p]);
				if (l.shared !== null) jc.push([l.shared, p]);
				if (l.dist !== null) {
					jc.push([l.dist, [dk[0][0], dk[1][0]]]);
					jc.push([l.dist + 1, [dk[0][1], dk[1][1]]]);
				}
				const jx: [V3, V3] = o.fixPoints
					? [
							[0, 0, 0],
							[0, 0, 0],
						]
					: [mtv(c.pose.r, a[0]), mtv(c.pose.r, a[1])];
				for (const [ia, ja] of jc) {
					bc[ia]! -= w * (ja[0] * r[0] + ja[1] * r[1]);
					for (const [ib, jb] of jc) S[ia * n + ib]! += w * (ja[0] * jb[0] + ja[1] * jb[1]);
				}
				if (!o.fixPoints) {
					for (let a1 = 0; a1 < 3; a1++) {
						ps.bp[a1]! -= w * (jx[0][a1]! * r[0] + jx[1][a1]! * r[1]);
						for (let b1 = 0; b1 < 3; b1++)
							ps.v[a1]![b1]! += w * (jx[0][a1]! * jx[0][b1]! + jx[1][a1]! * jx[1][b1]!);
					}
					for (const [ia, ja] of jc) {
						const wv: V3 = [
							w * (ja[0] * jx[0][0] + ja[1] * jx[1][0]),
							w * (ja[0] * jx[0][1] + ja[1] * jx[1][1]),
							w * (ja[0] * jx[0][2] + ja[1] * jx[1][2]),
						];
						const repeats = ia === l.shared || (l.dist !== null && (ia === l.dist || ia === l.dist + 1));
						const found = repeats ? ps.w.find((x) => x[0] === ia) : undefined;
						if (found) found[1] = add(found[1], wv);
						else ps.w.push([ia, wv]);
					}
				}
			}
			systems.push(ps);
		}
		if (o.focal.kind === 'perCamera') {
			const k = o.focal.prior;
			for (let i = 0; i + 1 < cams.length; i++) {
				const r = k * (Math.log(cams[i]!.f) - Math.log(cams[i + 1]!.f));
				const pair: [number, number][] = [
					[l.fidx[i]!, k],
					[l.fidx[i + 1]!, -k],
				];
				for (const [x, g] of pair) {
					if (x === NONE) continue;
					bc[x]! -= g * r;
					for (const [y, h] of pair) if (y !== NONE) S[x * n + y]! += g * h;
				}
			}
		}
		let meanDiag = 0;
		for (let i = 0; i < n; i++) meanDiag += S[i * n + i]!;
		meanDiag = Math.max(1e-12, meanDiag / Math.max(1, n));
		let accepted = false;
		for (let tr = 0; tr < 12; tr++) {
			const s = S.slice();
			const rhs = bc.slice();
			for (let i = 0; i < n; i++) {
				const d = s[i * n + i]!;
				s[i * n + i] = d + lambda * Math.max(d, 1e-6 * meanDiag);
			}
			const vinv: (M3 | null)[] = systems.map((ps) => {
				if (o.fixPoints) return null;
				const v = ps.v.map((r) => [...r]) as M3;
				const vd = (v[0][0] + v[1][1] + v[2][2]) / 3;
				for (let k = 0; k < 3; k++)
					v[k]![k]! += lambda * Math.max(v[k]![k]!, 1e-6 * Math.max(vd, 1e-12)) + 1e-12;
				return inv3(v);
			});
			if (!o.fixPoints)
				for (let j = 0; j < npts; j++) {
					const vi = vinv[j];
					const ps = systems[j]!;
					if (!vi) continue;
					const vb = mv(vi, ps.bp);
					const wv = ps.w.map(([, w]) => mv(vi, w));
					for (let a = 0; a < ps.w.length; a++) {
						const [ia, wa] = ps.w[a]!;
						rhs[ia]! -= dot(wa, vb);
						for (let b = a; b < ps.w.length; b++) {
							const [ib, wb] = ps.w[b]!;
							const d = dot(wv[a]!, wb);
							s[ia * n + ib]! -= d;
							if (ia !== ib) s[ib * n + ia]! -= d;
						}
					}
				}
			const dc = rhs;
			if (n > 0 && !choleskySolve(s, n, dc)) {
				lambda *= 10;
				continue;
			}
			const nc = cams.map(cloneCam);
			nc.forEach((c, i) => {
				const st = l.start[i]!;
				if (st !== NONE) {
					c.pose.r = mm(rodrigues([dc[st]!, dc[st + 1]!, dc[st + 2]!]), c.pose.r);
					if (!l.rotOnly) c.pose.c = add(c.pose.c, [dc[st + 3]!, dc[st + 4]!, dc[st + 5]!]);
				}
				if (l.fidx[i]! !== NONE) c.f *= Math.exp(Math.min(0.5, Math.max(-0.5, dc[l.fidx[i]!]!)));
				if (l.shared !== null) c.f *= Math.exp(Math.min(0.5, Math.max(-0.5, dc[l.shared]!)));
				if (l.dist !== null) {
					c.dist.k1 += Math.min(0.2, Math.max(-0.2, dc[l.dist]!));
					c.dist.k2 += Math.min(0.2, Math.max(-0.2, dc[l.dist + 1]!));
				}
			});
			const np = pts.map((x) => [...x] as V3);
			if (!o.fixPoints)
				for (let j = 0; j < npts; j++) {
					const vi = vinv[j];
					if (!vi) continue;
					let b = systems[j]!.bp;
					for (const [ia, w] of systems[j]!.w) b = sub(b, scale(w, dc[ia]!));
					np[j] = add(np[j]!, mv(vi, b));
				}
			const c2 = baCost(nc, np, obs, o);
			if (Number.isFinite(c2) && c2 < cur) {
				for (let i = 0; i < cams.length; i++) cams[i] = nc[i]!;
				for (let j = 0; j < npts; j++) pts[j] = np[j]!;
				const gain = cur - c2;
				cur = c2;
				lambda = Math.max(1e-9, lambda / 3);
				accepted = gain > 1e-6 * Math.max(cur, 1e-12);
				if (!accepted) return { initialCost: initial, cost: cur, iterations: iters };
				break;
			}
			lambda *= 4;
		}
		if (!accepted) break;
	}
	return { initialCost: initial, cost: cur, iterations: iters };
}
