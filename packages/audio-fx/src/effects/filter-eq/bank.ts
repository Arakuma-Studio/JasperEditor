// A bank of smoothed biquad bands shared by every equaliser of the family (port of filmcraft `effects/eq.rs`
// `BandBank`): per-band frequency (log2), gain, Q and an on/off cross-fade glide over 30 ms; coefficients are
// redesigned at most every 16 samples while a band glides (counted per sample, so block-size independent).
import { designBiquad, type FilterType, magnitudeDb } from '../../core/biquad.ts';
import { flush } from '../../core/math.ts';
import { Smoothed } from '../../core/smooth.ts';

/** Coefficients are recomputed at most every this many samples while parameters glide. */
const COEFF_INTERVAL = 16;
/** Samples per band-major chunk while settled. */
const CHUNK = 256;
export const SMOOTH_MS = 30;
/** Most bands a bank can hold. */
export const MAX_BANDS = 40;

/** Band kinds: the RBJ cookbook types plus first-order (6 dB/oct) Butterworth pass sections. */
export type BandKind = FilterType | 'lowPass1' | 'highPass1';

/** Normalised coefficients of a band: `[b0, b1, b2, a1, a2]` written into `out` at `o`. */
export function designBand(
	kind: BandKind,
	sampleRate: number,
	freq: number,
	q: number,
	gainDb: number,
	out: Float64Array,
	o: number,
): void {
	if (kind === 'lowPass1' || kind === 'highPass1') {
		// Bilinear transform of 1/(s + 1) (low-pass) or s/(s + 1) (high-pass), pre-warped to `freq`.
		const f = Math.min(Math.max(freq, 1), sampleRate * 0.49);
		const k = Math.tan((Math.PI * f) / sampleRate);
		const n = 1 / (k + 1);
		out[o] = kind === 'lowPass1' ? k * n : n;
		out[o + 1] = kind === 'lowPass1' ? k * n : -n;
		out[o + 2] = 0;
		out[o + 3] = (k - 1) * n;
		out[o + 4] = 0;
		return;
	}
	const c = designBiquad(kind, sampleRate, freq, q, gainDb);
	out[o] = c.b0;
	out[o + 1] = c.b1;
	out[o + 2] = c.b2;
	out[o + 3] = c.a1;
	out[o + 4] = c.a2;
}

const scratch = new Float64Array(5);

/** Analytic magnitude (dB) of one band design. */
export function bandDb(
	kind: BandKind,
	sampleRate: number,
	freq: number,
	q: number,
	gainDb: number,
	at: number,
): number {
	designBand(kind, sampleRate, freq, q, gainDb, scratch, 0);
	return magnitudeDb(
		{ b0: scratch[0]!, b1: scratch[1]!, b2: scratch[2]!, a1: scratch[3]!, a2: scratch[4]! },
		at,
		sampleRate,
	);
}

/** Q of a peaking band `octaves` wide (between the −3 dB points of the analog prototype). */
export function qForOctaves(octaves: number): number {
	const p = 2 ** octaves;
	return Math.sqrt(p) / (p - 1);
}

/**
 * Q of second-order section `k` (0-based, lowest Q first, `k` < ⌊n/2⌋) of an order-`n` Butterworth cascade: the
 * conjugate pole pair at angle φ = π(n − 2⌊n/2⌋ + 2k + 1)/(2n) from the negative real axis has Q = 1/(2 cos φ)
 * (odd orders add a first-order section for the real pole).
 */
export function butterworthQ(n: number, k: number): number {
	return 1 / (2 * Math.cos((Math.PI * (n - 2 * Math.floor(n / 2) + 2 * k + 1)) / (2 * n)));
}

export class BandBank {
	readonly kinds: BandKind[];
	private readonly freq: Smoothed[] = [];
	private readonly gain: Smoothed[] = [];
	private readonly q: Smoothed[] = [];
	private readonly mix: Smoothed[] = [];
	/** `[b0 b1 b2 a1 a2]` per band. */
	private readonly coef: Float64Array;
	/** 1 when the band's coefficients are an exact identity (b = a): skipped once its state has decayed to 0. */
	private readonly identity: Uint8Array;
	private readonly dirty: Uint8Array;
	private readonly mixes: Float64Array;
	private readonly tmp = new Float64Array(CHUNK);
	/** `[s1 s2]` per channel per band. */
	private readonly state: Float64Array;
	private readonly nch: number;
	private counter = 0;
	/** Samples until every smoother has reached its target (0 = settled: the per-band ticks are skipped). */
	private glide = 0;
	private readonly rampSamples: number;

	constructor(
		readonly sampleRate: number,
		channels: number,
		readonly bands: number,
	) {
		if (bands > MAX_BANDS) throw new Error('BandBank: too many bands');
		this.nch = Math.max(1, channels);
		this.kinds = new Array<BandKind>(bands).fill('peaking');
		for (let i = 0; i < bands; i++) {
			this.freq.push(Smoothed.withMs(Math.log2(1000), sampleRate, SMOOTH_MS));
			this.gain.push(Smoothed.withMs(0, sampleRate, SMOOTH_MS));
			this.q.push(Smoothed.withMs(1, sampleRate, SMOOTH_MS));
			this.mix.push(Smoothed.withMs(0, sampleRate, SMOOTH_MS));
		}
		this.coef = new Float64Array(5 * bands);
		for (let i = 0; i < bands; i++) this.coef[5 * i] = 1;
		this.identity = new Uint8Array(bands).fill(1);
		this.dirty = new Uint8Array(bands).fill(1);
		this.mixes = new Float64Array(bands);
		this.state = new Float64Array(2 * bands * this.nch);
		this.rampSamples = Math.round((sampleRate * SMOOTH_MS) / 1000);
	}

	setBand(
		i: number,
		on: boolean,
		kind: BandKind,
		freq: number,
		gain: number,
		q: number,
		snap: boolean,
	): void {
		this.kinds[i] = kind;
		this.freq[i]!.set(Math.log2(Math.max(freq, 1)));
		this.gain[i]!.set(gain);
		this.q[i]!.set(q);
		this.mix[i]!.set(on ? 1 : 0);
		if (snap) {
			this.freq[i]!.snap();
			this.gain[i]!.snap();
			this.q[i]!.snap();
			this.mix[i]!.snap();
			this.mixes[i] = this.mix[i]!.value();
		} else this.glide = this.rampSamples + 1;
		this.dirty[i] = 1;
	}

	updateCoeffs(force: boolean): void {
		const c = this.coef;
		for (let i = 0; i < this.bands; i++) {
			if (!this.dirty[i] && !force) continue;
			const f = this.freq[i]!;
			const g = this.gain[i]!;
			const q = this.q[i]!;
			designBand(this.kinds[i]!, this.sampleRate, 2 ** f.value(), q.value(), g.value(), c, 5 * i);
			const o = 5 * i;
			this.identity[i] = c[o] === 1 && c[o + 1] === c[o + 3] && c[o + 2] === c[o + 4] ? 1 : 0;
			this.dirty[i] = f.isSmoothing() || g.isSmoothing() || q.isSmoothing() ? 1 : 0;
		}
	}

	reset(): void {
		for (let i = 0; i < this.bands; i++) {
			this.freq[i]!.snap();
			this.gain[i]!.snap();
			this.q[i]!.snap();
			this.mix[i]!.snap();
			this.mixes[i] = this.mix[i]!.value();
			this.dirty[i] = 1;
		}
		this.state.fill(0);
		this.counter = 0;
		this.glide = 0;
		this.updateCoeffs(true);
	}

	/** Whether band `i` is (heading to) on. */
	isOn(i: number): boolean {
		return this.mix[i]!.target() >= 0.5;
	}

	/** Analytic magnitude (dB) of the whole bank at its target settings. */
	responseDb(freq: number): number {
		let db = 0;
		for (let i = 0; i < this.bands; i++) {
			if (this.mix[i]!.target() < 0.5) continue;
			db += bandDb(
				this.kinds[i]!,
				this.sampleRate,
				2 ** this.freq[i]!.target(),
				this.q[i]!.target(),
				this.gain[i]!.target(),
				freq,
			);
		}
		return db;
	}

	private tickSmoothers(): void {
		for (let b = 0; b < this.bands; b++) {
			const f = this.freq[b]!;
			const g = this.gain[b]!;
			const q = this.q[b]!;
			f.tick();
			g.tick();
			q.tick();
			if (f.isSmoothing() || g.isSmoothing() || q.isSmoothing()) this.dirty[b] = 1;
			this.mixes[b] = this.mix[b]!.tick();
		}
	}

	/** True when nothing glides: coefficients, mixes and the output gain are constant until the next change. */
	private settled(out: Smoothed): boolean {
		if (this.glide > 0 || out.isSmoothing()) return false;
		for (let b = 0; b < this.bands; b++) if (this.dirty[b]) return false;
		return true;
	}

	/**
	 * Processes `[start, end)` in place; `out` (linear output gain) is applied per sample. While settled the bands run
	 * band-major over chunks (f64 scratch, same arithmetic as the per-sample path, so the output is bit-identical);
	 * while anything glides, sample by sample.
	 */
	process(channels: readonly Float32Array[], start: number, end: number, out: Smoothed): void {
		let i = start;
		while (i < end) {
			if (this.settled(out)) {
				const len = Math.min(end - i, CHUNK);
				this.processSettled(channels, i, i + len, out.value());
				this.counter = (this.counter + len) % COEFF_INTERVAL;
				i += len;
			} else {
				// Run per sample until the next coefficient update (where the bank may settle).
				const stop = Math.min(end, i + COEFF_INTERVAL - this.counter);
				this.processGliding(channels, i, stop, out);
				i = stop;
			}
		}
	}

	private processSettled(channels: readonly Float32Array[], start: number, end: number, gain: number): void {
		const nb = this.bands;
		const nch = Math.min(channels.length, this.nch);
		const c = this.coef;
		const st = this.state;
		const tmp = this.tmp;
		const len = end - start;
		for (let ch = 0; ch < nch; ch++) {
			const buf = channels[ch]!;
			for (let k = 0; k < len; k++) tmp[k] = buf[start + k]!;
			let so = 2 * nb * ch;
			for (let b = 0; b < nb; b++, so += 2) {
				const m = this.mixes[b]!;
				if (m > 0) {
					if (this.identity[b] && st[so] === 0 && st[so + 1] === 0) continue;
					const o = 5 * b;
					const b0 = c[o]!;
					const b1 = c[o + 1]!;
					const b2 = c[o + 2]!;
					const a1 = c[o + 3]!;
					const a2 = c[o + 4]!;
					let s1 = st[so]!;
					let s2 = st[so + 1]!;
					for (let k = 0; k < len; k++) {
						const x = tmp[k]!;
						const y = b0 * x + s1;
						const v1 = b1 * x - a1 * y + s2;
						const v2 = b2 * x - a2 * y;
						s1 = v1 > -1e-30 && v1 < 1e-30 ? 0 : v1;
						s2 = v2 > -1e-30 && v2 < 1e-30 ? 0 : v2;
						tmp[k] = x + m * (y - x);
					}
					st[so] = s1;
					st[so + 1] = s2;
				} else {
					st[so] = 0;
					st[so + 1] = 0;
				}
			}
			for (let k = 0; k < len; k++) buf[start + k] = tmp[k]! * gain;
		}
	}

	private processGliding(channels: readonly Float32Array[], start: number, end: number, out: Smoothed): void {
		const nb = this.bands;
		const nch = Math.min(channels.length, this.nch);
		const c = this.coef;
		const st = this.state;
		const mixes = this.mixes;
		const ident = this.identity;
		for (let i = start; i < end; i++) {
			if (this.counter === 0) this.updateCoeffs(false);
			this.counter = (this.counter + 1) % COEFF_INTERVAL;
			// Settled smoothers return their value unchanged: skip the ticks (and keep `mixes`) until a change.
			if (this.glide > 0) {
				this.glide--;
				this.tickSmoothers();
			}
			const gain = out.tick();
			for (let ch = 0; ch < nch; ch++) {
				const buf = channels[ch]!;
				let x = buf[i]!;
				let so = 2 * nb * ch;
				for (let b = 0; b < nb; b++, so += 2) {
					const m = mixes[b]!;
					if (m > 0) {
						// An identity section with a settled (zero) state outputs its input exactly: skip it.
						if (ident[b] && st[so] === 0 && st[so + 1] === 0) continue;
						const o = 5 * b;
						const y = c[o]! * x + st[so]!;
						st[so] = flush(c[o + 1]! * x - c[o + 3]! * y + st[so + 1]!);
						st[so + 1] = flush(c[o + 2]! * x - c[o + 4]! * y);
						x += m * (y - x);
					} else {
						st[so] = 0;
						st[so + 1] = 0;
					}
				}
				buf[i] = x * gain;
			}
		}
	}
}
