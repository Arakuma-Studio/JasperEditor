// Remix joints the music would be heard chopped at (final verification B): the user walkthrough landed a drop on a hero
// cue and the next Sound Check found the remix's own joint chopped (EDGE: the outgoing source kept sounding at
// −15 dBFS over −24 dBFS entering, with the remix's 33 ms crossfade). The planner now measures each joint with Sound
// Check's own rule and asks for 110 ms there (`jointCrossfadeSeconds`), 30 ms elsewhere.
import { describe, expect, it } from 'vitest';
import {
	blockMeanSquares,
	JOINT_LEVEL_HOP_S,
	jointCrossfadesSeconds,
	REMIX_ANALYSIS_RATE,
} from '../src/audio/remix.ts';

const SR = REMIX_ANALYSIS_RATE;
const HOP = Math.round(JOINT_LEVEL_HOP_S * SR);

/** A tone whose level (dBFS RMS) changes at the given seconds: [[fromSec, db], …]. */
function levels(seconds: number, steps: [number, number][]): Float32Array {
	const x = new Float32Array(Math.round(seconds * SR));
	for (let i = 0; i < x.length; i++) {
		const t = i / SR;
		let db = -120;
		for (const [from, d] of steps) if (t >= from) db = d;
		x[i] = Math.SQRT2 * 10 ** (db / 20) * Math.sin(2 * Math.PI * 220 * t);
	}
	return x;
}

describe('remix joint crossfades', () => {
	it('110 ms where the source keeps sounding over what enters, 30 ms where it decays or matches', () => {
		// 0–4 s loud (−15), 4–8 s quiet (−24), 8–12 s loud again
		const x = levels(12, [
			[0, -15],
			[4, -24],
			[8, -15],
		]);
		const ms = blockMeanSquares(x, HOP);
		const s = (sec: number) => Math.round(sec * SR);
		const out = jointCrossfadesSeconds(ms, HOP, [
			// loud piece cut at 2 s (the source goes on loud) → a quiet piece from 5 s: chopped
			[s(2), s(5)],
			// quiet piece cut at 6 s → a quiet piece from 4.5 s: the same level enters
			[s(6), s(4.5)],
			// loud piece cut at 4 s, where the source itself drops 9 dB → a quiet piece: not chopped (it already fell)
			[s(4), s(5)],
			// quiet piece cut at 7 s → a loud piece from 9 s: what enters is louder
			[s(7), s(9)],
		]);
		expect(out).toEqual([0.11, 0.03, 0.03, 0.03]);
	});

	it('is total: silence, empty envelopes, cuts outside the signal', () => {
		const ms = blockMeanSquares(new Float32Array(SR), HOP);
		expect(jointCrossfadesSeconds(ms, HOP, [[SR / 2, SR / 4]])).toEqual([0.03]);
		expect(jointCrossfadesSeconds(new Float32Array(0), HOP, [[100, 200]])).toEqual([0.03]);
		expect(jointCrossfadesSeconds(ms, HOP, [[-5, 10 * SR]])).toEqual([0.03]);
		expect(blockMeanSquares(new Float32Array([Number.NaN, 1, Number.POSITIVE_INFINITY, 1]), 2)).toEqual(
			new Float32Array([0.5, 0.5]),
		);
	});
});
