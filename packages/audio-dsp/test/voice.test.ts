// Voice analysis frames (src/voice.ts, spec 14 TC-001/TC-002): the features against direct (non-FFT) formulas of the
// research prototype, block-split invariance (property), quantisation, and the frame classes of synthetic signals —
// voiced tones, loud and quiet unvoiced noise, breath-like bursts of several lengths, the noise floor, digital silence.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	classifyVoiceFrames,
	levelStats,
	quantiseUnit,
	quantiseVoiceLevel,
	speechThresholdDb,
	VOICE_CLASS_BREATH,
	VOICE_CLASS_SILENCE,
	VOICE_CLASS_SPEECH,
	VOICE_HOP,
	VOICE_SAMPLE_RATE,
	VOICE_WINDOW,
	VOICE_WINDOW_LEAD,
	VoiceFeatureExtractor,
	type VoiceFeaturePlanes,
	voiceFeatures,
	voiceFrameCount,
	voiceLevelDb,
	voiceLevels,
} from '../src/voice.ts';
import { Rng } from './util.ts';

const SR = VOICE_SAMPLE_RATE;
const dbToAmp = (db: number) => 10 ** (db / 20);

/** The prototype's features of frame k, directly (no FFT): level, voicing, flatness (unquantised). */
function reference(x: Float32Array, k: number): { level: number; voicing: number; flatness: number } {
	const fr = new Float64Array(VOICE_WINDOW);
	const a = k * VOICE_HOP - VOICE_WINDOW_LEAD;
	for (let n = 0; n < VOICE_WINDOW; n++) {
		const j = a + n;
		fr[n] = j >= 0 && j < x.length ? x[j]! : 0;
	}
	let e = 0;
	let mean = 0;
	for (const v of fr) {
		e += v * v;
		mean += v;
	}
	mean /= VOICE_WINDOW;
	const level = 10 * Math.log10(e / VOICE_WINDOW + 1e-12);
	const frc = fr.map((v) => v - mean);
	const ac = (l: number) => {
		let s = 0;
		for (let n = 0; n + l < VOICE_WINDOW; n++) s += frc[n]! * frc[n + l]!;
		return s;
	};
	let best = Number.NEGATIVE_INFINITY;
	for (let l = 40; l < 228; l++) best = Math.max(best, ac(l));
	const voicing = best / (ac(0) + 1e-9);
	let logSum = 0;
	let lin = 0;
	for (let kk = 9; kk < 192; kk++) {
		let re = 0;
		let im = 0;
		for (let n = 0; n < VOICE_WINDOW; n++) {
			const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (VOICE_WINDOW - 1));
			const ang = (-2 * Math.PI * kk * n) / 512;
			re += w * fr[n]! * Math.cos(ang);
			im += w * fr[n]! * Math.sin(ang);
		}
		const p = re * re + im * im + 1e-12;
		logSum += Math.log(p);
		lin += p;
	}
	const flatness = Math.exp(logSum / 183) / (lin / 183);
	return { level, voicing, flatness };
}

/** A harmonic complex ("voiced"): f0 and its harmonics up to 3 kHz, falling 6 dB per octave, at `db` RMS. */
function voiced(n: number, f0: number, db: number, phase0 = 0): Float32Array {
	const out = new Float32Array(n);
	for (let h = 1; h * f0 < 3000; h++)
		for (let i = 0; i < n; i++) out[i]! += Math.sin((2 * Math.PI * h * f0 * i) / SR + phase0 * h) / h;
	return scaleTo(out, db);
}

/** White noise, optionally through a one-pole low-pass (Hz), at `db` RMS. */
function noise(n: number, db: number, seed: number, lowpassHz?: number): Float32Array {
	const r = new Rng(seed);
	const out = new Float32Array(n);
	const c = lowpassHz ? Math.exp((-2 * Math.PI * lowpassHz) / SR) : 0;
	let y = 0;
	for (let i = 0; i < n; i++) {
		y = (1 - c) * r.uniform() + c * y;
		out[i] = y;
	}
	return scaleTo(out, db);
}

function scaleTo(x: Float32Array, db: number): Float32Array {
	let e = 0;
	for (const v of x) e += v * v;
	const g = dbToAmp(db) / Math.sqrt(e / Math.max(1, x.length) || 1);
	for (let i = 0; i < x.length; i++) x[i]! *= g;
	return x;
}

/** Concatenated segments (seconds, generator) over a noise floor. */
function program(
	segments: Array<{ s: number; make?: (n: number) => Float32Array }>,
	floorDb: number | null,
): { x: Float32Array; ranges: Array<[number, number]> } {
	const total = Math.round(segments.reduce((t, s) => t + s.s, 0) * SR);
	const x = floorDb === null ? new Float32Array(total) : noise(total, floorDb, 99);
	const ranges: Array<[number, number]> = [];
	let at = 0;
	for (const seg of segments) {
		const n = Math.round(seg.s * SR);
		if (seg.make) {
			const y = seg.make(n);
			for (let i = 0; i < n; i++) x[at + i]! += y[i]!;
		}
		ranges.push([at, at + n]);
		at += n;
	}
	return { x, ranges };
}

/** Classes of the frames well inside a sample range (3 frames of margin at each side). */
function inner(classes: Uint8Array, [a, b]: [number, number]): number[] {
	const f0 = Math.ceil(a / VOICE_HOP) + 3;
	const f1 = Math.floor(b / VOICE_HOP) - 3;
	return Array.from(classes.subarray(f0, f1));
}

describe('levels shared with the speech VAD (TC-002)', () => {
	it('floor = 10th, speech level = 95th lower-rank percentile of the frames above −100 dBFS', () => {
		const db = [...Array(90).fill(-60), ...Array(10).fill(-20), -120, -101];
		expect(levelStats(db)).toEqual({ floorDb: -60, speechDb: -20, frames: 100 });
		expect(speechThresholdDb(-60, -20)).toBeCloseTo(-48, 12);
		// at least 6 dB over the floor
		expect(speechThresholdDb(-50, -47)).toBe(-44);
		expect(levelStats([-120, -100])).toBeNull();
		expect(levelStats([1, 2, 3, 4], 1, 3)).toEqual({ floorDb: 2, speechDb: 2, frames: 2 });
	});

	it('quantises levels in 0.5 dB steps from −120 dBFS and units in 1/255', () => {
		expect(quantiseVoiceLevel(-120)).toBe(0);
		expect(quantiseVoiceLevel(Number.NaN)).toBe(0);
		expect(quantiseVoiceLevel(-60.24)).toBe(120);
		expect(voiceLevelDb(quantiseVoiceLevel(-60.26))).toBe(-60.5);
		expect(quantiseVoiceLevel(30)).toBe(255);
		expect(quantiseUnit(-0.1)).toBe(0);
		expect(quantiseUnit(0.5)).toBe(128);
		expect(quantiseUnit(2)).toBe(255);
		expect(quantiseUnit(Number.NaN)).toBe(0);
	});
});

describe('frame features', () => {
	it('match the prototype formulas computed directly (no FFT)', () => {
		const x = new Float32Array(12_000);
		x.set(voiced(4000, 140, -22), 0);
		x.set(noise(4000, -35, 3), 4000);
		x.set(noise(4000, -50, 4, 2500), 8000);
		const f = voiceFeatures(x);
		expect(f.level.length).toBe(voiceFrameCount(x.length));
		for (const k of [0, 1, 7, 12, 24, 25, 26, 40, 49, 50, 60, 74]) {
			const r = reference(x, k);
			expect(Math.abs(f.level[k]! - quantiseVoiceLevel(r.level)), `level ${k}`).toBeLessThanOrEqual(1);
			expect(Math.abs(f.voicing[k]! - quantiseUnit(r.voicing)), `voicing ${k}`).toBeLessThanOrEqual(1);
			expect(Math.abs(f.flatness[k]! - quantiseUnit(r.flatness)), `flatness ${k}`).toBeLessThanOrEqual(1);
		}
		// voiced: high voicing (the autocorrelation is the biased one: ≈ (400 − lag) / 400 for a periodic signal, 0.71 at
		// 140 Hz), low flatness; noise: the opposite
		expect(f.voicing[12]!).toBeGreaterThan(0.6 * 255);
		expect(f.flatness[12]!).toBeLessThan(0.15 * 255);
		expect(f.voicing[37]!).toBeLessThan(0.3 * 255);
		expect(f.flatness[37]!).toBeGreaterThan(0.3 * 255);
	});

	it('gives the same bytes for any split of the signal into blocks (property)', () => {
		const x = new Float32Array(8000);
		x.set(voiced(3000, 180, -25), 0);
		x.set(noise(5000, -40, 7), 3000);
		const whole = voiceFeatures(x);
		const n = whole.level.length;
		fc.assert(
			fc.property(fc.uniqueArray(fc.integer({ min: 1, max: n - 1 }), { maxLength: 6 }), (cuts) => {
				const bounds = [0, ...cuts.sort((a, b) => a - b), n];
				const ex = new VoiceFeatureExtractor();
				const out: VoiceFeaturePlanes = {
					level: new Uint8Array(n),
					voicing: new Uint8Array(n),
					flatness: new Uint8Array(n),
				};
				for (let i = 0; i + 1 < bounds.length; i++) {
					const f0 = bounds[i]!;
					const f1 = bounds[i + 1]!;
					// each block gets only its own samples plus the window context, like the engine's blocks
					const s0 = Math.max(0, f0 * VOICE_HOP - VOICE_WINDOW_LEAD);
					const s1 = Math.min(x.length, f1 * VOICE_HOP + (VOICE_WINDOW - VOICE_WINDOW_LEAD));
					const part = {
						level: new Uint8Array(f1 - f0),
						voicing: new Uint8Array(f1 - f0),
						flatness: new Uint8Array(f1 - f0),
					};
					ex.compute(x.slice(s0, s1), s0, f0, f1 - f0, part);
					out.level.set(part.level, f0);
					out.voicing.set(part.voicing, f0);
					out.flatness.set(part.flatness, f0);
				}
				expect(out).toEqual(whole);
			}),
			{ numRuns: 40 },
		);
	});

	it('treats non-finite samples as zero and rejects bad arguments', () => {
		const x = voiced(1600, 200, -20);
		const y = x.slice();
		y[800] = Number.NaN;
		y[801] = Number.POSITIVE_INFINITY;
		const clean = x.slice();
		clean[800] = 0;
		clean[801] = 0;
		expect(voiceFeatures(y)).toEqual(voiceFeatures(clean));
		const ex = new VoiceFeatureExtractor();
		const out = { level: new Uint8Array(2), voicing: new Uint8Array(2), flatness: new Uint8Array(2) };
		expect(() => ex.compute(x, 0, 0, 3, out)).toThrow(RangeError);
		expect(() => ex.compute(x, 0, -1.5, 1, out)).toThrow(RangeError);
		expect(voiceFeatures(new Float32Array(0)).level.length).toBe(0);
	});
});

describe('frame classes (TC-001)', () => {
	// floor −70 dBFS; voiced speech −20 dBFS → threshold −70 + 0.3·50 = −55 dBFS, "loud" from −45 dBFS
	const prog = program(
		[
			{ s: 1.0 },
			{ s: 1.2, make: (n) => voiced(n, 140, -20) }, // 1 voiced speech
			{ s: 0.6 },
			{ s: 0.4, make: (n) => noise(n, -52, 11, 4000) }, // 3 breath-like (400 ms, unvoiced, below loud)
			{ s: 0.6 },
			{ s: 0.5, make: (n) => noise(n, -30, 12) }, // 5 loud unvoiced ("s"): speech by level alone
			{ s: 0.6 },
			{ s: 0.06, make: (n) => noise(n, -52, 13, 4000) }, // 7 a 60 ms burst: too short for a breath
			{ s: 0.8 },
			{ s: 1.5, make: (n) => noise(n, -52, 14, 4000) }, // 9 1.5 s of noise: too long for a breath
			{ s: 0.6 },
			{ s: 0.8, make: (n) => voiced(n, 220, -24, 0.3) }, // 11 voiced speech, another pitch
			{ s: 0.6 },
			{ s: 0.4, make: (n) => voiced(n, 140, -52) }, // 13 quiet voiced: above the threshold and voiced
			{ s: 1.0 },
		],
		-70,
	);
	const planes = voiceFeatures(prog.x);
	const { classes, levels } = classifyVoiceFrames(planes);
	const r = prog.ranges;
	const every = (xs: number[], c: number) => xs.length > 0 && xs.every((v) => v === c);

	it('measures the floor, the speech level and the thresholds', () => {
		expect(levels).not.toBeNull();
		expect(levels!.floorDb).toBeGreaterThan(-71.5);
		expect(levels!.floorDb).toBeLessThan(-69);
		expect(levels!.speechDb).toBeGreaterThan(-26);
		expect(levels!.speechThresholdDb).toBeCloseTo(
			Math.max(levels!.floorDb + 0.3 * (levels!.speechDb - levels!.floorDb), levels!.floorDb + 6),
			12,
		);
		expect(levels!.breathFloorDb).toBe(levels!.floorDb + 5);
		expect(voiceLevels(planes.level)).toEqual(levels);
	});

	it('voiced tones are speech, at any pitch, also quiet ones above the threshold', () => {
		expect(every(inner(classes, r[1]!), VOICE_CLASS_SPEECH)).toBe(true);
		expect(every(inner(classes, r[11]!), VOICE_CLASS_SPEECH)).toBe(true);
		expect(every(inner(classes, r[13]!), VOICE_CLASS_SPEECH)).toBe(true);
	});

	it('loud unvoiced noise is speech by level alone (≥ 10 dB over the threshold)', () => {
		expect(every(inner(classes, r[5]!), VOICE_CLASS_SPEECH)).toBe(true);
	});

	it('a 400 ms unvoiced noise burst over the floor is breath-like', () => {
		expect(every(inner(classes, r[3]!), VOICE_CLASS_BREATH)).toBe(true);
	});

	it('breath-like runs shorter than 120 ms or longer than 900 ms are silence', () => {
		const [a7, b7] = r[7]!;
		expect(
			Array.from(classes.subarray(Math.floor(a7 / VOICE_HOP) - 2, Math.ceil(b7 / VOICE_HOP) + 2)),
		).toEqual(
			Array(Math.ceil(b7 / VOICE_HOP) + 2 - (Math.floor(a7 / VOICE_HOP) - 2)).fill(VOICE_CLASS_SILENCE),
		);
		expect(every(inner(classes, r[9]!), VOICE_CLASS_SILENCE)).toBe(true);
	});

	it('the noise floor between events is silence', () => {
		for (const k of [0, 2, 4, 6, 8, 10, 12, 14])
			expect(every(inner(classes, r[k]!), VOICE_CLASS_SILENCE), `${k}`).toBe(true);
	});

	it('speech runs have no gaps under 60 ms and no blips under 40 ms; breath-like runs last 120–900 ms', () => {
		const runs: Array<{ c: number; n: number; at: number }> = [];
		for (let i = 0; i < classes.length; ) {
			let j = i;
			while (j < classes.length && classes[j] === classes[i]) j++;
			runs.push({ c: classes[i]!, n: j - i, at: i });
			i = j;
		}
		for (const run of runs) {
			if (run.c === VOICE_CLASS_SPEECH) expect(run.n).toBeGreaterThanOrEqual(4);
			if (run.c === VOICE_CLASS_BREATH) {
				expect(run.n).toBeGreaterThanOrEqual(12);
				expect(run.n).toBeLessThanOrEqual(90);
			}
		}
	});

	it('digital silence has no levels and only silence frames', () => {
		const z = classifyVoiceFrames(voiceFeatures(new Float32Array(SR)));
		expect(z.levels).toBeNull();
		expect(z.classes.every((c) => c === VOICE_CLASS_SILENCE)).toBe(true);
	});

	it('closes a 50 ms dip inside speech and drops a 5 ms click', () => {
		const p = program(
			[
				{ s: 1 },
				{ s: 0.5, make: (n) => voiced(n, 150, -20) },
				{ s: 0.05 },
				{ s: 0.5, make: (n) => voiced(n, 150, -20) },
				{ s: 1 },
				{ s: 0.005, make: (n) => noise(n, -20, 21) },
				{ s: 1 },
			],
			null,
		);
		// a floor of very quiet noise so the levels are defined
		const floor = noise(p.x.length, -80, 5);
		for (let i = 0; i < p.x.length; i++) p.x[i]! += floor[i]!;
		const c = classifyVoiceFrames(voiceFeatures(p.x)).classes;
		const [a1] = p.ranges[1]!;
		const [, b3] = p.ranges[3]!;
		expect(
			Array.from(c.subarray(Math.ceil(a1 / VOICE_HOP) + 3, Math.floor(b3 / VOICE_HOP) - 3)).every(
				(v) => v === VOICE_CLASS_SPEECH,
			),
		).toBe(true);
		const [a5, b5] = p.ranges[5]!;
		expect(
			Array.from(c.subarray(Math.floor(a5 / VOICE_HOP) - 3, Math.ceil(b5 / VOICE_HOP) + 3)).every(
				(v) => v !== VOICE_CLASS_SPEECH,
			),
		).toBe(true);
	});

	it('rejects planes of different lengths', () => {
		expect(() =>
			classifyVoiceFrames({
				level: new Uint8Array(3),
				voicing: new Uint8Array(2),
				flatness: new Uint8Array(3),
			}),
		).toThrow(RangeError);
	});
});
