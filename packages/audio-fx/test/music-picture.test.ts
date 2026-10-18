// Music to picture (spec 12 P6-E11; wp-note "Phase 6 → WP-E7"): the key of music (chroma + Krumhansl–Schmuckler),
// drop candidates, the beat grid on the measured attacks (joints ≥ 3 ms before every attack) and anchored remix plans
// (the drop lands on an output time within 1 ms, joints on bar lines), on generated music with a known key, bars and
// drop, plus hostile inputs.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	analyzeKey,
	chromaOf,
	estimateKey,
	KK_MAJOR,
	keyScale,
	MAJOR_SCALE,
} from '../src/analysis/key.ts';
import {
	analyzeBeats,
	analyzeMusic,
	planAnchoredRemix,
	planCuts,
	planLength,
	planRemix,
	RemixError,
} from '../src/analysis/remix.ts';
import { dropMusic, testMusic } from './music.ts';

const SR = 22050;
const ms = (samples: number, sr = SR) => (1000 * samples) / sr;

describe('estimateKey / chromaOf', () => {
	it('finds the scale of generated music in C major, E♭ major and A minor with a clear confidence', () => {
		for (const [tonic, mode] of [
			[0, 'major'],
			[3, 'major'],
			[9, 'minor'],
			[7, 'major'],
		] as const) {
			const { audio } = dropMusic(SR, 120, 16, 9, { tonic, mode });
			const k = analyzeKey(audio, SR)!;
			console.info(
				`key of ${tonic} ${mode}: ${k.name} r ${k.correlation} margin ${k.margin} confidence ${k.confidence}`,
			);
			expect(k.scale).toEqual(keyScale(tonic, mode));
			expect(k.confidence).toBeGreaterThanOrEqual(0.6);
		}
		// the remix test music (C, Am, F, G / Dm, G, Em, Am): the C major scale
		const k = analyzeKey(testMusic(SR, 120, 24, 7).audio, SR)!;
		console.info(`key of the test music: ${k.name} r ${k.correlation} margin ${k.margin} confidence ${k.confidence}`);
		expect(k.scale).toEqual(keyScale(0, 'major'));
	});

	it('a profile itself is its key; rotating the chroma rotates the tonic (property)', () => {
		expect(estimateKey(KK_MAJOR)).toMatchObject({ tonic: 0, mode: 'major', name: 'C major' });
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: 0, max: 10, noNaN: true }), { minLength: 12, maxLength: 12 }),
				fc.integer({ min: 0, max: 11 }),
				(c, k) => {
					const a = estimateKey(c);
					const rot = Array.from({ length: 12 }, (_, i) => c[(i - k + 12) % 12]!);
					const b = estimateKey(rot);
					if (!a) return b === null;
					expect(b).not.toBeNull();
					expect(a.confidence).toBeGreaterThanOrEqual(0);
					expect(a.confidence).toBeLessThanOrEqual(1);
					// same key up to ties (equal correlations) and the rotation
					if (b!.correlation === a.correlation && a.margin > 1e-6)
						expect((b!.tonic - a.tonic + 12) % 12).toBe(k);
					return true;
				},
			),
			{ numRuns: 300 },
		);
	});

	it('silence, a steady sine, noise and hostile input: no key or a low confidence, never a throw', () => {
		expect(analyzeKey([new Float32Array(SR * 4)], SR)).toBeNull();
		const sine = Float32Array.from({ length: SR * 8 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR));
		const ks = analyzeKey([sine], SR);
		console.info(`key of a 440 Hz sine: ${ks?.name} confidence ${ks?.confidence}`);
		expect(ks === null || ks.confidence < 0.6).toBe(true);
		let x = 99;
		const noise = Float32Array.from({ length: SR * 8 }, () => {
			x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
			return (x >>> 8) / (1 << 24) - 0.5;
		});
		const kn = analyzeKey([noise], SR);
		console.info(`key of white noise: ${kn?.name} confidence ${kn?.confidence}`);
		expect(kn === null || kn.confidence < 0.6).toBe(true);
		expect(estimateKey([])).toBeNull();
		expect(estimateKey(new Array(12).fill(1))).toBeNull();
		expect(estimateKey([1, 2, Number.NaN, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
		expect(estimateKey([1, -2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
		const nan = Float32Array.from({ length: SR }, (_, i) => (i % 3 ? Number.NaN : 0.5));
		expect(() => chromaOf([nan, new Float32Array(3)], SR)).not.toThrow();
		expect(chromaOf([new Float32Array(10)], SR)).toEqual(new Array(12).fill(0));
		expect(chromaOf([sine], Number.NaN)).toEqual(new Array(12).fill(0));
		expect(chromaOf([], SR)).toEqual(new Array(12).fill(0));
		fc.assert(
			fc.property(fc.float32Array({ minLength: 0, maxLength: 9000 }), (a) => {
				const c = chromaOf([a], 8000);
				expect(c.length).toBe(12);
				expect(c.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
				expect(() => estimateKey(c)).not.toThrow();
			}),
			{ numRuns: 60 },
		);
	});

	it('the scales', () => {
		expect(keyScale(0, 'major')).toEqual([...MAJOR_SCALE]);
		expect(keyScale(9, 'minor')).toEqual(keyScale(0, 'major'));
		expect(keyScale(7, 'major')).toEqual([0, 2, 4, 6, 7, 9, 11]);
	});
});

describe('drops', () => {
	it('a generated track with a drop at bar 17 gives it as the top candidate (analyzeBeats and analyzeMusic)', () => {
		for (const [bpm, bars, drop] of [
			[120, 24, 17],
			[100, 28, 17],
			[128, 32, 9],
		] as const) {
			const m = dropMusic(SR, bpm, bars, drop);
			const b = analyzeBeats(m.audio, SR);
			const a = analyzeMusic(m.audio, SR);
			console.info(
				`${bpm} BPM drop bar ${drop}: beats ${JSON.stringify(b.drops.slice(0, 3).map((d) => [d.bar, d.score]))}, remix ${JSON.stringify(a.drops.slice(0, 3).map((d) => [d.bar, d.score]))}`,
			);
			expect(b.downbeats).not.toBeNull();
			expect(b.drops[0]!.bar, `${bpm}`).toBe(drop);
			expect(Math.abs(ms(b.drops[0]!.at - m.drop))).toBeLessThan(5);
			expect(a.drops[0]!.bar, `${bpm}`).toBe(drop);
			expect(Math.abs(ms(a.drops[0]!.at - m.drop))).toBeLessThan(5);
			expect(a.barsGuessed).toBe(false);
		}
	});

	it('music without a lift still lists candidates (the loudest bars), deterministically', () => {
		const m = testMusic(SR, 120, 16, 3);
		const a = analyzeBeats(m.audio, SR);
		expect(analyzeBeats(m.audio, SR).drops).toEqual(a.drops);
		expect(a.drops.length).toBeLessThanOrEqual(6);
	});
});

describe('beat-grid phase (joints before the measured attacks)', () => {
	it('every analysed joint is 3–15 ms before a true attack; remix cuts are at those joints', () => {
		for (const m of [testMusic(SR, 120, 24, 7), testMusic(SR, 97, 24, 5), dropMusic(SR, 128, 24, 9)]) {
			const a = analyzeMusic(m.audio, SR);
			let worstEarly = 0;
			let worstLate = Number.POSITIVE_INFINITY;
			for (const j of a.beats) {
				const next = m.beats.filter((t) => t >= j - 0.002 * SR).sort((x, y) => x - y)[0];
				if (next === undefined) continue;
				const lead = ms(next - j);
				worstLate = Math.min(worstLate, lead);
				worstEarly = Math.max(worstEarly, lead);
			}
			console.info(`joint lead before the attack: ${worstLate.toFixed(2)}…${worstEarly.toFixed(2)} ms`);
			expect(worstLate).toBeGreaterThanOrEqual(3);
			expect(worstEarly).toBeLessThanOrEqual(15);
			const p = planRemix(a, Math.round(a.len * 0.7));
			for (const [o, i] of planCuts(p)) {
				expect(a.beats).toContain(o);
				expect(a.beats).toContain(i);
			}
		}
	});
});

/** The plan's output (pieces concatenated, no crossfades) of mono `x`. */
function render(x: Float32Array, pieces: { src: number; len: number }[]): Float32Array {
	const total = Math.round(pieces.reduce((s, p) => s + p.len, 0));
	const out = new Float32Array(total);
	let o = 0;
	for (const p of pieces) {
		const s = Math.round(p.src);
		const l = Math.round(p.len);
		for (let k = 0; k < l && o + k < total; k++) out[o + k] = x[s + k] ?? 0;
		o += l;
	}
	return out;
}

/** Lag (samples) of `y` around `at` against `x` around `src` maximising their cross-correlation over ±`r`. */
function lagOf(x: Float32Array, src: number, y: Float32Array, at: number, r: number, w = 2048): number {
	let best = 0;
	let bestV = Number.NEGATIVE_INFINITY;
	for (let lag = -r; lag <= r; lag++) {
		let v = 0;
		for (let k = -w; k < w; k++) v += (x[src + k] ?? 0) * (y[at + lag + k] ?? 0);
		if (v > bestV) {
			bestV = v;
			best = lag;
		}
	}
	return best;
}

describe('planAnchoredRemix', () => {
	const m = dropMusic(SR, 120, 32, 17);
	const a = analyzeMusic(m.audio, SR);
	const drop = a.drops[0]!;
	const bars = new Set(a.downbeats.map((i) => a.beats[i]!));
	const halfBeat = a.period / 2;

	it('lands the drop earlier, later and in place within 1 ms; joints on bar lines; the outro ends within half a beat', () => {
		for (const outSec of [12, 20.37, 32.2, 41.1]) {
			const out = outSec * SR;
			const p = planAnchoredRemix(a, 56 * SR, [{ src: drop.at, out }], { fit: 'nearest' });
			const len = planLength(p);
			expect(Math.abs(len - p.target), `${outSec}`).toBeLessThanOrEqual(halfBeat + 1);
			expect(Math.abs(p.anchors[0]!.err), `${outSec}`).toBeLessThanOrEqual(0.001 * SR);
			for (const [o, i] of planCuts(p)) {
				expect(bars.has(o), `${outSec}: out cut ${o}`).toBe(true);
				expect(bars.has(i), `${outSec}: in cut ${i}`).toBe(true);
			}
			expect(p.headTrim).toBeGreaterThanOrEqual(0);
			expect(p.headTrim).toBeLessThan(a.period * a.beatsPerBar);
			const last = p.pieces.at(-1)!;
			expect(last.src + last.len).toBe(a.len);
			// the audio oracle: the rendered output around the anchor is the source around the drop
			const y = render(m.audio[0]!, p.pieces);
			const lag = lagOf(m.audio[0]!, Math.round(drop.at), y, Math.round(out), 60);
			expect(Math.abs(ms(lag)), `${outSec}: lag ${lag}`).toBeLessThanOrEqual(1);
			console.info(
				`drop → ${outSec} s: ${p.pieces.length} pieces, head ${ms(p.headTrim).toFixed(0)} ms, length ${(len / SR).toFixed(3)} s (target ${(p.target / SR).toFixed(3)}), lag ${ms(lag).toFixed(2)} ms`,
			);
		}
	});

	it('an exact target no plan reaches is refused with the nearest lengths; fit nearest plans one of them', () => {
		const out = 20 * SR;
		let err: RemixError | null = null;
		for (const t of [50.5, 51, 51.5, 52, 52.5, 53]) {
			try {
				planAnchoredRemix(a, t * SR, [{ src: drop.at, out }]);
			} catch (e) {
				err = e as RemixError;
				break;
			}
		}
		expect(err).toBeInstanceOf(RemixError);
		expect(err!.code).toBe('NO_PLAN_NEAR_TARGET');
		expect(err!.nearestTargets.length).toBeGreaterThan(0);
		for (const t of err!.nearestTargets) {
			const p = planAnchoredRemix(a, t, [{ src: drop.at, out }]);
			expect(Math.abs(planLength(p) - t)).toBeLessThanOrEqual(halfBeat + 1);
		}
	});

	it('two anchors a whole number of bars apart both land; inconsistent ones are refused', () => {
		const second = a.attacks[a.downbeats[a.downbeats.indexOf(drop.beat) + 4]!]!;
		const span = second - drop.at;
		const p = planAnchoredRemix(
			a,
			56 * SR,
			[
				{ src: drop.at, out: 20 * SR },
				{ src: second, out: 20 * SR + span },
			],
			{ fit: 'nearest' },
		);
		for (const an of p.anchors) expect(Math.abs(an.err)).toBeLessThanOrEqual(0.001 * SR);
		expect(() =>
			planAnchoredRemix(a, 56 * SR, [
				{ src: drop.at, out: 20 * SR },
				{ src: second, out: 20 * SR + span + 0.3 * SR },
			]),
		).toThrow(RemixError);
	});

	it('is deterministic', () => {
		const q = { src: drop.at, out: 18.5 * SR };
		expect(planAnchoredRemix(a, 50 * SR, [q], { fit: 'nearest' })).toEqual(
			planAnchoredRemix(analyzeMusic(m.audio, SR), 50 * SR, [q], { fit: 'nearest' }),
		);
	});

	it('hostile anchors and targets are refused with typed errors', () => {
		const code = (f: () => unknown) => {
			try {
				f();
			} catch (e) {
				expect(e).toBeInstanceOf(RemixError);
				return (e as RemixError).code;
			}
			return 'none';
		};
		expect(code(() => planAnchoredRemix(a, 40 * SR, []))).toBe('ANCHOR_OUT_OF_RANGE');
		expect(code(() => planAnchoredRemix(a, 40 * SR, [{ src: -1, out: 0 }]))).toBe('ANCHOR_OUT_OF_RANGE');
		expect(code(() => planAnchoredRemix(a, 40 * SR, [{ src: a.len + 5, out: 0 }]))).toBe('ANCHOR_OUT_OF_RANGE');
		expect(code(() => planAnchoredRemix(a, 40 * SR, [{ src: drop.at, out: 41 * SR }]))).toBe(
			'ANCHOR_OUT_OF_RANGE',
		);
		expect(code(() => planAnchoredRemix(a, 40 * SR, [{ src: Number.NaN, out: 1 }]))).toBe('ANCHOR_OUT_OF_RANGE');
		expect(code(() => planAnchoredRemix(a, SR, [{ src: drop.at, out: 0 }]))).toBe('TARGET_TOO_SHORT');
		expect(
			code(() =>
				planAnchoredRemix(a, 40 * SR, [
					{ src: drop.at, out: 20 * SR },
					{ src: drop.at - SR, out: 25 * SR },
				]),
			),
		).toBe('ANCHOR_OUT_OF_RANGE');
		// the drop of a 64 s song cannot land at 3 minutes in a 4 minute output with ≤ 8 repeats of short bars? it can:
		// but a drop 0.5 s into the music cannot land 10 s later without music before it to repeat
		expect(code(() => planAnchoredRemix(a, 40 * SR, [{ src: a.attacks[1]!, out: 10 * SR }]))).toBe(
			'ANCHOR_UNREACHABLE',
		);
		// no beat, a steady tone and a 1 s clip never get an analysis
		expect(code(() => analyzeMusic([new Float32Array(SR * 10)], SR))).toBe('NO_BEAT');
		const tone = Float32Array.from({ length: SR * 20 }, (_, i) => Math.sin(i * 0.05) * 0.3);
		expect(code(() => analyzeMusic([tone], SR))).toBe('NO_BEAT');
		const oneSec = dropMusic(SR, 120, 1, 1).audio.map((c) => c.subarray(0, SR));
		expect(['NO_BEAT', 'TOO_SHORT']).toContain(code(() => analyzeMusic(oneSec, SR)));
		fc.assert(
			fc.property(
				fc.double({ min: -1e9, max: 1e9, noNaN: false }),
				fc.double({ min: -1e9, max: 1e9, noNaN: false }),
				fc.double({ min: -1e9, max: 1e10, noNaN: false }),
				(src, out, target) => {
					try {
						const p = planAnchoredRemix(a, target, [{ src, out }], { fit: 'nearest' });
						expect(Math.abs(p.anchors[0]!.err)).toBeLessThanOrEqual(0.001 * SR + 1);
					} catch (e) {
						expect(e).toBeInstanceOf(RemixError);
					}
				},
			),
			{ numRuns: 200 },
		);
	});
});
