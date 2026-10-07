// DeEsser and Enhance Speech (ported from filmcraft `effects/essential.rs`).
import { Biquad, type Coeffs, designBiquad, IDENTITY } from '../../core/biquad.ts';
import { EffectBase } from '../../core/effect.ts';
import { flush } from '../../core/math.ts';
import { Smoothed } from '../../core/smooth.ts';
import { coef } from '../../core/util.ts';

const powDb = (p: number) => 10 * Math.log10(p + 1e-20);

/**
 * DeEsser: a 2nd-order high-pass side chain at Frequency detects sibilance (the band level exceeds the broadband
 * level by more than Threshold); the band above Frequency is then cut by a dynamic RBJ high shelf whose gain follows
 * the gain reduction (attack ≈ 1 ms, release ≈ 60 ms, stereo-linked). At 0 dB reduction the shelf is an exact
 * identity. Output Sibilance Only plays what is removed (input − output).
 */
export class DeEsser extends EffectBase {
	private readonly freq: Smoothed;
	private coeffs: Coeffs = IDENTITY;
	private readonly hp: Biquad[];
	private readonly shelf: Biquad[];
	private shelfCoeffs: Coeffs = IDENTITY;
	private shelfGr = 0;
	private envBand = 0;
	private envFull = 0;
	private gr = 0;
	private readonly det: number;
	private readonly att: number;
	private readonly rel: number;
	private threshold = -12;
	private reduction = 8;
	private readonly only: Smoothed;

	constructor(sr: number, ch: number) {
		super('jasper.audio.deesser', sr, ch);
		const n = Math.max(1, ch);
		this.freq = Smoothed.withMs(6000, sr, 20);
		this.hp = Array.from({ length: n }, () => new Biquad());
		this.shelf = Array.from({ length: n }, () => new Biquad());
		this.det = coef(2, sr);
		this.att = coef(1, sr);
		this.rel = coef(60, sr);
		this.only = Smoothed.withMs(0, sr, 20);
		this.applyParams(true);
	}

	private design(): void {
		this.coeffs = designBiquad('highPass', this.sampleRate, this.freq.value(), Math.SQRT1_2, 0);
		this.designShelf();
	}

	private designShelf(): void {
		this.shelfCoeffs =
			this.gr === 0
				? IDENTITY
				: designBiquad('highShelf', this.sampleRate, this.freq.value(), Math.SQRT1_2, this.gr);
		this.shelfGr = this.gr;
	}

	protected applyParams(snap: boolean): void {
		this.freq.set(this.pv.v('frequency'));
		this.threshold = this.pv.v('threshold');
		this.reduction = this.pv.v('reduction');
		this.only.set(this.pv.on('sibilanceOnly') ? 1 : 0);
		if (snap) {
			this.freq.snap();
			this.only.snap();
			this.design();
		}
	}

	meters(): number[] {
		return [this.gr];
	}

	reset(): void {
		this.freq.snap();
		this.only.snap();
		for (const b of this.hp) b.reset();
		for (const b of this.shelf) b.reset();
		this.envBand = 0;
		this.envFull = 0;
		this.gr = 0;
		this.design();
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.hp.length);
		for (let i = start; i < end; i++) {
			if (this.freq.isSmoothing()) {
				this.freq.tick();
				this.design();
			}
			let pb = 0;
			let pf = 0;
			for (let c = 0; c < nch; c++) {
				const x = ch[c]![i]!;
				const b = this.hp[c]!.tick(this.coeffs, x);
				pb += b * b;
				pf += x * x;
			}
			this.envBand = flush(this.det * this.envBand + (1 - this.det) * pb);
			this.envFull = flush(this.det * this.envFull + (1 - this.det) * pf);
			const bdb = powDb(this.envBand);
			const excess = bdb - powDb(this.envFull) - this.threshold;
			const target = bdb > -70 && excess > 0 ? -Math.min(excess * 2, this.reduction) : 0;
			const c = target < this.gr ? this.att : this.rel;
			this.gr = flush(c * this.gr + (1 - c) * target);
			if (target === 0 && this.gr > -1e-4) this.gr = 0;
			if (Math.abs(this.gr - this.shelfGr) > 0.05 || (this.gr === 0) !== (this.shelfGr === 0))
				this.designShelf();
			const only = this.only.tick();
			for (let k = 0; k < nch; k++) {
				const x = ch[k]![i]!;
				const y = this.shelf[k]!.tick(this.shelfCoeffs, x);
				ch[k]![i] = y + only * (x - y - y);
			}
		}
	}
}

const ENH_EXP_THRESHOLD = -50;
const ENH_EXP_RATIO = 3;
const ENH_EXP_RANGE = 18;
const ENH_COMP_THRESHOLD = -24;
const ENH_COMP_RATIO = 3;
const ENH_COMP_KNEE = 6;
/** Make-up gain: puts conversational speech (≈ −20 dBFS RMS) back near its input loudness. */
const ENH_MAKEUP = 3;
const MAX_CH = 8;

/**
 * Enhance Speech: a DSP voice-enhancement chain (no machine learning) — 80 Hz high-pass, de-mud cut, presence and air
 * boosts, then a combined downward expander + soft-knee compressor with make-up gain. Tone picks the cut/boost
 * frequencies for lower or higher voices; Mix blends with the dry signal.
 */
export class SpeechEnhance extends EffectBase {
	private coeffs: Coeffs[] = [IDENTITY, IDENTITY, IDENTITY, IDENTITY];
	private readonly filters: Biquad[][];
	private readonly mix: Smoothed;
	private ms = 0;
	private envExp = 0;
	private envComp = 0;
	private readonly det: number;
	private readonly fast: number;
	private readonly expClose: number;
	private readonly compRel: number;
	private readonly wet = new Float64Array(MAX_CH);

	constructor(sr: number, ch: number) {
		super('jasper.audio.enhance-speech', sr, ch);
		this.filters = Array.from({ length: Math.max(1, Math.min(MAX_CH, ch)) }, () =>
			Array.from({ length: 4 }, () => new Biquad()),
		);
		this.mix = Smoothed.withMs(1, sr, 20);
		this.det = coef(5, sr);
		this.fast = coef(3, sr);
		this.expClose = coef(30, sr);
		this.compRel = coef(120, sr);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		const high = this.pv.idx('tone') === 1;
		const [mud, presence] = high ? [350, 4000] : [250, 2500];
		const sr = this.sampleRate;
		this.coeffs = [
			designBiquad('highPass', sr, 80, Math.SQRT1_2, 0),
			designBiquad('peaking', sr, mud, 1, -3),
			designBiquad('peaking', sr, presence, 1, 4),
			designBiquad('highShelf', sr, 10000, Math.SQRT1_2, 2),
		];
		this.mix.set(this.pv.v('mix') / 100);
		if (snap) this.mix.snap();
	}

	static expanderDb(level: number): number {
		return level < ENH_EXP_THRESHOLD
			? Math.max((level - ENH_EXP_THRESHOLD) * (ENH_EXP_RATIO - 1), -ENH_EXP_RANGE)
			: 0;
	}

	static compressorDb(level: number): number {
		const d = level - ENH_COMP_THRESHOLD;
		if (2 * Math.abs(d) <= ENH_COMP_KNEE)
			return ((1 / ENH_COMP_RATIO - 1) * (d + ENH_COMP_KNEE / 2) ** 2) / (2 * ENH_COMP_KNEE);
		return d > 0 ? d / ENH_COMP_RATIO - d : 0;
	}

	reset(): void {
		for (const f of this.filters) for (const b of f) b.reset();
		this.mix.snap();
		this.ms = 0;
		this.envExp = 0;
		this.envComp = 0;
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.filters.length);
		const co = this.coeffs;
		for (let i = start; i < end; i++) {
			let sq = 0;
			for (let c = 0; c < nch; c++) {
				const f = this.filters[c]!;
				let x = ch[c]![i]!;
				x = f[0]!.tick(co[0]!, x);
				x = f[1]!.tick(co[1]!, x);
				x = f[2]!.tick(co[2]!, x);
				x = f[3]!.tick(co[3]!, x);
				this.wet[c] = x;
				if (x * x > sq) sq = x * x;
			}
			this.ms = flush(this.det * this.ms + (1 - this.det) * sq);
			const level = powDb(this.ms);
			const te = SpeechEnhance.expanderDb(level);
			let c = te > this.envExp ? this.fast : this.expClose;
			this.envExp = c * this.envExp + (1 - c) * te;
			const tc = SpeechEnhance.compressorDb(level);
			c = tc < this.envComp ? this.fast : this.compRel;
			this.envComp = c * this.envComp + (1 - c) * tc;
			if (Math.abs(this.envExp) < 1e-9) this.envExp = 0;
			if (Math.abs(this.envComp) < 1e-9) this.envComp = 0;
			const g = 10 ** ((this.envExp + this.envComp + ENH_MAKEUP) / 20);
			const m = this.mix.tick();
			for (let k = 0; k < nch; k++) {
				const dry = ch[k]![i]!;
				ch[k]![i] = dry + m * (this.wet[k]! * g - dry);
			}
		}
	}
}
