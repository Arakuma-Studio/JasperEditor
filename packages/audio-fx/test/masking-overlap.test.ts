// Masking solver, overlapping sound effects (spec 12 §2.4; wp-note "WP6.5b solver"): sound effects of a lower weight
// that play under a sound are part of its bed (an ambient effect masks the supports and heroes over it, a support masks
// a hero; peers and the layers of one cue do not mask each other), solved to a fixed point in bounded iterations; and
// the summed true peak of overlapping sounds stays under the ceiling (each clique of overlapping events is lowered
// together, deterministically). Unit tests with hand-computed numbers, an independent brute-force oracle of the
// effective bed, and properties (determinism, the summed ceiling, convergence).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	MAX_MASKING_ITERATIONS,
	type SolverEvent,
	type SolverResult,
	type SolverWeight,
	solveSfxGains,
	TARGET_LIFT_DB,
} from '../src/index.ts';

/** Sound dominant at 500 Hz (−20 dB), bed flat −40 dB, true peak −10 dBTP, base −20 dB (as masking.test.ts). */
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
const e10 = (db: number) => 10 ** (db / 10);
const dB10 = (x: number) => 10 * Math.log10(x);
const amp = (db: number) => 10 ** (db / 20);
const RANK: Record<SolverWeight, number> = { ambient: 0, support: 1, hero: 2 };

describe('overlapping sound effects mask the sounds of a higher weight', () => {
	it('an ambient effect under a hero is part of its bed: the hero clears bed + ambience by +5 dB', () => {
		const rain = ev({ clipId: 'rain', weight: 'ambient', startSec: 0, endSec: 4 });
		const hit = ev({ clipId: 'hit', weight: 'hero', startSec: 1, endSec: 1.5 });
		const r = solveSfxGains([rain, hit]);
		// the ambience alone: bed −40 + 2 − (−20) = −18 dB → −38 dB at 500 Hz
		expect(one(r, 'rain').gainDb).toBeCloseTo(-18, 9);
		expect(one(r, 'rain').maskedBy).toEqual([]);
		expect(one(r, 'rain').sfxMaskingDb).toBe(0);
		// the hero over bed (−40) ⊕ rain (−38) in its window (fully covered)
		const eff = dB10(e10(-40) + e10(-38));
		expect(one(r, 'hit').gainDb).toBeCloseTo(Math.round((eff + 5 + 20) * 100) / 100, 9);
		expect(one(r, 'hit').achievedLiftDb).toBeCloseTo(5, 2);
		expect(one(r, 'hit').sfxMaskingDb).toBeCloseTo(eff + 40, 2);
		expect(one(r, 'hit').maskedBy).toEqual(['rain']);
		expect(one(r, 'hit').limitedBy).toEqual([]);
		expect(r.stats.converged).toBe(true);
		// switched off: the bed alone (the WP4.1a model)
		const off = solveSfxGains([rain, hit], { sfxMasking: false });
		expect(one(off, 'hit').gainDb).toBeCloseTo(-15, 9);
		expect(one(off, 'hit').maskedBy).toEqual([]);
	});

	it('a partial overlap counts by its share of the window (the masker’s power spread over its own window)', () => {
		const r = solveSfxGains([
			ev({ clipId: 'amb', weight: 'ambient', startSec: 0, endSec: 1 }),
			ev({ clipId: 'h', weight: 'hero', startSec: 0.75, endSec: 1.25 }), // half of its window under amb
		]);
		const eff = dB10(e10(-40) + 0.5 * e10(-38));
		expect(one(r, 'h').gainDb).toBeCloseTo(Math.round((eff + 25) * 100) / 100, 9);
		// touching windows do not overlap
		const t = solveSfxGains([
			ev({ clipId: 'amb', weight: 'ambient', startSec: 0, endSec: 1 }),
			ev({ clipId: 'h', weight: 'hero', startSec: 1, endSec: 1.5 }),
		]);
		expect(one(t, 'h').gainDb).toBeCloseTo(-15, 9);
		expect(one(t, 'h').maskedBy).toEqual([]);
	});

	it('an energy profile counts a decaying masker by the energy it has under the event', () => {
		// a 4 s ambience with 90 % of its energy in its first second; a hero over its last second gets the rest
		const prof = Array.from({ length: 33 }, (_, k) => {
			const x = k / 32;
			return x <= 0.25 ? 0.9 * (x / 0.25) : 0.9 + 0.1 * ((x - 0.25) / 0.75);
		});
		const amb = { clipId: 'amb', weight: 'ambient' as const, startSec: 0, endSec: 4 };
		const late = ev({ clipId: 'h', weight: 'hero', startSec: 3, endSec: 4 });
		const r = solveSfxGains([ev({ ...amb, energyProfile: prof }), late]);
		// its mean power over 4 s is −38 dB at 500 Hz; the last second holds 0.1 / 3 of its energy: × 4 s / 1 s
		const eff = dB10(e10(-40) + ((0.1 / 3) * 4) * e10(-38));
		expect(one(r, 'h').gainDb).toBeCloseTo(Math.round((eff + 25) * 100) / 100, 9);
		// spread evenly: 1 s of 4 → 1 × its mean power
		const even = solveSfxGains([ev(amb), late]);
		expect(one(even, 'h').gainDb).toBeCloseTo(Math.round((dB10(e10(-40) + e10(-38)) + 25) * 100) / 100, 9);
		// a broken profile is reported and replaced by the even spread
		const bad = solveSfxGains([ev({ ...amb, energyProfile: [0, 2, 1] }), late]);
		expect(one(bad, 'h').gainDb).toBe(one(even, 'h').gainDb);
		expect(bad.warnings.map((w) => w.code)).toContain('W_SANITISED');
	});

	it('a support masks a hero (not the other way round); peers and the layers of one cue do not mask each other', () => {
		const r = solveSfxGains([
			ev({ clipId: 'h', weight: 'hero', startSec: 0, endSec: 0.5 }),
			ev({ clipId: 's', weight: 'support', startSec: 2, endSec: 2.5 }), // apart from the hero
			ev({ clipId: 's2', weight: 'support', startSec: 2, endSec: 2.5 }), // its peer, same window
			ev({ clipId: 'w', weight: 'support', startSec: 0.2, endSec: 0.5, soundBandsDb: [-60, -60, -60, -60, -20, -30, -60] }),
		]);
		// peers: both as alone (−40 + 3.5 + 20)
		expect(one(r, 's').gainDb).toBeCloseTo(-16.5, 9);
		expect(one(r, 's2').gainDb).toBeCloseTo(-16.5, 9);
		expect(one(r, 's').maskedBy).toEqual([]);
		// the whoosh (2 kHz) under the hero is shadowed by it, and the hero does not mask it
		expect(one(r, 'w').maskedBy).toEqual([]);
		expect(one(r, 'w').limitedBy).toEqual(['hero-shadow']);
		// the hero sees the whoosh in its bed, but at 500 Hz the whoosh has only −60 + g: a tiny masking
		expect(one(r, 'h').maskedBy).toEqual(['w']);
		expect(one(r, 'h').sfxMaskingDb).toBe(0); // +0.0004 dB, under the 0.01 dB step
		// layers of one cue: one designed sound
		const layered = solveSfxGains([
			ev({ clipId: 'h', weight: 'hero', cueKey: 'cue1' }),
			ev({ clipId: 'l', weight: 'support', cueKey: 'cue1' }),
			ev({ clipId: 'other', weight: 'ambient', startSec: 0, endSec: 0.5, cueKey: 'cue2' }),
		]);
		expect(one(layered, 'h').maskedBy).toEqual(['other']);
		expect(one(layered, 'l').maskedBy).toEqual(['other']);
	});

	it('converges in bounded iterations when consistency couples a hero to its masker', () => {
		// the same library sound as a hero and as an ambience under it: consistency (±2 dB around their median) pulls
		// the ambience up when the hero rises, which raises the hero's bed again — a monotone, contracting loop
		const events = [
			ev({ clipId: 'h', weight: 'hero', soundId: 'x', bedBandsDb: Array(7).fill(-50) }),
			ev({ clipId: 'a', weight: 'ambient', soundId: 'x', bedBandsDb: Array(7).fill(-40) }),
		];
		const r = solveSfxGains(events);
		expect(r.stats.converged).toBe(true);
		expect(r.stats.iterations).toBeGreaterThan(3);
		expect(r.stats.iterations).toBeLessThanOrEqual(MAX_MASKING_ITERATIONS + 1);
		expect(r.warnings.filter((w) => w.code === 'W_UNCONVERGED')).toEqual([]);
		const h = one(r, 'h');
		const a = one(r, 'a');
		expect(h.maskedBy).toEqual(['a']);
		expect(Math.abs(h.gainDb - a.gainDb)).toBeLessThanOrEqual(4 + 0.02);
		// a fixed point: the hero's bed is the bed ⊕ the ambience at its final gain (the brute-force oracle below)
		expect(h.sfxMaskingDb).toBeCloseTo(oracleMaskingDb(r.events, events)[0]!, 2);
		// without the masking: two passes' worth of difference
		expect(h.gainDb).toBeGreaterThan(one(solveSfxGains(events, { sfxMasking: false }), 'h').gainDb + 3);
	});
});

describe('summed true peak of overlapping sounds', () => {
	const hot = { bedBandsDb: Array(7).fill(-20), bedLocalPeakLu: 0, truePeakDb: -3 }; // each wants +5 → headroom +2

	it('two heroes that overlap are lowered together until their summed true peak meets the ceiling', () => {
		const r = solveSfxGains([
			ev({ clipId: 'a', weight: 'hero', ...hot, startSec: 0, endSec: 1 }),
			ev({ clipId: 'b', weight: 'hero', ...hot, startSec: 0.5, endSec: 1.5 }),
		]);
		// alone each stops at −1 dBTP (+2 dB); together 2 · 10^(−1/20) = +5.02 dBTP → both −6.02 dB lower
		// (rounded down to the 0.01 dB step: the solver stays inside the allowed interval)
		const g = Math.floor((2 - 20 * Math.log10(2)) * 100) / 100;
		for (const id of ['a', 'b']) {
			expect(one(r, id).gainDb, id).toBeCloseTo(g, 9);
			expect(one(r, id).limitedBy, id).toEqual(['headroom', 'overlap-headroom']);
			expect(one(r, id).overlapTruePeakDb!, id).toBeLessThanOrEqual(-1 + 0.005);
			expect(one(r, id).reason, id).toContain('overlapping');
		}
		expect(20 * Math.log10(2 * amp(-3 + g))).toBeLessThanOrEqual(-1 + 0.005);
		// apart: no change
		const apart = solveSfxGains([
			ev({ clipId: 'a', weight: 'hero', ...hot, startSec: 0, endSec: 1 }),
			ev({ clipId: 'b', weight: 'hero', ...hot, startSec: 1, endSec: 2 }),
		]);
		expect(one(apart, 'a').gainDb).toBe(2);
		expect(one(apart, 'a').limitedBy).toEqual(['headroom']);
		expect(one(apart, 'a').overlapTruePeakDb).toBeCloseTo(-1, 9);
	});

	it('a chain: the middle event is in both cliques and takes the larger cut; each clique holds', () => {
		const r = solveSfxGains([
			ev({ clipId: 'a', weight: 'hero', ...hot, startSec: 0, endSec: 1 }),
			ev({ clipId: 'b', weight: 'hero', ...hot, startSec: 0.9, endSec: 2 }),
			ev({ clipId: 'c', weight: 'hero', ...hot, truePeakDb: -9, startSec: 1.9, endSec: 3 }),
		]);
		const tp = (id: string, p: number) => p + one(r, id).gainDb;
		const ab = 20 * Math.log10(amp(tp('a', -3)) + amp(tp('b', -3)));
		const bc = 20 * Math.log10(amp(tp('b', -3)) + amp(tp('c', -9)));
		expect(ab).toBeLessThanOrEqual(-1 + 0.01);
		expect(bc).toBeLessThanOrEqual(-1 + 0.01);
		expect(one(r, 'b').gainDb).toBeLessThanOrEqual(one(r, 'c').gainDb);
	});

	it('a member held by an earlier constraint keeps it; the others absorb the cut', () => {
		// at the gain floor: a loud sound (0 dB bands) over a quiet bed wants −35 dB, clamped to −30; +20 dBTP → −10
		const floor = {
			weight: 'hero' as const,
			soundBandsDb: Array(7).fill(0),
			baseGainDb: -45,
			startSec: 0,
			endSec: 1,
		};
		const r = solveSfxGains([
			ev({ clipId: 'x', ...floor, truePeakDb: 20 }),
			ev({ clipId: 'y', weight: 'hero', ...hot, startSec: 0, endSec: 1 }),
		]);
		expect(one(r, 'x').gainDb).toBe(-30);
		expect(one(r, 'x').limitedBy).toEqual(['clamp']);
		const sum = 20 * Math.log10(amp(20 - 30) + amp(-3 + one(r, 'y').gainDb));
		expect(sum).toBeLessThanOrEqual(-1 + 0.005);
		expect(sum).toBeGreaterThan(-1.05);
		expect(one(r, 'y').limitedBy).toEqual(['headroom', 'overlap-headroom']);
		expect(r.warnings.filter((w) => w.code === 'W_UNRESOLVED' || w.code === 'W_CONFLICT')).toEqual([]);
		// when the held members alone are over the ceiling (2 × −5 dBTP = +1), the others go as low as they can and
		// the held ones name the conflict (the gain range, earlier, is kept)
		const c = solveSfxGains([
			ev({ clipId: 'x1', ...floor, truePeakDb: 25 }),
			ev({ clipId: 'x2', ...floor, truePeakDb: 25 }),
			ev({ clipId: 'y', weight: 'hero', ...hot, startSec: 0, endSec: 1 }),
		]);
		expect(one(c, 'y').gainDb).toBe(-30);
		expect(one(c, 'y').limitedBy).toContain('overlap-headroom');
		expect(one(c, 'x1').limitedBy).toContain('conflict:clamp/headroom');
		expect(one(c, 'x2').limitedBy).toContain('conflict:clamp/headroom');
		expect(c.warnings.filter((w) => w.code === 'W_UNRESOLVED')).toEqual([]);
	});
});

// ── oracle and properties ────────────────────────────────────────────────────────────────────────────────────────

/** Brute-force effective-bed masking (dB over the bed in the dominant bands) of every event at the solved gains. */
function oracleMaskingDb(out: SolverResult['events'], events: SolverEvent[]): number[] {
	const bands = [125, 250, 500, 1000, 2000, 4000, 8000];
	return events.map((e, i) => {
		const dom = out[i]!.dominantBands.map((hz) => bands.indexOf(hz));
		const len = e.endSec - e.startSec;
		if (!dom.length || !(len > 0)) return 0;
		let bed = 0;
		let all = 0;
		for (const b of dom) bed += e10(Math.max(-120, e.bedBandsDb[b]!));
		all = bed;
		events.forEach((m, j) => {
			if (j === i || !(RANK[m.weight] < RANK[e.weight])) return;
			if (e.cueKey && m.cueKey === e.cueKey) return;
			if (!out[j]!.dominantBands.length) return;
			const ov = Math.min(e.endSec, m.endSec) - Math.max(e.startSec, m.startSec);
			if (!(ov > 0) || !(m.endSec - m.startSec > 0)) return;
			for (const b of dom) all += e10(Math.max(-120, m.soundBandsDb[b]!) + out[j]!.gainDb) * (ov / len);
		});
		return dB10(all) - dB10(bed);
	});
}

const level = fc.double({ min: -120, max: 0, noNaN: true });
const arbEvent = (i: number) =>
	fc.record({
		clipId: fc.constant(`c${i}`),
		soundId: fc.constantFrom('', 's1', 's2', 's3'),
		type: fc.constantFrom('', 'hit', 'whoosh', 'click'),
		weight: fc.constantFrom<SolverWeight>('hero', 'support', 'ambient'),
		cueKey: fc.option(fc.constantFrom('k1', 'k2'), { nil: undefined }),
		startSec: fc.double({ min: 0, max: 4, noNaN: true }),
		len: fc.double({ min: 0, max: 2, noNaN: true }),
		soundBandsDb: fc.array(level, { minLength: 7, maxLength: 7 }),
		bedBandsDb: fc.array(level, { minLength: 7, maxLength: 7 }),
		soundPeakLu: fc.option(fc.double({ min: -70, max: 0, noNaN: true })),
		truePeakDb: fc.option(fc.double({ min: -60, max: 6, noNaN: true })),
		bedLocalPeakLu: fc.option(fc.double({ min: -80, max: 0, noNaN: true })),
		speechOverlap: fc.boolean(),
		baseGainDb: fc.double({ min: -40, max: 15, noNaN: true }),
	});
const arbEvents = fc
	.integer({ min: 1, max: 12 })
	.chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbEvent(i))))
	.map((xs) =>
		xs.map(({ len, cueKey, ...e }): SolverEvent => ({
			...e,
			endSec: e.startSec + len,
			...(cueKey ? { cueKey } : {}),
		})),
	);
const ceilingArb = fc.double({ min: -12, max: 0, noNaN: true });

/** Largest summed true peak (dBTP) of measured events active together, at the solved gains (interval cliques). */
function worstOverlapDb(events: SolverEvent[], r: SolverResult, unexplained: boolean): number {
	let worst = Number.NEGATIVE_INFINITY;
	const lostHeadroom = (i: number) => r.events[i]!.limitedBy.some((l) => l.startsWith('conflict:') && l.endsWith('/headroom'));
	events.forEach((e, i) => {
		if (e.truePeakDb === null) return;
		let s = 0;
		let explained = false;
		events.forEach((m, j) => {
			if (m.truePeakDb === null) return;
			const active =
				j === i ||
				(m.startSec <= e.startSec && (m.endSec > e.startSec || (m.endSec === m.startSec && m.startSec === e.startSec)));
			if (!active) return;
			s += amp(m.truePeakDb + r.events[j]!.gainDb);
			if (lostHeadroom(j)) explained = true;
		});
		if (unexplained && explained) return;
		worst = Math.max(worst, 20 * Math.log10(s));
	});
	return worst;
}

describe('properties', () => {
	it('the summed true peak of overlapping sounds never exceeds the ceiling (unless a reported conflict says so)', () => {
		fc.assert(
			fc.property(arbEvents, ceilingArb, (events, ceiling) => {
				const r = solveSfxGains(events, { truePeakCeilingDb: ceiling });
				expect(r.warnings.filter((w) => w.code === 'W_UNRESOLVED')).toEqual([]);
				expect(worstOverlapDb(events, r, true)).toBeLessThanOrEqual(ceiling + 0.005 * events.length + 1e-9);
			}),
			{ numRuns: 500 },
		);
	});

	it('without repeat groups nothing can override it: the summed true peak always holds', () => {
		fc.assert(
			fc.property(arbEvents, ceilingArb, (raw, ceiling) => {
				// unique sounds and types: no consistency group (the only constraint before headroom that may raise a gain)
				const events = raw.map((e, i) => ({ ...e, soundId: `u${i}`, type: `t${i}` }));
				const r = solveSfxGains(events, { truePeakCeilingDb: ceiling });
				const held = r.events.some((e) => e.limitedBy.some((l) => l.endsWith('/headroom')));
				if (!held) expect(worstOverlapDb(events, r, false)).toBeLessThanOrEqual(ceiling + 0.005 * events.length + 1e-9);
			}),
			{ numRuns: 500 },
		);
	});

	it('converges (bounded iterations), and the reported masking equals a brute-force oracle at the solved gains', () => {
		fc.assert(
			fc.property(arbEvents, (events) => {
				const r = solveSfxGains(events);
				expect(r.stats.converged).toBe(true);
				expect(r.stats.iterations).toBeLessThanOrEqual(MAX_MASKING_ITERATIONS + 1);
				const want = oracleMaskingDb(r.events, events);
				r.events.forEach((e, i) => {
					if (e.sfxMaskingDb === null) return;
					expect(Math.abs(e.sfxMaskingDb - want[i]!), e.clipId).toBeLessThan(0.011);
					// a hero / support with nothing holding it reaches its target over the masked bed
					if (e.limitedBy.length === 0 && e.achievedLiftDb !== null)
						expect(e.achievedLiftDb, e.clipId).toBeGreaterThanOrEqual(TARGET_LIFT_DB[events[i]!.weight] - 0.011);
				});
			}),
			{ numRuns: 400 },
		);
	});

	it('deterministic, and independent of the input order', () => {
		fc.assert(
			fc.property(arbEvents, fc.integer(), (events, seed) => {
				const a = solveSfxGains(events);
				expect(solveSfxGains(structuredClone(events))).toEqual(a);
				const perm = [...events].sort(
					(x, y) => ((x.clipId.charCodeAt(1) * 7919 + seed) % 13) - ((y.clipId.charCodeAt(1) * 7919 + seed) % 13),
				);
				expect(solveSfxGains(perm).gains).toEqual(a.gains);
			}),
			{ numRuns: 200 },
		);
	});
});
