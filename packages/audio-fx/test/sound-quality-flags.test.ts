// Version-2 descriptors and the judge flags they feed (spec 12 P6-E9): `rolloff95Hz` → `lowpassed`, `floorDb` →
// `noisy-floor`, `dcDb` → `dc-offset`.
import { describe, expect, it } from 'vitest';
import { Fft } from '../src/core/fft.ts';
import { Prng } from '../src/core/util.ts';
import {
	analyzeSound,
	DC_OFFSET_DB,
	DEFAULT_TYPE_PROFILES,
	judgeSound,
	LOWPASSED_ROLLOFF_HZ,
	NOISY_FLOOR_DB,
	SOUND_DESCRIPTORS_VERSION,
	type SoundDescriptors,
} from '../src/index.ts';
import { addClick, floorNoise, TAKE_SR as SR } from './take-fixtures.ts';
import { sine } from './util.ts';

/** White noise band-limited to [lo, hi] Hz (random-phase bins), peak 0.5. */
function bandNoise(seed: number, n: number, sr: number, lo: number, hi: number): Float32Array {
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	const r = new Prng(seed);
	for (let k = 1; k < n / 2; k++) {
		const f = (k * sr) / n;
		if (f < lo || f > hi) continue;
		const ph = r.unit() * 2 * Math.PI;
		re[k] = Math.cos(ph);
		im[k] = Math.sin(ph);
		re[n - k] = re[k]!;
		im[n - k] = -im[k]!;
	}
	new Fft(n).inverse(re, im);
	let peak = 0;
	for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(re[i]!));
	return Float32Array.from(re, (v) => (0.5 * v) / peak);
}

/** Hits (5 % of the time) over a floor of uniform noise at amplitude `floorAmp` (0 = digital silence). */
function hitsOverFloor(floorAmp: number): Float32Array {
	const x = floorNoise(2 * SR, floorAmp, 3);
	for (let k = 0; k < 4; k++)
		addClick(x, Math.round((0.2 + k * 0.45) * SR), { tauMs: 3, lenMs: 25, seed: k });
	return x;
}

describe('descriptors version 2', () => {
	it('is version 2', () => {
		expect(SOUND_DESCRIPTORS_VERSION).toBe(2);
	});

	it('floorDb is the 10th percentile of 20 ms RMS between the events', () => {
		// uniform noise of amplitude a has power a²/3: a = 0.005466 reads −50.0 dBFS
		const d = analyzeSound([hitsOverFloor(0.005466)], SR);
		expect(d.floorDb).not.toBeNull();
		expect(Math.abs(d.floorDb! + 50)).toBeLessThan(0.5);
		expect(analyzeSound([hitsOverFloor(0)], SR).floorDb).toBe(-120);
	});

	it('floorDb is null when there is no "between": one event, a sound that fills the file, or under 0.2 s', () => {
		expect(analyzeSound([floorNoise(SR, 0.3)], SR).floorDb).toBeNull();
		// one hit decaying over a long file: its tail is not a floor
		const one = new Float32Array(2 * SR);
		addClick(one, 4800, { tauMs: 500, lenMs: 1900, seed: 3 });
		const d1 = analyzeSound([one], SR);
		expect(d1.onsetCount).toBe(1);
		expect(d1.floorDb).toBeNull();
		const short = new Float32Array(Math.round(0.15 * SR));
		addClick(short, 100);
		expect(analyzeSound([short], SR).floorDb).toBeNull();
	});

	it('dcDb is the largest channel mean', () => {
		const x = sine(1000, 0.3, SR, SR).map((v) => v + 0.02);
		const d = analyzeSound([x, sine(1000, 0.3, SR, SR)], SR);
		expect(Math.abs(d.dcDb! - 20 * Math.log10(0.02))).toBeLessThan(0.05);
		expect(analyzeSound([new Float32Array(SR)], SR).dcDb).toBeNull();
	});

	it('cutoffHz: the cliff of a band limit; none for full-band noise, a natural slope or a tone; null under 44.1 kHz', () => {
		const at = (lo: number, hi: number, sr = SR) =>
			analyzeSound([bandNoise(7, 1 << 16, sr, lo, hi)], sr).cutoffHz;
		// the edge, or the next 250 Hz band (the analysis window's leakage)
		for (const edge of [8000, 11_000, 16_000])
			expect([edge, edge + 250], String(edge)).toContain(at(20, edge));
		expect(at(20, 23_900)).toBeNull();
		expect(at(20, 8000, 32_000)).toBeNull();
		// a natural slope (power ∝ 1/f²) and a 3 kHz tone have no cliff
		const pink = new Float32Array(1 << 16);
		const r = new Prng(9);
		let y = 0;
		for (let i = 0; i < pink.length; i++) {
			y = 0.995 * y + 0.05 * r.uniform();
			pink[i] = y;
		}
		expect(analyzeSound([pink], SR).cutoffHz).toBeNull();
		expect(analyzeSound([sine(3000, 0.5, SR, SR)], SR).cutoffHz).toBeNull();
		expect(analyzeSound([new Float32Array(SR)], SR).cutoffHz).toBeNull();
	});

	it('rolloff95Hz: full-band noise near the top, an 8 kHz lowpass under it, null under 44.1 kHz', () => {
		const wide = analyzeSound([bandNoise(1, 1 << 16, SR, 20, 23_900)], SR);
		expect(wide.rolloff95Hz!).toBeGreaterThan(21_000);
		const dull = analyzeSound([bandNoise(2, 1 << 16, SR, 20, 8000)], SR);
		expect(dull.rolloff95Hz!).toBeLessThan(8200);
		expect(dull.rolloff95Hz!).toBeGreaterThan(7000);
		expect(dull.rolloff95Hz!).toBeGreaterThanOrEqual(dull.rolloff85Hz);
		expect(analyzeSound([bandNoise(3, 1 << 15, 32_000, 20, 8000)], 32_000).rolloff95Hz).toBeNull();
		expect(analyzeSound([new Float32Array(SR)], SR).rolloff95Hz).toBeNull();
	});
});

/** A clean key press (inside every limit of `key`). */
const KEY: SoundDescriptors = {
	durationSec: 0.2,
	peakSec: 0.006,
	onsetSec: 0.005,
	riseMs: 1,
	decayMs: 20,
	decays: true,
	tailSec: 0.1,
	centroidHz: 4000,
	rolloff85Hz: 9000,
	rolloff95Hz: 15_000,
	cutoffHz: null,
	below150Share: 0.01,
	above6kShare: 0.3,
	flatness: 0.3,
	octaveBandsDb: [-50, -45, -40, -30, -25, -22, -24],
	pitchMidi: null,
	pitchConfidence: 0.1,
	onsetCount: 1,
	integratedLufs: -30,
	maxMomentaryLufs: -28,
	truePeakDb: -3,
	stereoWidth: 0,
	headQuietSec: 0.004,
	loopable: false,
	floorDb: -80,
	dcDb: null,
};

describe('judge flags lowpassed, noisy-floor, dc-offset', () => {
	const key = DEFAULT_TYPE_PROFILES.key;

	it('lowpassed: a band-limit cliff under 12 kHz for a type that needs air only (not the 95 % roll-off)', () => {
		expect(judgeSound({ ...KEY, cutoffHz: 9000 }, key).reasons).toEqual(['lowpassed']);
		expect(judgeSound({ ...KEY, cutoffHz: LOWPASSED_ROLLOFF_HZ }, key).ok).toBe(true);
		expect(judgeSound({ ...KEY, cutoffHz: null }, key).ok).toBe(true);
		expect(judgeSound({ ...KEY, rolloff95Hz: 5000 }, key).ok).toBe(true);
		const hit = { ...KEY, durationSec: 0.6, cutoffHz: 4000 };
		expect(judgeSound(hit, DEFAULT_TYPE_PROFILES.hit).reasons).not.toContain('lowpassed');
	});

	it('noisy-floor: a floor between events over −55 dBFS for one-shot types, never for beds or swells', () => {
		expect(NOISY_FLOOR_DB).toBe(-55);
		expect(judgeSound({ ...KEY, floorDb: -45 }, key).reasons).toEqual(['noisy-floor']);
		expect(judgeSound({ ...KEY, floorDb: -56 }, key).ok).toBe(true);
		expect(judgeSound({ ...KEY, floorDb: null }, key).ok).toBe(true);
		for (const t of ['riser', 'whoosh', 'ambience', 'roomtone', 'boom', 'chime', 'ui'] as const)
			expect(DEFAULT_TYPE_PROFILES[t].maxFloorDb, t).toBeNull();
	});

	it('dc-offset: a channel mean over −40 dBFS, whatever the type', () => {
		expect(DC_OFFSET_DB).toBe(-40);
		expect(judgeSound({ ...KEY, dcDb: -30 }, key).reasons).toEqual(['dc-offset']);
		expect(judgeSound({ ...KEY, dcDb: -41 }, key).ok).toBe(true);
		expect(judgeSound({ ...KEY, dcDb: -30 }, DEFAULT_TYPE_PROFILES.ambience).reasons).toContain('dc-offset');
	});

	it('the new reasons appear in order and lower the score', () => {
		const r = judgeSound({ ...KEY, cutoffHz: 6000, floorDb: -40, dcDb: -20 }, key);
		expect(r.reasons).toEqual(['lowpassed', 'noisy-floor', 'dc-offset']);
		expect(r.score).toBeLessThan(0.5);
	});

	it('version-1 descriptors (without the new fields) judge as before', () => {
		const { rolloff95Hz: _r, cutoffHz: _c, floorDb: _f, dcDb: _d, ...v1 } = KEY;
		expect(judgeSound(v1, key)).toEqual({ ok: true, score: 1, reasons: [] });
		expect(judgeSound({ ...v1, onsetCount: 3 }, key).reasons).toEqual(['multi-hit']);
	});

	it('a measured key band-limited at 8 kHz (a low-bitrate encode) is lowpassed; the same key full-band is not', () => {
		// a key press (broadband, sharp attack), then band-limited as a whole the way an encoder does
		const press = (hi: number) => {
			const n = 1 << 14;
			const re = new Float64Array(n);
			const im = new Float64Array(n);
			const r = new Prng(4);
			for (let i = 0; i < 4800; i++) re[240 + i] = 0.5 * r.uniform() * Math.exp(-i / 300);
			const fft = new Fft(n);
			fft.forward(re, im);
			for (let k = 1; k < n / 2; k++)
				if ((k * SR) / n > hi) {
					re[k] = im[k] = re[n - k] = im[n - k] = 0;
				}
			fft.inverse(re, im);
			return analyzeSound([Float32Array.from(re.subarray(0, Math.round(0.3 * SR)), (v) => v / n)], SR);
		};
		const cut = press(8000);
		expect([8000, 8250]).toContain(cut.cutoffHz);
		expect(judgeSound(cut, key).reasons).toContain('lowpassed');
		const full = press(23_900);
		expect(full.cutoffHz).toBeNull();
		expect(judgeSound(full, key).reasons).not.toContain('lowpassed');
	});
});
