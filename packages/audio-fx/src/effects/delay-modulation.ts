// "Delay and Echo" and "Modulation" DSP (catalogue: packages/project/src/registry/audio/delay-modulation.ts), ported
// from filmcraft `effects/time.rs` Delay and `effects/modulation.rs`. Modulated delays read with linear
// interpolation; feedback loops are bounded (|g| < 1, or saturating for the Analog Delay).
import { EffectBase, type ProcessorFactory } from '../core/effect.ts';
import { dbToGain, flush32 } from '../core/math.ts';
import { Smoothed } from '../core/smooth.ts';
import { AllPass1, coef, DelayLine, Envelope, Lfo, OnePole, uniSine, uniTri } from '../core/util.ts';

const SM = 20;
const snapAll = (xs: readonly Smoothed[]) => {
	for (const s of xs) s.snap();
};

/** Quarter notes per division (order of DELAY_DIVISIONS). */
const DIVISION_QUARTERS = [4, 2, 1, 0.5, 0.25, 1.5, 0.75, 2 / 3, 1 / 3];

/** Delay time (ms) for a tempo and division index. */
export function tempoDelayMs(bpm: number, division: number): number {
	return (
		(60_000 / Math.max(bpm, 1)) *
		DIVISION_QUARTERS[Math.min(Math.max(division, 0), DIVISION_QUARTERS.length - 1)]!
	);
}

/** Feedback delay per channel, time in ms or tempo-synced; the time glides (100 ms) instead of clicking. */
export class Delay extends EffectBase {
	/** Longest delay: a whole note at the slowest tempo (20 BPM: 12 s); the Time mode stops at 2 s. */
	static readonly MAX_MS = tempoDelayMs(20, 0);
	private readonly lines: DelayLine[];
	private readonly time: Smoothed;
	private readonly feedback: Smoothed;
	private readonly mix: Smoothed;

	constructor(sr: number, ch: number) {
		super('jasper.audio.delay', sr, ch);
		const len = Math.floor(Delay.MAX_MS * 0.001 * sr) + 4;
		this.lines = Array.from({ length: Math.max(1, ch) }, () => new DelayLine(len));
		this.time = Smoothed.withMs(1, sr, 100);
		this.feedback = Smoothed.withMs(0, sr, SM);
		this.mix = Smoothed.withMs(0, sr, SM);
		this.applyParams(true);
	}

	/** Effective delay (ms) at the current settings. */
	delayMs(): number {
		const ms =
			this.pv.idx('mode') === 1 ? tempoDelayMs(this.pv.v('bpm'), this.pv.idx('division')) : this.pv.v('time');
		return Math.min(ms, Delay.MAX_MS);
	}

	protected applyParams(snap: boolean): void {
		this.time.set(this.delayMs() * 0.001 * this.sampleRate);
		this.feedback.set(this.pv.v('feedback') / 100);
		this.mix.set(this.pv.v('mix') / 100);
		if (snap) snapAll([this.time, this.feedback, this.mix]);
	}

	reset(): void {
		for (const l of this.lines) l.reset();
		snapAll([this.time, this.feedback, this.mix]);
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.lines.length);
		for (let i = start; i < end; i++) {
			const d = Math.max(1, this.time.tick());
			const fb = this.feedback.tick();
			const mix = this.mix.tick();
			for (let c = 0; c < nch; c++) {
				const buf = ch[c]!;
				const x = buf[i]!;
				const line = this.lines[c]!;
				const yd = line.read(d - 1);
				line.push(x + fb * yd);
				buf[i] = x + mix * (yd - x);
			}
		}
	}
}

/** Chorus (three modulated voices, 15–35 ms) or flanger (one voice, 0.3–5 ms, feedback). */
export class ChorusFlanger extends EffectBase {
	private readonly lines: DelayLine[];
	private readonly lfo = new Lfo();
	private readonly fb: Float64Array;
	private readonly fast: Envelope[];
	private readonly slow: Envelope[];
	private readonly mix: Smoothed;
	private readonly width: Smoothed;
	private readonly intensity: Smoothed;
	private speed = 1;

	constructor(sr: number, ch: number) {
		super('jasper.audio.chorus-flanger', sr, ch);
		const n = Math.max(1, ch);
		this.lines = Array.from({ length: n }, () => new DelayLine(Math.floor(0.05 * sr)));
		this.fb = new Float64Array(n);
		this.fast = Array.from({ length: n }, () => new Envelope());
		this.slow = Array.from({ length: n }, () => new Envelope());
		this.mix = Smoothed.withMs(0, sr, SM);
		this.width = Smoothed.withMs(0, sr, SM);
		this.intensity = Smoothed.withMs(0, sr, SM);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		this.mix.set(this.pv.v('mix') / 100);
		this.width.set(this.pv.v('width') / 100);
		this.intensity.set(this.pv.v('intensity') / 100);
		this.speed = this.pv.v('speed');
		if (snap) snapAll([this.mix, this.width, this.intensity]);
	}

	reset(): void {
		for (const l of this.lines) l.reset();
		this.lfo.reset();
		this.fb.fill(0);
		for (const e of [...this.fast, ...this.slow]) e.reset();
		snapAll([this.mix, this.width, this.intensity]);
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.lines.length);
		const flanger = this.pv.idx('mode') === 1;
		const trans = this.pv.v('transience') / 100;
		const sr = this.sampleRate;
		const ms = sr * 0.001;
		const fa = coef(0.5, sr);
		const fr = coef(20, sr);
		const sa = coef(30, sr);
		const sr2 = coef(200, sr);
		for (let i = start; i < end; i++) {
			const mix = this.mix.tick();
			const width = this.width.tick();
			const inten = this.intensity.tick();
			for (let c = 0; c < nch; c++) {
				const buf = ch[c]!;
				const x = buf[i]!;
				const off = c * 0.25;
				const line = this.lines[c]!;
				let wet: number;
				if (flanger) {
					wet = line.read((0.3 + 4.7 * width * uniTri(this.lfo.phase(off))) * ms);
				} else {
					let acc = 0;
					for (let v = 0; v < 3; v++)
						acc += line.read((15 + 20 * width * uniSine(this.lfo.phase(off + v / 3))) * ms);
					wet = acc / 3;
				}
				this.fb[c] = wet;
				const g = flanger ? 0.95 * inten : 0.6 * inten;
				line.push(x + g * wet);
				let w = wet;
				if (trans > 0) {
					const a = Math.abs(x);
					const f = this.fast[c]!.tick(fa, fr, a);
					const s = this.slow[c]!.tick(sa, sr2, a);
					const boost = s > 1e-9 ? Math.min(Math.max((f - s) / s, 0), 2) : 0;
					w *= 1 + trans * boost;
				}
				buf[i] = x + mix * (w - x);
			}
			this.lfo.advance(this.speed, sr);
		}
	}
}

/**
 * Classic flanger: the delay sweeps between the initial and final delay; stereo phasing offsets the right channel's
 * LFO; feedback, inverted and "special effects" (normal minus inverted sweep) modes.
 */
export class Flanger extends EffectBase {
	private readonly lines: DelayLine[];
	private readonly lfo = new Lfo();
	private readonly d0: Smoothed;
	private readonly d1: Smoothed;
	private readonly fb: Smoothed;
	private readonly mix: Smoothed;

	constructor(sr: number, ch: number) {
		super('jasper.audio.flanger', sr, ch);
		this.lines = Array.from({ length: Math.max(1, ch) }, () => new DelayLine(Math.floor(0.025 * sr)));
		this.d0 = Smoothed.withMs(0, sr, SM);
		this.d1 = Smoothed.withMs(0, sr, SM);
		this.fb = Smoothed.withMs(0, sr, SM);
		this.mix = Smoothed.withMs(0, sr, SM);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		const ms = this.sampleRate * 0.001;
		this.d0.set(this.pv.v('initialDelay') * ms);
		this.d1.set(this.pv.v('finalDelay') * ms);
		this.fb.set((0.95 * this.pv.v('feedback')) / 100);
		this.mix.set(this.pv.v('mix') / 100);
		if (snap) snapAll([this.d0, this.d1, this.fb, this.mix]);
	}

	reset(): void {
		for (const l of this.lines) l.reset();
		this.lfo.reset();
		snapAll([this.d0, this.d1, this.fb, this.mix]);
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.lines.length);
		const sine = this.pv.on('sinusoidal');
		const inv = this.pv.on('inverted') ? -1 : 1;
		const special = this.pv.on('special');
		const phasing = this.pv.v('stereoPhasing') / 360;
		const rate = this.pv.v('rate');
		for (let i = start; i < end; i++) {
			const d0 = this.d0.tick();
			const d1 = this.d1.tick();
			const fb = this.fb.tick();
			const mix = this.mix.tick();
			for (let c = 0; c < nch; c++) {
				const buf = ch[c]!;
				const x = buf[i]!;
				const p = this.lfo.phase(c === 1 ? phasing : 0);
				const line = this.lines[c]!;
				const shape = sine ? uniSine(p) : uniTri(p);
				const y = line.read(d0 + (d1 - d0) * shape);
				let wet = y;
				if (special) {
					const q = (p + 0.5) % 1;
					const y2 = line.read(d0 + (d1 - d0) * (sine ? uniSine(q) : uniTri(q)));
					wet = 0.5 * (y - y2) + 0.5 * y;
				}
				line.push(x + fb * y);
				buf[i] = x + mix * (inv * wet - x);
			}
			this.lfo.advance(rate, this.sampleRate);
		}
	}
}

const MAX_STAGES = 12;

/** Swept cascade of first-order all-pass stages with feedback. */
export class Phaser extends EffectBase {
	private readonly ap: AllPass1[][];
	private readonly coefs: Float64Array;
	private readonly fbs: Float64Array;
	private readonly lfo = new Lfo();
	private counter = 0;
	private readonly intensity: Smoothed;
	private readonly mix: Smoothed;
	private readonly fb: Smoothed;
	private readonly out: Smoothed;

	constructor(sr: number, ch: number) {
		super('jasper.audio.phaser', sr, ch);
		const n = Math.max(1, ch);
		this.ap = Array.from({ length: n }, () => Array.from({ length: MAX_STAGES }, () => new AllPass1()));
		this.coefs = new Float64Array(n);
		this.fbs = new Float64Array(n);
		this.intensity = Smoothed.withMs(0, sr, SM);
		this.mix = Smoothed.withMs(0, sr, SM);
		this.fb = Smoothed.withMs(0, sr, SM);
		this.out = Smoothed.withMs(1, sr, SM);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		this.intensity.set(this.pv.v('intensity') / 100);
		this.mix.set(this.pv.v('mix') / 100);
		this.fb.set((0.9 * this.pv.v('feedback')) / 100);
		this.out.set(dbToGain(this.pv.v('output')));
		if (snap) snapAll([this.intensity, this.mix, this.fb, this.out]);
	}

	/** Centre frequency (Hz) of the sweep for an LFO phase: down from the upper frequency by up to 6 octaves. */
	sweepHz(phase: number): number {
		return this.pv.v('upperFreq') * 2 ** (-6 * (this.pv.v('depth') / 100) * uniSine(phase));
	}

	reset(): void {
		for (const a of this.ap) for (const s of a) s.reset();
		this.fbs.fill(0);
		this.lfo.reset();
		this.counter = 0;
		snapAll([this.intensity, this.mix, this.fb, this.out]);
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.ap.length);
		const stages = Math.min(Math.max(Math.floor(Math.round(this.pv.v('stages')) / 2) * 2, 2), MAX_STAGES);
		const diff = this.pv.v('phaseDiff') / 360;
		const rate = this.pv.v('rate');
		for (let i = start; i < end; i++) {
			if (this.counter === 0)
				for (let c = 0; c < nch; c++)
					this.coefs[c] = AllPass1.coef(this.sweepHz(this.lfo.phase(c === 1 ? diff : 0)), this.sampleRate);
			this.counter = (this.counter + 1) % 8;
			const inten = this.intensity.tick();
			const mix = this.mix.tick();
			const fb = this.fb.tick();
			const out = this.out.tick();
			for (let c = 0; c < nch; c++) {
				const buf = ch[c]!;
				const x = buf[i]!;
				const a = this.coefs[c]!;
				let y = x + fb * this.fbs[c]!;
				const st = this.ap[c]!;
				for (let k = 0; k < stages; k++) y = st[k]!.tick(a, y);
				this.fbs[c] = flush32(y);
				const wet = x + inten * (y - x);
				buf[i] = (x + mix * (wet - x)) * out;
			}
			this.lfo.advance(rate, this.sampleRate);
		}
	}
}

/**
 * Delay with a coloured, saturating feedback path (tape / tape+tube / bucket-brigade style low-pass and soft
 * clipping) and stereo spread.
 */
export class AnalogDelay extends EffectBase {
	static readonly MAX_MS = 8000;
	private readonly lines: DelayLine[];
	private readonly lp: OnePole[];
	private readonly time: Smoothed;
	private readonly dry: Smoothed;
	private readonly wet: Smoothed;
	private readonly fb: Smoothed;
	private readonly drive: Smoothed;
	private readonly spread: Smoothed;

	constructor(sr: number, ch: number) {
		super('jasper.audio.analog-delay', sr, ch);
		const n = Math.max(1, ch);
		const max = Math.floor(AnalogDelay.MAX_MS * 1.5 * 0.001 * sr) + 4;
		this.lines = Array.from({ length: n }, () => new DelayLine(max));
		this.lp = Array.from({ length: n }, () => new OnePole());
		this.time = Smoothed.withMs(1, sr, 100);
		this.dry = Smoothed.withMs(1, sr, SM);
		this.wet = Smoothed.withMs(0, sr, SM);
		this.fb = Smoothed.withMs(0, sr, SM);
		this.drive = Smoothed.withMs(1, sr, SM);
		this.spread = Smoothed.withMs(0, sr, SM);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		this.time.set(this.pv.v('delay') * 0.001 * this.sampleRate);
		this.dry.set(this.pv.v('dry') / 100);
		this.wet.set(this.pv.v('wet') / 100);
		this.fb.set(this.pv.v('feedback') / 100);
		this.drive.set(1 + (4 * this.pv.v('trash')) / 100);
		this.spread.set(this.pv.v('spread') / 100);
		if (snap) snapAll([this.time, this.dry, this.wet, this.fb, this.drive, this.spread]);
	}

	reset(): void {
		for (const l of this.lines) l.reset();
		for (const l of this.lp) l.reset();
		snapAll([this.time, this.dry, this.wet, this.fb, this.drive, this.spread]);
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.lines.length);
		const mode = Math.min(this.pv.idx('mode'), 2);
		const a = OnePole.alpha([6500, 5000, 3200][mode]!, this.sampleRate);
		const t02 = Math.tanh(0.2);
		for (let i = start; i < end; i++) {
			const t = this.time.tick();
			const dry = this.dry.tick();
			const wet = this.wet.tick();
			const fb = this.fb.tick();
			const drive = this.drive.tick();
			const spread = this.spread.tick();
			for (let c = 0; c < nch; c++) {
				const buf = ch[c]!;
				const x = buf[i]!;
				const side = nch === 1 ? 0 : c === 0 ? -0.25 : 0.25;
				const d = t * (1 + side * spread);
				const line = this.lines[c]!;
				const y = line.read(d - 1);
				const v = this.lp[c]!.lp(a, y) * drive;
				const sat =
					(mode === 0 ? Math.tanh(v) : mode === 1 ? Math.tanh(v + 0.2) - t02 : v / (1 + Math.abs(v))) / drive;
				line.push(x + fb * sat);
				buf[i] = dry * x + wet * y;
			}
		}
	}
}

const TAPS = 4;

/** Four independent feedback delay taps mixed into one wet signal. */
export class MultitapDelay extends EffectBase {
	static readonly MAX_MS = 4000;
	/** [channel × TAPS + tap]. */
	private readonly lines: DelayLine[];
	private readonly time: Smoothed[];
	private readonly fb: Smoothed[];
	private readonly level: Smoothed[];
	private readonly mix: Smoothed;
	private readonly t = new Float64Array(TAPS);
	private readonly f = new Float64Array(TAPS);
	private readonly l = new Float64Array(TAPS);
	private readonly nch: number;

	constructor(sr: number, ch: number) {
		super('jasper.audio.multitap-delay', sr, ch);
		this.nch = Math.max(1, ch);
		const max = Math.floor(MultitapDelay.MAX_MS * 0.001 * sr) + 4;
		this.lines = Array.from({ length: this.nch * TAPS }, () => new DelayLine(max));
		this.time = Array.from({ length: TAPS }, () => Smoothed.withMs(1, sr, 100));
		this.fb = Array.from({ length: TAPS }, () => Smoothed.withMs(0, sr, SM));
		this.level = Array.from({ length: TAPS }, () => Smoothed.withMs(0, sr, SM));
		this.mix = Smoothed.withMs(0, sr, SM);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		for (let k = 0; k < TAPS; k++) {
			const n = k + 1;
			this.time[k]!.set(this.pv.v(`delay${n}`) * 0.001 * this.sampleRate);
			this.fb[k]!.set(this.pv.v(`feedback${n}`) / 100);
			const l = this.pv.v(`level${n}`);
			this.level[k]!.set(l <= -96 ? 0 : dbToGain(l));
		}
		this.mix.set(this.pv.v('mix') / 100);
		if (snap) snapAll([...this.time, ...this.fb, ...this.level, this.mix]);
	}

	reset(): void {
		for (const l of this.lines) l.reset();
		snapAll([...this.time, ...this.fb, ...this.level, this.mix]);
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.nch);
		for (let i = start; i < end; i++) {
			for (let k = 0; k < TAPS; k++) {
				this.t[k] = this.time[k]!.tick();
				this.f[k] = this.fb[k]!.tick();
				this.l[k] = this.level[k]!.tick();
			}
			const mix = this.mix.tick();
			for (let c = 0; c < nch; c++) {
				const buf = ch[c]!;
				const x = buf[i]!;
				let wet = 0;
				for (let k = 0; k < TAPS; k++) {
					const line = this.lines[c * TAPS + k]!;
					const y = line.read(this.t[k]! - 1);
					line.push(x + this.f[k]! * y);
					wet += this.l[k]! * y;
				}
				buf[i] = x + mix * (wet - x);
			}
		}
	}
}

export const DELAY_MODULATION_PROCESSORS: Readonly<Record<string, ProcessorFactory>> = {
	'jasper.audio.analog-delay': (sr, ch) => new AnalogDelay(sr, ch),
	'jasper.audio.delay': (sr, ch) => new Delay(sr, ch),
	'jasper.audio.multitap-delay': (sr, ch) => new MultitapDelay(sr, ch),
	'jasper.audio.chorus-flanger': (sr, ch) => new ChorusFlanger(sr, ch),
	'jasper.audio.flanger': (sr, ch) => new Flanger(sr, ch),
	'jasper.audio.phaser': (sr, ch) => new Phaser(sr, ch),
};
