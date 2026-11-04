// GCC-PHAT audio sync (src/sync.ts): synthetic offsets, noise, gains, colouring, echo, inverted polarity,
// partial overlap and unrelated material. The test signals and cases follow FilmCraft's
// `crates/audio-dsp/src/sync.rs` tests (licenses/ported/multicam.md), plus partial-overlap and sub-sample cases.
import { describe, expect, it } from 'vitest';
import { decimate, findOffset, mixdown } from '../src/sync.ts';

/** Deterministic uniform noise in [−1, 1). */
function rng(seed: number): () => number {
	let s = (seed * 2654435761) >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return (s / 0x1_0000_0000) * 2 - 1;
	};
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));

/** Speech-like signal: voiced syllables (harmonics of a gliding pitch), noise bursts and pauses. */
function speechy(sr: number, secs: number, seed: number): Float32Array {
	const n = Math.floor(sr * secs);
	const r = rng(seed);
	const out = new Float32Array(n);
	let i = 0;
	while (i < n) {
		const len = Math.floor((0.08 + 0.25 * (r() * 0.5 + 0.5)) * sr);
		const kind = r();
		const f0 = 110 + 120 * (r() * 0.5 + 0.5);
		const glide = 1 + 0.3 * r();
		const amp = 0.2 + 0.3 * (r() * 0.5 + 0.5);
		for (let k = 0; k < Math.min(len, n - i); k++) {
			const t = k / sr;
			const env = Math.sin((Math.PI * k) / len);
			let v = 0;
			if (kind > 0.3) {
				const f = f0 * (1 + ((glide - 1) * k) / len);
				for (let h = 1; h < 8; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
			} else if (kind > -0.4) v = r();
			out[i + k] = v * env * amp;
		}
		i += len + Math.floor((r() * 0.5 + 0.5) * 0.15 * sr);
	}
	return out;
}

/**
 * `x` delayed by `delay` samples (fractional: windowed-sinc interpolation), scaled by `gain`, optionally coloured
 * by a zero-phase low-pass `[k, 1−2k, k]`, with white noise `snrDb` below the signal.
 */
function mic(
	x: Float32Array,
	delay: number,
	gain: number,
	lowpass: number | null,
	snrDb: number,
	len: number,
	seed: number,
): Float32Array {
	let out = new Float32Array(len);
	const di = Math.floor(delay);
	const fr = delay - di;
	// Fractional tap factors are constant across samples; retain the two multiplies' order below.
	const sinc = new Float64Array(33);
	const window = new Float64Array(33);
	if (fr !== 0) {
		for (let k = -16; k <= 16; k++) {
			const t = k - fr;
			sinc[k + 16] = Math.sin(Math.PI * t) / (Math.PI * t);
			window[k + 16] = 0.5 + 0.5 * Math.cos((Math.PI * t) / 17);
		}
	}
	for (let n = 0; n < len; n++) {
		const src = n - di;
		if (fr === 0) {
			if (src >= 0 && src < x.length) out[n] = x[src]!;
		} else {
			let acc = 0;
			for (let k = -16; k <= 16; k++) {
				const j = src - k;
				if (j < 0 || j >= x.length) continue;
				acc += x[j]! * sinc[k + 16]! * window[k + 16]!;
			}
			out[n] = acc;
		}
	}
	if (lowpass !== null) {
		const src = out;
		out = new Float32Array(len);
		for (let i = 1; i < len - 1; i++)
			out[i] = lowpass * src[i - 1]! + (1 - 2 * lowpass) * src[i]! + lowpass * src[i + 1]!;
	}
	const nrms = rms(out) * 10 ** (-snrDb / 20) * Math.sqrt(3);
	const r = rng(seed);
	for (let i = 0; i < len; i++) out[i] = out[i]! * gain + r() * nrms * gain;
	return out;
}

/** b[n] = s[n + delay] (zero outside s). */
function shifted(s: Float32Array, delay: number, len: number): Float32Array {
	const b = new Float32Array(len);
	for (let n = 0; n < len; n++) {
		const j = n + delay;
		if (j >= 0 && j < s.length) b[n] = s[j]!;
	}
	return b;
}

describe('decimate', () => {
	it('keeps low frequencies and removes high ones', () => {
		const sr = 48_000;
		const sine = (f: number) =>
			Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * f * i) / sr));
		const dl = decimate(sine(300), 6);
		const dh = decimate(sine(7000), 6);
		expect(dl.length).toBe(8000);
		expect(Math.abs(rms(dl.subarray(100, 7900)) - Math.SQRT1_2)).toBeLessThan(0.01);
		expect(rms(dh.subarray(100, 7900))).toBeLessThan(0.01);
	});
	it('mixdown averages channels', () => {
		const m = mixdown([Float32Array.from([1, 1, 1]), Float32Array.from([0, 1])]);
		expect([...m]).toEqual([0.5, 1]);
	});
});

describe('findOffset (GCC-PHAT, two passes)', () => {
	const sr = 48_000;
	it('finds pure delays exactly, both signs, and marks them reliable', () => {
		const s = speechy(sr, 12, 1);
		for (const delay of [0, 1, 7, 12_345, 96_001, -4321, -50_000]) {
			const r = findOffset(s, shifted(s, delay, 400_000), sr)!;
			expect(r.lag, `delay ${delay}`).toBe(delay);
			expect(r.reliable).toBe(true);
			expect(r.inverted).toBe(false);
		}
	});

	const microphones: [number, number, number, number | null, number][] = [
		[1, 2345, 0.1, null, 25],
		[2, -31_337.4, 3, 0.3, 10],
		[3, 150_000.6, 0.5, null, 3],
	];
	let microphoneSource: Float32Array | undefined;
	let microphoneReference: Float32Array | undefined;
	it.each(microphones)(
		'three microphones: mic %i with gain, noise, colouring and fractional delay is within one sample',
		(k, delay, gain, lowpass, snrDb) => {
			const src = (microphoneSource ??= speechy(sr, 30, 7));
			const reference = (microphoneReference ??= mic(src, 0, 1, null, 40, 30 * sr, 100));
			const target = mic(src, delay, gain, lowpass, snrDb, 30 * sr, 100 + k);
			// b[n] = src[n − delay], reference has zero delay → lag = −delay.
			const expected = -delay;
			const r = findOffset(reference, target, sr)!;
			expect(Math.abs(r.lag - expected), `mic ${k}: ${r.lag} vs ${expected}`).toBeLessThanOrEqual(1);
			expect(Math.abs(r.lagFine - expected), `mic ${k} fine: ${r.lagFine}`).toBeLessThan(0.75);
			expect(r.reliable).toBe(true);
		},
		60_000,
	);

	it('room echo 23 ms later at 0 dB SNR: the direct path wins', () => {
		const src = speechy(sr, 20, 21);
		const len = src.length;
		const near = mic(src, 0, 1, null, 35, len, 1);
		const direct = mic(src, 777, 1, null, 60, len, 2);
		const echo = mic(src, 777 + 0.023 * sr, 0.6, null, 60, len, 3);
		const room = direct.map((v, i) => v + echo[i]!);
		const nrms = rms(room) * Math.sqrt(3);
		const r9 = rng(9);
		const far = room.map((v) => (v + r9() * nrms) * 0.3);
		const r = findOffset(near, far, sr)!;
		expect(Math.abs(r.lag + 777)).toBeLessThanOrEqual(1);
		expect(r.reliable).toBe(true);
	}, 30_000);

	it('finds inverted polarity', () => {
		const s = speechy(sr, 8, 3);
		const b = new Float32Array(300_000);
		for (let n = 0; n + 1000 < s.length && n < b.length; n++) b[n] = -0.5 * s[n + 1000]!;
		const r = findOffset(s, b, sr)!;
		expect(r.lag).toBe(1000);
		expect(r.inverted).toBe(true);
	});

	it('partial overlap: b covers only the last 4 s of a, and starts before a', () => {
		const s = speechy(sr, 20, 41);
		// a = s[0, 10 s), b = s[6 s, 20 s): 4 s in common; b[n] = a[n + 6 s].
		const a = mic(s.subarray(0, 10 * sr), 0, 1, null, 30, 10 * sr, 5);
		const b = mic(s.subarray(6 * sr), 0, 0.4, null, 20, 14 * sr, 6);
		const r = findOffset(a, b, sr)!;
		expect(Math.abs(r.lag - 6 * sr)).toBeLessThanOrEqual(1);
		expect(r.reliable).toBe(true);
		// the other way round: a[n] = b[n − 6 s] → lag −6 s
		const q = findOffset(b, a, sr)!;
		expect(Math.abs(q.lag + 6 * sr)).toBeLessThanOrEqual(1);
	}, 30_000);

	let subSampleSource: Float32Array | undefined;
	let subSampleReference: Float32Array | undefined;
	it.each([0.25, 0.5, 10.4, -3.7])(
		'sub-sample delays come out of the parabolic refinement (%s samples)',
		(d) => {
			const s = (subSampleSource ??= speechy(sr, 6, 51));
			const a = (subSampleReference ??= mic(s, 0, 1, null, 50, s.length, 1));
			const b = mic(s, d, 1, null, 50, s.length, 2);
			// b[n] = s[n − d] = a[n − d] → lag = −d
			const r = findOffset(a, b, sr)!;
			expect(Math.abs(r.lagFine + d), `delay ${d}: ${r.lagFine}`).toBeLessThan(0.3);
		},
		30_000,
	);

	it('unrelated, silent or too-short signals are not trusted', () => {
		const a = speechy(sr, 10, 11);
		const b = speechy(sr, 10, 12);
		expect(findOffset(a, b, sr)!.reliable).toBe(false);
		expect(findOffset(a, new Float32Array(48_000), sr)).toBeNull();
		expect(findOffset(a.subarray(0, 100), a, sr)).toBeNull();
	});

	it('maxLag limits the search', () => {
		const s = speechy(sr, 10, 5);
		const b = s.slice(48_000);
		expect(findOffset(s, b, sr, { maxLag: 60_000 })!.lag).toBe(48_000);
		const r = findOffset(s, b, sr, { maxLag: 10_000 })!;
		expect(!r.reliable || r.lag !== 48_000).toBe(true);
	});

	it('works at other sample rates (44.1 kHz decimates by 6 to 7.35 kHz)', () => {
		const sr44 = 44_100;
		const s = speechy(sr44, 10, 61);
		const r = findOffset(s, shifted(s, 33_333, 300_000), sr44)!;
		expect(r.lag).toBe(33_333);
	});
});
