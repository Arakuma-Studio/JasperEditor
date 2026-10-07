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
	type Layout,
	layoutFromChannels,
	type Mixdown,
	pan51Matrix,
	panMonoGains,
} from '@jasper/audio-dsp';
import {
	contentTimeAt,
	type EffectInstance,
	evaluate,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	holdValueAt,
	type Rational,
	type RenderAudioClip,
	type RenderAudioMix,
	type RenderStrip,
} from '@jasper/project';
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

const insertFactories = new Map<string, PreviewInsertFactory>();
/** Registers the Web Audio implementation of an audio effect for preview slots (returns an unregister function). */
export function registerPreviewInsert(effectId: string, factory: PreviewInsertFactory): () => void {
	insertFactories.set(effectId, factory);
	return () => {
		if (insertFactories.get(effectId) === factory) insertFactories.delete(effectId);
	};
}
export function hasPreviewInsert(effectId: string): boolean {
	return insertFactories.has(effectId);
}

// ------------------------------------------------------------------ worklet module

let workletUrl: string | null = null;
const workletLoads = new WeakMap<BaseAudioContext, Promise<boolean>>();
/** The URL of the bundled `worklet.ts` (the web app sets it; without it meters and the preview limiter are off). */
export function setMixWorkletUrl(url: string | null): void {
	workletUrl = url;
}
function loadWorklet(ctx: BaseAudioContext): Promise<boolean> {
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

// ------------------------------------------------------------------ helpers

const dbToGain = (db: number) => (db <= -96 || !Number.isFinite(db) ? 0 : 10 ** (db / 20));
const widthOf = (f: string) => (f === 'mono' ? 1 : f === '5.1' ? 6 : 2);
const layoutOf = (w: number): Layout => layoutFromChannels(w);

function laneAt(
	a: { value: number; keyframes: { time: number; value: number }[] },
	t: number,
	hold = false,
): number {
	if (a.keyframes.length === 0) return a.value;
	return hold ? holdValueAt(a as never, t) : evaluate(a as never, t);
}

function scaleRows(m: number[][], gains: number[]): number[][] {
	return m.map((row, o) => row.map((v) => v * (gains[o] ?? 1)));
}

function _mul(a: number[][], b: number[][]): number[][] {
	// (a · b)[o][i] = Σ_k a[o][k] b[k][i]
	return a.map((row) => b[0]!.map((_, i) => row.reduce((s, x, k) => s + x * (b[k]?.[i] ?? 0), 0)));
}

/** The pan stage matrix of a strip (width w → bus width ow) for a pan value (−100…100) or 5.1 puck. */
export function panStageMatrix(
	w: number,
	ow: number,
	pan: number,
	p51: { x: number; y: number; center: number; lfeDb: number },
	mixdown: Mixdown = 'frontRear',
): number[][] {
	const src = layoutOf(w);
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

// ------------------------------------------------------------------ slots

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

// ------------------------------------------------------------------ strips

type SendNodes = {
	id: string;
	target: string;
	preFader: boolean;
	level: GainNode;
	matrix: MatrixNode;
	gate: GainNode;
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
		for (const x of this.sends) {
			x.level.disconnect();
			x.matrix.dispose();
			x.gate.disconnect();
		}
	}
}

// ------------------------------------------------------------------ clips

class ClipNodes {
	/** Remotion's per-clip gain node connects here (the `gainNode` of our SharedAudioContext override). */
	readonly input: GainNode;
	private select: MatrixNode | null = null;
	readonly trim: GainNode;
	private slots: SlotChain | null = null;
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
			this.input.connect(this.select.input);
			this.select.output.connect(this.trim);
			this.trim.connect(this.slots.input);
			this.width = w;
			this.pan?.dispose();
			this.pan = null;
		}
		const map = clip.channels.map.length > 0 ? clip.channels.map : Array.from({ length: w }, (_, i) => i);
		const sel = Array.from({ length: w }, (_, o) =>
			Array.from({ length: stream }, (_, i) => (map[o] === i ? 1 : 0)),
		);
		this.select.set(sel, true);
		if (!this.pan || this.trackWidth !== trackWidth) {
			this.pan?.dispose();
			this.pan = new MatrixNode(this.ctx, w, trackWidth);
			this.slots!.output.connect(this.pan.input);
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
		let m = conversionMatrix(layoutOf(w), layoutOf(tw));
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
	}

	dispose(): void {
		this.input.disconnect();
		this.select?.dispose();
		this.trim.disconnect();
		this.slots?.dispose();
		this.pan?.dispose();
	}
}

// ------------------------------------------------------------------ the graph

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

	constructor(
		readonly ctx: AudioContext,
		readonly destination: AudioNode,
	) {
		this.loudGain = discreteGain(ctx, 2);
		void loadWorklet(ctx).then((ok) => {
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

	// -------------------------------------------------------------- clips

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

	// -------------------------------------------------------------- overrides (live controls)

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

	// -------------------------------------------------------------- meters

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

	// -------------------------------------------------------------- update (every rendered frame)

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
		if (key !== this.structure) {
			this.rebuild(mix);
			this.structure = key;
			for (const cb of this.changeListeners) cb();
		}
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
			const meter = this.makeMeter(s.id, widthOf(s.format), false);
			this.strips.set(s.id, new StripNodes(this.ctx, s, ow, s.kind === 'master' ? null : meter));
		}
		// routing (outputs and sends)
		for (const s of mix.strips) {
			const st = this.strips.get(s.id)!;
			if (s.output) {
				const target = this.strips.get(s.output);
				if (target) st.gate.connect(target.input);
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
				gate.connect(target.input);
				return [{ id: x.id, target: x.target, preFader: x.preFader, level, matrix, gate }];
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
		const m = conversionMatrix(layoutOf(mw), 'stereo', this.mixdown);
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

	/** Evaluates every lane at the current time and ramps the nodes there. */
	private applyValues(instant: boolean): void {
		const t = this.time;
		const mix = this.mix!;
		for (const s of this.order) {
			const st = this.strips.get(s.id);
			if (!st) continue;
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
				const pan = this.ov(s.id, 'pan') ?? laneAt(s.pan, t);
				const p51 = {
					x: this.ov(s.id, 'pan51.x') ?? laneAt(s.pan51.x, t),
					y: this.ov(s.id, 'pan51.y') ?? laneAt(s.pan51.y, t),
					center: this.ov(s.id, 'pan51.center') ?? laneAt(s.pan51.center, t),
					lfeDb: this.ov(s.id, 'pan51.lfe') ?? laneAt(s.pan51.lfe, t),
				};
				st.pan.set(panStageMatrix(st.width, st.outWidth, pan, p51, this.mixdown), instant);
			}
			for (const x of st.sends) {
				const send = s.sends.find((y) => y.id === x.id);
				if (!send) continue;
				const lv = this.ov(s.id, `send.${x.id}.level`) ?? laneAt(send.levelDb, t);
				setParam(x.level.gain, dbToGain(lv), this.ctx, instant);
				const target = this.strips.get(x.target);
				const p51 = { x: 0, y: 100, center: 100, lfeDb: st.width === 6 ? 0 : -96 };
				x.matrix.set(panStageMatrix(st.width, target?.width ?? 2, send.pan, p51, this.mixdown), instant);
				setParam(x.gate.gain, s.silent ? 0 : 1, this.ctx, true);
			}
			st.pre.sync(
				s.inserts.filter((e) => !e.postFader),
				t,
			);
			st.post.sync(
				s.inserts.filter((e) => !!e.postFader),
				t,
			);
		}
		// loudness normalisation
		setParam(this.loudGain.gain, mix.loudness ? dbToGain(mix.loudness.gainDb) : 1, this.ctx, instant);
		this.limiter?.port.postMessage({ enabled: !!mix.loudness, ceilingDb: mix.loudness?.truePeakDb ?? -1 });
		// clips
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
			c.update(clip, t, override, instant, this.fps);
		}
	}

	/** Sample-accurate equivalent check helper for tests: the pan matrix the strip would use at `t`. */
	stripMatrix(stripId: string): number[][] | null {
		const s = this.order.find((x) => x.id === stripId);
		const st = this.strips.get(stripId);
		if (!s || !st) return null;
		const t = this.time;
		return panStageMatrix(st.width, st.outWidth, laneAt(s.pan, t), {
			x: laneAt(s.pan51.x, t),
			y: laneAt(s.pan51.y, t),
			center: laneAt(s.pan51.center, t),
			lfeDb: laneAt(s.pan51.lfe, t),
		});
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

// ------------------------------------------------------------------ registry

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
