// Masking solver (spec 12 §2.4, P4-R1): each constraint, their order and the post-verification, monotonicity in the
// bed, determinism, sanitisation and speed.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { threadCpuMs } from '../../../scripts/perf/cpu.ts';
import {
	BED_CAP_LU,
	CONSISTENCY_DB,
	DIALOGUE_LIFT_DB,
	HERO_SHADOW_DB,
	MAX_MASKING_ITERATIONS,
	QUIET_BED_OFFSET_LU,
	SOLVER_GAIN_MAX_DB,
	SOLVER_GAIN_MIN_DB,
	type SolverEvent,
	type SolverResult,
	type SolverWeight,
	solveSfxGains,
	TARGET_LIFT_DB,
} from '../src/index.ts';

/** Sound dominant at 500 Hz (−20 dB; the next bands are 10 dB under it, < 10 % share each), bed flat −40 dB. */
function ev(over: Partial<SolverEvent> & { clipId: string }): SolverEvent {
	return {
		soundId: `snd-${over.clipId}`,
		type: '',
		weight: 'support',
		startSec: 0,
		endSec: 0.5,
		soundBandsDb: [-40, -30, -20, -30, -40, -50, -60],
		soundPeakLu: -20,
		truePeakDb: -10,
		bedBandsDb: [-40, -40, -40, -40, -40, -40, -40],
		bedLocalPeakLu: -30,
		speechOverlap: false,
		baseGainDb: -20,
		...over,
	};
}
const one = (r: SolverResult, id: string) => r.events.find((e) => e.clipId === id)!;
const DIALOGUE = [3, 4, 5];

describe('target lift', () => {
	it.each([
		['support', 3.5],
		['hero', 5],
		['ambient', 2],
	] as [SolverWeight, number][])('%s reaches +%s dB in its dominant band', (weight, lift) => {
		expect(TARGET_LIFT_DB[weight]).toBe(lift);
		const r = solveSfxGains([ev({ clipId: 'a', weight })]);
		const e = one(r, 'a');
		// need = bed (−40) + lift − sound (−20)
		expect(e.gainDb).toBeCloseTo(-20 + lift, 9);
		expect(r.gains.a).toBe(e.gainDb);
		expect(e.achievedLiftDb).toBeCloseTo(lift, 9);
		expect(e.targetLiftDb).toBe(lift);
		expect(e.dominantBands).toEqual([500]);
		expect(e.limitedBy).toEqual([]);
		expect(r.warnings).toEqual([]);
	});

	it('a second band with ≥ 10 % of the energy is dominant too; the lift is over both', () => {
		const sound = [-40, -22, -20, -30, -40, -50, -60]; // 250 Hz: 10^-0.2 / (1 + 10^-0.2 + …) ≈ 0.36
		const bed = [-40, -30, -40, -40, -40, -40, -40];
		const r = solveSfxGains([ev({ clipId: 'a', soundBandsDb: sound, bedBandsDb: bed })]);
		const e = one(r, 'a');
		expect(e.dominantBands).toEqual([500, 250]);
		const S = 10 * Math.log10(10 ** -2 + 10 ** -2.2);
		const B = 10 * Math.log10(10 ** -4 + 10 ** -3);
		expect(e.gainDb).toBeCloseTo(Math.round((B + 3.5 - S) * 100) / 100, 9);
		// just under 10 %: one band
		const s2 = [-60, -60, -20, -29.6, -60, -60, -60]; // 10^-0.96 / (1 + 10^-0.96) ≈ 0.0988
		expect(one(solveSfxGains([ev({ clipId: 'b', soundBandsDb: s2 })]), 'b').dominantBands).toEqual([500]);
	});

	it('never goes under the base (default) gain: an unmasked sound keeps it', () => {
		const r = solveSfxGains([ev({ clipId: 'a', bedBandsDb: Array(7).fill(-80), bedLocalPeakLu: -70 })]);
		const e = one(r, 'a');
		expect(e.gainDb).toBe(-20);
		expect(e.achievedLiftDb).toBeCloseTo(40, 9); // −20 − 20 − (−80)
		expect(e.limitedBy).toEqual([]);
	});

	it('a silent bed (−Infinity bands, no peak) is the floor: base gain, bed cap against the quiet-bed reference', () => {
		const r = solveSfxGains([
			ev({ clipId: 'a', bedBandsDb: Array(7).fill(Number.NEGATIVE_INFINITY), bedLocalPeakLu: null }),
			ev({
				clipId: 'b',
				bedBandsDb: Array(7).fill(Number.NEGATIVE_INFINITY),
				bedLocalPeakLu: Number.NEGATIVE_INFINITY,
				baseGainDb: 5,
				soundPeakLu: -10,
			}),
		]);
		expect(r.warnings).toEqual([]);
		expect(one(r, 'a').gainDb).toBe(-20);
		expect(one(r, 'a').achievedLiftDb).toBeCloseTo(80, 9); // −20 − 20 − (−120)
		// not "clears the bed by +80 dB": nothing plays under it (Phase 4 verification)
		// b: −10 LUFS + 5 dB would be 15 LU over the quiet-bed reference (−14 − 12 = −26): capped at +6 LU
		const b = one(r, 'b');
		expect(b.gainDb).toBeCloseTo(-26 + 6 + 10, 9);
		expect(b.peakOverBedLu).toBeCloseTo(BED_CAP_LU.support, 9);
		expect(b.limitedBy).toEqual(['bed-cap']);
		expect(QUIET_BED_OFFSET_LU).toBe(-12);
	});

	it('a user offset is added; a negative one that leaves the lift short is reported', () => {
		const r = solveSfxGains([
			ev({ clipId: 'up', userOffsetDb: 1 }),
			ev({ clipId: 'down', userOffsetDb: -3 }),
		]);
		expect(one(r, 'up').gainDb).toBeCloseTo(-15.5, 9);
		expect(one(r, 'up').achievedLiftDb).toBeCloseTo(4.5, 9);
		expect(one(r, 'down').gainDb).toBeCloseTo(-19.5, 9);
		expect(one(r, 'down').limitedBy).toEqual(['user-offset']);
	});

	it('a silent sound keeps its base gain and says so', () => {
		const r = solveSfxGains([
			ev({ clipId: 'a', soundBandsDb: Array(7).fill(-120), soundPeakLu: null, truePeakDb: null }),
		]);
		const e = one(r, 'a');
		expect(e.gainDb).toBe(-20);
		expect(e.achievedLiftDb).toBeNull();
		expect(e.dominantBands).toEqual([]);
		expect(e.limitedBy).toEqual(['silent-sound']);
		expect(r.warnings.map((w) => w.code)).toEqual(['W_SILENT_SOUND', 'W_UNMEASURED']);
	});

	it('empty input', () => {
		const { gains, events, warnings, stats } = solveSfxGains([]);
		expect({ gains, events, warnings }).toEqual({ gains: {}, events: [], warnings: [] });
		expect(stats.converged).toBe(true);
	});
});

describe('constraints, one at a time', () => {
	it('1 clamp: [−30, +12]', () => {
		const r = solveSfxGains([
			ev({
				clipId: 'hi',
				bedBandsDb: Array(7).fill(0),
				soundPeakLu: -60,
				truePeakDb: -40,
				bedLocalPeakLu: 0,
			}),
			ev({ clipId: 'lo', baseGainDb: -45, bedBandsDb: Array(7).fill(-100) }),
		]);
		expect(one(r, 'hi').gainDb).toBe(SOLVER_GAIN_MAX_DB);
		expect(one(r, 'hi').limitedBy).toEqual(['clamp']);
		expect(one(r, 'lo').gainDb).toBe(SOLVER_GAIN_MIN_DB);
		expect(one(r, 'lo').limitedBy).toEqual(['clamp']);
	});

	it('2 bed cap: peak ≤ local bed + 6 LU (support, ambient) / + 10 LU (hero)', () => {
		const loud = { bedBandsDb: Array(7).fill(-25), soundPeakLu: -12, bedLocalPeakLu: -24 };
		const r = solveSfxGains([
			ev({ clipId: 's', ...loud }),
			ev({ clipId: 'h', weight: 'hero', ...loud, startSec: 10, endSec: 11 }),
			ev({ clipId: 'a', weight: 'ambient', ...loud }),
		]);
		for (const [id, cap] of [
			['s', 6],
			['h', 10],
			['a', 6],
		] as const) {
			const e = one(r, id);
			expect(e.peakOverBedLu, id).toBeCloseTo(cap, 9);
			expect(e.gainDb, id).toBeCloseTo(-24 + cap + 12, 9);
			expect(e.limitedBy, id).toEqual(['bed-cap']);
			expect(e.achievedLiftDb!, id).toBeLessThan(e.targetLiftDb);
		}
		// unmeasured peak: no cap, reported
		const u = solveSfxGains([ev({ clipId: 'u', ...loud, soundPeakLu: null })]);
		expect(one(u, 'u').limitedBy).toEqual([]);
		expect(u.warnings.map((w) => w.code)).toEqual(['W_UNMEASURED']);
		// the programme level moves the quiet-bed reference
		const p = solveSfxGains([ev({ clipId: 'p', baseGainDb: 10, bedLocalPeakLu: null, soundPeakLu: -10 })], {
			programLufs: -23,
		});
		expect(one(p, 'p').gainDb).toBeCloseTo(-23 - 12 + 6 + 10, 9);
	});

	it('3 hero shadow: a support within 0.15 s of a hero × 0.6; not past 0.15 s, not ambient, not the hero', () => {
		const h = ev({ clipId: 'h', weight: 'hero', startSec: 1, endSec: 1.3 });
		const r = solveSfxGains(
			[
				h,
				ev({ clipId: 'near', startSec: 1.4, endSec: 2 }), // gap 0.1 s
				ev({ clipId: 'edge', startSec: 1.45, endSec: 2 }), // gap 0.15 s exactly
				ev({ clipId: 'far', startSec: 1.46, endSec: 2 }),
				ev({ clipId: 'before', startSec: 0, endSec: 0.9 }),
				ev({ clipId: 'over', startSec: 0.5, endSec: 3 }), // overlaps
				ev({ clipId: 'amb', weight: 'ambient', startSec: 1, endSec: 2 }),
				// the bed alone: the ambience and supports under the hero would raise the hero and the supports
				// (overlapping-SFX masking, masking-overlap.test.ts); this test is about step 3
			],
			{ sfxMasking: false },
		);
		const free = -16.5;
		expect(HERO_SHADOW_DB).toBeCloseTo(-4.437, 3);
		for (const id of ['near', 'edge', 'before', 'over']) {
			expect(one(r, id).gainDb, id).toBeCloseTo(Math.round((free + HERO_SHADOW_DB) * 100) / 100, 9);
			expect(one(r, id).limitedBy, id).toEqual(['hero-shadow']);
		}
		expect(one(r, 'far').gainDb).toBeCloseTo(free, 9);
		expect(one(r, 'amb').gainDb).toBeCloseTo(-18, 9);
		expect(one(r, 'h').gainDb).toBeCloseTo(-15, 9);
	});

	it('4 consistency: repeats of a sound, then of a type and weight, within the median ± 2 dB', () => {
		const bed = (db: number) => Array(7).fill(db);
		const r = solveSfxGains([
			ev({ clipId: 'a', soundId: 'x', bedBandsDb: bed(-40) }), // −16.5
			ev({ clipId: 'b', soundId: 'x', bedBandsDb: bed(-39) }), // −15.5 (median)
			ev({ clipId: 'c', soundId: 'x', bedBandsDb: bed(-30), bedLocalPeakLu: -20 }), // −6.5 → −13.5
			ev({ clipId: 'd', soundId: 'y', type: 'hit', bedBandsDb: bed(-30), bedLocalPeakLu: -20 }), // −6.5
			ev({ clipId: 'e', soundId: 'z', type: 'hit', bedBandsDb: bed(-45) }), // base −20 → −8.5 … median −13.25
			ev({
				clipId: 'f',
				soundId: 'w',
				type: 'hit',
				weight: 'hero',
				bedBandsDb: bed(-30),
				bedLocalPeakLu: -20,
				startSec: 30,
				endSec: 31,
			}),
		]);
		expect(one(r, 'a').gainDb).toBeCloseTo(-16.5, 9);
		expect(one(r, 'b').gainDb).toBeCloseTo(-15.5, 9);
		expect(one(r, 'c').gainDb).toBeCloseTo(-15.5 + CONSISTENCY_DB, 9);
		expect(one(r, 'c').limitedBy).toEqual(['consistency']);
		// hit / support: d −6.5 and e −20 → median −13.25 → d −11.25, e −15.25
		expect(one(r, 'd').gainDb).toBeCloseTo(-11.25, 9);
		expect(one(r, 'e').gainDb).toBeCloseTo(-15.25, 9);
		expect(one(r, 'e').limitedBy).toEqual(['consistency']);
		// a hero hit is not a repeat of support hits
		expect(one(r, 'f').gainDb).toBeCloseTo(-5, 9);
		expect(r.warnings).toEqual([]);
	});

	it('5 dialogue guard: during speech, 1–4 kHz lift ≤ +1 dB; advice names types clear of 1–4 kHz', () => {
		const speechBed = [-40, -45, -40, -30, -30, -35, -50];
		const click = [-80, -70, -50, -30, -18, -25, -40]; // dominant 2 kHz (+4 kHz)
		const boom = [-15, -25, -45, -60, -70, -80, -90];
		const r = solveSfxGains([
			ev({ clipId: 'k', type: 'click', soundBandsDb: click, bedBandsDb: speechBed, speechOverlap: true }),
			ev({
				clipId: 'b',
				type: 'boom',
				soundBandsDb: boom,
				bedBandsDb: speechBed,
				speechOverlap: true,
				baseGainDb: -30,
				startSec: 5,
				endSec: 6,
			}),
			ev({
				clipId: 'free',
				type: 'tick',
				soundBandsDb: click,
				bedBandsDb: speechBed,
				startSec: 9,
				endSec: 10,
			}),
		]);
		const k = one(r, 'k');
		expect(k.dominantBands).toEqual([2000, 4000]);
		expect(k.speechBandLiftDb).toBeCloseTo(DIALOGUE_LIFT_DB, 9);
		// bound = 1 + min(bed − sound) over 1/2/4 kHz = 1 + min(0, −12, −10) = −11
		expect(k.gainDb).toBeCloseTo(-11, 9);
		expect(k.limitedBy).toEqual(['dialogue']);
		// the boom's speech bands are far under the bed: untouched, at its target
		const b = one(r, 'b');
		expect(b.limitedBy).toEqual([]);
		expect(b.achievedLiftDb).toBeCloseTo(3.5, 9);
		expect(b.speechBandLiftDb!).toBeLessThan(-20);
		// outside speech the same click reaches its target
		expect(one(r, 'free').achievedLiftDb).toBeCloseTo(3.5, 9);
		expect(one(r, 'free').speechBandLiftDb).toBeNull();
		const advice = r.warnings.filter((w) => w.code === 'W_DIALOGUE_BAND');
		expect(advice).toHaveLength(1);
		expect(advice[0]!.clipId).toBe('k');
		expect(advice[0]!.message).toContain('boom');
	});

	it('dialogue advice names only the dominant bands inside the speech octaves', () => {
		// dominant 8 kHz, second 4 kHz (≥ 10 % of the energy): only 4 kHz is a speech octave
		const bright = [-80, -80, -80, -60, -40, -23, -20];
		const r = solveSfxGains([
			ev({
				clipId: 's',
				type: 'tick',
				soundBandsDb: bright,
				bedBandsDb: Array(7).fill(-30),
				speechOverlap: true,
			}),
		]);
		expect(one(r, 's').dominantBands).toEqual([8000, 4000]);
		const w = r.warnings.find((x) => x.code === 'W_DIALOGUE_BAND')!;
		expect(w.message).toContain('4000');
		expect(w.message).not.toContain('8000');
	});

	it('6 headroom: true peak after the gain ≤ the ceiling (default −1 dBTP); unmeasured → no boost', () => {
		const masked = { bedBandsDb: Array(7).fill(-15), bedLocalPeakLu: 0 }; // needs +8.5 dB
		const r = solveSfxGains([
			ev({ clipId: 'a', ...masked, truePeakDb: -6 }),
			ev({ clipId: 'b', ...masked, truePeakDb: null }),
		]);
		expect(one(r, 'a').gainDb).toBeCloseTo(5, 9);
		expect(one(r, 'a').truePeakDb).toBeCloseTo(-1, 9);
		expect(one(r, 'a').limitedBy).toEqual(['headroom']);
		expect(one(r, 'b').gainDb).toBe(0);
		expect(one(r, 'b').truePeakDb).toBeNull();
		expect(one(r, 'b').limitedBy).toEqual(['headroom']);
		const c = solveSfxGains([ev({ clipId: 'a', ...masked, truePeakDb: -6 })], { truePeakCeilingDb: -6 });
		expect(one(c, 'a').gainDb).toBe(0);
	});
});

describe('order and post-verification (an earlier constraint is never silently broken)', () => {
	it('step 4 would break step 2: the bed cap holds and the conflict is reported', () => {
		// three repeats; two under loud beds (gain ≈ +3.5), one in a quiet place whose bed cap allows only −14
		const loud = { bedBandsDb: Array(7).fill(-20), bedLocalPeakLu: -10 };
		const r = solveSfxGains([
			ev({ clipId: 'a', soundId: 'x', ...loud, soundPeakLu: -20 }),
			ev({ clipId: 'b', soundId: 'x', ...loud, soundPeakLu: -20, startSec: 10, endSec: 10.5 }),
			ev({
				clipId: 'q',
				soundId: 'x',
				startSec: 20,
				endSec: 20.5,
				bedBandsDb: Array(7).fill(-60),
				bedLocalPeakLu: -40,
				soundPeakLu: -20,
			}),
		]);
		const q = one(r, 'q');
		// bed cap: max(−40, −26) + 6 − (−20) = 0 … the base −20 is under it, so q sits at −20; the median +3.5 asks ≥ +1.5
		expect(one(r, 'a').gainDb).toBeCloseTo(3.5, 9);
		expect(q.gainDb).toBeCloseTo(0, 9);
		expect(q.peakOverBedLu!).toBeLessThanOrEqual(BED_CAP_LU.support + 1e-9);
		expect(q.limitedBy).toEqual(['consistency', 'conflict:bed-cap/consistency']);
		expect(r.warnings.map((w) => w.code)).toEqual(['W_CONFLICT']);
	});

	it('a step 2 / 3 bound under the gain range: the repeat conflict names that constraint, not the clamp', () => {
		// q's bed cap allows −32 dB (quiet bed reference −26, +6 LU, a sound peaking at +12 LU at 0 dB): the clamp keeps
		// −30 (conflict:clamp/bed-cap); its repeats sit at +3.5, so consistency loses — to the BED CAP, which is what
		// holds q down (before: "conflict:clamp/consistency", as if the gain range were the reason)
		const loud = { bedBandsDb: Array(7).fill(-20), bedLocalPeakLu: -10 };
		const r = solveSfxGains([
			ev({ clipId: 'a', soundId: 'x', ...loud }),
			ev({ clipId: 'b', soundId: 'x', ...loud, startSec: 10, endSec: 10.5 }),
			ev({
				clipId: 'q',
				soundId: 'x',
				startSec: 20,
				endSec: 20.5,
				bedBandsDb: Array(7).fill(-60),
				bedLocalPeakLu: -40,
				soundPeakLu: 12,
			}),
		]);
		const q = one(r, 'q');
		expect(q.gainDb).toBeCloseTo(-30, 9);
		expect(q.limitedBy).toContain('conflict:clamp/bed-cap');
		expect(q.limitedBy).toContain('conflict:bed-cap/consistency');
		expect(q.limitedBy).not.toContain('conflict:clamp/consistency');
		expect(r.warnings.some((w) => w.code === 'W_UNRESOLVED')).toBe(false);
		// the same for a hero shadow under −30: a support at −28 next to a hero (−28 × 0.6 → −32.4)
		const r2 = solveSfxGains([
			ev({ clipId: 'h', weight: 'hero', startSec: 0, endSec: 0.3, soundId: 'hh' }),
			ev({
				clipId: 's1',
				soundId: 'y',
				startSec: 0.05,
				endSec: 0.5,
				baseGainDb: -28,
				soundBandsDb: Array(7).fill(-10),
			}),
			ev({ clipId: 's2', soundId: 'y', startSec: 10, endSec: 10.5, ...loud }),
			ev({ clipId: 's3', soundId: 'y', startSec: 20, endSec: 20.5, ...loud }),
		]);
		const s1 = one(r2, 's1');
		expect(s1.limitedBy).toContain('conflict:clamp/hero-shadow');
		expect(s1.limitedBy).toContain('conflict:hero-shadow/consistency');
		expect(s1.limitedBy).not.toContain('conflict:clamp/consistency');
		expect(r2.warnings.some((w) => w.code === 'W_UNRESOLVED')).toBe(false);
	});

	it('step 4 would break step 3: a shadowed support stays shadowed', () => {
		const r = solveSfxGains([
			ev({ clipId: 'h', weight: 'hero', startSec: 0, endSec: 0.3, soundId: 'hh' }),
			ev({ clipId: 's1', soundId: 'x', startSec: 0.05, endSec: 0.5 }),
			ev({ clipId: 's2', soundId: 'x', startSec: 10, endSec: 10.5, bedBandsDb: Array(7).fill(-35) }),
			ev({ clipId: 's3', soundId: 'x', startSec: 20, endSec: 20.5, bedBandsDb: Array(7).fill(-35) }),
		]);
		const s1 = one(r, 's1');
		// free −16.5, shadowed −20.94; the median of the repeats is −11.5 (others at −11.5) → would need ≥ −13.5
		expect(s1.gainDb).toBeCloseTo(-16.5 + HERO_SHADOW_DB, 2);
		// consistency did not move it (the shadow kept it where it was): only the conflict is reported for it
		expect(s1.limitedBy).toEqual(['hero-shadow', 'conflict:hero-shadow/consistency']);
	});

	it('step 5 and step 6 lose to earlier constraints (spec order), and say so', () => {
		// dialogue wants −40, the clamp keeps −30
		const r = solveSfxGains([
			ev({
				clipId: 'd',
				speechOverlap: true,
				soundBandsDb: [-80, -80, -80, -10, -80, -80, -80],
				bedBandsDb: [-80, -80, -80, -50, -80, -80, -80],
				bedLocalPeakLu: -30,
			}),
		]);
		expect(one(r, 'd').gainDb).toBe(-30);
		expect(one(r, 'd').limitedBy).toEqual(['dialogue', 'conflict:clamp/dialogue']);
		// headroom vs consistency: a hot sound in a group of repeats under loud beds
		const loud = { bedBandsDb: Array(7).fill(-20), bedLocalPeakLu: -10 };
		const h = solveSfxGains([
			ev({ clipId: 'a', soundId: 'x', ...loud, truePeakDb: -10 }),
			ev({ clipId: 'b', soundId: 'x', ...loud, truePeakDb: -10, startSec: 10, endSec: 10.5 }),
			ev({ clipId: 'hot', soundId: 'x', ...loud, truePeakDb: 0, startSec: 20, endSec: 20.5 }),
		]);
		expect(one(h, 'hot').gainDb).toBeCloseTo(1.5, 9);
		// headroom took it to −1 dB, consistency (earlier) back up to the median − 2
		expect(one(h, 'hot').limitedBy).toEqual(['consistency', 'headroom', 'conflict:consistency/headroom']);
		expect(one(h, 'hot').truePeakDb).toBeCloseTo(1.5, 9);
		expect(h.warnings.some((w) => w.code === 'W_UNRESOLVED')).toBe(false);
	});
});

// ── properties ───────────────────────────────────────────────────────────────────────────────────────────────────

const level = fc.double({ min: -120, max: 0, noNaN: true });
const arbEvent = (i: number) =>
	fc.record({
		clipId: fc.constant(`c${i}`),
		soundId: fc.constantFrom('', 's1', 's2', 's3'),
		type: fc.constantFrom('', 'hit', 'whoosh', 'click'),
		weight: fc.constantFrom<SolverWeight>('hero', 'support', 'ambient'),
		startSec: fc.double({ min: 0, max: 10, noNaN: true }),
		len: fc.double({ min: 0, max: 2, noNaN: true }),
		soundBandsDb: fc.array(level, { minLength: 7, maxLength: 7 }),
		bedBandsDb: fc.array(level, { minLength: 7, maxLength: 7 }),
		soundPeakLu: fc.option(fc.double({ min: -70, max: 0, noNaN: true })),
		truePeakDb: fc.option(fc.double({ min: -60, max: 6, noNaN: true })),
		bedLocalPeakLu: fc.option(fc.double({ min: -80, max: 0, noNaN: true })),
		speechOverlap: fc.boolean(),
		baseGainDb: fc.double({ min: -40, max: 15, noNaN: true }),
		userOffsetDb: fc.option(fc.double({ min: -3, max: 3, noNaN: true }), { nil: undefined }),
	});
const arbEvents = fc
	.integer({ min: 1, max: 12 })
	.chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbEvent(i))))
	.map((xs) => xs.map(({ len, ...e }): SolverEvent => ({ ...e, endSec: e.startSec + len })));
const arbOpts = fc.record({
	truePeakCeilingDb: fc.double({ min: -12, max: 0, noNaN: true }),
	programLufs: fc.double({ min: -31, max: -10, noNaN: true }),
});

const shiftBed = (events: SolverEvent[], d: number): SolverEvent[] =>
	events.map((e) => ({
		...e,
		bedBandsDb: e.bedBandsDb.map((b) => Math.min(0, b + d)),
		bedLocalPeakLu: e.bedLocalPeakLu === null ? null : e.bedLocalPeakLu + d,
	}));

/** The checks a reviewer would run on the output, from the inputs only. */
function checkCaps(
	events: SolverEvent[],
	r: SolverResult,
	opts: { truePeakCeilingDb: number; programLufs: number },
) {
	const tol = 0.005 + 1e-9;
	expect(r.warnings.filter((w) => w.code === 'W_UNRESOLVED')).toEqual([]);
	events.forEach((e, i) => {
		const out = r.events[i]!;
		const g = out.gainDb;
		const lost = (c: string) => out.limitedBy.some((l) => l.startsWith('conflict:') && l.endsWith(`/${c}`));
		expect(Number.isFinite(g)).toBe(true);
		// clamp is first: it always holds
		expect(g).toBeGreaterThanOrEqual(SOLVER_GAIN_MIN_DB - tol);
		expect(g).toBeLessThanOrEqual(SOLVER_GAIN_MAX_DB + tol);
		if (e.soundPeakLu !== null && !lost('bed-cap')) {
			const ref = Math.max(e.bedLocalPeakLu ?? -Infinity, opts.programLufs + QUIET_BED_OFFSET_LU);
			expect(e.soundPeakLu + g - ref).toBeLessThanOrEqual(BED_CAP_LU[e.weight] + tol);
		}
		if (e.speechOverlap && !lost('dialogue'))
			for (const b of DIALOGUE)
				expect(Math.max(-120, e.soundBandsDb[b]!) + g - Math.max(-120, e.bedBandsDb[b]!)).toBeLessThanOrEqual(
					DIALOGUE_LIFT_DB + tol,
				);
		if (!lost('headroom'))
			expect(g).toBeLessThanOrEqual(
				(e.truePeakDb === null ? 0 : opts.truePeakCeilingDb - e.truePeakDb) + tol,
			);
		// a lift short of the target always has a reason
		if (out.achievedLiftDb !== null && out.achievedLiftDb < out.targetLiftDb - 0.01)
			expect(out.limitedBy.length, JSON.stringify(out)).toBeGreaterThan(0);
	});
	// repeats (same sound): within 2·2 dB of each other unless consistency lost a conflict
	const bySound = new Map<string, number[]>();
	events.forEach((e, i) => {
		if (!e.soundId) return;
		const out = r.events[i]!;
		if (out.limitedBy.some((l) => l.startsWith('conflict:') && l.endsWith('/consistency'))) return;
		bySound.set(e.soundId, [...(bySound.get(e.soundId) ?? []), out.gainDb]);
	});
	for (const gs of bySound.values())
		expect(Math.max(...gs) - Math.min(...gs)).toBeLessThanOrEqual(2 * CONSISTENCY_DB + 2 * tol);
}

describe('properties', () => {
	it('caps always hold (or a reported conflict names the constraint that lost); nothing unresolved', () => {
		fc.assert(
			fc.property(arbEvents, arbOpts, (events, opts) => {
				checkCaps(events, solveSfxGains(events, opts), opts);
			}),
			{ numRuns: 400 },
		);
	});

	it('monotone in the bed: a louder bed never lowers a gain', () => {
		fc.assert(
			fc.property(arbEvents, arbOpts, fc.double({ min: 0, max: 30, noNaN: true }), (events, opts, d) => {
				const a = solveSfxGains(events, opts);
				const b = solveSfxGains(shiftBed(events, d), opts);
				// the one cap that can take a gain DOWN when the bed rises: overlapping sounds sharing the summed true peak
				// (a louder neighbour takes more of it); then the event was cut by it, or follows a repeat that was
				const overlapCut = b.events.some((x) => x.limitedBy.includes('overlap-headroom'));
				a.events.forEach((e, i) => {
					const y = b.events[i]!;
					if (
						overlapCut &&
						y.limitedBy.some(
							(l) => l === 'overlap-headroom' || l === 'consistency' || l.endsWith('/headroom'),
						)
					)
						return;
					expect(y.gainDb, `${e.clipId}`).toBeGreaterThanOrEqual(e.gainDb - 0.01 - 1e-9);
				});
				checkCaps(shiftBed(events, d), b, opts);
			}),
			{ numRuns: 300 },
		);
	});

	it('a lone event follows the bed dB for dB until a cap, then stays capped', () => {
		const base = ev({ clipId: 'a', bedBandsDb: Array(7).fill(-60), bedLocalPeakLu: -60, baseGainDb: -30 });
		let prev = Number.NEGATIVE_INFINITY;
		let capped = false;
		for (let bed = -60; bed <= 0; bed += 1) {
			const r = solveSfxGains([{ ...base, bedBandsDb: Array(7).fill(bed), bedLocalPeakLu: bed + 5 }]);
			const e = one(r, 'a');
			expect(e.gainDb).toBeGreaterThanOrEqual(prev);
			if (e.limitedBy.length === 0) {
				expect(capped).toBe(false);
				expect(e.gainDb === -30 || Math.abs(e.achievedLiftDb! - 3.5) < 1e-9).toBe(true);
			} else capped = true;
			prev = e.gainDb;
		}
		// truePeak −10 → headroom +9 dB is the cap at the end
		expect(capped).toBe(true);
		expect(prev).toBe(9);
	});

	it('deterministic, and independent of the input order', () => {
		fc.assert(
			fc.property(arbEvents, arbOpts, fc.integer(), (events, opts, seed) => {
				const a = solveSfxGains(events, opts);
				expect(solveSfxGains(structuredClone(events), opts)).toEqual(a);
				const perm = [...events].sort(
					(x, y) =>
						((x.clipId.charCodeAt(1) * 7919 + seed) % 13) - ((y.clipId.charCodeAt(1) * 7919 + seed) % 13),
				);
				expect(solveSfxGains(perm, opts).gains).toEqual(a.gains);
			}),
			{ numRuns: 150 },
		);
	});
});

// ── robustness ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('sanitisation', () => {
	it('NaN / ±Infinity / missing fields are replaced and reported, never propagated', () => {
		const r = solveSfxGains([
			ev({
				clipId: 'n',
				soundBandsDb: [Number.NaN, -30, -20, Number.POSITIVE_INFINITY, -40] as number[],
				bedBandsDb: [Number.NEGATIVE_INFINITY, Number.NaN, -40, -40, -40, -40, -40, -40],
				soundPeakLu: Number.NaN,
				truePeakDb: Number.POSITIVE_INFINITY,
				bedLocalPeakLu: Number.NaN,
				startSec: Number.NaN,
				endSec: Number.NEGATIVE_INFINITY,
				baseGainDb: Number.NaN,
				userOffsetDb: Number.POSITIVE_INFINITY,
				weight: 'loud' as SolverWeight,
				speechOverlap: 'yes' as unknown as boolean,
			}),
		]);
		const e = one(r, 'n');
		expect(Number.isFinite(e.gainDb)).toBe(true);
		expect(e.dominantBands).toEqual([500]);
		expect(r.warnings[0]!.code).toBe('W_SANITISED');
		for (const what of [
			'soundBandsDb has 5 bands',
			'soundBandsDb[0]',
			'soundBandsDb[3]',
			'bedBandsDb has 8',
			'bedBandsDb[1]',
			'soundPeakLu',
			'truePeakDb',
			'bedLocalPeakLu',
			'startSec',
			'baseGainDb',
			'userOffsetDb',
			'weight',
			'speechOverlap',
		])
			expect(r.warnings[0]!.message).toContain(what);
		// −Infinity bands (silence) are not a sanitisation
		expect(r.warnings[0]!.message).not.toContain('bedBandsDb[0]');
	});

	it('hostile input never throws and always gives finite gains in range', () => {
		const anything = fc.oneof(
			fc.double(),
			fc.constantFrom(
				null,
				undefined,
				'',
				'x',
				true,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.NEGATIVE_INFINITY,
			),
			fc.array(fc.oneof(fc.double(), fc.constant(null)), { maxLength: 9 }),
			fc.object(),
		);
		const hostile = fc.dictionary(
			fc.constantFrom(
				'clipId',
				'soundId',
				'type',
				'weight',
				'startSec',
				'endSec',
				'soundBandsDb',
				'bedBandsDb',
				'soundPeakLu',
				'truePeakDb',
				'bedLocalPeakLu',
				'speechOverlap',
				'baseGainDb',
				'userOffsetDb',
			),
			anything,
		);
		fc.assert(
			fc.property(
				fc.array(fc.oneof(hostile, anything), { maxLength: 8 }),
				fc.oneof(fc.object(), fc.record({ truePeakCeilingDb: fc.double(), programLufs: fc.double() })),
				(events, opts) => {
					const r = solveSfxGains(events as unknown as SolverEvent[], opts as never);
					expect(r.events).toHaveLength(events.length);
					for (const e of r.events) {
						expect(Number.isFinite(e.gainDb)).toBe(true);
						expect(e.gainDb).toBeGreaterThanOrEqual(SOLVER_GAIN_MIN_DB);
						expect(e.gainDb).toBeLessThanOrEqual(SOLVER_GAIN_MAX_DB);
						if (e.achievedLiftDb !== null) expect(Number.isFinite(e.achievedLiftDb)).toBe(true);
					}
					expect(r.warnings.filter((w) => w.code === 'W_UNRESOLVED')).toEqual([]);
				},
			),
			{ numRuns: 300 },
		);
		expect(solveSfxGains(null as never)).toEqual({
			gains: {},
			events: [],
			warnings: [],
			stats: { iterations: 0, converged: true },
		});
		expect(solveSfxGains('x' as never).warnings[0]!.code).toBe('W_INVALID_INPUT');
		expect(solveSfxGains([], { truePeakCeilingDb: Number.NaN }).warnings[0]!.code).toBe('W_INVALID_INPUT');
	});

	it('duplicate clip ids: every event is reported, gains keeps the last', () => {
		const r = solveSfxGains([
			ev({ clipId: 'a' }),
			ev({ clipId: 'a', weight: 'hero', startSec: 40, endSec: 41 }),
		]);
		expect(r.events).toHaveLength(2);
		expect(r.gains.a).toBeCloseTo(-15, 9);
		expect(r.warnings.map((w) => w.code)).toEqual(['W_DUPLICATE_CLIP']);
	});
});

describe('performance', () => {
	// The best of 9 runs measures the solver’s executing-thread CPU use.
	/** 2000 events over 10 minutes (≈ 3 playing at once); `sameWeightRepeats`: a sound repeats under one weight only. */
	function events2000(sameWeightRepeats: boolean): SolverEvent[] {
		const rnd = (() => {
			let s = 12345;
			return () => {
				s = (Math.imul(s, 1103515245) + 12345) >>> 0;
				return s / 2 ** 32;
			};
		})();
		const types = ['hit', 'whoosh', 'click', 'boom', 'ui'];
		return Array.from({ length: 2000 }, (_, i) => {
			const t = rnd() * 600;
			const weight = (['hero', 'support', 'support', 'ambient'] as const)[i % 4]!;
			const sound = Math.floor(rnd() * 200);
			return ev({
				clipId: `c${i}`,
				soundId: sameWeightRepeats ? `${weight}-s${sound % 50}` : `s${sound}`,
				type: types[i % types.length]!,
				weight,
				startSec: t,
				endSec: t + rnd() * 2,
				soundBandsDb: Array.from({ length: 7 }, () => -60 + rnd() * 50),
				bedBandsDb: Array.from({ length: 7 }, () => -70 + rnd() * 50),
				bedLocalPeakLu: -40 + rnd() * 30,
				speechOverlap: rnd() < 0.3,
			});
		});
	}
	function bestOf9(events: SolverEvent[], opts: Parameters<typeof solveSfxGains>[1]) {
		solveSfxGains(events, opts); // warm-up (JIT)
		const times: number[] = [];
		for (let k = 0; k < 9; k++) {
			const t0 = threadCpuMs();
			const r = solveSfxGains(events, opts);
			times.push(threadCpuMs() - t0);
			expect(r.events).toHaveLength(2000);
		}
		times.sort((a, b) => a - b);
		return { min: times[0]!, median: times[4]! };
	}

	it('solves 2000 events in under 50 ms (the bed-alone model of WP4.1a: one pass)', () => {
		const t = bestOf9(events2000(false), { sfxMasking: false });
		console.log(
			`solveSfxGains 2000 events, bed alone: min ${t.min.toFixed(1)} ms, median ${t.median.toFixed(1)} ms`,
		);
		expect(t.min).toBeLessThan(50);
	});

	/** Best-of-5 thread CPU time of the masking and one-pass solves, interleaved in this process. */
	function ratioToOnePass(events: SolverEvent[]) {
		solveSfxGains(events, {});
		solveSfxGains(events, { sfxMasking: false });
		const masking: number[] = [];
		const onePass: number[] = [];
		let iterations = 0;
		for (let k = 0; k < 5; k++) {
			let t0 = threadCpuMs();
			solveSfxGains(events, { sfxMasking: false });
			onePass.push(threadCpuMs() - t0);
			t0 = threadCpuMs();
			iterations = solveSfxGains(events, {}).stats.iterations;
			masking.push(threadCpuMs() - t0);
		}
		const m = Math.min(...masking);
		const o = Math.min(...onePass);
		return { masking: m, onePass: o, ratio: m / o, iterations };
	}

	// The masking budgets are ratios to the one-pass solve measured in the same process, interleaved (a loaded host
	// slows both alike; WP6.5b measured on the idle build server: 31 ms ≈ 1.8× in 3 passes,
	// 45 ms ≈ 2.6× in 13 passes; the absolute "under 50 ms" of these cases failed at a load of 20–50).
	it('masking overlapping effects costs ≤ 2.5× the bed-alone solve when repeats keep their weight', () => {
		// a plan places a repeated sound with one role: the masking settles in one pass per weight rank
		const t = ratioToOnePass(events2000(true));
		console.log(
			`solveSfxGains 2000 events, masking: ${t.masking.toFixed(1)} ms vs one pass ${t.onePass.toFixed(1)} ms (${t.ratio.toFixed(2)}×), ${t.iterations} passes`,
		);
		expect(t.ratio).toBeLessThan(2.5);
	});

	it('masking mixed-weight repeats costs ≤ 4× the bed-alone solve', () => {
		// The stress case: every repeat group spans the weights, so a hero's masked bed moves its group's median, which
		// moves the ambient members under the other heroes… the fixed point takes 13 passes; only the events whose bed
		// moved are solved again, so 13 passes cost ≈ 2.6 one-pass solves.
		const t = ratioToOnePass(events2000(false));
		console.log(
			`solveSfxGains 2000 events, masking, repeats across weights: ${t.masking.toFixed(1)} ms vs one pass ${t.onePass.toFixed(1)} ms (${t.ratio.toFixed(2)}×), ${t.iterations} passes`,
		);
		expect(t.iterations).toBeLessThanOrEqual(1 + MAX_MASKING_ITERATIONS);
		expect(t.ratio).toBeLessThan(4);
	});
});
