import {
	AUTOMATION_HORIZON,
	type CurvePrecision,
	followCurve,
	holdParam,
	isFollowing,
	noteParamSet,
	paramTarget,
} from './automation.ts';

// A channel matrix in Web Audio: `in` (N channels, discrete) → splitter → one GainNode per non-zero coefficient →
// merger (M channels) → `out`. Coefficients are set with short ramps so automation and fader moves never click.

/**
 * How closely a followed matrix coefficient is cut (`MatrixNode.follow`): one-sample pieces where needed, and a finer
 * tolerance than a gain's, since several panned paths add up at the Mix.
 */
const PAN_PRECISION: CurvePrecision = { minSamples: 1, tolerance: 2e-5 };

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
		noteParamSet(p, t, v);
		return;
	}
	if (wasFollowing) holdParam(p, t);
	else if (Math.abs((paramTarget(p) ?? p.value) - v) < 1e-7) return;
	else p.cancelScheduledValues(t);
	noteParamSet(p, t, v, PARAM_TC);
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

	/**
	 * While playing: every coefficient follows `at(dt)` (the matrix `dt` seconds of context time after now) sample by
	 * sample until the next call (`followCurve`; sound-design Phase 6: pan, the 5.1 puck and send pans move between
	 * picture frames as the export's pan stage does, instead of one step per frame with the 8 ms glide). `breaks`:
	 * seconds after now where the curve may bend (the lanes' keyframes).
	 */
	follow(at: (dt: number) => readonly (readonly number[])[], breaks: readonly number[] = []): void {
		const memo = new Map<number, readonly (readonly number[])[]>();
		const m = (dt: number) => {
			let v = memo.get(dt);
			if (!v) {
				v = at(dt);
				memo.set(dt, v);
			}
			return v;
		};
		// a coefficient that becomes non-zero within the horizon needs its node now
		const probe = [
			0,
			AUTOMATION_HORIZON / 4,
			AUTOMATION_HORIZON / 2,
			(3 * AUTOMATION_HORIZON) / 4,
			AUTOMATION_HORIZON,
		];
		for (const b of breaks) if (b > 0 && b < AUTOMATION_HORIZON) probe.push(b);
		for (let o = 0; o < this.outChannels; o++)
			for (let i = 0; i < this.inChannels; i++) {
				let g = this.gains[o]![i]!;
				if (!g) {
					if (probe.every((dt) => (m(dt)[o]?.[i] ?? 0) === 0)) continue;
					g = this.ctx.createGain();
					// the curve starts from the value the param holds: a new coefficient starts at the matrix's
					g.gain.value = m(0)[o]?.[i] ?? 0;
					noteParamSet(g.gain, this.ctx.currentTime, g.gain.value);
					this.splitter.connect(g, i);
					g.connect(this.merger, 0, o);
					this.gains[o]![i] = g;
				}
				// down to one-sample pieces at a corner: the 5.1 panner's clamps and square roots bend its gains where no
				// keyframe is
				followCurve(
					g.gain,
					this.ctx,
					(dt) => m(dt)[o]?.[i] ?? 0,
					undefined,
					undefined,
					breaks,
					PAN_PRECISION,
				);
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
