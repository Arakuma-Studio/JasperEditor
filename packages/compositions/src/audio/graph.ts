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
import { followCurve } from './automation.ts';
import type { SlotClock } from './fx-processor.ts';
import { discreteGain, MatrixNode, setParam } from './matrix-node.ts';
import { PrimedStartClock } from './primed-clock.ts';

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
	/** `clock`: while playing, the time's clock (the slot advances it sample by sample, `SlotClock`). */
	update(effect: EffectInstance, timeFlicks: number, clock?: SlotClock): void;
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

/**
 * Longest picture wait (s) of a primed start (sound-design Phase 6: was 0.5 s, and a longer read-ahead lost its first
 * samples). Any plausible effect chain waits less (one FFT-based or look-ahead effect adds 20–43 ms at 48 kHz; it takes
 * some 70 of them in series to reach this); only a longer, pathological read-ahead starts unprimed.
 */
export const MAX_PRIMED_WAIT = 3;
/** A primed wait at least this long (s) is shown as buffering on the Program monitor (`MixGraph.onStartWait`). */
export const VISIBLE_START_WAIT = 0.2;
/**
 * How long (context seconds) Remotion must keep asking for a later audio anchor while playing before the graph lets it
 * re-anchor (`MixGraph` anchor guard): a late frame commit asks once or twice, a real drift keeps asking.
 */
export const ANCHOR_CONFIRM = 0.3;
/** A picture update this long (s) after the one before came late (≈ 3 frames at 30 fps): the main thread was busy. */
const LATE_UPDATE = 0.1;
/** Most Remotion's anchor may differ from the picture (s) after a paused seek before the graph re-anchors (`afterSeek`). */
const ANCHOR_STALE = 0.002;
/** Quiet time (ms) after a paused seek before a stale anchor is fixed (a scrub moves on every frame). */
const STALE_SETTLE_MS = 150;
/** Longest hold (ms) for the sources to start again after a schedule epoch (`bumpEpoch`). */
const GATE_TIMEOUT_MS = 1500;
/** Fade-out (s) of the graph's stale audio at a seek during playback, before its delay lines and effects are reset. */
export const FLUSH_FADE = 0.003;
/**
 * Frames a primed start waits beyond the read-ahead (`MixGraph.prime`): Chrome renders in device callbacks of several
 * quanta (640 frames measured) and its `currentTime` can stay behind where the audio thread stopped by up to one.
 */
export const START_MARGIN = 1024;
/** Fade-in (s) at the start of a primed playback: Remotion's own resume fade, moved to where the program starts. */
export const START_FADE = 0.03;

/**
 * What the graph needs from Remotion's shared audio context to follow the transport: the audio sync anchor and its
 * change events (a seek or jump: every media player reschedules its buffers).
 */
export type RemotionAudioSync = {
	anchor: { value: number };
	subscribe(cb: (event: string) => void): () => void;
	/**
	 * Remotion's anchor emitter (its `dispatch`): the graph holds back the `changed` event of a re-anchor it refuses (a
	 * frame committed late while playing, sound-design Phase 6).
	 */
	emitter?: { dispatch(event: string): void };
};

/** A transport event of the graph, for diagnostics (`globalThis.__jasperTransportLog`, when it is an array). */
export type TransportLogEntry = {
	/** Context time. */
	t: number;
	kind:
		| 'anchor'
		| 'refused'
		| 'confirmed'
		| 'caught-up'
		| 'primed'
		| 'restart'
		| 'gate'
		| 'gate-open'
		| 'stale'
		| 'running'
		| 'suspended'
		| 'play'
		| 'pause';
	/** The anchor after the event (context time of composition time 0). */
	anchor: number;
	/** The anchor Remotion asked for (`refused`) or the shift written (`primed`: the wait). */
	value?: number;
};

function transportLog(e: TransportLogEntry): void {
	const log = (globalThis as { __jasperTransportLog?: unknown }).__jasperTransportLog;
	if (Array.isArray(log)) log.push(e);
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

/** Seconds after lane time `t` (flicks) of the lane's keyframes within `horizon` (break points of a followed curve). */
function laneBreaks(a: Animatable<number>, t: number, horizon = 0.25): number[] {
	const out: number[] = [];
	for (const k of a.keyframes) {
		const dt = (k.time - t) / FLICKS_PER_SECOND;
		if (dt > 0 && dt < horizon) out.push(dt);
	}
	return out;
}

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
	sync(effects: readonly EffectInstance[], time: number, clock?: SlotClock): void {
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
			this.slots[i]?.ins?.update(e, time, clock);
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
	/** The target strip's input node (a replaced target strip needs a new route). */
	to: AudioNode;
};

function disposeSend(x: SendNodes): void {
	x.level.disconnect();
	x.matrix.dispose();
	x.gate.disconnect();
	x.route.dispose();
}

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
	/** Output route into the strip's bus (null for the Mix or a dangling output), and the bus input it feeds. */
	out: DelayRoute | null = null;
	outTo: AudioNode | null = null;
	sends: SendNodes[] = [];
	/** Kind, widths and worklet state the nodes were built for (`MixGraph.rebuild` keeps strips of the same shape). */
	shape = '';

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
		for (const x of this.sends) disposeSend(x);
	}
}

/** audio-fx: a clip whose levels are applied after its effects in the preview (enabled clip effects). */
export function clipHasEffects(clip: Pick<RenderAudioClip, 'effects'>): boolean {
	return clip.effects.some((e) => e.enabled);
}

/** Whether a clip's level changes over time: Volume keyframes, fades or a nested sequence's gain. */
export function clipLevelsAnimated(clip: Pick<RenderAudioClip, 'volumeDb' | 'fades' | 'nestGain'>): boolean {
	return isAnimated(clip.volumeDb) || (clip.fades?.length ?? 0) > 0 || (clip.nestGain?.length ?? 0) > 0;
}

/**
 * Whether the graph applies the clip's levels (gain, Volume, fades, nested gain) in its level node, Remotion playing
 * the clip at unity: clips with enabled effects (export order: effects, then levels) and clips whose level changes
 * over time — the graph follows those sample by sample while playing (`followCurve`, sound-design Phase 4
 * verification), where Remotion's per-clip volume would step once per frame.
 */
export function graphAppliesLevels(
	clip: Pick<RenderAudioClip, 'effects' | 'volumeDb' | 'fades' | 'nestGain'>,
): boolean {
	return clipHasEffects(clip) || clipLevelsAnimated(clip);
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

/**
 * Seconds after sequence time `t` (flicks) where a clip's level may bend within `horizon`: its Volume keyframes
 * (content time mapped to the sequence; forward or reversed constant speed) and its fades' edges.
 */
function clipLevelBreaks(clip: RenderAudioClip, t: number, fps: Rational, horizon = 0.25): number[] {
	const F = flicksPerFrame(fps);
	const out = clipKeyBreaks(clip, clip.volumeDb, t, fps, horizon);
	for (const f of clip.fades ?? [])
		for (const seqFrame of [f.start, f.start + f.frames]) {
			const dt = (seqFrame * F - t) / FLICKS_PER_SECOND;
			if (dt > 0 && dt < horizon) out.push(dt);
		}
	return out;
}

/** Seconds after sequence time `t` (flicks) of a clip lane's keyframes (content time mapped to the sequence). */
function clipKeyBreaks(
	clip: RenderAudioClip,
	a: Animatable<number>,
	t: number,
	fps: Rational,
	horizon = 0.25,
): number[] {
	const F = flicksPerFrame(fps);
	const out: number[] = [];
	const rate = clip.speed.rate > 0 ? clip.speed.rate : 1;
	for (const k of a.keyframes) {
		const local = (k.time - clip.sourceIn) / (F * rate);
		const seqFrame = clip.start + (clip.speed.reverse ? clip.duration - 1 - local : local);
		const dt = (seqFrame * F - t) / FLICKS_PER_SECOND;
		if (dt > 0 && dt < horizon) out.push(dt);
	}
	return out;
}

/** The clip pan stage (clip width → track width) at sequence time `t` (flicks): balance into a stereo track. */
function clipPanMatrix(
	clip: RenderAudioClip,
	w: number,
	tw: number,
	t: number,
	fps: Rational,
	pan?: number,
): number[][] {
	const F = flicksPerFrame(fps);
	const m = conversionMatrix(layoutFromChannels(w), layoutFromChannels(tw));
	if (tw !== 2) return m;
	let p = pan;
	if (p === undefined) {
		const frame = Math.min(clip.start + clip.duration - 1e-6, Math.max(clip.start, t / F));
		p = laneAt(clip.pan, contentTimeAt(clip, frame, fps));
	}
	return p !== 0 ? scaleRows(m, balanceGains(Math.max(-1, Math.min(1, p / 100)))) : m;
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

	/**
	 * Clip pan, effects and the Clip Mixer trim at sequence time `t` (flicks). `follow` (playing): an animated level
	 * the graph applies follows its curve from `t` on, sample by sample (`followCurve`).
	 */
	update(
		clip: RenderAudioClip,
		t: number,
		override: { volume?: number; pan?: number } | null,
		instant = false,
		fps?: Rational,
		follow = false,
		/** Sequence flicks per second of context time while following (the playback rate). */
		followRate = 1,
	): void {
		this.clip = clip;
		if (!this.pan) return;
		const rate = fps ?? { num: 30, den: 1 };
		const F = flicksPerFrame(rate);
		const frame = Math.min(clip.start + clip.duration - 1e-6, Math.max(clip.start, t / F));
		const content = contentTimeAt(clip, frame, rate);
		const w = this.width;
		const tw = this.trackWidth;
		if (follow && !instant && tw === 2 && override?.pan === undefined && isAnimated(clip.pan)) {
			// Playing: the clip's pan keyframes are followed sample by sample (sound-design Phase 6), as the export
			// evaluates them per sample.
			this.pan.follow(
				(dt) => clipPanMatrix(clip, w, tw, t + dt * followRate * FLICKS_PER_SECOND, rate),
				clipKeyBreaks(clip, clip.pan, t, rate).map((b) => b / followRate),
			);
		} else this.pan.set(clipPanMatrix(clip, w, tw, t, rate, override?.pan), instant);
		// Clip Mixer fader held: replace the clip's volume (Remotion applies gain + volume; the trim corrects it).
		const trim =
			override?.volume !== undefined
				? dbToGain(override.volume) / Math.max(1e-9, dbToGain(laneAt(clip.volumeDb, content)))
				: 1;
		// Gain above Remotion's volume limit: the trim (before the effect slots) for a clip Remotion plays at its levels,
		// the level node (after them) for a clip with effects.
		const fx = graphAppliesLevels(clip);
		const excess = clipGainExcess(clip, t / F - clip.start, rate);
		const trimGain = (Number.isFinite(trim) ? Math.min(trim, 64) : 1) * (fx ? 1 : excess);
		setParam(this.trim.gain, trimGain, this.ctx, instant);
		this.slots?.sync(
			clip.effects.filter((e) => e.enabled),
			content,
			follow ? this.slotClock(clip, t, rate, followRate) : undefined,
		);
		if (!this.level) return;
		// The export plays a clip over its span only (handles included): an effect's tail (a filter's ringing, a
		// reverb) stops at its end, so the level node closes there, on the sample.
		const end = clip.duration + (clip.tailHandle ?? 0);
		if (fx && follow && !instant && override?.volume === undefined) {
			const level = (dt: number) => {
				const f = (t + dt * followRate * FLICKS_PER_SECOND) / F - clip.start;
				return clipLevelAt(clip, f, rate) * clipGainExcess(clip, f, rate);
			};
			const cut = ((clip.start + end) * F - t) / FLICKS_PER_SECOND / followRate;
			const breaks = clipLevelBreaks(clip, t, rate).map((b) => b / followRate);
			followCurve(this.level.gain, this.ctx, level, undefined, cut, breaks);
		} else {
			const f = t / F - clip.start;
			setParam(
				this.level.gain,
				fx ? (f < end ? clipLevelAt(clip, f, rate) * excess : 0) : 1,
				this.ctx,
				instant,
			);
		}
	}

	/**
	 * The clock of the clip's effect slots at sequence time `t`: content time, its rate (content flicks per sequence
	 * flick) and the export's control-block grid (samples since the clip's start, where its slots start in the export).
	 */
	private slotClock(clip: RenderAudioClip, t: number, rate: Rational, playbackRate: number): SlotClock {
		const F = flicksPerFrame(rate);
		const sr = this.ctx.sampleRate;
		return {
			at: this.ctx.currentTime,
			rate: clip.speed.rate * (clip.speed.reverse ? -1 : 1) * playbackRate,
			grid: ((t - clip.start * F) * sr) / FLICKS_PER_SECOND,
		};
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
	/**
	 * While playing with Remotion's sync anchor: the sequence time (flicks) of the samples leaving the graph at the
	 * context's current time, and the playback rate (sound-design Phase 4 verification). Automation curves start
	 * there. Null: the picture time stands.
	 */
	private audioClock: { time: number; rate: number } | null = null;
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
	/** The picture's wait after the next resume (the program output starts that much after the context). */
	private readonly startClock = new PrimedStartClock();
	private flushToken = 0;
	private disposed = false;
	/** Writes Remotion's anchor without the guard (the graph's own writes: a primed start, a stall). */
	private writeAnchor: (v: number) => void = (v) => {
		if (this.sync) this.sync.anchor.value = v;
	};
	/** The `changed` event that follows a refused re-anchor is not passed on. */
	private swallowChanged = false;
	/** Refused re-anchors in a row: context time of the first and the last. */
	private refused: { since: number; last: number } | null = null;
	private advancePicture: ((frames: number) => boolean) | null = null;
	private pictureFps = 30;
	/** Context time of the last update while playing, and of the last one that came late (a busy main thread). */
	private lastUpdateAt: number | null = null;
	private lastIrregular = Number.NEGATIVE_INFINITY;
	private readonly restartListeners = new Set<() => void>();
	/** A restart was asked for during this run (asked once per run). */
	private restartAsked = false;
	private readonly startWaitListeners = new Set<(wait: number | null) => void>();
	private idleWaiters: (() => void)[] = [];
	private seekWaiters: (() => void)[] = [];
	/** Composition time (s) of the picture at the last update, and the playback rate (Remotion's anchor relation). */
	private pictureTime: number | null = null;
	private pictureRate = 1;
	private bufferGate: (() => { unblock(): void }) | null = null;
	/** Remotion's buffering flag (its playback loop reads it before resuming the context). */
	private bufferFlag: { current: boolean | null } | null = null;
	/** A paused seek Remotion may have ignored: checked after a quiet moment (`checkPausedSeek`). */
	private staleTimer: ReturnType<typeof setTimeout> | null = null;
	/** `currentTime` once the context stood still after its last suspend (null: not settled yet, or running). */
	private frozenAt: number | null = null;
	private settleToken = 0;
	private gateHandle: { unblock(): void } | null = null;
	private gateTimer: ReturnType<typeof setTimeout> | null = null;
	/** Clips whose new media player has not scheduled a buffer since the last schedule epoch. */
	private readonly awaiting = new Set<string>();

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
		// The anchor guard (sound-design Phase 6). Remotion re-anchors every player (stops their queued buffers and
		// schedules again from the new anchor) whenever, at a frame's commit, `currentTime − frame / fps` is off by more
		// than 0.1 s + the output latency. A frame committed late — a long main-thread task: a big document change such
		// as Hear proposal or an added track — reads as a picture behind the audio and the audio jumped ≈ 185 ms. While
		// playing, a later anchor is refused unless Remotion keeps asking for it (`ANCHOR_CONFIRM`: a real drift); an
		// earlier one (the picture ahead of the audio clock) is taken at once. Seeks while playing do not come here: the
		// Program monitor restarts playback for them (pause, seek, play: `whenPaused`, `afterSeek`).
		const anchor = sync.anchor;
		const own = Object.getOwnPropertyDescriptor(anchor, 'value');
		let restoreAnchor = () => {};
		if (own && 'value' in own && own.configurable !== false) {
			let raw = Number(own.value);
			Object.defineProperty(anchor, 'value', {
				configurable: true,
				enumerable: true,
				get: () => raw,
				set: (v: number) => {
					if (this.guardAnchor(raw, v)) raw = v;
				},
			});
			this.writeAnchor = (v) => {
				raw = v;
			};
			restoreAnchor = () => {
				Object.defineProperty(anchor, 'value', {
					configurable: true,
					enumerable: true,
					writable: true,
					value: raw,
				});
			};
		}
		const emitter = sync.emitter;
		let restoreDispatch = () => {};
		if (emitter && typeof emitter.dispatch === 'function') {
			const dispatch = emitter.dispatch;
			emitter.dispatch = (event: string) => {
				if (event === 'changed' && this.swallowChanged) {
					this.swallowChanged = false;
					return;
				}
				dispatch.call(emitter, event);
			};
			restoreDispatch = () => {
				emitter.dispatch = dispatch;
			};
		}
		const off = sync.subscribe((e) => {
			if (e === 'changed') this.discontinuity();
		});
		const onState = () => this.onContextState();
		this.ctx.addEventListener?.('statechange', onState);
		// Remotion starts the picture once the context's output timestamp passes the resume time
		// (`waitUntilActuallyResumed`). The program reaches the output the primed wait later than the context's own
		// output: report that, so a primed start shows its first frame with its first sample.
		const native = (this.ctx as { getOutputTimestamp?: () => AudioTimestamp }).getOutputTimestamp;
		const shimmed = typeof native === 'function';
		if (shimmed)
			Object.defineProperty(this.ctx, 'getOutputTimestamp', {
				configurable: true,
				writable: true,
				// Remotion's start reading fixes the offset; its polls then pass the start once the program is at the
				// output (`PrimedStartClock`).
				value: () => {
					const waiting = this.startClock.active;
					const r = this.startClock.report(native.call(this.ctx), this.ctx.currentTime) as AudioTimestamp;
					if (waiting && !this.startClock.active) this.notifyStartWait(null);
					return r;
				},
			});
		this.unsubscribeSync = () => {
			off();
			this.ctx.removeEventListener?.('statechange', onState);
			if (shimmed) delete (this.ctx as { getOutputTimestamp?: unknown }).getOutputTimestamp;
			restoreAnchor();
			restoreDispatch();
			this.writeAnchor = (v) => {
				if (this.sync) this.sync.anchor.value = v;
			};
		};
		this.prime(false);
	}

	/**
	 * Remotion writes a new anchor: whether to take it (`MixGraph.attachSync`). Refusing it also holds back the
	 * `changed` event Remotion dispatches right after.
	 */
	private guardAnchor(old: number, v: number): boolean {
		const t = this.ctx.currentTime;
		const take = (kind: TransportLogEntry['kind']) => {
			this.refused = null;
			transportLog({ t, kind, anchor: v });
			return true;
		};
		// paused or suspending (a seek while paused, the forced write at a suspend): Remotion's anchor stands
		if (!this.playing || this.ctx.state !== 'running' || this.disposed) return take('anchor');
		// the picture ahead of the audio clock (a seek forward without a restart, an audio clock that fell behind)
		if (!(v > old)) return take('anchor');
		const r = this.refused && t - this.refused.last < 0.15 ? this.refused : { since: t, last: t };
		r.last = t;
		this.refused = r;
		// Only a picture that is behind while the main thread keeps up is behind for real (a freeze that did not suspend
		// the audio); behind while frames come late is commits lagging (measured after an agent added tracks: Remotion
		// asked for anchors 0.19–0.31 s later for 0.6 s and more, then the picture caught up).
		if (t - Math.max(r.since, this.lastIrregular) >= ANCHOR_CONFIRM) {
			// The picture is behind the audio for real: Remotion restarts its frame clock from the current frame when its
			// video config changes (a new duration), dropping the time since the last frame. The audio is right; the
			// picture catches up (drops the frames it is behind), as a player falling behind does — no audio jump.
			const ahead = this.advancePicture;
			const frames = Math.round((v - old) * this.pictureRate * this.pictureFps);
			if (ahead && frames > 0 && ahead(frames)) {
				this.refused = null;
				this.swallowChanged = true;
				transportLog({ t, kind: 'caught-up', anchor: old, value: frames });
				return false;
			}
			return take('confirmed');
		}
		this.swallowChanged = true;
		transportLog({ t, kind: 'refused', anchor: old, value: v });
		return false;
	}

	/**
	 * Moves the picture `frames` ahead while playing (Remotion's frame state; MixGraphDriver): the anchor guard's answer
	 * to a picture that fell behind the audio. Returns false when it could not.
	 */
	setPictureAdvance(advance: ((frames: number) => boolean) | null, fps: number): void {
		this.advancePicture = advance;
		if (Number.isFinite(fps) && fps > 0) this.pictureFps = fps;
	}

	/**
	 * Called when playback should restart (pause, then play at the same frame) so the audio is primed again: a latency
	 * added while playing (an insert, normalisation) would otherwise leave the Mix late by it until the stop. The Program
	 * monitor's playback driver does it (sound-design Phase 6); without a listener the Mix stays late as before.
	 */
	onRestartRequest(cb: () => void): () => void {
		this.restartListeners.add(cb);
		return () => this.restartListeners.delete(cb);
	}

	/**
	 * The picture's wait at a primed start, in seconds, while it lasts (null when it is over): the Program monitor shows
	 * it as buffering when it is at least `VISIBLE_START_WAIT`.
	 */
	onStartWait(cb: (wait: number | null) => void): () => void {
		this.startWaitListeners.add(cb);
		return () => this.startWaitListeners.delete(cb);
	}

	private notifyStartWait(wait: number | null): void {
		for (const cb of [...this.startWaitListeners]) cb(wait);
	}

	/**
	 * Resolves once playback has stopped and the next start is prepared (the context suspended, a primed start set up):
	 * a restart can then play again (`onRestartRequest`, seeks while playing). Resolves within `timeoutMs` in any case.
	 */
	whenPaused(timeoutMs = 1000): Promise<void> {
		return new Promise((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				resolve();
			};
			setTimeout(finish, timeoutMs);
			// the next start is prepared once Chrome has really stopped (`settle`, the `suspended` handler)
			if (!this.playing && this.ctx.state === 'suspended' && this.frozenAt !== null) setTimeout(finish, 0);
			else this.idleWaiters.push(finish);
		});
	}

	private releaseIdle(): void {
		const w = this.idleWaiters;
		this.idleWaiters = [];
		for (const f of w) f();
	}

	private detachSync(): void {
		this.unsubscribeSync?.();
		this.unsubscribeSync = null;
		this.sync = null;
	}

	/** Remotion's playing state: the read-ahead is held while playing and follows the plan while paused. */
	setPlaying(playing: boolean): void {
		if (this.playing === playing) return;
		// Play within the quiet moment after a short paused seek: the check runs now (late: the context is already
		// running, but the program at least follows the picture)
		if (playing && this.staleTimer) {
			clearTimeout(this.staleTimer);
			this.staleTimer = null;
			this.checkPausedSeek();
		}
		transportLog({
			t: this.ctx.currentTime,
			kind: playing ? 'play' : 'pause',
			anchor: this.sync?.anchor.value ?? 0,
		});
		this.playing = playing;
		if (playing) {
			// a run starts: whatever was primed is in use now (also when the context's own events come late)
			this.fresh = false;
			this.flushed = false;
			this.restartAsked = false;
		} else {
			this.refused = null;
			this.swallowChanged = false;
			this.followPlan();
			if (this.ctx.state === 'suspended' && this.frozenAt !== null) setTimeout(() => this.releaseIdle(), 0);
		}
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
		const changed = p !== this.readAhead;
		if (changed) {
			this.readAhead = p;
			this.fresh = true;
		}
		this.pad?.set(Math.max(0, this.readAhead - p), false);
		// every source reschedules with the new read-ahead (once: a prime that moves the anchor does it)
		if (!this.prime(false) && changed) this.bumpEpoch();
	}

	private onContextState(): void {
		const s = this.ctx.state;
		if (s === 'running' || s === 'suspended')
			transportLog({ t: this.ctx.currentTime, kind: s, anchor: this.sync?.anchor.value ?? 0 });
		if (s === 'running') {
			// a run starts: whatever was primed is in use now
			this.fresh = false;
			this.flushed = false;
			this.frozenAt = null;
			if (this.startClock.active) this.notifyStartWait(this.startClock.endTime - this.ctx.currentTime);
		} else if (s === 'suspended') {
			const shift = this.shift;
			if (this.playing && this.startClock.active && shift && this.sync) {
				// Buffering stalled a primed start before its program reached the output: Remotion re-anchors to the
				// picture, which has not moved yet. Keep the primed anchor (the queued sources follow it) and the wait;
				// the resume after the stall waits for what is left of it.
				this.startClock.rearm();
				setTimeout(() => {
					this.writeAnchor(shift.base + shift.shift);
				}, 0);
				return;
			}
			if (this.startClock.active) this.notifyStartWait(null);
			this.startClock.clear();
			this.frozenAt = null;
			// After Remotion's own handler (it re-anchors to the picture on suspend) and once Chrome has really stopped:
			// the next start is prepared now, while paused — at Play the context is already running (the Player's
			// play() resumes it in the user's gesture, before any effect), too late to schedule anything.
			this.settle(() => {
				this.frozenAt = this.ctx.currentTime;
				if (this.ctx.state !== 'suspended') return;
				if (!this.fresh) this.prepareStart();
				else {
					this.checkPausedSeek();
					this.prime(false);
				}
				if (!this.playing) this.releaseIdle();
			});
		}
	}

	/**
	 * Runs `then` once Chrome's `currentTime` stands still (two reads 10 ms apart; at most 300 ms): it renders on for a
	 * few quanta after `suspended` (measured: 29–35 ms after the event in a pause followed by a quick Play).
	 */
	private settle(then: () => void): void {
		const token = ++this.settleToken;
		let last = Number.NaN;
		let still = 0;
		let left = 30;
		const check = () => {
			if (token !== this.settleToken || this.disposed) return;
			const t = this.ctx.currentTime;
			still = t === last ? still + 1 : 0;
			last = t;
			if (still >= 2 || left-- <= 0) then();
			else setTimeout(check, 10);
		};
		setTimeout(check, 0);
	}

	/**
	 * Prepares a primed start at the picture's position while suspended (a plain pause, a buffering stall): the graph is
	 * flushed, Remotion's anchor put on the picture at the final frozen time, and every source scheduled again for it
	 * (`bumpEpoch`). Remotion moves its anchor to the picture at every suspend without having its players schedule
	 * again: the buffers queued before kept the old timeline and those scheduled after Play the new one, and the audio
	 * jumped by the picture's lag (measured 109–188 ms) when the queued ones ran out, ≈ 2 s after Play
	 * (sound-design Phase 6). Every Play now starts primed, as after a seek.
	 */
	private prepareStart(): void {
		const sync = this.sync;
		if (!sync || this.disposed || this.ctx.state !== 'suspended' || this.pictureTime === null) return;
		const expected = (this.frozenAt ?? this.ctx.currentTime) - this.pictureTime / this.pictureRate;
		if (!Number.isFinite(expected)) return;
		const was = sync.anchor.value;
		this.writeAnchor(expected);
		transportLog({ t: this.ctx.currentTime, kind: 'stale', anchor: expected, value: was });
		this.shift = null;
		this.fresh = true;
		this.flushed = false;
		this.prime(false, true);
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
	private prime(fromSeek: boolean, stalled = false): boolean {
		const sync = this.sync;
		if (!sync || !this.fresh || (this.playing && !stalled) || this.disposed || this.ctx.state !== 'suspended')
			return false;
		if (!this.flushed) {
			this.flush();
			this.flushed = true;
		}
		// a fade-out of a seek during playback still pending: priming owns the output gain now
		this.flushToken++;
		const lead = (this.readAhead + this.maxClipFx()) / this.ctx.sampleRate;
		// + START_MARGIN: Chrome's `currentTime` can stay behind where the audio thread stopped (measured: a play's first
		// buffer, scheduled at the frozen time, started one or two quanta late — the first click 128 / 256 samples late
		// and the next buffer overlapping it); the program then starts after wherever the context really resumes.
		const wait = lead >= 0 && lead <= MAX_PRIMED_WAIT ? lead + START_MARGIN / this.ctx.sampleRate : 0;
		const a = primedAnchor(sync.anchor.value, this.shift, wait);
		const changed = !this.shift || a.base !== this.shift.base || wait !== this.shift.shift;
		this.writeAnchor(a.value);
		transportLog({ t: this.ctx.currentTime, kind: 'primed', anchor: a.value, value: wait });
		this.shift = { base: a.base, shift: wait };
		// The context's time is frozen while suspended. The sources start at the play position at `startAt` — the anchor's
		// base plus the picture's position: Remotion's anchor relation, which holds even when the time it read was not the
		// final frozen time (Chrome renders on for a few quanta after `suspended`) — and the program `wait` later.
		const g = this.outGain.gain;
		const t0 = this.ctx.currentTime;
		const pos = this.pictureTime !== null ? this.pictureTime / this.pictureRate : null;
		const startAt = pos !== null && Number.isFinite(a.base + pos) ? a.base + pos : t0;
		this.startClock.arm(startAt, wait);
		g.cancelScheduledValues(0);
		g.setValueAtTime(wait > 0 ? 0 : 1, t0);
		if (wait > 0) {
			g.setValueAtTime(0, Math.max(t0, startAt + wait));
			g.linearRampToValueAtTime(1, Math.max(t0, startAt + wait) + START_FADE);
		}
		if (changed && !fromSeek) {
			this.bumpEpoch();
			return true;
		}
		return false;
	}

	/**
	 * Every source must reschedule (AudioLayer re-creates its media players): while their new players start, playback
	 * is held (Remotion's buffering, `setBufferGate`) until each clip under the picture has scheduled its first buffer,
	 * so a Play right after (a restart, a quick Play after an edit) does not start before them and lose their first
	 * samples (sound-design Phase 6).
	 */
	private bumpEpoch(): void {
		this.scheduleEpoch++;
		this.awaiting.clear();
		if (this.bufferGate) {
			const F = flicksPerFrame(this.fps);
			const t = this.time;
			for (const [id, c] of this.clips) {
				const a = (c.clip.start - (c.clip.headHandle ?? 0)) * F;
				const b = (c.clip.start + c.clip.duration + (c.clip.tailHandle ?? 0)) * F;
				if (a <= t + FLICKS_PER_SECOND && b > t) this.awaiting.add(id);
			}
			if (this.awaiting.size > 0) {
				transportLog({
					t: this.ctx.currentTime,
					kind: 'gate',
					anchor: this.sync?.anchor.value ?? 0,
					value: this.awaiting.size,
				});
				this.gateHandle ??= this.bufferGate();
				// Remotion raises its flag a render after the block; a Play in this very commit (a Play right after a
				// short paused seek, `setPlaying`) must already see it, or the context resumes before the new players
				// have scheduled anything and their first samples are lost.
				if (this.bufferFlag) this.bufferFlag.current = true;
				if (this.gateTimer) clearTimeout(this.gateTimer);
				this.gateTimer = setTimeout(() => this.releaseGate(true), GATE_TIMEOUT_MS);
			} else this.releaseGate();
		}
		this.notify();
	}

	private releaseGate(timedOut = false): void {
		if (this.gateTimer) clearTimeout(this.gateTimer);
		this.gateTimer = null;
		const left = this.awaiting.size;
		this.awaiting.clear();
		const h = this.gateHandle;
		this.gateHandle = null;
		if (h)
			transportLog({
				t: this.ctx.currentTime,
				kind: 'gate-open',
				anchor: this.sync?.anchor.value ?? 0,
				value: timedOut ? -left : 0,
			});
		h?.unblock();
	}

	/**
	 * Remotion's buffering (`useBufferState().delayPlayback`), for holding playback while the sources start again after
	 * a schedule epoch (`bumpEpoch`). Null: no hold.
	 */
	setBufferGate(delay: (() => { unblock(): void }) | null, flag?: { current: boolean | null }): void {
		if (!delay) this.releaseGate();
		this.bufferGate = delay;
		this.bufferFlag = delay ? (flag ?? null) : null;
	}

	/** AudioLayer: the media player of `clipId` made for schedule epoch `epoch` scheduled a buffer. */
	noteScheduled(clipId: string, epoch: number): void {
		if (epoch !== this.scheduleEpoch || !this.awaiting.delete(clipId)) return;
		if (this.awaiting.size === 0) this.releaseGate();
	}

	/**
	 * Resolves once the graph has seen the picture at the position of a seek made while paused (its next update) and,
	 * when Remotion kept its anchor (a seek shorter than its 0.1 s + output-latency tolerance: the sources would go on
	 * from where they were), re-anchored to the picture and had every source start again. The Program monitor's
	 * restart (a seek while playing) plays after it (sound-design Phase 6).
	 */
	afterSeek(timeoutMs = 300): Promise<void> {
		return new Promise((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				resolve();
			};
			setTimeout(finish, timeoutMs);
			this.seekWaiters.push(finish);
		});
	}

	/**
	 * After a seek while paused: re-anchors to the picture when Remotion's anchor is stale (it ignores seeks shorter
	 * than its tolerance, and the sources would go on from where they were), and has every source start again. Run by
	 * `afterSeek` (a restart) and at Play — not while paused, where a scrub or frame steps would restart every source
	 * on every frame.
	 */
	private checkPausedSeek(): void {
		if (this.staleTimer) clearTimeout(this.staleTimer);
		this.staleTimer = null;
		const sync = this.sync;
		if (!sync || this.playing || this.pictureTime === null) return;
		if (this.ctx.state !== 'suspended' && this.frozenAt === null) return;
		const expected = (this.frozenAt ?? this.ctx.currentTime) - this.pictureTime / this.pictureRate;
		const cur = sync.anchor.value;
		const base =
			this.shift && Math.abs(cur - (this.shift.base + this.shift.shift)) < 1e-9 ? this.shift.base : cur;
		if (!Number.isFinite(expected) || Math.abs(base - expected) <= ANCHOR_STALE) return;
		this.writeAnchor(expected);
		transportLog({ t: this.ctx.currentTime, kind: 'stale', anchor: expected, value: base });
		this.shift = null;
		this.fresh = true;
		this.flushed = false;
		this.prime(false);
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
		if (this.startClock.active) this.notifyStartWait(null);
		this.startClock.clear();
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

	/** Most a clock reading may differ from the picture time before it is distrusted (a stale anchor). */
	private static readonly CLOCK_TRUST = 0.25 * FLICKS_PER_SECOND;

	private clockFrom(
		timeFlicks: number,
		clock: { compositionFlicks: number; rate: number } | undefined,
	): { time: number; rate: number } | null {
		const sync = this.sync;
		if (!clock || !sync || !this.playing) return null;
		const rate = clock.rate;
		if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(clock.compositionFlicks)) return null;
		const anchor = sync.anchor.value;
		if (!Number.isFinite(anchor)) return null;
		const time =
			(this.ctx.currentTime - anchor) * rate * FLICKS_PER_SECOND + (timeFlicks - clock.compositionFlicks);
		if (!Number.isFinite(time) || Math.abs(time - timeFlicks) > MixGraph.CLOCK_TRUST) return null;
		return { time, rate };
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
		// While playing, keep the audio in flight (a changed route delay inserts silence or skips, never restarts; a new
		// route is empty either way).
		const live = this.playing;
		for (const s of mix.strips) {
			const st = this.strips.get(s.id);
			const r = plan.strips[s.id];
			if (!st || !r) continue;
			st.out?.set(r.outDelay, live);
			for (const x of st.sends) x.route.set(r.sendDelays[x.id] ?? 0, live);
		}
		this.plan = plan;
		if (this.playing) {
			this.pad?.set(Math.max(0, this.readAhead - plan.total), live);
			// More latency than the read-ahead held: the Mix plays late by the difference until the sources start again.
			// Ask for a restart (primed with the new read-ahead); the held read-ahead keeps the audio going meanwhile.
			if (plan.total > this.readAhead && !this.restartAsked && this.restartListeners.size > 0) {
				this.restartAsked = true;
				transportLog({ t: this.ctx.currentTime, kind: 'restart', anchor: this.sync?.anchor.value ?? 0 });
				const listeners = [...this.restartListeners];
				setTimeout(() => {
					for (const cb of listeners) cb();
				}, 0);
			}
		} else this.followPlan();
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

	/**
	 * `clock` (the player, while playing): the composition time of the frame (`timeFlicks` minus the sequence offset)
	 * and the playback rate, so the graph can tell, from Remotion's audio sync anchor, the sequence time of the samples
	 * it renders now — the picture frame's time trails them by the output latency and the frame callback's delay.
	 */
	update(
		mix: RenderAudioMix,
		clips: readonly RenderAudioClip[],
		timeFlicks: number,
		fps: Rational,
		clock?: { compositionFlicks: number; rate: number },
	): void {
		this.mix = mix;
		this.clipList = clips as RenderAudioClip[];
		this.fps = fps;
		this.time = timeFlicks;
		this.audioClock = this.clockFrom(timeFlicks, clock);
		if (this.playing && this.ctx.state === 'running') {
			const now = this.ctx.currentTime;
			if (this.lastUpdateAt !== null && now - this.lastUpdateAt > LATE_UPDATE) this.lastIrregular = now;
			this.lastUpdateAt = now;
		} else this.lastUpdateAt = null;
		if (clock && Number.isFinite(clock.compositionFlicks) && clock.rate > 0) {
			const moved = this.pictureTime !== clock.compositionFlicks / FLICKS_PER_SECOND;
			this.pictureTime = clock.compositionFlicks / FLICKS_PER_SECOND;
			this.pictureRate = clock.rate;
			// A paused seek Remotion may not count (shorter than its tolerance): checked once the playhead rests (not on
			// every frame of a scrub or of frame steps).
			if (moved && !this.playing && this.sync) {
				if (this.staleTimer) clearTimeout(this.staleTimer);
				this.staleTimer = setTimeout(() => {
					this.staleTimer = null;
					this.checkPausedSeek();
				}, STALE_SETTLE_MS);
			}
		}
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
		if (this.seekWaiters.length > 0) {
			this.checkPausedSeek();
			const w = this.seekWaiters;
			this.seekWaiters = [];
			for (const f of w) f();
		}
	}

	/**
	 * Builds the strips for a new topology. Strips whose own shape is unchanged (kind, width, bus width) keep their
	 * nodes — inserts with their state, the audio in flight — and so do routes between kept strips and the Mix chain:
	 * adding or removing a track, submix or send while playing (an agent's edit, Hear proposal) no longer resets every
	 * strip (the audio in their inserts and delay lines was lost: up to the read-ahead, sound-design Phase 6).
	 */
	private rebuild(mix: RenderAudioMix): void {
		this.order = mix.strips;
		const mw = widthOf(mix.masterFormat);
		const shapeOf = (s: RenderStrip) =>
			`${s.kind}|${widthOf(s.format)}|${s.kind === 'master' ? mw : s.outputFormat ? widthOf(s.outputFormat) : mw}|${this.workletReady}`;
		const prevMaster = this.strips.get('master');
		const old = new Map(this.strips);
		const next = new Map<string, StripNodes>();
		for (const s of mix.strips) {
			const shape = shapeOf(s);
			const prev = old.get(s.id);
			if (prev && prev.shape === shape) {
				next.set(s.id, prev);
				old.delete(s.id);
				continue;
			}
			const ow = s.outputFormat ? widthOf(s.outputFormat) : mw;
			// The Mix is metered after the limiter (with loudness) under the same id: no second meter here, or
			// its silent readings would race the real ones.
			const meter = s.kind === 'master' ? null : this.makeMeter(s.id, widthOf(s.format), false);
			const st = new StripNodes(this.ctx, s, ow, meter);
			st.shape = shape;
			next.set(s.id, st);
		}
		// strips gone or reshaped (their routes go with them)
		const masterKept = !!prevMaster && next.get('master') === prevMaster;
		for (const st of old.values()) st.dispose();
		this.strips = next;
		// routing (outputs and sends): routes between kept strips stay (their delay lines keep what is in flight)
		for (const s of mix.strips) {
			const st = next.get(s.id)!;
			const target = s.output ? next.get(s.output) : undefined;
			if (st.out && st.outTo !== (target?.input ?? null)) {
				st.out.dispose();
				st.out = null;
				st.outTo = null;
			}
			if (!st.out && target) {
				st.out = new DelayRoute(this.ctx, st.gate, target.input, target.width);
				st.outTo = target.input;
			}
			const kept = new Map(st.sends.map((x) => [x.id, x]));
			st.sends = s.sends.flatMap((x) => {
				const t = next.get(x.target);
				if (!t) return [];
				const k = kept.get(x.id);
				if (k && k.target === x.target && k.preFader === x.preFader && k.to === t.input) {
					kept.delete(x.id);
					return [k];
				}
				const level = discreteGain(this.ctx, st.width);
				const matrix = new MatrixNode(this.ctx, st.width, t.width);
				const gate = discreteGain(this.ctx, t.width);
				(x.preFader ? st.pre.output : st.post.output).connect(level);
				level.connect(matrix.input);
				matrix.output.connect(gate);
				const route = new DelayRoute(this.ctx, gate, t.input, t.width);
				return [
					{ id: x.id, target: x.target, preFader: x.preFader, level, matrix, gate, route, to: t.input },
				];
			});
			for (const x of kept.values()) disposeSend(x);
		}
		// the Mix → loudness gain → limiter → meter (levels + loudness) → device fold → Remotion's output gain: kept
		// with the Mix strip
		const master = next.get('master')!;
		if (masterKept && this.pad && this.device) {
			this.reconnectClips();
			return;
		}
		this.masterMeter?.disconnect();
		this.limiter?.disconnect();
		this.limiter?.port.close();
		this.device?.dispose();
		this.pad?.dispose();
		this.loudGain.disconnect();
		this.loudGain = discreteGain(this.ctx, mw);
		// a fresh Mix chain: nothing in flight, the padding starts empty
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
		this.reconnectClips();
	}

	/** Existing clips → their track inputs (new strips get them; kept ones keep them). */
	private reconnectClips(): void {
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
		// Playing: automated lanes follow their curves sample by sample until the next update (`followCurve`), from the
		// audio clock's time when the anchor tells it (else the picture's).
		const follow = this.playing && !instant;
		const clock = follow ? this.audioClock : null;
		const base = clock?.time ?? this.time;
		const rate = clock?.rate ?? 1;
		const at = (t: number) => (dt: number) => t + dt * rate * FLICKS_PER_SECOND;
		const insertClock = (t: number): SlotClock | undefined =>
			follow ? { at: this.ctx.currentTime, rate, grid: (t * sr) / FLICKS_PER_SECOND } : undefined;
		for (const s of this.order) {
			const st = this.strips.get(s.id);
			if (!st) continue;
			const times = stripStageTimes(this.plan, s.id, follow ? base : this.time, sr, this.readAhead);
			const t = times.fader;
			const volOv = this.ov(s.id, 'volume');
			if (follow && volOv === undefined && isAnimated(s.volumeDb)) {
				const ft = at(t);
				followCurve(
					st.fader.gain,
					this.ctx,
					(dt) => dbToGain(laneAt(s.volumeDb, ft(dt))),
					undefined,
					undefined,
					laneBreaks(s.volumeDb, t).map((b) => b / rate),
				);
			} else setParam(st.fader.gain, dbToGain(volOv ?? laneAt(s.volumeDb, t)), this.ctx, instant);
			const muteOv = s.kind === 'master' ? 0 : this.ov(s.id, 'mute');
			if (follow && muteOv === undefined && isAnimated(s.mute)) {
				const ft = at(t);
				followCurve(
					st.mute.gain,
					this.ctx,
					(dt) => (laneAt(s.mute, ft(dt), true) >= 0.5 ? 0 : 1),
					undefined,
					undefined,
					laneBreaks(s.mute, t).map((b) => b / rate),
				);
			} else {
				const mute = muteOv ?? laneAt(s.mute, t, true);
				setParam(st.mute.gain, mute >= 0.5 ? 0 : 1, this.ctx, instant);
			}
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
				const tp = times.pan;
				const lanes = this.panLanes(s, st.outWidth);
				if (follow && lanes.some((a) => isAnimated(a))) {
					// Playing: the pan law follows the lanes between picture frames, sample by sample like the export's
					// pan stage (sound-design Phase 6), not one step per frame with the 8 ms glide.
					const ft = at(tp);
					st.pan.follow(
						(dt) =>
							panStageMatrix(
								st.width,
								st.outWidth,
								this.ov(s.id, 'pan') ?? laneAt(s.pan, ft(dt)),
								this.puck(s, ft(dt)),
								this.mixdown,
							),
						lanes.flatMap((a) => laneBreaks(a, tp)).map((b) => b / rate),
					);
				} else {
					const pan = this.ov(s.id, 'pan') ?? laneAt(s.pan, tp);
					st.pan.set(panStageMatrix(st.width, st.outWidth, pan, this.puck(s, tp), this.mixdown), instant);
				}
			}
			for (const x of st.sends) {
				const send = s.sends.find((y) => y.id === x.id);
				if (!send) continue;
				const ts = send.preFader ? times.fader : times.pan;
				const lvOv = this.ov(s.id, `send.${x.id}.level`);
				if (follow && lvOv === undefined && isAnimated(send.levelDb)) {
					const ft = at(ts);
					followCurve(
						x.level.gain,
						this.ctx,
						(dt) => dbToGain(laneAt(send.levelDb, ft(dt))),
						undefined,
						undefined,
						laneBreaks(send.levelDb, ts).map((b) => b / rate),
					);
				} else setParam(x.level.gain, dbToGain(lvOv ?? laneAt(send.levelDb, ts)), this.ctx, instant);
				const target = this.strips.get(x.target);
				const tw = target?.width ?? 2;
				// a send into a 5.1 bus pans with the strip's puck, at the send's tap time
				const puckLanes = tw === 6 ? this.panLanes(s, 6) : [];
				if (follow && puckLanes.some((a) => isAnimated(a))) {
					const ft = at(ts);
					x.matrix.follow(
						(dt) => panStageMatrix(st.width, tw, send.pan, this.puck(s, ft(dt)), this.mixdown),
						puckLanes.flatMap((a) => laneBreaks(a, ts)).map((b) => b / rate),
					);
				} else x.matrix.set(panStageMatrix(st.width, tw, send.pan, this.puck(s, ts), this.mixdown), instant);
				setParam(x.gate.gain, s.silent ? 0 : 1, this.ctx, true);
			}
			st.pre.sync(
				s.inserts.filter((e) => !e.postFader),
				times.preInserts,
				insertClock(times.preInserts),
			);
			st.post.sync(
				s.inserts.filter((e) => !!e.postFader),
				times.postInserts,
				insertClock(times.postInserts),
			);
		}
		// loudness normalisation
		setParam(this.loudGain.gain, mix.loudness ? dbToGain(mix.loudness.gainDb) : 1, this.ctx, instant);
		this.limiter?.port.postMessage({ enabled: !!mix.loudness, ceilingDb: mix.loudness?.truePeakDb ?? -1 });
		// clips: their nodes process the samples `total` ahead of the picture (the read-ahead)
		const t = this.time;
		const ahead = follow ? base + (this.readAhead * FLICKS_PER_SECOND) / sr : this.aheadTime();
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
			c.update(clip, ahead, override, instant, this.fps, follow, rate);
		}
	}

	/**
	 * The lanes the pan stage of a strip into a bus of width `ow` reads, without those a live control holds (the pan
	 * into a stereo bus; the 5.1 puck into a 5.1 bus; nothing into a mono bus).
	 */
	private panLanes(s: RenderStrip, ow: number): Animatable<number>[] {
		const held = (lane: string) => this.ov(s.id, lane) !== undefined;
		if (ow === 6)
			return (
				[
					['pan51.x', s.pan51.x],
					['pan51.y', s.pan51.y],
					['pan51.center', s.pan51.center],
					['pan51.lfe', s.pan51.lfe],
				] as const
			)
				.filter(([lane]) => !held(lane))
				.map(([, a]) => a);
		if (ow === 2 && !held('pan')) return [s.pan];
		return [];
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
		if (this.staleTimer) clearTimeout(this.staleTimer);
		this.releaseGate();
		this.releaseIdle();
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
