// Channel utilities and stereo imagery (ported from filmcraft `audio-dsp/src/effects/channel.rs`, `essential.rs`
// StereoWidth, `special.rs` ChannelMixer / StereoExpander / Binauralizer / AmbisonicsPanner; Mono Maker is ours).
import { Biquad, type Coeffs, designBiquad } from '../core/biquad.ts';
import { EffectBase, type ProcessorFactory } from '../core/effect.ts';
import { dbToGain, flush32 } from '../core/math.ts';
import { balanceGains, constantPowerPan } from '../core/pan.ts';
import { Smoothed } from '../core/smooth.ts';
import { DelayLine } from '../core/util.ts';

const RAMP_MS = 20;
const sm = (v: number, sr: number) => Smoothed.withMs(v, sr, RAMP_MS);
const gainOf = (db: number) => (db <= -96 ? 0 : dbToGain(db));
const snapAll = (xs: readonly Smoothed[]) => {
	for (const s of xs) s.snap();
};

export class Amplify extends EffectBase {
	private readonly gl: Smoothed;
	private readonly gr: Smoothed;
	constructor(sr: number, ch: number) {
		super('jasper.audio.amplify', sr, ch);
		this.gl = sm(1, sr);
		this.gr = sm(1, sr);
		this.applyParams(true);
	}
	protected applyParams(snap: boolean): void {
		const l = this.pv.v('leftGain');
		const r = this.pv.on('link') ? l : this.pv.v('rightGain');
		this.gl.set(gainOf(l));
		this.gr.set(gainOf(r));
		if (snap) snapAll([this.gl, this.gr]);
	}
	reset(): void {
		snapAll([this.gl, this.gr]);
	}
	process(ch: readonly Float32Array[], start: number, end: number): void {
		const l = ch[0];
		const r = ch[1];
		for (let i = start; i < end; i++) {
			const a = this.gl.tick();
			const b = this.gr.tick();
			if (l) l[i] = l[i]! * a;
			if (r) r[i] = r[i]! * b;
			for (let c = 2; c < ch.length; c++) ch[c]![i] = ch[c]![i]! * a;
		}
	}
}

export class ChannelVolume extends EffectBase {
	private readonly gl: Smoothed;
	private readonly gr: Smoothed;
	constructor(sr: number, ch: number) {
		super('jasper.audio.channel-volume', sr, ch);
		this.gl = sm(1, sr);
		this.gr = sm(1, sr);
		this.applyParams(true);
	}
	protected applyParams(snap: boolean): void {
		this.gl.set(gainOf(this.pv.v('left')));
		this.gr.set(gainOf(this.pv.v('right')));
		if (snap) snapAll([this.gl, this.gr]);
	}
	reset(): void {
		snapAll([this.gl, this.gr]);
	}
	process(ch: readonly Float32Array[], start: number, end: number): void {
		const l = ch[0];
		const r = ch[1];
		for (let i = start; i < end; i++) {
			const a = this.gl.tick();
			const b = this.gr.tick();
			if (l) l[i] = l[i]! * a;
			if (r) r[i] = r[i]! * b;
		}
	}
}

export class Balance extends EffectBase {
	private readonly gl: Smoothed;
	private readonly gr: Smoothed;
	private readonly modeMix: Smoothed;
	constructor(sr: number, ch: number) {
		super('jasper.audio.balance', sr, ch);
		this.gl = sm(1, sr);
		this.gr = sm(1, sr);
		this.modeMix = sm(0, sr);
		this.applyParams(true);
	}
	protected applyParams(snap: boolean): void {
		const p = this.pv.v('balance') / 100;
		const pan = this.pv.idx('mode') === 1;
		let l: number;
		let r: number;
		if (pan) {
			[l, r] = constantPowerPan(p);
			l *= Math.SQRT2;
			r *= Math.SQRT2;
		} else [l, r] = balanceGains(p);
		this.gl.set(l);
		this.gr.set(r);
		this.modeMix.set(pan ? 1 : 0);
		if (snap) snapAll([this.gl, this.gr, this.modeMix]);
	}
	reset(): void {
		snapAll([this.gl, this.gr, this.modeMix]);
	}
	process(ch: readonly Float32Array[], start: number, end: number): void {
		const l = ch[0];
		const r = ch[1];
		if (!l || !r) return;
		for (let i = start; i < end; i++) {
			const gl = this.gl.tick();
			const gr = this.gr.tick();
			const mm = this.modeMix.tick();
			const x = l[i]!;
			const y = r[i]!;
			const mono = 0.5 * (x + y);
			l[i] = (x + mm * (mono - x)) * gl;
			r[i] = (y + mm * (mono - y)) * gr;
		}
	}
}

export class Invert extends EffectBase {
	constructor(sr: number, ch: number) {
		super('jasper.audio.invert', sr, ch);
	}
	protected applyParams(): void {}
	reset(): void {}
	process(ch: readonly Float32Array[], start: number, end: number): void {
		const which = this.pv.idx('channels');
		ch.forEach((buf, c) => {
			if (which === 0 || which === c + 1) for (let i = start; i < end; i++) buf[i] = -buf[i]!;
		});
	}
}

type Routing = 'swap' | 'fillLeft' | 'fillRight';
const ROUTE_IDS: Record<Routing, string> = {
	swap: 'jasper.audio.swap-channels',
	fillLeft: 'jasper.audio.fill-left-with-right',
	fillRight: 'jasper.audio.fill-right-with-left',
};

export class Route extends EffectBase {
	constructor(
		private readonly kind: Routing,
		sr: number,
		ch: number,
	) {
		super(ROUTE_IDS[kind], sr, ch);
	}
	protected applyParams(): void {}
	reset(): void {}
	process(ch: readonly Float32Array[], start: number, end: number): void {
		const l = ch[0];
		const r = ch[1];
		if (!l || !r) return;
		if (this.kind === 'swap')
			for (let i = start; i < end; i++) {
				const t = l[i]!;
				l[i] = r[i]!;
				r[i] = t;
			}
		else if (this.kind === 'fillLeft') l.set(r.subarray(start, end), start);
		else r.set(l.subarray(start, end), start);
	}
}

export class ChannelMixer extends EffectBase {
	private readonly g: Smoothed[];
	constructor(sr: number, ch: number) {
		super('jasper.audio.channel-mixer', sr, ch);
		this.g = [sm(1, sr), sm(0, sr), sm(0, sr), sm(1, sr)];
		this.applyParams(true);
	}
	protected applyParams(snap: boolean): void {
		const il = this.pv.on('invertLeft') ? -1 : 1;
		const ir = this.pv.on('invertRight') ? -1 : 1;
		const v = [
			(il * this.pv.v('leftFromLeft')) / 100,
			(il * this.pv.v('leftFromRight')) / 100,
			(ir * this.pv.v('rightFromLeft')) / 100,
			(ir * this.pv.v('rightFromRight')) / 100,
		];
		this.g.forEach((s, k) => s.set(v[k]!));
		if (snap) snapAll(this.g);
	}
	reset(): void {
		snapAll(this.g);
	}
	process(ch: readonly Float32Array[], start: number, end: number): void {
		const l = ch[0];
		const r = ch[1];
		const [g0, g1, g2, g3] = this.g as [Smoothed, Smoothed, Smoothed, Smoothed];
		if (!l) return;
		if (!r) {
			for (let i = start; i < end; i++) {
				const a = g0.tick();
				const b = g1.tick();
				g2.tick();
				g3.tick();
				l[i] = l[i]! * (a + b);
			}
			return;
		}
		for (let i = start; i < end; i++) {
			const a = g0.tick();
			const b = g1.tick();
			const c = g2.tick();
			const d = g3.tick();
			const x = l[i]!;
			const y = r[i]!;
			l[i] = a * x + b * y;
			r[i] = c * x + d * y;
		}
	}
}

export class StereoExpander extends EffectBase {
	private readonly gl: Smoothed;
	private readonly gr: Smoothed;
	private readonly side: Smoothed;
	constructor(sr: number, ch: number) {
		super('jasper.audio.stereo-expander', sr, ch);
		this.gl = sm(1, sr);
		this.gr = sm(1, sr);
		this.side = sm(1, sr);
		this.applyParams(true);
	}
	protected applyParams(snap: boolean): void {
		const p = this.pv.v('centerPan') / 100;
		this.gl.set(Math.min(1 - p, 1));
		this.gr.set(Math.min(1 + p, 1));
		this.side.set(this.pv.v('expand') / 100);
		if (snap) snapAll([this.gl, this.gr, this.side]);
	}
	reset(): void {
		snapAll([this.gl, this.gr, this.side]);
	}
	process(ch: readonly Float32Array[], start: number, end: number): void {
		const l = ch[0];
		const r = ch[1];
		if (!l || !r) return;
		for (let i = start; i < end; i++) {
			const gl = this.gl.tick();
			const gr = this.gr.tick();
			const w = this.side.tick();
			const x = l[i]!;
			const y = r[i]!;
			const m = 0.5 * (x + y);
			const s = 0.5 * (x - y) * w;
			l[i] = m * gl + s;
			r[i] = m * gr - s;
		}
	}
}

export class StereoWidth extends EffectBase {
	private readonly width: Smoothed;
	constructor(sr: number, ch: number) {
		super('jasper.audio.stereo-width', sr, ch);
		this.width = sm(1, sr);
		this.applyParams(true);
	}
	protected applyParams(snap: boolean): void {
		this.width.set(this.pv.v('width') / 100);
		if (snap) this.width.snap();
	}
	reset(): void {
		this.width.snap();
	}
	process(ch: readonly Float32Array[], start: number, end: number): void {
		const l = ch[0];
		const r = ch[1];
		if (!l || !r) {
			for (let i = start; i < end; i++) this.width.tick();
			return;
		}
		for (let i = start; i < end; i++) {
			const w = this.width.tick();
			const m = 0.5 * (l[i]! + r[i]!);
			const s = 0.5 * (l[i]! - r[i]!) * w;
			l[i] = m + s;
			r[i] = m - s;
		}
	}
}

/** Coefficient refresh interval while the crossover frequency glides. */
const COEFF_INTERVAL = 16;

/**
 * Mono Maker: full-range mono sum, or mono below a crossover frequency. The crossover is a 4th-order Linkwitz–Riley
 * pair (two cascaded Butterworth sections each), so low + high sum to an all-pass (flat magnitude).
 */
export class MonoMaker extends EffectBase {
	private readonly freq: Smoothed; // log2 Hz
	private readonly amount: Smoothed;
	private readonly modeMix: Smoothed; // 0 = full, 1 = below
	private lp: Coeffs;
	private hp: Coeffs;
	/** [ch][stage] for low-pass and high-pass cascades. */
	private readonly lps = [
		[new Biquad(), new Biquad()],
		[new Biquad(), new Biquad()],
	];
	private readonly hps = [
		[new Biquad(), new Biquad()],
		[new Biquad(), new Biquad()],
	];
	private counter = 0;
	private dirty = true;
	constructor(sr: number, ch: number) {
		super('jasper.audio.mono-maker', sr, ch);
		this.freq = sm(Math.log2(150), sr);
		this.amount = sm(1, sr);
		this.modeMix = sm(0, sr);
		this.lp = designBiquad('lowPass', sr, 150, Math.SQRT1_2, 0);
		this.hp = designBiquad('highPass', sr, 150, Math.SQRT1_2, 0);
		this.applyParams(true);
	}
	protected applyParams(snap: boolean): void {
		this.freq.set(Math.log2(this.pv.v('frequency')));
		this.amount.set(this.pv.v('amount') / 100);
		this.modeMix.set(this.pv.idx('mode') === 1 ? 1 : 0);
		this.dirty = true;
		if (snap) {
			snapAll([this.freq, this.amount, this.modeMix]);
			this.design();
		}
	}
	private design(): void {
		const f = 2 ** this.freq.value();
		this.lp = designBiquad('lowPass', this.sampleRate, f, Math.SQRT1_2, 0);
		this.hp = designBiquad('highPass', this.sampleRate, f, Math.SQRT1_2, 0);
	}
	reset(): void {
		snapAll([this.freq, this.amount, this.modeMix]);
		for (const a of [...this.lps, ...this.hps]) for (const b of a) b.reset();
		this.counter = 0;
		this.design();
		this.dirty = false;
	}
	/** Crossover sum response is flat; the effect's magnitude on a mono (L = R) signal is 0 dB. */
	responseDb(): number {
		return 0;
	}
	process(ch: readonly Float32Array[], start: number, end: number): void {
		const l = ch[0];
		const r = ch[1];
		if (!l || !r) {
			for (let i = start; i < end; i++) {
				this.freq.tick();
				this.amount.tick();
				this.modeMix.tick();
			}
			return;
		}
		const [l0, l1] = this.lps[0] as [Biquad, Biquad];
		const [r0, r1] = this.lps[1] as [Biquad, Biquad];
		const [hl0, hl1] = this.hps[0] as [Biquad, Biquad];
		const [hr0, hr1] = this.hps[1] as [Biquad, Biquad];
		for (let i = start; i < end; i++) {
			if (this.counter === 0 && this.dirty) {
				this.design();
				this.dirty = this.freq.isSmoothing();
			}
			this.counter = (this.counter + 1) % COEFF_INTERVAL;
			this.freq.tick();
			if (this.freq.isSmoothing()) this.dirty = true;
			const amt = this.amount.tick();
			const mm = this.modeMix.tick();
			const x = l[i]!;
			const y = r[i]!;
			// Full-range mono.
			const m = 0.5 * (x + y);
			const fl = x + amt * (m - x);
			const fr = y + amt * (m - y);
			// Mono below the crossover.
			const lowL = l1.tick(this.lp, l0.tick(this.lp, x));
			const lowR = r1.tick(this.lp, r0.tick(this.lp, y));
			const highL = hl1.tick(this.hp, hl0.tick(this.hp, x));
			const highR = hr1.tick(this.hp, hr0.tick(this.hp, y));
			const lm = 0.5 * (lowL + lowR);
			// Linkwitz–Riley 4th order: low + high (same polarity) is an all-pass.
			const bl = lowL + amt * (lm - lowL) + highL;
			const br = lowR + amt * (lm - lowR) + highR;
			l[i] = flush32(fl + mm * (bl - fl));
			r[i] = flush32(fr + mm * (br - fr));
		}
	}
}

// ---------------------------------------------------------------- binauralizer

const SPEED_OF_SOUND = 343;

/** Head-shadow filter (one-pole/one-zero spherical-head model, Brown & Duda 1998). */
class Shadow {
	b0 = 1;
	b1 = 0;
	a1 = 0;
	x1 = 0;
	y1 = 0;
	static coeffs(incidenceDeg: number, radius: number, sr: number): [number, number, number] {
		const alpha = 1.05 + 0.95 * Math.cos((incidenceDeg / 150) * Math.PI);
		const w0 = SPEED_OF_SOUND / radius;
		const t = (2 * sr) / (2 * w0);
		const a0 = 1 + t;
		return [(1 + alpha * t) / a0, (1 - alpha * t) / a0, (1 - t) / a0];
	}
	set(c: [number, number, number]): void {
		[this.b0, this.b1, this.a1] = c;
	}
	tick(x: number): number {
		const y = this.b0 * x + this.b1 * this.x1 - this.a1 * this.y1;
		this.x1 = x;
		this.y1 = Math.abs(y) < 1e-25 ? 0 : y;
		return y;
	}
	clear(): void {
		this.x1 = 0;
		this.y1 = 0;
	}
}

export class Binauralizer extends EffectBase {
	private readonly lines: [DelayLine, DelayLine];
	/** near-L, far-L→R, near-R, far-R→L */
	private readonly sh = [new Shadow(), new Shadow(), new Shadow(), new Shadow()];
	private readonly itd: Smoothed;
	private readonly mix: Smoothed;
	constructor(sr: number, ch: number) {
		super('jasper.audio.binauralizer', sr, ch);
		const max = Math.floor(0.002 * sr) + 4;
		this.lines = [new DelayLine(max), new DelayLine(max)];
		this.itd = sm(0, sr);
		this.mix = sm(1, sr);
		this.applyParams(true);
	}
	protected applyParams(snap: boolean): void {
		const theta = this.pv.v('angle');
		const a = (this.pv.v('headSize') * 0.01) / 2;
		const near = Shadow.coeffs(90 - theta, a, this.sampleRate);
		const far = Shadow.coeffs(90 + theta, a, this.sampleRate);
		this.sh.forEach((s, k) => s.set(k % 2 === 0 ? near : far));
		const th = (theta * Math.PI) / 180;
		this.itd.set((a / SPEED_OF_SOUND) * (th + Math.sin(th)) * this.sampleRate);
		this.mix.set(this.pv.v('mix') / 100);
		if (snap) snapAll([this.itd, this.mix]);
	}
	reset(): void {
		for (const d of this.lines) d.reset();
		for (const s of this.sh) s.clear();
		snapAll([this.itd, this.mix]);
	}
	process(ch: readonly Float32Array[], start: number, end: number): void {
		const l = ch[0];
		const r = ch[1];
		if (!l || !r) return;
		const [s0, s1, s2, s3] = this.sh as [Shadow, Shadow, Shadow, Shadow];
		for (let i = start; i < end; i++) {
			const itd = this.itd.tick();
			const mix = this.mix.tick();
			const xl = l[i]!;
			const xr = r[i]!;
			this.lines[0].push(xl);
			this.lines[1].push(xr);
			const nearL = s0.tick(xl);
			const farL = s1.tick(this.lines[0].read(itd));
			const nearR = s2.tick(xr);
			const farR = s3.tick(this.lines[1].read(itd));
			const bl = 0.5 * (nearL + farR);
			const br = 0.5 * (nearR + farL);
			l[i] = xl + mix * (bl - xl);
			r[i] = xr + mix * (br - xr);
		}
	}
}

// ---------------------------------------------------------------- ambisonics panner

export class AmbisonicsPanner extends EffectBase {
	/** out L ← in L, out L ← in R, out R ← in L, out R ← in R */
	private readonly m: Smoothed[];
	constructor(sr: number, ch: number) {
		super('jasper.audio.ambisonics-panner', sr, ch);
		this.m = [sm(1, sr), sm(0, sr), sm(0, sr), sm(1, sr)];
		this.applyParams(true);
	}

	/** `[left, right]` gains of a source at azimuth `az` (degrees, + = left) after the rotation. */
	static sourceGains(az: number, pan: number, tilt: number, roll: number): [number, number] {
		const rad = (d: number) => (d * Math.PI) / 180;
		let v: [number, number, number] = [Math.cos(rad(az)), Math.sin(rad(az)), 0];
		const rot = (w: [number, number, number], axis: number, ang: number): [number, number, number] => {
			const s = Math.sin(rad(ang));
			const c = Math.cos(rad(ang));
			const [x, y, z] = w;
			if (axis === 0) return [x, c * y - s * z, s * y + c * z];
			if (axis === 1) return [c * x + s * z, y, -s * x + c * z];
			return [c * x - s * y, s * x + c * y, z];
		};
		v = rot(v, 0, roll);
		v = rot(v, 1, tilt);
		v = rot(v, 2, pan);
		const p = Math.min(Math.max(v[1] / Math.sin(rad(30)), -1), 1);
		const a = (1 - p) * 0.5 * (Math.PI / 2);
		const att = (1 - 0.3 * Math.max(-v[0], 0)) * (1 - 0.2 * Math.abs(v[2]));
		return [Math.cos(a) * att, Math.sin(a) * att];
	}

	protected applyParams(snap: boolean): void {
		const pan = this.pv.v('pan');
		const tilt = this.pv.v('tilt');
		const roll = this.pv.v('roll');
		const [ll, rl] = AmbisonicsPanner.sourceGains(30, pan, tilt, roll);
		const [lr, rr] = AmbisonicsPanner.sourceGains(-30, pan, tilt, roll);
		const clean = (v: number) => (Math.abs(v) < 1e-6 ? 0 : Math.abs(v - 1) < 1e-6 ? 1 : v);
		[ll, lr, rl, rr].forEach((v, k) => this.m[k]!.set(clean(v)));
		if (snap) snapAll(this.m);
	}
	reset(): void {
		snapAll(this.m);
	}
	process(ch: readonly Float32Array[], start: number, end: number): void {
		const l = ch[0];
		const r = ch[1];
		if (!l || !r) return;
		const [m0, m1, m2, m3] = this.m as [Smoothed, Smoothed, Smoothed, Smoothed];
		for (let i = start; i < end; i++) {
			const a = m0.tick();
			const b = m1.tick();
			const c = m2.tick();
			const d = m3.tick();
			const x = l[i]!;
			const y = r[i]!;
			l[i] = a * x + b * y;
			r[i] = c * x + d * y;
		}
	}
}

export const STEREO_CHANNEL_PROCESSORS: Readonly<Record<string, ProcessorFactory>> = {
	'jasper.audio.amplify': (sr, ch) => new Amplify(sr, ch),
	'jasper.audio.channel-mixer': (sr, ch) => new ChannelMixer(sr, ch),
	'jasper.audio.channel-volume': (sr, ch) => new ChannelVolume(sr, ch),
	'jasper.audio.balance': (sr, ch) => new Balance(sr, ch),
	'jasper.audio.fill-left-with-right': (sr, ch) => new Route('fillLeft', sr, ch),
	'jasper.audio.fill-right-with-left': (sr, ch) => new Route('fillRight', sr, ch),
	'jasper.audio.invert': (sr, ch) => new Invert(sr, ch),
	'jasper.audio.swap-channels': (sr, ch) => new Route('swap', sr, ch),
	'jasper.audio.mono-maker': (sr, ch) => new MonoMaker(sr, ch),
	'jasper.audio.stereo-expander': (sr, ch) => new StereoExpander(sr, ch),
	'jasper.audio.stereo-width': (sr, ch) => new StereoWidth(sr, ch),
	'jasper.audio.binauralizer': (sr, ch) => new Binauralizer(sr, ch),
	'jasper.audio.ambisonics-panner': (sr, ch) => new AmbisonicsPanner(sr, ch),
};
