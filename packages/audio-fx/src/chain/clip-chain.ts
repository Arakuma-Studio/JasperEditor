// The audio of one clip, after its source: clip effects → levels (clip gain + Volume, track volume, master volume,
// transition fades) → pan (clip Panner, track pan). The SAME code runs in the preview's AudioWorklet and in the
// engine's native export, so both produce the same samples for the same input (tested).
//
// Positions are clip-local INPUT samples `s`: s = 0 is the first sample of the clip's span (its head handle when a
// crossfade plays one), at the sequence frame `start − headHandle`. The span lasts `spanSamples`. Effect parameters
// are evaluated at the input position; levels and pan at the output position `o = s − latency` (the effects delay
// the signal by their latency, compensated by feeding the input early). Outside the span the input is silence and
// the output is zero (effect tails end at the clip's end, like a clip's own audio). Control points are every
// `CONTROL_BLOCK` samples of `s` (and the entry point), so the output does not depend on how the host cuts the
// stream into blocks.
import {
	type Animatable,
	audioFadeGain,
	evaluate,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	type Rational,
	type RenderAudioFade,
} from '@jasper/project/audio';
import { dbToGain } from '../core/math.ts';
import { panGains } from '../core/pan.ts';
import { type ChainEffect, EffectChain } from './effect-chain.ts';

/** Samples between two control points (automation and level evaluation). */
export const CONTROL_BLOCK = 32;

/** What the chain needs to know about a clip (a subset of the render snapshot's `RenderAudioClip`). */
export type ClipChainClip = {
	start: number;
	duration: number;
	sourceIn: number;
	speed: { rate: number; reverse: boolean };
	headHandle?: number;
	tailHandle?: number;
	gainDb: number;
	volumeDb: Animatable<number>;
	pan: Animatable<number>;
	effects: readonly ChainEffect[];
	track: { volumeDb: Animatable<number>; pan: Animatable<number> };
	fades?: readonly RenderAudioFade[];
};

export type ClipChainConfig = {
	sampleRate: number;
	fps: Rational;
	clip: ClipChainClip;
	master?: { volumeDb: Animatable<number> } | null;
	/** Apply levels and pan (default true). False = effects only (loudness analysis of the clip's own signal). */
	levels?: boolean;
};

/** Span length in samples (same rounding as the native audio builder). */
export function spanSamples(clip: Pick<ClipChainClip, 'duration' | 'headHandle' | 'tailHandle'>, fps: Rational, sr: number): number {
	const frames = clip.duration + (clip.headHandle ?? 0) + (clip.tailHandle ?? 0);
	return Math.round((frames * fps.den * sr) / fps.num);
}

/** True when the clip needs the DSP chain (enabled effects, pan, track pan) — else plain gain is enough. */
export function clipNeedsChain(clip: Pick<ClipChainClip, 'effects' | 'pan' | 'track'>): boolean {
	return (
		clip.effects.some((e) => e.enabled) ||
		clip.pan.value !== 0 ||
		clip.pan.keyframes.length > 0 ||
		clip.track.pan.value !== 0 ||
		clip.track.pan.keyframes.length > 0
	);
}

export class ClipChain {
	readonly effects: EffectChain;
	private cfg!: ClipChainConfig;
	private span = 0;
	private framesPerSample = 0;
	private F = 0;
	private entered = false;
	/** Cached gain grid cell: output positions [cell·C, (cell+1)·C). */
	private cell = Number.NaN;
	private g0l = 0;
	private g0r = 0;
	private g1l = 0;
	private g1r = 0;
	private readonly lr: [number, number] = [0, 0];

	constructor(cfg: ClipChainConfig, channels = 2) {
		this.effects = new EffectChain(cfg.sampleRate, channels);
		this.update(cfg);
	}

	/** New settings (effects, params, levels) keep the processors' state; timing changes take effect immediately. */
	update(cfg: ClipChainConfig): void {
		this.cfg = cfg;
		this.span = spanSamples(cfg.clip, cfg.fps, cfg.sampleRate);
		this.framesPerSample = cfg.fps.num / (cfg.fps.den * cfg.sampleRate);
		this.F = flicksPerFrame(cfg.fps);
		this.effects.setEffects(cfg.clip.effects);
		this.cell = Number.NaN;
	}

	get spanSamples(): number {
		return this.span;
	}

	latency(): number {
		return this.effects.latency();
	}

	/** Back to the initial state: the next processed sample (re)enters the clip with fresh effect state. */
	reset(): void {
		this.entered = false;
		this.cell = Number.NaN;
	}

	/** Clip-relative frame index (fractional; may be outside 0…duration) of position `p`. */
	private frameIndex(p: number): number {
		return p * this.framesPerSample - (this.cfg.clip.headHandle ?? 0);
	}

	/** Content time (flicks) at clip frame index `i`, clamped to the clip's frames (Effect Controls rule). */
	private contentAt(i: number): number {
		const c = this.cfg.clip;
		const k = Math.min(Math.max(i, 0), Math.max(0, c.duration - 1));
		return c.speed.reverse
			? c.sourceIn + (c.duration - 1 - k) * this.F * c.speed.rate
			: c.sourceIn + k * this.F * c.speed.rate;
	}

	/** Linear left/right gains at output position `o` (zero outside the span). */
	private levelsAt(o: number, out: [number, number]): void {
		const c = this.cfg.clip;
		if (o < 0 || o >= this.span) {
			out[0] = 0;
			out[1] = 0;
			return;
		}
		if (this.cfg.levels === false) {
			out[0] = 1;
			out[1] = 1;
			return;
		}
		const i = this.frameIndex(o);
		const k = Math.min(Math.max(i, 0), Math.max(0, c.duration - 1));
		const content = this.contentAt(i);
		const seqT = (c.start + k) * this.F;
		const db =
			c.gainDb +
			evaluate(c.volumeDb, content) +
			evaluate(c.track.volumeDb, seqT) +
			(this.cfg.master ? evaluate(this.cfg.master.volumeDb, seqT) : 0);
		// ≤ −96 dB is silence (the Player's and the native volume filter's rule).
		const g = (db <= -96 ? 0 : dbToGain(db)) * audioFadeGain(c.fades, c.start + i);
		const [pl, pr] = panGains(evaluate(c.pan, content) / 100);
		const [tl, tr] = panGains(evaluate(c.track.pan, seqT) / 100);
		out[0] = g * pl * tl;
		out[1] = g * pr * tr;
	}

	private gainCell(cell: number): void {
		if (cell === this.cell) return;
		this.cell = cell;
		this.levelsAt(cell * CONTROL_BLOCK, this.lr);
		this.g0l = this.lr[0];
		this.g0r = this.lr[1];
		this.levelsAt((cell + 1) * CONTROL_BLOCK, this.lr);
		this.g1l = this.lr[0];
		this.g1r = this.lr[1];
	}

	/** Effect-parameter time (content flicks) at input position `s`. */
	paramTime(s: number): number {
		return this.contentAt(this.frameIndex(s));
	}

	/**
	 * Processes `[start, end)` of `channels` (stereo, in place): the samples are the clip's input at positions
	 * `s0 … s0 + (end − start) − 1`; the output replaces them.
	 */
	process(channels: readonly Float32Array[], start: number, end: number, s0: number): void {
		const L = this.effects.latency();
		const stop = this.span + L;
		let i = start;
		let s = s0;
		while (i < end) {
			if (s < 0) {
				// Before the clip: silence, effects untouched.
				const n = Math.min(end - i, -s);
				for (const ch of channels) ch.fill(0, i, i + n);
				i += n;
				s += n;
				continue;
			}
			if (s >= stop) {
				for (const ch of channels) ch.fill(0, i, end);
				return;
			}
			if (!this.entered) {
				this.entered = true;
				this.effects.reset();
				this.effects.automate(this.paramTime(s));
			} else if (s % CONTROL_BLOCK === 0) this.effects.automate(this.paramTime(s));
			// Sub-block up to the next control point (and the end of the span input).
			const nextControl = (Math.floor(s / CONTROL_BLOCK) + 1) * CONTROL_BLOCK;
			let n = Math.min(end - i, nextControl - s, stop - s);
			if (s < this.span) n = Math.min(n, this.span - s);
			if (s >= this.span) for (const ch of channels) ch.fill(0, i, i + n); // past the clip: silence in
			this.effects.process(channels, i, i + n);
			this.applyLevels(channels, i, i + n, s - L);
			i += n;
			s += n;
		}
	}

	private applyLevels(channels: readonly Float32Array[], a: number, b: number, o0: number): void {
		const left = channels[0];
		const right = channels[1] ?? channels[0];
		if (!left || !right) return;
		let o = o0;
		for (let i = a; i < b; ) {
			const cell = Math.floor(o / CONTROL_BLOCK);
			this.gainCell(cell);
			const cellEnd = (cell + 1) * CONTROL_BLOCK;
			const n = Math.min(b - i, cellEnd - o);
			const base = cell * CONTROL_BLOCK;
			const dl = (this.g1l - this.g0l) / CONTROL_BLOCK;
			const dr = (this.g1r - this.g0r) / CONTROL_BLOCK;
			for (let k = 0; k < n; k++) {
				const pos = o + k;
				// Hard window: nothing outside the span (also kills effect tails past the clip end).
				if (pos < 0 || pos >= this.span) {
					left[i + k] = 0;
					if (right !== left) right[i + k] = 0;
					continue;
				}
				const u = pos - base;
				left[i + k] = left[i + k]! * (this.g0l + dl * u);
				if (right !== left) right[i + k] = right[i + k]! * (this.g0r + dr * u);
			}
			i += n;
			o += n;
		}
	}
}

/** Seconds of a flick count (helpers for hosts). */
export const flicksToSec = (f: number): number => f / FLICKS_PER_SECOND;
