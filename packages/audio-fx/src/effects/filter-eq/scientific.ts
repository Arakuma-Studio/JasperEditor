// Scientific Filter (port of filmcraft `effects/filters.rs` ScientificFilter): classical IIR designs
// (`core/design.ts`: Bessel / Butterworth / Chebyshev I / elliptic) as a cascade of biquads. Cutoff changes glide
// (redesigned every 32 samples while moving, counted per sample) and the coefficients are interpolated sample by sample
// from one design to the next (sound-design Phase 4 WP4.2a: a keyframed build swept 2 kHz → 20 Hz in one frame clicked
// at ≈ −38 dB when the coefficients jumped every 32 samples); type/order/ripple changes switch immediately.
import {
	type Band,
	type Family,
	MAX_SECTIONS,
	type Prototype,
	prototype,
	realize,
	Sections,
} from '../../core/design.ts';
import { EffectBase } from '../../core/effect.ts';
import { dbToGain, flush } from '../../core/math.ts';
import { Smoothed } from '../../core/smooth.ts';
import { SMOOTH_MS } from './bank.ts';

const FAMILIES: readonly Family[] = ['bessel', 'butterworth', 'chebyshev', 'elliptic'];
const BANDS: readonly Band[] = ['lowPass', 'highPass', 'bandPass', 'bandStop'];
const REDESIGN_INTERVAL = 32;
/** Samples per section-major chunk while settled. */
const CHUNK = 256;

export class ScientificFilter extends EffectBase {
	private protoKey = '';
	private proto: Prototype;
	private band: Band = 'lowPass';
	/** log2 cutoffs (smoothed so automation glides). */
	private readonly f1: Smoothed;
	private readonly f2: Smoothed;
	private readonly gain: Smoothed;
	private readonly sections = new Sections();
	private readonly target = new Sections();
	/** The coefficient ramp (gliding): from the design in use to the next one over `REDESIGN_INTERVAL` samples. */
	private readonly rampFrom = new Sections();
	private readonly rampTo = new Sections();
	private ramp = 0;
	/** What the sections in use (or ramped to) were designed for. */
	private designed = { key: '', f1: Number.NaN, f2: Number.NaN, band: '' };
	/** `[s1 s2]` per section per channel. */
	private readonly state: Float64Array;
	private readonly nch: number;
	private readonly tmp = new Float64Array(CHUNK);
	private counter = 0;
	private dirty = true;

	constructor(sampleRate: number, channels: number) {
		super('jasper.audio.scientific-filter', sampleRate, channels);
		this.nch = Math.max(1, channels);
		this.proto = prototype('butterworth', 1, 1, 60);
		this.f1 = Smoothed.withMs(10, sampleRate, SMOOTH_MS);
		this.f2 = Smoothed.withMs(12, sampleRate, SMOOTH_MS);
		this.gain = Smoothed.withMs(1, sampleRate, SMOOTH_MS);
		this.state = new Float64Array(2 * MAX_SECTIONS * this.nch);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		const pv = this.pv;
		const fam = FAMILIES[Math.min(pv.idx('type'), 3)]!;
		const order = Math.round(pv.v('order'));
		const key = `${fam}/${order}/${pv.v('ripple')}/${pv.v('stopAtten')}`;
		if (key !== this.protoKey) {
			this.protoKey = key;
			this.proto = prototype(fam, order, pv.v('ripple'), pv.v('stopAtten'));
		}
		this.band = BANDS[Math.min(pv.idx('mode'), 3)]!;
		this.f1.set(Math.log2(pv.v('cutoff')));
		this.f2.set(Math.log2(pv.v('highCutoff')));
		this.gain.set(dbToGain(pv.v('gain')));
		this.dirty = true;
		if (snap) {
			this.f1.snap();
			this.f2.snap();
			this.gain.snap();
			this.redesign();
		}
	}

	private redesign(): void {
		const before = this.sections.n;
		this.ramp = 0;
		this.designed = { key: this.protoKey, f1: this.f1.value(), f2: this.f2.value(), band: this.band };
		realize(
			this.proto,
			this.band,
			2 ** this.f1.value(),
			2 ** this.f2.value(),
			this.sampleRate,
			this.sections,
		);
		// Sections that come (back) into use after an order change start from silence, not from the state they
		// had when they were last used.
		for (let ch = 0; ch < this.nch; ch++)
			for (let k = before; k < this.sections.n; k++) {
				const so = 2 * MAX_SECTIONS * ch + 2 * k;
				this.state[so] = 0;
				this.state[so + 1] = 0;
			}
		this.dirty = this.f1.isSmoothing() || this.f2.isSmoothing();
	}

	/**
	 * The next design while gliding: the same prototype and band with as many sections → a coefficient ramp to it over
	 * the next `REDESIGN_INTERVAL` samples; anything else switches at once (`redesign`).
	 */
	private nextDesign(): void {
		if (this.protoKey !== this.designed.key || this.band !== this.designed.band) {
			this.redesign();
			this.dirty = true; // settle again at the glide's end
			return;
		}
		const f1 = this.f1.value();
		const f2 = this.f2.value();
		realize(this.proto, this.band, 2 ** f1, 2 ** f2, this.sampleRate, this.rampTo);
		if (this.rampTo.n !== this.sections.n) {
			this.redesign();
			return;
		}
		this.designed = { key: this.protoKey, f1, f2, band: this.band };
		this.rampFrom.copyFrom(this.sections);
		this.ramp = REDESIGN_INTERVAL;
	}

	/** Advances the coefficient ramp by one sample. */
	private stepRamp(): void {
		this.ramp--;
		const c = this.sections.c;
		const a = this.rampFrom.c;
		const b = this.rampTo.c;
		const m = 5 * this.sections.n;
		if (this.ramp <= 0) {
			for (let k = 0; k < m; k++) c[k] = b[k]!;
			return;
		}
		const u = 1 - this.ramp / REDESIGN_INTERVAL;
		for (let k = 0; k < m; k++) c[k] = a[k]! + (b[k]! - a[k]!) * u;
	}

	/** The designed cascade at the target settings. */
	targetSections(): Sections {
		return realize(
			this.proto,
			this.band,
			this.pv.v('cutoff'),
			this.pv.v('highCutoff'),
			this.sampleRate,
			this.target,
		);
	}

	responseDb(freq: number): number {
		return this.targetSections().magnitudeDb(freq, this.sampleRate) + this.pv.v('gain');
	}

	reset(): void {
		this.f1.snap();
		this.f2.snap();
		this.gain.snap();
		this.state.fill(0);
		this.counter = 0;
		this.redesign();
	}

	/**
	 * While nothing glides the sections run section-major over chunks (f64 scratch, same arithmetic as the per-sample
	 * path, so the output is bit-identical); while a cutoff or the gain glides, sample by sample.
	 */
	process(channels: readonly Float32Array[], start: number, end: number): void {
		let i = start;
		while (i < end) {
			if (
				!this.dirty &&
				this.ramp === 0 &&
				!this.f1.isSmoothing() &&
				!this.f2.isSmoothing() &&
				!this.gain.isSmoothing()
			) {
				const len = Math.min(end - i, CHUNK);
				this.processSettled(channels, i, i + len);
				this.counter = (this.counter + len) % REDESIGN_INTERVAL;
				i += len;
			} else {
				const stop = Math.min(end, i + REDESIGN_INTERVAL - this.counter);
				this.processGliding(channels, i, stop);
				i = stop;
			}
		}
	}

	private processSettled(channels: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(channels.length, this.nch);
		const st = this.state;
		const c = this.sections.c;
		const ns = this.sections.n;
		const g = this.gain.value();
		const tmp = this.tmp;
		const len = end - start;
		for (let ch = 0; ch < nch; ch++) {
			const buf = channels[ch]!;
			for (let k = 0; k < len; k++) tmp[k] = buf[start + k]!;
			let so = 2 * MAX_SECTIONS * ch;
			for (let s = 0; s < ns; s++, so += 2) {
				const o = 5 * s;
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
					tmp[k] = y;
				}
				st[so] = s1;
				st[so + 1] = s2;
			}
			for (let k = 0; k < len; k++) buf[start + k] = tmp[k]! * g;
		}
	}

	private processGliding(channels: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(channels.length, this.nch);
		const st = this.state;
		const c = this.sections.c;
		for (let i = start; i < end; i++) {
			if (this.counter === 0 && this.dirty) {
				// a ramp to the design at the current cutoffs, unless the sections in use already are it
				const moving = this.f1.isSmoothing() || this.f2.isSmoothing();
				const stale =
					this.f1.value() !== this.designed.f1 ||
					this.f2.value() !== this.designed.f2 ||
					this.protoKey !== this.designed.key ||
					this.band !== this.designed.band;
				if (stale) this.nextDesign();
				this.dirty = moving || stale;
			}
			this.counter = (this.counter + 1) % REDESIGN_INTERVAL;
			if (this.ramp > 0) this.stepRamp();
			this.f1.tick();
			this.f2.tick();
			if (this.f1.isSmoothing() || this.f2.isSmoothing()) this.dirty = true;
			const g = this.gain.tick();
			const ns = this.sections.n;
			for (let ch = 0; ch < nch; ch++) {
				const buf = channels[ch]!;
				let x = buf[i]!;
				let so = 2 * MAX_SECTIONS * ch;
				for (let s = 0; s < ns; s++, so += 2) {
					const o = 5 * s;
					const y = c[o]! * x + st[so]!;
					st[so] = flush(c[o + 1]! * x - c[o + 3]! * y + st[so + 1]!);
					st[so + 1] = flush(c[o + 2]! * x - c[o + 4]! * y);
					x = y;
				}
				buf[i] = x * g;
			}
		}
	}
}
