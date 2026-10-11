// Hard Limiter (ported from filmcraft `effects/dynamics.rs` Limiter; the true-peak engine is @jasper/audio-dsp's
// `TruePeakLimiter`, whose ceiling guarantee audio-mix tests). Both engines run at a fixed 0 dB ceiling on the input
// scaled by `boost / ceiling`; the output is scaled back by the ceiling of the same (delayed) sample, so Maximum
// Amplitude and Input Boost stay keyframable without rebuilding the limiter, and a final clamp at that ceiling
// guarantees the sample peak.
import { TruePeakLimiter } from '@jasper/audio-dsp';
import { EffectBase } from '../../core/effect.ts';
import { dbToGain, linDb as linToDb } from '../../core/math.ts';
import { Smoothed } from '../../core/smooth.ts';
import { coef } from '../../core/util.ts';

/**
 * Sample-peak look-ahead limiter at a 0 dBFS ceiling (FilmCraft's algorithm without the true-peak detector): the
 * required gain is held for the look-ahead with a sliding minimum, released with a one-pole and smoothed with a
 * moving average exactly as long as the look-ahead, so it has reached its target when the peak leaves the delay.
 */
class SamplePeakLimiter {
	readonly latency: number;
	private readonly delay: Float32Array[];
	private wpos = 0;
	private t = 0;
	private readonly qIdx: Float64Array;
	private readonly qVal: Float64Array;
	private qHead = 0;
	private qTail = 0;
	private readonly box: Float64Array;
	private boxPos = 0;
	private boxSum: number;
	private relState = 1;
	private readonly rel: number;
	lastGain = 1;

	constructor(
		readonly channels: number,
		look: number,
		releaseCoef: number,
	) {
		this.latency = look;
		this.delay = Array.from({ length: channels }, () => new Float32Array(look + 1));
		this.qIdx = new Float64Array(look + 2);
		this.qVal = new Float64Array(look + 2);
		this.box = new Float64Array(look + 1).fill(1);
		this.boxSum = look + 1;
		this.rel = releaseCoef;
	}

	reset(): void {
		for (const d of this.delay) d.fill(0);
		this.wpos = 0;
		this.t = 0;
		this.qHead = 0;
		this.qTail = 0;
		this.box.fill(1);
		this.boxPos = 0;
		this.boxSum = this.box.length;
		this.relState = 1;
		this.lastGain = 1;
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.channels);
		const dlen = this.latency + 1;
		const window = this.latency + 1;
		const cap = this.qIdx.length;
		for (let i = start; i < end; i++) {
			let det = 0;
			for (let c = 0; c < nch; c++) {
				const x = ch[c]![i]!;
				this.delay[c]![this.wpos] = x;
				const a = x < 0 ? -x : x;
				if (a > det) det = a;
			}
			const r = det > 1 ? 1 / det : 1;
			while (this.qTail > this.qHead && this.qVal[(this.qTail - 1) % cap]! >= r) this.qTail--;
			this.qIdx[this.qTail % cap] = this.t;
			this.qVal[this.qTail % cap] = r;
			this.qTail++;
			while (this.qIdx[this.qHead % cap]! + window <= this.t) this.qHead++;
			const m = this.qVal[this.qHead % cap]!;
			this.relState = m < this.relState ? m : this.relState + (m - this.relState) * (1 - this.rel);
			this.boxSum += this.relState - this.box[this.boxPos]!;
			this.box[this.boxPos] = this.relState;
			this.boxPos = this.boxPos + 1 === this.box.length ? 0 : this.boxPos + 1;
			const g = Math.min(1, this.boxSum / this.box.length);
			this.lastGain = g;
			const out = (this.wpos + 1) % dlen;
			for (let c = 0; c < nch; c++) {
				const y = this.delay[c]![out]! * g;
				ch[c]![i] = y > 1 ? 1 : y < -1 ? -1 : y;
			}
			this.wpos = (this.wpos + 1) % dlen;
			this.t++;
			if ((this.t & 0xffff) === 0) {
				let s = 0;
				for (let k = 0; k < this.box.length; k++) s += this.box[k]!;
				this.boxSum = s;
			}
		}
	}
}

type Engine = {
	latency: number;
	process(ch: Float32Array[], start: number, end: number): void;
	reset(): void;
	gain(): number;
};

export class HardLimiter extends EffectBase {
	private readonly inGain: Smoothed;
	private readonly ceil: Smoothed;
	private engines: Engine[] = [];
	private config = '';
	private lat = 0;
	/** Ceiling of each input sample, read back when that sample leaves the limiter (2·(lat + 1) long). */
	private ceilRing = new Float64Array(2);
	private ringPos = 0;

	constructor(sr: number, ch: number) {
		super('jasper.audio.hard-limiter', sr, ch);
		this.inGain = Smoothed.withMs(1, sr, 20);
		this.ceil = Smoothed.withMs(1, sr, 20);
		this.applyParams(true);
	}

	protected applyParams(snap: boolean): void {
		this.inGain.set(dbToGain(this.pv.v('inputBoost')));
		this.ceil.set(dbToGain(this.pv.v('maxAmplitude')));
		const look = this.pv.v('lookAhead');
		const release = this.pv.v('release');
		const tp = this.pv.on('truePeak');
		const link = this.pv.on('linkChannels');
		const key = `${look}|${release}|${tp}|${link}`;
		if (key !== this.config) {
			this.config = key;
			this.build(look, release, tp, link);
		}
		if (snap) {
			this.inGain.snap();
			this.ceil.snap();
			this.ceilRing.fill(this.ceil.value());
		}
	}

	private build(lookMs: number, releaseMs: number, truePeak: boolean, link: boolean): void {
		const sr = this.sampleRate;
		const groups = link ? [this.channels] : Array.from({ length: this.channels }, () => 1);
		this.engines = groups.map((n) => {
			if (truePeak) {
				const l = new TruePeakLimiter(sr, n, { ceilingDb: 0, lookaheadMs: lookMs, releaseMs });
				return {
					latency: l.latency,
					process: (c, s, e) => l.process(c, s, e - s),
					reset: () => l.reset(),
					gain: () => 10 ** (l.gainReductionDb() / 20),
				};
			}
			const look = Math.max(1, Math.round((lookMs * sr) / 1000));
			const l = new SamplePeakLimiter(n, look, coef(releaseMs, sr));
			return {
				latency: l.latency,
				process: (c, s, e) => l.process(c, s, e),
				reset: () => l.reset(),
				gain: () => l.lastGain,
			};
		});
		this.lat = this.engines[0]?.latency ?? 0;
		this.ceilRing = new Float64Array(2 * (this.lat + 1)).fill(this.ceil.value());
		this.ringPos = 0;
	}

	latency(): number {
		return this.lat;
	}

	meters(): number[] {
		let g = 1;
		for (const e of this.engines) g = Math.min(g, e.gain());
		return [linToDb(g)];
	}

	reset(): void {
		this.inGain.snap();
		this.ceil.snap();
		for (const e of this.engines) e.reset();
		this.ceilRing.fill(this.ceil.value());
		this.ringPos = 0;
	}

	process(ch: readonly Float32Array[], start: number, end: number): void {
		const nch = Math.min(ch.length, this.channels);
		if (nch === 0) {
			for (let i = start; i < end; i++) {
				this.inGain.tick();
				this.ceil.tick();
			}
			return;
		}
		// Chunks of at most lat + 1 samples so the ceiling ring (2·(lat + 1)) never overwrites a value still needed.
		const step = this.lat + 1;
		for (let a = start; a < end; a += step) this.chunk(ch, nch, a, Math.min(end, a + step));
	}

	private chunk(ch: readonly Float32Array[], nch: number, start: number, end: number): void {
		const ring = this.ceilRing;
		const R = ring.length;
		const t0 = this.ringPos;
		// Pre-scale by boost / ceiling (the engines limit at 0 dB); remember each sample's ceiling.
		for (let i = start, t = t0; i < end; i++, t++) {
			const g = this.inGain.tick();
			const c = this.ceil.tick();
			ring[t % R] = c;
			const k = g / c;
			for (let q = 0; q < nch; q++) ch[q]![i] = ch[q]![i]! * k;
		}
		if (this.engines.length === 1) this.engines[0]!.process(ch as Float32Array[], start, end);
		else
			this.engines.forEach((e, q) => {
				if (q < nch) e.process([ch[q]!], start, end);
			});
		// Post-scale by the ceiling of the sample now leaving (it entered `lat` samples ago), final clamp.
		for (let i = start, t = t0; i < end; i++, t++) {
			const c = ring[(t - this.lat + R * 4) % R]!;
			for (let q = 0; q < nch; q++) {
				const y = ch[q]![i]! * c;
				ch[q]![i] = y > c ? c : y < -c ? -c : y;
			}
		}
		this.ringPos = (t0 + (end - start)) % R;
	}
}
