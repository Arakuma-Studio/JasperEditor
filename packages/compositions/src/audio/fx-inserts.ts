// audio-fx preview: every audio effect of the catalogue is a preview slot of the audio-mix graph (clip effect slots
// and track / submix / Mix inserts, `registerPreviewInsert`). A slot is one AudioWorkletNode running `FxSlotCore`
// (fx-processor.ts) — the same EffectChain code the export's offline mixer runs. Live meters (gain reduction,
// loudness) of a slot are posted while someone listens (`audioFxMeters`, Effect Controls).
import { effectLatency } from '@jasper/audio-fx';
import { AUDIO_EFFECTS, type EffectInstance } from '@jasper/project/audio';
import { FX_PROCESSOR_NAME, type FxSlotMessage, type FxSlotReading } from './fx-processor.ts';
import { mixWorkletReady, type PreviewInsert, registerPreviewInsert } from './graph.ts';
import { discreteGain } from './matrix-node.ts';

type MeterListener = (values: readonly number[]) => void;
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
		// Silent until the processor exists: never play the slot's input unprocessed.
		void mixWorkletReady(ctx).then((ok) => {
			if (!ok || this.disposed) return;
			const node = new AudioWorkletNode(ctx, FX_PROCESSOR_NAME, {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [channels],
				channelCount: channels,
				channelCountMode: 'explicit',
				channelInterpretation: 'discrete',
				processorOptions: { channels },
			});
			node.port.onmessage = (e: MessageEvent<FxSlotReading>) => {
				for (const fn of meterListeners.get(this.effect.id) ?? []) fn(e.data.values);
			};
			this.node = node;
			this.input.connect(node);
			node.connect(this.output);
			this.post({ type: 'effect', effect: this.effect, time: this.time });
			if (meterListeners.has(this.effect.id)) this.meters(true);
		});
	}

	private post(m: FxSlotMessage): void {
		this.node?.port.postMessage(m);
	}

	meters(on: boolean): void {
		this.post({ type: 'meters', on });
	}

	update(effect: EffectInstance, timeFlicks: number): void {
		this.time = timeFlicks;
		if (effect !== this.effect) {
			this.effect = effect;
			const key = JSON.stringify(effect.params);
			if (key !== this.sentKey) {
				this.sentKey = key;
				this.post({ type: 'effect', effect, time: timeFlicks });
				return;
			}
		}
		this.post({ type: 'time', time: timeFlicks });
	}

	dispose(): void {
		this.disposed = true;
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
