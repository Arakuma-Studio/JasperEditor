// IIR filter design from classical analog prototypes (Scientific Filter; port of filmcraft `design.rs`).
//
// Textbook method: a normalised low-pass prototype (zeros, poles, gain) — Butterworth, Bessel (roots of the reverse
// Bessel polynomial, normalised to −3 dB at Ω = 1), Chebyshev type I and elliptic (Cauer; Landen-transformation
// formulation of the Jacobi elliptic functions, after S. J. Orfanidis, *Lecture Notes on Elliptic Filter Design*,
// 2006) — is transformed to low-pass / high-pass / band-pass / band-stop at pre-warped analog frequencies, mapped to
// the z-plane with the bilinear transform and factored into second-order sections.
//
// `prototype()` (Bessel needs a root search) runs only when the family/order/ripple change; `realize()` runs while a
// cutoff glides, so it works on preallocated scratch root lists and writes into a caller-owned `Sections`: no
// allocation.
import type { Coeffs } from './biquad.ts';

/** Highest prototype order. */
export const MAX_ORDER = 12;
/** Most second-order sections a design produces (band-pass/stop double the order). */
export const MAX_SECTIONS = MAX_ORDER;
const MAX_ROOTS = 2 * MAX_ORDER;

/** Result registers of the allocation-free complex helpers below. */
let tr = 0;
let ti = 0;

export type Family = 'bessel' | 'butterworth' | 'chebyshev' | 'elliptic';
export type Band = 'lowPass' | 'highPass' | 'bandPass' | 'bandStop';

/** Minimal immutable complex number (prototype design only: not on the per-redesign path). */
export class C {
	constructor(
		readonly re: number,
		readonly im: number,
	) {}
	static real(re: number): C {
		return new C(re, 0);
	}
	add(o: C): C {
		return new C(this.re + o.re, this.im + o.im);
	}
	sub(o: C): C {
		return new C(this.re - o.re, this.im - o.im);
	}
	mul(o: C): C {
		return new C(this.re * o.re - this.im * o.im, this.re * o.im + this.im * o.re);
	}
	div(o: C): C {
		const d = o.re * o.re + o.im * o.im;
		return new C((this.re * o.re + this.im * o.im) / d, (this.im * o.re - this.re * o.im) / d);
	}
	scale(s: number): C {
		return new C(this.re * s, this.im * s);
	}
	conj(): C {
		return new C(this.re, -this.im);
	}
	abs(): number {
		return Math.hypot(this.re, this.im);
	}
	sqrt(): C {
		const r = this.abs();
		const re = Math.sqrt(Math.max((r + this.re) * 0.5, 0));
		const im = Math.sqrt(Math.max((r - this.re) * 0.5, 0));
		return new C(re, this.im < 0 ? -im : im);
	}
	ln(): C {
		return new C(Math.log(this.abs()), Math.atan2(this.im, this.re));
	}
	cos(): C {
		return new C(Math.cos(this.re) * Math.cosh(this.im), -Math.sin(this.re) * Math.sinh(this.im));
	}
	sin(): C {
		return new C(Math.sin(this.re) * Math.cosh(this.im), Math.cos(this.re) * Math.sinh(this.im));
	}
	/** acos(w) = −j·ln(w + j·√(1 − w²)). */
	acos(): C {
		const s = C.real(1).sub(this.mul(this)).sqrt();
		const v = this.add(new C(-s.im, s.re)).ln();
		return new C(v.im, -v.re);
	}
}

/** Fixed-capacity root list (split real/imaginary storage). */
class Roots {
	readonly re = new Float64Array(MAX_ROOTS);
	readonly im = new Float64Array(MAX_ROOTS);
	n = 0;

	push(re: number, im: number): void {
		if (this.n < MAX_ROOTS) {
			this.re[this.n] = re;
			this.im[this.n] = im;
			this.n++;
		}
	}

	pushC(c: C): void {
		this.push(c.re, c.im);
	}

	get(i: number): C {
		return new C(this.re[i]!, this.im[i]!);
	}

	copyFrom(o: Roots): void {
		this.re.set(o.re);
		this.im.set(o.im);
		this.n = o.n;
	}

	/** Π(−rᵢ) → (tr, ti). */
	prodNeg(): void {
		let ar = 1;
		let ai = 0;
		for (let i = 0; i < this.n; i++) {
			const br = -this.re[i]!;
			const bi = -this.im[i]!;
			const r = ar * br - ai * bi;
			ai = ar * bi + ai * br;
			ar = r;
		}
		tr = ar;
		ti = ai;
	}

	/** Removes root `i` (the last one takes its place). */
	take(i: number): void {
		this.n--;
		this.re[i] = this.re[this.n]!;
		this.im[i] = this.im[this.n]!;
	}

	/** Index of the root closest to (re, im) (first on ties), −1 when empty. */
	closest(re: number, im: number): number {
		let best = -1;
		let bd = Number.POSITIVE_INFINITY;
		for (let i = 0; i < this.n; i++) {
			const d = Math.hypot(this.re[i]! - re, this.im[i]! - im);
			if (d < bd) {
				bd = d;
				best = i;
			}
		}
		return best;
	}
}

/** Analog zeros/poles/gain. */
class Zpk {
	readonly z = new Roots();
	readonly p = new Roots();
	k = 1;

	copyFrom(o: Zpk): void {
		this.z.copyFrom(o.z);
		this.p.copyFrom(o.p);
		this.k = o.k;
	}
}

/** A cascade of second-order sections, stored flat (`b0 b1 b2 a1 a2` per section). */
export class Sections {
	readonly c = new Float64Array(5 * MAX_SECTIONS);
	n = 0;

	/** Section `i` as a coefficient record (tests, inspection). */
	coeffs(i: number): Coeffs {
		const o = 5 * i;
		const c = this.c;
		return { b0: c[o]!, b1: c[o + 1]!, b2: c[o + 2]!, a1: c[o + 3]!, a2: c[o + 4]! };
	}

	copyFrom(o: Sections): void {
		this.c.set(o.c);
		this.n = o.n;
	}

	/** Magnitude of the cascade in dB at `freq` Hz. */
	magnitudeDb(freq: number, sampleRate: number): number {
		const w = (2 * Math.PI * freq) / sampleRate;
		const c1 = Math.cos(w);
		const s1 = Math.sin(w);
		const c2 = Math.cos(2 * w);
		const s2 = Math.sin(2 * w);
		let num = 1;
		let den = 1;
		const c = this.c;
		for (let i = 0; i < this.n; i++) {
			const o = 5 * i;
			const nr = c[o]! + c[o + 1]! * c1 + c[o + 2]! * c2;
			const ni = -(c[o + 1]! * s1 + c[o + 2]! * s2);
			const dr = 1 + c[o + 3]! * c1 + c[o + 4]! * c2;
			const di = -(c[o + 3]! * s1 + c[o + 4]! * s2);
			num *= nr * nr + ni * ni;
			den *= dr * dr + di * di;
		}
		return 10 * Math.log10(num / den);
	}
}

function butterworth(n: number): Zpk {
	const f = new Zpk();
	for (let k = 0; k < n; k++) {
		const a = (Math.PI * (2 * k + n + 1)) / (2 * n);
		f.p.push(Math.cos(a), Math.sin(a));
	}
	return f;
}

function chebyshev1(n: number, rp: number): Zpk {
	const eps = Math.sqrt(10 ** (rp / 10) - 1);
	const mu = Math.asinh(1 / eps) / n;
	const f = new Zpk();
	for (let k = 0; k < n; k++) {
		const th = (Math.PI * (2 * k + 1)) / (2 * n);
		f.p.push(-Math.sinh(mu) * Math.sin(th), Math.cosh(mu) * Math.cos(th));
	}
	f.p.prodNeg();
	let k = tr;
	if (n % 2 === 0) k /= Math.sqrt(1 + eps * eps);
	f.k = k;
	return f;
}

/** Roots of a monic polynomial (`c[i]` = coefficient of sⁱ, `c[n]` = 1) by Durand–Kerner. */
function polyRoots(c: readonly number[], out: Roots): void {
	const n = c.length - 1;
	const evalAt = (s: C): C => {
		let acc = C.real(c[n]!);
		for (let i = n - 1; i >= 0; i--) acc = acc.mul(s).add(C.real(c[i]!));
		return acc;
	};
	// Initial guesses on a circle of the Cauchy-bound radius.
	let m = 0;
	for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(c[i]!));
	const radius = 1 + m ** (1 / n);
	const r: C[] = [];
	for (let i = 0; i < n; i++) {
		const a = (2 * Math.PI * i) / n + 0.4;
		r.push(new C(radius * Math.cos(a), radius * Math.sin(a)));
	}
	for (let it = 0; it < 500; it++) {
		let delta = 0;
		for (let i = 0; i < n; i++) {
			let den = C.real(1);
			for (let j = 0; j < n; j++) if (j !== i) den = den.mul(r[i]!.sub(r[j]!));
			const step = evalAt(r[i]!).div(den);
			r[i] = r[i]!.sub(step);
			delta = Math.max(delta, step.abs());
		}
		if (delta < 1e-14) break;
	}
	out.n = 0;
	for (const ri of r) out.pushC(ri);
}

function factorial(m: number): number {
	let a = 1;
	for (let v = 2; v <= m; v++) a *= v;
	return a;
}

function bessel(n: number): Zpk {
	// Reverse Bessel polynomial: a_k = (2n − k)! / (2^(n−k) k! (n − k)!), monic (a_n = 1).
	const c: number[] = [];
	for (let k = 0; k <= n; k++)
		c.push(factorial(2 * n - k) / (2 ** (n - k) * factorial(k) * factorial(n - k)));
	const f = new Zpk();
	polyRoots(c, f.p);
	// H(s) = a0 / θ(s); find Ω where |H(jΩ)| = 1/√2 and normalise it to 1.
	const a0 = c[0]!;
	const mag = (w: number): number => {
		const s = new C(0, w);
		let acc = C.real(1);
		for (let i = 0; i < f.p.n; i++) acc = acc.mul(s.sub(f.p.get(i)));
		return a0 / acc.abs();
	};
	let lo = 1e-3;
	let hi = 100;
	for (let i = 0; i < 200; i++) {
		const mid = Math.sqrt(lo * hi);
		if (mag(mid) > Math.SQRT1_2) lo = mid;
		else hi = mid;
	}
	const w3 = Math.sqrt(lo * hi);
	scaleRoots(f.p, 1 / w3);
	f.p.prodNeg();
	f.k = tr;
	return f;
}

const LANDEN_STEPS = 10;

/** Descending Landen sequence of moduli. */
function landen(k0: number): number[] {
	const v: number[] = [];
	let k = k0;
	while (v.length < LANDEN_STEPS && k > 1e-16) {
		k = (k / (1 + Math.sqrt(Math.max(1 - k * k, 0)))) ** 2;
		v.push(k);
	}
	return v;
}

/** Complete elliptic integral K(k). */
export function ellipK(k: number): number {
	if (k >= 1) return Number.POSITIVE_INFINITY;
	return landen(k).reduce((a, vi) => a * (1 + vi), Math.PI / 2);
}

function landenUp(w0: C, v: readonly number[]): C {
	let w = w0;
	for (let i = v.length - 1; i >= 0; i--) {
		const vi = v[i]!;
		w = w.scale(1 + vi).div(C.real(1).add(w.mul(w).scale(vi)));
	}
	return w;
}

/** cd(u·K, k) for complex normalised u. */
export function cde(u: C, k: number): C {
	return landenUp(u.scale(Math.PI / 2).cos(), landen(k));
}

/** sn(u·K, k) for complex normalised u. */
export function sne(u: C, k: number): C {
	return landenUp(u.scale(Math.PI / 2).sin(), landen(k));
}

/** Inverse of `cde`: normalised u with cd(u·K, k) = w. */
export function acde(w0: C, k: number): C {
	const v = landen(k);
	let w = w0;
	for (let i = 0; i < v.length; i++) {
		const v1 = i === 0 ? k : v[i - 1]!;
		const s = C.real(1)
			.sub(w.mul(w).scale(v1 * v1))
			.sqrt();
		w = w.div(C.real(1).add(s)).scale(2 / (1 + v[i]!));
	}
	return w.acos().scale(2 / Math.PI);
}

/** Inverse of `sne`: sn(uK) = cd((1 − u)K). */
export function asne(w: C, k: number): C {
	return C.real(1).sub(acde(w, k));
}

function elliptic(n: number, rp: number, rs: number): Zpk {
	const ep = Math.sqrt(10 ** (rp / 10) - 1);
	const es = Math.sqrt(10 ** (rs / 10) - 1);
	const k1 = ep / es;
	const k1p = Math.sqrt(1 - k1 * k1);
	const l = Math.floor(n / 2);
	// Degree equation: k' = k1'^N · Π sn⁴(u_i K', k1').
	let kp = k1p ** n;
	for (let i = 1; i <= l; i++) {
		const ui = (2 * i - 1) / n;
		kp *= sne(C.real(ui), k1p).re ** 4;
	}
	const k = Math.sqrt(Math.max(1 - kp * kp, 0));
	// v0 = −j·asn(j/εp, k1) / N   (normalised).
	const a = asne(new C(0, 1 / ep), k1);
	const v0 = new C(a.im, -a.re).scale(1 / n);
	const f = new Zpk();
	const j = new C(0, 1);
	for (let i = 1; i <= l; i++) {
		const ui = (2 * i - 1) / n;
		const zeta = cde(C.real(ui), k);
		const zi = j.div(zeta.scale(k));
		f.z.pushC(zi);
		f.z.pushC(zi.conj());
		// p_i = j·cd((u_i − j v0)K, k)
		const c = cde(C.real(ui).sub(j.mul(v0)), k);
		const pi = new C(-c.im, c.re);
		f.p.pushC(pi);
		f.p.pushC(pi.conj());
	}
	if (n % 2 === 1) {
		// p0 = j·sn(j v0 K, k); the result is real (negative): drop the numerical imaginary residue.
		const s = sne(j.mul(v0), k);
		f.p.push(-Math.abs(-s.im), 0);
	}
	// Make sure all poles are in the left half plane.
	for (let i = 0; i < f.p.n; i++) if (f.p.re[i]! > 0) f.p.re[i] = -f.p.re[i]!;
	// Gain: H(0) = 1 (odd N) or 1/√(1+εp²) (even N).
	const h0 = n % 2 === 1 ? 1 : 1 / Math.sqrt(1 + ep * ep);
	f.z.prodNeg();
	const nr = tr;
	const ni = ti;
	f.p.prodNeg();
	cdiv(tr, ti, nr, ni);
	f.k = h0 * tr;
	return f;
}

/** (ar + j ai) / (br + j bi) → (tr, ti). */
function cdiv(ar: number, ai: number, br: number, bi: number): void {
	const d = br * br + bi * bi;
	const r = (ar * br + ai * bi) / d;
	ti = (ai * br - ar * bi) / d;
	tr = r;
}

/** √(ar + j ai) (principal) → (tr, ti). */
function csqrt(ar: number, ai: number): void {
	const r = Math.hypot(ar, ai);
	const re = Math.sqrt(Math.max((r + ar) * 0.5, 0));
	const im = Math.sqrt(Math.max((r - ar) * 0.5, 0));
	tr = re;
	ti = ai < 0 ? -im : im;
}

/** Re(Π(−z) / Π(−p)). */
function zpRatio(f: Zpk): number {
	f.z.prodNeg();
	const nr = tr;
	const ni = ti;
	f.p.prodNeg();
	cdiv(nr, ni, tr, ti);
	return tr;
}

function scaleRoots(r: Roots, s: number): void {
	for (let i = 0; i < r.n; i++) {
		r.re[i] = r.re[i]! * s;
		r.im[i] = r.im[i]! * s;
	}
}

function lpToLp(f: Zpk, wc: number): void {
	scaleRoots(f.z, wc);
	scaleRoots(f.p, wc);
	f.k *= wc ** (f.p.n - f.z.n);
}

function invertRoots(r: Roots, wc: number): void {
	for (let i = 0; i < r.n; i++) {
		cdiv(wc, 0, r.re[i]!, r.im[i]!);
		r.re[i] = tr;
		r.im[i] = ti;
	}
}

function lpToHp(f: Zpk, wc: number): void {
	const ratio = zpRatio(f);
	const degree = f.p.n - f.z.n;
	invertRoots(f.z, wc);
	invertRoots(f.p, wc);
	for (let i = 0; i < degree; i++) f.z.push(0, 0);
	f.k *= ratio;
}

/** Each root r ↦ a ± √(a² − w0²) with a = r·bw/2 (band-pass) or a = (bw/2)/r (band-stop), via `tmp`. */
function mapBand(src: Roots, tmp: Roots, w0: number, bw: number, stop: boolean): void {
	tmp.n = 0;
	for (let i = 0; i < src.n; i++) {
		let ar: number;
		let ai: number;
		if (stop) {
			cdiv(bw / 2, 0, src.re[i]!, src.im[i]!);
			ar = tr;
			ai = ti;
		} else {
			ar = (src.re[i]! * bw) / 2;
			ai = (src.im[i]! * bw) / 2;
		}
		csqrt(ar * ar - ai * ai - w0 * w0, 2 * ar * ai);
		tmp.push(ar + tr, ai + ti);
		tmp.push(ar - tr, ai - ti);
	}
	src.copyFrom(tmp);
}

function lpToBp(f: Zpk, tmp: Roots, w0: number, bw: number): void {
	const degree = f.p.n - f.z.n;
	mapBand(f.z, tmp, w0, bw, false);
	mapBand(f.p, tmp, w0, bw, false);
	for (let i = 0; i < degree; i++) f.z.push(0, 0);
	f.k *= bw ** degree;
}

function lpToBs(f: Zpk, tmp: Roots, w0: number, bw: number): void {
	const degree = f.p.n - f.z.n;
	const ratio = zpRatio(f);
	mapBand(f.z, tmp, w0, bw, true);
	mapBand(f.p, tmp, w0, bw, true);
	for (let i = 0; i < degree; i++) {
		f.z.push(0, w0);
		f.z.push(0, -w0);
	}
	f.k *= ratio;
}

/** Π(fs2 − rᵢ) as (tr, ti), then every root ↦ (fs2 + r)/(fs2 − r). */
function bilinearRoots(r: Roots, fs2: number): void {
	let pr = 1;
	let pi = 0;
	for (let i = 0; i < r.n; i++) {
		const br = fs2 - r.re[i]!;
		const bi = -r.im[i]!;
		const x = pr * br - pi * bi;
		pi = pr * bi + pi * br;
		pr = x;
		cdiv(fs2 + r.re[i]!, r.im[i]!, br, bi);
		r.re[i] = tr;
		r.im[i] = ti;
	}
	tr = pr;
	ti = pi;
}

function bilinear(f: Zpk, fs: number): void {
	const fs2 = 2 * fs;
	const degree = f.p.n - f.z.n;
	bilinearRoots(f.z, fs2);
	const nr = tr;
	const ni = ti;
	bilinearRoots(f.p, fs2);
	cdiv(nr, ni, tr, ti);
	f.k *= tr;
	for (let i = 0; i < degree; i++) f.z.push(-1, 0);
}

const REAL_EPS = 1e-7;

/** Split roots into conjugate pairs (upper-half-plane members) and real roots. */
function split(r: Roots, pairs: Roots, reals: Roots): void {
	pairs.n = 0;
	reals.n = 0;
	for (let i = 0; i < r.n; i++) {
		const re = r.re[i]!;
		const im = r.im[i]!;
		if (Math.abs(im) <= REAL_EPS * (1 + Math.hypot(re, im))) reals.push(re, 0);
		else if (im > 0) pairs.push(re, im);
	}
}

class Scratch {
	readonly f = new Zpk();
	readonly tmp = new Roots();
	readonly pp = new Roots();
	readonly pr = new Roots();
	readonly zp = new Roots();
	readonly zr = new Roots();
}
const SCRATCH = new Scratch();

function pushSection(out: Sections, b0: number, b1: number, b2: number, a1: number, a2: number): void {
	if (out.n >= MAX_SECTIONS) return;
	const o = 5 * out.n;
	out.c[o] = b0;
	out.c[o + 1] = b1;
	out.c[o + 2] = b2;
	out.c[o + 3] = a1;
	out.c[o + 4] = a2;
	out.n++;
}

function intoSections(f: Zpk, out: Sections, s: Scratch): void {
	const { pp, pr, zp, zr } = s;
	split(f.p, pp, pr);
	split(f.z, zp, zr);
	out.n = 0;
	// An odd real pole first (it needs a single real zero).
	if (pr.n % 2 === 1) {
		let i = 0;
		for (let k = 1; k < pr.n; k++) if (Math.abs(pr.re[k]!) >= Math.abs(pr.re[i]!)) i = k;
		const p = pr.re[i]!;
		pr.take(i);
		const j = zr.closest(p, 0);
		if (j >= 0) {
			const z = zr.re[j]!;
			zr.take(j);
			pushSection(out, 1, -z, 0, -p, 0);
		} else pushSection(out, 1, 0, 0, -p, 0);
	}
	// Second-order sections, highest-Q (closest to the unit circle) first.
	for (;;) {
		let a1: number;
		let a2: number;
		let cre: number;
		let cim: number;
		if (pp.n > 0) {
			let i = 0;
			for (let k = 1; k < pp.n; k++)
				if (Math.hypot(pp.re[k]!, pp.im[k]!) >= Math.hypot(pp.re[i]!, pp.im[i]!)) i = k;
			const re = pp.re[i]!;
			const im = pp.im[i]!;
			pp.take(i);
			a1 = -2 * re;
			a2 = re * re + im * im;
			cre = re;
			cim = im;
		} else if (pr.n >= 2) {
			const p1 = pr.re[0]!;
			pr.take(0);
			const p2 = pr.re[0]!;
			pr.take(0);
			a1 = -(p1 + p2);
			a2 = p1 * p2;
			cre = (p1 + p2) / 2;
			cim = 0;
		} else break;
		// Zeros: best complex pair, else two reals, else none.
		const j = zp.closest(cre, cim);
		let usePair = false;
		if (j >= 0) {
			const kr = zr.closest(cre, cim);
			const dr = kr >= 0 ? Math.hypot(zr.re[kr]! - cre, zr.im[kr]! - cim) : Number.POSITIVE_INFINITY;
			usePair = zr.n < 2 || Math.hypot(zp.re[j]! - cre, zp.im[j]! - cim) <= dr;
		}
		if (usePair) {
			const re = zp.re[j]!;
			const im = zp.im[j]!;
			zp.take(j);
			pushSection(out, 1, -2 * re, re * re + im * im, a1, a2);
		} else if (zr.n >= 2) {
			const i1 = zr.closest(cre, cim);
			const z1 = zr.re[i1]!;
			zr.take(i1);
			const i2 = zr.closest(cre, cim);
			const z2 = zr.re[i2]!;
			zr.take(i2);
			pushSection(out, 1, -(z1 + z2), z1 * z2, a1, a2);
		} else if (zr.n === 1) {
			const z1 = zr.re[0]!;
			zr.take(0);
			pushSection(out, 1, -z1, 0, a1, a2);
		} else pushSection(out, 1, 0, 0, a1, a2);
	}
	// Overall gain on the first section.
	if (out.n > 0) {
		out.c[0] = out.c[0]! * f.k;
		out.c[1] = out.c[1]! * f.k;
		out.c[2] = out.c[2]! * f.k;
	}
}

/** A normalised analog low-pass prototype (cache it: Bessel needs a root search). */
export class Prototype {
	/** @internal */
	constructor(readonly zpk: Zpk) {}
}

/** The analog prototype for a family, order, pass-band ripple and stop-band attenuation (dB). */
export function prototype(family: Family, order: number, rippleDb: number, stopDb: number): Prototype {
	const n = Math.min(Math.max(Math.round(order), 1), MAX_ORDER);
	const rp = Math.min(Math.max(rippleDb, 0.01), 10);
	const rs = Math.min(Math.max(stopDb, rp + 1), 150);
	switch (family) {
		case 'butterworth':
			return new Prototype(butterworth(n));
		case 'bessel':
			return new Prototype(bessel(n));
		case 'chebyshev':
			return new Prototype(chebyshev1(n, rp));
		case 'elliptic':
			return new Prototype(elliptic(n, rp, rs));
	}
}

/** Pre-warped analog angular frequency of `hz` (clamped to 1 Hz … 0.49·fs). */
function warp(hz: number, sampleRate: number): number {
	return 2 * sampleRate * Math.tan((Math.PI * Math.min(Math.max(hz, 1), sampleRate * 0.49)) / sampleRate);
}

/**
 * Transforms a prototype to `band` at `f1` (and `f2` for band-pass/stop; the edges may come in either order) and
 * digitises it into `out` (allocation-free).
 */
export function realize(
	proto: Prototype,
	band: Band,
	f1: number,
	f2: number,
	sampleRate: number,
	out: Sections = new Sections(),
): Sections {
	const s = SCRATCH;
	const f = s.f;
	f.copyFrom(proto.zpk);
	if (band === 'lowPass') lpToLp(f, warp(f1, sampleRate));
	else if (band === 'highPass') lpToHp(f, warp(f1, sampleRate));
	else {
		const lo = Math.min(f1, f2);
		const hi = Math.max(Math.max(f1, f2), lo * 1.001);
		const w1 = warp(lo, sampleRate);
		const w2 = warp(hi, sampleRate);
		const w0 = Math.sqrt(w1 * w2);
		const bw = Math.max(w2 - w1, 1e-6);
		if (band === 'bandPass') lpToBp(f, s.tmp, w0, bw);
		else lpToBs(f, s.tmp, w0, bw);
	}
	bilinear(f, sampleRate);
	intoSections(f, out, s);
	return out;
}

/** Design parameters. */
export type DesignSpec = {
	family: Family;
	band: Band;
	/** Prototype order (1..=MAX_ORDER). */
	order: number;
	/** Low-pass / high-pass edge, or the lower edge for band-pass / band-stop (Hz). */
	f1: number;
	/** Upper edge for band-pass / band-stop (Hz). */
	f2: number;
	/** Pass-band ripple (dB, Chebyshev / elliptic). */
	rippleDb: number;
	/** Stop-band attenuation (dB, elliptic). */
	stopDb: number;
};

/** Designs a digital filter at `sampleRate`. */
export function design(spec: DesignSpec, sampleRate: number): Sections {
	return realize(
		prototype(spec.family, spec.order, spec.rippleDb, spec.stopDb),
		spec.band,
		spec.f1,
		spec.f2,
		sampleRate,
	);
}
