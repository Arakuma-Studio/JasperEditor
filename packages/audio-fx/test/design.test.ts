// Classical IIR design (core/design.ts; port of the filmcraft `design.rs` tests plus analytic checks: Butterworth
// −3.01 dB corner and 6·N dB/oct asymptote, Chebyshev ripple = parameter, elliptic stop band ≥ attenuation).
import { describe, expect, it } from 'vitest';
import {
	asne,
	type Band,
	C,
	cde,
	type DesignSpec,
	design,
	ellipK,
	type Family,
	sne,
} from '../src/core/design.ts';
import { SR } from './util.ts';

function spec(family: Family, band: Band, order: number, f1: number, f2: number): DesignSpec {
	return { family, band, order, f1, f2, rippleDb: 1, stopDb: 60 };
}

const wa = (f: number) => Math.tan((Math.PI * f) / SR);

describe('IIR design (analog prototypes → bilinear → SOS)', () => {
	it('Butterworth matches the closed form (pre-warped), −3.01 dB at the cutoff', () => {
		for (let n = 1; n <= 12; n++) {
			for (const band of ['lowPass', 'highPass'] as const) {
				const s = design(spec('butterworth', band, n, 1000, 0), SR);
				expect(s.n).toBe(Math.ceil(n / 2));
				for (const f of [100, 500, 1000, 2000, 8000]) {
					const r = band === 'lowPass' ? wa(f) / wa(1000) : wa(1000) / wa(f);
					const want = -10 * Math.log10(1 + r ** (2 * n));
					expect(Math.abs(s.magnitudeDb(f, SR) - want), `n=${n} ${band} f=${f}`).toBeLessThan(1e-6);
				}
				expect(Math.abs(s.magnitudeDb(1000, SR) + 3.0103)).toBeLessThan(1e-3);
			}
		}
	});

	it('Butterworth stop band falls 6·N dB per octave', () => {
		for (let n = 1; n <= 10; n++) {
			const lp = design(spec('butterworth', 'lowPass', n, 20, 0), SR);
			const slope = lp.magnitudeDb(400, SR) - lp.magnitudeDb(800, SR);
			expect(Math.abs(slope - 6.0206 * n), `lp n=${n}: ${slope}`).toBeLessThan(0.02 * n);
			const hp = design(spec('butterworth', 'highPass', n, 8000, 0), SR);
			const hslope = hp.magnitudeDb(400, SR) - hp.magnitudeDb(200, SR);
			expect(Math.abs(hslope - 6.0206 * n), `hp n=${n}: ${hslope}`).toBeLessThan(0.02 * n);
		}
	});

	it('Bessel is −3 dB at the cutoff and monotonic', () => {
		for (let n = 1; n <= 10; n++) {
			const s = design(spec('bessel', 'lowPass', n, 2000, 0), SR);
			expect(Math.abs(s.magnitudeDb(2000, SR) + 3.0103), `n=${n}`).toBeLessThan(0.02);
			expect(Math.abs(s.magnitudeDb(1, SR))).toBeLessThan(1e-5);
			let last = 1;
			for (let i = 1; i < 200; i++) {
				const m = s.magnitudeDb(i * 100, SR);
				expect(m).toBeLessThanOrEqual(last + 1e-9);
				last = m;
			}
		}
	});

	it('Chebyshev I ripple stays within the bound and reaches it', () => {
		for (let n = 2; n <= 8; n++) {
			const s = design({ ...spec('chebyshev', 'lowPass', n, 1000, 0), rippleDb: 0.5 }, SR);
			let min = Number.POSITIVE_INFINITY;
			let max = Number.NEGATIVE_INFINITY;
			for (let i = 1; i < 100; i++) {
				const m = s.magnitudeDb(i * 10, SR);
				min = Math.min(min, m);
				max = Math.max(max, m);
			}
			expect(max, `n=${n}`).toBeLessThan(1e-6);
			expect(min, `n=${n}`).toBeGreaterThan(-0.5 - 1e-6);
			expect(min, `ripple reaches the bound (n=${n})`).toBeLessThan(-0.45);
			expect(Math.abs(s.magnitudeDb(1000, SR) + 0.5)).toBeLessThan(1e-3);
		}
	});

	it('Chebyshev I pass-band ripple equals the parameter', () => {
		for (const rp of [0.1, 1, 3, 6])
			for (const n of [3, 4, 7]) {
				const s = design({ ...spec('chebyshev', 'lowPass', n, 2000, 0), rippleDb: rp }, SR);
				let min = Number.POSITIVE_INFINITY;
				let max = Number.NEGATIVE_INFINITY;
				for (let f = 1; f <= 2000; f += 1) {
					const m = s.magnitudeDb(f, SR);
					min = Math.min(min, m);
					max = Math.max(max, m);
				}
				expect(Math.abs(max - min - rp), `rp=${rp} n=${n}: ${max - min}`).toBeLessThan(0.002 * rp + 1e-4);
				expect(Math.abs(s.magnitudeDb(2000, SR) + rp)).toBeLessThan(1e-6 + 1e-3 * rp);
			}
	});

	it('elliptic meets its pass-band ripple and stop-band attenuation', () => {
		for (let n = 2; n <= 8; n++) {
			for (const [rp, rs] of [
				[1, 60],
				[0.1, 40],
				[0.5, 80],
			] as const) {
				const s = design({ ...spec('elliptic', 'lowPass', n, 1000, 0), rippleDb: rp, stopDb: rs }, SR);
				let max = Number.NEGATIVE_INFINITY;
				let min = Number.POSITIVE_INFINITY;
				for (let i = 1; i <= 100; i++) {
					const m = s.magnitudeDb(i * 10, SR);
					min = Math.min(min, m);
					max = Math.max(max, m);
				}
				expect(max).toBeLessThan(1e-6);
				expect(min, `n=${n} rp=${rp}`).toBeGreaterThan(-rp - 1e-3);
				let below = false;
				for (let i = 1; i < 2390; i++) {
					const m = s.magnitudeDb(i * 10, SR);
					if (m < -rs) below = true;
					if (below && m >= -rs + 0.05) throw new Error(`n=${n} rs=${rs} f=${i * 10}: ${m}`);
				}
				expect(below, `n=${n} rs=${rs}: stop band reached`).toBe(true);
			}
		}
		const e = design(spec('elliptic', 'lowPass', 4, 1000, 0), SR);
		const b = design(spec('butterworth', 'lowPass', 4, 1000, 0), SR);
		expect(e.magnitudeDb(1500, SR)).toBeLessThan(b.magnitudeDb(1500, SR) - 10);
	});

	it('high-pass, band-pass and band-stop shapes for every family', () => {
		for (const fam of ['butterworth', 'chebyshev', 'elliptic', 'bessel'] as const) {
			const hp = design(spec(fam, 'highPass', 4, 1000, 0), SR);
			expect(hp.magnitudeDb(10000, SR), `${fam} hp pass`).toBeGreaterThan(-1.1);
			expect(hp.magnitudeDb(100, SR), `${fam} hp stop`).toBeLessThan(-40);
			const bp = design(spec(fam, 'bandPass', 3, 500, 2000), SR);
			expect(bp.magnitudeDb(1000, SR), `${fam} bp centre`).toBeGreaterThan(-3.5);
			expect(bp.magnitudeDb(50, SR)).toBeLessThan(-30);
			expect(bp.magnitudeDb(15000, SR)).toBeLessThan(-25);
			const bs = design(spec(fam, 'bandStop', 3, 500, 2000), SR);
			expect(bs.magnitudeDb(1000, SR), `${fam} bs centre`).toBeLessThan(-20);
			expect(bs.magnitudeDb(30, SR)).toBeGreaterThan(-1.1);
			expect(bs.magnitudeDb(18000, SR)).toBeGreaterThan(-1.1);
		}
		// Butterworth band edges are the −3 dB points (edges in either order).
		const bp = design(spec('butterworth', 'bandPass', 4, 2000, 500), SR);
		expect(Math.abs(bp.magnitudeDb(500, SR) + 3.0103)).toBeLessThan(1e-3);
		expect(Math.abs(bp.magnitudeDb(2000, SR) + 3.0103)).toBeLessThan(1e-3);
		expect(Math.abs(bp.magnitudeDb(Math.sqrt(500 * 2000), SR))).toBeLessThan(0.05);
	});

	it('complex helpers and Jacobi elliptic functions', () => {
		const w = new C(0.3, -0.7);
		expect(w.acos().cos().sub(w).abs()).toBeLessThan(1e-12);
		expect(Math.abs(new C(-4, 0).sqrt().im - 2)).toBeLessThan(1e-12);
		expect(Math.abs(ellipK(0) - Math.PI / 2)).toBeLessThan(1e-12);
		// K(1/√2) = Γ(1/4)² / (4√π)
		expect(Math.abs(ellipK(Math.SQRT1_2) - 1.854074677301372)).toBeLessThan(1e-12);
		// sn(K, k) = 1; cd(0, k) = 1
		expect(Math.abs(sne(C.real(1), 0.7).re - 1)).toBeLessThan(1e-9);
		expect(Math.abs(cde(C.real(0), 0.7).re - 1)).toBeLessThan(1e-9);
		const u = asne(C.real(0.5), 0.7);
		expect(Math.abs(sne(u, 0.7).re - 0.5)).toBeLessThan(1e-9);
	});

	it('every design is stable (all poles inside the unit circle)', () => {
		for (const family of ['bessel', 'butterworth', 'chebyshev', 'elliptic'] as const)
			for (const band of ['lowPass', 'highPass', 'bandPass', 'bandStop'] as const)
				for (const order of [1, 2, 5, 12])
					for (const [f1, f2] of [
						[20, 20000],
						[1000, 1100],
						[20000, 20],
					] as const) {
						const s = design({ family, band, order, f1, f2, rippleDb: 6, stopDb: 120 }, SR);
						for (let i = 0; i < s.n; i++) {
							const { a1, a2 } = s.coeffs(i);
							// Jury: |a2| < 1 and |a1| < 1 + a2.
							expect(Math.abs(a2), `${family} ${band} ${order}`).toBeLessThan(1);
							expect(Math.abs(a1)).toBeLessThan(1 + a2);
						}
					}
	});
});
