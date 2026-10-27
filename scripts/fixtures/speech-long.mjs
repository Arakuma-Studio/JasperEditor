// Long speech for the Fix Transcript cost measurement (spec 17 SC-037; apps/engine/test/transcript-fix.bench.test.ts):
// lj-long.flac = the public-domain LJ composite (fixtures/speech/lj-composite.flac, 71.64 s, 12 sentences) played 11
// times back to back — 13.1 min of audio, 10.6 min of speech — as 16 kHz mono FLAC (FFmpeg's native LGPL `flac`
// encoder). Lossless and sample-exact (71.64 s × 16 kHz is a whole number of samples), so repeat k is the fixture's
// audio shifted by k × 71.64 s and its words are the fixture transcript's words shifted by the same amount.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = join(root, 'fixtures', 'speech', 'lj-composite.flac');
/** How many times the fixture plays. */
export const LJ_LONG_REPEATS = 11;

/** @param {import('./types.ts').FixtureContext} _ctx */
export function fixtures(_ctx) {
	if (!existsSync(SOURCE)) {
		console.log('skip   lj-long.flac (fixtures/speech/lj-composite.flac is missing)');
		return [];
	}
	return [
		{
			name: 'lj-long.flac',
			steps: (out) => [
				[
					...['-stream_loop', String(LJ_LONG_REPEATS - 1), '-i', SOURCE],
					...['-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'flac', '-f', 'flac', out],
				],
			],
		},
	];
}
