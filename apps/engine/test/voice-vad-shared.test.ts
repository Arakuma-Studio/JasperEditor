// Spec 14 TC-002: the speech worker's VAD threshold now comes from the floor / speech-level code shared with the voice
// analysis (@jasper/audio-dsp `levelStats` + `speechThresholdDb`). This proves it is bit-identical to the speech
// worker's own implementation before the extraction (copied verbatim below) on arbitrary frame levels.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { vadThreshold } from '../src/speech/core/vad.ts';

/** `vadThreshold` as it was in apps/engine/src/speech/core/vad.ts before TC-002. */
function legacyVadThreshold(db: ArrayLike<number>): number {
	const s: number[] = [];
	for (let i = 0; i < db.length; i++) if (db[i]! > -100) s.push(db[i]!);
	if (!s.length) return -60;
	s.sort((a, b) => a - b);
	const q = (p: number) => s[Math.floor((s.length - 1) * p)]!;
	const floor = q(0.1);
	const speech = q(0.95);
	return Math.max(floor + 0.3 * (speech - floor), floor + 6);
}

describe('speech VAD threshold over the shared level code (TC-002)', () => {
	it('is bit-identical to the speech worker implementation it replaced', () => {
		const level = fc.oneof(
			fc.double({ min: -160, max: 10, noNaN: true }),
			fc.constantFrom(-100, -120, -99.99999, 0, -1e-12),
		);
		fc.assert(
			fc.property(fc.array(level, { maxLength: 400 }), (xs) => {
				expect(Object.is(vadThreshold(xs), legacyVadThreshold(xs))).toBe(true);
				const f32 = Float32Array.from(xs);
				expect(Object.is(vadThreshold(f32), legacyVadThreshold(f32))).toBe(true);
			}),
			{ numRuns: 2000 },
		);
	});
});
