// Tracking geometry helpers (S09:TRK-011…013): homographies, feature masks, per-frame edge refinement (sub-pixel
// edge samples along the normals of the predicted quad, robust line fits, intersections), confidence and the
// media ↔ tracking pixel mapping.
//
// WORKER-SAFE: the tracking worker (worker.ts) evaluates the source text of every function exported here, so each
// function may only reference other function declarations of this file and JS globals — no imports, no module
// constants, no closures over module scope.

/** Row-major 3x3 homography. */
export type Mat3 = number[];
/** Quad as 8 numbers: TL x, y, TR x, y, BR x, y, BL x, y. */
export type Quad8 = number[];
export type EdgeMode = 'rise' | 'fall' | 'valley';

export function hApply(h: Mat3, x: number, y: number): [number, number] {
	const w = h[6]! * x + h[7]! * y + h[8]!;
	return [(h[0]! * x + h[1]! * y + h[2]!) / w, (h[3]! * x + h[4]! * y + h[5]!) / w];
}

export function hMul(a: Mat3, b: Mat3): Mat3 {
	const out = new Array<number>(9);
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++)
			out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
	return hNormalize(out);
}

export function hNormalize(h: Mat3): Mat3 {
	const s = Math.abs(h[8]!) > 1e-12 ? h[8]! : 1;
	return h.map((v) => v / s);
}

export function hInv(m: Mat3): Mat3 {
	const [a, b, c, d, e, f, g, h, i] = m as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return hNormalize([
		A / det,
		-(b * i - c * h) / det,
		(b * f - c * e) / det,
		B / det,
		(a * i - c * g) / det,
		-(a * f - c * d) / det,
		C / det,
		-(a * h - b * g) / det,
		(a * e - b * d) / det,
	]);
}

export function hTranslate(tx: number, ty: number): Mat3 {
	return [1, 0, tx, 0, 1, ty, 0, 0, 1];
}

export function hIdentity(): Mat3 {
	return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function quadApply(h: Mat3, q: Quad8): Quad8 {
	const out: number[] = [];
	for (let k = 0; k < 4; k++) out.push(...hApply(h, q[2 * k]!, q[2 * k + 1]!));
	return out;
}

/** Signed area (positive = clockwise in image coordinates, y down). */
export function quadSignedArea(q: Quad8): number {
	let s = 0;
	for (let k = 0; k < 4; k++) {
		const j = (k + 1) % 4;
		s += q[2 * k]! * q[2 * j + 1]! - q[2 * j]! * q[2 * k + 1]!;
	}
	return s / 2;
}

export function quadIsConvex(q: Quad8): boolean {
	let sign = 0;
	for (let k = 0; k < 4; k++) {
		const a = k;
		const b = (k + 1) % 4;
		const c = (k + 2) % 4;
		const cross =
			(q[2 * b]! - q[2 * a]!) * (q[2 * c + 1]! - q[2 * b + 1]!) -
			(q[2 * b + 1]! - q[2 * a + 1]!) * (q[2 * c]! - q[2 * b]!);
		if (!Number.isFinite(cross) || Math.abs(cross) < 1e-9) return false;
		const s = cross > 0 ? 1 : -1;
		if (sign === 0) sign = s;
		else if (s !== sign) return false;
	}
	return true;
}

export function quadCentroid(q: Quad8): [number, number] {
	return [(q[0]! + q[2]! + q[4]! + q[6]!) / 4, (q[1]! + q[3]! + q[5]! + q[7]!) / 4];
}

/** Quad scaled by `k` about its centroid. */
export function quadScale(q: Quad8, k: number): Quad8 {
	const [cx, cy] = quadCentroid(q);
	return q.map((v, i) => (i % 2 === 0 ? cx + (v - cx) * k : cy + (v - cy) * k));
}

export function quadBounds(q: Quad8): { x0: number; y0: number; x1: number; y1: number } {
	const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
	const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
	return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Largest corner distance between two quads. */
export function quadMaxDistance(a: Quad8, b: Quad8): number {
	let m = 0;
	for (let k = 0; k < 4; k++)
		m = Math.max(m, Math.hypot(a[2 * k]! - b[2 * k]!, a[2 * k + 1]! - b[2 * k + 1]!));
	return m;
}

/**
 * Inward side lines of a convex quad as [nx, ny, c] with n·p + c = signed distance (positive inside).
 * Side k runs from corner k to corner k+1 (top, right, bottom, left for TL, TR, BR, BL).
 */
export function quadInwardLines(q: Quad8): number[][] {
	const [cx, cy] = quadCentroid(q);
	const lines: number[][] = [];
	for (let k = 0; k < 4; k++) {
		const j = (k + 1) % 4;
		const px = q[2 * k]!;
		const py = q[2 * k + 1]!;
		const dx = q[2 * j]! - px;
		const dy = q[2 * j + 1]! - py;
		const len = Math.hypot(dx, dy) || 1;
		let nx = -dy / len;
		let ny = dx / len;
		if (nx * (cx - px) + ny * (cy - py) < 0) {
			nx = -nx;
			ny = -ny;
		}
		lines.push([nx, ny, -(nx * px + ny * py)]);
	}
	return lines;
}

/** Smallest signed distance of (x, y) to the sides of a convex quad (positive inside). */
export function quadInsideDistance(lines: number[][], x: number, y: number): number {
	let d = Number.POSITIVE_INFINITY;
	for (const l of lines) {
		const v = l[0]! * x + l[1]! * y + l[2]!;
		if (v < d) d = v;
	}
	return d;
}

/**
 * Feature mask (255 = features allowed) over the region `roi` of a frame: `inside` the quad at least `inset` px from
 * its sides, a ring 5–25 % of the quad size outside it (`surroundings`), or `both`.
 */
export function featureMask(
	quad: Quad8,
	roi: { x: number; y: number; w: number; h: number },
	mode: 'inside' | 'surroundings' | 'both',
	inset: number,
): Uint8Array {
	const mask = new Uint8Array(roi.w * roi.h);
	const inner = quadInwardLines(quad);
	const ringIn = quadInwardLines(quadScale(quad, 1.05));
	const ringOut = quadInwardLines(quadScale(quad, 1.25));
	const wantInside = mode !== 'surroundings';
	const wantRing = mode !== 'inside';
	for (let y = 0; y < roi.h; y++) {
		const py = roi.y + y;
		for (let x = 0; x < roi.w; x++) {
			const px = roi.x + x;
			let on = false;
			if (wantInside && quadInsideDistance(inner, px, py) >= inset) on = true;
			if (
				!on &&
				wantRing &&
				quadInsideDistance(ringOut, px, py) >= 0 &&
				quadInsideDistance(ringIn, px, py) < 0
			)
				on = true;
			if (on) mask[y * roi.w + x] = 255;
		}
	}
	return mask;
}

/** Integer region around the feature area of `quad` (plus `margin`), clipped to the frame. */
export function featureRoi(
	quad: Quad8,
	mode: 'inside' | 'surroundings' | 'both',
	margin: number,
	width: number,
	height: number,
): { x: number; y: number; w: number; h: number } | null {
	const b = quadBounds(mode === 'inside' ? quad : quadScale(quad, 1.25));
	const x0 = Math.max(0, Math.floor(b.x0 - margin));
	const y0 = Math.max(0, Math.floor(b.y0 - margin));
	const x1 = Math.min(width, Math.ceil(b.x1 + margin));
	const y1 = Math.min(height, Math.ceil(b.y1 + margin));
	if (x1 - x0 < 16 || y1 - y0 < 16) return null;
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Bilinear sample of an 8-bit gray image; NaN outside [0, w-1]×[0, h-1]. */
export function sampleGray(img: Uint8Array, w: number, h: number, x: number, y: number): number {
	if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return Number.NaN;
	const x0 = Math.min(w - 2, Math.floor(x));
	const y0 = Math.min(h - 2, Math.floor(y));
	const fx = x - x0;
	const fy = y - y0;
	const i = y0 * w + x0;
	const a = img[i]! + (img[i + 1]! - img[i]!) * fx;
	const b = img[i + w]! + (img[i + w + 1]! - img[i + w]!) * fx;
	return a + (b - a) * fy;
}

/**
 * Edge samples along the segment p→q: `n` normals at t ∈ [0.1, 0.9], each sampled over ±`band` px (0.5 px steps,
 * lightly smoothed). `rise`/`fall`: the strongest luminance step increasing/decreasing towards the inside; `valley`:
 * a dark line such as a bezel mask (its centre between the half-depth crossings). Of the strong candidates on a normal
 * the one nearest to the given side wins. Sub-pixel parabolic peak for steps. Returns the position `t` along
 * the side and the signed offset along the inward normal of each accepted sample. Normals leaving the frame are
 * skipped.
 */
export function edgeSamples(
	img: Uint8Array,
	w: number,
	h: number,
	p: [number, number],
	q: [number, number],
	inward: [number, number],
	band: number,
	n: number,
	mode: EdgeMode,
	minContrast: number,
): { t: number[]; off: number[]; strength: number[] } {
	const ts: number[] = [];
	const offs: number[] = [];
	const strengths: number[] = [];
	const steps = Math.max(4, Math.round(band * 2));
	const m = 2 * steps + 1;
	const raw = new Float64Array(m);
	const prof = new Float64Array(m);
	const score = new Float64Array(m);
	for (let s = 0; s < n; s++) {
		const t = 0.1 + (0.8 * s) / Math.max(1, n - 1);
		const cx = p[0] + (q[0] - p[0]) * t;
		const cy = p[1] + (q[1] - p[1]) * t;
		let ok = true;
		for (let i = 0; i < m; i++) {
			const o = (i - steps) * 0.5;
			const v = sampleGray(img, w, h, cx + inward[0] * o, cy + inward[1] * o);
			if (Number.isNaN(v)) {
				ok = false;
				break;
			}
			raw[i] = v;
		}
		if (!ok) continue;
		for (let i = 0; i < m; i++) {
			const a = raw[Math.max(0, i - 1)]!;
			const b = raw[Math.min(m - 1, i + 1)]!;
			prof[i] = 0.25 * a + 0.5 * raw[i]! + 0.25 * b;
		}
		// Candidate peaks (local maxima of the score) and their strength: the step size, or for a valley its depth
		// below the brighter sides. The strong candidate (≥ half the strongest) NEAREST to the given line wins, so a
		// refinement snaps to the edge the user placed the side on, not to a stronger edge further away.
		if (mode === 'valley') for (let i = 0; i < m; i++) score[i] = -prof[i]!;
		else {
			const sign = mode === 'rise' ? 1 : -1;
			score[0] = 0;
			score[m - 1] = 0;
			for (let i = 1; i < m - 1; i++) score[i] = (sign * (prof[i + 1]! - prof[i - 1]!)) / 2;
		}
		let strongest = 0;
		const cand: number[] = [];
		const strength: number[] = [];
		for (let i = 2; i < m - 2; i++) {
			if (score[i]! < score[i - 1]! || score[i]! < score[i + 1]!) continue;
			let st: number;
			if (mode === 'valley') {
				let leftMax = 0;
				let rightMax = 0;
				for (let j = 0; j < i; j++) leftMax = Math.max(leftMax, prof[j]!);
				for (let j = i + 1; j < m; j++) rightMax = Math.max(rightMax, prof[j]!);
				st = Math.min(leftMax, rightMax) - prof[i]!;
				if (st < minContrast * 3) continue;
			} else {
				st = score[i]!;
				if (st < minContrast) continue;
			}
			cand.push(i);
			strength.push(st);
			strongest = Math.max(strongest, st);
		}
		let k = -1;
		let kStrength = 0;
		for (let c = 0; c < cand.length; c++)
			if (strength[c]! >= 0.5 * strongest && (k < 0 || Math.abs(cand[c]! - steps) < Math.abs(k - steps))) {
				k = cand[c]!;
				kStrength = strength[c]!;
			}
		if (k < 0) continue;
		let pos: number;
		if (mode === 'valley') {
			// Centre between the half-height crossings of each flank (each against its own bright side): robust for
			// flat-bottomed dark lines wider than a pixel and for unequal sides (bright bezel, dim picture).
			let leftMax = 0;
			let rightMax = 0;
			for (let j = 0; j < k; j++) leftMax = Math.max(leftMax, prof[j]!);
			for (let j = k + 1; j < m; j++) rightMax = Math.max(rightMax, prof[j]!);
			const levelL = 0.5 * (prof[k]! + leftMax);
			const levelR = 0.5 * (prof[k]! + rightMax);
			let l = k;
			while (l > 0 && prof[l]! < levelL) l--;
			let r = k;
			while (r < m - 1 && prof[r]! < levelR) r++;
			if (prof[l]! < levelL || prof[r]! < levelR) continue;
			const xl = l + (levelL - prof[l]!) / (prof[l + 1]! - prof[l]!);
			const xr = r - (levelR - prof[r]!) / (prof[r - 1]! - prof[r]!);
			pos = (xl + xr) / 2;
		} else {
			const a = score[k - 1]!;
			const b = score[k]!;
			const c = score[k + 1]!;
			const den = a - 2 * b + c;
			let sub = Math.abs(den) > 1e-9 ? (0.5 * (a - c)) / den : 0;
			if (sub > 0.5) sub = 0.5;
			else if (sub < -0.5) sub = -0.5;
			pos = k + sub;
		}
		ts.push(t);
		offs.push((pos - steps) * 0.5);
		strengths.push(kStrength);
	}
	return { t: ts, off: offs, strength: strengths };
}

/**
 * Robust fit of `off = a + b·t` (Huber, then Tukey biweight IRLS) starting from the median offset. Returns the
 * line, median absolute residual and the number of samples within `inlierTol`.
 */
export function robustOffsetFit(
	t: number[],
	off: number[],
	inlierTol: number,
): { a: number; b: number; median: number; inliers: number } {
	const n = t.length;
	if (n === 0) return { a: 0, b: 0, median: Number.POSITIVE_INFINITY, inliers: 0 };
	const sorted = [...off].sort((x, y) => x - y);
	let a = sorted[Math.floor(n / 2)]!;
	let b = 0;
	const wts = new Array<number>(n).fill(1);
	for (let iter = 0; iter < 10; iter++) {
		const tukey = iter >= 4;
		for (let i = 0; i < n; i++) {
			const r = Math.abs(off[i]! - (a + b * t[i]!));
			if (tukey) {
				const c = 2 * inlierTol;
				wts[i] = r < c ? (1 - (r / c) ** 2) ** 2 : 0;
			} else wts[i] = r <= inlierTol ? 1 : inlierTol / r;
		}
		let sw = 0;
		let st = 0;
		let so = 0;
		let stt = 0;
		let sto = 0;
		for (let i = 0; i < n; i++) {
			const wi = wts[i]!;
			sw += wi;
			st += wi * t[i]!;
			so += wi * off[i]!;
			stt += wi * t[i]! * t[i]!;
			sto += wi * t[i]! * off[i]!;
		}
		if (sw < 1e-9) break;
		const det = sw * stt - st * st;
		if (Math.abs(det) < 1e-12) {
			a = so / sw;
			b = 0;
		} else {
			b = (sw * sto - st * so) / det;
			a = (so - b * st) / sw;
		}
	}
	const residuals = off.map((o, i) => Math.abs(o - (a + b * t[i]!)));
	const rs = [...residuals].sort((x, y) => x - y);
	return {
		a,
		b,
		median: rs[Math.floor(n / 2)]!,
		inliers: residuals.filter((r) => r <= inlierTol).length,
	};
}

/** Intersection of the lines through p1→p2 and p3→p4 (null when parallel). */
export function intersectLines(
	p1: [number, number],
	p2: [number, number],
	p3: [number, number],
	p4: [number, number],
): [number, number] | null {
	const d1x = p2[0] - p1[0];
	const d1y = p2[1] - p1[1];
	const d2x = p4[0] - p3[0];
	const d2y = p4[1] - p3[1];
	const den = d1x * d2y - d1y * d2x;
	if (Math.abs(den) < 1e-12) return null;
	const s = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
	return [p1[0] + s * d1x, p1[1] + s * d1y];
}

export type EdgeSideResult = {
	accepted: boolean;
};

/**
 * Per-frame edge refinement (S09 planar `refineEdges`): every side with a mode is re-measured in ±`band` px around
 * the predicted side; a side is accepted when enough samples agree (`minFraction` of `n` within 1 px), the median
 * residual is ≤ `maxResidual` and the fitted line stays within `maxShift` px of the prediction. Corners = intersections
 * of adjacent (refined or predicted) sides. Sides whose normals leave the frame keep the predicted line.
 */
export function refineQuadEdges(
	img: Uint8Array,
	w: number,
	h: number,
	quad: Quad8,
	modes: (EdgeMode | null)[],
	opts: {
		band: number;
		n: number;
		maxShift: number;
		maxResidual: number;
		minFraction: number;
		minContrast: number;
	},
): { quad: Quad8; sides: EdgeSideResult[] } {
	const lines = quadInwardLines(quad);
	const sideLines: [[number, number], [number, number]][] = [];
	const sides: EdgeSideResult[] = [];
	for (let k = 0; k < 4; k++) {
		const j = (k + 1) % 4;
		const p: [number, number] = [quad[2 * k]!, quad[2 * k + 1]!];
		const q: [number, number] = [quad[2 * j]!, quad[2 * j + 1]!];
		const nrm: [number, number] = [lines[k]![0]!, lines[k]![1]!];
		const predicted: [[number, number], [number, number]] = [p, q];
		const mode = modes[k] ?? null;
		if (!mode) {
			sideLines.push(predicted);
			sides.push({ accepted: false });
			continue;
		}
		const s = edgeSamples(img, w, h, p, q, nrm, opts.band, opts.n, mode, opts.minContrast);
		const fit = robustOffsetFit(s.t, s.off, 1);
		const shift = Math.max(Math.abs(fit.a), Math.abs(fit.a + fit.b));
		const ok =
			s.t.length > 0 &&
			fit.inliers >= Math.max(6, Math.ceil(opts.n * opts.minFraction)) &&
			fit.median <= opts.maxResidual &&
			shift <= opts.maxShift;
		const line: [[number, number], [number, number]] = [
			[p[0] + nrm[0] * fit.a, p[1] + nrm[1] * fit.a],
			[q[0] + nrm[0] * (fit.a + fit.b), q[1] + nrm[1] * (fit.a + fit.b)],
		];
		sideLines.push(ok ? line : predicted);
		sides.push({ accepted: ok });
	}
	if (!sides.some((s) => s.accepted)) return { quad: [...quad], sides };
	const out: number[] = [];
	for (let k = 0; k < 4; k++) {
		const prev = sideLines[(k + 3) % 4]!;
		const cur = sideLines[k]!;
		const x = intersectLines(prev[0], prev[1], cur[0], cur[1]);
		if (!x || Math.hypot(x[0] - quad[2 * k]!, x[1] - quad[2 * k + 1]!) > opts.maxShift * 3)
			return { quad: [...quad], sides: sides.map((s) => ({ ...s, accepted: false })) };
		out.push(x[0], x[1]);
	}
	if (!quadIsConvex(out)) return { quad: [...quad], sides: sides.map((s) => ({ ...s, accepted: false })) };
	return { quad: out, sides };
}

/**
 * On the reference frame: which edge kind each side shows (a step up or down going inward, or a dark valley): of the
 * modes that fit a straight line well, the one nearest to the given side. Sides where nothing fits get null (never
 * refined).
 */
export function chooseEdgeModes(
	img: Uint8Array,
	w: number,
	h: number,
	quad: Quad8,
	opts: { band: number; n: number; maxResidual: number; minFraction: number; minContrast: number },
): (EdgeMode | null)[] {
	const out: (EdgeMode | null)[] = [];
	const lines = quadInwardLines(quad);
	const candidates: EdgeMode[] = ['rise', 'fall', 'valley'];
	for (let k = 0; k < 4; k++) {
		const j = (k + 1) % 4;
		const p: [number, number] = [quad[2 * k]!, quad[2 * k + 1]!];
		const q: [number, number] = [quad[2 * j]!, quad[2 * j + 1]!];
		const nrm: [number, number] = [lines[k]![0]!, lines[k]![1]!];
		// Among the modes that fit, the one whose line lies nearest to the given side (within 0.5 px: the stronger
		// edge), so the reference snap never jumps across a bezel to a stronger edge further away.
		let best: EdgeMode | null = null;
		let bestDist = Number.POSITIVE_INFINITY;
		let bestStrength = 0;
		for (const mode of candidates) {
			const s = edgeSamples(img, w, h, p, q, nrm, opts.band, opts.n, mode, opts.minContrast);
			const fit = robustOffsetFit(s.t, s.off, 1);
			if (fit.inliers < Math.max(6, Math.ceil(opts.n * opts.minFraction)) || fit.median > opts.maxResidual)
				continue;
			const dist = Math.abs(fit.a + fit.b * 0.5);
			const sorted = [...s.strength].sort((x, y) => x - y);
			const strength = sorted[Math.floor(sorted.length / 2)]!;
			if (dist < bestDist - 0.5 || (dist < bestDist + 0.5 && strength > bestStrength)) {
				best = mode;
				bestDist = Math.min(dist, bestDist);
				bestStrength = strength;
			}
		}
		out.push(best);
	}
	return out;
}

/** Planar confidence (S09:TRK-012): inlier ratio × (1 − mean reprojection error / threshold), in [0, 1]. */
export function planarConfidence(
	inliers: number,
	total: number,
	meanError: number,
	threshold: number,
): number {
	if (total <= 0 || inliers <= 0) return 0;
	const ratio = Math.min(1, inliers / total);
	const err = Math.min(1, Math.max(0, meanError / threshold));
	return Math.max(0, Math.min(1, ratio * (1 - err)));
}

/** Tracking resolution for a display size and quality (fast ≤ 960 px wide, balanced ≤ 1280, best = source). */
export function trackingSize(
	width: number,
	height: number,
	quality: 'fast' | 'balanced' | 'best',
): { width: number; height: number; sx: number; sy: number } {
	const cap = quality === 'fast' ? 960 : quality === 'balanced' ? 1280 : width;
	if (width <= cap) return { width, height, sx: 1, sy: 1 };
	const tw = cap - (cap % 2);
	let th = Math.round((height * tw) / width);
	th += th % 2;
	return { width: tw, height: th, sx: width / tw, sy: height / th };
}

/** Media px → tracking px (pixel centres at integer coordinates in both). */
export function toTrackingPx(values: number[], sx: number, sy: number): number[] {
	return values.map((v, i) => (v + 0.5) / (i % 2 === 0 ? sx : sy) - 0.5);
}

/** Tracking px → media px. */
export function toMediaPx(values: number[], sx: number, sy: number): number[] {
	return values.map((v, i) => (v + 0.5) * (i % 2 === 0 ? sx : sy) - 0.5);
}

/**
 * Hold-out mask (S09 hold-out regions): the union of `polygons` (tracking px, flattened x, y pairs; pixel centres
 * inside a polygon by the even–odd rule) grown by `grow` px (a square dilation), as a `width`×`height` byte mask
 * (1 = held out). Null when no pixel is held out.
 */
export function rasterizeHoldout(
	polygons: readonly (readonly number[])[],
	width: number,
	height: number,
	grow: number,
): Uint8Array | null {
	const mask = new Uint8Array(width * height);
	let bx0 = width;
	let by0 = height;
	let bx1 = -1;
	let by1 = -1;
	const xs: number[] = [];
	for (const poly of polygons) {
		const n = Math.floor(poly.length / 2);
		if (n < 3) continue;
		let ymin = Number.POSITIVE_INFINITY;
		let ymax = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < n; i++) {
			const y = poly[2 * i + 1]!;
			if (!Number.isFinite(y) || !Number.isFinite(poly[2 * i]!)) continue;
			ymin = Math.min(ymin, y);
			ymax = Math.max(ymax, y);
		}
		const r0 = Math.max(0, Math.ceil(ymin));
		const r1 = Math.min(height - 1, Math.floor(ymax));
		for (let r = r0; r <= r1; r++) {
			xs.length = 0;
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n;
				const ax = poly[2 * i]!;
				const ay = poly[2 * i + 1]!;
				const bx = poly[2 * j]!;
				const by = poly[2 * j + 1]!;
				if (ay <= r !== by <= r) xs.push(ax + ((r - ay) * (bx - ax)) / (by - ay));
			}
			xs.sort((a, b) => a - b);
			for (let k = 0; k + 1 < xs.length; k += 2) {
				const c0 = Math.max(0, Math.ceil(xs[k]!));
				const c1 = Math.min(width - 1, Math.floor(xs[k + 1]!));
				if (c1 < c0) continue;
				mask.fill(1, r * width + c0, r * width + c1 + 1);
				bx0 = Math.min(bx0, c0);
				bx1 = Math.max(bx1, c1);
				by0 = Math.min(by0, r);
				by1 = Math.max(by1, r);
			}
		}
	}
	if (bx1 < 0) return null;
	const g = Math.max(0, Math.round(grow));
	if (g === 0) return mask;
	// Separable square dilation over the touched box.
	const x0 = Math.max(0, bx0 - g);
	const x1 = Math.min(width - 1, bx1 + g);
	const y0 = Math.max(0, by0 - g);
	const y1 = Math.min(height - 1, by1 + g);
	const tmp = new Uint8Array(width * height);
	for (let y = by0; y <= by1; y++) {
		const row = y * width;
		for (let x = bx0; x <= bx1; x++) {
			if (!mask[row + x]) continue;
			tmp.fill(1, row + Math.max(x0, x - g), row + Math.min(x1, x + g) + 1);
		}
	}
	for (let x = x0; x <= x1; x++) {
		for (let y = y0; y <= y1; y++) {
			if (!tmp[y * width + x]) continue;
			const a = Math.max(y0, y - g);
			const b = Math.min(y1, y + g);
			for (let yy = a; yy <= b; yy++) mask[yy * width + x] = 1;
		}
	}
	return mask;
}
