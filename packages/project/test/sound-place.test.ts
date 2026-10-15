import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	FLICKS_PER_SECOND,
	flicksPerFrame,
	type PeakAlignInput,
	peakAlignedStart,
	RATES,
} from '../src/index.ts';

const fps30 = { num: 30, den: 1 };
const ok = (input: PeakAlignInput) => {
	const r = peakAlignedStart(input);
	if (!r.ok) throw new Error(r.message);
	return r;
};

describe('peakAlignedStart (spec 12 §2.3)', () => {
	it('trims the sub-frame rest from a quiet head: the peak lands exactly on the cue', () => {
		const r = ok({
			cueFrame: 30,
			peakSec: 0.05,
			durationSec: 1,
			headQuietSec: 0.02,
			fps: fps30,
			align: 'peak',
		});
		expect(r.start).toBe(29);
		expect(r.sourceInFlicks).toBe(11_760_000); // 1/60 s
		expect(r.errorFlicks).toBe(0);
		expect(r.alignFlicks).toBe(35_280_000);
		// the peak plays at start·F + (peak − In) = cue·F
		const F = flicksPerFrame(fps30);
		expect(r.start * F + r.alignFlicks - r.sourceInFlicks).toBe(30 * F);
		expect(r.durationFrames).toBe(30); // (1 s − 1/60 s) at 30 fps = 29.5 frames → 30
	});

	it('without enough quiet head it plays late by the rest (under one frame); subFrame:false never trims', () => {
		const late = ok({
			cueFrame: 30,
			peakSec: 0.05,
			durationSec: 1,
			headQuietSec: 0.01,
			fps: fps30,
			align: 'peak',
		});
		expect(late).toMatchObject({ start: 29, sourceInFlicks: 0, errorFlicks: 11_760_000 });
		const frameOnly = ok({
			cueFrame: 30,
			peakSec: 0.05,
			durationSec: 1,
			headQuietSec: 0.5,
			fps: fps30,
			align: 'peak',
			subFrame: false,
		});
		expect(frameOnly).toMatchObject({ start: 29, sourceInFlicks: 0, errorFlicks: 11_760_000 });
	});

	it('aligns risers by their end, UI by the onset, and divides by the playback rate', () => {
		expect(ok({ cueFrame: 100, peakSec: 1.9, durationSec: 2, fps: fps30, align: 'end' })).toMatchObject({
			start: 40,
			sourceInFlicks: 0,
			errorFlicks: 0,
			durationFrames: 60,
		});
		expect(
			ok({ cueFrame: 10, peakSec: 0.2, onsetSec: 0.11, durationSec: 0.5, fps: fps30, align: 'start' }),
		).toMatchObject({ start: 7, sourceInFlicks: 0, errorFlicks: 7_056_000 }); // 0.3 frame late, no quiet head
		// at 2× the 2 s riser lasts 1 s
		expect(
			ok({ cueFrame: 100, peakSec: 0, durationSec: 2, rate: 2, fps: fps30, align: 'end' }),
		).toMatchObject({
			start: 70,
			durationFrames: 30,
		});
	});

	it('refuses a start before frame 0 with E_INVALID_PARAM, or clamps and trims the head when asked', () => {
		const r = peakAlignedStart({ cueFrame: 10, peakSec: 0, durationSec: 3, fps: fps30, align: 'end' });
		expect(r).toMatchObject({ ok: false, code: 'E_INVALID_PARAM' });
		const c = ok({ cueFrame: 10, peakSec: 0, durationSec: 3, fps: fps30, align: 'end', clampStart: true });
		expect(c.start).toBe(0);
		expect(c.errorFlicks).toBe(0);
		// 3 s − 10 frames = 2.6667 s trimmed; the end still lands on frame 10
		expect(c.sourceInFlicks).toBe(3 * FLICKS_PER_SECOND - 10 * flicksPerFrame(fps30));
		expect(c.trimmedHeadSec).toBeCloseTo(2.666667, 5);
	});

	it('refuses hostile input with a typed error and never throws', () => {
		const base: PeakAlignInput = { cueFrame: 10, peakSec: 0.1, durationSec: 1, fps: fps30, align: 'peak' };
		const bad: Partial<Record<keyof PeakAlignInput, unknown>>[] = [
			{ cueFrame: -1 },
			{ cueFrame: 1.5 },
			{ cueFrame: Number.NaN },
			{ fps: { num: 0, den: 1 } },
			{ fps: { num: 30, den: 0 } },
			{ fps: null },
			{ rate: 0 },
			{ rate: Number.POSITIVE_INFINITY },
			{ durationSec: 0 },
			{ durationSec: 1e9 },
			{ peakSec: 2 },
			{ peakSec: -0.1 },
			{ peakSec: undefined },
			{ onsetSec: Number.NaN },
			{ headQuietSec: -1 },
			{ align: 'middle' },
		];
		for (const b of bad) {
			const r = peakAlignedStart({ ...base, ...b } as PeakAlignInput);
			expect(r.ok, JSON.stringify(b)).toBe(false);
			if (!r.ok) expect(r.code).toBe('E_INVALID_PARAM');
		}
		expect(peakAlignedStart(null as never).ok).toBe(false);
	});

	const fpsArb = fc.oneof(
		fc.constantFrom(...Object.values(RATES)),
		fc
			.record({ num: fc.integer({ min: 1, max: 120_000 }), den: fc.integer({ min: 1, max: 1001 }) })
			.filter((r) => r.num / r.den >= 1 && r.num / r.den <= 240),
	);
	const input = fc
		.record({
			cueFrame: fc.integer({ min: 0, max: 200_000 }),
			durationSec: fc.double({ min: 0.001, max: 60, noNaN: true }),
			peakFrac: fc.double({ min: 0, max: 1, noNaN: true }),
			onsetFrac: fc.double({ min: 0, max: 1, noNaN: true }),
			quietFrac: fc.oneof(fc.constant(0), fc.constant(1), fc.double({ min: 0, max: 1, noNaN: true })),
			rate: fc.oneof(fc.constant(1), fc.double({ min: 0.25, max: 4, noNaN: true })),
			fps: fpsArb,
			align: fc.constantFrom('peak' as const, 'start' as const, 'end' as const),
			subFrame: fc.boolean(),
			clampStart: fc.boolean(),
		})
		.map(
			(x): PeakAlignInput => ({
				cueFrame: x.cueFrame,
				durationSec: x.durationSec,
				peakSec: x.durationSec * x.peakFrac,
				onsetSec: x.durationSec * x.onsetFrac,
				headQuietSec: x.durationSec * x.quietFrac,
				rate: x.rate,
				fps: x.fps,
				align: x.align,
				subFrame: x.subFrame,
				clampStart: x.clampStart,
			}),
		);

	it('property: In ≥ 0, error < 1 frame, exact when the head is quiet, the aligned point lands where it says', () => {
		fc.assert(
			fc.property(input, (inp) => {
				const r = peakAlignedStart(inp);
				const F = flicksPerFrame(inp.fps);
				const rate = inp.rate ?? 1;
				const offset =
					inp.align === 'peak' ? inp.peakSec : inp.align === 'start' ? (inp.onsetSec ?? 0) : inp.durationSec;
				const alignSrc = offset * FLICKS_PER_SECOND;
				const k = Math.floor(alignSrc / rate / F);
				if (!r.ok) {
					// the only refusal for valid input: a start before frame 0 without clampStart
					expect(inp.clampStart).toBe(false);
					expect(inp.cueFrame - k).toBeLessThanOrEqual(0);
					return;
				}
				expect(Number.isInteger(r.start) && r.start >= 0).toBe(true);
				expect(Number.isInteger(r.sourceInFlicks) && r.sourceInFlicks >= 0).toBe(true);
				expect(r.errorFlicks).toBeGreaterThanOrEqual(0);
				expect(r.errorFlicks).toBeLessThan(F);
				// where the aligned point actually plays, in sequence flicks
				const lands = r.start * F + (alignSrc - r.sourceInFlicks) / rate;
				const tol = 2 + 1e-12 * Math.abs(lands);
				expect(Math.abs(lands - (inp.cueFrame * F + r.errorFlicks))).toBeLessThanOrEqual(tol + 0.5 / rate);
				const quiet = (inp.headQuietSec ?? 0) * FLICKS_PER_SECOND;
				if (r.trimmedHeadSec === 0) {
					// never trims audible sound
					expect(r.sourceInFlicks).toBeLessThanOrEqual(quiet + 1);
					if (inp.subFrame !== false && r.start > 0) {
						const rest = (alignSrc / rate - (inp.cueFrame - r.start) * F) * rate;
						// exact up to the In point's whole-flick rounding, stretched by slow rates
						if (quiet >= rest + 1) expect(r.errorFlicks).toBeLessThanOrEqual(Math.ceil(0.5 / rate));
					}
				}
				// the clip covers the rest of the sound, with less than a frame to spare
				const remaining = (inp.durationSec * FLICKS_PER_SECOND - r.sourceInFlicks) / rate;
				expect(r.durationFrames).toBeGreaterThanOrEqual(1);
				expect(r.durationFrames * F).toBeGreaterThanOrEqual(remaining - 1e-6 * F);
				if (r.durationFrames > 1) expect((r.durationFrames - 1) * F).toBeLessThan(remaining + 1e-6 * F);
			}),
			{ numRuns: 3000, seed: 20261015 },
		);
	});

	it('property: at 23.976, 29.97 (drop-frame) and 59.94 a quiet-headed peak is exact to the flick', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(RATES.r23_976, RATES.r29_97, RATES.r59_94),
				fc.integer({ min: 400, max: 1_000_000 }),
				fc.integer({ min: 0, max: 48_000 * 5 }),
				(fps, cueFrame, peakSample) => {
					const peakSec = peakSample / 48_000;
					const r = ok({ cueFrame, peakSec, durationSec: 6, headQuietSec: peakSec, fps, align: 'peak' });
					expect(r.errorFlicks).toBe(0);
					const F = flicksPerFrame(fps);
					expect(Number.isInteger(F)).toBe(true);
					expect(r.start * F + r.alignFlicks - r.sourceInFlicks).toBe(cueFrame * F);
				},
			),
			{ numRuns: 1000, seed: 42 },
		);
	});
});
