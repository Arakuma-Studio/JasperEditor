// Takes of multi-hit recordings (spec 12 P6-E9; wp-note "Phase 6 → WP-E5"): synthetic recordings with known attacks.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	analyzeTakes,
	findTakes,
	SoundAnalysisError,
	TAKE_CLEAN_HEAD_DB,
	TAKE_CLEAN_TAIL_DB,
	TAKE_FLAGS,
	TAKE_MAX_COUNT,
	type TakeSegment,
} from '../src/index.ts';
import { addClick, floorNoise, TAKE_SR as SR, tenClicksInSilence, typingPairs } from './take-fixtures.ts';

const ms = (n: number) => Math.round((n / 1000) * SR);

/** Segments are ordered, inside the input, not overlapping, numbered 1…, flags and levels well formed. */
function expectWellFormed(takes: TakeSegment[], frames: number, rate: number): void {
	expect(takes.length).toBeLessThanOrEqual(TAKE_MAX_COUNT);
	let prevEnd = 0;
	takes.forEach((t, i) => {
		expect(t.index).toBe(i + 1);
		expect(Number.isSafeInteger(t.startSample) && Number.isSafeInteger(t.endSample)).toBe(true);
		expect(t.startSample).toBeGreaterThanOrEqual(prevEnd);
		expect(t.endSample).toBeGreaterThan(t.startSample);
		expect(t.endSample).toBeLessThanOrEqual(frames);
		expect(Math.round(t.startSec * rate)).toBe(t.startSample);
		expect(Math.round(t.endSec * rate)).toBe(t.endSample);
		for (const v of [t.headDb, t.tailDb]) {
			expect(Number.isFinite(v)).toBe(true);
			expect(v).toBeLessThanOrEqual(0);
			expect(v).toBeGreaterThanOrEqual(-120);
		}
		for (const f of t.flags) expect(TAKE_FLAGS).toContain(f);
		expect(t.flags.includes('head-cut')).toBe(t.headDb > TAKE_CLEAN_HEAD_DB);
		if (t.tailDb > TAKE_CLEAN_TAIL_DB) expect(t.flags).toContain('tail-cut');
		expect([1, 2]).toContain(t.strokes);
		prevEnd = t.endSample;
	});
}

describe('findTakes: known recordings', () => {
	it('10 clicks separated by digital silence give 10 clean takes, each from 5 ms before its attack', () => {
		const { x, attacks } = tenClicksInSilence();
		const takes = findTakes([x], SR);
		expectWellFormed(takes, x.length, SR);
		expect(takes).toHaveLength(10);
		takes.forEach((t, k) => {
			expect(t.flags, `take ${t.index}`).toEqual([]);
			expect(t.strokes).toBe(1);
			// 5 ms pre-roll, the attack refined to its 1 ms frame
			expect(Math.abs(t.startSample - (attacks[k]! - ms(5))), `take ${t.index} start`).toBeLessThanOrEqual(ms(1));
			// ends after the click has decayed (it is ≈ 30 ms to −35 dB, plus 20 ms) and before the next one
			expect(t.endSample).toBeGreaterThan(attacks[k]! + ms(30));
			if (k + 1 < attacks.length) expect(t.endSample).toBeLessThan(attacks[k + 1]!);
			expect(t.headDb).toBeLessThanOrEqual(TAKE_CLEAN_HEAD_DB);
			expect(t.tailDb).toBeLessThanOrEqual(TAKE_CLEAN_TAIL_DB);
		});
	});

	it('a typing run of down / up pairs gives one joined take per key press', () => {
		const { x, downs, ups } = typingPairs();
		const takes = findTakes([x], SR);
		expectWellFormed(takes, x.length, SR);
		expect(takes).toHaveLength(downs.length);
		takes.forEach((t, k) => {
			expect(t.strokes, `take ${t.index}`).toBe(2);
			expect(Math.abs(t.startSample - (downs[k]! - ms(5)))).toBeLessThanOrEqual(ms(1));
			expect(t.endSample).toBeGreaterThan(ups[k]! + ms(20));
			expect(t.flags).toEqual([]);
		});
	});

	it('the same in stereo, and at 44.1 kHz', () => {
		const { x } = typingPairs();
		const r = x.map((v) => v * 0.5);
		expect(findTakes([x, r], SR)).toHaveLength(8);
		const lo = typingPairs(44_100);
		const t44 = findTakes([lo.x], 44_100);
		expectWellFormed(t44, lo.x.length, 44_100);
		expect(t44.map((t) => t.strokes)).toEqual(Array(8).fill(2));
	});

	it('a take cut at a boundary is flagged: a file starting inside a sound, one ending inside one, a hit cut by the next', () => {
		const x = floorNoise(Math.round(3 * SR), 3e-4, 5);
		// starts inside a sustained, decaying sound (no pre-roll of quiet)
		for (let i = 0; i < ms(400); i++) x[i] = x[i]! + 0.4 * Math.exp(-i / ms(120)) * Math.sin((2 * Math.PI * 440 * i) / SR);
		// a long hit 0.35 s before the next one: it has not decayed 35 dB when the next starts
		addClick(x, ms(800), { amp: 0.6, tauMs: 160, lenMs: 1200, seed: 1 });
		addClick(x, ms(1150), { amp: 0.6, tauMs: 4, lenMs: 60, seed: 2 });
		// a clean hit
		addClick(x, ms(1800), { amp: 0.6, tauMs: 4, lenMs: 60, seed: 3 });
		// the last hit runs past the end of the file
		addClick(x, x.length - ms(60), { amp: 0.6, tauMs: 200, lenMs: 2000, seed: 4 });
		const takes = findTakes([x], SR);
		expectWellFormed(takes, x.length, SR);
		const at = (sample: number) => takes.find((t) => t.startSample <= sample && sample < t.endSample);
		expect(at(ms(20))?.flags).toContain('head-cut');
		expect(at(ms(900))?.flags).toContain('tail-cut');
		expect(at(ms(1810))?.flags).toEqual([]);
		expect(at(x.length - ms(30))?.flags).toContain('tail-cut');
	});

	it('a hit chopped into digital silence (no decay) is a tail cut', () => {
		const x = new Float32Array(SR);
		addClick(x, ms(200), { amp: 0.6, tauMs: 200, lenMs: 100, seed: 9 }); // stops at ≈ −4 dB
		addClick(x, ms(600), { amp: 0.6, tauMs: 4, lenMs: 60, seed: 10 });
		const takes = findTakes([x], SR);
		expectWellFormed(takes, x.length, SR);
		expect(takes).toHaveLength(2);
		expect(takes[0]!.flags).toContain('tail-cut');
		expect(takes[1]!.flags).toEqual([]);
	});

	it('keeps at most 64 takes, clean ones first, spread over the whole recording', () => {
		const x = new Float32Array(Math.round(16 * SR));
		const attacks: number[] = [];
		for (let k = 0; k < 100; k++) {
			const a = Math.round((0.1 + k * 0.15) * SR);
			attacks.push(a);
			addClick(x, a, { seed: 1000 + k });
		}
		const takes = findTakes([x], SR);
		expectWellFormed(takes, x.length, SR);
		expect(takes).toHaveLength(TAKE_MAX_COUNT);
		expect(takes.every((t) => t.flags.length === 0)).toBe(true);
		expect(takes[0]!.startSample).toBeLessThan(Math.round(2 * SR));
		expect(takes[takes.length - 1]!.startSample).toBeGreaterThan(Math.round(13 * SR));
	});

	it('is deterministic, and analyzeTakes gives each take its own descriptors with the recording floor', () => {
		const { x } = typingPairs();
		expect(findTakes([x], SR)).toEqual(findTakes([Float32Array.from(x)], SR));
		const a = analyzeTakes([x], SR);
		expect(a).toEqual(analyzeTakes([x], SR));
		expect(a).toHaveLength(8);
		const floor = a[0]!.descriptors.floorDb;
		expect(floor).not.toBeNull();
		expect(floor!).toBeLessThan(-60);
		for (const t of a) {
			expect(t.descriptors.floorDb).toBe(floor);
			expect(t.descriptors.durationSec).toBeCloseTo((t.endSample - t.startSample) / SR, 3);
			expect(t.descriptors.onsetCount).toBeGreaterThanOrEqual(1);
			// the down-stroke peaks within its first 10 ms (after the 5 ms pre-roll)
			expect(t.descriptors.peakSec).toBeLessThan(0.016);
		}
	});
});

describe('findTakes: hostile input never throws', () => {
	it('empty, one sample, all silence, all NaN, DC', () => {
		expect(findTakes([], SR)).toEqual([]);
		expect(findTakes([new Float32Array(0)], SR)).toEqual([]);
		expect(findTakes([new Float32Array([0.9])], SR)).toEqual([]);
		expect(findTakes([new Float32Array(SR)], SR)).toEqual([]);
		expect(findTakes([new Float32Array(SR).fill(Number.NaN)], SR)).toEqual([]);
		const dc = findTakes([new Float32Array(SR).fill(0.5)], SR);
		expectWellFormed(dc, SR, SR);
		expect(analyzeTakes([new Float32Array(SR)], SR)).toEqual([]);
	});

	it('refuses invalid arguments like analyzeSound', () => {
		expect(() => findTakes([new Float32Array(10)], 0)).toThrow(SoundAnalysisError);
		expect(() => findTakes('x' as never, SR)).toThrow(SoundAnalysisError);
	});

	it('random signals (any length, channels, rate, non-finite samples) give well-formed takes', () => {
		const sample = fc.oneof(
			{ weight: 8, arbitrary: fc.float({ min: -1, max: 1, noNaN: true }) },
			{ weight: 1, arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -3.4e38, 0) },
		);
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 3 }),
				fc.constantFrom(8000, 22_050, 44_100, 48_000, 96_000),
				fc.array(sample, { minLength: 0, maxLength: 4000 }),
				fc.array(fc.integer({ min: 0, max: 3999 }), { maxLength: 12 }),
				(nch, rate, base, bursts) => {
					const n = base.length;
					const chs = Array.from({ length: nch }, (_, c) => {
						const x = Float32Array.from(base, (v) => v * (c + 1) * 0.01);
						for (const b of bursts) if (b < n) addClick(x, b, { sr: rate, seed: b + c, lenMs: 20 });
						return x;
					});
					const takes = findTakes(chs, rate);
					expectWellFormed(takes, n, rate);
					const analysed = analyzeTakes(chs, rate);
					expect(analysed.map(({ descriptors: _d, ...t }) => t)).toEqual(takes);
				},
			),
			{ numRuns: 150, seed: 0x5eed },
		);
	});
});
