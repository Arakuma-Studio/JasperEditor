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
import { Biquad, designBiquad } from '@jasper/audio-dsp';

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
const BUTTER4_Q = [0.5411961, 1.3065630] as const;

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
	private readonly filters: Biquad[][];
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
		this.sampleRate = fin(sampleRate) && sampleRate >= 1000 ? Math.round(sampleRate) : 48_000;
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
		this.minLevel = fin(opts.minLevel as number) && (opts.minLevel as number) > 0 ? (opts.minLevel as number) : 1e-4;
		this.filters = Array.from({ length: this.channels }, () =>
			BUTTER4_Q.map(
				(q) => new Biquad(designBiquad('highPass', this.sampleRate, CLICK_DETECTOR.highpassHz, q)),
			),
		);
		const cap = this.chunk + 3 * this.pad;
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
			for (let c = 0; c < this.channels; c++) {
				const x = planar[c];
				const [f1, f2] = this.filters[c]! as [Biquad, Biquad];
				const out = this.buf[c]!;
				for (let j = 0; j < take; j++) {
					const raw = x && i + j < x.length ? x[i + j]! : 0;
					out[this.len + j] = f2.processSample(f1.processSample(fin(raw) ? raw : 0));
				}
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
		const prefix = new Float64Array(n + 1);
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
			const sum = (a: number, b: number) => prefix[Math.min(n, Math.max(0, b))]! - prefix[Math.min(n, Math.max(0, a))]!;
			for (let abs = from; abs < to; abs++) {
				const k = abs - this.base;
				const v = y[k]!;
				const e = v < 0 ? -v : v;
				if (e <= this.minLevel) continue;
				const sL = Math.max(0, sum(k - L, k + L));
				const loc = Math.sqrt(sL / (2 * L)) + 1e-5;
				if (e <= ratioL * loc) continue;
				const sN = Math.max(0, sum(k - N, k + N));
				const near = Math.sqrt(sN / (2 * N)) + 1e-5;
				if (e <= ratioN * near) continue;
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
