// Phase 1 verification: regression tests for review findings in the descriptors and the judge (each failed before).
import { describe, expect, it } from 'vitest';
import { analyzeSound, DEFAULT_TYPE_PROFILES, judgeSound } from '../src/index.ts';

describe('loudness descriptors stay in range', () => {
	it('a sub-normal "signal" reads as silence (null), not −900 LUFS', () => {
		const tiny = new Float32Array(48000).fill(1e-45);
		const d = analyzeSound([tiny, tiny], 48000);
		expect(d.maxMomentaryLufs).toBeNull();
		expect(d.integratedLufs).toBeNull();
		expect(d.truePeakDb).toBeNull();
	});
});

describe('judgeSound never throws', () => {
	it('missing descriptors or profile are not accepted', () => {
		expect(judgeSound(null as never, DEFAULT_TYPE_PROFILES.hit)).toEqual({
			ok: false,
			score: 0,
			reasons: [],
		});
		expect(judgeSound(undefined as never, undefined as never).ok).toBe(false);
	});
});
