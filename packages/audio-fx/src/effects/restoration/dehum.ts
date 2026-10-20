// DeHummer (ported from filmcraft `effects/restoration.rs` DeHum): a cascade of RBJ notches at the mains fundamental
// and its harmonics, each stage cross-faded in/out so changing the harmonic count is click-free.
import { Biquad, type Coeffs, designBiquad, IDENTITY } from '../../core/biquad.ts';
import { EffectBase } from '../../core/effect.ts';
import { Smoothed } from '../../core/smooth.ts';

export const MAX_HARMONICS = 10;

export class DeHum extends EffectBase {
	private readonly coeffs: Coeffs[] = Array.from({ length: MAX_HARMONICS }, () => IDENTITY);
	private readonly stageMix: Smoothed[];
	private readonly state: Biquad[][];
	private readonly amount: Smoothed;
	private readonly humOnly: Smoothed;
	private readonly mix = new Float64Array(MAX_HARMONICS);

	constructor(sr: number, ch: number) {
		super('jasper.audio.dehummer', sr, ch);
		this.stageMix = Array.from({ length: MAX_HARMONICS }, () => Smoothed.withMs(0, sr, 20));
		this.state = Array.from({ length: Math.max(1, ch) }, () =>
			Array.from({ length: MAX_HARMONICS }, () => new Biquad()),
		);
		this.amount = Smoothed.withMs(1, sr, 20);
		this.humOnly = Smoothed.withMs(0, sr, 20);
		this.applyParams(true);
	}

	private f0(): number {
		return this.pv.option('frequency') === '50' ? 50 : 60;
	}

	protected applyParams(snap: boolean): void {
		const f0 = this.f0();
		const h = Math.round(this.pv.v('harmonics'));
		const q = this.pv.v('q');
		for (let k = 0; k < MAX_HARMONICS; k++) {
			const f = f0 * (k + 1);
			const active = k < h && f < this.sampleRate * 0.45;
			this.coeffs[k] = designBiquad('notch', this.sampleRate, f, q, 0);
			this.stageMix[k]!.set(active ? 1 : 0);
			if (snap) this.stageMix[k]!.snap();
		}
		this.amount.set(this.pv.v('amount') / 100);
		this.humOnly.set(this.pv.on('humOnly') ? 1 : 0);
		if (snap) {
			this.amount.snap();
			this.humOnly.snap();
		}
	}

	responseDb(freq: number): number {
		const a = this.pv.v('amount') / 100;
		const h = Math.round(this.pv.v('harmonics'));
		const f0 = this.f0();
		const q = this.pv.v('q');
		// Complex response of the active cascade, blended with the dry path by Amount.
		let re = 1;
		let im = 0;
		const w = (2 * Math.PI * freq) / this.sampleRate;
		for (let k = 0; k < h; k++) {
			if (f0 * (k + 1) >= this.sampleRate * 0.45) continue;
			const c = designBiquad('notch', this.sampleRate, f0 * (k + 1), q, 0);
			const nr = c.b0 + c.b1 * Math.cos(w) + c.b2 * Math.cos(2 * w);
			const ni = -(c.b1 * Math.sin(w) + c.b2 * Math.sin(2 * w));
			const dr = 1 + c.a1 * Math.cos(w) + c.a2 * Math.cos(2 * w);
			const di = -(c.a1 * Math.sin(w) + c.a2 * Math.sin(2 * w));
			const d = dr * dr + di * di;
			const hr = (nr * dr + ni * di) / d;
			const hi = (ni * dr - nr * di) / d;
			const r2 = re * hr - im * hi;
			im = re * hi + im * hr;
			re = r2;
		}
		let yr = 1 + a * (re - 1);
		let yi = a * im;
		if (this.pv.on('humOnly')) {
			yr = 1 - yr;
			yi = -yi;
		}
		return 20 * Math.log10(Math.max(Math.hypot(yr, yi), 1e-12));
	}

	reset(): void {
		for (const s of this.state) for (const b of s) b.reset();
		for (const s of this.stageMix) s.snap();
		this.amount.snap();
		this.humOnly.snap();
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.state.length);
		const mix = this.mix;
		for (let i = start; i < end; i++) {
			for (let k = 0; k < MAX_HARMONICS; k++) mix[k] = this.stageMix[k]!.tick();
			const amt = this.amount.tick();
			const only = this.humOnly.tick();
			for (let c = 0; c < nch; c++) {
				const buf = ch[c]!;
				const dry = buf[i]!;
				let x = dry;
				const st = this.state[c]!;
				for (let k = 0; k < MAX_HARMONICS; k++) {
					const m = mix[k]!;
					if (m > 0) {
						const y = st[k]!.tick(this.coeffs[k]!, x);
						x += m * (y - x);
					} else st[k]!.reset();
				}
				const wet = dry + amt * (x - dry);
				buf[i] = wet + only * (dry - wet - wet);
			}
		}
	}
}
