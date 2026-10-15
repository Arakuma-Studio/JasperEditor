// The project taxonomy (`@jasper/project/sound`) duplicates the judge profiles because the model may not import
// audio-fx (ARCHITECTURE §3.1). This test keeps the two copies identical (spec 12 §2.1, wp-note "WP1.1a").
import {
	SOUND_TYPE_IDS as PROJECT_TYPE_IDS,
	SOUND_TYPE_PROFILES,
	SOUND_TYPES,
	type SoundTypeProfile as ProjectProfile,
} from '@jasper/project/sound';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TYPE_PROFILES, judgeSound, SOUND_TYPE_IDS, type SoundTypeProfile } from '../src/index.ts';

describe('project taxonomy ↔ audio-fx judge profiles', () => {
	it('have the same type ids in the same order', () => {
		expect([...PROJECT_TYPE_IDS]).toEqual([...SOUND_TYPE_IDS]);
	});

	it('have deep-equal profiles for every type, with exactly the same fields', () => {
		for (const id of SOUND_TYPE_IDS) {
			expect(SOUND_TYPE_PROFILES[id], id).toEqual(DEFAULT_TYPE_PROFILES[id]);
			expect(SOUND_TYPES[id].profile, id).toEqual(DEFAULT_TYPE_PROFILES[id]);
			expect(Object.keys(SOUND_TYPE_PROFILES[id]).sort(), id).toEqual(Object.keys(DEFAULT_TYPE_PROFILES[id]).sort());
		}
		expect(SOUND_TYPE_PROFILES).toEqual(DEFAULT_TYPE_PROFILES);
	});

	it('are interchangeable types: a project profile can be passed to judgeSound', () => {
		const p: ProjectProfile = SOUND_TYPES.hit.profile;
		const asFx: SoundTypeProfile = p;
		const back: ProjectProfile = DEFAULT_TYPE_PROFILES.hit;
		expect(back).toEqual(asFx);
		const r = judgeSound(
			{
				durationSec: 1,
				peakSec: 0.01,
				onsetSec: 0.005,
				riseMs: 1,
				decayMs: 100,
				decays: true,
				tailSec: 0.5,
				centroidHz: 1500,
				rolloff85Hz: 4000,
				below150Share: 0.1,
				above6kShare: 0.05,
				flatness: 0.05,
				octaveBandsDb: [-30, -25, -20, -18, -19, -24, -33],
				pitchMidi: null,
				pitchConfidence: 0.2,
				onsetCount: 1,
				integratedLufs: -20,
				maxMomentaryLufs: -14,
				truePeakDb: -1,
				stereoWidth: 0,
				headQuietSec: 0.004,
				loopable: false,
			},
			asFx,
		);
		expect(r).toEqual({ ok: true, score: 1, reasons: [] });
	});
});
