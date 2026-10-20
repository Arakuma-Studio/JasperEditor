// Shared fixtures of the sound-design tests.
import type { LibraryProvenance } from '../src/index.ts';

/** Valid provenance of a starter-kit hit. */
export const LIB: LibraryProvenance = {
	soundId: 'snd_0123456789abcdef',
	title: 'Impact Metal 03',
	types: ['hit'],
	source: { type: 'starter' },
	license: 'CC0-1.0',
	licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
	author: 'Kenney',
	sourceUrl: 'https://kenney.nl/assets/impact-sounds',
	attribution: null,
	descriptors: {
		peakSec: 0.0123,
		onsetSec: 0.011,
		headQuietSec: 0.0105,
		durationSec: 0.9,
		octaveBandsDb: [-30, -25, -20, -18, -19, -24, -33],
		centroidHz: 1820,
		maxMomentaryLufs: -14.2,
	},
	snapshotHash: 'sha256:abc',
};
