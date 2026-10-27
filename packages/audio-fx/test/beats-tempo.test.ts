// Tempo octave and metre of `analyzeBeats` (wp-note "Phase 6 → WP6.5b", item 10). The tracker used to lock to half
// the tempo of fast regular material (a 150 BPM click read as 75: at 22.05 kHz a 150 BPM period is 34.45 envelope
// frames, so its autocorrelation splits over two integer lags while twice the period lands on one). Click tracks
// from 60 to 200 BPM and generated drum patterns (kick / snare / hats, straight and swung, 4/4 and a waltz) must
// read at their own tempo — never half or double — with every beat on its attack; downbeats follow the metre
// (`timeSignature` 'auto' detects 3 or 4 beats per bar from the accent periodicity, a number forces it).
import { describe, expect, it } from 'vitest';
import { analyzeBeats } from '../src/analysis/remix.ts';
import { clickTrack } from './clicks.ts';

const SR = 22050;

const worstMs = (beats: number[], truth: number[], sr: number) => {
	let w = 0;
	for (const b of beats) w = Math.max(w, Math.min(...truth.map((t) => Math.abs(t - b))));
	return (1000 * w) / sr;
};

/** Random generator (LCG), deterministic per seed. */
function rng(seed: number) {
	let s = (Math.imul(seed, 747796405) + 2891336453) >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return ((s >>> 8) / (1 << 24)) * 2 - 1;
	};
}

type DrumOpts = {
	/** Beats per bar (4 = rock / pop, 3 = waltz). */
	meter?: 3 | 4;
	/** Hats per beat (2 = eighths, 4 = sixteenths, 0 = none). */
	hats?: 0 | 2 | 4;
	/** Swing: the off-beat eighth delayed to this fraction of the beat (0.5 straight, 0.667 triplet swing). */
	swing?: number;
	/** 'backbeat': kick on 1 and 3, snare on 2 and 4; 'waltz': kick on 1, snare on 2 and 3; 'twostep': drum & bass. */
	pattern?: 'backbeat' | 'waltz' | 'twostep';
	seed?: number;
};

/**
 * Music-like drums: kick (pitched-down sine), snare (noise burst + body), hats (short high noise), a bass note on each
 * bar and a sustained pad, at `bpm`. Returns the audio and the true beat / downbeat sample positions.
 */
function drums(
	sr: number,
	bpm: number,
	bars: number,
	o: DrumOpts = {},
): { audio: Float32Array[]; beats: number[]; downbeats: number[] } {
	const meter = o.meter ?? 4;
	const beat = (60 * sr) / bpm;
	const n = Math.round((bars * meter + 1) * beat);
	const x = new Float32Array(n);
	const noise = rng(o.seed ?? 3);
	const tau = 2 * Math.PI;
	const add = (at: number, len: number, f: (t: number) => number) => {
		const s = Math.round(at);
		// a 10 ms release: an event cut off abruptly would click (a broadband onset of its own)
		const rel = Math.max(1, Math.round(0.01 * sr));
		for (let i = 0; i < len && s + i < n; i++)
			if (s + i >= 0) x[s + i] = x[s + i]! + f(i / sr) * Math.min(1, (len - i) / rel);
	};
	const kick = (at: number, g = 0.9) =>
		add(
			at,
			Math.round(0.25 * sr),
			(t) => g * Math.exp(-t * 14) * Math.sin(tau * (45 * t + (80 / 30) * (1 - Math.exp(-t * 30)))),
		);
	const snare = (at: number, g = 0.45) =>
		add(
			at,
			Math.round(0.18 * sr),
			(t) => g * Math.exp(-t * 24) * (0.7 * noise() + 0.3 * Math.sin(tau * 190 * t)),
		);
	const hat = (at: number, g = 0.08) =>
		add(at, Math.round(0.035 * sr), (t) => g * Math.exp(-t * 140) * noise());
	const beats: number[] = [];
	const downbeats: number[] = [];
	const pattern = o.pattern ?? (meter === 3 ? 'waltz' : 'backbeat');
	const swing = o.swing ?? 0.5;
	for (let bar = 0; bar < bars; bar++) {
		const b0 = bar * meter * beat;
		// a pad and a bass note per bar (tonal, steady: no onsets of their own but a music-like bed)
		add(b0, Math.round(meter * beat), (t) => 0.05 * (1 - Math.exp(-t * 6)) * Math.sin(tau * 220 * t));
		add(b0, Math.round(beat * 0.9), (t) => 0.12 * Math.exp(-t * 3) * Math.sin(tau * 55 * t));
		for (let q = 0; q < meter; q++) {
			const at = b0 + q * beat;
			beats.push(Math.round(at));
			if (q === 0) downbeats.push(Math.round(at));
			if (pattern === 'waltz') {
				if (q === 0) kick(at);
				else snare(at, 0.22);
			} else if (pattern === 'twostep') {
				if (q === 0) kick(at);
				if (q === 1 || q === 3) snare(at, 0.5);
				if (q === 2) kick(at + beat * 0.5, 0.8);
			} else {
				if (q % 2 === 0) kick(at);
				else snare(at);
			}
			const hats = o.hats ?? 2;
			for (let k = 0; k < hats; k++) {
				const frac = hats === 2 && k === 1 ? swing : k / hats;
				hat(at + frac * beat, k === 0 ? 0.1 : 0.06);
			}
		}
	}
	return { audio: [x, x.slice()], beats, downbeats };
}

const sameTempo = (got: number, want: number) => Math.abs(got - want) / want < 0.02;

describe('tempo octave', () => {
	it('fast clicks at 44.1 and 48 kHz and other phases read at their own tempo too', () => {
		for (const [bpm, sr, offsetSec] of [
			[150, 44100, 0.1],
			[174, 48000, 0.37],
			[200, 48000, 0.05],
			[150, SR, 0.61],
		] as const) {
			const { audio, clicks } = clickTrack(sr, bpm, 14, { offsetSec });
			const a = analyzeBeats(audio, sr);
			expect(sameTempo(a.bpm, bpm), `${bpm}@${sr} read as ${a.bpm.toFixed(2)}`).toBe(true);
			expect(worstMs(a.beats, clicks, sr)).toBeLessThan(5);
		}
	});

	const MUSIC: [string, number, DrumOpts][] = [
		['75 BPM backbeat, sixteenth hats', 75, { hats: 4 }],
		['90 BPM swung backbeat', 90, { swing: 0.667 }],
		['100 BPM backbeat, eighth hats', 100, {}],
		['120 BPM backbeat, sixteenth hats', 120, { hats: 4 }],
		['150 BPM swung backbeat', 150, { swing: 0.62 }],
		['150 BPM backbeat, no hats', 150, { hats: 0 }],
		['174 BPM drum & bass two-step', 174, { pattern: 'twostep', hats: 2 }],
	];
	for (const [name, bpm, o] of MUSIC)
		it(`music: ${name} reads ${bpm} BPM with beats on the drums`, () => {
			const bars = Math.max(8, Math.round((bpm * 20) / 60 / 4));
			const { audio, beats } = drums(SR, bpm, bars, { ...o, seed: bpm });
			const a = analyzeBeats(audio, SR);
			expect(sameTempo(a.bpm, bpm), `${name} read as ${a.bpm.toFixed(2)}`).toBe(true);
			expect(worstMs(a.beats, beats, SR)).toBeLessThan(15);
			expect(a.beats.length).toBeGreaterThanOrEqual(beats.length - 6);
		});
});

describe('metre: downbeats in 3 or 4', () => {
	it('a waltz is detected in 3: one downbeat per bar, on the kick', () => {
		for (const bpm of [90, 150, 180]) {
			const { audio, downbeats } = drums(SR, bpm, Math.round((bpm * 20) / 60 / 3), {
				meter: 3,
				hats: 0,
				seed: bpm,
			});
			const a = analyzeBeats(audio, SR);
			expect(sameTempo(a.bpm, bpm), `waltz ${bpm} read as ${a.bpm.toFixed(2)}`).toBe(true);
			expect(a.beatsPerBar, `waltz ${bpm}`).toBe(3);
			expect(a.downbeats).not.toBeNull();
			const down = a.downbeats!.map((i) => a.beats[i]!);
			expect(worstMs(down, downbeats, SR)).toBeLessThan(15);
			// consecutive downbeats are 3 beats apart
			for (let i = 1; i < a.downbeats!.length; i++) expect(a.downbeats![i]! - a.downbeats![i - 1]!).toBe(3);
			// forced: 3 gives the same; 4 finds no accent every 4 beats in a waltz (null, never a wrong bar)
			const forced = analyzeBeats(audio, SR, { timeSignature: 3 });
			expect(forced.downbeats).toEqual(a.downbeats);
			const four = analyzeBeats(audio, SR, { timeSignature: 4 });
			expect(four.downbeats).toBeNull();
			expect(four.beatsPerBar).toBe(4);
		}
	});

	it('4/4 music and an accented 4/4 click stay in 4; forcing 4 matches auto', () => {
		const { audio, downbeats } = drums(SR, 120, 10, { hats: 2, seed: 9 });
		// the backbeat's accent is the kick on 1 and 3: the bar is found from the accent on 1
		const a = analyzeBeats(audio, SR);
		expect(a.beatsPerBar === null || a.beatsPerBar === 4 || a.beatsPerBar === 2).toBe(true);
		expect(a.beatsPerBar).not.toBe(3);
		const { audio: click, clicks } = clickTrack(SR, 120, 12, { accent: 2.5 });
		const c = analyzeBeats(click, SR);
		expect(c.beatsPerBar).toBe(4);
		expect(c.downbeatConfidence).toBeGreaterThan(0.1);
		const down = c.downbeats!.map((i) => c.beats[i]!);
		expect(
			worstMs(
				down,
				clicks.filter((_, k) => k % 4 === 0),
				SR,
			),
		).toBeLessThan(5);
		expect(analyzeBeats(click, SR, { timeSignature: 4 }).downbeats).toEqual(c.downbeats);
		void downbeats;
	});

	it('an even click track has no downbeats whatever the metre; invalid metres fall back to auto', () => {
		const even = clickTrack(SR, 120, 12).audio;
		for (const timeSignature of ['auto', 3, 4] as const) {
			const a = analyzeBeats(even, SR, { timeSignature });
			expect(a.downbeats).toBeNull();
		}
		const { audio } = drums(SR, 150, 12, { meter: 3, hats: 0, seed: 5 });
		for (const bad of [0, 1, 13, 2.5, Number.NaN, -3] as unknown as (3 | 4)[])
			expect(analyzeBeats(audio, SR, { timeSignature: bad }).beatsPerBar).toBe(3);
	});
});

describe('the whole tempo range', () => {
	it('clicks across 55–205 BPM keep their tempo, with every beat on its click', () => {
		const tempos = [...Array.from({ length: 31 }, (_, i) => 55 + i * 5), 128, 174];
		for (const bpm of tempos) {
			const { audio, clicks } = clickTrack(SR, bpm, Math.max(12, (16 * 60) / bpm), {
				offsetSec: 0.13 + (bpm % 7) / 20,
			});
			const a = analyzeBeats(audio, SR);
			const bpmTolerance = [90, 100, 120, 128].includes(bpm) ? 1 : bpm * 0.02;
			expect(Math.abs(a.bpm - bpm), `${bpm} read as ${a.bpm.toFixed(2)}`).toBeLessThan(bpmTolerance);
			expect(worstMs(a.beats, clicks, SR), `${bpm} BPM`).toBeLessThan(5);
			expect(a.beats.length, `${bpm} BPM`).toBeGreaterThanOrEqual(clicks.length - 3);
		}
	});

	it('hostile audio: only NO_BEAT, never a crash; results are well formed', () => {
		const r = rng(77);
		for (let c = 0; c < 40; c++) {
			const sr = [8000, 22050, 44100][c % 3]!;
			const n = Math.round(sr * (0.5 + Math.abs(r()) * 10));
			const x = new Float32Array(n);
			const bursts = Math.floor(Math.abs(r()) * 60);
			for (let b = 0; b < bursts; b++) {
				const at = Math.floor(Math.abs(r()) * n);
				const g = Math.abs(r()) * (c % 5 === 0 ? 1e6 : 1);
				for (let i = 0; i < 200 && at + i < n; i++) x[at + i] = g * r();
			}
			if (c % 7 === 0) x.fill(Number.NaN, 0, Math.min(n, 10));
			const ts = [undefined, 'auto', 3, 4, 7, 0, Number.POSITIVE_INFINITY][c % 7] as never;
			try {
				const a = analyzeBeats([x], sr, { timeSignature: ts });
				expect(Number.isFinite(a.bpm)).toBe(true);
				for (let i = 1; i < a.beats.length; i++) expect(a.beats[i]!).toBeGreaterThan(a.beats[i - 1]!);
				expect(a.accents).toHaveLength(a.beats.length);
				if (a.downbeats) {
					expect(a.beatsPerBar).not.toBeNull();
					for (const i of a.downbeats) expect(i >= 0 && i < a.beats.length).toBe(true);
				}
			} catch (e) {
				expect((e as Error).name).toBe('RemixError');
			}
		}
	});
});
