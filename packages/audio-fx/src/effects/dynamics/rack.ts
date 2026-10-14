// Dynamics (Premiere's rack: AutoGate → Expander → Compressor → Limiter, stereo-linked peak detection, soft clip,
// output gain) and the four-band Multiband Compressor (Linkwitz–Riley crossovers with all-pass phase compensation,
// so the bands sum to an all-pass). Ported from filmcraft `effects/multiband.rs`.
import { Biquad, type Coeffs, designBiquad, IDENTITY } from '../../core/biquad.ts';
import { EffectBase } from '../../core/effect.ts';
import { dbToGain, flush32, linDb as linToDb } from '../../core/math.ts';
import { Smoothed } from '../../core/smooth.ts';
import { coef } from '../../core/util.ts';
import { compressorCurve, expanderCurve, smoothDb, softClip } from './curves.ts';

/** Attenuation of a closed gate (dB). */
const GATE_RANGE = 80;
/** Most expander attenuation (dB). */
const EXP_RANGE = 60;

export class DynamicsRack extends EffectBase {
	private gateEnv = 0;
	private gateHold = 0;
	private expEnv = 0;
	private compEnv = 0;
	private limEnv = 0;
	private readonly out: Smoothed;
	/** Compressor make-up (dB), part of the compressor stage: before the limiter, which caps it. */
	private readonly makeup: Smoothed;
	/** gate att, gate rel, exp att (1 ms), exp rel (80 ms), comp att, comp rel, —, lim rel. */
	private c = new Float64Array(8);
	private hold = 0;

	constructor(sr: number, ch: number) {
		super('jasper.audio.dynamics', sr, ch);
		this.out = Smoothed.withMs(1, sr, 20);
		this.makeup = Smoothed.withMs(0, sr, 20);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		const p = this.pv;
		const sr = this.sampleRate;
		this.c = Float64Array.from([
			coef(p.v('gateAttack'), sr),
			coef(p.v('gateRelease'), sr),
			coef(1, sr),
			coef(80, sr),
			coef(p.v('compAttack'), sr),
			coef(p.v('compRelease'), sr),
			0,
			coef(p.v('limRelease'), sr),
		]);
		this.hold = Math.floor(p.v('gateHold') * 0.001 * sr);
		this.out.set(dbToGain(p.v('output')));
		this.makeup.set(this.makeupDb());
		if (snap) {
			this.out.snap();
			this.makeup.snap();
		}
	}

	private makeupDb(): number {
		const p = this.pv;
		if (!p.on('compOn')) return 0;
		const t = p.v('compThreshold');
		const r = p.v('compRatio');
		const auto = p.on('compAuto') ? -0.5 * t * (1 - 1 / r) : 0;
		return p.v('compMakeup') + auto;
	}

	/** Static gain (dB) of the enabled sections (compressor make-up included) for a detector level, before output. */
	private staticGain(level: number): number {
		const p = this.pv;
		let l = level;
		if (p.on('gateOn') && l < p.v('gateThreshold')) l -= GATE_RANGE;
		if (p.on('expOn')) l = expanderCurve(l, p.v('expThreshold'), p.v('expRatio'), EXP_RANGE);
		if (p.on('compOn')) l = compressorCurve(l, p.v('compThreshold'), p.v('compRatio'), 0) + this.makeupDb();
		if (p.on('limOn')) l = Math.min(l, p.v('limThreshold'));
		return l - level;
	}

	transferDb(band: number, inputDb: number): number | null {
		if (band !== 0) return null;
		return inputDb + this.staticGain(inputDb) + this.pv.v('output');
	}

	/** Gain reduction (dB) of the AutoGate, Expander, Compressor and Limiter sections. */
	meters(): number[] {
		return [this.gateEnv, this.expEnv, this.compEnv, this.limEnv];
	}

	reset(): void {
		this.gateEnv = 0;
		this.gateHold = 0;
		this.expEnv = 0;
		this.compEnv = 0;
		this.limEnv = 0;
		this.out.snap();
		this.makeup.snap();
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const p = this.pv;
		const nch = ch.length;
		const gateOn = p.on('gateOn');
		const gt = p.v('gateThreshold');
		const expOn = p.on('expOn');
		const et = p.v('expThreshold');
		const er = p.v('expRatio');
		const compOn = p.on('compOn');
		const ct = p.v('compThreshold');
		const cr = p.v('compRatio');
		const limOn = p.on('limOn');
		const lt = p.v('limThreshold');
		const clip = p.on('softClip');
		const ceiling = dbToGain(lt);
		const c = this.c;
		for (let i = start; i < end; i++) {
			let peak = 0;
			for (let k = 0; k < nch; k++) {
				const a = Math.abs(ch[k]![i]!);
				if (a > peak) peak = a;
			}
			let l = linToDb(peak);
			let g = 0;
			if (gateOn) {
				const target = l < gt ? -GATE_RANGE : 0;
				if (target >= 0) {
					this.gateHold = this.hold;
					this.gateEnv = smoothDb(this.gateEnv, 0, c[1]!, c[0]!);
				} else if (this.gateHold > 0) this.gateHold--;
				else this.gateEnv = smoothDb(this.gateEnv, target, c[1]!, c[1]!);
				g += this.gateEnv;
				l += this.gateEnv;
			}
			if (expOn) {
				const target = expanderCurve(l, et, er, EXP_RANGE) - l;
				this.expEnv = smoothDb(this.expEnv, target, c[2]!, c[3]!);
				g += this.expEnv;
				l += this.expEnv;
			}
			if (compOn) {
				const target = compressorCurve(l, ct, cr, 0) - l;
				this.compEnv = smoothDb(this.compEnv, target, c[4]!, c[5]!);
				g += this.compEnv;
				l += this.compEnv;
			}
			// Make-up belongs to the compressor: the limiter after it sees (and caps) the made-up level.
			const mk = this.makeup.tick();
			g += mk;
			l += mk;
			if (limOn) {
				const target = Math.min(lt - l, 0);
				if (target < this.limEnv) this.limEnv = target;
				else this.limEnv = smoothDb(this.limEnv, target, 0, c[7]!);
				g += this.limEnv;
			}
			const gain = dbToGain(g);
			const o = this.out.tick();
			for (let k = 0; k < nch; k++) {
				let y = ch[k]![i]! * gain;
				if (limOn) y = clip ? softClip(y, ceiling) : y > ceiling ? ceiling : y < -ceiling ? -ceiling : y;
				ch[k]![i] = y * o;
			}
		}
	}
}

export const MB_BANDS = 4;
const Q_BW = Math.SQRT1_2;
/** Most channels the multiband compressor processes (extra ones pass through). */
const MAX_CH = 8;

type XoState = {
	lp1: [Biquad, Biquad];
	hp1: [Biquad, Biquad];
	lp2: [Biquad, Biquad];
	hp2: [Biquad, Biquad];
	lp3: [Biquad, Biquad];
	hp3: [Biquad, Biquad];
	/** Phase compensation: band 1 through AP(f2), AP(f3); band 2 through AP(f3). */
	ap12: Biquad;
	ap13: Biquad;
	ap23: Biquad;
};
const pair = (): [Biquad, Biquad] => [new Biquad(), new Biquad()];
const xoState = (): XoState => ({
	lp1: pair(),
	hp1: pair(),
	lp2: pair(),
	hp2: pair(),
	lp3: pair(),
	hp3: pair(),
	ap12: new Biquad(),
	ap13: new Biquad(),
	ap23: new Biquad(),
});

export class MultibandCompressor extends EffectBase {
	private readonly xo: Smoothed[];
	private readonly lp: Coeffs[] = [IDENTITY, IDENTITY, IDENTITY];
	private readonly hp: Coeffs[] = [IDENTITY, IDENTITY, IDENTITY];
	private readonly ap: Coeffs[] = [IDENTITY, IDENTITY, IDENTITY];
	private readonly state: XoState[];
	/** Gain-reduction envelopes (dB), [channel][band] (channel 0 when linked). */
	private readonly env: Float64Array[];
	private limEnv = 0;
	private readonly bandGain: Smoothed[];
	private readonly out: Smoothed;
	private readonly att = new Float64Array(MB_BANDS);
	private readonly rel = new Float64Array(MB_BANDS);
	private limRel = 0;
	private counter = 0;
	/** The crossover designs lag the smoothers (see `process`). */
	private xoDirty = false;
	private readonly bands = Array.from({ length: MAX_CH }, () => new Float64Array(MB_BANDS));
	private readonly gains = Array.from({ length: MAX_CH }, () => new Float64Array(MB_BANDS));
	private readonly ys = new Float64Array(MAX_CH);
	private readonly thr = new Float64Array(MB_BANDS);
	private readonly ratio = new Float64Array(MB_BANDS);
	private readonly byp = new Uint8Array(MB_BANDS);
	private readonly bg = new Float64Array(MB_BANDS);

	constructor(sr: number, ch: number) {
		super('jasper.audio.multiband-compressor', sr, ch);
		const sm = (v: number) => Smoothed.withMs(v, sr, 30);
		this.xo = [sm(1), sm(1), sm(1)];
		const n = Math.max(1, Math.min(MAX_CH, ch));
		this.state = Array.from({ length: n }, xoState);
		this.env = Array.from({ length: n }, () => new Float64Array(MB_BANDS));
		this.bandGain = [sm(1), sm(1), sm(1), sm(1)];
		this.out = sm(1);
		this.applyParams(true);
	}

	/** Crossover frequencies (Hz), kept strictly increasing. */
	crossovers(): [number, number, number] {
		const a = this.pv.v('xo1');
		const b = Math.max(this.pv.v('xo2'), a * 1.25);
		const c = Math.min(Math.max(this.pv.v('xo3'), b * 1.25), this.sampleRate * 0.45);
		return [a, Math.min(b, c / 1.25), c];
	}

	private updateXo(): void {
		for (let k = 0; k < 3; k++) {
			const f = 2 ** this.xo[k]!.value();
			this.lp[k] = designBiquad('lowPass', this.sampleRate, f, Q_BW, 0);
			this.hp[k] = designBiquad('highPass', this.sampleRate, f, Q_BW, 0);
			this.ap[k] = designBiquad('allPass', this.sampleRate, f, Q_BW, 0);
		}
	}

	private bandLevel(b: number): number {
		const anySolo = [1, 2, 3, 4].some((n) => this.pv.on(`b${n}Solo`));
		const n = b + 1;
		if (anySolo && !this.pv.on(`b${n}Solo`)) return 0;
		return this.pv.on(`b${n}Bypass`) ? 1 : dbToGain(this.pv.v(`b${n}Gain`));
	}

	protected applyParams(snap: boolean): void {
		const xo = this.crossovers();
		for (let k = 0; k < 3; k++) this.xo[k]!.set(Math.log2(xo[k]!));
		for (let b = 0; b < MB_BANDS; b++) {
			const n = b + 1;
			this.att[b] = coef(this.pv.v(`b${n}Attack`), this.sampleRate);
			this.rel[b] = coef(this.pv.v(`b${n}Release`), this.sampleRate);
			this.bandGain[b]!.set(this.bandLevel(b));
			this.thr[b] = this.pv.v(`b${n}Threshold`);
			this.ratio[b] = this.pv.v(`b${n}Ratio`);
			this.byp[b] = this.pv.on(`b${n}Bypass`) ? 1 : 0;
		}
		this.limRel = coef(this.pv.v('limRelease'), this.sampleRate);
		this.out.set(dbToGain(this.pv.v('output')));
		if (snap) {
			for (const s of [...this.xo, ...this.bandGain, this.out]) s.snap();
			this.updateXo();
		}
	}

	transferDb(band: number, inputDb: number): number | null {
		if (band < 0 || band >= MB_BANDS) return null;
		const n = band + 1;
		if (this.pv.on(`b${n}Bypass`)) return inputDb;
		return (
			compressorCurve(inputDb, this.pv.v(`b${n}Threshold`), this.pv.v(`b${n}Ratio`), 0) +
			this.pv.v(`b${n}Gain`)
		);
	}

	/** Gain reduction (dB) per band (channel 0 / linked). */
	meters(): number[] {
		return Array.from(this.env[0]!);
	}

	/** Combined magnitude of the crossover (flat by design): 0 dB. */
	responseDb(): number {
		return 0;
	}

	reset(): void {
		for (const s of [...this.xo, ...this.bandGain, this.out]) s.snap();
		this.updateXo();
		for (const st of this.state)
			for (const v of Object.values(st)) for (const b of Array.isArray(v) ? v : [v]) b.reset();
		for (const e of this.env) e.fill(0);
		this.limEnv = 0;
		this.counter = 0;
		this.xoDirty = false;
	}

	private split(st: XoState, x: number, out: Float64Array): void {
		const lp = this.lp;
		const hp = this.hp;
		const ap = this.ap;
		let b1 = st.lp1[1].tick(lp[0]!, st.lp1[0].tick(lp[0]!, x));
		const r1 = st.hp1[1].tick(hp[0]!, st.hp1[0].tick(hp[0]!, x));
		b1 = st.ap13.tick(ap[2]!, st.ap12.tick(ap[1]!, b1));
		let b2 = st.lp2[1].tick(lp[1]!, st.lp2[0].tick(lp[1]!, r1));
		const r2 = st.hp2[1].tick(hp[1]!, st.hp2[0].tick(hp[1]!, r1));
		b2 = st.ap23.tick(ap[2]!, b2);
		out[0] = b1;
		out[1] = b2;
		out[2] = st.lp3[1].tick(lp[2]!, st.lp3[0].tick(lp[2]!, r2));
		out[3] = st.hp3[1].tick(hp[2]!, st.hp3[0].tick(hp[2]!, r2));
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.state.length);
		const link = this.pv.on('link');
		const limOn = this.pv.on('limOn');
		const lt = this.pv.v('limThreshold');
		const ceiling = dbToGain(lt);
		const thr = this.thr;
		const ratio = this.ratio;
		const byp = this.byp;
		const bg = this.bg;
		for (let i = start; i < end; i++) {
			if (this.counter === 0) {
				// Redesign while the crossovers glide, and once more after they arrive (the last ramp steps fall
				// between two control points; without it the crossovers stopped short of their targets).
				const gliding = this.xo[0]!.isSmoothing() || this.xo[1]!.isSmoothing() || this.xo[2]!.isSmoothing();
				if (gliding || this.xoDirty) this.updateXo();
				this.xoDirty = gliding;
			}
			this.counter = (this.counter + 1) % 16;
			this.xo[0]!.tick();
			this.xo[1]!.tick();
			this.xo[2]!.tick();
			for (let b = 0; b < MB_BANDS; b++) bg[b] = this.bandGain[b]!.tick();
			const o = this.out.tick();
			for (let c = 0; c < nch; c++) this.split(this.state[c]!, ch[c]![i]!, this.bands[c]!);
			for (let b = 0; b < MB_BANDS; b++) {
				if (byp[b]) {
					for (let c = 0; c < nch; c++) this.gains[c]![b] = 1;
					continue;
				}
				if (link) {
					let peak = 0;
					for (let c = 0; c < nch; c++) peak = Math.max(peak, Math.abs(this.bands[c]![b]!));
					const l = linToDb(peak);
					const e0 = this.env[0]!;
					e0[b] = smoothDb(e0[b]!, compressorCurve(l, thr[b]!, ratio[b]!, 0) - l, this.att[b]!, this.rel[b]!);
					const g = dbToGain(e0[b]!);
					for (let c = 0; c < nch; c++) this.gains[c]![b] = g;
				} else
					for (let c = 0; c < nch; c++) {
						const l = linToDb(Math.abs(this.bands[c]![b]!));
						const e = this.env[c]!;
						e[b] = smoothDb(e[b]!, compressorCurve(l, thr[b]!, ratio[b]!, 0) - l, this.att[b]!, this.rel[b]!);
						this.gains[c]![b] = dbToGain(e[b]!);
					}
			}
			for (let c = 0; c < nch; c++) {
				let y = 0;
				for (let b = 0; b < MB_BANDS; b++) y += this.bands[c]![b]! * this.gains[c]![b]! * bg[b]!;
				this.ys[c] = y * o;
			}
			if (limOn) {
				let peak = 0;
				for (let c = 0; c < nch; c++) peak = Math.max(peak, Math.abs(this.ys[c]!));
				const target = Math.min(lt - linToDb(peak), 0);
				if (target < this.limEnv) this.limEnv = target;
				else this.limEnv = smoothDb(this.limEnv, target, 0, this.limRel);
				const g = dbToGain(this.limEnv);
				for (let c = 0; c < nch; c++) {
					const y = this.ys[c]! * g;
					this.ys[c] = y > ceiling ? ceiling : y < -ceiling ? -ceiling : y;
				}
			}
			for (let c = 0; c < nch; c++) ch[c]![i] = flush32(this.ys[c]!);
		}
	}
}
