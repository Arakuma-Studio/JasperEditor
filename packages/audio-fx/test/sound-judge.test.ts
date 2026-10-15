// Table tests of the sound judge (spec 12 P1-R2).
import { describe, expect, it } from 'vitest';
import {
	CLIPPED_TRUE_PEAK_DB,
	DEFAULT_TYPE_PROFILES,
	JUDGE_REASONS,
	type JudgeReason,
	judgeSound,
	SOUND_TYPE_IDS,
	type SoundDescriptors,
	type SoundTypeProfile,
} from '../src/index.ts';

/** A clean, short, decaying, single hit. */
const HIT: SoundDescriptors = {
	durationSec: 0.8,
	peakSec: 0.01,
	onsetSec: 0.005,
	riseMs: 2,
	decayMs: 150,
	decays: true,
	tailSec: 0.6,
	centroidHz: 1800,
	rolloff85Hz: 4000,
	below150Share: 0.3,
	above6kShare: 0.05,
	flatness: 0.1,
	octaveBandsDb: [-20, -18, -15, -12, -14, -20, -30],
	pitchMidi: null,
	pitchConfidence: 0.3,
	onsetCount: 1,
	integratedLufs: -18,
	maxMomentaryLufs: -14,
	truePeakDb: -1,
	stereoWidth: 0.1,
	headQuietSec: 0.004,
	loopable: false,
};

const PROFILE: SoundTypeProfile = {
	minDurSec: 0.05,
	maxDurSec: 4,
	maxRiseMs: 20,
	mustDecay: true,
	maxBelow150Share: 0.6,
	maxAbove6kShare: 0.5,
	maxFlatness: 0.5,
	singleHit: true,
	minMaxMomentaryLufs: -40,
};

describe('judgeSound', () => {
	it('accepts a sound inside every limit with score 1', () => {
		expect(judgeSound(HIT, PROFILE)).toEqual({ ok: true, score: 1, reasons: [] });
	});

	const cases: [JudgeReason, Partial<SoundDescriptors>, Partial<SoundTypeProfile>?][] = [
		['boomy', { below150Share: 0.7 }],
		['hissy', { above6kShare: 0.6 }],
		['noisy', { flatness: 0.8 }],
		['soft-attack', { riseMs: 45 }],
		['non-decaying', { decays: false }],
		['too-long', { durationSec: 5 }],
		['too-short', { durationSec: 0.02 }],
		['clipped', { truePeakDb: 1.2 }],
		['multi-hit', { onsetCount: 3 }],
		['quiet', { maxMomentaryLufs: -50 }],
		['quiet', { maxMomentaryLufs: null, integratedLufs: null }],
	];
	it.each(cases)('flags %s', (reason, change) => {
		const r = judgeSound({ ...HIT, ...change }, PROFILE);
		expect(r.ok).toBe(false);
		expect(r.reasons).toEqual([reason]);
		expect(r.score).toBeGreaterThan(0);
		expect(r.score).toBeLessThan(1);
	});

	it('values exactly on a limit pass', () => {
		const r = judgeSound(
			{
				...HIT,
				durationSec: 4,
				riseMs: 20,
				below150Share: 0.6,
				above6kShare: 0.5,
				flatness: 0.5,
				maxMomentaryLufs: -40,
				truePeakDb: CLIPPED_TRUE_PEAK_DB,
			},
			PROFILE,
		);
		expect(r).toEqual({ ok: true, score: 1, reasons: [] });
		expect(judgeSound({ ...HIT, durationSec: 0.05 }, PROFILE).ok).toBe(true);
	});

	it('profile switches: no rise limit, no decay needed, no flatness limit, several hits allowed', () => {
		const lax: SoundTypeProfile = {
			...PROFILE,
			maxRiseMs: null,
			mustDecay: false,
			maxFlatness: null,
			singleHit: false,
		};
		expect(judgeSound({ ...HIT, riseMs: 900, decays: false, flatness: 1, onsetCount: 9 }, lax).ok).toBe(true);
	});

	it('lists every reason in a fixed order and lowers the score with each one', () => {
		const worst: SoundDescriptors = {
			...HIT,
			below150Share: 0.95,
			above6kShare: 0.9,
			flatness: 0.95,
			riseMs: 500,
			decays: false,
			durationSec: 0.01,
			truePeakDb: 3,
			onsetCount: 6,
			maxMomentaryLufs: -70,
		};
		const all = judgeSound(worst, PROFILE);
		expect(all.reasons).toEqual(JUDGE_REASONS.filter((r) => r !== 'too-long'));
		expect(all.score).toBeLessThan(0.05);
		const two = judgeSound({ ...HIT, below150Share: 0.95, onsetCount: 6 }, PROFILE);
		const one = judgeSound({ ...HIT, below150Share: 0.95 }, PROFILE);
		expect(one.score).toBeGreaterThan(two.score);
		expect(two.score).toBeGreaterThan(all.score);
	});

	it('severity grows with the distance outside the limit', () => {
		const a = judgeSound({ ...HIT, durationSec: 4.5 }, PROFILE).score;
		const b = judgeSound({ ...HIT, durationSec: 12 }, PROFILE).score;
		expect(a).toBeGreaterThan(b);
		const q1 = judgeSound({ ...HIT, maxMomentaryLufs: -42 }, PROFILE).score;
		const q2 = judgeSound({ ...HIT, maxMomentaryLufs: -70 }, PROFILE).score;
		expect(q1).toBeGreaterThan(q2);
	});

	it('never throws on odd profiles: non-finite limits are not checked', () => {
		const odd = {
			...PROFILE,
			minDurSec: Number.NaN,
			maxDurSec: Number.POSITIVE_INFINITY,
			maxRiseMs: Number.NaN,
			maxBelow150Share: Number.NaN,
			minMaxMomentaryLufs: Number.NEGATIVE_INFINITY,
		} as SoundTypeProfile;
		const r = judgeSound(
			{ ...HIT, durationSec: 1000, riseMs: 1000, below150Share: 1, maxMomentaryLufs: null },
			odd,
		);
		expect(r).toEqual({ ok: true, score: 1, reasons: [] });
	});
});

describe('DEFAULT_TYPE_PROFILES', () => {
	it('has a sane profile for every type id (19 effects + ambience + roomtone)', () => {
		expect(SOUND_TYPE_IDS).toHaveLength(21);
		expect(Object.keys(DEFAULT_TYPE_PROFILES).sort()).toEqual([...SOUND_TYPE_IDS].sort());
		for (const id of SOUND_TYPE_IDS) {
			const p = DEFAULT_TYPE_PROFILES[id];
			expect(Object.keys(p).sort()).toEqual(Object.keys(PROFILE).sort());
			expect(p.minDurSec).toBeGreaterThan(0);
			expect(p.maxDurSec).toBeGreaterThan(p.minDurSec);
			if (p.maxRiseMs !== null) expect(p.maxRiseMs).toBeGreaterThan(0);
			for (const v of [p.maxBelow150Share, p.maxAbove6kShare, p.maxFlatness ?? 0.5]) {
				expect(v).toBeGreaterThan(0);
				expect(v).toBeLessThanOrEqual(1);
			}
			expect(p.minMaxMomentaryLufs).toBeLessThan(0);
			expect(Object.isFrozen(p)).toBe(true);
		}
	});

	it('types that are one strike are single-hit and must decay; beds are neither', () => {
		for (const id of ['hit', 'boom', 'click', 'tick', 'tap', 'pop', 'thump', 'key'] as const) {
			expect(DEFAULT_TYPE_PROFILES[id].singleHit, id).toBe(true);
			expect(DEFAULT_TYPE_PROFILES[id].mustDecay, id).toBe(true);
		}
		for (const id of ['ambience', 'roomtone', 'riser', 'whoosh'] as const) {
			expect(DEFAULT_TYPE_PROFILES[id].singleHit, id).toBe(false);
			expect(DEFAULT_TYPE_PROFILES[id].mustDecay, id).toBe(false);
		}
		expect(DEFAULT_TYPE_PROFILES.ambience.maxDurSec).toBeGreaterThanOrEqual(600);
	});
});
