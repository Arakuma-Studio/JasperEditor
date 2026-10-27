// Beats of music for Sound Design beat cues (spec 12 §2.2 "beats (engine)", P6-R2; wp-note "Phase 6 → WP6.2"):
// `analyzeBeats` shares the remix's beat tracker and puts each beat on its attack. Click tracks (with and without an
// accented downbeat) and the generated test music: tempo within 1 BPM, attacks within 5 ms, downbeats when accented.
import { describe, expect, it } from 'vitest';
import { analyzeBeats, RemixError } from '../src/analysis/remix.ts';
import { clickTrack } from './clicks.ts';
import { testMusic } from './music.ts';

const SR = 22050;

const worstMs = (beats: number[], truth: number[], sr: number) => {
	let w = 0;
	for (const b of beats) w = Math.max(w, Math.min(...truth.map((t) => Math.abs(t - b))));
	return (1000 * w) / sr;
};

describe('analyzeBeats', () => {
	it('the generated test music: beats on the drums; deterministic; 48 kHz too', () => {
		const { audio, beats: truth } = testMusic(SR, 120, 8, 3);
		const a = analyzeBeats(audio, SR);
		expect(Math.abs(a.bpm - 120)).toBeLessThan(1);
		expect(worstMs(a.beats, truth, SR)).toBeLessThan(12);
		expect(analyzeBeats(audio, SR)).toEqual(a);
		const hi = clickTrack(48000, 100, 10);
		expect(worstMs(analyzeBeats(hi.audio, 48000).beats, hi.clicks, 48000)).toBeLessThan(5);
	});

	it('refuses audio without a pulse, and too few beats', () => {
		const noise = new Float32Array(SR * 4);
		let s = 1;
		for (let i = 0; i < noise.length; i++) {
			s = (s * 1664525 + 1013904223) >>> 0;
			noise[i] = (s / 2 ** 32 - 0.5) * 0.5;
		}
		expect(() => analyzeBeats([noise], SR)).toThrow(RemixError);
		expect(() => analyzeBeats([new Float32Array(SR)], SR)).toThrow(RemixError);
		expect(() => analyzeBeats(clickTrack(SR, 120, 1.2).audio, SR)).toThrow(RemixError);
	});
});
