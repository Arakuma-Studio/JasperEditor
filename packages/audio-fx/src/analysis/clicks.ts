// Click detection for Sound Check (spec 12 §4 P6-E1 `CLICK`; wp-note "Phase 6 → WP-E1"). Pure, deterministic,
// streaming (block-size independent) and total: it never throws.
//
// Adapted from earshot `skills/real-sound/scripts/qa.py` `detect_clicks` (MIT, Copyright (c) 2026 Leon Lin;
// licenses/ported/earshot.md): the signal high-passed at 14 kHz (4th-order Butterworth), a burst is a sample whose
// magnitude is more than 9× the RMS of its centred 20 ms neighbourhood and more than 6× the RMS of its centred 4 ms
// neighbourhood; it is a *click* (a cut, a discontinuity) when at least 80 % of the high-passed energy within ±5 ms of
// it lies within ±0.5 ms (1 ms), else an *attack* (a designed transient). After a burst, the same channel is quiet for
// 10 ms; bursts of different channels within 1 ms are one. Reimplemented in TypeScript, streaming: the windows are the
// same centred windows as earshot's `fftconvolve(…, mode='same')`, with silence before the first and after the last
// sample. Sample rates under 30 kHz cannot carry 14 kHz: nothing is detected there (documented limit).
import { designBiquad } from '@jasper/audio-dsp';

export const CLICK_DETECTOR = {
	highpassHz: 14_000,
	/** Neighbourhoods (centred windows, ms) and how far over their RMS a burst must be. */
	localMs: 20,
	localRatio: 9,
	nearMs: 4,
	nearRatio: 6,
	/** Concentration: energy within ±innerMs / ±outerMs of the burst; ≥ 0.8 = a click. */
	innerMs: 0.5,
	outerMs: 5,
	concentration: 0.8,
	/** Quiet time per channel after a burst (ms), and channels merged within (ms). */
	refractoryMs: 10,
	mergeMs: 1,
	/** Below this sample rate nothing is detected (14 kHz is over its Nyquist frequency with margin). */
	minSampleRate: 30_000,
	/** At most this many bursts are kept (earliest first). */
	maxBursts: 10_000,
} as const;

/** Butterworth 4th order = two biquads with these Q values. */
const BUTTER4_Q = [0.5411961, 1.306563] as const;

export type ClickBurst = {
	/** Sample index from the first sample pushed. */
	sample: number;
	channel: number;
	/** Peak magnitude of the high-passed signal at the burst (dBFS of the input scale). */
	levelDb: number;
	/** How far over its 20 ms neighbourhood (dB): 20·log10(|y| / RMS20). */
	overDb: number;
	/** Share of the ±5 ms energy within ±0.5 ms. */
	concentration: number;
	kind: 'click' | 'attack';
};

export type ClickDetectorOptions = {
	/** Least burst magnitude (linear, input scale) kept. Default 1e-4 (−80 dBFS): callers filter by level after. */
	minLevel?: number;
};

const fin = (x: number) => x - x === 0;
const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -120);

/**
 * Streams planar blocks and finds bursts (see the module docs). `push` any block sizes; `finish` once. Memory is
 * bounded (one chunk per channel), so a 4-hour stem is fine.
 */
export class ClickDetector {
	readonly sampleRate: number;
	readonly channels: number;
	readonly enabled: boolean;
	/** Two high-pass sections: coefficients (b0 b1 b2 a1 a2 each) and per channel TDF-II state (s1 s2 each). */
	private readonly coeffs: Float64Array;
	private readonly state: Float64Array[];
	private readonly prefix: Float64Array;
	/** Window half-lengths (samples). */
	private readonly hLocal: number;
	private readonly hNear: number;
	private readonly hInner: number;
	private readonly hOuter: number;
	private readonly refractory: number;
	private readonly pad: number;
	private readonly chunk: number;
	private readonly minLevel: number;
	/** Per channel: the high-passed samples of [base, base + len). */
	private readonly buf: Float64Array[];
	private len = 0;
	/** Absolute index of buf[0] (negative at the start: the silence before the first sample). */
	private base: number;
	/** Next absolute index to judge. */
	private next = 0;
	private total = 0;
	private readonly last: number[];
	private readonly found: ClickBurst[] = [];
	private finished = false;

	constructor(sampleRate: number, channels: number, opts: ClickDetectorOptions = {}) {
		this.sampleRate =
			fin(sampleRate) && sampleRate >= 1000 && sampleRate <= 768_000 ? Math.round(sampleRate) : 48_000;
		this.channels = Math.max(1, Math.min(32, Math.floor(fin(channels) ? channels : 1)));
		this.enabled = this.sampleRate >= CLICK_DETECTOR.minSampleRate;
		const ms = (x: number) => Math.max(1, Math.round((x / 1000) * this.sampleRate));
		this.hLocal = Math.max(1, Math.round(ms(CLICK_DETECTOR.localMs) / 2));
		this.hNear = Math.max(1, Math.round(ms(CLICK_DETECTOR.nearMs) / 2));
		this.hInner = ms(CLICK_DETECTOR.innerMs);
		this.hOuter = ms(CLICK_DETECTOR.outerMs);
		this.refractory = ms(CLICK_DETECTOR.refractoryMs);
		this.pad = Math.max(this.hLocal, this.hOuter, this.hNear) + 1;
		this.chunk = 16_384;
		this.minLevel =
			fin(opts.minLevel as number) && (opts.minLevel as number) > 0 ? (opts.minLevel as number) : 1e-4;
		this.coeffs = new Float64Array(10);
		BUTTER4_Q.forEach((q, k) => {
			const c = designBiquad('highPass', this.sampleRate, CLICK_DETECTOR.highpassHz, q);
			this.coeffs.set([c.b0, c.b1, c.b2, c.a1, c.a2], k * 5);
		});
		this.state = Array.from({ length: this.channels }, () => new Float64Array(4));
		const cap = this.chunk + 3 * this.pad;
		this.prefix = new Float64Array(cap + this.pad + 1);
		this.buf = Array.from({ length: this.channels }, () => new Float64Array(cap));
		// the silence before the first sample (the `same` convolution's zero padding)
		this.len = this.pad;
		this.base = -this.pad;
		this.last = new Array(this.channels).fill(Number.NEGATIVE_INFINITY);
	}

	/** Samples pushed so far. */
	get samples(): number {
		return this.total;
	}

	/** Feeds `frames` samples of every channel (missing channels are silence; non-finite samples count as 0). */
	push(planar: readonly Float32Array[], frames: number): void {
		if (this.finished) return;
		const n = Math.max(0, Math.floor(fin(frames) ? frames : 0));
		if (!this.enabled) {
			this.total += n;
			return;
		}
		let i = 0;
		while (i < n) {
			const room = this.buf[0]!.length - this.len;
			const take = Math.min(n - i, room);
			const k = this.coeffs;
			const [b0, b1, b2, a1, a2, d0, d1, d2, e1, e2] = [
				k[0]!,
				k[1]!,
				k[2]!,
				k[3]!,
				k[4]!,
				k[5]!,
				k[6]!,
				k[7]!,
				k[8]!,
				k[9]!,
			];
			for (let c = 0; c < this.channels; c++) {
				const x = planar[c];
				const st = this.state[c]!;
				let s1 = st[0]!;
				let s2 = st[1]!;
				let t1 = st[2]!;
				let t2 = st[3]!;
				const out = this.buf[c]!;
				const avail = x ? Math.max(0, Math.min(take, x.length - i)) : 0;
				for (let j = 0; j < take; j++) {
					const raw = j < avail ? x![i + j]! : 0;
					const v = raw - raw === 0 ? raw : 0;
					// two transposed direct form II sections
					const y = b0 * v + s1;
					s1 = b1 * v - a1 * y + s2;
					s2 = b2 * v - a2 * y;
					const z = d0 * y + t1;
					t1 = d1 * y - e1 * z + t2;
					t2 = d2 * y - e2 * z;
					out[this.len + j] = z;
				}
				// denormal protection of the recursive state
				st[0] = Math.abs(s1) < 1e-30 ? 0 : s1;
				st[1] = Math.abs(s2) < 1e-30 ? 0 : s2;
				st[2] = Math.abs(t1) < 1e-30 ? 0 : t1;
				st[3] = Math.abs(t2) < 1e-30 ? 0 : t2;
			}
			this.len += take;
			this.total += take;
			i += take;
			if (this.len >= this.buf[0]!.length) this.flush(false);
		}
	}

	/** Judges what the buffer allows and keeps the context the next judgement needs. */
	private flush(final: boolean): void {
		// judge absolute indices up to `upTo` (exclusive): every window around them is inside the buffer (or past the end)
		const end = this.base + this.len;
		const upTo = final ? Math.min(end, this.total) : end - this.pad;
		if (upTo > this.next) this.judge(this.next, upTo, final);
		this.next = Math.max(this.next, upTo);
		if (final) return;
		// keep from (next − pad): the left context of the next index
		const keepFrom = this.next - this.pad - this.base;
		if (keepFrom > 0) {
			for (const b of this.buf) b.copyWithin(0, keepFrom, this.len);
			this.len -= keepFrom;
			this.base += keepFrom;
		}
	}

	private judge(from: number, to: number, final: boolean): void {
		// prefix sums of y² per channel over the buffer plus `pad` zeros after it (the silence after the end)
		const n = this.len + (final ? this.pad : 0);
		const prefix = this.prefix;
		const L = this.hLocal;
		const N = this.hNear;
		const I = this.hInner;
		const O = this.hOuter;
		const ratioL = CLICK_DETECTOR.localRatio;
		const ratioN = CLICK_DETECTOR.nearRatio;
		for (let c = 0; c < this.channels; c++) {
			const y = this.buf[c]!;
			for (let k = 0; k < n; k++) {
				const v = k < this.len ? y[k]! : 0;
				prefix[k + 1] = prefix[k]! + v * v;
			}
			// every window of an index judged lies in [0, n]: k ∈ [pad, len) and pad > every half-length
			const sum = (a: number, b: number) => prefix[b]! - prefix[a]!;
			const minLevel = this.minLevel;
			for (let abs = from; abs < to; abs++) {
				const k = abs - this.base;
				const v = y[k]!;
				const e = v < 0 ? -v : v;
				if (e <= minLevel) continue;
				// e > 9·(√(sL / 2L) + 1e-5) ⇔ (e/9 − 1e-5)² > sL / 2L (both sides ≥ 0)
				const tl = e / ratioL - 1e-5;
				const sL = prefix[k + L]! - prefix[k - L]!;
				if (tl <= 0 || tl * tl <= Math.max(0, sL) / (2 * L)) continue;
				const tn = e / ratioN - 1e-5;
				const sN = prefix[k + N]! - prefix[k - N]!;
				if (tn <= 0 || tn * tn <= Math.max(0, sN) / (2 * N)) continue;
				const loc = Math.sqrt(Math.max(0, sL) / (2 * L)) + 1e-5;
				if (abs - this.last[c]! > this.refractory) {
					const inner = Math.max(0, sum(k - I, k + I));
					const outer = Math.max(0, sum(k - O, k + O));
					const conc = outer > 0 ? Math.min(1, inner / (outer + 1e-15)) : 0;
					if (this.found.length < CLICK_DETECTOR.maxBursts)
						this.found.push({
							sample: abs,
							channel: c,
							levelDb: Math.round(db(e) * 10) / 10,
							overDb: Math.round(db(e / loc) * 10) / 10,
							concentration: Math.round(conc * 100) / 100,
							kind: conc >= CLICK_DETECTOR.concentration ? 'click' : 'attack',
						});
				}
				this.last[c] = abs;
			}
		}
	}

	/** Judges the rest and returns the bursts in time order (channels within 1 ms merged: the first kept). */
	finish(): ClickBurst[] {
		if (!this.finished) {
			this.finished = true;
			if (this.enabled) this.flush(true);
		}
		const merge = Math.max(1, Math.round((CLICK_DETECTOR.mergeMs / 1000) * this.sampleRate));
		const sorted = [...this.found].sort((a, b) => a.sample - b.sample || a.channel - b.channel);
		return sorted.filter((b, i) => i === 0 || b.sample - sorted[i - 1]!.sample > merge);
	}
}

/** Bursts of a whole signal (`ClickDetector` in one block). */
export function detectClicks(
	planar: readonly Float32Array[],
	sampleRate: number,
	opts: ClickDetectorOptions = {},
): ClickBurst[] {
	const d = new ClickDetector(sampleRate, Math.max(1, planar.length), opts);
	d.push(planar, planar[0]?.length ?? 0);
	return d.finish();
}
