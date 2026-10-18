// Reference-profile metrics (spec 12 §4 P6-E8; wp-note "Phase 6 → WP-E4"): the "Done when" known answers — −20 LUFS
// pink noise (and its octave-band shares, an oracle independent of our meters: pink noise has equal energy per octave),
// a 1 s gap, a hard end against a 2 s fade, clicks at 2/s giving 2 onsets/s, a 0.5 cut/s picture — plus the stereo
// width of identical and independent channels, block-size independence and hostile input that never throws.
import { measureLoudness } from '@jasper/audio-dsp';
import { REFERENCE_METRIC_KEYS, REFERENCE_MONO_DB } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Prng } from '../src/core/util.ts';
import { type ProfilePicture, type ProfileResult, ProfileMeter } from '../src/index.ts';

const SR = 48_000;

/** Pink noise (Paul Kellet's refined filter on white noise; ±0.05 dB from 10 Hz to Nyquist at 44.1–48 kHz). */
function pink(n: number, seed: number): Float32Array {
	const r = new Prng(seed);
	const out = new Float32Array(n);
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	let b3 = 0;
	let b4 = 0;
	let b5 = 0;
	let b6 = 0;
	for (let i = 0; i < n; i++) {
		const w = r.uniform();
		b0 = 0.99886 * b0 + w * 0.0555179;
		b1 = 0.99332 * b1 + w * 0.0750759;
		b2 = 0.969 * b2 + w * 0.153852;
		b3 = 0.8665 * b3 + w * 0.3104856;
		b4 = 0.55 * b4 + w * 0.5329522;
		b5 = -0.7616 * b5 - w * 0.016898;
		out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
		b6 = w * 0.115926;
	}
	return out;
}

/** Scales planar audio to an integrated loudness (BS.1770, `measureLoudness`). */
function toLufs(planar: Float32Array[], lufs: number): Float32Array[] {
	const m = measureLoudness(planar, SR);
	const g = 10 ** ((lufs - m.integrated) / 20);
	return planar.map((c) => c.map((v) => v * g));
}

function measure(planar: Float32Array[], block = 4800, picture?: ProfilePicture | null): ProfileResult {
	const meter = new ProfileMeter(SR, planar.length);
	const n = planar[0]!.length;
	for (let i = 0; i < n; i += block) {
		const k = Math.min(block, n - i);
		meter.push(
			planar.map((c) => c.subarray(i, i + k)),
			k,
		);
	}
	return meter.finish(picture);
}

const sec = (s: number) => Math.round(s * SR);
function concat(...parts: Float32Array[]): Float32Array {
	const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
/** A 1 ms click (a decaying 3 kHz burst) at each time, over a quiet pink bed (−60 dBFS-ish). */
function clicks(durSec: number, times: readonly number[], seed = 3): Float32Array {
	const x = pink(sec(durSec), seed).map((v) => v * 0.0005);
	for (const t of times) {
		const at = sec(t);
		for (let i = 0; i < sec(0.02) && at + i < x.length; i++)
			x[at + i]! += 0.6 * Math.exp(-i / (SR * 0.002)) * Math.sin((2 * Math.PI * 3000 * i) / SR);
	}
	return x;
}

describe('ProfileMeter known answers (spec 12 P6-E8)', () => {
	it('−20 LUFS pink noise: integrated −20, octave-band shares as pink noise has them', () => {
		const L = pink(sec(20), 1);
		const R = pink(sec(20), 2);
		const r = measure(toLufs([L, R], -20));
		expect(r.unscorable).toBeNull();
		const m = r.measurement.metrics;
		expect(m.lufs_i).toBeCloseTo(-20, 1);
		// equal energy per octave: a band's share is its octaves over the 20 Hz–16 kHz total (9.644 octaves)
		const total = Math.log2(16000 / 20);
		const want = (a: number, b: number) => 10 * Math.log10(Math.log2(b / a) / total);
		expect(Math.abs(m.band_low! - want(60, 250))).toBeLessThan(0.5);
		expect(Math.abs(m.band_lowmid! - want(250, 1000))).toBeLessThan(0.5);
		expect(Math.abs(m.band_mid! - want(1000, 4000))).toBeLessThan(0.5);
		expect(Math.abs(m.band_presence! - want(4000, 8000))).toBeLessThan(0.5);
		expect(Math.abs(m.band_air! - want(8000, 16000))).toBeLessThan(0.5);
		// 20–60 Hz is 3–5 bins of an 85 ms frame: within 1 dB
		expect(Math.abs(m.band_sub! - want(20, 60))).toBeLessThan(1);
		// stationary noise: a small loudness range, no gap, sound from the start to the end
		expect(m.lra!).toBeLessThan(2);
		expect(m.first_sound_s!).toBeLessThan(0.02);
		expect(m.end_silence_s!).toBeLessThan(0.02);
		expect(m.max_gap_s).toBe(0);
		// independent channels: side ≈ mid, correlation ≈ 0
		expect(Math.abs(m.side_to_mid_db!)).toBeLessThan(0.3);
		expect(Math.abs(m.correlation!)).toBeLessThan(0.05);
		expect(r.measurement.mono).toBe(false);
		// the brightness of pink noise lies between 1 and 6 kHz (magnitude-weighted centroid over 20 Hz–16 kHz)
		expect(m.brightness_hz!).toBeGreaterThan(1000);
		expect(m.brightness_hz!).toBeLessThan(6000);
		expect(r.measurement.arc).toHaveLength(11);
		for (const p of r.measurement.arc!) expect(Math.abs(p!)).toBeLessThan(1);
	});

	it('identical channels read as a mono mix (−40 dB, correlation 1)', () => {
		const x = toLufs([pink(sec(12), 4)], -23)[0]!;
		const m = measure([x, x]).measurement;
		expect(m.mono).toBe(true);
		expect(m.metrics.side_to_mid_db).toBe(REFERENCE_MONO_DB);
		expect(m.metrics.correlation).toBe(1);
	});

	it('a 1 s gap reads 1 s; a 2 s silent start reads 2 s to the first sound', () => {
		const a = pink(sec(5), 5).map((v) => v * 0.2);
		const b = pink(sec(5), 6).map((v) => v * 0.2);
		const r = measure([concat(a, new Float32Array(sec(1)), b)]);
		expect(r.measurement.metrics.max_gap_s!).toBeGreaterThan(0.95);
		expect(r.measurement.metrics.max_gap_s!).toBeLessThan(1.05);
		expect(r.events.gaps).toHaveLength(1);
		expect(r.events.gaps[0]![0]).toBeCloseTo(5, 1);
		expect(r.events.gaps[0]![1]).toBeCloseTo(6, 1);
		const late = measure([concat(new Float32Array(sec(2)), a, b)]);
		expect(late.measurement.metrics.first_sound_s!).toBeGreaterThan(1.98);
		expect(late.measurement.metrics.first_sound_s!).toBeLessThan(2.02);
	});

	it('a hard end against a 2 s fade, and 2 s of dead air', () => {
		const body = pink(sec(12), 7).map((v) => v * 0.2);
		const hard = measure([body]).measurement.metrics;
		expect(hard.fade_s!).toBeLessThan(0.5);
		expect(hard.end_silence_s!).toBeLessThan(0.02);
		const faded = body.slice();
		const f0 = faded.length - sec(2);
		for (let i = f0; i < faded.length; i++) faded[i]! *= 1 - (i - f0) / sec(2);
		const fade = measure([faded]).measurement.metrics;
		expect(fade.fade_s!).toBeGreaterThan(0.6);
		expect(fade.fade_s!).toBeLessThan(2);
		expect(fade.fade_s!).toBeGreaterThan(hard.fade_s! + 0.5);
		const dead = measure([concat(body, new Float32Array(sec(2)))]).measurement.metrics;
		expect(dead.end_silence_s!).toBeGreaterThan(1.97);
		expect(dead.end_silence_s!).toBeLessThan(2.03);
		expect(dead.max_gap_s).toBe(0);
	});

	it('clicks at 2/s give 2 onsets/s; each is a salient hit', () => {
		const times = Array.from({ length: 40 }, (_, i) => 0.25 + i * 0.5);
		const r = measure([clicks(20, times)]);
		expect(r.measurement.metrics.onset_rate!).toBeGreaterThan(1.95);
		expect(r.measurement.metrics.onset_rate!).toBeLessThan(2.05);
		expect(r.events.onsetsSec).toHaveLength(40);
		for (let i = 0; i < 40; i++) expect(Math.abs(r.events.onsetsSec[i]! - times[i]!)).toBeLessThan(0.002);
		expect(r.measurement.metrics.hit_rate!).toBeGreaterThan(1.5);
	});

	it('a 0.5 cut/s picture: 0.5 events/s; sync shares with their chance', () => {
		const cuts = Array.from({ length: 10 }, (_, i) => 1 + i * 2);
		const on = measure([clicks(20, cuts)], 4800, { timesSec: cuts, fps: 25 });
		const m = on.measurement.metrics;
		expect(m.cut_rate).toBeCloseTo(0.5, 3);
		expect(m.cuts_with_sound).toBe(1);
		expect(m.cut_frame_sync).toBe(1);
		// ten onsets of ±100 ms over 20 s: chance 10 · 0.2 / 20 = 0.1; ±40 ms: 0.04
		expect(on.measurement.chance.cuts_with_sound).toBeCloseTo(0.1, 2);
		expect(on.measurement.chance.cut_frame_sync).toBeCloseTo(0.04, 2);
		expect(on.events.picture.silentSec).toEqual([]);
		// the clicks 300 ms after the cuts: none answered
		const off = measure(
			[clicks(20, cuts.map((t) => t + 0.3))],
			4800,
			{ timesSec: cuts, fps: 25 },
		);
		expect(off.measurement.metrics.cuts_with_sound).toBe(0);
		expect(off.events.picture.withoutOnsetSec).toHaveLength(10);
		expect(off.events.picture.silentSec).toHaveLength(10);
		// without a picture: no sync rows
		const none = measure([clicks(20, cuts)]).measurement.metrics;
		expect(none.cut_rate).toBeNull();
		expect(none.cuts_with_sound).toBeNull();
	});

	it('under 10 s the loudness shape is n.a.; under 3 s or silent nothing is scored', () => {
		const short = measure([pink(sec(6), 8).map((v) => v * 0.2)]);
		expect(short.unscorable).toBeNull();
		for (const k of ['lra', 'crest_lu', 'intro_lu', 'end_lu', 'final_lu'] as const)
			expect(short.measurement.metrics[k]).toBeNull();
		expect(short.measurement.metrics.onset_rate).not.toBeNull();
		expect(measure([pink(sec(2), 9)]).unscorable).toMatch(/shorter than 3 s/);
		expect(measure([new Float32Array(sec(5))]).unscorable).toMatch(/silent/);
	});

	it('is independent of the block size', () => {
		const x = concat(clicks(6, [0.5, 1.7, 3.1]), pink(sec(6), 10).map((v) => v * 0.1));
		const cuts = { timesSec: [0.5, 1.7, 3.1, 8], fps: 30 };
		const a = measure([x, x.map((v) => v * 0.5)], 997, cuts);
		const b = measure([x, x.map((v) => v * 0.5)], 48_000, cuts);
		expect(b.measurement).toEqual(a.measurement);
		expect(b.events).toEqual(a.events);
	});

	it('truncates at maxSeconds and says so', () => {
		const meter = new ProfileMeter(SR, 1, { maxSeconds: 4 });
		const x = pink(sec(6), 11).map((v) => v * 0.2);
		meter.push([x], x.length);
		const r = meter.finish();
		expect(r.truncated).toBe(true);
		expect(r.measurement.durationSec).toBe(4);
	});

	it('hostile input never throws and every metric is finite or null', () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.constant(Number.NaN), fc.constant(0), fc.constant(-5), fc.constant(1e12), fc.integer({ min: 1, max: 200_000 })),
				fc.integer({ min: 0, max: 9 }),
				fc.array(
					fc.oneof(
						fc.double({ noNaN: false }),
						fc.constant(Number.POSITIVE_INFINITY),
						fc.constant(Number.NaN),
						fc.float({ min: -1, max: 1, noNaN: true }),
					),
					{ maxLength: 3000 },
				),
				fc.integer({ min: 1, max: 4000 }),
				(rate, channels, samples, reps) => {
					const meter = new ProfileMeter(rate, channels);
					const x = Float32Array.from(samples);
					const n = Math.min(x.length * reps, 200_000);
					const block = new Float32Array(n);
					for (let i = 0; i < n; i++) block[i] = x.length ? x[i % x.length]! : 0;
					meter.push([block, undefined as unknown as Float32Array], n);
					meter.push([], Number.NaN);
					const r = meter.finish({ timesSec: [Number.NaN, -1, 0.5, 1e9], fps: Number.POSITIVE_INFINITY });
					for (const k of REFERENCE_METRIC_KEYS) {
						const v = r.measurement.metrics[k];
						expect(v === null || Number.isFinite(v)).toBe(true);
					}
					return true;
				},
			),
			{ numRuns: 60 },
		);
	});
});
