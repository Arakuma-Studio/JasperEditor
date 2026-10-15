import { TruePeakDetector } from '@jasper/audio-dsp';
import { describe, expect, it } from 'vitest';
import { dbToGain } from '../src/core/math.ts';
import { createProcessor } from '../src/registry.ts';
import { noise, SR, sine, toneAmplitude } from './util.ts';

const lin = (x: number) => 20 * Math.log10(Math.max(Math.abs(x), 1e-12));
function fx(id: string, params: Record<string, number | boolean | string> = {}, ch = 2) {
	const e = createProcessor(`jasper.audio.${id}`, SR, ch)!;
	for (const [k, v] of Object.entries(params)) expect(e.setParam(k, v), `${id}.${k}`).toBe(true);
	e.reset();
	return e;
}

/** Giannoulis, Massberg & Reiss 2012, eq. (4). */
function gmr(x: number, T: number, R: number, W: number): number {
	if (2 * (x - T) < -W || (W === 0 && x <= T)) return x;
	if (W > 0 && 2 * Math.abs(x - T) <= W) return x + ((1 / R - 1) * (x - T + W / 2) ** 2) / (2 * W);
	return T + (x - T) / R;
}

describe('compressor static curve', () => {
	it('steady-state output and transferDb match the textbook curve (peak and RMS detectors)', () => {
		for (const [T, R, W, det] of [
			[-20, 4, 0, 'peak'],
			[-30, 8, 6, 'peak'],
			[-18, 3, 12, 'rms'],
		] as const) {
			const c = fx('single-band-compressor', {
				threshold: T,
				ratio: R,
				knee: W,
				output: 2,
				detector: det,
				release: 50,
			});
			for (const inDb of [-50, -30, -20, -10, -3]) {
				c.reset();
				const amp = dbToGain(inDb);
				// DC-like constant level: peak = level; for RMS use a square wave (RMS = peak).
				const n = SR;
				const l = new Float32Array(n);
				for (let i = 0; i < n; i++) l[i] = (Math.floor(i / 48) % 2 ? -1 : 1) * amp;
				const r = l.slice();
				c.process([l, r], 0, n);
				const out = lin(l[n - 1]!);
				const expected = gmr(inDb, T, R, W) + 2;
				expect(Math.abs(out - expected), `${T}/${R}/${W}/${det} @${inDb}`).toBeLessThan(0.2);
				expect(c.transferDb!(0, inDb)).toBeCloseTo(expected, 9);
			}
		}
	});

	it('attack and release time constants (63 % of the change in dB) are within 15 % of the params', () => {
		const att = 10;
		const rel = 200;
		const c = fx(
			'single-band-compressor',
			{ threshold: -20, ratio: 20, knee: 0, attack: att, release: rel },
			1,
		);
		const n = SR;
		const x = new Float32Array(n);
		x.fill(1, 0, SR / 2);
		x.fill(0.01, SR / 2);
		const y = x.slice();
		c.process([y], 0, n);
		const final = -19; // −20 + (0 − (−20)) / 20 = −19 dB gain reduction.
		const gr = (i: number) => lin(y[i]!) - lin(x[i]!);
		let tA = 0;
		while (gr(tA) > 0.632 * final) tA++;
		expect(Math.abs(tA / (SR / 1000) - att) / att).toBeLessThan(0.15);
		// Release: from −19 dB back toward 0 (the quiet part is below the threshold).
		const start = SR / 2;
		const g0 = gr(start);
		let tR = start;
		while (gr(tR) < g0 * (1 - 0.632)) tR++;
		expect(Math.abs((tR - start) / (SR / 1000) - rel) / rel).toBeLessThan(0.15);
	});
});

describe('Hard Limiter', () => {
	const signals = (): [string, Float32Array, Float32Array][] => {
		const n = SR;
		const sq = new Float32Array(n);
		for (let i = 0; i < n; i++) sq[i] = Math.floor(i / 60) % 2 ? -1 : 1;
		const imp = new Float32Array(n);
		for (let i = 1000; i < n; i += 4801) imp[i] = i % 2 ? 4 : -3;
		const fs4 = new Float32Array(n);
		for (let i = 0; i < n; i++) fs4[i] = Math.sin((Math.PI / 2) * i + Math.PI / 4);
		return [
			['noise', noise(1, n, 1), noise(2, n, 0.6)],
			['sine', sine(997, 1, SR, n), sine(440, 0.9, SR, n)],
			['square', sq, sq.slice()],
			['impulses', imp, imp.slice()],
			['fs/4 at 45°', fs4, fs4.slice()],
		];
	};

	it('never exceeds Maximum Amplitude (sample peak), at any boost, in random blocks', () => {
		for (const tp of [false, true])
			for (const boost of [0, 12, 24])
				for (const [name, a, b] of signals()) {
					const lim = fx('hard-limiter', { maxAmplitude: -1, inputBoost: boost, truePeak: tp });
					const ceil = 0.8912509381337456; // 10^(−1/20), independent −1 dBFS amplitude.
					const l = a.slice();
					const r = b.slice();
					let pos = 0;
					let k = 3;
					while (pos < l.length) {
						k = (k * 1103515245 + 12345) >>> 0;
						const len = Math.min(l.length - pos, 1 + (k % 700));
						lim.process([l, r], pos, pos + len);
						pos += len;
					}
					let worst = 0;
					for (let i = 0; i < l.length; i++) worst = Math.max(worst, Math.abs(l[i]!), Math.abs(r[i]!));
					expect(worst, `${name} tp=${tp} boost=${boost}`).toBeLessThanOrEqual(ceil + 1e-6);
				}
	});

	it('with True Peak the 4× interpolated true peak stays within ceiling + 0.1 dB', () => {
		for (const [name, a, b] of signals()) {
			const lim = fx('hard-limiter', { maxAmplitude: -1, inputBoost: 12, truePeak: true });
			const l = a.slice();
			const r = b.slice();
			lim.process([l, r], 0, l.length);
			const det = new TruePeakDetector(SR, 2);
			det.process([l, r]);
			expect(det.truePeakDb(), name).toBeLessThanOrEqual(-1 + 0.1);
		}
	});

	it('is a pure delay below the ceiling; latency equals the measured impulse delay', () => {
		for (const tp of [false, true]) {
			const lim = fx('hard-limiter', { truePeak: tp, lookAhead: 5 }, 1);
			const lat = lim.latency();
			expect(lat).toBeGreaterThan(0);
			const x = new Float32Array(4800);
			x[100] = 0.5;
			const y = x.slice();
			lim.process([y], 0, y.length);
			let at = 0;
			for (let i = 0; i < y.length; i++) if (Math.abs(y[i]!) > Math.abs(y[at]!)) at = i;
			expect(at - 100).toBe(lat);
			expect(y[at]).toBeCloseTo(0.5, 6);
			const s = sine(1000, 0.3, SR, 4800);
			const z = s.slice();
			lim.reset();
			lim.process([z], 0, z.length);
			for (let i = lat; i < 4800; i++) expect(Math.abs(z[i]! - s[i - lat]!)).toBeLessThan(1e-6);
		}
	});

	it('brings a loud sine to the ceiling smoothly', () => {
		const lim = fx('hard-limiter', { maxAmplitude: -6 }, 1);
		const x = sine(200, 1, SR, SR);
		lim.process([x], 0, x.length);
		let pk = 0;
		for (let i = SR / 2; i < SR; i++) pk = Math.max(pk, Math.abs(x[i]!));
		expect(Math.abs(lin(pk) + 6)).toBeLessThan(0.3);
		expect(lim.meters!()[0]!).toBeLessThan(-5);
	});
});

describe('gate, rack, multiband, tube', () => {
	it('Expander / Gate attenuates by the range below the threshold and holds', () => {
		const g = fx('expander-gate', { threshold: -30, ratio: 100, range: 40, hold: 100, release: 10 }, 1);
		const loud = dbToGain(-10);
		const quiet = dbToGain(-50);
		const x = new Float32Array(SR);
		for (let i = 0; i < SR; i++) x[i] = i < SR / 2 ? loud : quiet;
		g.process([x], 0, SR);
		expect(Math.abs(lin(x[SR / 2 - 1]!) + 10)).toBeLessThan(0.01);
		expect(Math.abs(lin(x[SR / 2 + 2400]!) + 50)).toBeLessThan(0.01);
		expect(Math.abs(lin(x[SR - 1]!) + 90)).toBeLessThan(0.1);
		expect(g.transferDb!(0, -40)).toBeCloseTo(-80, 6);
	});

	it('Dynamics rack: compressor section follows its curve; auto makeup; gate closes; soft clip bounded', () => {
		const r = fx('dynamics', { compThreshold: -20, compRatio: 4 });
		expect(r.transferDb!(0, 0)).toBeCloseTo(-15, 6);
		const auto = fx('dynamics', { compThreshold: -20, compRatio: 4, compAuto: true });
		expect(auto.transferDb!(0, 0)).toBeCloseTo(-15 + 7.5, 6);
		const gate = fx(
			'dynamics',
			{ gateOn: true, gateThreshold: -40, compOn: false, gateRelease: 5, gateHold: 0 },
			1,
		);
		const x = new Float32Array(SR).fill(dbToGain(-60));
		gate.process([x], 0, SR);
		expect(lin(x[SR - 1]!)).toBeLessThan(-130);
		expect(gate.meters!()[0]!).toBeLessThan(-70);
		const lim = fx('dynamics', { compOn: false, limOn: true, limThreshold: -6, softClip: true }, 1);
		const s = sine(100, 1, SR, SR);
		lim.process([s], 0, SR);
		for (let i = 0; i < SR; i++) expect(Math.abs(s[i]!)).toBeLessThanOrEqual(0.5011872336272722 + 1e-6);
	});

	it('Multiband crossovers sum flat (±0.1 dB) when no band compresses', () => {
		for (const f of [40, 120, 500, 2000, 6000, 10000, 15000]) {
			const m = fx('multiband-compressor', {
				b1Threshold: 0,
				b2Threshold: 0,
				b3Threshold: 0,
				b4Threshold: 0,
			});
			const x = sine(f, 0.25, SR, SR);
			const y = x.slice();
			m.process([y, x.slice()], 0, SR);
			const g = 20 * Math.log10(toneAmplitude(y, f, SR, SR / 2, SR) / 0.25);
			expect(Math.abs(g), `${f} Hz`).toBeLessThan(0.1);
		}
		const solo = fx('multiband-compressor', { b4Solo: true });
		const low = sine(60, 0.25, SR, SR);
		solo.process([low, low.slice()], 0, SR);
		expect(toneAmplitude(low, 60, SR, SR / 2, SR)).toBeLessThan(0.01);
	});

	it('Multiband compresses only the band over its threshold and meters it', () => {
		const m = fx('multiband-compressor', {
			b1Threshold: -40,
			b1Ratio: 10,
			b2Threshold: 0,
			b3Threshold: 0,
			b4Threshold: 0,
		});
		const x = sine(60, 0.5, SR, SR);
		m.process([x, x.slice()], 0, SR);
		expect(m.meters!()[0]!).toBeLessThan(-10);
		expect(m.meters!()[2]!).toBe(0);
	});

	it('Tube-modeled compressor is near-transparent at low level and compresses loud signals', () => {
		const t = fx('tube-compressor');
		const q = sine(1000, 0.01, SR, SR);
		const qy = q.slice();
		t.process([qy, q.slice()], 0, SR);
		expect(Math.abs(20 * Math.log10(toneAmplitude(qy, 1000, SR, SR / 2, SR) / 0.01))).toBeLessThan(0.05);
		t.reset();
		const l = sine(1000, 1, SR, SR);
		t.process([l, l.slice()], 0, SR);
		expect(toneAmplitude(l, 1000, SR, SR / 2, SR)).toBeLessThan(0.6);
	});
});
