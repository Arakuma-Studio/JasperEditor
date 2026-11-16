// Pitch Shifter engines (effects/pitch.ts): stored instances keep the legacy engine; Signalsmith Stretch and Rubber
// Band R3 (the separate module packages/audio-fx/wasm/rubberband.wasm) shift by the requested ratio, keep the output
// aligned with the input at `latency()`, keep (or move) the formant envelope as asked, never clip, and Rubber Band
// falls back to Signalsmith with the same latency where its module is missing.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AudioProcessor } from '../src/core/effect.ts';
import { Fft } from '../src/core/fft.ts';
import { rubberBandStatus, setRubberBandModule } from '../src/effects/pitch/rubberband.ts';
import { createProcessor } from '../src/registry.ts';
import { SR } from './util.ts';

const WASM = new URL('../wasm/rubberband.wasm', import.meta.url);

beforeAll(() => setRubberBandModule(new WebAssembly.Module(readFileSync(WASM))));
afterAll(() => setRubberBandModule(null));

type Setup = { engine: string; quality: string };
const ENGINES: Setup[] = [
	{ engine: 'signalsmith', quality: 'best' },
	{ engine: 'signalsmith', quality: 'fast' },
	{ engine: 'rubberband-r3', quality: 'best' },
	{ engine: 'rubberband-r3', quality: 'fast' },
];
const label = (s: Setup) => `${s.engine} ${s.quality}`;

function shifter(s: Setup, semitones: number, formants: boolean, channels = 1): AudioProcessor {
	const p = createProcessor('jasper.audio.pitch-shifter', SR, channels)!;
	p.setParam('engine', s.engine);
	p.setParam('quality', s.quality);
	p.setParam('semitones', Math.trunc(semitones));
	p.setParam('cents', Math.round((semitones - Math.trunc(semitones)) * 100));
	p.setParam('preserveFormants', formants);
	p.reset();
	return p;
}

/** Runs `x` through `p` in 128-sample quanta (as the preview does) and returns the output aligned at 0. */
function run(p: AudioProcessor, x: Float32Array): Float32Array {
	const lat = p.latency();
	const buf = new Float32Array(x.length + lat);
	buf.set(x);
	for (let i = 0; i < buf.length; i += 128) p.process([buf], i, Math.min(buf.length, i + 128));
	return buf.subarray(lat);
}

/** A voiced, vowel-like source: an impulse train at `f0` (with slight vibrato) through three formant resonators. */
function vowel(f0: number, seconds: number, formants = [700, 1200, 2600], gain = 0.3): Float32Array {
	const n = Math.round(seconds * SR);
	const src = new Float64Array(n);
	let phase = 0;
	for (let i = 0; i < n; i++) {
		phase += (f0 * (1 + 0.004 * Math.sin((2 * Math.PI * 5 * i) / SR))) / SR;
		if (phase >= 1) {
			phase -= 1;
			src[i] = 1;
		}
	}
	let y = src;
	for (const [k, f] of formants.entries()) {
		const bw = [80, 90, 120][k]!;
		const r = Math.exp((-Math.PI * bw) / SR);
		const a1 = -2 * r * Math.cos((2 * Math.PI * f) / SR);
		const a2 = r * r;
		const out = new Float64Array(n);
		for (let i = 0; i < n; i++) out[i] = y[i]! - a1 * (out[i - 1] ?? 0) - a2 * (out[i - 2] ?? 0);
		y = out;
	}
	let peak = 0;
	for (const v of y) peak = Math.max(peak, Math.abs(v));
	return Float32Array.from(y, (v) => (v / peak) * gain);
}

/** f0 of `x[from, from+len)` by normalised autocorrelation around `guess` (parabolic peak). */
function f0Of(x: Float32Array, from: number, len: number, guess: number): number {
	const lo = Math.floor(SR / (guess * 1.15));
	const hi = Math.ceil(SR / (guess * 0.85));
	const r = new Float64Array(hi + 2);
	for (let lag = lo - 1; lag <= hi + 1; lag++) {
		let s = 0;
		for (let i = from; i < from + len; i++) s += x[i]! * x[i + lag]!;
		r[lag] = s;
	}
	let best = lo;
	for (let lag = lo; lag <= hi; lag++) if (r[lag]! > r[best]!) best = lag;
	const a = r[best - 1]!;
	const b = r[best]!;
	const c = r[best + 1]!;
	return SR / (best + (0.5 * (a - c)) / (a - 2 * b + c));
}

/** Cepstrally smoothed log spectrum (dB, 16384-point, 4.2 ms lifter: below the pitch periods used) of `x` at `from`. */
function envelope(x: Float32Array, from: number): Float64Array {
	const N = 16384;
	const re = new Float64Array(N);
	const im = new Float64Array(N);
	for (let i = 0; i < N; i++) re[i] = x[from + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
	const fft = new Fft(N);
	fft.forward(re, im);
	for (let k = 0; k < N; k++) {
		re[k] = Math.log(Math.hypot(re[k]!, im[k]!) + 1e-9);
		im[k] = 0;
	}
	fft.inverse(re, im);
	const lifter = 200;
	for (let q = 0; q < N; q++) {
		const keep = q < lifter || q > N - lifter;
		re[q] = keep ? re[q]! / N : 0;
		im[q] = 0;
	}
	fft.forward(re, im);
	return Float64Array.from(re.subarray(0, N / 2), (v) => (20 / Math.LN10) * v);
}

/** RMS distance (dB) over 200–4000 Hz between two envelopes, levels matched; `warp` reads `b` at f / warp. */
function envelopeDistance(a: Float64Array, b: Float64Array, warp = 1): number {
	const N = a.length * 2;
	const lo = Math.round((200 * N) / SR);
	const hi = Math.round((4000 * N) / SR);
	const d: number[] = [];
	for (let k = lo; k <= hi; k++) {
		const kb = k / warp;
		const i = Math.floor(kb);
		d.push(a[k]! - (b[i]! + (b[i + 1]! - b[i]!) * (kb - i)));
	}
	const mean = d.reduce((t, v) => t + v, 0) / d.length;
	return Math.sqrt(d.reduce((t, v) => t + (v - mean) ** 2, 0) / d.length);
}

describe('Pitch Shifter engines', () => {
	it('an instance stored without an engine keeps the legacy phase vocoder (and its latency)', () => {
		const p = createProcessor('jasper.audio.pitch-shifter', SR, 2)! as AudioProcessor & {
			runningEngine(): string;
		};
		p.setParam('semitones', -1);
		expect(p.runningEngine()).toBe('legacy');
		expect(p.latency()).toBe(2048);
	});

	for (const s of ENGINES) {
		it(`${label(s)}: output aligned with the input to the sample at 0 st, the same length`, () => {
			const x = vowel(140, 1.2);
			const y = run(shifter(s, 0, false), x);
			expect(y.length).toBe(x.length);
			// cross-correlation over ±20 samples around the claimed alignment: the peak is at lag 0
			let best = 0;
			let bestLag = 99;
			const from = Math.round(0.4 * SR);
			for (let lag = -20; lag <= 20; lag++) {
				let c = 0;
				for (let i = from; i < from + SR / 2; i++) c += x[i]! * y[i + lag]!;
				if (c > best) {
					best = c;
					bestLag = lag;
				}
			}
			expect(bestLag).toBe(0);
		});

		it(`${label(s)}: −1.5 st scales f0 by 2^(−1.5/12) within 0.3 %, formants on and off`, () => {
			const x = vowel(150, 1.2);
			const want = 150 * 2 ** (-1.5 / 12);
			for (const formants of [false, true]) {
				const y = run(shifter(s, -1.5, formants), x);
				const got = f0Of(y, Math.round(0.5 * SR), 9600, want);
				expect(Math.abs(got / want - 1), `formants ${formants}`).toBeLessThan(0.003);
			}
		});

		it(`${label(s)}: Preserve Formants keeps the spectral envelope; off, it moves with the pitch (−3 st)`, () => {
			const x = vowel(120, 1.2);
			const from = Math.round(0.4 * SR);
			const input = envelope(x, from);
			const kept = envelope(run(shifter(s, -3, true), x), from);
			const moved = envelope(run(shifter(s, -3, false), x), from);
			const ratio = 2 ** (-3 / 12);
			// measured on this vowel: kept ≈ 4.5–5 dB from the input, moved ≈ 6.7–8 dB (and close to the shifted input)
			expect(envelopeDistance(kept, input)).toBeLessThan(6);
			expect(envelopeDistance(kept, input)).toBeLessThan(0.75 * envelopeDistance(moved, input));
			expect(envelopeDistance(moved, input, ratio)).toBeLessThan(envelopeDistance(moved, input));
		});
	}

	it('Signalsmith and Rubber Band output does not depend on the host block sizes (stereo, a pitch change mid-stream)', () => {
		const x = vowel(130, 0.8);
		for (const s of [ENGINES[0]!, ENGINES[2]!]) {
			const render = (sizes: () => number) => {
				const p = shifter(s, -1.5, true, 2);
				const l = x.slice();
				const r = x.map((v, i) => v * 0.5 + (i % 7) * 1e-4);
				let pos = 0;
				while (pos < l.length) {
					if (pos >= 20000 && pos < 20000 + 4096) p.setParam('semitones', 2);
					const n = Math.min(sizes(), l.length - pos, pos < 20000 ? 20000 - pos : l.length);
					p.process([l, r], pos, pos + n);
					pos += n;
				}
				return [l, r];
			};
			let seed = 3;
			const whole = render(() => Number.MAX_SAFE_INTEGER);
			const ragged = render(() => {
				seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
				return [1, 37, 128, 1000, 4095][seed % 5]!;
			});
			for (let c = 0; c < 2; c++)
				for (let i = 0; i < x.length; i++)
					if (whole[c]![i] !== ragged[c]![i])
						throw new Error(`${label(s)}: block-size dependent at ${c}:${i}`);
		}
	});

	it('a full-scale input shifted down may exceed 0 dBFS: no engine clips or wraps inside the effect', () => {
		// a clipped voice: the vowel driven into ±1 (as the raw take, about +0.9 dBTP)
		const x = vowel(150, 1, [700, 1200, 2600], 4).map((v) => Math.max(-1, Math.min(1, v)));
		for (const s of [{ engine: 'legacy', quality: 'best' }, ...ENGINES]) {
			const y = run(shifter(s, -1.5, s.engine !== 'legacy'), x);
			let peak = 0;
			for (const v of y) {
				expect(Number.isFinite(v)).toBe(true);
				peak = Math.max(peak, Math.abs(v));
			}
			expect(peak, label(s)).toBeGreaterThan(1.02);
		}
	});

	it('Rubber Band R3 without its module runs Signalsmith, with the same latency', () => {
		expect(rubberBandStatus().available).toBe(true);
		const withModule = shifter({ engine: 'rubberband-r3', quality: 'best' }, -1.5, true) as AudioProcessor & {
			runningEngine(): string;
		};
		expect(withModule.runningEngine()).toBe('rubberband-r3');
		const module = new WebAssembly.Module(readFileSync(WASM));
		setRubberBandModule(null, 'missing in this test');
		try {
			const without = shifter({ engine: 'rubberband-r3', quality: 'best' }, -1.5, true) as AudioProcessor & {
				runningEngine(): string;
			};
			expect(without.runningEngine()).toBe('signalsmith');
			expect(without.latency()).toBe(withModule.latency());
			expect(rubberBandStatus()).toEqual({ available: false, error: 'missing in this test' });
		} finally {
			setRubberBandModule(module);
		}
	});
});
