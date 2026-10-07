// Music remix on synthetic beat tracks (port of filmcraft `remix.rs` tests): tempo and beats, similarity, plans hit the
// target at beat boundaries keeping intro and outro, determinism and parameters, refusals, equal-power render.
import { describe, expect, it } from 'vitest';
import {
	analyzeMusic,
	beatLead,
	jumpScore,
	MIN_PIECE_BEATS,
	planCuts,
	planJoints,
	planLength,
	planRemix,
	RemixError,
	renderRemix,
	testMusic,
} from '../src/analysis/remix.ts';

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
	const { audio, a } = music(120, 24); // 48 s

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

	it('renders equal-power crossfades, block-size independent, exact outside the fades', () => {
		const p = planRemix(a, 30 * SR);
		const read = (s: number, n: number) =>
			audio.map((c) => Float32Array.from({ length: n }, (_, k) => c[Math.max(s + k, 0)] ?? 0));
		const total = planLength(p);
		const whole = renderRemix(p, 0, total, 2, read);
		const cut = [new Float32Array(total), new Float32Array(total)];
		let pos = 0;
		let step = 1;
		while (pos < total) {
			const n = Math.min(step, total - pos);
			const b = renderRemix(p, pos, n, 2, read);
			cut[0]!.set(b[0]!, pos);
			cut[1]!.set(b[1]!, pos);
			pos += n;
			step = ((step * 7) % 4093) + 1;
		}
		expect(Buffer.from(cut[0]!.buffer).equals(Buffer.from(whole[0]!.buffer))).toBe(true);
		let d = 0;
		for (const pc of p.pieces) {
			for (let k = p.xfade; k < pc.len - p.xfade; k += 97)
				expect(whole[0]![d + k]).toBe(audio[0]![pc.src + k]);
			d += pc.len;
		}
		expect(planJoints(p).length).toBe(p.pieces.length - 1);
		// equal-power: the outgoing side follows cos, the incoming sin, so gain² of both sides sums to 1
		const q = {
			pieces: [
				{ src: 0, len: 100 },
				{ src: 1000, len: 100 },
			],
			xfade: 20,
		};
		const first = (s: number, n: number) => [
			Float32Array.from({ length: n }, (_, k) => (s + k < 500 ? 1 : 0)),
		];
		const second = (s: number, n: number) => [
			Float32Array.from({ length: n }, (_, k) => (s + k >= 500 ? 1 : 0)),
		];
		const out = renderRemix(q, 90, 20, 1, first)[0]!;
		const inn = renderRemix(q, 90, 20, 1, second)[0]!;
		for (let i = 0; i < 20; i++) {
			expect(out[i]).toBeCloseTo(Math.cos(((i + 0.5) / 20) * (Math.PI / 2)), 6);
			expect(out[i]! ** 2 + inn[i]! ** 2).toBeCloseTo(1, 5);
		}
	});

	it('analyses a 3-minute song quickly', () => {
		const { audio: long } = testMusic(SR, 110, 82, 3);
		const t0 = performance.now();
		const r = analyzeMusic(long, SR);
		expect(performance.now() - t0).toBeLessThan(6000);
		expect(Math.abs(r.bpm - 110)).toBeLessThan(1);
	});
});
