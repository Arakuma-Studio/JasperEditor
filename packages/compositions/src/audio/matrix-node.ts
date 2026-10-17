import { holdParam, isFollowing } from './automation.ts';

// A channel matrix in Web Audio: `in` (N channels, discrete) → splitter → one GainNode per non-zero coefficient →
// merger (M channels) → `out`. Coefficients are set with short ramps so automation and fader moves never click.

/** Smoothing time constant of every parameter change (s). */
export const PARAM_TC = 0.008;

export function discreteGain(ctx: BaseAudioContext, channels: number, value = 1): GainNode {
	const g = ctx.createGain();
	g.channelCount = channels;
	g.channelCountMode = 'explicit';
	g.channelInterpretation = 'discrete';
	g.gain.value = value;
	return g;
}

/** Sets an AudioParam to `v` smoothly (immediately when `instant`). */
export function setParam(p: AudioParam, v: number, ctx: BaseAudioContext, instant = false): void {
	if (!Number.isFinite(v)) v = 0;
	const t = ctx.currentTime;
	// A param that was following an automation curve (`followCurve`): stop the curve where it is.
	const wasFollowing = isFollowing(p);
	if (instant) {
		if (wasFollowing) holdParam(p, t);
		p.cancelScheduledValues(t);
		p.setValueAtTime(v, t);
		return;
	}
	if (wasFollowing) holdParam(p, t);
	else if (Math.abs(p.value - v) < 1e-7) return;
	else p.cancelScheduledValues(t);
	p.setTargetAtTime(v, t, PARAM_TC);
}

export class MatrixNode {
	readonly input: GainNode;
	readonly output: GainNode;
	private readonly splitter: ChannelSplitterNode;
	private readonly merger: ChannelMergerNode;
	private readonly gains: (GainNode | null)[][];
	private primed = false;

	constructor(
		private readonly ctx: BaseAudioContext,
		readonly inChannels: number,
		readonly outChannels: number,
	) {
		this.input = discreteGain(ctx, inChannels);
		this.output = discreteGain(ctx, outChannels);
		this.splitter = ctx.createChannelSplitter(inChannels);
		this.merger = ctx.createChannelMerger(outChannels);
		this.input.connect(this.splitter);
		this.merger.connect(this.output);
		this.gains = Array.from({ length: outChannels }, () => Array<GainNode | null>(inChannels).fill(null));
	}

	/** `m[out][in]`; zero coefficients have no node (created on demand). */
	set(m: readonly (readonly number[])[], instant = false): void {
		const now = instant || !this.primed;
		for (let o = 0; o < this.outChannels; o++)
			for (let i = 0; i < this.inChannels; i++) {
				const v = m[o]?.[i] ?? 0;
				let g = this.gains[o]![i]!;
				if (!g) {
					if (v === 0) continue;
					g = this.ctx.createGain();
					g.gain.value = 0;
					this.splitter.connect(g, i);
					g.connect(this.merger, 0, o);
					this.gains[o]![i] = g;
				}
				setParam(g.gain, v, this.ctx, now);
			}
		this.primed = true;
	}

	dispose(): void {
		this.input.disconnect();
		this.splitter.disconnect();
		for (const row of this.gains) for (const g of row) g?.disconnect();
		this.merger.disconnect();
		this.output.disconnect();
	}
}
