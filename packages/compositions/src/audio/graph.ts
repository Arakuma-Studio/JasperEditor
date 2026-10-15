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
import { audioGainAt, MAX_PREVIEW_GAIN, dbToGain as pipelineDbToGain } from '../pipeline.ts';
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
	/** Samples the sources play ahead of the picture (`plan.total`, or the read-ahead held while playing). */
	readAhead = plan.total,
): { preInserts: number; fader: number; postInserts: number; pan: number } {
	const r = plan.strips[stripId];
	const fps = FLICKS_PER_SECOND / sampleRate;
	if (!r) return { preInserts: t, fader: t, postInserts: t, pan: t };
	const at = (lat: number) => t + (readAhead - lat) * fps;
	return { preInserts: at(r.inLat), fader: at(r.preLat), postInserts: at(r.preLat), pan: at(r.postLat) };
}

/**
 * Segment lengths (samples) of a route delay changed to `target` while audio flows through it (sound-design Phase 0
 * close-out): the audio in flight is kept. A longer delay appends a segment (`target − current`: that much silence,
 * then the audio continues); a shorter one shortens the last segments (the output skips ahead). Lengths are > 0.
 */
export function liveDelaySegments(current: readonly number[], target: number): number[] {
	const n = Number.isFinite(target) && target > 0 ? Math.round(target) : 0;
	const segs = current.filter((s) => s > 0);
	const sum = segs.reduce((a, b) => a + b, 0);
	if (n >= sum) return n > sum ? [...segs, n - sum] : segs;
	let cut = sum - n;
	while (cut > 0 && segs.length > 0) {
		const last = segs[segs.length - 1]!;
		if (last > cut) {
			segs[segs.length - 1] = last - cut;
			cut = 0;
		} else {
			segs.pop();
			cut -= last;
		}
	}
	return segs;
}

/**
 * Remotion's audio sync anchor (context time of sequence time 0) for a primed start: the picture waits `wait` seconds
 * after Play while the sources start at the play position, so the anchor moves `wait` later. `ours` is the shift
 * written last; when the anchor still holds it, the base is the value Remotion had then, else Remotion has written a
 * new anchor since (a seek, a pause) and that is the base.
 */
export function primedAnchor(
	current: number,
	ours: { base: number; shift: number } | null,
	wait: number,
): { base: number; value: number } {
	const base = ours && Math.abs(current - (ours.base + ours.shift)) < 1e-9 ? ours.base : current;
	const w = Number.isFinite(wait) && wait > 0 ? wait : 0;
	return { base, value: base + w };
}

/** Longest picture wait (s) of a primed start; a larger read-ahead starts unprimed (its first samples are lost). */
export const MAX_PRIMED_WAIT = 0.5;
/** Fade-out (s) of the graph's stale audio at a seek during playback, before its delay lines and effects are reset. */
export const FLUSH_FADE = 0.003;
/** Fade-in (s) at the start of a primed playback: Remotion's own resume fade, moved to where the program starts. */
export const START_FADE = 0.03;

/**
 * What the graph needs from Remotion's shared audio context to follow the transport: the audio sync anchor and its
 * change events (a seek or jump: every media player reschedules its buffers).
 */
export type RemotionAudioSync = {
	anchor: { value: number };
	subscribe(cb: (event: string) => void): () => void;
};

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

type Slot = { id: string; effectId: string; ins: PreviewInsert | null };

class SlotChain {
	readonly input: GainNode;
	readonly output: GainNode;
	private slots: Slot[] = [];
	private effects: readonly EffectInstance[] = [];

	constructor(
		private readonly ctx: BaseAudioContext,
		private readonly channels: number,
	) {
		this.input = discreteGain(ctx, channels);
		this.output = discreteGain(ctx, channels);
		this.input.connect(this.output);
	}

	private make(e: EffectInstance): Slot {
		const f = insertFactories.get(e.effectId);
		return { id: e.id, effectId: e.effectId, ins: f ? f(this.ctx, e, this.channels) : null };
	}

	/** Connects input → slots → output in order (every outgoing connection of the chain is made here). */
	private link(next: Slot[]): void {
		this.input.disconnect();
		for (const s of this.slots) s.ins?.output.disconnect();
		for (const s of next) s.ins?.output.disconnect();
		this.slots = next;
		let last: AudioNode = this.input;
		for (const s of this.slots) {
			if (!s.ins) continue;
			last.connect(s.ins.input);
			last = s.ins.output;
		}
		last.connect(this.output);
	}

	/**
	 * Relinks the chain when the effect list changed; updates every slot. Slots of instances still in the list keep
	 * their processor (state and audio in flight): adding, removing or reordering one effect does not restart the
	 * others (sound-design Phase 0 close-out).
	 */
	sync(effects: readonly EffectInstance[], time: number): void {
		const key = effects.map((e) => `${e.id}:${e.effectId}`).join(',');
		if (key !== this.slots.map((s) => `${s.id}:${s.effectId}`).join(',')) {
			const old = new Map<string, Slot>();
			for (const s of this.slots) old.set(`${s.id}:${s.effectId}`, s);
			const next = effects.map((e) => {
				const k = `${e.id}:${e.effectId}`;
				const s = old.get(k);
				if (!s) return this.make(e);
				old.delete(k);
				return s;
			});
			for (const s of old.values()) {
				s.ins?.output.disconnect();
				s.ins?.dispose();
			}
			this.link(next);
		}
		this.effects = effects;
		effects.forEach((e, i) => {
			this.slots[i]?.ins?.update(e, time);
		});
	}

	/** New processors for every slot (no state, nothing in flight): the effects start like an export at this point. */
	reset(): void {
		if (this.slots.length === 0) return;
		const old = this.slots;
		const next = this.effects.map((e) => this.make(e));
		this.link(next);
		for (const s of old) s.ins?.dispose();
	}

	dispose(): void {
		this.input.disconnect();
		for (const s of this.slots) s.ins?.dispose();
		this.output.disconnect();
	}
}

/**
 * A route into a bus (`from` → `to`) with an optional latency-compensation delay (DelayNodes only when needed).
 * Integer sample delays: the DelayNodes read exactly `samples` back. A change while audio flows (`live`) keeps the
 * audio in flight (`liveDelaySegments`); otherwise, and on `reset`, the route gets one fresh, empty delay line.
 */
class DelayRoute {
	private segs: { node: DelayNode; samples: number }[] = [];
	samples = 0;

	constructor(
		private readonly ctx: BaseAudioContext,
		private readonly from: AudioNode,
		private readonly to: AudioNode,
		private readonly channels: number,
	) {
		from.connect(to);
	}

	private node(samples: number): DelayNode {
		const sec = samples / this.ctx.sampleRate;
		const d = this.ctx.createDelay(Math.min(179, sec + 0.01));
		d.channelCount = this.channels;
		d.channelCountMode = 'explicit';
		d.channelInterpretation = 'discrete';
		d.delayTime.value = sec;
		return d;
	}

	private link(next: { node: DelayNode; samples: number }[]): void {
		this.from.disconnect();
		for (const s of this.segs) s.node.disconnect();
		for (const s of next) s.node.disconnect();
		this.segs = next;
		let last: AudioNode = this.from;
		for (const s of next) {
			last.connect(s.node);
			last = s.node;
		}
		last.connect(this.to);
		this.samples = next.reduce((a, s) => a + s.samples, 0);
	}

	set(samples: number, live = false): void {
		const n = Number.isFinite(samples) && samples > 0 ? Math.round(samples) : 0;
		if (n === this.samples) return;
		if (!live) {
			this.link(n > 0 ? [{ node: this.node(n), samples: n }] : []);
			return;
		}
		const lens = liveDelaySegments(
			this.segs.map((s) => s.samples),
			n,
		);
		const next = lens.map((len, i) => {
			const s = this.segs[i];
			if (s && s.samples === len) return s;
			if (s && i === lens.length - 1 && len < s.samples) {
				// the last kept segment shortens: the output skips ahead by the difference
				s.node.delayTime.value = len / this.ctx.sampleRate;
				return { node: s.node, samples: len };
			}
			return { node: this.node(len), samples: len };
		});
		this.link(next);
	}

	/** One fresh delay line of the current length: nothing in flight. */
	reset(): void {
		if (this.samples === 0) return;
		this.link([{ node: this.node(this.samples), samples: this.samples }]);
	}

	dispose(): void {
		this.from.disconnect();
		for (const s of this.segs) s.node.disconnect();
		this.segs = [];
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

/**
 * The part of a clip's gain + Volume above Remotion's volume limit (`MAX_PREVIEW_GAIN`, +24 dB) at clip-local frame
 * `f`: Remotion's per-clip volume is clamped there, so the graph applies the rest (≥ 1) — the export applies the whole
 * gain (Audio Gain goes up to +96 dB, e.g. Normalize Max Peak of a quiet recording).
 */
export function clipGainExcess(
	clip: Pick<RenderAudioClip, 'duration' | 'sourceIn' | 'speed' | 'gainDb' | 'volumeDb'>,
	f: number,
	fps: Rational,
): number {
	const F = flicksPerFrame(fps);
	const i = Math.max(0, Math.min(clip.duration - 1, f));
	const content = clip.speed.reverse
		? clip.sourceIn + (clip.duration - 1 - i) * F * clip.speed.rate
		: clip.sourceIn + i * F * clip.speed.rate;
	const g = pipelineDbToGain(clip.gainDb + evaluate(clip.volumeDb, content));
	return Number.isFinite(g) && g > MAX_PREVIEW_GAIN ? g / MAX_PREVIEW_GAIN : 1;
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

	/**
	 * (Re)builds the chain for the clip's channel layout and the track width; connects to `dest`. `time` is the time of
	 * the samples the clip nodes process now (the picture time plus the graph's read-ahead), `fps` the sequence rate.
	 */
	connect(clip: RenderAudioClip, trackWidth: number, dest: AudioNode, time: number, fps?: Rational): void {
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
		this.update(clip, time, null, true, fps);
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
		// Gain above Remotion's volume limit: the trim (before the effect slots) for a clip Remotion plays at its levels,
		// the level node (after them) for a clip with effects.
		const fx = clipHasEffects(clip);
		const excess = clipGainExcess(clip, t / F - clip.start, rate);
		const trimGain = (Number.isFinite(trim) ? Math.min(trim, 64) : 1) * (fx ? 1 : excess);
		setParam(this.trim.gain, trimGain, this.ctx, instant);
		this.slots?.sync(
			clip.effects.filter((e) => e.enabled),
			content,
		);
		if (this.level)
			setParam(
				this.level.gain,
				fx ? clipLevelAt(clip, t / F - clip.start, rate) * excess : 1,
				this.ctx,
				instant,
			);
	}

	/** Fresh clip effect processors (a discontinuity: nothing of the audio before it stays in flight). */
	reset(): void {
		this.slots?.reset();
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
	/** The node after the limiter (the Mix meter or the device fold): where a fresh limiter connects. */
	private limiterNext: AudioNode | null = null;
	/** The Mix → loudness gain route; delays the Mix by `readAhead − plan.total` while a longer read-ahead is held. */
	private pad: DelayRoute | null = null;
	/** Graph output (before Remotion's gain node): fades for discontinuities and the primed start. */
	private readonly outGain: GainNode;
	// Transport (sound-design Phase 0 close-out). `readAhead`: samples the sources play ahead of the picture. It
	// follows the plan while paused and is held while playing: a latency change during playback then never
	// reschedules the media (the Mix is padded to it, or plays the difference late until playback stops).
	private readAhead = 0;
	private playing = false;
	/** Changes whenever every media player must reschedule from scratch (read-ahead or anchor changed while paused). */
	private scheduleEpoch = 0;
	private sync: RemotionAudioSync | null = null;
	private unsubscribeSync: (() => void) | null = null;
	/** No audio of the present position is in flight: the next Play is a primed start. */
	private fresh = true;
	/** Latent state already reset since the context last ran. */
	private flushed = false;
	/** The anchor shift written for a primed start (`primedAnchor`). */
	private shift: { base: number; shift: number } | null = null;
	/** Seconds the picture waits after the next resume (the program output starts that much after the context). */
	private startWait = 0;
	/** Context time where the primed start resumes (the frozen time of the suspended context). */
	private startAt = 0;
	private flushToken = 0;
	private disposed = false;

	constructor(
		readonly ctx: AudioContext,
		readonly destination: AudioNode,
	) {
		this.loudGain = discreteGain(ctx, 2);
		this.outGain = ctx.createGain();
		this.outGain.connect(destination);
		void mixWorkletReady(ctx).then((ok) => {
			this.workletReady = ok;
			if (ok && this.mix) {
				this.structure = '';
				this.update(this.mix, this.clipList, this.time, this.fps);
			}
		});
	}

	/**
	 * Follows Remotion's transport (the Program monitor): flushes the graph's delay lines and effect state at a seek,
	 * and primes a start from a paused seek — the sources start at the play position and the picture waits for the
	 * program to reach the output (the read-ahead), so nothing at the play position is lost. Idempotent.
	 */
	attachSync(sync: RemotionAudioSync): void {
		if (this.sync === sync || this.disposed) return;
		this.detachSync();
		this.sync = sync;
		const off = sync.subscribe((e) => {
			if (e === 'changed') this.discontinuity();
		});
		const onState = () => this.onContextState();
		this.ctx.addEventListener?.('statechange', onState);
		// Remotion starts the picture once the context's output timestamp passes the resume time
		// (`waitUntilActuallyResumed`). The program reaches the output `startWait` later than the context's own
		// output: report that, so a primed start shows its first frame with its first sample.
		const native = (this.ctx as { getOutputTimestamp?: () => AudioTimestamp }).getOutputTimestamp;
		const shimmed = typeof native === 'function';
		if (shimmed)
			Object.defineProperty(this.ctx, 'getOutputTimestamp', {
				configurable: true,
				writable: true,
				value: () => {
					const t = native.call(this.ctx);
					const w = this.startWait;
					if (!(w > 0) || t.contextTime === undefined || t.performanceTime === undefined) return t;
					// the program has reached the output: the start is over, report the context's own timestamp again
					if (t.contextTime >= this.startAt + w) {
						this.startWait = 0;
						return t;
					}
					return { contextTime: t.contextTime - w, performanceTime: t.performanceTime - w * 1000 };
				},
			});
		this.unsubscribeSync = () => {
			off();
			this.ctx.removeEventListener?.('statechange', onState);
			if (shimmed) delete (this.ctx as { getOutputTimestamp?: unknown }).getOutputTimestamp;
		};
		this.prime(false);
	}

	private detachSync(): void {
		this.unsubscribeSync?.();
		this.unsubscribeSync = null;
		this.sync = null;
	}

	/** Remotion's playing state: the read-ahead is held while playing and follows the plan while paused. */
	setPlaying(playing: boolean): void {
		if (this.playing === playing) return;
		this.playing = playing;
		if (!playing) this.followPlan();
	}

	/** Bumped when every source must reschedule (AudioLayer re-creates its media players while paused). */
	get epoch(): number {
		return this.scheduleEpoch;
	}

	private notify(): void {
		for (const cb of [...this.latencyListeners]) cb();
	}

	/** While paused: the read-ahead takes the plan's (every source reschedules; the next Play is primed). */
	private followPlan(): void {
		if (this.playing) return;
		const p = this.plan.total;
		if (p !== this.readAhead) {
			this.readAhead = p;
			this.scheduleEpoch++;
			this.fresh = true;
			this.notify();
		}
		this.pad?.set(Math.max(0, this.readAhead - p), false);
		this.prime(false);
	}

	private onContextState(): void {
		const s = this.ctx.state;
		if (s === 'running') {
			// a run starts: whatever was primed is in use now
			this.fresh = false;
			this.flushed = false;
		} else if (s === 'suspended') {
			this.startWait = 0;
			// after Remotion's own handler (it re-anchors to the picture on suspend)
			setTimeout(() => this.prime(false), 0);
		}
	}

	/** A seek or jump (Remotion re-anchored; every media player reschedules from the new position). */
	private discontinuity(): void {
		if (this.playing) {
			// what the graph still holds of the old position is audible: fade it out and reset
			if (this.ctx.state === 'running') this.fadeFlush();
			return;
		}
		// Paused: the next Play starts from the new position, primed. Remotion reschedules every player itself; if
		// the context is still suspending, the 'suspended' handler primes (and has the players reschedule again).
		this.fresh = true;
		this.prime(true);
	}

	/** The largest clip-effect latency (samples) of the mounted clips. */
	private maxClipFx(): number {
		let m = 0;
		for (const c of this.clips.values())
			if (clipHasEffects(c.clip)) m = Math.max(m, clipEffectsLatency(c.clip.effects, this.ctx.sampleRate));
		return m;
	}

	/**
	 * Primes the next start while paused after a discontinuity: resets the latent state, moves Remotion's anchor by
	 * the wait (read-ahead + clip effect latency) so the sources start at the play position, has the picture wait as
	 * long, and fades the program in where it starts. `fromSeek`: Remotion is rescheduling every player already.
	 */
	private prime(fromSeek: boolean): void {
		const sync = this.sync;
		if (!sync || !this.fresh || this.disposed || this.ctx.state !== 'suspended') return;
		if (!this.flushed) {
			this.flush();
			this.flushed = true;
		}
		// a fade-out of a seek during playback still pending: priming owns the output gain now
		this.flushToken++;
		let wait = (this.readAhead + this.maxClipFx()) / this.ctx.sampleRate;
		if (!(wait > 0) || wait > MAX_PRIMED_WAIT) wait = 0;
		const a = primedAnchor(sync.anchor.value, this.shift, wait);
		const changed = !this.shift || a.base !== this.shift.base || wait !== this.shift.shift;
		sync.anchor.value = a.value;
		this.shift = { base: a.base, shift: wait };
		// The context's time is frozen while suspended: the next run starts at `t0`, the program `wait` later.
		const g = this.outGain.gain;
		const t0 = this.ctx.currentTime;
		this.startWait = wait;
		this.startAt = t0;
		g.cancelScheduledValues(0);
		g.setValueAtTime(wait > 0 ? 0 : 1, t0);
		if (wait > 0) {
			g.setValueAtTime(0, t0 + wait);
			g.linearRampToValueAtTime(1, t0 + wait + START_FADE);
		}
		if (changed && !fromSeek) {
			this.scheduleEpoch++;
			this.notify();
		}
	}

	/** Resets every delay line and effect processor: nothing from before stays in flight (`MixGraph.flush`). */
	flush(): void {
		for (const st of this.strips.values()) {
			st.pre.reset();
			st.post.reset();
			st.out?.reset();
			for (const x of st.sends) x.route.reset();
		}
		this.pad?.reset();
		for (const c of this.clips.values()) c.reset();
		if (this.limiter && this.limiterNext && this.mix) {
			const fresh = this.makeLimiter(widthOf(this.mix.masterFormat), this.mix);
			this.loudGain.disconnect();
			this.loudGain.connect(fresh);
			fresh.connect(this.limiterNext);
			this.limiter.disconnect();
			this.limiter.port.close();
			this.limiter = fresh;
		}
	}

	/** A seek while playing: fades out what the graph still holds of the old position, then flushes. */
	private fadeFlush(): void {
		this.startWait = 0;
		const g = this.outGain.gain;
		const t = this.ctx.currentTime;
		g.cancelScheduledValues(t);
		g.setValueAtTime(g.value, t);
		g.linearRampToValueAtTime(0, t + FLUSH_FADE);
		const token = ++this.flushToken;
		const done = () => {
			if (token !== this.flushToken || this.disposed) return;
			if (this.ctx.state === 'running' && this.ctx.currentTime < t + FLUSH_FADE) {
				setTimeout(done, 1);
				return;
			}
			this.flush();
			const t2 = this.ctx.currentTime;
			g.cancelScheduledValues(t2);
			g.setValueAtTime(1, t2);
		};
		setTimeout(done, FLUSH_FADE * 1000);
	}

	private makeLimiter(mw: number, mix: RenderAudioMix): AudioWorkletNode {
		return new AudioWorkletNode(this.ctx, 'jasper-limiter', {
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

	/** Sequence time (flicks) of the samples the clip nodes process now: the picture time plus the read-ahead. */
	private aheadTime(): number {
		return this.time + (this.readAhead * FLICKS_PER_SECOND) / this.ctx.sampleRate;
	}

	/**
	 * Read-ahead of the graph in seconds: every source plays this much early so the Mix lines up with the picture. The
	 * plan's total while paused; held while playing (`setPlaying`).
	 */
	get latency(): number {
		return this.readAhead / this.ctx.sampleRate;
	}

	/** Called when the graph's read-ahead or schedule epoch changes (AudioLayer reschedules its sources). */
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
		return (fx + this.readAhead) / this.ctx.sampleRate;
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
		// While playing, keep the audio in flight (a changed route delay inserts silence or skips, never restarts).
		const live = this.playing && !force;
		for (const s of mix.strips) {
			const st = this.strips.get(s.id);
			const r = plan.strips[s.id];
			if (!st || !r) continue;
			st.out?.set(r.outDelay, live);
			for (const x of st.sends) x.route.set(r.sendDelays[x.id] ?? 0, live);
		}
		this.plan = plan;
		if (this.playing) this.pad?.set(Math.max(0, this.readAhead - plan.total), live);
		else this.followPlan();
	}

	/** The node Remotion's per-clip gain must connect to for `clip` (stable for the life of the clip id). */
	clipInput(clip: RenderAudioClip): GainNode {
		let c = this.clips.get(clip.clipId);
		if (!c) {
			c = new ClipNodes(this.ctx, clip);
			this.clips.set(clip.clipId, c);
			const st = this.strips.get(clip.trackId);
			if (st) c.connect(clip, st.width, st.input, this.aheadTime(), this.fps);
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
		// The strips' lanes, inserts and send levels change without a rebuild (same topology): always read the new mix.
		this.order = mix.strips;
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
				c.connect(clip, st.width, st.input, this.aheadTime(), this.fps);
			}
		}
		this.applyValues(false);
		// paused before a primed start: the wait follows edits (clip effect latency) made meanwhile
		this.prime(false);
	}

	private rebuild(mix: RenderAudioMix): void {
		for (const st of this.strips.values()) st.dispose();
		this.strips.clear();
		this.masterMeter?.disconnect();
		this.limiter?.disconnect();
		this.limiter?.port.close();
		this.device?.dispose();
		this.pad?.dispose();
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
		// a fresh topology: nothing in flight, the padding starts empty
		this.pad = new DelayRoute(this.ctx, master.gate, this.loudGain, mw);
		this.pad.set(Math.max(0, this.readAhead - this.plan.total));
		let last: AudioNode = this.loudGain;
		this.device = new MatrixNode(this.ctx, mw, 2);
		this.device.set(this.deviceMatrix(mw), true);
		if (this.workletReady) {
			this.limiter = this.makeLimiter(mw, mix);
			last.connect(this.limiter);
			last = this.limiter;
			this.masterMeter = this.makeMeter('master', mw, true);
			this.limiterNext = this.masterMeter ?? this.device.input;
			if (this.masterMeter) {
				last.connect(this.masterMeter);
				last = this.masterMeter;
			}
		} else {
			this.limiter = null;
			this.masterMeter = null;
			this.limiterNext = null;
		}
		last.connect(this.device.input);
		this.device.output.connect(this.outGain);
		// existing clips → their (new) track inputs
		const byId = new Map(this.clipList.map((c) => [c.clipId, c]));
		for (const [id, c] of this.clips) {
			const clip = byId.get(id) ?? c.clip;
			const st = this.strips.get(clip.trackId);
			if (st) c.connect(clip, st.width, st.input, this.aheadTime(), this.fps);
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
			const times = stripStageTimes(this.plan, s.id, this.time, sr, this.readAhead);
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
		const ahead = this.aheadTime();
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
		this.disposed = true;
		this.detachSync();
		for (const st of this.strips.values()) st.dispose();
		for (const c of this.clips.values()) c.dispose();
		this.strips.clear();
		this.clips.clear();
		this.device?.dispose();
		this.pad?.dispose();
		this.limiter?.disconnect();
		this.masterMeter?.disconnect();
		this.outGain.disconnect();
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
