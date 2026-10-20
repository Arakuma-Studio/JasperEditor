// Classical filter responses are observed through the processor API used by the EQ editor.
import { describe, expect, it } from 'vitest';
import { createProcessor } from '../src/registry.ts';
import { SR } from './util.ts';

function filter(type: string, mode: string, order: number, cutoff: number, highCutoff = 2000) {
	const effect = createProcessor('jasper.audio.scientific-filter', SR, 1)!;
	for (const [name, value] of Object.entries({
		type,
		mode,
		order,
		cutoff,
		highCutoff,
		ripple: 1,
		stopAtten: 60,
	}))
		expect(effect.setParam(name, value)).toBe(true);
	return (frequency: number) => effect.responseDb!(frequency)!;
}

describe('Scientific Filter family responses', () => {
	it('Bessel is −3 dB at the cutoff and monotonic', () => {
		for (let n = 1; n <= 10; n++) {
			const s = filter('bessel', 'lowPass', n, 2000);
			expect(Math.abs(s(2000) + 3.0103), `n=${n}`).toBeLessThan(0.02);
			expect(Math.abs(s(1))).toBeLessThan(1e-5);
			let last = 1;
			for (let i = 1; i < 200; i++) {
				const m = s(i * 100);
				expect(m).toBeLessThanOrEqual(last + 1e-9);
				last = m;
			}
		}
	});

	it('high-pass, band-pass and band-stop shapes for every family', () => {
		for (const fam of ['butterworth', 'chebyshev', 'elliptic', 'bessel'] as const) {
			const hp = filter(fam, 'highPass', 4, 1000);
			expect(hp(10000), `${fam} hp pass`).toBeGreaterThan(-1.1);
			expect(hp(100), `${fam} hp stop`).toBeLessThan(-40);
			const bp = filter(fam, 'bandPass', 3, 500, 2000);
			expect(bp(1000), `${fam} bp centre`).toBeGreaterThan(-3.5);
			expect(bp(50)).toBeLessThan(-30);
			expect(bp(15000)).toBeLessThan(-25);
			const bs = filter(fam, 'bandStop', 3, 500, 2000);
			expect(bs(1000), `${fam} bs centre`).toBeLessThan(-20);
			expect(bs(30)).toBeGreaterThan(-1.1);
			expect(bs(18000)).toBeGreaterThan(-1.1);
		}
		// Butterworth band edges are the −3 dB points (edges in either order).
		const bp = filter('butterworth', 'bandPass', 4, 2000, 500);
		expect(Math.abs(bp(500) + 3.0103)).toBeLessThan(1e-3);
		expect(Math.abs(bp(2000) + 3.0103)).toBeLessThan(1e-3);
		expect(Math.abs(bp(Math.sqrt(500 * 2000)))).toBeLessThan(0.05);
	});
});
