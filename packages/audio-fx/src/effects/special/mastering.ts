// Mastering, Vocal Enhancer, Loudness Meter, Mute (ported from filmcraft `effects/special.rs`) and Loudness Auto Gain
// (ours).
import { defaultChannelWeights, kPrefilter, kRlb, LoudnessMeter } from '@jasper/audio-dsp';
import { Biquad, type Coeffs, designBiquad, IDENTITY, magnitudeDb } from '../../core/biquad.ts';
import { EffectBase } from '../../core/effect.ts';
import { dbToGain, linDb } from '../../core/math.ts';
import { Smoothed } from '../../core/smooth.ts';
import { coef, OnePole } from '../../core/util.ts';
import { softClip } from '../dynamics/curves.ts';
import { FdnReverb } from '../reverb/fdn.ts';

const CHUNK = 256;
const sm = (v: number, sr: number) => Smoothed.withMs(v, sr, 20);

/** Mastering chain: three-band EQ → reverb → exciter → widener → loudness maximiser → output (transparent at defaults). */
export class Mastering extends EffectBase {
	private eq: Coeffs[] = [IDENTITY, IDENTITY, IDENTITY];
	private readonly st: Biquad[][];
	private readonly rev: FdnReverb;
	private readonly scratch = [new Float32Array(CHUNK), new Float32Array(CHUNK)] as const;
	private readonly hp: OnePole[];
	private limEnv = 0;
	private readonly revAmt: Smoothed;
	private readonly exc: Smoothed;
	private readonly width: Smoothed;
	private readonly boost: Smoothed;
	private readonly out: Smoothed;
	private readonly y: Float64Array;

	constructor(sr: number, ch: number) {
		super('jasper.audio.mastering', sr, ch);
		const n = Math.max(1, ch);
		this.y = new Float64Array(n);
		this.st = Array.from({ length: n }, () => [new Biquad(), new Biquad(), new Biquad()]);
		this.rev = new FdnReverb(sr);
		this.rev.set({ preDelay: 20, decay: 1.4, damping: 40, size: 40, mix: 100 }, true);
		this.hp = Array.from({ length: n }, () => new OnePole());
		this.revAmt = sm(0, sr);
		this.exc = sm(0, sr);
		this.width = sm(1, sr);
		this.boost = sm(1, sr);
		this.out = sm(1, sr);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		const sr = this.sampleRate;
		const q = Math.SQRT1_2;
		this.eq = [
			designBiquad('lowShelf', sr, 100, q, this.pv.v('eqLow')),
			designBiquad('peaking', sr, this.pv.v('eqMidFreq'), 1, this.pv.v('eqMid')),
			designBiquad('highShelf', sr, 8000, q, this.pv.v('eqHigh')),
		];
		this.revAmt.set((0.4 * this.pv.v('reverb')) / 100);
		this.exc.set((0.6 * this.pv.v('exciter')) / 100);
		this.width.set(this.pv.v('widener') / 100);
		this.boost.set(dbToGain((12 * this.pv.v('loudness')) / 100));
		this.out.set(dbToGain(this.pv.v('output')));
		if (snap) for (const s of [this.revAmt, this.exc, this.width, this.boost, this.out]) s.snap();
	}

	responseDb(freq: number): number {
		let db = this.pv.v('output');
		for (const c of this.eq) db += magnitudeDb(c, freq, this.sampleRate);
		return db;
	}

	reset(): void {
		for (const s of this.st) for (const b of s) b.reset();
		this.rev.clear();
		this.rev.set({ preDelay: 20, decay: 1.4, damping: 40, size: 40, mix: 100 }, true);
		for (const h of this.hp) h.reset();
		this.limEnv = 0;
		for (const s of [this.revAmt, this.exc, this.width, this.boost, this.out]) s.snap();
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.st.length);
		if (nch === 0) return;
		const n2 = Math.min(nch, 2);
		const loud = this.pv.v('loudness') > 0;
		const useRev = this.pv.v('reverb') > 0;
		const mode = this.pv.idx('exciterMode');
		const ahp = OnePole.alpha(3000, this.sampleRate);
		const ceiling = dbToGain(-0.3);
		const ceilDb = linDb(ceiling);
		const rel = coef(60, this.sampleRate);
		const t02 = Math.tanh(0.2);
		const [s0, s1] = this.scratch;
		const y = this.y;
		for (let a = start; a < end; a += CHUNK) {
			const len = Math.min(CHUNK, end - a);
			for (let c = 0; c < nch; c++) {
				const buf = ch[c]!;
				const st = this.st[c]!;
				for (let i = a; i < a + len; i++) {
					let v = buf[i]!;
					v = st[0]!.tick(this.eq[0]!, v);
					v = st[1]!.tick(this.eq[1]!, v);
					v = st[2]!.tick(this.eq[2]!, v);
					buf[i] = v;
				}
			}
			if (useRev) {
				for (let i = 0; i < len; i++) {
					s0[i] = ch[0]![a + i]!;
					s1[i] = ch[n2 - 1]![a + i]!;
				}
				this.rev.process([s0, s1], 0, len);
			}
			for (let i = 0; i < len; i++) {
				const ra = this.revAmt.tick();
				const ex = this.exc.tick();
				const w = this.width.tick();
				const boost = this.boost.tick();
				const out = this.out.tick();
				// Every channel gets the exciter, the maximiser and the output gain (5.1 too); reverb and widener
				// work on the L/R pair.
				for (let c = 0; c < nch; c++) {
					let v = ch[c]![a + i]!;
					if (useRev && c < n2) v += ra * (c === 0 ? s0[i]! : s1[i]!);
					if (ex > 0) {
						const h = this.hp[c]!.hp(ahp, v);
						const s =
							mode === 0
								? Math.min(Math.max(3 * h, -1), 1) / 3
								: mode === 1
									? Math.tanh(3 * h) / 3
									: (Math.tanh(3 * h + 0.2) - t02) / 3;
						v += ex * (s - h * 0.5) * 2;
					}
					y[c] = v;
				}
				if (nch >= 2) {
					const m = 0.5 * (y[0]! + y[1]!);
					const s = 0.5 * (y[0]! - y[1]!) * w;
					y[0] = m + s;
					y[1] = m - s;
				}
				if (loud) {
					let peak = 0;
					for (let c = 0; c < nch; c++) {
						y[c] = y[c]! * boost;
						peak = Math.max(peak, Math.abs(y[c]!));
					}
					const target = Math.min(ceilDb - linDb(peak), 0);
					this.limEnv = target < this.limEnv ? target : rel * this.limEnv + (1 - rel) * target;
					const g = dbToGain(this.limEnv);
					for (let c = 0; c < nch; c++) y[c] = softClip(y[c]! * g, ceiling);
				}
				for (let c = 0; c < nch; c++) ch[c]![a + i] = y[c]! * out;
			}
		}
	}
}

/**
 * Vocal Enhancer: fixed voicings — Male / Female (rumble cut, de-mud, presence and air, gentle 2:1 compression above
 * −18 dBFS) or Music (carves the vocal presence range so a voice sits on top).
 */
export class VocalEnhancer extends EffectBase {
	private eq: Coeffs[] = [IDENTITY, IDENTITY, IDENTITY, IDENTITY];
	private readonly st: Biquad[][];
	private env = 0;

	constructor(sr: number, ch: number) {
		super('jasper.audio.vocal-enhancer', sr, ch);
		this.st = Array.from({ length: Math.max(1, ch) }, () => Array.from({ length: 4 }, () => new Biquad()));
		this.applyParams();
	}

	protected applyParams(): void {
		const sr = this.sampleRate;
		const d = (k: Parameters<typeof designBiquad>[0], f: number, q: number, g: number) =>
			designBiquad(k, sr, f, q, g);
		const m = this.pv.idx('mode');
		this.eq =
			m === 0
				? [
						d('highPass', 80, Math.SQRT1_2, 0),
						d('peaking', 250, 1, -3),
						d('peaking', 3000, 1, 3),
						d('highShelf', 10000, Math.SQRT1_2, 1.5),
					]
				: m === 1
					? [
							d('highPass', 120, Math.SQRT1_2, 0),
							d('peaking', 400, 1, -2),
							d('peaking', 5000, 1, 3),
							d('highShelf', 10000, Math.SQRT1_2, 2),
						]
					: [
							d('highPass', 40, Math.SQRT1_2, 0),
							d('peaking', 1500, 0.7, -4),
							d('peaking', 3500, 1, -2),
							IDENTITY,
						];
	}

	responseDb(freq: number): number {
		let db = 0;
		for (const c of this.eq) db += magnitudeDb(c, freq, this.sampleRate);
		return db;
	}

	reset(): void {
		for (const s of this.st) for (const b of s) b.reset();
		this.env = 0;
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.st.length);
		const voice = this.pv.idx('mode') < 2;
		const att = coef(5, this.sampleRate);
		const rel = coef(150, this.sampleRate);
		for (let i = start; i < end; i++) {
			let peak = 0;
			for (let c = 0; c < nch; c++) {
				const st = this.st[c]!;
				let y = ch[c]![i]!;
				for (let k = 0; k < 4; k++) y = st[k]!.tick(this.eq[k]!, y);
				ch[c]![i] = y;
				peak = Math.max(peak, Math.abs(y));
			}
			if (voice) {
				const l = linDb(peak);
				const target = l > -18 ? -18 + (l + 18) / 2 - l : 0;
				const c0 = target < this.env ? att : rel;
				this.env = c0 * this.env + (1 - c0) * target;
				if (Math.abs(this.env) < 1e-7) this.env = 0;
				const g = dbToGain(this.env);
				for (let c = 0; c < nch; c++) ch[c]![i] = ch[c]![i]! * g;
			}
		}
	}
}

/** Pass-through BS.1770 / R128 meter at its insert point (@jasper/audio-dsp LoudnessMeter). */
export class LoudnessMeterFx extends EffectBase {
	readonly meter: LoudnessMeter;
	private readonly view: Float32Array[] = [];

	constructor(sr: number, ch: number) {
		super('jasper.audio.loudness-meter', sr, ch);
		// Every channel, with the BS.1770 weights of its layout (5.1: LFE excluded, surrounds +1.5 dB).
		this.meter = new LoudnessMeter(sr, Math.max(ch, 1));
	}

	protected applyParams(): void {}

	/** [momentary, short-term, integrated (LUFS), loudness range (LU), true peak (dBTP), target (LUFS)]. */
	meters(): number[] {
		return [
			this.meter.momentary(),
			this.meter.shortTerm(),
			this.meter.integrated(),
			this.meter.loudnessRange(),
			this.meter.truePeakDb(),
			this.pv.v('target'),
		];
	}

	reset(): void {
		this.meter.reset();
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.meter.channels);
		if (nch === 0 || end <= start) return;
		this.view.length = nch;
		for (let c = 0; c < nch; c++) this.view[c] = ch[c]!;
		this.meter.process(this.view, start, end - start);
	}
}

/** Mute with a 5 ms ramp (keyframe it to silence passages without clicks). */
export class Mute extends EffectBase {
	private readonly g: Smoothed;
	constructor(sr: number, ch: number) {
		super('jasper.audio.mute', sr, ch);
		this.g = Smoothed.withMs(1, sr, 5);
		this.applyParams(true);
	}
	protected applyParams(snap: boolean): void {
		this.g.set(this.pv.on('mute') ? 0 : 1);
		if (snap) this.g.snap();
	}
	reset(): void {
		this.g.snap();
	}
	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.channels);
		for (let i = start; i < end; i++) {
			const g = this.g.tick();
			for (let c = 0; c < nch; c++) ch[c]![i] = ch[c]![i]! * g;
		}
	}
}

/**
 * Loudness Auto Gain: K-weighted (BS.1770) mean square over a sliding 3 s window, updated every sample, gives the
 * short-term loudness L; the gain moves toward `target − L` (limited to +Max Boost / −Max Cut) with a one-pole of the
 * Response time, holds while L is below the silence threshold, and is capped so the gained sample peak (fast-attack,
 * 50 ms-release follower) stays under the Peak Ceiling, with a final clamp. No look-ahead (latency 0).
 */
export class AutoGain extends EffectBase {
	private readonly pre: Coeffs;
	private readonly rlb: Coeffs;
	private readonly kf: [Biquad, Biquad][];
	private readonly ring: Float64Array;
	private ringPos = 0;
	private filled = 0;
	private sum = 0;
	private gainDb = 0;
	private peak = 0;
	private sinceResum = 0;
	private resp = 0;
	private readonly peakRel: number;
	/** BS.1770 channel weights (5.1: LFE excluded, surrounds +1.5 dB), as the loudness meters use. */
	private readonly weights: number[];

	constructor(sr: number, ch: number) {
		super('jasper.audio.auto-gain', sr, ch);
		this.pre = kPrefilter(sr);
		this.rlb = kRlb(sr);
		this.kf = Array.from({ length: Math.max(1, Math.min(ch, 8)) }, () => [new Biquad(), new Biquad()]);
		this.weights = defaultChannelWeights(this.kf.length);
		this.ring = new Float64Array(Math.round(3 * sr));
		this.peakRel = coef(50, sr);
		this.applyParams();
	}

	protected applyParams(): void {
		this.resp = coef(this.pv.v('response'), this.sampleRate);
	}

	/** Current applied gain (dB). */
	meters(): number[] {
		return [this.gainDb];
	}

	reset(): void {
		for (const [a, b] of this.kf) {
			a.reset();
			b.reset();
		}
		this.ring.fill(0);
		this.ringPos = 0;
		this.filled = 0;
		this.sum = 0;
		this.gainDb = 0;
		this.peak = 0;
		this.sinceResum = 0;
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.kf.length);
		if (nch === 0) return;
		const target = this.pv.v('target');
		const maxBoost = this.pv.v('maxBoost');
		const maxCut = this.pv.v('maxCut');
		const silence = this.pv.v('silence');
		const ceiling = dbToGain(this.pv.v('ceiling'));
		const W = this.ring.length;
		for (let i = start; i < end; i++) {
			let z = 0;
			let pk = 0;
			for (let c = 0; c < nch; c++) {
				const x = ch[c]![i]!;
				const [a, b] = this.kf[c]!;
				const y = b.tick(this.rlb, a.tick(this.pre, x));
				z += this.weights[c]! * y * y;
				pk = Math.max(pk, Math.abs(x));
			}
			this.sum += z - this.ring[this.ringPos]!;
			this.ring[this.ringPos] = z;
			this.ringPos = this.ringPos + 1 === W ? 0 : this.ringPos + 1;
			if (this.filled < W) this.filled++;
			if (++this.sinceResum >= 65536) {
				this.sinceResum = 0;
				let s = 0;
				for (let k = 0; k < W; k++) s += this.ring[k]!;
				this.sum = s;
			}
			const ms = Math.max(this.sum, 0) / this.filled;
			const lufs = ms > 0 ? -0.691 + 10 * Math.log10(ms) : Number.NEGATIVE_INFINITY;
			if (lufs > silence) {
				const want = Math.min(Math.max(target - lufs, -maxCut), maxBoost);
				this.gainDb = this.resp * this.gainDb + (1 - this.resp) * want;
				if (Math.abs(this.gainDb) < 1e-9) this.gainDb = 0;
			}
			this.peak = pk > this.peak ? pk : this.peakRel * this.peak + (1 - this.peakRel) * pk;
			let g = dbToGain(this.gainDb);
			if (this.peak * g > ceiling) g = ceiling / this.peak;
			for (let c = 0; c < nch; c++) {
				const y = ch[c]![i]! * g;
				ch[c]![i] = y > ceiling ? ceiling : y < -ceiling ? -ceiling : y;
			}
		}
	}
}
