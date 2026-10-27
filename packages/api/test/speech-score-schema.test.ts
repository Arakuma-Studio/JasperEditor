// Spec 17 SC-092 / SC-030: the scoring request schema accepts the optional muted gaps of a packed window and refuses
// ranges outside their window; whatever the model's window builder produces is a valid request.
import { buildScoreWindows, type FixCandidate, scoreRequestWindows } from '@jasper/project/script-fix';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SpeechScoreRequestSchema } from '../src/index.ts';

const F = 705_600_000;
const base = (mute?: Array<{ start: number; end: number }>) => ({
	mediaId: 'mk_1',
	language: 'es',
	windows: [
		{ id: 'w0', start: F, end: 9 * F, readings: [{ id: 'asr', words: ['hola'] }], ...(mute ? { mute } : {}) },
	],
});

describe('SpeechScoreRequestSchema muted gaps (SC-030)', () => {
	it('mute is optional; ranges inside the window are accepted', () => {
		expect(SpeechScoreRequestSchema.safeParse(base()).success).toBe(true);
		expect(SpeechScoreRequestSchema.safeParse(base([])).success).toBe(true);
		expect(
			SpeechScoreRequestSchema.safeParse(
				base([
					{ start: 2 * F, end: 3 * F },
					{ start: 5 * F, end: 9 * F },
				]),
			).success,
		).toBe(true);
	});

	it('refuses ranges outside the window, empty or reversed ranges, unknown keys and more than 64 ranges', () => {
		for (const bad of [
			[{ start: 0, end: 2 * F }],
			[{ start: 8 * F, end: 10 * F }],
			[{ start: 3 * F, end: 3 * F }],
			[{ start: 4 * F, end: 3 * F }],
			[{ start: 2 * F, end: 3 * F, x: 1 }],
			[{ start: 2.5 * F + 0.5, end: 3 * F }],
			Array.from({ length: 65 }, (_, k) => ({ start: F + k * 1000, end: F + k * 1000 + 10 })),
		])
			expect(SpeechScoreRequestSchema.safeParse(base(bad as never)).success).toBe(false);
	});

	it('property: the windows buildScoreWindows makes are valid requests', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(fc.integer({ min: 1, max: 600_000_000 }), fc.integer({ min: 0, max: 2_500_000_000 })),
					{
						minLength: 1,
						maxLength: 200,
					},
				),
				fc.array(fc.nat(), { maxLength: 40 }),
				(spec, at) => {
					let t = 0;
					const words = spec.map(([dur, gap], k) => {
						const start = t + gap;
						t = start + dur;
						return { text: `w${k}`, start, end: start + dur };
					});
					const cs = at.map(
						(x, k) =>
							({
								id: `c${k}`,
								fromWord: x % words.length,
								toWord: (x % words.length) + 1,
								script: ['nuevo'],
								needsAudio: true,
							}) as unknown as FixCandidate,
					);
					const windows = scoreRequestWindows(buildScoreWindows(words, cs).windows);
					if (!windows.length) return;
					const r = SpeechScoreRequestSchema.safeParse({ mediaId: 'mk_1', language: 'es', windows });
					expect(r.success).toBe(true);
				},
			),
			{ numRuns: 200 },
		);
	});
});
