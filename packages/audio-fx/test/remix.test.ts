// Music remix on synthetic beat tracks (port of filmcraft `remix.rs` tests): tempo and beats, similarity, plans hit the
// target at beat boundaries keeping intro and outro, determinism and parameters, refusals.
import { describe, expect, it } from 'vitest';
import { budgetMs, budgetReport } from '../../../scripts/perf/budget.ts';
import {
	analyzeMusic,
	beatLead,
	jumpScore,
	MIN_PIECE_BEATS,
	planCuts,
	planLength,
	planRemix,
	RemixError,
} from '../src/analysis/remix.ts';
import { testMusic } from './music.ts';

const SR = 22050;
const music = (bpm: number, bars: number) => {
	const m = testMusic(SR, bpm, bars, 7);
	return { ...m, a: analyzeMusic(m.audio, SR) };
};

describe('remix analysis', () => {
	it('finds tempo within 1 BPM and beats within 10 ms', () => {
		for (const [bpm, sr] of [
			[100, SR],
			[120, SR],
			[97, SR],
			[128, SR],
			[120, 48000],
			[90, 44100],
		] as const) {
			const { audio, beats: truth } = testMusic(sr, bpm, 16, 7);
			const a = analyzeMusic(audio, sr);
			expect(Math.abs(a.bpm - bpm), `${bpm}@${sr}`).toBeLessThan(1);
			const tol = Math.trunc(0.01 * sr);
			let worst = 0;
			for (const b of a.beats.map((x) => x + beatLead(sr)))
				worst = Math.max(worst, Math.min(...truth.map((t) => Math.abs(t - b))));
			expect(worst, `${bpm}@${sr}`).toBeLessThanOrEqual(tol);
			expect(a.beats.length + 2).toBeGreaterThanOrEqual(truth.length);
		}
	});

	it('similarity prefers the same section', () => {
		const { a } = music(120, 24);
		const first = (bar: number) => a.beats.findIndex((b) => b >= bar * 4 * a.period - a.period / 4);
		const i = first(1);
		expect(jumpScore(a, i, first(5))).toBeGreaterThan(jumpScore(a, i, first(9)));
	});

	it('silence, a steady tone and noise have no beat', () => {
		expect(() => analyzeMusic([new Float32Array(SR * 10)], SR)).toThrow(RemixError);
		const tone = Float32Array.from({ length: SR * 20 }, (_, i) => Math.sin(i * 0.05) * 0.3);
		expect(() => analyzeMusic([tone], SR)).toThrow(RemixError);
		let x = 12345;
		const noise = Float32Array.from({ length: SR * 20 }, () => {
			x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
			return (x >>> 8) / (1 << 24) - 0.5;
		});
		expect(() => analyzeMusic([noise], SR)).toThrow(RemixError);
	});
});

describe('remix plans', () => {
	const { a } = music(120, 24);

	it('hits targets within a beat (half a beat at default settings), at beat boundaries, keeping intro and outro', () => {
		const beat = Math.trunc(a.period);
		for (const secs of [20, 30, 40, 47, 60, 75, 100])
			for (const segments of [0, 50, 100])
				for (const variations of [0, 50, 100]) {
					const target = Math.trunc(secs * SR);
					const p = planRemix(a, target, { segments, variations });
					const err = Math.abs(planLength(p) - target);
					expect(err, `${secs}s ${segments}/${variations}`).toBeLessThanOrEqual(beat);
					if (segments === 50 && variations === 50) expect(err).toBeLessThanOrEqual(beat / 2 + 1);
					expect(p.pieces[0]!.src).toBe(0);
					const last = p.pieces[p.pieces.length - 1]!;
					expect(last.src + last.len).toBe(a.len);
					for (const [o, i] of planCuts(p)) {
						expect(a.beats).toContain(o);
						expect(a.beats).toContain(i);
					}
					for (const pc of p.pieces)
						expect(pc.len).toBeGreaterThanOrEqual(Math.trunc(MIN_PIECE_BEATS * a.period) - 2);
				}
	});

	it('is deterministic; Segments changes the number of joints; identity at the source length; too-short targets refused', () => {
		const a2 = analyzeMusic(music(120, 24).audio, SR);
		expect(a2.beats).toEqual(a.beats);
		const t = 30 * SR;
		expect(planRemix(a, t)).toEqual(planRemix(a2, t));
		const few = planRemix(a, t, { segments: 0, variations: 50 });
		const many = planRemix(a, t, { segments: 100, variations: 50 });
		expect(few.pieces.length).toBeLessThan(many.pieces.length);
		expect(planRemix(a, a.len).pieces.length).toBe(1);
		expect(() => planRemix(a, SR)).toThrow(RemixError);
	});

	it('analyses a 3-minute song quickly', () => {
		const { audio: long } = testMusic(SR, 110, 82, 3);
		const t0 = performance.now();
		const r = analyzeMusic(long, SR);
		const ms = performance.now() - t0;
		console.info(budgetReport('remix analysis, 3 min', ms, 6000));
		expect(ms).toBeLessThan(budgetMs(6000));
		expect(Math.abs(r.bpm - 110)).toBeLessThan(1);
	});
});
