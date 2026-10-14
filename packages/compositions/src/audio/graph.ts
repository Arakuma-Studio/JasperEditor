// The preview audio mix (audio-mix): a Web Audio graph we control between Remotion's per-clip audio nodes and its
// output gain node. Every audio clip of the Program composition plays into a clip node (channel selection, Audio
// Clip Mixer trim, clip effect slot, clip pan) → its track strip → submixes → the Mix → loudness gain → true-peak
// limiter → Mix meter (levels + BS.1770 loudness) → device fold (5.1 / mono → stereo) → Remotion's gain node.
//
// Strip: input → input map → pre-fader inserts → [pre-fader sends] → mute → fader → meter → post-fader inserts →
// [post-fader sends] → pan / balance / 5.1 panner → solo gate → output bus. The same pan laws and matrices as the
// offline export mixer (`@jasper/project` OfflineMixer, both from `@jasper/audio-dsp`), so preview and export agree.
//
// Lane values (volume, mute, pan, 5.1 puck, send levels, clip pan) are evaluated at the composition's current frame
// and ramped (8 ms time constant); live controls held on the Audio Track / Clip Mixer override them (`setOverride`).
import {
	balanceGains,
	conversionMatrix,
	layoutFromChannels,
	type Mixdown,
	pan51Matrix,
	panMonoGains,
	TruePeakLimiter,
} from '@jasper/audio-dsp';
import {
	type Animatable,
	audioFadeGain,
	contentTimeAt,
	type EffectInstance,
	evaluate,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	holdValueAt,
	isAnimated,
	nestGainDbAt,
	type Rational,
	type RenderAudioClip,
	type RenderAudioMix,
	type RenderStrip,
} from '@jasper/project';
import { audioGainAt, dbToGain as pipelineDbToGain } from '../pipeline.ts';
import { discreteGain, MatrixNode, setParam } from './matrix-node.ts';

export type LoudnessReading = {
	momentary: number;
	shortTerm: number;
	integrated: number;
	lra: number;
	truePeakDb: number;
	samplePeakDb: number;
	maxMomentary: number;
	maxShortTerm: number;
};

export type MeterReading = {
	/** Linear per-channel peak / RMS since the previous reading; 1 when the channel clipped. */
	peak: number[];
	rms: number[];
	clipped: number[];
	loudness?: LoudnessReading;
	/** performance.now() of the reading. */
	at: number;
};

/** A preview effect slot (track / submix / Mix insert or clip effect), hosted by `registerPreviewInsert`. */
export interface PreviewInsert {
	input: AudioNode;
	output: AudioNode;
	/** Called every rendered frame with the current instance (time: sequence flicks for inserts, content for clips). */
	update(effect: EffectInstance, timeFlicks: number): void;
	dispose(): void;
}
export type PreviewInsertFactory = (
	ctx: BaseAudioContext,
	effect: EffectInstance,
	channels: number,
) => PreviewInsert;

/** Latency (samples at `sampleRate`) a preview slot adds for an effect instance (its static parameter values). */
export type PreviewInsertLatency = (effect: EffectInstance, sampleRate: number) => number;

const insertFactories = new Map<string, PreviewInsertFactory>();
const insertLatencies = new Map<string, PreviewInsertLatency>();
/**
 * Registers the Web Audio implementation of an audio effect for preview slots (returns an unregister function).
 * `latency` reports the delay the slot adds (look-ahead, FFT, convolution): the graph compensates it like the export.
 */
export function registerPreviewInsert(
	effectId: string,
	factory: PreviewInsertFactory,
	latency?: PreviewInsertLatency,
): () => void {
	insertFactories.set(effectId, factory);
	if (latency) insertLatencies.set(effectId, latency);
	else insertLatencies.delete(effectId);
	return () => {
		if (insertFactories.get(effectId) === factory) {
			insertFactories.delete(effectId);
			insertLatencies.delete(effectId);
		}
	};
}

const latencyCache = new Map<string, number>();
/**
 * Latency (samples) of a preview slot for `effect`: 0 when the effect has no preview slot (it passes through) or is
 * disabled. Cached per effect id, static parameter values and rate (the measurement builds a processor).
 */
export function previewInsertLatency(effect: EffectInstance, sampleRate: number): number {
	if (!effect.enabled || !insertFactories.has(effect.effectId)) return 0;
	const f = insertLatencies.get(effect.effectId);
	if (!f) return 0;
	const values: Record<string, unknown> = {};
	for (const [k, a] of Object.entries(effect.params ?? {})) values[k] = (a as { value?: unknown })?.value;
	const key = `${effect.effectId}|${sampleRate}|${JSON.stringify(values)}`;
	let l = latencyCache.get(key);
	if (l === undefined) {
		const raw = f(effect, sampleRate);
		l = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
		if (latencyCache.size > 512) latencyCache.clear();
		latencyCache.set(key, l);
	}
	return l;
}

/** Total latency (samples) of a clip's enabled effect slots. */
export function clipEffectsLatency(effects: readonly EffectInstance[], sampleRate: number): number {
	let l = 0;
	for (const e of effects) l += previewInsertLatency(e, sampleRate);
	return l;
}

/** Latency bookkeeping of one strip (samples), as in the export mixer (`OfflineMixer`). */
export type StripLatency = {
	/** Latest arrival of the strip's inputs (every input is delayed to it). */
	inLat: number;
	/** `inLat` + the pre-fader inserts. */
	preLat: number;
	/** `preLat` + the post-fader inserts. */
	postLat: number;
	/** Delay of the strip's output route into its bus (0 for the Mix). */
	outDelay: number;
	/** Delay of each send route (by send id). */
	sendDelays: Record<string, number>;
};

export type MixLatencyPlan = {
	/**
	 * Read-ahead of the whole graph (samples): the Mix's latency plus the preview limiter's when it runs. Sources are
	 * scheduled this much early so the Mix output lines up with the picture.
	 */
	total: number;
	strips: Record<string, StripLatency>;
};

/**
 * Latency compensation of the preview graph — the same plan as the export mixer: every insert reports its latency,
 * each route into a bus is delayed so all of the bus's inputs arrive together (`inLat` = latest arrival), and the
 * graph is read ahead by the Mix's latency (`total`). `masterExtra` is latency after the Mix strip (the loudness
 * limiter). Strips are in processing order (inputs come from earlier strips; the Mix is last).
 */
export function planMixLatency(
	mix: Pick<RenderAudioMix, 'strips'>,
	latencyOf: (effect: EffectInstance) => number,
	masterExtra = 0,
): MixLatencyPlan {
	const strips = mix.strips;
	const index = new Map(strips.map((s, i) => [s.id, i]));
	const arrivals = strips.map(() => [] as number[]);
	const lat = (e: EffectInstance) => {
		const l = latencyOf(e);
		return Number.isFinite(l) && l > 0 ? Math.round(l) : 0;
	};
	const rows: StripLatency[] = strips.map((s, i) => {
		const inLat = Math.max(0, ...arrivals[i]!);
		let preLat = inLat;
		let postLat = 0;
		for (const e of s.inserts) if (!e.postFader) preLat += lat(e);
		postLat = preLat;
		for (const e of s.inserts) if (e.postFader) postLat += lat(e);
		if (s.output !== null) {
			const t = index.get(s.output);
			if (t !== undefined && t > i) arrivals[t]!.push(postLat);
		}
		for (const x of s.sends) {
			const t = index.get(x.target);
			if (t !== undefined && t > i) arrivals[t]!.push(x.preFader ? preLat : postLat);
		}
		return { inLat, preLat, postLat, outDelay: 0, sendDelays: {} };
	});
	strips.forEach((s, i) => {
		const r = rows[i]!;
		if (s.output !== null) {
			const t = index.get(s.output);
			if (t !== undefined && t > i) r.outDelay = rows[t]!.inLat - r.postLat;
		}
		for (const x of s.sends) {
			const t = index.get(x.target);
			if (t !== undefined && t > i) r.sendDelays[x.id] = rows[t]!.inLat - (x.preFader ? r.preLat : r.postLat);
		}
	});
	const master = rows[rows.length - 1];
	const out: Record<string, StripLatency> = {};
	strips.forEach((s, i) => {
		out[s.id] = rows[i]!;
	});
	const extra = Number.isFinite(masterExtra) && masterExtra > 0 ? Math.round(masterExtra) : 0;
	return { total: (master?.postLat ?? 0) + extra, strips: out };
}

/**
 * Sequence times (flicks) at which a strip's lanes and inserts are evaluated when the picture shows `t`: the signal
 * at each stage is `total − stage latency` samples ahead of the picture (sources are read ahead by `total`), exactly
 * the times the export mixer uses for the same samples.
 */
export function stripStageTimes(
	plan: MixLatencyPlan,
	stripId: string,
	t: number,
	sampleRate: number,
): { preInserts: number; fader: number; postInserts: number; pan: number } {
	const r = plan.strips[stripId];
	const fps = FLICKS_PER_SECOND / sampleRate;
	if (!r) return { preInserts: t, fader: t, postInserts: t, pan: t };
	const at = (lat: number) => t + (plan.total - lat) * fps;
	return { preInserts: at(r.inLat), fader: at(r.preLat), postInserts: at(r.preLat), pan: at(r.postLat) };
}

let workletUrl: string | null = null;
const workletLoads = new WeakMap<BaseAudioContext, Promise<boolean>>();
/** The URL of the bundled `worklet.ts` (the web app sets it; without it meters and the preview limiter are off). */
export function setMixWorkletUrl(url: string | null): void {
	workletUrl = url;
}
/** audio-fx: resolves true once the mix worklet module (with the `jasper-audio-fx` effect slot) is loaded on `ctx`. */
export function mixWorkletReady(ctx: BaseAudioContext): Promise<boolean> {
	let p = workletLoads.get(ctx);
	if (!p) {
		p =
			workletUrl && ctx.audioWorklet
				? ctx.audioWorklet.addModule(workletUrl).then(
						() => true,
						() => false,
					)
				: Promise.resolve(false);
		workletLoads.set(ctx, p);
	}
	return p;
}

/** Look-ahead of the preview loudness limiter (`jasper-limiter`), as the export's normalisation limiter. */
export const LIMITER_LOOKAHEAD_MS = 5;

const dbToGain = (db: number) => (db <= -96 || !Number.isFinite(db) ? 0 : 10 ** (db / 20));
const widthOf = (f: string) => (f === 'mono' ? 1 : f === '5.1' ? 6 : 2);

function laneAt(a: Animatable<number>, t: number, hold = false): number {
	if (!isAnimated(a)) return a.value;
	return hold ? holdValueAt(a, t) : evaluate(a, t);
}

function scaleRows(m: number[][], gains: number[]): number[][] {
	return m.map((row, o) => row.map((v) => v * (gains[o] ?? 1)));
}

/** The pan stage matrix of a strip (width w → bus width ow) for a pan value (−100…100) or 5.1 puck. */
export function panStageMatrix(
	w: number,
	ow: number,
	pan: number,
	p51: { x: number; y: number; center: number; lfeDb: number },
	mixdown: Mixdown = 'frontRear',
): number[][] {
	const src = layoutFromChannels(w);
	if (ow === 6)
		return pan51Matrix(src, {
			x: p51.x / 100,
			y: p51.y / 100,
			center: p51.center / 100,
			lfeGain: dbToGain(p51.lfeDb),
		});
	if (ow === 1) return conversionMatrix(src, 'mono');
	const p = Math.max(-1, Math.min(1, pan / 100));
	if (w === 1) {
		const [l, r] = panMonoGains(p);
		return [[l], [r]];
	}
	const [l, r] = balanceGains(p);
	const fold = w === 6 ? conversionMatrix('5.1', 'stereo', mixdown) : conversionMatrix('stereo', 'stereo');
	return scaleRows(fold, [l, r]);
}

class SlotChain {
	readonly input: GainNode;
	readonly output: GainNode;
	private slots: { id: string; effectId: string; ins: PreviewInsert | null }[] = [];

	constructor(
		private readonly ctx: BaseAudioContext,
		private readonly channels: number,
	) {
		this.input = discreteGain(ctx, channels);
		this.output = discreteGain(ctx, channels);
		this.input.connect(this.output);
	}

	/** Rebuilds the chain when the effect list changed; updates every slot. */
	sync(effects: readonly EffectInstance[], time: number): void {
		const key = effects.map((e) => `${e.id}:${e.effectId}`).join(',');
		if (key !== this.slots.map((s) => `${s.id}:${s.effectId}`).join(',')) {
			this.input.disconnect();
			for (const s of this.slots) {
				s.ins?.output.disconnect();
				s.ins?.dispose();
			}
			this.slots = effects.map((e) => {
				const f = insertFactories.get(e.effectId);
				return { id: e.id, effectId: e.effectId, ins: f ? f(this.ctx, e, this.channels) : null };
			});
			let last: AudioNode = this.input;
			for (const s of this.slots) {
				if (!s.ins) continue;
				last.connect(s.ins.input);
				last = s.ins.output;
			}
			last.connect(this.output);
		}
		effects.forEach((e, i) => {
			this.slots[i]?.ins?.update(e, time);
		});
	}

	dispose(): void {
		this.input.disconnect();
		for (const s of this.slots) s.ins?.dispose();
		this.output.disconnect();
	}
}

/**
 * A route into a bus (`from` → `to`) with an optional latency-compensation delay (a DelayNode only when needed).
 * Integer sample delays: the DelayNode reads exactly `samples` back.
 */
class DelayRoute {
	private delay: DelayNode | null = null;
	samples = 0;

	constructor(
		private readonly ctx: BaseAudioContext,
		private readonly from: AudioNode,
		private readonly to: AudioNode,
		private readonly channels: number,
	) {
		from.connect(to);
	}

	set(samples: number): void {
		const n = Number.isFinite(samples) && samples > 0 ? Math.round(samples) : 0;
		if (n === this.samples) return;
		this.from.disconnect();
		this.delay?.disconnect();
		this.delay = null;
		this.samples = n;
		if (n === 0) {
			this.from.connect(this.to);
			return;
		}
		const sec = n / this.ctx.sampleRate;
		const d = this.ctx.createDelay(Math.min(179, sec + 0.01));
		d.channelCount = this.channels;
		d.channelCountMode = 'explicit';
		d.channelInterpretation = 'discrete';
		d.delayTime.value = sec;
		this.from.connect(d);
		d.connect(this.to);
		this.delay = d;
	}

	dispose(): void {
		this.from.disconnect();
		this.delay?.disconnect();
		this.delay = null;
	}
}

type SendNodes = {
	id: string;
	target: string;
	preFader: boolean;
	level: GainNode;
	matrix: MatrixNode;
	gate: GainNode;
	route: DelayRoute;
};

class StripNodes {
	readonly width: number;
	readonly input: GainNode;
	readonly inputMap: MatrixNode | null;
	readonly pre: SlotChain;
	readonly mute: GainNode;
	readonly fader: GainNode;
	meter: AudioWorkletNode | null = null;
	readonly post: SlotChain;
	readonly pan: MatrixNode | null;
	readonly gate: GainNode;
	/** Output route into the strip's bus (null for the Mix or a dangling output). */
	out: DelayRoute | null = null;
	sends: SendNodes[] = [];

	constructor(
		readonly ctx: BaseAudioContext,
		readonly s: RenderStrip,
		readonly outWidth: number,
		meterNode: AudioWorkletNode | null,
	) {
		const w = widthOf(s.format);
		this.width = w;
		this.input = discreteGain(ctx, w);
		this.inputMap = w === 2 ? new MatrixNode(ctx, 2, 2) : null;
		this.pre = new SlotChain(ctx, w);
		this.mute = discreteGain(ctx, w);
		this.fader = discreteGain(ctx, w);
		this.post = new SlotChain(ctx, w);
		this.pan = s.kind === 'master' ? null : new MatrixNode(ctx, w, outWidth);
		this.gate = discreteGain(ctx, s.kind === 'master' ? w : outWidth);
		this.meter = meterNode;
		let last: AudioNode = this.input;
		if (this.inputMap) {
			last.connect(this.inputMap.input);
			last = this.inputMap.output;
		}
		last.connect(this.pre.input);
		this.pre.output.connect(this.mute);
		this.mute.connect(this.fader);
		last = this.fader;
		if (this.meter) {
			last.connect(this.meter);
			last = this.meter;
		}
		last.connect(this.post.input);
		if (this.pan) {
			this.post.output.connect(this.pan.input);
			this.pan.output.connect(this.gate);
		} else this.post.output.connect(this.gate);
	}

	dispose(): void {
		for (const n of [this.input, this.mute, this.fader, this.gate]) n.disconnect();
		this.inputMap?.dispose();
		this.pre.dispose();
		this.post.dispose();
		this.pan?.dispose();
		this.meter?.disconnect();
		this.meter?.port.close();
		this.out?.dispose();
		for (const x of this.sends) {
			x.level.disconnect();
			x.matrix.dispose();
			x.gate.disconnect();
			x.route.dispose();
		}
	}
}

/** audio-fx: a clip whose levels are applied after its effects in the preview (enabled clip effects). */
export function clipHasEffects(clip: Pick<RenderAudioClip, 'effects'>): boolean {
	return clip.effects.some((e) => e.enabled);
}

/**
 * Linear clip level (gain + Volume + fades + nested gain, no track/Mix faders) at clip-local frame `f` (negative in
 * the head handle) — the AudioLayer's volume callback, applied after the effect slots instead.
 */
export function clipLevelAt(clip: RenderAudioClip, f: number, fps: Rational): number {
	const { fades, nestGain, ...levels } = clip;
	return (
		audioGainAt(levels, f, fps, undefined, false) *
		audioFadeGain(fades, clip.start + f) *
		(nestGain ? pipelineDbToGain(nestGainDbAt(nestGain, clip.start + f)) : 1)
	);
}

class ClipNodes {
	/** Remotion's per-clip gain node connects here (the `gainNode` of our SharedAudioContext override). */
	readonly input: GainNode;
	private select: MatrixNode | null = null;
	readonly trim: GainNode;
	private slots: SlotChain | null = null;
	/**
	 * audio-fx: the clip's levels (gain, Volume, fades, nested gain) AFTER its effects, as in the export's mixer
	 * (`gain → clip effects → volume → fades`). Used when the clip has enabled effects (Remotion then plays at unity,
	 * AudioLayer); otherwise unity (Remotion applies the levels before the — empty — slot chain).
	 */
	private level: GainNode | null = null;
	private pan: MatrixNode | null = null;
	trackWidth = 0;
	width = 0;
	clip: RenderAudioClip;
	private dest: AudioNode | null = null;

	constructor(
		readonly ctx: BaseAudioContext,
		clip: RenderAudioClip,
	) {
		this.clip = clip;
		this.input = ctx.createGain();
		this.input.channelInterpretation = 'discrete';
		this.trim = discreteGain(ctx, 1);
	}

	/** (Re)builds the chain for the clip's channel layout and the track width; connects to `dest`. */
	connect(clip: RenderAudioClip, trackWidth: number, dest: AudioNode, time: number): void {
		this.clip = clip;
		const stream = Math.max(
			1,
			Math.min(6, clip.streamChannels ?? Math.max(2, ...clip.channels.map.map((c) => c + 1))),
		);
		const mapped = clip.channels.map.length > 0 ? clip.channels.map.length : stream;
		const w = mapped === 1 || mapped === 2 || mapped === 6 ? mapped : 2;
		if (!this.select || this.width !== w || this.select.inChannels !== stream) {
			this.select?.dispose();
			this.slots?.dispose();
			this.input.disconnect();
			this.trim.disconnect();
			this.select = new MatrixNode(this.ctx, stream, w);
			this.trim.channelCount = w;
			this.slots = new SlotChain(this.ctx, w);
			this.level?.disconnect();
			this.level = discreteGain(this.ctx, w);
			this.slots.output.connect(this.level);
			this.input.connect(this.select.input);
			this.select.output.connect(this.trim);
			this.trim.connect(this.slots.input);
			this.width = w;
			this.pan?.dispose();
			this.pan = null;
		}
		const map = clip.channels.map.length > 0 ? clip.channels.map : Array.from({ length: w }, (_, i) => i);
		// gaps (Modify ▸ Audio Channels): muted clip channels (no source routed to them) are silent.
		const mute = clip.channels.mute ?? [];
		const sel = Array.from({ length: w }, (_, o) =>
			Array.from({ length: stream }, (_, i) => (map[o] === i && !mute.includes(o) ? 1 : 0)),
		);
		this.select.set(sel, true);
		if (!this.pan || this.trackWidth !== trackWidth) {
			this.pan?.dispose();
			this.pan = new MatrixNode(this.ctx, w, trackWidth);
			this.level!.connect(this.pan.input);
			this.trackWidth = trackWidth;
			this.dest = null;
		}
		if (this.dest !== dest) {
			this.pan.output.disconnect();
			this.pan.output.connect(dest);
			this.dest = dest;
		}
		this.update(clip, time, null, true);
	}

	/** Clip pan, effects and the Clip Mixer trim at sequence time `t` (flicks). */
	update(
		clip: RenderAudioClip,
		t: number,
		override: { volume?: number; pan?: number } | null,
		instant = false,
		fps?: Rational,
	): void {
		this.clip = clip;
		if (!this.pan) return;
		const rate = fps ?? { num: 30, den: 1 };
		const F = flicksPerFrame(rate);
		const frame = Math.min(clip.start + clip.duration - 1e-6, Math.max(clip.start, t / F));
		const content = contentTimeAt(clip, frame, rate);
		const pan = override?.pan ?? laneAt(clip.pan, content);
		const w = this.width;
		const tw = this.trackWidth;
		let m = conversionMatrix(layoutFromChannels(w), layoutFromChannels(tw));
		if (tw === 2 && pan !== 0) m = scaleRows(m, balanceGains(Math.max(-1, Math.min(1, pan / 100))));
		this.pan.set(m, instant);
		// Clip Mixer fader held: replace the clip's volume (Remotion applies gain + volume; the trim corrects it).
		const trim =
			override?.volume !== undefined
				? dbToGain(override.volume) / Math.max(1e-9, dbToGain(laneAt(clip.volumeDb, content)))
				: 1;
		setParam(this.trim.gain, Number.isFinite(trim) ? Math.min(trim, 64) : 1, this.ctx, instant);
		this.slots?.sync(
			clip.effects.filter((e) => e.enabled),
			content,
		);
		if (this.level)
			setParam(
				this.level.gain,
				clipHasEffects(clip) ? clipLevelAt(clip, t / F - clip.start, rate) : 1,
				this.ctx,
				instant,
			);
	}

	dispose(): void {
		this.input.disconnect();
		this.select?.dispose();
		this.level?.disconnect();
		this.trim.disconnect();
		this.slots?.dispose();
		this.pan?.dispose();
	}
}

type Listener<T> = (v: T) => void;

export class MixGraph {
	private strips = new Map<string, StripNodes>();
	private order: RenderStrip[] = [];
	private structure = '';
	private readonly clips = new Map<string, ClipNodes>();
	private readonly overrides = new Map<string, number>();
	private readonly meterListeners = new Map<string, Set<Listener<MeterReading>>>();
	private readonly lastReadings = new Map<string, MeterReading>();
	private readonly changeListeners = new Set<() => void>();
	private loudGain: GainNode;
	private limiter: AudioWorkletNode | null = null;
	private masterMeter: AudioWorkletNode | null = null;
	private device: MatrixNode | null = null;
	private workletReady = false;
	private mix: RenderAudioMix | null = null;
	private clipList: RenderAudioClip[] = [];
	private fps: Rational = { num: 30, den: 1 };
	private time = 0;
	mixdown: Mixdown = 'frontRear';
	/** Output channels soloed on the Audio Meters (monitoring only; empty = all). */
	private monitorSolo = new Set<number>();
	/** Latency compensation (insert latencies, route delays, read-ahead), replanned when the mix changes. */
	private plan: MixLatencyPlan = { total: 0, strips: {} };
	private plannedMix: RenderAudioMix | null = null;
	private plannedExtra = -1;
	private readonly latencyListeners = new Set<() => void>();
	private limiterLatencySamples: number | null = null;

	constructor(
		readonly ctx: AudioContext,
		readonly destination: AudioNode,
	) {
		this.loudGain = discreteGain(ctx, 2);
		void mixWorkletReady(ctx).then((ok) => {
			this.workletReady = ok;
			if (ok && this.mix) {
				this.structure = '';
				this.update(this.mix, this.clipList, this.time, this.fps);
			}
		});
	}

	get sampleRate(): number {
		return this.ctx.sampleRate;
	}

	/** The current mix (strip order, labels): the Audio Track Mixer reads it. */
	get currentMix(): RenderAudioMix | null {
		return this.mix;
	}

	/** Sequence time (flicks) of the last update. */
	get currentTime(): number {
		return this.time;
	}

	/** The latency plan in use (route delays, stage latencies, read-ahead). */
	get latencyPlan(): MixLatencyPlan {
		return this.plan;
	}

	/** Read-ahead of the graph in seconds: every source plays this much early so the Mix lines up with the picture. */
	get latency(): number {
		return this.plan.total / this.ctx.sampleRate;
	}

	/** Called when the graph's read-ahead changes (AudioLayer reschedules its sources). */
	onLatency(cb: () => void): () => void {
		this.latencyListeners.add(cb);
		return () => this.latencyListeners.delete(cb);
	}

	/**
	 * How early (seconds) a clip's source must play: the graph read-ahead plus, for a clip with enabled effects, the
	 * latency of its effect slots (the export pre-rolls them).
	 */
	clipLead(clip: Pick<RenderAudioClip, 'effects'>): number {
		const fx = clipHasEffects(clip) ? clipEffectsLatency(clip.effects, this.ctx.sampleRate) : 0;
		return (fx + this.plan.total) / this.ctx.sampleRate;
	}

	private limiterLatency(): number {
		this.limiterLatencySamples ??= new TruePeakLimiter(this.ctx.sampleRate, 1, {
			ceilingDb: -1,
			lookaheadMs: LIMITER_LOOKAHEAD_MS,
		}).latency;
		return this.limiterLatencySamples;
	}

	/** Recomputes the latency plan when the mix (or the limiter state) changed; sets every route delay. */
	private replan(mix: RenderAudioMix, force: boolean): void {
		const extra = this.limiter && mix.loudness ? this.limiterLatency() : 0;
		if (!force && mix === this.plannedMix && extra === this.plannedExtra) return;
		this.plannedMix = mix;
		this.plannedExtra = extra;
		const sr = this.ctx.sampleRate;
		const plan = planMixLatency(mix, (e) => previewInsertLatency(e, sr), extra);
		for (const s of mix.strips) {
			const st = this.strips.get(s.id);
			const r = plan.strips[s.id];
			if (!st || !r) continue;
			st.out?.set(r.outDelay);
			for (const x of st.sends) x.route.set(r.sendDelays[x.id] ?? 0);
		}
		const changed = plan.total !== this.plan.total;
		this.plan = plan;
		if (changed) for (const cb of [...this.latencyListeners]) cb();
	}

	/** The node Remotion's per-clip gain must connect to for `clip` (stable for the life of the clip id). */
	clipInput(clip: RenderAudioClip): GainNode {
		let c = this.clips.get(clip.clipId);
		if (!c) {
			c = new ClipNodes(this.ctx, clip);
			this.clips.set(clip.clipId, c);
			const st = this.strips.get(clip.trackId);
			if (st) c.connect(clip, st.width, st.input, this.time);
		}
		return c.input;
	}

	releaseClip(clipId: string): void {
		const c = this.clips.get(clipId);
		if (!c) return;
		c.dispose();
		this.clips.delete(clipId);
	}

	/** Holds a control at `value` (`lane`: volume, pan, mute, pan51.*, send.<id>.level, clip.volume, clip.pan). */
	setOverride(stripId: string, lane: string, value: number | null): void {
		const k = `${stripId}|${lane}`;
		if (value === null) this.overrides.delete(k);
		else this.overrides.set(k, value);
		if (this.mix) this.applyValues(true);
	}

	getOverride(stripId: string, lane: string): number | undefined {
		return this.overrides.get(`${stripId}|${lane}`);
	}

	clearOverrides(): void {
		this.overrides.clear();
		if (this.mix) this.applyValues(true);
	}

	/** Meter readings of a strip (`master` = the Mix, with loudness). Returns an unsubscribe function. */
	onMeter(stripId: string, cb: Listener<MeterReading>): () => void {
		let set = this.meterListeners.get(stripId);
		if (!set) {
			set = new Set();
			this.meterListeners.set(stripId, set);
		}
		set.add(cb);
		return () => set!.delete(cb);
	}

	lastMeter(stripId: string): MeterReading | undefined {
		return this.lastReadings.get(stripId);
	}

	/** Resets the integrated loudness / LRA / true-peak accumulation of the Mix meter. */
	resetLoudness(): void {
		this.masterMeter?.port.postMessage({ type: 'reset' });
	}

	/** Called whenever the topology changed (strip list). */
	onChange(cb: () => void): () => void {
		this.changeListeners.add(cb);
		return () => this.changeListeners.delete(cb);
	}

	get metersAvailable(): boolean {
		return this.workletReady;
	}

	private makeMeter(id: string, channels: number, loudness: boolean): AudioWorkletNode | null {
		if (!this.workletReady) return null;
		const node = new AudioWorkletNode(this.ctx, 'jasper-meter', {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [channels],
			channelCount: channels,
			channelCountMode: 'explicit',
			channelInterpretation: 'discrete',
			processorOptions: { channels, loudness },
		});
		node.port.onmessage = (e: MessageEvent) => {
			// anime-allow: wall-clock stamp of a live meter reading (peak-hold decay), never animation time
			const r = { ...(e.data as Omit<MeterReading, 'at'>), at: performance.now() };
			this.lastReadings.set(id, r);
			for (const cb of this.meterListeners.get(id) ?? []) cb(r);
		};
		return node;
	}

	update(mix: RenderAudioMix, clips: readonly RenderAudioClip[], timeFlicks: number, fps: Rational): void {
		this.mix = mix;
		this.clipList = clips as RenderAudioClip[];
		this.fps = fps;
		this.time = timeFlicks;
		const key = JSON.stringify([
			this.workletReady,
			mix.masterFormat,
			mix.strips.map((s) => [
				s.id,
				s.format,
				s.output,
				s.outputFormat,
				s.sends.map((x) => [x.id, x.target, x.preFader]),
			]),
		]);
		const rebuilt = key !== this.structure;
		if (rebuilt) {
			this.rebuild(mix);
			this.structure = key;
		}
		this.replan(mix, rebuilt);
		if (rebuilt) for (const cb of this.changeListeners) cb();
		// clips: (re)connect to their track input
		const byId = new Map(clips.map((c) => [c.clipId, c]));
		for (const [id, c] of this.clips) {
			const clip = byId.get(id);
			if (!clip) continue;
			const st = this.strips.get(clip.trackId);
			if (!st) continue;
			if (c.clip.trackId !== clip.trackId || c.clip !== clip || c.trackWidth !== st.width) {
				c.connect(clip, st.width, st.input, timeFlicks);
			}
		}
		this.applyValues(false);
	}

	private rebuild(mix: RenderAudioMix): void {
		for (const st of this.strips.values()) st.dispose();
		this.strips.clear();
		this.masterMeter?.disconnect();
		this.limiter?.disconnect();
		this.device?.dispose();
		this.loudGain.disconnect();
		this.order = mix.strips;
		const mw = widthOf(mix.masterFormat);
		for (const s of mix.strips) {
			const ow = s.outputFormat ? widthOf(s.outputFormat) : mw;
			// The Mix is metered after the limiter (with loudness) under the same id: no second meter here, or
			// its silent readings would race the real ones.
			const meter = s.kind === 'master' ? null : this.makeMeter(s.id, widthOf(s.format), false);
			this.strips.set(s.id, new StripNodes(this.ctx, s, ow, meter));
		}
		// routing (outputs and sends)
		for (const s of mix.strips) {
			const st = this.strips.get(s.id)!;
			if (s.output) {
				const target = this.strips.get(s.output);
				if (target) st.out = new DelayRoute(this.ctx, st.gate, target.input, target.width);
			}
			st.sends = s.sends.flatMap((x) => {
				const target = this.strips.get(x.target);
				if (!target) return [];
				const level = discreteGain(this.ctx, st.width);
				const matrix = new MatrixNode(this.ctx, st.width, target.width);
				const gate = discreteGain(this.ctx, target.width);
				(x.preFader ? st.pre.output : st.post.output).connect(level);
				level.connect(matrix.input);
				matrix.output.connect(gate);
				const route = new DelayRoute(this.ctx, gate, target.input, target.width);
				return [{ id: x.id, target: x.target, preFader: x.preFader, level, matrix, gate, route }];
			});
		}
		// the Mix → loudness gain → limiter → meter (levels + loudness) → device fold → Remotion's output gain
		const master = this.strips.get('master')!;
		this.loudGain = discreteGain(this.ctx, mw);
		master.gate.connect(this.loudGain);
		let last: AudioNode = this.loudGain;
		if (this.workletReady) {
			this.limiter = new AudioWorkletNode(this.ctx, 'jasper-limiter', {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [mw],
				channelCount: mw,
				channelCountMode: 'explicit',
				channelInterpretation: 'discrete',
				processorOptions: {
					channels: mw,
					ceilingDb: mix.loudness?.truePeakDb ?? -1,
					enabled: !!mix.loudness,
					lookaheadMs: LIMITER_LOOKAHEAD_MS,
				},
			});
			last.connect(this.limiter);
			last = this.limiter;
			this.masterMeter = this.makeMeter('master', mw, true);
			if (this.masterMeter) {
				last.connect(this.masterMeter);
				last = this.masterMeter;
			}
		} else {
			this.limiter = null;
			this.masterMeter = null;
		}
		this.device = new MatrixNode(this.ctx, mw, 2);
		this.device.set(this.deviceMatrix(mw), true);
		last.connect(this.device.input);
		this.device.output.connect(this.destination);
		// existing clips → their (new) track inputs
		const byId = new Map(this.clipList.map((c) => [c.clipId, c]));
		for (const [id, c] of this.clips) {
			const clip = byId.get(id) ?? c.clip;
			const st = this.strips.get(clip.trackId);
			if (st) c.connect(clip, st.width, st.input, this.time);
		}
	}

	/** The Mix → device fold with the meters' channel solo applied (soloed channels only, folded the same way). */
	private deviceMatrix(mw: number): number[][] {
		const m = conversionMatrix(layoutFromChannels(mw), 'stereo', this.mixdown);
		if (this.monitorSolo.size === 0) return m;
		const solo = mw === 2 ? m.map((row) => row.map((v, j) => (this.monitorSolo.has(j) ? v : 0))) : m;
		if (mw !== 2) return m.map((row) => row.map((v, j) => (this.monitorSolo.has(j) ? v : 0)));
		// stereo: a soloed channel is heard on both sides (Premiere's meter solo buttons)
		if (this.monitorSolo.size === 1) {
			const j = [...this.monitorSolo][0]!;
			return [
				[j === 0 ? 1 : 0, j === 1 ? 1 : 0],
				[j === 0 ? 1 : 0, j === 1 ? 1 : 0],
			];
		}
		return solo;
	}

	/** Solo output channels on the monitor (Audio Meters' S buttons). */
	setMonitorSolo(channels: Iterable<number>): void {
		this.monitorSolo = new Set(channels);
		if (this.device && this.mix) this.device.set(this.deviceMatrix(widthOf(this.mix.masterFormat)));
		for (const cb of this.changeListeners) cb();
	}

	get monitorSoloChannels(): ReadonlySet<number> {
		return this.monitorSolo;
	}

	/** 5.1 mixdown type of the device fold (Preferences ▸ Audio). */
	setMixdown(m: Mixdown): void {
		if (this.mixdown === m) return;
		this.mixdown = m;
		if (this.device && this.mix) this.device.set(this.deviceMatrix(widthOf(this.mix.masterFormat)));
	}

	private ov(stripId: string, lane: string): number | undefined {
		return this.overrides.get(`${stripId}|${lane}`);
	}

	/**
	 * Evaluates every lane and ramps the nodes there. Each stage is evaluated at the sequence time of the samples it
	 * is processing (the picture time plus the read-ahead not yet spent upstream, `stripStageTimes`), as the export does.
	 */
	private applyValues(instant: boolean): void {
		const mix = this.mix!;
		const sr = this.ctx.sampleRate;
		for (const s of this.order) {
			const st = this.strips.get(s.id);
			if (!st) continue;
			const times = stripStageTimes(this.plan, s.id, this.time, sr);
			const t = times.fader;
			const vol = this.ov(s.id, 'volume') ?? laneAt(s.volumeDb, t);
			setParam(st.fader.gain, dbToGain(vol), this.ctx, instant);
			const mute = s.kind === 'master' ? 0 : (this.ov(s.id, 'mute') ?? laneAt(s.mute, t, true));
			setParam(st.mute.gain, mute >= 0.5 ? 0 : 1, this.ctx, instant);
			setParam(st.gate.gain, s.silent ? 0 : 1, this.ctx, true);
			if (st.inputMap) {
				const m =
					s.inputMap === 'left'
						? [
								[1, 0],
								[1, 0],
							]
						: s.inputMap === 'right'
							? [
									[0, 1],
									[0, 1],
								]
							: s.inputMap === 'swap'
								? [
										[0, 1],
										[1, 0],
									]
								: s.inputMap === 'mono'
									? [
											[0.5, 0.5],
											[0.5, 0.5],
										]
									: [
											[1, 0],
											[0, 1],
										];
				st.inputMap.set(m, true);
			}
			if (st.pan) {
				const pan = this.ov(s.id, 'pan') ?? laneAt(s.pan, times.pan);
				st.pan.set(
					panStageMatrix(st.width, st.outWidth, pan, this.puck(s, times.pan), this.mixdown),
					instant,
				);
			}
			for (const x of st.sends) {
				const send = s.sends.find((y) => y.id === x.id);
				if (!send) continue;
				const ts = send.preFader ? times.fader : times.pan;
				const lv = this.ov(s.id, `send.${x.id}.level`) ?? laneAt(send.levelDb, ts);
				setParam(x.level.gain, dbToGain(lv), this.ctx, instant);
				const target = this.strips.get(x.target);
				x.matrix.set(
					panStageMatrix(st.width, target?.width ?? 2, send.pan, this.puck(s, ts), this.mixdown),
					instant,
				);
				setParam(x.gate.gain, s.silent ? 0 : 1, this.ctx, true);
			}
			st.pre.sync(
				s.inserts.filter((e) => !e.postFader),
				times.preInserts,
			);
			st.post.sync(
				s.inserts.filter((e) => !!e.postFader),
				times.postInserts,
			);
		}
		// loudness normalisation
		setParam(this.loudGain.gain, mix.loudness ? dbToGain(mix.loudness.gainDb) : 1, this.ctx, instant);
		this.limiter?.port.postMessage({ enabled: !!mix.loudness, ceilingDb: mix.loudness?.truePeakDb ?? -1 });
		// clips: their nodes process the samples `total` ahead of the picture (the read-ahead)
		const t = this.time;
		const ahead = t + (this.plan.total * FLICKS_PER_SECOND) / sr;
		const byId = new Map(this.clipList.map((c) => [c.clipId, c]));
		for (const [id, c] of this.clips) {
			const clip = byId.get(id);
			if (!clip) continue;
			const vo = this.ov(clip.trackId, 'clip.volume');
			const po = this.ov(clip.trackId, 'clip.pan');
			const F = flicksPerFrame(this.fps);
			const under = clip.start * F <= t && t < (clip.start + clip.duration) * F;
			const override =
				under && (vo !== undefined || po !== undefined)
					? { ...(vo !== undefined ? { volume: vo } : {}), ...(po !== undefined ? { pan: po } : {}) }
					: null;
			c.update(clip, ahead, override, instant, this.fps);
		}
	}

	/**
	 * The 5.1 puck of a strip at `t` (live overrides first). Sends into a 5.1 bus use the strip's puck too, as the
	 * export's pan stage does.
	 */
	private puck(s: RenderStrip, t: number): { x: number; y: number; center: number; lfeDb: number } {
		return {
			x: this.ov(s.id, 'pan51.x') ?? laneAt(s.pan51.x, t),
			y: this.ov(s.id, 'pan51.y') ?? laneAt(s.pan51.y, t),
			center: this.ov(s.id, 'pan51.center') ?? laneAt(s.pan51.center, t),
			lfeDb: this.ov(s.id, 'pan51.lfe') ?? laneAt(s.pan51.lfe, t),
		};
	}

	dispose(): void {
		for (const st of this.strips.values()) st.dispose();
		for (const c of this.clips.values()) c.dispose();
		this.strips.clear();
		this.clips.clear();
		this.device?.dispose();
		this.limiter?.disconnect();
		this.masterMeter?.disconnect();
	}
}

const graphs = new WeakMap<BaseAudioContext, MixGraph>();
let active: MixGraph | null = null;
const activeListeners = new Set<(g: MixGraph | null) => void>();

/** The graph of a Remotion AudioContext (created on first use) feeding `destination` (Remotion's output gain). */
export function mixGraphFor(ctx: AudioContext, destination: AudioNode): MixGraph {
	let g = graphs.get(ctx);
	if (!g || g.destination !== destination) {
		g?.dispose();
		g = new MixGraph(ctx, destination);
		graphs.set(ctx, g);
	}
	if (active !== g) {
		active = g;
		for (const cb of activeListeners) cb(g);
	}
	return g;
}

/** The Program monitor's preview mix (the Audio Meters / Track Mixer panels subscribe to it). */
export function activeMixGraph(): MixGraph | null {
	return active;
}

export function onActiveMixGraph(cb: (g: MixGraph | null) => void): () => void {
	activeListeners.add(cb);
	return () => activeListeners.delete(cb);
}

/** Seconds of sequence time → flicks (helper for UIs). */
export function secondsToFlicks(s: number): number {
	return Math.round(s * FLICKS_PER_SECOND);
}
