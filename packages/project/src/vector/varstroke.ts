// Variable-width strokes (wp shapes): the shape Stroke's Taper (start/end length, width and ease) and Wave (amount,
// wavelength or cycles, phase), with dashes cut along the same arc length. Port of EffectCraft's
// `crates/path/src/varstroke.rs` (MIT OR Apache-2.0).
//
// The stroke is built as a union of positively wound primitives: one quad per flattened piece (its two ends at the
// local widths), a disc at every bend (round joins) and the caps. Filled with the non-zero rule (as one path), the
// union is exact whatever the width profile does.
import {
	arcCubics,
	type BezPath,
	flattenPath,
	lerp,
	type P,
	polyline,
	type SubPath,
	signedArea,
} from './geom.ts';
import type { LineCap } from './offset.ts';

/** Taper: lengths in pixels, or fractions of each path's length when `percent`; widths/eases are fractions 0–1. */
export type Taper = {
	percent: boolean;
	startLength: number;
	endLength: number;
	startWidth: number;
	endWidth: number;
	startEase: number;
	endEase: number;
};

/** Wave: the width oscillates between 1 − amount and 1 of the stroke width. */
export type Wave = {
	/** 0–1. */
	amount: number;
	/** Cycles along each path (units = cycles), else `wavelength` in pixels. */
	cycles: number | null;
	wavelength: number;
	/** Degrees. */
	phase: number;
};

export const taperActive = (t: Taper | null | undefined): t is Taper =>
	!!t && ((t.startLength > 0 && t.startWidth < 1) || (t.endLength > 0 && t.endWidth < 1));

export const waveActive = (w: Wave | null | undefined): w is Wave =>
	!!w && w.amount > 0 && (w.cycles === null ? w.wavelength > 0 : w.cycles > 0);

/** Ease profile from the tip (u = 0) to full width (u = 1): linear at ease 0, a quarter circle at ease 1. */
function ease(u: number, e: number): number {
	const uu = Math.min(1, Math.max(0, u));
	const round = Math.sqrt(Math.max(0, 1 - (1 - uu) * (1 - uu)));
	return uu + (round - uu) * Math.min(1, Math.max(0, e));
}

/** Width factor (0–1) at arc length `s` of a path `len` long. */
export function widthFactor(taper: Taper | null, wave: Wave | null, s: number, len: number): number {
	let k = 1;
	if (taperActive(taper)) {
		let ls = Math.max(0, taper.percent ? taper.startLength * len : taper.startLength);
		let le = Math.max(0, taper.percent ? taper.endLength * len : taper.endLength);
		// Overlapping tapers share the path in proportion.
		if (ls + le > len && ls + le > 0) {
			const f = len / (ls + le);
			ls *= f;
			le *= f;
		}
		const sw = Math.min(1, Math.max(0, taper.startWidth));
		const ew = Math.min(1, Math.max(0, taper.endWidth));
		if (ls > 0 && s < ls) k = Math.min(k, sw + (1 - sw) * ease(s / ls, taper.startEase));
		if (le > 0 && s > len - le) k = Math.min(k, ew + (1 - ew) * ease((len - s) / le, taper.endEase));
	}
	if (waveActive(wave)) {
		const lambda = wave.cycles !== null ? len / wave.cycles : wave.wavelength;
		if (lambda > 0) {
			const ph = (2 * Math.PI * s) / lambda + (wave.phase * Math.PI) / 180;
			k *= 1 - Math.min(1, Math.max(0, wave.amount)) * (0.5 - 0.5 * Math.cos(ph));
		}
	}
	return k;
}

/** Arc-length intervals that are "on" for a dash pattern (dash, gap, …) with an offset on a path `len` long. */
export function dashIntervals(pattern: readonly number[], offset: number, len: number): [number, number][] {
	let pat = pattern.map((v) => Math.max(0, v));
	if (pat.length % 2 === 1) pat = [...pat, ...pat];
	const period = pat.reduce((a, b) => a + b, 0);
	if (pat.length < 2 || period <= 1e-9 || len <= 0) return [[0, len]];
	let pos = ((offset % period) + period) % period;
	let idx = 0;
	while (pos >= pat[idx]!) {
		pos -= pat[idx]!;
		idx = (idx + 1) % pat.length;
	}
	let s = 0;
	const out: [number, number][] = [];
	let guard = 0;
	while (s < len && guard++ < 1_000_000) {
		const seg = pat[idx]! - pos;
		const e = Math.min(len, s + seg);
		if (idx % 2 === 0 && e >= s) out.push([s, e]);
		s += seg;
		pos = 0;
		idx = (idx + 1) % pat.length;
	}
	return out;
}

type Poly = { pts: P[]; s: number[]; closed: boolean };

function measure(pts: P[], closed: boolean, step: number): Poly | null {
	const clean: P[] = [];
	for (const p of pts) {
		const q = clean[clean.length - 1];
		if (!q || Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-9) clean.push(p);
	}
	if (closed && clean.length > 2) {
		const a = clean[0]!;
		const b = clean[clean.length - 1]!;
		if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) clean.push(a);
	}
	if (clean.length < 2) return null;
	const fine: P[] = [clean[0]!];
	for (let i = 1; i < clean.length; i++) {
		const a = clean[i - 1]!;
		const b = clean[i]!;
		const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
		for (let k = 1; k <= n; k++) fine.push(lerp(a, b, k / n));
	}
	const s = [0];
	for (let i = 1; i < fine.length; i++)
		s.push(s[i - 1]! + Math.hypot(fine[i]![0] - fine[i - 1]![0], fine[i]![1] - fine[i - 1]![1]));
	return { pts: fine, s, closed };
}

function at(poly: Poly, t: number): { p: P; i: number } {
	let lo = 0;
	let hi = poly.s.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (poly.s[mid]! <= t) lo = mid + 1;
		else hi = mid;
	}
	const i = Math.min(poly.pts.length - 1, Math.max(1, lo));
	const a = poly.s[i - 1]!;
	const b = poly.s[i]!;
	const u = b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 0;
	return { p: lerp(poly.pts[i - 1]!, poly.pts[i]!, u), i };
}

function pushPositive(out: BezPath, sp: SubPath): void {
	const a = signedArea([sp]);
	if (Math.abs(a) <= 1e-12) return;
	out.push(
		a < 0 ? { closed: true, segs: sp.segs.map((c) => [c[3], c[2], c[1], c[0]] as const).reverse() } : sp,
	);
}

function quad(out: BezPath, pts: [P, P, P, P]): void {
	pushPositive(out, polyline(pts, true));
}

function disc(out: BezPath, c: P, r: number): void {
	if (r > 1e-6) pushPositive(out, { segs: arcCubics(c, r, 0, 2 * Math.PI), closed: true });
}

export type VarStroke = {
	width: number;
	cap: LineCap;
	dash: { pattern: number[]; offset: number } | null;
	taper: Taper | null;
	wave: Wave | null;
};

/**
 * Outline of a tapered / waved stroke (local space, fill non-zero); `resScale` = device pixels per local unit, so
 * the profile is sampled every half device pixel.
 */
export function varStrokeOutline(paths: BezPath, st: VarStroke, resScale: number): BezPath {
	const out: BezPath = [];
	if (!(st.width > 0)) return out;
	const rs = Math.max(0.01, resScale);
	const half = st.width / 2;
	const taper = taperActive(st.taper) ? st.taper : null;
	const wave = waveActive(st.wave) ? st.wave : null;
	for (const rough of flattenPath(paths, 0.1 / rs)) {
		const probe = measure(rough.pts, rough.closed, Number.POSITIVE_INFINITY);
		if (!probe) continue;
		const len0 = probe.s[probe.s.length - 1]!;
		if (len0 <= 0) continue;
		const poly = measure(rough.pts, rough.closed, Math.max(0.5 / rs, len0 / 20000));
		if (!poly) continue;
		const len = poly.s[poly.s.length - 1]!;
		const wf = (s: number) => half * widthFactor(taper, wave, s, len);
		const intervals = st.dash?.pattern.some((v) => v > 0)
			? dashIntervals(st.dash.pattern, st.dash.offset, len)
			: [[0, len] as [number, number]];
		const whole = intervals.length === 1 && intervals[0]![0] <= 0 && intervals[0]![1] >= len;
		for (const [a, b] of intervals) {
			const pa = at(poly, a);
			const pb = at(poly, b);
			let pts: [P, number][] = [[pa.p, a]];
			for (let i = pa.i; i < pb.i; i++) pts.push([poly.pts[i]!, poly.s[i]!]);
			pts.push([pb.p, b]);
			pts = pts.filter(
				(x, i) => i === 0 || Math.hypot(x[0][0] - pts[i - 1]![0][0], x[0][1] - pts[i - 1]![0][1]) >= 1e-9,
			);
			if (pts.length < 2) {
				// A zero-length dash: only its caps show.
				if (st.cap === 'round') disc(out, pa.p, wf(a));
				continue;
			}
			const closed = whole && poly.closed;
			const dir = (i: number): P => {
				const d: P = [pts[i + 1]![0][0] - pts[i]![0][0], pts[i + 1]![0][1] - pts[i]![0][1]];
				const l = Math.hypot(d[0], d[1]);
				return [d[0] / l, d[1] / l];
			};
			for (let i = 0; i + 1 < pts.length; i++) {
				const d = dir(i);
				const n: P = [-d[1], d[0]];
				const [p0, s0] = pts[i]!;
				const [p1, s1] = pts[i + 1]!;
				const w0 = wf(s0);
				const w1 = wf(s1);
				quad(out, [
					[p0[0] + n[0] * w0, p0[1] + n[1] * w0],
					[p1[0] + n[0] * w1, p1[1] + n[1] * w1],
					[p1[0] - n[0] * w1, p1[1] - n[1] * w1],
					[p0[0] - n[0] * w0, p0[1] - n[1] * w0],
				]);
				if (i > 0) {
					const pd = dir(i - 1);
					if (pd[0] * d[0] + pd[1] * d[1] < 0.9999) disc(out, p0, w0);
				}
			}
			if (closed) {
				disc(out, pts[0]![0], wf(0));
				continue;
			}
			const last = pts.length - 1;
			const d0 = dir(0);
			const d1 = dir(last - 1);
			const ends: [P, number, P][] = [
				[pts[0]![0], wf(pts[0]![1]), [-d0[0], -d0[1]]],
				[pts[last]![0], wf(pts[last]![1]), d1],
			];
			for (const [p, w, o] of ends) {
				if (st.cap === 'round') disc(out, p, w);
				else if (st.cap === 'square') {
					const n: P = [-o[1], o[0]];
					const q: P = [p[0] + o[0] * w, p[1] + o[1] * w];
					quad(out, [
						[p[0] + n[0] * w, p[1] + n[1] * w],
						[q[0] + n[0] * w, q[1] + n[1] * w],
						[q[0] - n[0] * w, q[1] - n[1] * w],
						[p[0] - n[0] * w, p[1] - n[1] * w],
					]);
				}
			}
		}
	}
	return out;
}
