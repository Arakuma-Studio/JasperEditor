// Sound Check Phase 6 detectors (spec 12 §4 P6-E1, P6-E2; wp-note "Phase 6 → WP-E1"): clicks (adapted from earshot's
// `detect_clicks`), clip-edge measurements and judgements, the 2–6 kHz presence meter, 1/3-octave band energies and
// layer audibility. Known answers, block-size independence, monotonicity in gain, and hostile input (NaN, DC, silence,
// one sample, 30 minutes) that never throws.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	attackMs,
	CLICK_DETECTOR,
	ClickDetector,
	decayAfterMs,
	detectClicks,
	harshExcess,
	isAbruptEntry,
	isChoppedDecay,
	isChoppedMusic,
	layerAudibility,
	loudestWindowStart,
	measureEntry,
	measureExit,
	measureSplice,
	PRESENCE_FLOOR_DB,
	PresenceMeter,
	presenceLevels,
	presencePeakDb,
	THIRD_OCTAVE_CENTRES_HZ,
	thirdOctaveEnergies,
} from '../src/index.ts';
import { noise, sine } from './util.ts';

const SR = 48_000;
const ENTRY = { preDb: -20, fadeMs: 5, attackMs: 10, exposedDb: -10 };
const EXIT = { tailDb: -35, postDb: -35, fadeMs: 30 };
const SPLICE = { sustainDb: 6, overNextDb: 6, crossfadeMs: 100 };

function feedClicks(d: ClickDetector, planar: Float32Array[], block: number) {
	const n = planar[0]!.length;
	for (let i = 0; i < n; i += block) {
		const k = Math.min(block, n - i);
		d.push(
			planar.map((c) => c.subarray(i, i + k)),
			k,
		);
	}
	return d.finish();
}

/** A 1 kHz tone faded in over 20 ms (no discontinuity anywhere). */
function smoothTone(n: number, amp = 0.3): Float32Array {
	const x = sine(1000, amp, SR, n);
	for (let i = 0; i < 960; i++) x[i]! *= 0.5 - 0.5 * Math.cos((Math.PI * i) / 960);
	return x;
}
/** The high-pass delays the burst's largest sample by a couple of samples (≪ the 1 ms the check promises). */
const near = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThanOrEqual(3);

/** A tone with a step (a cut) at `at`: zero before, a full-level cosine from it. */
function stepAt(n: number, at: number, amp = 0.3): Float32Array {
	const x = new Float32Array(n);
	for (let i = at; i < n; i++) x[i] = amp * Math.cos((2 * Math.PI * 1000 * (i - at)) / SR);
	return x;
}

describe('ClickDetector (CLICK)', () => {
	it('finds a step in a tone at its sample, as a click; a smooth tone and pink-ish noise have none', () => {
		const n = SR;
		const x = stepAt(n, 24_000);
		const b = detectClicks([x, x.slice()], SR);
		expect(b).toHaveLength(1);
		expect(b[0]!.kind).toBe('click');
		expect(Math.abs(b[0]!.sample - 24_000)).toBeLessThanOrEqual(2);
		expect(b[0]!.concentration).toBeGreaterThanOrEqual(0.8);
		expect(b[0]!.overDb).toBeGreaterThan(20 * Math.log10(9));
		expect(detectClicks([smoothTone(n)], SR)).toEqual([]);
		expect(detectClicks([noise(3, n, 0.2)], SR)).toEqual([]);
	});

	it('a single-sample spike over quiet noise is a click; a 5 ms noise burst is an attack at most', () => {
		const x = noise(5, SR, 0.001);
		x[30_000] = 0.5;
		const b = detectClicks([x], SR);
		expect(b.map((c) => c.kind)).toEqual(['click']);
		near(b[0]!.sample, 30_000);
		const y = noise(6, SR, 0.0005);
		const burst = noise(7, 240, 0.4);
		for (let i = 0; i < 240; i++) y[20_000 + i]! += burst[i]! * Math.sin((Math.PI * i) / 240);
		expect(detectClicks([y], SR).filter((c) => c.kind === 'click')).toEqual([]);
	});

	it('is block-size independent and merges channels within 1 ms', () => {
		const x = stepAt(SR, 10_001);
		const r = stepAt(SR, 10_020);
		const whole = detectClicks([x, r], SR);
		for (const block of [1, 7, 480, 4096, 48_000])
			expect(feedClicks(new ClickDetector(SR, 2), [x, r], block)).toEqual(whole);
		expect(whole).toHaveLength(1);
		near(whole[0]!.sample, 10_001);
		// two clicks 30 ms apart on one channel are both found
		const two = stepAt(SR, 5000);
		for (let i = 6440; i < SR; i++) two[i] = -two[i]!;
		const both = detectClicks([two], SR).map((c) => c.sample);
		expect(both).toHaveLength(2);
		near(both[0]!, 5000);
		near(both[1]!, 6440);
	});

	it('works at 44.1 kHz and finds nothing under 30 kHz (14 kHz does not fit)', () => {
		const sr = 44_100;
		const x = new Float32Array(sr);
		for (let i = 22_050; i < sr; i++) x[i] = 0.3 * Math.cos((2 * Math.PI * 1000 * (i - 22_050)) / sr);
		const b = detectClicks([x], sr);
		expect(b.map((c) => c.kind)).toEqual(['click']);
		expect(Math.abs(b[0]!.sample - 22_050)).toBeLessThanOrEqual(2);
		expect(detectClicks([x], 22_050)).toEqual([]);
		expect(new ClickDetector(22_050, 1).enabled).toBe(false);
		expect(CLICK_DETECTOR.minSampleRate).toBe(30_000);
	});

	it('finds a click 30 minutes in (streamed, bounded memory) and never throws on hostile input', () => {
		const d = new ClickDetector(SR, 1);
		const block = new Float32Array(48_000);
		const total = 30 * 60;
		for (let s = 0; s < total - 1; s++) d.push([block], block.length);
		d.push([stepAt(48_000, 12_000)], 48_000);
		const b = d.finish();
		expect(b).toHaveLength(1);
		near(b[0]!.sample, (total - 1) * 48_000 + 12_000);
		fc.assert(
			fc.property(
				fc.array(fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(1), fc.constant(0)), {
					maxLength: 3000,
				}),
				fc.integer({ min: 1, max: 4 }),
				fc.oneof(fc.constant(48_000), fc.constant(8000), fc.double()),
				(vals, ch, sr) => {
					const x = Float32Array.from(vals);
					const out = detectClicks(
						Array.from({ length: ch }, () => x),
						sr,
					);
					for (const c of out) {
						expect(Number.isFinite(c.levelDb)).toBe(true);
						expect(c.sample).toBeGreaterThanOrEqual(0);
						expect(c.sample).toBeLessThan(Math.max(1, x.length));
					}
				},
			),
			{ numRuns: 300 },
		);
		// DC, silence and a single sample
		expect(detectClicks([new Float32Array(SR).fill(0.5)], SR).length).toBeLessThanOrEqual(1);
		expect(detectClicks([new Float32Array(SR)], SR)).toEqual([]);
		expect(() => detectClicks([Float32Array.of(1)], SR)).not.toThrow();
		expect(detectClicks([], SR)).toEqual([]);
	});
});

describe('clip edges (EDGE)', () => {
	const tone = (n: number, amp = 0.3, phase = 0) => sine(440, amp, SR, n, phase);

	it('abrupt entry: a sustained source before the In point and no fade; a fade or a silent source clears it', () => {
		const before = tone(960);
		const inside = tone(SR, 0.3, (2 * Math.PI * 440 * 960) / SR);
		const m = measureEntry(inside, before, SR);
		expect(m.preDb).toBeGreaterThan(-4);
		expect(m.preDb).toBeLessThan(-2);
		expect(m.attackMs).toBe(0);
		expect(isAbruptEntry(m, 0, ENTRY)).toBe(true);
		expect(isAbruptEntry(m, 5, ENTRY)).toBe(false);
		expect(isAbruptEntry(measureEntry(inside, new Float32Array(960), SR), 0, ENTRY)).toBe(false);
		expect(isAbruptEntry(measureEntry(inside, new Float32Array(0), SR), 0, ENTRY)).toBe(false);
		// a quiet bed before a hit whose attack is 2 ms in: covered by the attack (source under −10 dB re its peak)
		const hit = new Float32Array(SR);
		for (let i = 96; i < SR; i++) hit[i] = 0.9 * Math.exp(-(i - 96) / 4800) * Math.sin(i / 3);
		const bed = tone(960, 0.2);
		const mh = measureEntry(hit, bed, SR);
		expect(mh.preDb).toBeGreaterThan(-20);
		expect(mh.attackMs).toBeLessThanOrEqual(10);
		expect(isAbruptEntry(mh, 0, ENTRY)).toBe(false);
		expect(attackMs(hit, SR)).toBe(2);
	});

	it('chopped decay: the clip ends loud while its source goes on; a 30 ms fade or a decayed source clears it', () => {
		const inside = tone(SR);
		const after = tone(960);
		const m = measureExit(inside, after, SR);
		expect(m.tailDb).toBeGreaterThan(-35);
		expect(isChoppedDecay(m, 0, EXIT)).toBe(true);
		expect(isChoppedDecay(m, 29, EXIT)).toBe(true);
		expect(isChoppedDecay(m, 30, EXIT)).toBe(false);
		expect(isChoppedDecay(measureExit(inside, new Float32Array(960), SR), 0, EXIT)).toBe(false);
		const decayed = tone(SR).map((v, i) => v * Math.exp(-i / 2000));
		expect(isChoppedDecay(measureExit(decayed, new Float32Array(960), SR), 0, EXIT)).toBe(false);
		// where the source after it has decayed 35 dB under the clip's peak
		const ring = new Float32Array(SR).map((_, i) => 0.3 * Math.exp(-i / 4800) * Math.sin(i / 5));
		const ms = decayAfterMs(ring, 0.3, -35, SR)!;
		expect(ms).toBeGreaterThan(300);
		expect(ms).toBeLessThan(500);
		expect(decayAfterMs(tone(4800), 0.3, -35, SR)).toBeNull();
	});

	it('chopped music: the source sustains past the joint over a quieter entry with a short crossfade', () => {
		const loud = tone(2400);
		const quiet = tone(2400, 0.01);
		const s = measureSplice(loud, loud, quiet);
		expect(s.outDb).toBeCloseTo(s.cutOffDb, 1);
		expect(isChoppedMusic(s, 33, SPLICE)).toBe(true);
		expect(isChoppedMusic(s, 100, SPLICE)).toBe(false);
		// the next piece enters as loud: a musical joint
		expect(isChoppedMusic(measureSplice(loud, loud, loud), 0, SPLICE)).toBe(false);
		// the music had already stopped at the joint
		expect(isChoppedMusic(measureSplice(loud, new Float32Array(2400), quiet), 0, SPLICE)).toBe(false);
	});

	it('never throws and stays finite on hostile input', () => {
		const arr = fc
			.array(fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(Number.POSITIVE_INFINITY)), {
				maxLength: 500,
			})
			.map((a) => Float32Array.from(a));
		fc.assert(
			fc.property(arr, arr, arr, fc.double(), (a, b, c, ms) => {
				const e = measureEntry(a, b, SR);
				const x = measureExit(a, c, SR);
				const s = measureSplice(a, b, c);
				for (const v of [e.preDb, e.headDb, e.attackMs, x.tailDb, x.postDb, s.outDb, s.cutOffDb, s.nextInDb])
					expect(Number.isFinite(v)).toBe(true);
				expect(typeof isAbruptEntry(e, ms, ENTRY)).toBe('boolean');
				expect(typeof isChoppedDecay(x, ms, EXIT)).toBe('boolean');
				expect(typeof isChoppedMusic(s, ms, SPLICE)).toBe('boolean');
			}),
			{ numRuns: 300 },
		);
	});
});

describe('presence 2–6 kHz (HARSH)', () => {
	it('a 4 kHz tone reads its mean square; 500 Hz and 12 kHz are far down; levels are block-size independent', () => {
		const n = SR;
		const db4k = presencePeakDb(presenceLevels([sine(4000, 0.5, SR, n)], SR));
		expect(Math.abs(db4k - 10 * Math.log10(0.125))).toBeLessThan(1);
		expect(presencePeakDb(presenceLevels([sine(500, 0.5, SR, n)], SR))).toBeLessThan(db4k - 30);
		expect(presencePeakDb(presenceLevels([sine(12_000, 0.5, SR, n)], SR))).toBeLessThan(db4k - 20);
		const x = noise(9, n, 0.3);
		const whole = presenceLevels([x, x], SR);
		for (const block of [1, 13, 480, 4096]) {
			const m = new PresenceMeter(SR, 2);
			for (let i = 0; i < n; i += block) {
				const k = Math.min(block, n - i);
				m.push([x.subarray(i, i + k), x.subarray(i, i + k)], k);
			}
			const got = m.finish();
			expect(got.length).toBe(whole.length);
			for (let h = 0; h < got.length; h++) expect(got[h]!).toBeCloseTo(whole[h]!, 4);
		}
		expect(whole.length).toBe(100);
	});

	it('is monotone in gain (+g dB in → +g dB out) and harshness compares peaks', () => {
		const x = noise(11, SR / 4, 0.1);
		fc.assert(
			fc.property(fc.double({ min: -30, max: 20, noNaN: true }), (g) => {
				const k = 10 ** (g / 20);
				const a = presencePeakDb(presenceLevels([x], SR));
				const b = presencePeakDb(presenceLevels([x.map((v) => v * k)], SR));
				expect(Math.abs(b - a - g)).toBeLessThan(0.01);
			}),
			{ numRuns: 50 },
		);
		expect(harshExcess(-10, -20, 6)).toEqual({ overDb: 10, harsh: true });
		expect(harshExcess(-15, -20, 6)).toEqual({ overDb: 5, harsh: false });
		expect(harshExcess(-10, PRESENCE_FLOOR_DB, 6)).toBeNull();
		expect(harshExcess(Number.NaN, -20, 6)).toBeNull();
	});

	it('never throws on hostile input; silence reads the floor', () => {
		expect(presencePeakDb(presenceLevels([new Float32Array(SR)], SR))).toBe(PRESENCE_FLOOR_DB);
		expect(presencePeakDb([])).toBe(PRESENCE_FLOOR_DB);
		fc.assert(
			fc.property(
				fc.array(fc.oneof(fc.double(), fc.constant(Number.NaN)), { maxLength: 2000 }),
				fc.oneof(fc.constant(48_000), fc.double()),
				(vals, sr) => {
					const lv = presenceLevels([Float32Array.from(vals)], sr);
					for (const v of lv) expect(Number.isFinite(v)).toBe(true);
				},
			),
			{ numRuns: 300 },
		);
	});
});

describe('1/3-octave bands and layer audibility (LAYER_INAUDIBLE)', () => {
	it('a 1 kHz tone lands in the 1 kHz band; the loudest window is found', () => {
		const e = thirdOctaveEnergies([sine(1000, 0.5, SR, 2880)], 0, 2880, SR);
		let best = 0;
		for (let b = 1; b < e.length; b++) if (e[b]! > e[best]!) best = b;
		expect(Math.round(THIRD_OCTAVE_CENTRES_HZ[best]!)).toBe(1000);
		expect(THIRD_OCTAVE_CENTRES_HZ).toHaveLength(22);
		const x = new Float32Array(SR);
		x.set(sine(800, 0.5, SR, 2880), 30_000);
		expect(Math.abs(loudestWindowStart([x], 2880) - 30_000)).toBeLessThanOrEqual(48);
	});

	it('a layer 50 dB under the rest adds ≈ 0 dB; an equal one 3 dB; the target gain makes it add 3 dB', () => {
		const rest = thirdOctaveEnergies([noise(1, 2880, 0.3)], 0, 2880, SR);
		const quiet = thirdOctaveEnergies([noise(2, 2880, 0.3 * 10 ** (-50 / 20))], 0, 2880, SR);
		const a = layerAudibility(quiet, rest);
		expect(a.maxAddDb).toBeLessThan(0.1);
		expect(a.gainForTargetDb!).toBeGreaterThan(40);
		const equal = layerAudibility(rest, rest);
		expect(Math.abs(equal.maxAddDb - 3.01)).toBeLessThan(0.02);
		const g = 10 ** (a.gainForTargetDb! / 10);
		const boosted = Float64Array.from(quiet, (v) => v * g);
		const hit = layerAudibility(boosted, rest);
		expect(Math.abs(hit.maxAddDb - 3)).toBeLessThan(0.15);
		expect(layerAudibility(new Float64Array(22), rest)).toMatchObject({ maxAddDb: 0, gainForTargetDb: null });
	});

	it('the addition is monotone in the layer gain and never throws', () => {
		const rest = thirdOctaveEnergies([noise(3, 2880, 0.2)], 0, 2880, SR);
		const layer = thirdOctaveEnergies([sine(2000, 0.05, SR, 2880)], 0, 2880, SR);
		fc.assert(
			fc.property(
				fc.double({ min: -40, max: 30, noNaN: true }),
				fc.double({ min: 0, max: 10, noNaN: true }),
				(g, d) => {
					const k = (x: number) => Float64Array.from(layer, (v) => v * 10 ** (x / 10));
					expect(layerAudibility(k(g + d), rest).maxAddDb).toBeGreaterThanOrEqual(
						layerAudibility(k(g), rest).maxAddDb - 1e-9,
					);
				},
			),
			{ numRuns: 200 },
		);
		fc.assert(
			fc.property(
				fc.array(fc.oneof(fc.double(), fc.constant(Number.NaN)), { maxLength: 4000 }),
				fc.integer({ min: -10, max: 5000 }),
				fc.integer({ min: -10, max: 5000 }),
				(vals, from, len) => {
					const x = Float32Array.from(vals);
					const e = thirdOctaveEnergies([x], from, len, SR);
					for (const v of e) expect(Number.isFinite(v)).toBe(true);
					const a = layerAudibility(e, e);
					expect(Number.isFinite(a.maxAddDb)).toBe(true);
					expect(loudestWindowStart([x], len)).toBeGreaterThanOrEqual(0);
				},
			),
			{ numRuns: 300 },
		);
	});
});
