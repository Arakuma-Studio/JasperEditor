// Beats of music for Sound Design beat cues (spec 12 §2.2 "beats (engine)", P6-R2; wp-note "Phase 6 → WP6.2"):
// `analyzeBeats` shares the remix's beat tracker and puts each beat on its attack. Click tracks (with and without an
// accented downbeat) and the generated test music: tempo within 1 BPM, attacks within 5 ms, downbeats when accented.
import { describe, expect, it } from 'vitest';
import { analyzeBeats, RemixError } from '../src/analysis/remix.ts';
import { testMusic } from './music.ts';

const SR = 22050;

/** A click track: 2 ms decaying 2 kHz clicks at `bpm` from `offsetSec`, every 4th at `accent` × the others. */
export function clickTrack(
	sr: number,
	bpm: number,
	seconds: number,
	opts: { offsetSec?: number; accent?: number } = {},
): { audio: Float32Array[]; clicks: number[] } {
	const n = Math.round(seconds * sr);
	const x = new Float32Array(n);
	const period = (60 * sr) / bpm;
	const clicks: number[] = [];
	for (let k = 0; ; k++) {
		const at = Math.round((opts.offsetSec ?? 0.25) * sr + k * period);
		if (at >= n) break;
		clicks.push(at);
		const amp = k % 4 === 0 ? 0.4 * (opts.accent ?? 1) : 0.4;
		for (let i = 0; i < Math.round(0.03 * sr) && at + i < n; i++)
			x[at + i] = amp * Math.exp(-i / (0.004 * sr)) * Math.sin((2 * Math.PI * 2000 * i) / sr);
	}
	return { audio: [x], clicks };
}

const worstMs = (beats: number[], truth: number[], sr: number) => {
	let w = 0;
	for (const b of beats) w = Math.max(w, Math.min(...truth.map((t) => Math.abs(t - b))));
	return (1000 * w) / sr;
};

describe('analyzeBeats', () => {
	it('a click track: tempo within 1 BPM, every beat on its click within 5 ms', () => {
		for (const bpm of [90, 100, 120, 128]) {
			const { audio, clicks } = clickTrack(SR, bpm, 12);
			const a = analyzeBeats(audio, SR);
			expect(Math.abs(a.bpm - bpm), String(bpm)).toBeLessThan(1);
			expect(worstMs(a.beats, clicks, SR), String(bpm)).toBeLessThan(5);
			expect(a.beats.length).toBeGreaterThanOrEqual(clicks.length - 3);
		}
	});

	it('an accented click every 4 beats gives downbeats; an even click track does not', () => {
		const { audio, clicks } = clickTrack(SR, 120, 12, { accent: 2.5 });
		const a = analyzeBeats(audio, SR);
		expect(a.downbeats).not.toBeNull();
		const down = a.downbeats!.map((i) => a.beats[i]!);
		const accented = clicks.filter((_, k) => k % 4 === 0);
		expect(worstMs(down, accented, SR)).toBeLessThan(5);
		expect(a.downbeatConfidence).toBeGreaterThan(0.1);
		const even = analyzeBeats(clickTrack(SR, 120, 12).audio, SR);
		expect(even.downbeats).toBeNull();
	});

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
