// Listening transcript events (spec 12 §4 P6-E6; wp-note "Phase 6 → WP-E3"): what an agent that cannot hear needs to
// know about a stem or a mix, as a list of events. Pure, deterministic, streaming (block-size independent, bounded
// memory: a 10-minute mix is analysed in 30 s chunks with 2.5 s of context) and total: it never throws.
//
// Adapted from earshot `earshot/timeline.py` (MIT, Copyright (c) 2026 Leon Lin; licenses/ported/earshot.md):
//   onsets   a superflux onset curve (5 ms frames: the mean positive increase of the log band energies over the
//            maximum of the neighbouring bands two frames before), peak-picked over ±25 ms where its robust z
//            (median / MAD over ±1 s) is ≥ 3; each refined to the attack on 1 ms max-abs envelopes of the full signal,
//            its lows (< 200 Hz) and its highs (> 2 kHz): in the band where the event stands out most over its bed,
//            walk back from the event's peak to the first millisecond within 20 dB of it above the bed (the timing comes
//            from the full band whenever the event rises 12 dB there too); length = until the envelope falls 20 dB under
//            the peak or back to 3 dB over the bed for 30 ms (≤ 2 s); onsets within 30 ms are one (from the first attack,
//            with the stronger one's band, contrast, prominence and peak).
//   prominence  the rise of the K-weighted 10 ms level (at 1 ms steps) over the bed: the median of the 20–300 ms before
//            the attack (floored at −80); `bedDb` reads as LUFS. Measured over the event's own length (≤ 80 ms: windows
//            ending inside it), so a flicker of the bed just before a hit does not borrow the hit's level.
//   swells   10 ms RMS of the signal and of its highs, smoothed over 90 ms, rising ≥ 8 dB over 0.25–2 s, mostly
//            monotonically (≥ 60 % rising steps), then falling ≥ 4 dB; timed at their peak; a peak that is the attack
//            of an onset explaining at least half the rise (and ≥ 3 dB) is not a swell.
//   silences fast (100 ms) loudness 20 LU under the integrated loudness (or under −60 LUFS) for ≥ 0.25 s.
//   accents  the top 20 % of events by prominence that are also ≥ 6 dB over their bed.
//   sync     the event that answers a picture event (OK within a frame, near ≤ 100 ms, swell ≤ 300 ms, else none) and
//            the CHANCE level of every share: the share random times would score with the same events (the measure of
//            the union of the ±tolerance windows over the span), so "60 % of cuts have a sound" means something. Only
//            events rising ≥ 3 dB over their bed answer (and count for chance): a busy bed's flicker is no sound. An
//            event answers at its attack or at its peak (ours: sounds are placed by their peak, a whoosh peaks on its
//            cut long after its attack; earshot matches attacks and falls back to level peaks).
// Changes from earshot (all deterministic): log-spaced triangular bands (96, 30 Hz–16 kHz) instead of mel; an absolute
// −100 dB band floor instead of "80 dB under the file's maximum"; the MAD is taken around each candidate's own median;
// the prominence window ends with the event (earshot: always 80 ms); a swell is dropped for an onset at its peak only
// when that onset explains half its rise (earshot: any onset there); merged onsets start at the first attack (earshot:
// the stronger onset's time);
// the z floor (2 % of the 99th percentile of the onset curve) and the bed fallback (the 10th percentile within ±2 s) are
// local to the chunk; no level-peak fallback for unanswered cuts and no model tags (CLAP / AST are not adopted).
import {
	type BiquadCoeffs,
	defaultChannelWeights,
	designBiquad,
	Fft,
	kPrefilter,
	kRlb,
} from '@jasper/audio-dsp';

/** The detector's constants (earshot `timeline.py` unless said otherwise). */
export const LISTEN_EVENTS = {
	/** Onset frame hop (ms) and FFT size at 48 kHz (scaled with the sample rate to the same duration). */
	hopMs: 5,
	fftAt48k: 1024,
	/** Log-spaced bands of the onset curve and the spectrogram. */
	bands: 96,
	fMinHz: 30,
	fMaxHz: 16_000,
	/** Band level floor (dB re a full-scale sine) — decision: absolute, so a chunk does not depend on the whole file. */
	floorDb: -100,
	/** Peak picking (frames: ±25 ms), robust z over ±1 s, threshold. */
	pickFrames: 11,
	zFrames: 401,
	zThreshold: 3,
	/** Least contrast over the bed (dB) for an onset. */
	minContrastDb: 3,
	/** Onsets closer than this are one (ms). */
	mergeMs: 30,
	lowHz: 200,
	highHz: 2000,
	/** Beds quieter than this count as this (dBFS), so a prominence stays finite. */
	bedFloorDb: -80,
	/** The full-band timing is used when the event rises this much there (ratio 4 = 12 dB). */
	fullTimingRatio: 4,
	lengthCapMs: 2000,
	/** Prominence: 10 ms windows; the bed is the median of the windows starting 300…20 ms before the attack. */
	bedFromMs: 300,
	bedToMs: 20,
	peakSearchMs: 80,
	swellRiseDb: 8,
	swellMinSec: 0.25,
	swellMaxSec: 2,
	swellMonotone: 0.6,
	silenceUnderLu: 20,
	silenceFloorLufs: -60,
	silenceMinSec: 0.25,
	accentDb: 6,
	accentTopShare: 0.2,
	/** Analysis chunk and the context kept either side of it (ms). */
	chunkMs: 30_000,
	contextMs: 2500,
	/** Longest input analysed (s); more is ignored (`truncated`). The engine refuses ranges over 10 min before. */
	maxSeconds: 2 * 3600,
} as const;

/** Sync windows (ms; earshot `timeline.py` `sync`). */
export const LISTEN_SYNC = {
	nearMs: 100,
	swellMs: 300,
	/** A strong onset this close to an unanswered picture event is named ("nearest sound"). */
	offMs: 250,
	onBeatMs: 50,
	/** Tolerance of "OK" without a frame rate (ms). */
	defaultFrameMs: 40,
	/**
	 * Only an event rising this much over its bed answers a picture event (and counts for the chance levels) — decision:
	 * the flicker of a busy bed (an onset the K-weighted level does not rise for) is no sound for a cut; earshot counts
	 * every onset.
	 */
	minProminenceDb: 3,
} as const;

export type ListenBand = 'full' | 'low' | 'high';

export type ListenEvent = {
	/** Attack (onsets) or peak (swells), ms from the first sample pushed (0.1 ms steps). */
	ms: number;
	/** Where the event's full-band envelope peaks over its length (ms; swells: their peak). */
	peakMs: number;
	shape: 'hit' | 'swell';
	/** The band the event stands out in. */
	band: ListenBand;
	/** Rise of the K-weighted 10 ms level over the bed (dB). */
	prominenceDb: number;
	/** The bed just before (K-weighted, ≈ LUFS; swells: the 10 ms RMS before the rise, dBFS), floored at −80. */
	bedDb: number;
	/** Rise in its band over the bed of that band (dB). */
	contrastDb: number;
	/** Onset novelty in robust standard deviations (0 for swells). */
	z: number;
	/** Length until it has decayed 20 dB (ms; swells: until 10 dB under their peak). */
	lengthMs: number;
	/** Sample peak over its first 50–300 ms (dBFS). */
	peakDb: number;
	/** Swells: how long the rise took (ms). */
	riseMs?: number;
	/** Top 20 % by prominence and ≥ 6 dB over the bed. */
	accent: boolean;
	/**
	 * Found at a hint (`ListenMeter.hint`: where a clip rendered alone has its own onset) although the onset curve did
	 * not stand out there: the signal still rises ≥ 3 dB over its bed in some band at that attack.
	 */
	guided?: boolean;
};

export type ListenSilence = {
	startMs: number;
	endMs: number;
	kind: 'digital silence' | 'near silence' | 'drop';
	/** Mean fast loudness over it (LUFS, floored at −70). */
	levelLufs: number;
	/** It touches the first / last sample pushed. */
	atStart: boolean;
	atEnd: boolean;
};

/** A log-frequency spectrogram: `frames` columns of `bands` levels (u8: 0 = `floorDb`, 255 = 0 dB), column-major. */
export type ListenSpectrogram = {
	hopMs: number;
	bands: number;
	frames: number;
	fMinHz: number;
	fMaxHz: number;
	floorDb: number;
	/** `data[frame · bands + band]`, band 0 the lowest. */
	data: Uint8Array;
};

export type ListenAnalysis = {
	sampleRate: number;
	/** Samples analysed. */
	samples: number;
	events: ListenEvent[];
	/** The accent threshold used (dB of prominence; null without events). */
	accentDb: number | null;
	silences: ListenSilence[];
	/** BS.1770 gated integrated loudness of what was pushed (null: everything gated out). */
	integratedLufs: number | null;
	/** Per 10 ms hop: the K-weighted channel-weighted energy summed over the hop, and the sample peak (dBFS, ≥ −120). */
	hop10: {
		count: number;
		samples: number;
		kEnergy: Float64Array;
		peakDb: Float32Array;
		/** Mean square of the mono mean of the channels (linear). */
		meanSquare: Float64Array;
	};
	spectrogram: ListenSpectrogram | null;
	/** Input beyond `maxSeconds` was ignored. */
	truncated: boolean;
};

const fin = (x: number) => x - x === 0;
/** Sample rates outside 1 kHz…768 kHz are read as 48 kHz (hostile input). */
const rateOf = (sr: number) => (fin(sr) && sr >= 1000 && sr <= 768_000 ? Math.round(sr) : 48_000);
const BUTTER4_Q = [0.5411961, 1.306563] as const;
const BED_FLOOR = 10 ** (LISTEN_EVENTS.bedFloorDb / 20);
/** An onset at a swell's peak makes the peak its attack when it is this prominent and explains half the rise. */
const SWELL_HIT_DB = 3;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Linear-interpolated percentile (NumPy's default) of `xs` (not modified); NaN for an empty list. */
function percentile(xs: ArrayLike<number>, p: number): number {
	const n = xs.length;
	if (n === 0) return Number.NaN;
	const s = Float64Array.from(xs).sort();
	const q = (Math.min(100, Math.max(0, p)) / 100) * (n - 1);
	const lo = Math.floor(q);
	const hi = Math.min(n - 1, lo + 1);
	return s[lo]! + (s[hi]! - s[lo]!) * (q - lo);
}
const median = (xs: ArrayLike<number>) => percentile(xs, 50);

/** Cascaded biquads (TDF-II, float64 state), one channel. */
class Sos {
	private readonly c: Float64Array;
	private readonly s: Float64Array;
	constructor(sections: readonly BiquadCoeffs[]) {
		this.c = new Float64Array(sections.length * 5);
		this.s = new Float64Array(sections.length * 2);
		sections.forEach((q, i) => {
			this.c.set([q.b0, q.b1, q.b2, q.a1, q.a2], i * 5);
		});
	}
	run(x: number): number {
		const c = this.c;
		const s = this.s;
		let v = x;
		for (let k = 0, n = s.length / 2; k < n; k++) {
			const o = k * 5;
			const y = c[o]! * v + s[2 * k]!;
			let s1 = c[o + 1]! * v - c[o + 3]! * y + s[2 * k + 1]!;
			let s2 = c[o + 2]! * v - c[o + 4]! * y;
			if (s1 > -1e-30 && s1 < 1e-30) s1 = 0;
			if (s2 > -1e-30 && s2 < 1e-30) s2 = 0;
			s[2 * k] = s1;
			s[2 * k + 1] = s2;
			v = y;
		}
		return v;
	}
	get quiet(): boolean {
		for (let i = 0; i < this.s.length; i++) if (this.s[i] !== 0) return false;
		return true;
	}
}

/** A growable float64 series that can drop its oldest values (absolute indices stay valid). */
class Series {
	private data: Float64Array;
	/** Absolute index of `data[0]`. */
	base = 0;
	/** Absolute end (exclusive). */
	end = 0;
	constructor(cap = 4096) {
		this.data = new Float64Array(cap);
	}
	push(v: number): void {
		if (this.end - this.base >= this.data.length) {
			const next = new Float64Array(this.data.length * 2);
			next.set(this.data.subarray(0, this.end - this.base));
			this.data = next;
		}
		this.data[this.end - this.base] = v;
		this.end++;
	}
	get(i: number): number {
		return i < this.base || i >= this.end ? 0 : this.data[i - this.base]!;
	}
	/** Values of `[a, b)` clamped to what is kept. */
	slice(a: number, b: number): Float64Array {
		const lo = Math.max(this.base, a);
		const hi = Math.min(this.end, b);
		return hi > lo ? this.data.slice(lo - this.base, hi - this.base) : new Float64Array(0);
	}
	dropBefore(i: number): void {
		const k = Math.min(this.end, i) - this.base;
		if (k <= 0) return;
		this.data.copyWithin(0, k, this.end - this.base);
		this.base += k;
	}
}

/** Growable dense arrays (the 10 ms hops). */
class Dense {
	f64: Float64Array;
	n = 0;
	constructor(cap = 1024) {
		this.f64 = new Float64Array(cap);
	}
	push(v: number): void {
		if (this.n >= this.f64.length) {
			const next = new Float64Array(this.f64.length * 2);
			next.set(this.f64);
			this.f64 = next;
		}
		this.f64[this.n++] = v;
	}
	view(): Float64Array {
		return this.f64.subarray(0, this.n);
	}
}

/**
 * Short-time log-band energies of a mono stream: a Hann-windowed FFT every `hopMs`, frame `f` centred on sample
 * `round(f · hop)` (silence before the first and after the last sample), its power summed into log-spaced triangular
 * bands, in dB re a full-scale sine, floored. Frames of digital silence cost nothing.
 */
export class LogBandStft {
	readonly n: number;
	readonly hop: number;
	readonly bands: number;
	readonly fMinHz: number;
	readonly fMaxHz: number;
	readonly floorDb: number;
	private readonly fft: Fft;
	private readonly win: Float64Array;
	private readonly norm: number;
	private readonly ring: Float64Array;
	private readonly mask: number;
	private readonly re: Float64Array;
	private readonly im: Float64Array;
	private readonly bandStart: Int32Array;
	private readonly bandW: Float64Array[];
	private readonly levels: Float64Array;
	private pushed = 0;
	private lastNonZero = -1;
	/** Next frame to emit. */
	frame = 0;

	constructor(
		sampleRate: number,
		private readonly onFrame: (frame: number, levels: Float64Array) => void,
		opts: { bands?: number; fMinHz?: number; fMaxHz?: number; floorDb?: number; hopMs?: number } = {},
	) {
		const sr = rateOf(sampleRate);
		let n = 2;
		while (n < (LISTEN_EVENTS.fftAt48k * sr) / 48_000 / 1.5) n *= 2;
		this.n = Math.max(64, n);
		this.hop = (sr * (opts.hopMs ?? LISTEN_EVENTS.hopMs)) / 1000;
		this.bands = Math.max(4, Math.min(256, Math.floor(opts.bands ?? LISTEN_EVENTS.bands)));
		this.fMinHz = opts.fMinHz ?? LISTEN_EVENTS.fMinHz;
		this.fMaxHz = Math.min(opts.fMaxHz ?? LISTEN_EVENTS.fMaxHz, sr * 0.45);
		this.floorDb = opts.floorDb ?? LISTEN_EVENTS.floorDb;
		this.fft = new Fft(this.n);
		this.win = new Float64Array(this.n);
		let sum = 0;
		for (let i = 0; i < this.n; i++) {
			this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.n);
			sum += this.win[i]!;
		}
		this.norm = (sum / 2) ** 2;
		this.ring = new Float64Array(this.n * 2);
		this.mask = this.n * 2 - 1;
		this.re = new Float64Array(this.n);
		this.im = new Float64Array(this.n);
		this.levels = new Float64Array(this.bands);
		// triangular bands between log-spaced edges; a band narrower than a bin takes its nearest bin
		const edges: number[] = [];
		const lr = Math.log(this.fMaxHz / this.fMinHz);
		for (let i = 0; i < this.bands + 2; i++) edges.push(this.fMinHz * Math.exp((lr * i) / (this.bands + 1)));
		const binHz = sr / this.n;
		this.bandStart = new Int32Array(this.bands);
		this.bandW = [];
		for (let b = 0; b < this.bands; b++) {
			const lo = edges[b]!;
			const c = edges[b + 1]!;
			const hi = edges[b + 2]!;
			const k0 = Math.max(1, Math.floor(lo / binHz));
			const k1 = Math.min(this.n / 2, Math.ceil(hi / binHz));
			const w: number[] = [];
			for (let k = k0; k <= k1; k++) {
				const f = k * binHz;
				w.push(Math.max(0, Math.min((f - lo) / (c - lo), (hi - f) / (hi - c))));
			}
			if (!w.some((x) => x > 0)) {
				const k = Math.max(1, Math.min(this.n / 2, Math.round(c / binHz)));
				this.bandStart[b] = k;
				this.bandW.push(Float64Array.of(1));
			} else {
				this.bandStart[b] = k0;
				this.bandW.push(Float64Array.from(w));
			}
		}
	}

	private centre(f: number): number {
		return Math.round(f * this.hop);
	}

	private emit(): void {
		const f = this.frame++;
		const c = this.centre(f);
		const s0 = c - this.n / 2;
		if (this.lastNonZero < s0) this.levels.fill(this.floorDb);
		else {
			const re = this.re;
			const im = this.im;
			for (let k = 0; k < this.n; k++) {
				const s = s0 + k;
				re[k] = s < 0 || s >= this.pushed ? 0 : this.ring[s & this.mask]! * this.win[k]!;
				im[k] = 0;
			}
			this.fft.forward(re, im);
			for (let b = 0; b < this.bands; b++) {
				const w = this.bandW[b]!;
				const k0 = this.bandStart[b]!;
				let e = 0;
				for (let i = 0; i < w.length; i++) {
					const k = k0 + i;
					e += w[i]! * (re[k]! * re[k]! + im[k]! * im[k]!);
				}
				const db = 10 * Math.log10(e / this.norm + 1e-30);
				this.levels[b] = db > this.floorDb ? db : this.floorDb;
			}
		}
		this.onFrame(f, this.levels);
	}

	push(x: number): void {
		this.ring[this.pushed & this.mask] = x;
		if (x !== 0) this.lastNonZero = this.pushed;
		this.pushed++;
		while (this.pushed >= this.centre(this.frame) + this.n / 2) this.emit();
	}

	/** Emits the frames centred inside what was pushed (silence after it). */
	flush(): void {
		const end = this.pushed;
		while (this.centre(this.frame) < end) {
			// the samples after the end are silence: pad the ring with zeros as they are reached
			const need = this.centre(this.frame) + this.n / 2;
			while (this.pushed < need) {
				this.ring[this.pushed & this.mask] = 0;
				this.pushed++;
			}
			this.emit();
		}
	}
}

/**
 * The log-frequency spectrogram of a stream on its own (the sheet's lane, `POST /api/sound-design/visual`
 * `spectrogram`): the mono mean of the channels through {@link LogBandStft}, two 5 ms frames per 10 ms column (their
 * maximum), `gainDb` added to every level (as delivered). Non-finite samples count as 0.
 */
export class SpectrogramMeter {
	private readonly stft: LogBandStft;
	private readonly channels: number;
	private data = new Uint8Array(1024 * LISTEN_EVENTS.bands);
	private frames = 0;
	private pending: Float64Array | null = null;
	private done: ListenSpectrogram | null = null;
	constructor(
		sampleRate: number,
		channels: number,
		private readonly gainDb = 0,
	) {
		this.channels = Math.max(1, Math.min(32, Math.floor(fin(channels) ? channels : 1)));
		this.stft = new LogBandStft(sampleRate, (_f, levels) => this.onFrame(levels));
	}
	private onFrame(levels: Float64Array): void {
		if (!this.pending) {
			this.pending = Float64Array.from(levels);
			return;
		}
		const col = this.pending;
		const B = col.length;
		for (let b = 0; b < B; b++) if (levels[b]! > col[b]!) col[b] = levels[b]!;
		this.pending = null;
		if ((this.frames + 1) * B > this.data.length) {
			const next = new Uint8Array(this.data.length * 2);
			next.set(this.data);
			this.data = next;
		}
		const floor = this.stft.floorDb;
		const g = fin(this.gainDb) ? this.gainDb : 0;
		for (let b = 0; b < B; b++) {
			const v = col[b]! <= floor ? floor : col[b]! + g;
			this.data[this.frames * B + b] = Math.round(Math.max(0, Math.min(1, (v - floor) / -floor)) * 255);
		}
		this.frames++;
	}
	push(planar: readonly (Float32Array | Float64Array | undefined)[], n: number): void {
		if (this.done) return;
		const count = Math.max(0, Math.floor(fin(n) ? n : 0));
		for (let i = 0; i < count; i++) {
			let m = 0;
			for (let c = 0; c < this.channels; c++) {
				const raw = planar[c]?.[i];
				if (raw !== undefined && fin(raw)) m += raw;
			}
			this.stft.push(m / this.channels);
		}
	}
	finish(): ListenSpectrogram {
		if (this.done) return this.done;
		this.stft.flush();
		if (this.pending) this.onFrame(this.pending);
		this.done = {
			hopMs: 10,
			bands: this.stft.bands,
			frames: this.frames,
			fMinHz: this.stft.fMinHz,
			fMaxHz: Math.round(this.stft.fMaxHz),
			floorDb: this.stft.floorDb,
			data: this.data.slice(0, this.frames * this.stft.bands),
		};
		return this.done;
	}
}

type Attack = { ratio: number; band: ListenBand; j: number; ip: number; bed: number };

/**
 * Streams planar blocks of a stem or mix and finds its events (see the module docs). `push` any block sizes; `finish`
 * once. Non-finite samples count as 0; a missing channel is silence.
 */
export class ListenMeter {
	readonly sampleRate: number;
	readonly channels: number;
	private readonly weights: number[];
	private readonly kw: Sos[];
	private readonly lp: Sos;
	private readonly hp: Sos;
	private readonly stft: LogBandStft;
	private readonly maxSamples: number;
	private readonly spec: boolean;
	// per-millisecond features (absolute ms index)
	private readonly eFull = new Series();
	private readonly eLow = new Series();
	private readonly eHigh = new Series();
	private readonly kMs = new Series();
	// onset curve (absolute frame index)
	private readonly odf = new Series();
	private prev1: Float64Array | null = null;
	private prev2: Float64Array | null = null;
	private specData: Uint8Array;
	private specFrames = 0;
	private specPending: Float64Array | null = null;
	// per 10 ms (whole input)
	private readonly k10 = new Dense();
	private readonly pk10 = new Dense();
	private readonly msF10 = new Dense();
	private readonly msH10 = new Dense();
	// accumulators
	private samples = 0;
	private msIndex = 0;
	private msEnd: number;
	private aFull = 0;
	private aLow = 0;
	private aHigh = 0;
	private aK = 0;
	private aMsF = 0;
	private aMsH = 0;
	private h10K = 0;
	private h10P = 0;
	private h10F = 0;
	private h10H = 0;
	private h10N = 0;
	private zeroRun = 0;
	private truncated = false;
	private finished: ListenAnalysis | null = null;
	// detection
	private doneFrame = 0;
	private readonly hits: ListenEvent[] = [];
	/** Attacks to look at (ms), sorted; consumed by the chunk that covers them. */
	private hints: number[] = [];

	private readonly onHit: ((e: ListenEvent) => void) | null;

	constructor(
		sampleRate: number,
		channels: number,
		opts: {
			spectrogram?: boolean;
			maxSeconds?: number;
			/** Called with every onset as its chunk finds it (not the guided ones, not swells). */
			onHit?: (e: ListenEvent) => void;
		} = {},
	) {
		this.onHit = opts.onHit ?? null;
		this.sampleRate = rateOf(sampleRate);
		this.channels = Math.max(1, Math.min(32, Math.floor(fin(channels) ? channels : 1)));
		const sr = this.sampleRate;
		this.weights = defaultChannelWeights(this.channels);
		this.kw = Array.from({ length: this.channels }, () => new Sos([kPrefilter(sr), kRlb(sr)]));
		this.lp = new Sos(BUTTER4_Q.map((q) => designBiquad('lowPass', sr, LISTEN_EVENTS.lowHz, q)));
		this.hp = new Sos(BUTTER4_Q.map((q) => designBiquad('highPass', sr, LISTEN_EVENTS.highHz, q)));
		this.spec = opts.spectrogram === true;
		this.specData = new Uint8Array(this.spec ? 1024 * LISTEN_EVENTS.bands : 0);
		this.stft = new LogBandStft(sr, (f, levels) => this.onFrame(f, levels));
		const maxSec = Math.min(
			LISTEN_EVENTS.maxSeconds,
			fin(opts.maxSeconds ?? Number.NaN) ? opts.maxSeconds! : LISTEN_EVENTS.maxSeconds,
		);
		this.maxSamples = Math.max(0, Math.floor(maxSec * sr));
		this.msEnd = this.boundary(0);
	}

	private boundary(ms: number): number {
		return Math.round(((ms + 1) * this.sampleRate) / 1000);
	}

	private onFrame(_f: number, levels: Float64Array): void {
		const B = levels.length;
		let v = 0;
		if (this.prev2) {
			const p = this.prev2;
			for (let b = 0; b < B; b++) {
				let m = p[b]!;
				if (b > 0 && p[b - 1]! > m) m = p[b - 1]!;
				if (b + 1 < B && p[b + 1]! > m) m = p[b + 1]!;
				const d = levels[b]! - m;
				if (d > 0) v += d;
			}
			v /= B;
		}
		this.odf.push(v);
		this.prev2 = this.prev1;
		this.prev1 = Float64Array.from(levels);
		if (this.spec) {
			if (!this.specPending) this.specPending = Float64Array.from(levels);
			else {
				const col = this.specPending;
				for (let b = 0; b < B; b++) if (levels[b]! > col[b]!) col[b] = levels[b]!;
				this.pushSpec(col);
				this.specPending = null;
			}
		}
	}

	private pushSpec(col: Float64Array): void {
		const B = col.length;
		if ((this.specFrames + 1) * B > this.specData.length) {
			const next = new Uint8Array(this.specData.length * 2);
			next.set(this.specData);
			this.specData = next;
		}
		const floor = this.stft.floorDb;
		for (let b = 0; b < B; b++)
			this.specData[this.specFrames * B + b] = Math.round(
				Math.max(0, Math.min(1, (col[b]! - floor) / -floor)) * 255,
			);
		this.specFrames++;
	}

	private closeMs(): void {
		this.eFull.push(this.aFull + 1e-7);
		this.eLow.push(this.aLow + 1e-7);
		this.eHigh.push(this.aHigh + 1e-7);
		this.kMs.push(this.aK);
		this.h10K += this.aK;
		this.h10F += this.aMsF;
		this.h10H += this.aMsH;
		if (this.aFull > this.h10P) this.h10P = this.aFull;
		this.aFull = 0;
		this.aLow = 0;
		this.aHigh = 0;
		this.aK = 0;
		this.aMsF = 0;
		this.aMsH = 0;
		this.msIndex++;
		this.msEnd = this.boundary(this.msIndex);
		if (this.msIndex % 10 === 0) this.closeHop10();
		this.maybeDetect(false);
	}

	private closeHop10(): void {
		const n = Math.max(1, this.h10N);
		this.k10.push(this.h10K);
		this.pk10.push(this.h10P > 0 ? Math.max(-120, 20 * Math.log10(this.h10P)) : -120);
		this.msF10.push(this.h10F / n);
		this.msH10.push(this.h10H / n);
		this.h10K = 0;
		this.h10P = 0;
		this.h10F = 0;
		this.h10H = 0;
		this.h10N = 0;
	}

	/** Pushes `n` samples of planar `channels` (missing channels are silence). */
	push(planar: readonly (Float32Array | Float64Array | undefined)[], n: number): void {
		if (this.finished) return;
		const C = this.channels;
		const count = Math.max(0, Math.floor(fin(n) ? n : 0));
		for (let i = 0; i < count; i++) {
			if (this.samples >= this.maxSamples) {
				this.truncated = true;
				return;
			}
			let m = 0;
			let amax = 0;
			let kE = 0;
			let any = false;
			for (let c = 0; c < C; c++) {
				const raw = planar[c]?.[i];
				const x = raw !== undefined && fin(raw) ? raw : 0;
				if (x !== 0) any = true;
				m += x;
				const a = x < 0 ? -x : x;
				if (a > amax) amax = a;
			}
			m /= C;
			if (!any) this.zeroRun++;
			else this.zeroRun = 0;
			// a long digital silence with settled filters: the filters output exact zeros
			const settled = this.zeroRun > 4096;
			let lo = 0;
			let hi = 0;
			if (!settled || !this.lp.quiet || !this.hp.quiet) {
				lo = this.lp.run(m);
				hi = this.hp.run(m);
			}
			for (let c = 0; c < C; c++) {
				const k = this.kw[c]!;
				if (settled && k.quiet) continue;
				const raw = planar[c]?.[i];
				const x = raw !== undefined && fin(raw) ? raw : 0;
				const y = k.run(x);
				kE += this.weights[c]! * y * y;
			}
			const al = lo < 0 ? -lo : lo;
			const ah = hi < 0 ? -hi : hi;
			if (amax > this.aFull) this.aFull = amax;
			if (al > this.aLow) this.aLow = al;
			if (ah > this.aHigh) this.aHigh = ah;
			this.aK += kE;
			this.aMsF += m * m;
			this.aMsH += hi * hi;
			this.h10N++;
			this.stft.push(m);
			this.samples++;
			if (this.samples >= this.msEnd) this.closeMs();
		}
	}

	// ── detection ─────────────────────────────────────────────────────────────────────────────────────────────────

	private maybeDetect(final: boolean): void {
		const frameMs = LISTEN_EVENTS.hopMs;
		const half = (LISTEN_EVENTS.zFrames - 1) / 2;
		const ahead = LISTEN_EVENTS.lengthCapMs + 400;
		const availMs = this.msIndex;
		const availF = this.odf.end;
		let upTo: number;
		if (final) upTo = availF;
		else {
			upTo = Math.min(availF - half - 1, Math.floor((availMs - ahead) / frameMs));
			if (upTo - this.doneFrame < LISTEN_EVENTS.chunkMs / frameMs) return;
		}
		if (upTo <= this.doneFrame) return;
		this.detectFrames(this.doneFrame, upTo, availF, availMs);
		this.doneFrame = upTo;
		const keepMs = this.doneFrame * frameMs - LISTEN_EVENTS.contextMs;
		for (const s of [this.eFull, this.eLow, this.eHigh, this.kMs]) s.dropBefore(keepMs);
		this.odf.dropBefore(this.doneFrame - half - 50);
	}

	private detectFrames(from: number, to: number, availF: number, availMs: number): void {
		const half = (LISTEN_EVENTS.zFrames - 1) / 2;
		const pick = (LISTEN_EVENTS.pickFrames - 1) / 2;
		// z floor: 2 % of the 99th percentile of the positive onset curve around the chunk
		const around = this.odf.slice(from - half, to + half);
		const pos: number[] = [];
		for (let i = 0; i < around.length; i++) if (around[i]! > 0) pos.push(around[i]!);
		const zFloor = pos.length ? 0.02 * percentile(pos, 99) : 1e-6;
		const lo = Math.max(this.odf.base, 0);
		for (let f = from; f < to; f++) {
			const v = this.odf.get(f);
			if (!(v > 0)) continue;
			let isMax = true;
			for (let k = Math.max(lo, f - pick); k <= Math.min(availF - 1, f + pick); k++)
				if (this.odf.get(k) > v) {
					isMax = false;
					break;
				}
			if (!isMax) continue;
			const w = this.odf.slice(f - half, f + half + 1);
			const med = median(w);
			for (let i = 0; i < w.length; i++) w[i] = Math.abs(w[i]! - med);
			const mad = median(w) * 1.4826;
			const z = (v - med) / (mad + zFloor + 1e-9);
			if (!(z >= LISTEN_EVENTS.zThreshold)) continue;
			const ev = this.attackEvent(f * LISTEN_EVENTS.hopMs, z, availMs);
			if (ev) {
				this.hits.push(ev);
				this.onHit?.(ev);
			}
		}
		// hints in this chunk with no onset of their own within the merge window
		const fromMs = from * LISTEN_EVENTS.hopMs;
		const toMs = to * LISTEN_EVENTS.hopMs;
		const keep: number[] = [];
		for (const h of this.hints) {
			if (h >= toMs && to < availF) {
				keep.push(h);
				continue;
			}
			if (h < fromMs - LISTEN_EVENTS.hopMs) continue;
			if (this.hits.some((e) => Math.abs(e.ms - h) < LISTEN_EVENTS.mergeMs)) continue;
			const ev = this.attackEvent(Math.round(h), 0, availMs);
			if (ev) this.hits.push({ ...ev, guided: true });
		}
		this.hints = keep;
	}

	/**
	 * Attacks (ms from the first sample) to look at even where the onset curve does not stand out — the engine passes
	 * where each clip rendered alone has its own onsets, so a sound masked in the onset curve but still rising ≥ 3 dB
	 * over its bed in some band is found (`guided`). Give them before the stream reaches them (+ 2.5 s); later ones
	 * are looked at by the next chunk or at `finish`.
	 */
	hint(ms: readonly number[]): void {
		for (const h of ms) if (fin(h) && h >= 0) this.hints.push(h);
		this.hints.sort((a, b) => a - b);
	}

	private bandSeries(b: ListenBand): Series {
		return b === 'full' ? this.eFull : b === 'low' ? this.eLow : this.eHigh;
	}

	private attack(ic: number, availMs: number): { best: Attack; timing: Attack } | null {
		const res: Attack[] = [];
		for (const band of ['full', 'low', 'high'] as const) {
			const e = this.bandSeries(band);
			const a = Math.max(e.base, ic - 15);
			const b = Math.min(availMs, ic + 50);
			if (b - a < 5) continue;
			let ip = a;
			for (let i = a; i < b; i++) if (e.get(i) > e.get(ip)) ip = i;
			const pre = e.slice(Math.max(0, ic - 160), Math.max(0, ic - 40));
			const bedRaw = pre.length >= 20 ? median(pre) : median(e.slice(e.base, ic + 250));
			const bed = Math.max(Number.isFinite(bedRaw) ? bedRaw : 0, BED_FLOOR);
			const thr = bed + 0.1 * (e.get(ip) - bed);
			let j = ip;
			const lo = Math.max(e.base, ic - 40);
			while (j > lo && e.get(j - 1) >= thr) j--;
			res.push({ ratio: e.get(ip) / bed, band, j, ip, bed });
		}
		if (!res.length) return null;
		let best = res[0]!;
		for (const r of res) if (r.ratio > best.ratio) best = r;
		const full = res.find((r) => r.band === 'full');
		const timing = full && full.ratio >= LISTEN_EVENTS.fullTimingRatio ? full : best;
		return { best, timing };
	}

	private lengthMs(e: Series, i0: number, ip: number, bed: number): number {
		const floor = Math.max(e.get(ip) * 0.1, bed * 1.41);
		const cap = LISTEN_EVENTS.lengthCapMs;
		let run = 0;
		const n = Math.min(cap, Math.max(0, e.end - ip));
		let k = n;
		for (let i = 0; i < n; i++) {
			if (e.get(ip + i) < floor) {
				run++;
				if (run === 30) {
					k = i - 29;
					break;
				}
			} else run = 0;
		}
		return Math.min(ip + k - i0, cap);
	}

	/** K-weighted level of the 10 ms window starting at ms `i` (≈ LUFS). */
	private kwDb(i: number): number {
		let e = 0;
		for (let k = i; k < i + 10; k++) e += this.kMs.get(k);
		const samples = (10 * this.sampleRate) / 1000;
		return -0.691 + 10 * Math.log10(e / samples + 1e-12);
	}

	private attackEvent(ic: number, z: number, availMs: number): ListenEvent | null {
		const att = this.attack(ic, availMs);
		if (!att) return null;
		const contrast = 20 * Math.log10(att.best.ratio);
		if (!(contrast >= LISTEN_EVENTS.minContrastDb)) return null;
		const t = att.timing;
		const length = this.lengthMs(this.bandSeries(t.band), t.j, t.ip, t.bed);
		const j = t.j;
		// prominence over the K-weighted bed
		const pre: number[] = [];
		for (let i = Math.max(this.kMs.base, j - LISTEN_EVENTS.bedFromMs); i < j - LISTEN_EVENTS.bedToMs; i++)
			pre.push(this.kwDb(i));
		let bed: number;
		if (pre.length >= 20) bed = median(pre);
		else {
			const wide: number[] = [];
			for (let i = Math.max(this.kMs.base, j - 2000); i < Math.min(this.kMs.end - 10, j + 2000); i++)
				wide.push(this.kwDb(i));
			bed = wide.length ? percentile(wide, 10) : LISTEN_EVENTS.bedFloorDb;
		}
		bed = Math.max(Number.isFinite(bed) ? bed : LISTEN_EVENTS.bedFloorDb, LISTEN_EVENTS.bedFloorDb);
		// over the event's own length (≤ 80 ms): a flicker of the bed just before a hit does not borrow its level
		let top = Number.NEGATIVE_INFINITY;
		const own = Math.max(1, Math.min(LISTEN_EVENTS.peakSearchMs, length - 9));
		for (let i = j; i < Math.min(this.kMs.end - 9, j + own); i++) {
			const v = this.kwDb(i);
			if (v > top) top = v;
		}
		const prominence = Number.isFinite(top) ? Math.max(0, top - bed) : 0;
		// the sample peak over the first 50–300 ms; where the event peaks over its whole length (≤ 2 s)
		const span = Math.max(50, Math.min(length, 300));
		let pk = 0;
		let pkAt = j;
		let top1 = 0;
		for (let i = j; i < Math.min(this.eFull.end, j + Math.max(span, length)); i++) {
			const v = this.eFull.get(i);
			if (i < j + span && v > pk) pk = v;
			if (v > top1) {
				top1 = v;
				pkAt = i;
			}
		}
		return {
			ms: j,
			peakMs: pkAt,
			shape: 'hit',
			band: att.best.band,
			prominenceDb: r1(prominence),
			bedDb: r1(bed),
			contrastDb: r1(Math.min(contrast, 60)),
			z: r1(Math.min(z, 99)),
			lengthMs: Math.max(0, Math.round(length)),
			peakDb: r1(pk > 1e-7 ? Math.max(-120, 20 * Math.log10(pk)) : -120),
			accent: false,
		};
	}

	// ── finish ────────────────────────────────────────────────────────────────────────────────────────────────────

	/** Ends the stream and returns the analysis (the same object on later calls). */
	finish(): ListenAnalysis {
		if (this.finished) return this.finished;
		this.stft.flush();
		// the last partial millisecond and 10 ms hop
		if (this.samples > Math.round((this.msIndex * this.sampleRate) / 1000)) this.closeMs();
		if (this.h10N > 0) this.closeHop10();
		this.maybeDetect(true);
		// onsets within 30 ms are one event: it starts at the first attack and has the strongest one's band, contrast,
		// prominence and peak (earshot keeps the stronger onset's time instead, which can be one inside the sound)
		const hits = this.hits.slice().sort((a, b) => a.ms - b.ms);
		const merged: ListenEvent[] = [];
		for (const e of hits) {
			const last = merged[merged.length - 1];
			if (last && e.ms - last.ms < LISTEN_EVENTS.mergeMs) {
				const end = Math.max(last.ms + last.lengthMs, e.ms + e.lengthMs);
				const strong = e.contrastDb > last.contrastDb ? e : last;
				const peak = e.peakDb > last.peakDb ? e : last;
				merged[merged.length - 1] = {
					...strong,
					ms: last.ms,
					peakMs: peak.peakMs,
					peakDb: peak.peakDb,
					prominenceDb: Math.max(last.prominenceDb, e.prominenceDb),
					z: Math.max(last.z, e.z),
					lengthMs: Math.min(LISTEN_EVENTS.lengthCapMs, end - last.ms),
				};
				continue;
			}
			merged.push(e);
		}
		const events = [...merged, ...this.swells(merged)].sort(
			(a, b) => a.ms - b.ms || (a.shape < b.shape ? -1 : 1),
		);
		const accent = accentThreshold(events);
		if (accent !== null) for (const e of events) e.accent = e.prominenceDb >= accent;
		const integrated = integratedOf(this.k10.view(), this.sampleRate / 100);
		const silences = this.silences(integrated);
		const peak = Float32Array.from(this.pk10.view());
		this.finished = {
			sampleRate: this.sampleRate,
			samples: this.samples,
			events,
			accentDb: accent === null ? null : r1(accent),
			silences,
			integratedLufs: integrated === null ? null : r1(integrated),
			hop10: {
				count: this.k10.n,
				samples: this.sampleRate / 100,
				kEnergy: this.k10.view().slice(),
				peakDb: peak,
				meanSquare: this.msF10.view().slice(),
			},
			spectrogram: this.spec
				? {
						hopMs: 10,
						bands: LISTEN_EVENTS.bands,
						frames: this.specFrames,
						fMinHz: this.stft.fMinHz,
						fMaxHz: Math.round(this.stft.fMaxHz),
						floorDb: this.stft.floorDb,
						data: this.specData.slice(0, this.specFrames * LISTEN_EVENTS.bands),
					}
				: null,
			truncated: this.truncated,
		};
		return this.finished;
	}

	/** Build-ups (see the module docs). */
	private swells(hits: readonly ListenEvent[]): ListenEvent[] {
		const n = this.msF10.n;
		if (n < 60) return [];
		const out: ListenEvent[] = [];
		const smooth = (ms: Float64Array) => {
			const r = new Float64Array(n);
			for (let i = 0; i < n; i++) r[i] = Math.max(10 * Math.log10(ms[i]! + 1e-18), -80);
			const s = new Float64Array(n);
			for (let i = 0; i < n; i++) {
				let acc = 0;
				for (let k = -4; k <= 4; k++) {
					let q = i + k;
					// reflect (half-sample symmetric, SciPy's default)
					if (q < 0) q = -q - 1;
					if (q >= n) q = 2 * n - q - 1;
					acc += r[Math.max(0, Math.min(n - 1, q))]!;
				}
				s[i] = acc / 9;
			}
			return s;
		};
		// a peak is a hit's attack only when that onset explains at least half of the rise (the onsets a rising noise
		// throws up along a riser do not)
		const hitAt = hits.map((h) => ({ t: h.ms / 1000, p: h.prominenceDb }));
		const peak10 = this.pk10.view();
		for (const [band, src] of [
			['full', this.msF10.view()],
			['high', this.msH10.view()],
		] as const) {
			const s = smooth(src);
			for (let i = 0; i < n; i++) {
				if (!(s[i]! > -70)) continue;
				let isMax = true;
				for (let k = Math.max(0, i - 15); k <= Math.min(n - 1, i + 15); k++)
					if (s[k]! > s[i]!) {
						isMax = false;
						break;
					}
				if (!isMax) continue;
				const a = Math.max(0, i - Math.round(LISTEN_EVENTS.swellMaxSec * 100));
				if (i - a < 25 || i - 15 <= a) continue;
				let j = a;
				for (let k = a; k < i - 15; k++) if (s[k]! < s[j]!) j = k;
				const rise = s[i]! - s[j]!;
				const dur = (i - j) / 100;
				const after = s.subarray(i, Math.min(n, i + 100));
				let afterMin = Number.POSITIVE_INFINITY;
				for (const v of after) if (v < afterMin) afterMin = v;
				if (
					rise < LISTEN_EVENTS.swellRiseDb ||
					dur < LISTEN_EVENTS.swellMinSec ||
					after.length < 10 ||
					s[i]! - afterMin < 4
				)
					continue;
				let up = 0;
				for (let k = j; k < i; k++) if (s[k + 1]! > s[k]!) up++;
				if (up / Math.max(1, i - j) < LISTEN_EVENTS.swellMonotone) continue;
				const t = i / 100;
				if (hitAt.some((h) => Math.abs(h.t - (t - 0.03)) < 0.05 && h.p >= Math.max(SWELL_HIT_DB, rise / 2)))
					continue;
				if (out.some((o) => Math.abs(o.ms / 1000 - t) < 0.15)) continue;
				let fall = -1;
				for (let k = 0; k < after.length; k++)
					if (after[k]! < s[i]! - 10) {
						fall = k;
						break;
					}
				let pk = -120;
				for (let k = i; k < Math.min(n, i + 5); k++) if (peak10[k]! > pk) pk = peak10[k]!;
				out.push({
					ms: i * 10,
					peakMs: i * 10,
					shape: 'swell',
					band,
					prominenceDb: r1(rise),
					bedDb: r1(s[j]!),
					contrastDb: r1(rise),
					z: 0,
					lengthMs: fall >= 0 ? fall * 10 : 1000,
					peakDb: r1(pk),
					riseMs: Math.round(dur * 1000),
					accent: false,
				});
			}
		}
		return out;
	}

	/** Silences and drops of the fast loudness (see the module docs). */
	private silences(integrated: number | null): ListenSilence[] {
		const k = this.k10.view();
		const n = k.length;
		const hopSamples = this.sampleRate / 100;
		if (this.samples < this.sampleRate / 2 || n < 10) return [];
		// fast loudness: 100 ms windows every 50 ms, centred at (5m + 5) hops
		const F: number[] = [];
		const T: number[] = [];
		for (let s = 0; s + 10 <= n; s += 5) {
			let e = 0;
			for (let i = s; i < s + 10; i++) e += k[i]!;
			const l = e > 0 ? -0.691 + 10 * Math.log10(e / (10 * hopSamples)) : -70;
			F.push(Math.max(l, -70));
			T.push((s + 5) / 100);
		}
		const m = F.length;
		const thr =
			integrated === null || integrated <= -60
				? -70
				: Math.max(LISTEN_EVENTS.silenceFloorLufs, integrated - LISTEN_EVENTS.silenceUnderLu);
		const low = F.map((v) => (integrated === null ? v <= thr : v < thr));
		// binary closing with a 7-wide element on an edge-padded mask, then kept only where within 6 LU of the threshold
		const padded = [low[0]!, low[0]!, low[0]!, ...low, low[m - 1]!, low[m - 1]!, low[m - 1]!];
		const dil = padded.map((_, i) => {
			for (let q = i - 3; q <= i + 3; q++)
				if (padded[Math.max(0, Math.min(padded.length - 1, q))]) return true;
			return false;
		});
		const ero = dil.map((_, i) => {
			for (let q = i - 3; q <= i + 3; q++) if (!dil[Math.max(0, Math.min(dil.length - 1, q))]) return false;
			return true;
		});
		const mask = low.map((_, i) => ero[i + 3]! && F[i]! < thr + 6);
		const durSec = this.samples / this.sampleRate;
		const out: ListenSilence[] = [];
		const minRun = Math.max(1, Math.round(LISTEN_EVENTS.silenceMinSec / 0.05));
		for (let i = 0; i < m; ) {
			if (!mask[i]) {
				i++;
				continue;
			}
			let e = i;
			while (e < m && mask[e]) e++;
			if (e - i >= minRun) {
				let a = Math.max(0, T[i]! - 0.05);
				let b = Math.min(durSec, T[e - 1]! + 0.05);
				if (i === 0) a = 0;
				if (e === m) b = durSec;
				let pk = -120;
				for (let h = Math.round(a * 100); h < Math.min(this.pk10.n, Math.round(b * 100)); h++)
					pk = Math.max(pk, this.pk10.f64[h]!);
				let maxF = -70;
				let sum = 0;
				for (let q = i; q < e; q++) {
					maxF = Math.max(maxF, F[q]!);
					sum += F[q]!;
				}
				out.push({
					startMs: Math.round(a * 1000),
					endMs: Math.round(b * 1000),
					kind: pk < -100 ? 'digital silence' : maxF < -60 ? 'near silence' : 'drop',
					levelLufs: r1(sum / (e - i)),
					atStart: a <= 0.05,
					atEnd: b >= durSec - 0.05,
				});
			}
			i = e;
		}
		return out;
	}
}

/** BS.1770 gated integrated loudness from 10 ms K-weighted energy sums (`hopSamples` samples each); null when gated out. */
export function integratedOf(kEnergy: ArrayLike<number>, hopSamples: number): number | null {
	const n = kEnergy.length;
	if (n < 40 || !(hopSamples > 0)) return null;
	const blocks: number[] = [];
	for (let s = 0; s + 40 <= n; s += 10) {
		let e = 0;
		for (let i = s; i < s + 40; i++) e += fin(kEnergy[i]!) ? kEnergy[i]! : 0;
		blocks.push(e / (40 * hopSamples));
	}
	const lufs = (e: number) => (e > 0 ? -0.691 + 10 * Math.log10(e) : Number.NEGATIVE_INFINITY);
	const abs = blocks.filter((e) => lufs(e) > -70);
	if (!abs.length) return null;
	const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
	const gated = abs.filter((e) => lufs(e) > rel);
	if (!gated.length) return null;
	return lufs(gated.reduce((a, b) => a + b, 0) / gated.length);
}

/** The accent threshold of a list of events: max(6 dB, the 80th percentile of prominence); null for none. */
export function accentThreshold(events: readonly Pick<ListenEvent, 'prominenceDb'>[]): number | null {
	if (!events.length) return null;
	return Math.max(
		LISTEN_EVENTS.accentDb,
		percentile(
			events.map((e) => e.prominenceDb),
			80,
		),
	);
}

// ── sync ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type SyncStatus = 'ok' | 'near' | 'swell' | 'none';

export type PictureAnswer = {
	status: SyncStatus;
	/** Index into the events of the one that answers (null: none). */
	event: number | null;
	/** Sound − picture (ms; negative = the sound is early); null for none. */
	offsetMs: number | null;
	/** Which moment of the event answers: its attack, or its peak (a whoosh peaks on its cut long after its attack). */
	at: 'attack' | 'peak' | null;
	/** Unanswered: the nearest strong onset within 250 ms (sound − picture, ms), else null. */
	nearestStrongMs: number | null;
};

/** earshot's "strong" onsets: prominence ≥ min(6 dB, the 40th percentile). */
export function strongThreshold(events: readonly Pick<ListenEvent, 'prominenceDb'>[]): number {
	if (!events.length) return Number.POSITIVE_INFINITY;
	return Math.min(
		6,
		percentile(
			events.map((e) => e.prominenceDb),
			40,
		),
	);
}

/** The position in `ts` (sorted) nearest to `t` within `radius`, or null. */
function nearestAt(ts: readonly number[], t: number, radius: number): number | null {
	if (!ts.length) return null;
	let lo = 0;
	let hi = ts.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (ts[mid]! < t) lo = mid + 1;
		else hi = mid;
	}
	let best: number | null = null;
	for (const j of [lo - 1, lo, lo + 1])
		if (j >= 0 && j < ts.length && Math.abs(ts[j]! - t) <= radius + 1e-9)
			if (best === null || Math.abs(ts[j]! - t) < Math.abs(ts[best]! - t)) best = j;
	return best;
}
function nearestIn(ts: readonly number[], idx: readonly number[], t: number, radius: number): number | null {
	const j = nearestAt(ts, t, radius);
	return j === null ? null : idx[j]!;
}

/** Times of events (sorted): each event's attack and, when it differs, its peak, with the event's index. */
export type SyncTimes = { t: number[]; i: number[]; peak: boolean[] };

/** Event lists prepared for answering many picture events. */
export type SyncIndex = {
	events: readonly ListenEvent[];
	all: SyncTimes;
	strong: SyncTimes;
	swells: SyncTimes;
	accents: SyncTimes;
};

export function syncIndex(events: readonly ListenEvent[]): SyncIndex {
	const strongDb = strongThreshold(events);
	// an event answers at its attack or at its peak (sounds are placed by their peak: a whoosh peaks on its cut)
	const sel = (p: (e: ListenEvent) => boolean): SyncTimes => {
		const list: { t: number; i: number; peak: boolean }[] = [];
		events.forEach((e, i) => {
			if (!p(e)) return;
			list.push({ t: e.ms, i, peak: false });
			if (fin(e.peakMs) && Math.abs(e.peakMs - e.ms) > 0.5) list.push({ t: e.peakMs, i, peak: true });
		});
		list.sort((a, b) => a.t - b.t || a.i - b.i);
		return { t: list.map((x) => x.t), i: list.map((x) => x.i), peak: list.map((x) => x.peak) };
	};
	const audible = (e: ListenEvent) => e.prominenceDb >= LISTEN_SYNC.minProminenceDb;
	return {
		events,
		all: sel(audible),
		strong: sel((e) => audible(e) && e.prominenceDb >= strongDb),
		swells: sel((e) => audible(e) && e.shape === 'swell'),
		accents: sel((e) => audible(e) && e.accent),
	};
}

/**
 * The event that answers a picture event at `tMs` (earshot's ladder): any event within one frame (OK); else the
 * nearest strong one within 100 ms, else any within 100 ms (near); else a swell peaking within 300 ms (swell); else
 * none, naming a strong onset within 250 ms.
 */
export function answerPictureEvent(ix: SyncIndex, tMs: number, frameMs: number): PictureAnswer {
	const tol = fin(frameMs) && frameMs > 0 ? frameMs : LISTEN_SYNC.defaultFrameMs;
	const steps: [SyncTimes, number, SyncStatus][] = [
		[ix.all, tol, 'ok'],
		[ix.strong, LISTEN_SYNC.nearMs, 'near'],
		[ix.all, LISTEN_SYNC.nearMs, 'near'],
		[ix.swells, LISTEN_SYNC.swellMs, 'swell'],
	];
	for (const [list, radius, status] of steps) {
		const j = nearestAt(list.t, tMs, radius);
		if (j !== null)
			return {
				status,
				event: list.i[j]!,
				offsetMs: r1(list.t[j]! - tMs),
				at: list.peak[j] ? 'peak' : 'attack',
				nearestStrongMs: null,
			};
	}
	const off = nearestAt(ix.strong.t, tMs, LISTEN_SYNC.offMs);
	return {
		status: 'none',
		event: null,
		offsetMs: null,
		at: null,
		nearestStrongMs: off === null ? null : r1(ix.strong.t[off]! - tMs),
	};
}

/**
 * The chance level of a sync share: the fraction of times in `[loMs, hiMs]` within `tolMs` of one of `ts` — the measure
 * of the union of the windows `[t − tol, t + tol]` over the span, divided by the span. 0 for no times or an empty span.
 */
export function syncChance(ts: readonly number[], loMs: number, hiMs: number, tolMs: number): number {
	if (!(hiMs > loMs) || !ts.length || !(tolMs >= 0)) return 0;
	const iv = ts
		.filter(fin)
		.map((t) => [Math.max(loMs, t - tolMs), Math.min(hiMs, t + tolMs)] as const)
		.filter(([a, b]) => b > a)
		.sort((a, b) => a[0] - b[0]);
	let covered = 0;
	let curA = Number.NaN;
	let curB = Number.NaN;
	for (const [a, b] of iv) {
		if (Number.isNaN(curA)) {
			curA = a;
			curB = b;
		} else if (a <= curB) curB = Math.max(curB, b);
		else {
			covered += curB - curA;
			curA = a;
			curB = b;
		}
	}
	if (!Number.isNaN(curA)) covered += curB - curA;
	return Math.min(1, covered / (hiMs - loMs));
}

export type SyncStats = {
	n: number;
	ok: number;
	near: number;
	swell: number;
	none: number;
	/** Shares (0…1) and what random times would score (chance) with the same events. */
	okShare: number;
	okChance: number;
	within100Share: number;
	within100Chance: number;
	/** The same for accents only (null without accents). */
	accentOkShare: number | null;
	accentOkChance: number | null;
	accent100Share: number | null;
	accent100Chance: number | null;
	/** Picture events within 50 ms of a beat, and its chance (null without beats). */
	onBeatShare: number | null;
	onBeatChance: number | null;
	medianAbsOffsetMs: number | null;
	/** Tolerance of OK (ms: one frame). */
	frameMs: number;
	/** The span the chance levels are taken over (ms): the picture events ± 1 s. */
	spanMs: [number, number];
};

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Sync shares of picture events at `timesMs` with their answers, and the chance of each (see the module docs). */
export function syncStats(
	ix: SyncIndex,
	timesMs: readonly number[],
	answers: readonly PictureAnswer[],
	frameMs: number,
	beatsMs?: readonly number[] | null,
): SyncStats | null {
	const n = Math.min(timesMs.length, answers.length);
	if (n === 0) return null;
	const tol = fin(frameMs) && frameMs > 0 ? frameMs : LISTEN_SYNC.defaultFrameMs;
	const lo = Math.min(...timesMs.slice(0, n)) - 1000;
	const hi = Math.max(...timesMs.slice(0, n)) + 1000;
	const count = (s: SyncStatus) => answers.slice(0, n).filter((a) => a.status === s).length;
	const ok = count('ok');
	const near = count('near');
	const offs = answers
		.slice(0, n)
		.filter((a) => a.status === 'ok' || a.status === 'near')
		.map((a) => Math.abs(a.offsetMs ?? 0));
	const acc = ix.accents.t;
	const accentOff = timesMs.slice(0, n).map((t) => {
		const j = nearestAt(acc, t, LISTEN_SYNC.nearMs);
		return j === null ? Number.POSITIVE_INFINITY : Math.abs(acc[j]! - t);
	});
	let onBeatShare: number | null = null;
	let onBeatChance: number | null = null;
	const beats = (beatsMs ?? [])
		.filter(fin)
		.slice()
		.sort((a, b) => a - b);
	if (beats.length > 1) {
		const idx = beats.map((_, i) => i);
		onBeatShare = r3(
			timesMs.slice(0, n).filter((t) => nearestIn(beats, idx, t, LISTEN_SYNC.onBeatMs) !== null).length / n,
		);
		onBeatChance = r3(syncChance(beats, lo, hi, LISTEN_SYNC.onBeatMs));
	}
	return {
		n,
		ok,
		near,
		swell: count('swell'),
		none: count('none'),
		okShare: r3(ok / n),
		okChance: r3(syncChance(ix.all.t, lo, hi, tol)),
		within100Share: r3((ok + near) / n),
		within100Chance: r3(syncChance(ix.all.t, lo, hi, LISTEN_SYNC.nearMs)),
		accentOkShare: acc.length ? r3(accentOff.filter((d) => d <= tol + 1e-6).length / n) : null,
		accentOkChance: acc.length ? r3(syncChance(acc, lo, hi, tol)) : null,
		accent100Share: acc.length ? r3(accentOff.filter((d) => d <= LISTEN_SYNC.nearMs).length / n) : null,
		accent100Chance: acc.length ? r3(syncChance(acc, lo, hi, LISTEN_SYNC.nearMs)) : null,
		onBeatShare,
		onBeatChance,
		medianAbsOffsetMs: offs.length ? r1(median(offs)) : null,
		frameMs: r1(tol),
		spanMs: [r1(lo), r1(hi)],
	};
}
