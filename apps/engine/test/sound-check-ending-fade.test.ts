// Sound Check ENDING and a fade-out into the end (final verification B): the user walkthrough's Clip ▸ Audio Options ▸
// End on Bar faded the music out over one beat (constant power) into the bar line where the sequence ended; ENDING
// called that "ends mid-sound" (last 50 ms −44.6 dBFS RMS, last 10 ms −51.1 dBFS peak: over earshot's −60). A mix that
// fades out over its last half second ends; a mix cut at a loud frame, or one that only dips, still does not.
import { describe, expect, it } from 'vitest';
import { EdgeTap, endsWithFadeOut } from '../src/sound-design/check-findings.ts';

const SR = 48_000;

/** Stereo: a 440 Hz tone at `db` dBFS RMS for `seconds`, its last `fadeSec` faded by `curve` (gain 0 at the end). */
function tone(seconds: number, db: number, fadeSec: number, curve: (x: number) => number): Float32Array[] {
	const n = Math.round(seconds * SR);
	const a = Math.SQRT2 * 10 ** (db / 20);
	const x = new Float32Array(n);
	const f0 = n - Math.round(fadeSec * SR);
	for (let i = 0; i < n; i++) {
		const g = fadeSec > 0 && i >= f0 ? curve((n - i) / (n - f0)) : 1;
		x[i] = a * g * Math.sin((2 * Math.PI * 440 * i) / SR);
	}
	return [x, x.slice()];
}
function tapOf(ch: Float32Array[]) {
	const t = new EdgeTap(SR, 2);
	// in blocks, as the check renders
	for (let i = 0; i < ch[0]!.length; i += 1024) {
		const n = Math.min(1024, ch[0]!.length - i);
		t.push(
			ch.map((c) => c.subarray(i, i + n)),
			n,
		);
	}
	return t.result()!;
}

describe('ENDING and a fade-out into the end', () => {
	it('a one-beat constant-power fade into the end is an ending (no ENDING); a cut at a loud frame is not', () => {
		const faded = tapOf(tone(3, -15, 0.5, (x) => Math.sin((x * Math.PI) / 2)));
		// what the walkthrough measured, near enough: the fade's tail is over −60 dBFS peak (the old rule fired)
		expect(faded.tailPeakDb).toBeGreaterThan(-60);
		expect(faded.fadeFromDb).toBeCloseTo(-15, 0);
		expect(endsWithFadeOut(faded)).toBe(true);
		const cut = tapOf(tone(3, -15, 0, () => 1));
		expect(cut.tailRmsDb).toBeCloseTo(-15, 0);
		expect(endsWithFadeOut(cut)).toBe(false);
		// a 2 s linear fade to silence ends too
		expect(endsWithFadeOut(tapOf(tone(4, -15, 2, (x) => x)))).toBe(true);
	});

	it('a dip that does not reach the end quietly, a quiet tail still loud enough, or a mix shorter than the look-back: reported as before', () => {
		// −15 → −30 dBFS over the last half second: a 15 dB drop, not a fade-out
		const dip = tapOf(tone(3, -15, 0.5, (x) => 10 ** ((-15 * (1 - x)) / 20)));
		expect(endsWithFadeOut(dip)).toBe(false);
		// a fade from −5 dBFS that stops at −35 dBFS: 30 dB down, but the sound goes on at that level to the last sample
		const loudTail = tapOf(tone(3, -5, 0.5, (x) => 10 ** ((-30 * (1 - x)) / 20)));
		expect(endsWithFadeOut(loudTail)).toBe(false);
		// 0.3 s of audio: nothing half a second back
		const short = tapOf(tone(0.3, -15, 0.2, (x) => x));
		expect(short.fadeFromDb).toBeNull();
		expect(endsWithFadeOut(short)).toBe(false);
		expect(endsWithFadeOut({ tailRmsDb: -50, tailPeakDb: -60, fadeFromDb: Number.NaN })).toBe(false);
	});
});
