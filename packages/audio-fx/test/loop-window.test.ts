// Ambience beds and room tone (spec 12 §4 P6-E12; wp-note "Phase 6 → WP-E8"): the clean window of a bed recording,
// loop points for an equal-power crossfade, the quietest stretch outside speech, the noise-floor profile and the
// spectral distance. Known answers on generated recordings (a spike, a busy stretch, a level step, hum), a loop RENDERED
// with the found points (level at every joint within 1 dB of the body, no click), and hostile input that never throws.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	crossfadeLaw,
	detectClicks,
	findCleanWindow,
	findLoopPoints,
	LOOP_WINDOW,
	noiseFloorProfile,
	quietestStretch,
	spectralDistanceDb,
	windowSpectrum,
} from '../src/index.ts';
import { Prng } from '../src/core/util.ts';

const SR = 24_000;

/** Pink noise (Paul Kellet's filter) at about `rmsDb` dBFS. */
function pink(seed: number, seconds: number, rmsDb: number): Float32Array {
	const r = new Prng(seed);
	const n = Math.round(seconds * SR);
	const out = new Float32Array(n);
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	let e = 0;
	for (let i = 0; i < n; i++) {
		const w = r.uniform();
		b0 = 0.99765 * b0 + w * 0.099046;
		b1 = 0.963 * b1 + w * 0.2965164;
		b2 = 0.57 * b2 + w * 1.0526913;
		out[i] = b0 + b1 + b2 + w * 0.1848;
		e += out[i]! * out[i]!;
	}
	const g = 10 ** (rmsDb / 20) / Math.sqrt(e / n);
	for (let i = 0; i < n; i++) out[i]! *= g;
	return out;
}

function white(seed: number, seconds: number, rmsDb: number): Float32Array {
	const r = new Prng(seed);
	const n = Math.round(seconds * SR);
	const out = new Float32Array(n);
	const g = 10 ** (rmsDb / 20) * Math.sqrt(3);
	for (let i = 0; i < n; i++) out[i] = r.uniform() * g;
	return out;
}

function add(x: Float32Array, y: Float32Array, at = 0): Float32Array {
	for (let i = 0; i < y.length && at + i < x.length; i++) x[at + i]! += y[i]!;
	return x;
}

/** A burst (a dog bark, a door): 0.3 s of a 900 Hz tone at `amp`. */
function burst(seconds = 0.3, amp = 0.3): Float32Array {
	const n = Math.round(seconds * SR);
	return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 900 * i) / SR) * Math.sin((Math.PI * i) / n));
}

const levelDb = (x: Float32Array, a: number, b: number) => {
	let e = 0;
	for (let i = a; i < b; i++) e += x[i]! * x[i]!;
	return 10 * Math.log10(e / Math.max(1, b - a) + 1e-20);
};

/** Renders a loop of [inSec, outSec] to `seconds` with equal-power crossfades of X (the timeline's pieces). */
function renderLoop(
	x: Float32Array,
	inSec: number,
	outSec: number,
	X: number,
	seconds: number,
	fade: 'equal-power' | 'equal-gain' = 'equal-power',
): Float32Array {
	const a = Math.round(inSec * SR);
	const b = Math.round(outSec * SR);
	const xn = Math.round(X * SR);
	const n = Math.round(seconds * SR);
	const out = new Float32Array(n);
	let pos = 0; // where the current pass starts in the output
	let first = true;
	while (pos < n) {
		for (let i = 0; i < b - a && pos + i < n; i++) {
			const v = x[a + i]!;
			let g = 1;
			const up = (t: number) => (fade === 'equal-gain' ? t : Math.sin((Math.PI / 2) * t));
			if (!first && i < xn) g = up((i + 0.5) / xn);
			if (i >= b - a - xn) g *= up(1 - (i - (b - a - xn) + 0.5) / xn);
			out[pos + i]! += g * v;
		}
		pos += b - a - xn;
		first = false;
	}
	return out;
}

describe('clean window', () => {
	it('avoids spikes and a busy stretch, prefers a long steady window', () => {
		const x = pink(1, 40, -30);
		add(x, burst(), Math.round(8 * SR)); // a bark at 8 s
		add(x, burst(), Math.round(31 * SR)); // and at 31 s
		// clicks every 0.4 s from 0 to 6 s (footsteps)
		for (let t = 0.2; t < 6; t += 0.4) add(x, burst(0.02, 0.2), Math.round(t * SR));
		const w = findCleanWindow(x, SR)!;
		expect(w).not.toBeNull();
		expect(w.clean).toBe(true);
		expect(w.spikes).toBe(0);
		// a window between the busy start and the barks: 8.3 s … 31 s holds 20 s
		expect(w.startSec).toBeGreaterThanOrEqual(8.3);
		expect(w.endSec).toBeLessThanOrEqual(31);
		expect(w.endSec - w.startSec).toBeGreaterThanOrEqual(20);
		expect(w.levelStdDb).toBeLessThan(1.5);
		expect(Math.abs(w.levelDb - -30)).toBeLessThan(1.5);
	});

	it('a 4 s bed is (nearly) its own window', () => {
		const x = pink(2, 4, -28);
		const w = findCleanWindow(x, SR)!;
		expect(w.clean).toBe(true);
		expect(w.endSec - w.startSec).toBeGreaterThanOrEqual(3);
		expect(w.endSec).toBeLessThanOrEqual(4);
		const short = findCleanWindow(pink(3, 2, -28), SR)!;
		expect(short.whole).toBe(true);
		expect(short.startSec).toBe(0);
		expect(short.endSec).toBe(2);
	});

	it('a level step counts as variance: the steady part wins', () => {
		const x = pink(4, 30, -30);
		for (let i = Math.round(10 * SR); i < Math.round(14 * SR); i++) x[i]! *= 3; // +9.5 dB for 4 s
		const w = findCleanWindow(x, SR, { maxSec: 15 })!;
		expect(w.endSec <= 10 || w.startSec >= 14).toBe(true);
	});

	it('a recording made of spikes still gets the least bad window, marked not clean', () => {
		const x = pink(5, 8, -40);
		for (let t = 0.1; t < 8; t += 0.7) add(x, burst(0.1, 0.5), Math.round(t * SR));
		const w = findCleanWindow(x, SR)!;
		expect(w.clean).toBe(false);
		expect(w.spikes).toBeGreaterThan(0);
	});

	it('digital silence is never inside the window; all silence is nothing', () => {
		const x = pink(6, 20, -30);
		x.fill(0, Math.round(9 * SR), Math.round(10 * SR));
		const w = findCleanWindow(x, SR)!;
		expect(w.endSec <= 9 || w.startSec >= 10).toBe(true);
		expect(findCleanWindow(new Float32Array(SR * 5), SR)).toBeNull();
	});
});

describe('loop points', () => {
	it('loop length is a whole number of frames; the rendered loop has no seam', () => {
		const x = pink(7, 12, -30);
		const lp = findLoopPoints(x, SR, { startSec: 0, endSec: 12 }, { crossfadeSec: 1.5, frameSec: 1 / 30 })!;
		expect(lp).not.toBeNull();
		const frames = (lp.outSec - lp.inSec) * 30;
		expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-6);
		expect(lp.crossfadeSec).toBe(1.5);
		expect(lp.fade).toBe('equal-power');
		expect(Math.abs(lp.correlation)).toBeLessThan(0.1);
		expect(Math.abs(lp.levelDiffDb)).toBeLessThan(0.5);
		const y = renderLoop(x, lp.inSec, lp.outSec, lp.crossfadeSec, 40);
		// every 250 ms frame within 1.5 dB of the loop's median level (no dip or bump at the joints)
		const frame = SR / 4;
		const levels: number[] = [];
		for (let i = 0; i + frame <= y.length; i += frame) levels.push(levelDb(y, i, i + frame));
		const sorted = [...levels].sort((a, b) => a - b);
		const med = sorted[sorted.length >> 1]!;
		const worst = Math.max(...levels.map((l) => Math.abs(l - med)));
		console.info(
			`[loop] in ${lp.inSec} out ${lp.outSec.toFixed(4)} ΔL ${lp.levelDiffDb} D ${lp.spectralDistanceDb} ρ ${lp.correlation}; worst 250 ms frame ${worst.toFixed(2)} dB from the median`,
		);
		expect(worst).toBeLessThan(1.5);
		expect(detectClicks([y], SR)).toHaveLength(0);
	});

	it('a drifting recording: the points meet where the levels match better than the window edges', () => {
		const x = pink(7, 12, -30);
		for (let i = 0; i < x.length; i++) x[i]! *= 10 ** ((3 * i) / x.length / 20); // +3 dB over 12 s
		const lp = findLoopPoints(x, SR, { startSec: 0, endSec: 12 }, { crossfadeSec: 1.5, frameSec: 1 / 30 })!;
		const edges = levelDb(x, Math.round(10.5 * SR), 12 * SR) - levelDb(x, 0, Math.round(1.5 * SR));
		expect(Math.abs(lp.levelDiffDb)).toBeLessThan(Math.abs(edges));
	});

	it('mains hum at 25 fps repeats in phase: an equal-gain crossfade keeps the level (measured on the render)', () => {
		const x = pink(8, 10, -40);
		for (let i = 0; i < x.length; i++) x[i]! += 0.05 * Math.sin((2 * Math.PI * 50 * i) / SR);
		const lp = findLoopPoints(x, SR, { startSec: 0.5, endSec: 9.5 }, { frameSec: 1 / 25 })!;
		expect(lp.correlation).toBeGreaterThan(0.5);
		expect(lp.fade).toBe('equal-gain');
		expect(Math.abs(lp.midpointDb)).toBeLessThanOrEqual(1);
		expect(crossfadeLaw(0)).toEqual({ fade: 'equal-power', midpointDb: 0 });
		expect(crossfadeLaw(1).fade).toBe('equal-gain');
		// measured on the render: the midpoint of the first joint vs the body around it
		const y = renderLoop(x, lp.inSec, lp.outSec, lp.crossfadeSec, 20, lp.fade);
		const joint = Math.round((lp.outSec - lp.inSec - lp.crossfadeSec / 2) * SR);
		const mid = levelDb(y, joint - SR / 20, joint + SR / 20);
		const body = levelDb(y, joint - 2 * SR, joint - SR);
		expect(Math.abs(mid - body)).toBeLessThan(1.2);
	});

	it('a short window shortens the crossfade to 40 % of it', () => {
		const lp = findLoopPoints(pink(9, 3, -30), SR, { startSec: 0, endSec: 3 }, { crossfadeSec: 1.5 })!;
		expect(lp.crossfadeSec).toBe(1.2);
		expect(lp.outSec - lp.inSec).toBeGreaterThanOrEqual(2 * lp.crossfadeSec - 1e-9);
	});
});

describe('room tone', () => {
	it('quietest stretch outside speech, and the noise floor of the pauses', () => {
		const x = pink(10, 12, -50);
		// speech-like bursts at 1–4 s and 6–11 s
		for (const [a, b] of [
			[1, 4],
			[6, 11],
		] as const)
			add(x, white(11, b - a, -20), Math.round(a * SR));
		const speech: [number, number][] = [
			[1, 4],
			[6, 11],
		];
		const s = quietestStretch(x, SR, { exclude: speech })!;
		expect(s.endSec - s.startSec).toBeGreaterThanOrEqual(0.5);
		expect(s.endSec - s.startSec).toBeLessThanOrEqual(3);
		expect(s.startSec >= 4 && s.endSec <= 6).toBe(true); // the 2 s pause is the only room for ≥ 0.5 s… and longest
		expect(Math.abs(s.levelDb - -50)).toBeLessThan(2);
		const floor = noiseFloorProfile(x, SR, { exclude: speech })!;
		expect(Math.abs(floor.levelDb - -50)).toBeLessThan(2.5);
		const ref = windowSpectrum(pink(12, 5, -45), SR, 0, 5)!;
		// the same colour of noise at another level: the same shape
		expect(spectralDistanceDb(floor.bandsDb, ref.bandsDb)).toBeLessThan(1.5);
		// white noise has another shape (pink falls 3 dB per octave)
		const w = windowSpectrum(white(13, 5, -45), SR, 0, 5)!;
		expect(spectralDistanceDb(floor.bandsDb, w.bandsDb)).toBeGreaterThan(4);
		expect(quietestStretch(x, SR, { exclude: [[0, 12]] })).toBeNull();
	});

	it('spectral distance: zero for equal shapes, symmetric in level, ignores bands 40 dB down', () => {
		const a = [-40, -43, -46, -49, -52, -55, -58];
		expect(spectralDistanceDb(a, a.map((v) => v - 12))).toBe(0);
		const b = [...a];
		b[6] = -150; // far below: not counted
		expect(spectralDistanceDb([...a.slice(0, 6), -100], b)).toBe(0);
		expect(spectralDistanceDb(a, [-40, -40, -40, -40, -40, -40, -40])).toBeGreaterThan(4);
	});
});

describe('hostile input', () => {
	it('never throws and returns null or finite numbers', () => {
		fc.assert(
			fc.property(
				fc.array(fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(Number.POSITIVE_INFINITY)), {
					maxLength: 3000,
				}),
				fc.oneof(fc.constant(SR), fc.double(), fc.constant(0), fc.constant(1e12), fc.constant(Number.NaN)),
				fc.record({ startSec: fc.double(), endSec: fc.double() }),
				(arr, sr, win) => {
					const x = Float32Array.from(arr);
					const w = findCleanWindow(x, sr as number);
					if (w) expect(Number.isFinite(w.startSec) && Number.isFinite(w.endSec)).toBe(true);
					const lp = findLoopPoints(x, sr as number, win, { frameSec: 1 / 30 });
					if (lp) expect(Number.isFinite(lp.inSec) && Number.isFinite(lp.outSec)).toBe(true);
					quietestStretch(x, sr as number, { exclude: [[Number.NaN, 2] as never, [3, 1]] });
					noiseFloorProfile(x, sr as number);
					windowSpectrum(x, sr as number, win.startSec, win.endSec);
					expect(Number.isFinite(spectralDistanceDb(arr.slice(0, 7), arr.slice(7, 14)))).toBe(true);
				},
			),
			{ numRuns: 200 },
		);
		expect(findCleanWindow(null as never, SR)).toBeNull();
		expect(findLoopPoints(new Float32Array(10), SR, null as never)).toBeNull();
		expect(LOOP_WINDOW.spikeDb).toBe(10);
	});
});
