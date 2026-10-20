// Surround Reverb (ported from filmcraft `effects/reverbs.rs`): early reflections (8 taps, alternating sides) plus the
// FDN late field, low/high cut on the wet signal, wet width, separate dry/wet levels; Center Input sets how much of
// the mid (L+R) signal feeds the reverb.
import { EffectBase } from '../../core/effect.ts';
import { Smoothed } from '../../core/smooth.ts';
import { DelayLine, OnePole } from '../../core/util.ts';
import { FdnReverb } from './fdn.ts';

const ER_TAPS = 8;
const ER_MS = [7.1, 11.3, 15.7, 19.9, 24.2, 31.7, 38.3, 47.9];
const ER_GAIN = [0.8, -0.7, 0.62, -0.55, 0.47, -0.4, 0.33, -0.27];
const CHUNK = 256;

export class SurroundReverb extends EffectBase {
	private readonly late: FdnReverb;
	private readonly er: DelayLine;
	private readonly lc = [new OnePole(), new OnePole()];
	private readonly hc = [new OnePole(), new OnePole()];
	private readonly scratch = [new Float32Array(CHUNK), new Float32Array(CHUNK)] as const;
	/** Dry level per sample of the current chunk (applied to the channels beyond L/R). */
	private readonly dryAt = new Float64Array(CHUNK);
	private readonly dry: Smoothed;
	private readonly wet: Smoothed;
	private readonly early: Smoothed;
	private readonly width: Smoothed;
	private readonly centre: Smoothed;
	private readonly size: Smoothed;

	constructor(sr: number, ch: number) {
		super('jasper.audio.surround-reverb', sr, ch);
		this.late = new FdnReverb(sr);
		this.er = new DelayLine(Math.floor(0.1 * sr));
		const sm = (v: number) => Smoothed.withMs(v, sr, 20);
		this.dry = sm(1);
		this.wet = sm(0);
		this.early = sm(0);
		this.width = sm(1);
		this.centre = sm(1);
		this.size = sm(1);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		this.late.set(
			{
				preDelay: this.pv.v('preDelay'),
				decay: this.pv.v('decay'),
				damping: this.pv.v('damping'),
				size: this.pv.v('roomSize'),
				mix: 100,
			},
			snap,
		);
		this.dry.set(this.pv.v('dry') / 100);
		this.wet.set(this.pv.v('wet') / 100);
		this.early.set(this.pv.v('early') / 100);
		this.width.set(this.pv.v('width') / 100);
		this.centre.set(this.pv.v('centerInput') / 100);
		this.size.set(0.5 + this.pv.v('roomSize') / 100);
		if (snap) {
			this.late.clear();
			for (const s of [this.dry, this.wet, this.early, this.width, this.centre, this.size]) s.snap();
		}
	}

	reset(): void {
		this.late.clear();
		this.applyParams(true);
		this.er.reset();
		for (const f of [...this.lc, ...this.hc]) f.reset();
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		// Channels beyond the configured count are left alone (another processor's).
		const all = Math.min(ch.length, this.channels);
		const nch = Math.min(all, 2);
		if (nch === 0) return;
		const alc = OnePole.alpha(this.pv.v('lowCut'), this.sampleRate);
		const ahc = OnePole.alpha(this.pv.v('highCut'), this.sampleRate);
		const ms = this.sampleRate * 0.001;
		const L = ch[0]!;
		const R = nch === 2 ? ch[1]! : ch[0]!;
		// 5.1 (L R C LFE Ls Rs): the centre channel feeds the reverb with the L/R mid (Center Input); every channel
		// beyond L/R gets the Dry level, so Dry and Wet act on the whole signal.
		const C = all >= 3 ? ch[2]! : null;
		const [s0, s1] = this.scratch;
		const dryAt = this.dryAt;
		for (let a = start; a < end; a += CHUNK) {
			const len = Math.min(CHUNK, end - a);
			for (let i = 0; i < len; i++) {
				const l = L[a + i]!;
				const r = R[a + i]!;
				const c = this.centre.tick();
				const mid = 0.5 * (l + r) + (C ? Math.SQRT1_2 * C[a + i]! : 0);
				const side = 0.5 * (l - r);
				s0[i] = c * mid + side;
				s1[i] = c * mid - side;
			}
			this.late.process([s0, s1], 0, len);
			for (let i = 0; i < len; i++) {
				const x = nch === 2 ? 0.5 * (L[a + i]! + R[a + i]!) : L[a + i]!;
				const size = this.size.tick();
				this.er.push(x);
				let el = 0;
				let er = 0;
				for (let k = 0; k < ER_TAPS; k++) {
					const v = ER_GAIN[k]! * this.er.read(ER_MS[k]! * size * ms);
					if (k % 2 === 0) el += v;
					else er += v;
				}
				const early = this.early.tick();
				const dry = this.dry.tick();
				dryAt[i] = dry;
				const wet = this.wet.tick();
				const width = this.width.tick();
				const w0 = this.hc[0]!.lp(ahc, this.lc[0]!.hp(alc, s0[i]! + early * el));
				const w1 = this.hc[1]!.lp(ahc, this.lc[1]!.hp(alc, s1[i]! + early * er));
				const m = 0.5 * (w0 + w1);
				if (nch === 2) {
					L[a + i] = dry * L[a + i]! + wet * (m + width * (w0 - m));
					R[a + i] = dry * R[a + i]! + wet * (m + width * (w1 - m));
				} else L[a + i] = dry * L[a + i]! + wet * m;
			}
			for (let k = 2; k < all; k++) {
				const x = ch[k]!;
				for (let i = 0; i < len; i++) x[a + i] = dryAt[i]! * x[a + i]!;
			}
		}
	}
}
