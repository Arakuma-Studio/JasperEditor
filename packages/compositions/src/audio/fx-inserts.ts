// audio-fx preview: every audio effect of the catalogue is a preview slot of the audio-mix graph (clip effect slots
// and track / submix / Mix inserts, `registerPreviewInsert`). A slot is one AudioWorkletNode running `FxSlotCore`
// (fx-processor.ts) — the same EffectChain code the export's offline mixer runs. Live meters (gain reduction,
// loudness) of a slot are posted while someone listens (`audioFxMeters`, Effect Controls).
import { effectLatency } from '@jasper/audio-fx';
import { AUDIO_EFFECTS, type EffectInstance } from '@jasper/project/audio';
import { FX_PROCESSOR_NAME, type FxSlotMessage, type FxSlotReading, type SlotClock } from './fx-processor.ts';
import { mixWorkletReady, type PreviewInsert, registerPreviewInsert } from './graph.ts';
import { discreteGain } from './matrix-node.ts';

type MeterListener = (values: readonly number[]) => void;

const PITCH_SHIFTER = 'jasper.audio.pitch-shifter';
const wantsRubberBand = (e: EffectInstance) => e.effectId === PITCH_SHIFTER;

type RubberBandState = { state: 'unset' | 'loading' | 'ready' | 'failed'; error: string | null };
let rbLoader: (() => Promise<WebAssembly.Module>) | null = null;
let rbLoad: Promise<WebAssembly.Module | null> | null = null;
let rbModule: WebAssembly.Module | null = null;
let rbState: RubberBandState = { state: 'unset', error: 'Rubber Band module not configured' };
/** Worklet slots currently running Signalsmith instead of Rubber Band R3, with the reason. */
const rbFallbacks = new Map<object, string>();
const rbListeners = new Set<() => void>();
const rbNotify = () => {
	for (const fn of [...rbListeners]) fn();
};

/**
 * The preview's Rubber Band module (the Pitch Shifter's `rubberband-r3` engine, a separate GPL WebAssembly file): the
 * app registers how to fetch and compile it; Pitch Shifter slots wait for it and pass it into the AudioWorklet. When
 * it cannot load (or a slot cannot start it) the slots run Signalsmith and `warning()` says so.
 */
export const previewRubberBand = {
	setLoader(load: () => Promise<WebAssembly.Module>): void {
		rbLoader = load;
		rbLoad = null;
		rbState = { state: 'unset', error: null };
	},
	/** The module, loading it on first use; null when it is not configured or failed. */
	module(): Promise<WebAssembly.Module | null> {
		if (rbLoad) return rbLoad;
		if (!rbLoader) return Promise.resolve(null);
		rbState = { state: 'loading', error: null };
		rbLoad = rbLoader().then(
			(m) => {
				rbModule = m;
				rbState = { state: 'ready', error: null };
				rbNotify();
				return m;
			},
			(e: unknown) => {
				rbState = {
					state: 'failed',
					error: `rubberband.wasm failed to load: ${e instanceof Error ? e.message : String(e)}`,
				};
				rbNotify();
				return null;
			},
		);
		return rbLoad;
	},
	/** Why Rubber Band R3 Pitch Shifters play with Signalsmith in the preview, or null when they do not. */
	warning(): string | null {
		if (rbState.state === 'failed' || (rbState.state === 'unset' && !rbLoader)) return rbState.error;
		for (const reason of rbFallbacks.values()) return reason;
		return null;
	},
	subscribe(fn: () => void): () => void {
		rbListeners.add(fn);
		return () => rbListeners.delete(fn);
	},
};
const meterListeners = new Map<string, Set<MeterListener>>();
const liveSlots = new Map<string, Set<FxInsert>>();

/** Live meter readings of effect instances in the preview (Effect Controls gain-reduction / loudness meters). */
export const audioFxMeters = {
	/** Calls `fn` with the meter values of effect instance `instanceId` (~10 Hz while playing). */
	subscribe(instanceId: string, fn: MeterListener): () => void {
		let set = meterListeners.get(instanceId);
		if (!set) meterListeners.set(instanceId, (set = new Set()));
		set.add(fn);
		for (const s of liveSlots.get(instanceId) ?? []) s.meters(true);
		return () => {
			set!.delete(fn);
			if (set!.size === 0) {
				meterListeners.delete(instanceId);
				for (const s of liveSlots.get(instanceId) ?? []) s.meters(false);
			}
		};
	},
};

class FxInsert implements PreviewInsert {
	readonly input: GainNode;
	readonly output: GainNode;
	private node: AudioWorkletNode | null = null;
	private effect: EffectInstance;
	private time = 0;
	private disposed = false;
	private sentKey = '';
	/** Whether this slot's worklet scope was given the Rubber Band module. */
	private sentModule = false;

	constructor(
		readonly ctx: BaseAudioContext,
		effect: EffectInstance,
		readonly channels: number,
	) {
		this.effect = effect;
		this.input = discreteGain(ctx, channels);
		this.output = discreteGain(ctx, channels);
		let set = liveSlots.get(effect.id);
		if (!set) liveSlots.set(effect.id, (set = new Set()));
		set.add(this);
		// Silent until the processor exists: never play the slot's input unprocessed. A Pitch Shifter also waits for the
		// Rubber Band module (loaded once), so its first quantum already runs the engine it is set to.
		const rb = wantsRubberBand(effect) ? previewRubberBand.module() : Promise.resolve(rbModule);
		void Promise.all([mixWorkletReady(ctx), rb]).then(([ok, module]) => {
			if (!ok || this.disposed) return;
			this.sentModule = !!module;
			const node = new AudioWorkletNode(ctx, FX_PROCESSOR_NAME, {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [channels],
				channelCount: channels,
				channelCountMode: 'explicit',
				channelInterpretation: 'discrete',
				processorOptions: {
					channels,
					effect: this.effect,
					time: this.time,
					...(module ? { rubberband: module } : {}),
				},
			});
			node.port.onmessage = (e: MessageEvent<FxSlotReading>) => {
				const d = e.data;
				if (d.type === 'engine') {
					if (d.fallback) rbFallbacks.set(this, d.fallback);
					else rbFallbacks.delete(this);
					rbNotify();
					return;
				}
				for (const fn of meterListeners.get(this.effect.id) ?? []) fn(d.values);
			};
			this.node = node;
			this.input.connect(node);
			node.connect(this.output);
			this.sentKey = JSON.stringify(this.effect.params);
			if (meterListeners.has(this.effect.id)) this.meters(true);
		});
	}

	private post(m: FxSlotMessage): void {
		this.node?.port.postMessage(m);
	}

	meters(on: boolean): void {
		this.post({ type: 'meters', on });
	}

	update(effect: EffectInstance, timeFlicks: number, clock?: SlotClock): void {
		this.time = timeFlicks;
		const c = clock ? { clock } : {};
		if (effect !== this.effect) {
			this.effect = effect;
			if (!this.sentModule && rbModule && this.node && wantsRubberBand(effect)) {
				this.sentModule = true;
				this.post({ type: 'rubberband', module: rbModule });
			}
			const key = JSON.stringify(effect.params);
			if (key !== this.sentKey) {
				this.sentKey = key;
				this.post({ type: 'effect', effect, time: timeFlicks, ...c });
				return;
			}
		}
		this.post({ type: 'time', time: timeFlicks, ...c });
	}

	dispose(): void {
		this.disposed = true;
		if (rbFallbacks.delete(this)) rbNotify();
		liveSlots.get(this.effect.id)?.delete(this);
		this.input.disconnect();
		if (this.node) {
			this.post({ type: 'dispose' });
			this.node.disconnect();
			this.node.port.onmessage = null;
		}
		this.output.disconnect();
	}
}

let installed = false;

/** Registers the preview slot of every audio effect (idempotent; called with the mix graph module). */
export function installAudioFxPreview(): void {
	if (installed) return;
	installed = true;
	// The slot's latency is the processor's (the same code in the worklet): the graph compensates it like the export.
	const latency = (effect: EffectInstance, sampleRate: number) => effectLatency(effect, sampleRate);
	for (const spec of AUDIO_EFFECTS)
		registerPreviewInsert(spec.id, (ctx, effect, channels) => new FxInsert(ctx, effect, channels), latency);
}
