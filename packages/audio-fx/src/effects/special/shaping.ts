// Distortion and GuitarSuite (ported from filmcraft `effects/special.rs`).
import { Biquad, type Coeffs, designBiquad, IDENTITY } from '../../core/biquad.ts';
import { EffectBase } from '../../core/effect.ts';
import { dbToGain, linDb } from '../../core/math.ts';
import { Smoothed } from '../../core/smooth.ts';
import { coef, DcBlock, OnePole } from '../../core/util.ts';

const sm = (v: number, sr: number) => Smoothed.withMs(v, sr, 20);

/** Memoryless transfer curves with unity small-signal slope: soft clip, hard clip, tube (asymmetric), foldback. */
export function shape(kind: number, v: number): number {
	switch (kind) {
		case 0:
			return Math.tanh(v);
		case 1:
			return v < -1 ? -1 : v > 1 ? 1 : v;
		case 2:
			return v >= 0 ? Math.tanh(v) : Math.tanh(1.6 * v) / 1.6;
		default:
			return Math.sin(v);
	}
}

/** Waveshaping distortion: drive, curve, asymmetry (bias, DC-blocked), tone low-pass, output, dry/wet. */
export class Distortion extends EffectBase {
	private readonly dc: DcBlock[];
	private readonly lp: OnePole[];
	private readonly drive: Smoothed;
	private readonly bias: Smoothed;
	private readonly out: Smoothed;
	private readonly mix: Smoothed;

	constructor(sr: number, ch: number) {
		super('jasper.audio.distortion', sr, ch);
		const n = Math.max(1, ch);
		this.dc = Array.from({ length: n }, () => new DcBlock());
		this.lp = Array.from({ length: n }, () => new OnePole());
		this.drive = sm(1, sr);
		this.bias = sm(0, sr);
		this.out = sm(1, sr);
		this.mix = sm(1, sr);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		this.drive.set(dbToGain(this.pv.v('drive')));
		this.bias.set((0.5 * this.pv.v('symmetry')) / 100);
		this.out.set(dbToGain(this.pv.v('output')));
		this.mix.set(this.pv.v('mix') / 100);
		if (snap) for (const s of [this.drive, this.bias, this.out, this.mix]) s.snap();
	}

	reset(): void {
		for (const d of this.dc) d.reset();
		for (const l of this.lp) l.reset();
		for (const s of [this.drive, this.bias, this.out, this.mix]) s.snap();
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.dc.length);
		const kind = this.pv.idx('curve');
		const tone = this.pv.v('tone');
		const a = OnePole.alpha(tone, this.sampleRate);
		const r = DcBlock.r(this.sampleRate);
		for (let i = start; i < end; i++) {
			const d = this.drive.tick();
			const b = this.bias.tick();
			const o = this.out.tick();
			const m = this.mix.tick();
			const sb = shape(kind, b);
			for (let c = 0; c < nch; c++) {
				const buf = ch[c]!;
				const x = buf[i]!;
				let y = shape(kind, d * x + b) - sb;
				y = this.dc[c]!.tick(r, y);
				if (tone < 19999) y = this.lp[c]!.lp(a, y);
				buf[i] = x + m * (y * o - x);
			}
		}
	}
}

const CAB_NONE: readonly Coeffs[] = [IDENTITY, IDENTITY, IDENTITY, IDENTITY];

/** Guitar chain: compressor → distortion → amplifier/cabinet voicing → filter, with mix and output gain. */
export class GuitarSuite extends EffectBase {
	private env = 0;
	private cab: readonly Coeffs[] = CAB_NONE;
	private filt: Coeffs = IDENTITY;
	private readonly st: Biquad[][];
	private readonly dc: DcBlock[];
	private readonly mix: Smoothed;
	private readonly out: Smoothed;
	private readonly drive: Smoothed;

	constructor(sr: number, ch: number) {
		super('jasper.audio.guitar-suite', sr, ch);
		const n = Math.max(1, ch);
		this.st = Array.from({ length: n }, () => Array.from({ length: 5 }, () => new Biquad()));
		this.dc = Array.from({ length: n }, () => new DcBlock());
		this.mix = sm(1, sr);
		this.out = sm(1, sr);
		this.drive = sm(1, sr);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		const sr = this.sampleRate;
		const d = (k: Parameters<typeof designBiquad>[0], f: number, q: number, g: number) =>
			designBiquad(k, sr, f, q, g);
		switch (this.pv.idx('amp')) {
			case 0:
				this.cab = CAB_NONE;
				break;
			case 1:
				this.cab = [
					d('highPass', 70, 0.7, 0),
					d('peaking', 400, 0.8, -2),
					d('peaking', 2500, 1, 3),
					d('lowPass', 6000, 0.8, 0),
				];
				break;
			case 2:
				this.cab = [
					d('highPass', 90, 0.7, 0),
					d('peaking', 800, 0.7, 4),
					d('peaking', 3000, 1.2, 2),
					d('lowPass', 4500, 0.9, 0),
				];
				break;
			case 3:
				this.cab = [
					d('highPass', 60, 0.7, 0),
					d('lowShelf', 200, 0.7, 3),
					d('peaking', 1200, 0.8, 2),
					d('lowPass', 4000, 0.7, 0),
				];
				break;
			default:
				this.cab = [
					d('highPass', 100, 0.8, 0),
					d('peaking', 500, 1, -5),
					d('peaking', 2000, 0.8, 5),
					d('lowPass', 5000, 1, 0),
				];
		}
		const q = 0.5 + (7.5 * this.pv.v('filterRes')) / 100;
		const f = this.pv.v('filterFreq');
		const filter = this.pv.idx('filter');
		this.filt =
			filter === 1
				? d('lowPass', f, q, 0)
				: filter === 2
					? d('highPass', f, q, 0)
					: filter === 3
						? d('bandPass', f, q, 0)
						: IDENTITY;
		this.mix.set(this.pv.v('mix') / 100);
		this.out.set(dbToGain(this.pv.v('output')));
		this.drive.set(dbToGain((36 * this.pv.v('distortion')) / 100));
		if (snap) for (const s of [this.mix, this.out, this.drive]) s.snap();
	}

	reset(): void {
		this.env = 0;
		for (const s of this.st) for (const b of s) b.reset();
		for (const d of this.dc) d.reset();
		for (const s of [this.mix, this.out, this.drive]) s.snap();
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.st.length);
		const comp = this.pv.v('compressor') / 100;
		const thr = -6 - 30 * comp;
		const ratio = 1 + 7 * comp;
		const att = coef(5, this.sampleRate);
		const rel = coef(120, this.sampleRate);
		const kind = Math.min(this.pv.idx('distType'), 2);
		const r = DcBlock.r(this.sampleRate);
		const t03 = Math.tanh(0.3);
		for (let i = start; i < end; i++) {
			const mix = this.mix.tick();
			const out = this.out.tick();
			const drive = this.drive.tick();
			let peak = 0;
			for (let c = 0; c < nch; c++) peak = Math.max(peak, Math.abs(ch[c]![i]!));
			const l = linDb(peak);
			const target = comp > 0 && l > thr ? thr + (l - thr) / ratio - l : 0;
			const c0 = target < this.env ? att : rel;
			this.env = c0 * this.env + (1 - c0) * target;
			if (Math.abs(this.env) < 1e-7) this.env = 0;
			const g = dbToGain(this.env);
			// Distortion level compensation keeps the output near the input level.
			const compOut = 1 / Math.sqrt(drive);
			for (let c = 0; c < nch; c++) {
				const buf = ch[c]!;
				const x = buf[i]!;
				const v = x * g * drive;
				let y =
					(kind === 0
						? Math.tanh(v)
						: kind === 1
							? v < -1
								? -1
								: v > 1
									? 1
									: v
							: Math.tanh(v + 0.3) - t03 + 0.5 * Math.tanh(2 * v)) * compOut;
				y = this.dc[c]!.tick(r, y);
				const st = this.st[c]!;
				for (let k = 0; k < 4; k++) y = st[k]!.tick(this.cab[k]!, y);
				y = st[4]!.tick(this.filt, y);
				buf[i] = x + mix * (y * out - x);
			}
		}
	}
}
