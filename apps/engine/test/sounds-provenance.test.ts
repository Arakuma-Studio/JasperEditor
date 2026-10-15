// The provenance a registered library sound carries (spec 12 §2.1; Phase 1 verification): time points of the
// registered file (lead silence included) and values kept inside the project schema, so registering never fails
// with a 500 on a number from an old cache or a broken file.
import type { SoundEntry } from '@jasper/api';
import { LibraryProvenanceSchema } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { provenanceOf } from '../src/sounds/service.ts';

const entry = (d: Partial<SoundEntry['descriptors']> = {}): SoundEntry =>
	({
		id: 'snd_0123456789abcdef',
		fingerprint: `q1:${'a'.repeat(64)}`,
		title: 'Hit',
		types: ['hit'],
		tags: [],
		source: { type: 'starter', file: 'hit.ogg' },
		license: 'CC0-1.0',
		author: 'Kenney',
		attribution: null,
		format: { durationSec: 0.5, sampleRate: 48000, channels: 2, container: 'ogg' },
		descriptors: {
			durationSec: 0.5,
			peakSec: 0.02,
			onsetSec: 0.01,
			riseMs: 1,
			decayMs: 100,
			decays: true,
			tailSec: 0.4,
			centroidHz: 900,
			rolloff85Hz: 3000,
			below150Share: 0.2,
			above6kShare: 0.01,
			flatness: 0.05,
			octaveBandsDb: [-20, -20, -20, -20, -20, -20, -20],
			pitchMidi: null,
			pitchConfidence: 0,
			onsetCount: 1,
			integratedLufs: -20,
			maxMomentaryLufs: -14,
			truePeakDb: -1,
			stereoWidth: 0,
			headQuietSec: 0,
			loopable: false,
			...d,
		},
		judge: null,
		indexedAt: '2026-10-15T00:00:00.000Z',
		analysisVersion: 1001,
	}) as SoundEntry;

describe('provenanceOf', () => {
	it('describes the registered file: descriptors moved by the lead silence, which it records', () => {
		const p = provenanceOf(entry(), 'h', 0.05);
		expect(p.leadSilenceSec).toBe(0.05);
		expect(p.descriptors).toMatchObject({ peakSec: 0.07, headQuietSec: 0.05, durationSec: 0.55 });
		expect(p.descriptors!.onsetSec).toBeCloseTo(0.06, 12);
		expect(provenanceOf(entry(), 'h').leadSilenceSec).toBeUndefined();
	});
	it('keeps values from old caches or broken files inside the schema instead of throwing', () => {
		const p = provenanceOf(
			entry({
				maxMomentaryLufs: -900,
				durationSec: 100_000,
				octaveBandsDb: [-900, 0, 0, 0, 0, 0, 900],
				centroidHz: 1e9,
			}),
			'h',
		);
		expect(LibraryProvenanceSchema.safeParse(p).success).toBe(true);
		expect(p.descriptors!.maxMomentaryLufs).toBeNull();
		expect(p.descriptors!.durationSec).toBeLessThan(86_400);
		expect(p.descriptors!.octaveBandsDb).toEqual([-400, 0, 0, 0, 0, 0, 400]);
	});
});
