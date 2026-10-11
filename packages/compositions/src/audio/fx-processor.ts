// audio-fx: the AudioWorklet processor of one audio effect slot (`jasper-audio-fx`), registered by `worklet.ts`. It
// hosts the same `EffectChain` code as the export (`@jasper/audio-fx` EffectSlot in the offline mixer). The main
// thread posts the effect instance whenever it changes and the slot time (content flicks for clip effects, sequence
// flicks for inserts) every rendered frame; keyframed parameters are evaluated at that time and the processors
// smooth the steps. Exported for tests (the class runs in Node with a stub `AudioWorkletProcessor`).
import { EffectChain } from '@jasper/audio-fx';
import type { EffectInstance } from '@jasper/project/audio';

/** Main → worklet messages. */
export type FxSlotMessage =
	| { type: 'effect'; effect: EffectInstance; time: number }
	| { type: 'time'; time: number }
	| { type: 'meters'; on: boolean }
	| { type: 'reset' }
	| { type: 'dispose' };

/** Worklet → main: live meters of the effect (gain reduction per band, loudness readings…). */
export type FxSlotReading = { type: 'meters'; values: number[] };

export const FX_PROCESSOR_NAME = 'jasper-audio-fx';
const METER_EVERY = 4800;

type Port = { postMessage(message: FxSlotReading): void };

/** Processor logic, independent of the worklet global scope (tests drive it directly). */
export class FxSlotCore {
	readonly chain: EffectChain;
	private readonly scratch: Float32Array[];
	private meters = false;
	private since = 0;
	alive = true;

	constructor(
		sampleRate: number,
		readonly channels: number,
		private readonly port: Port | null,
	) {
		this.chain = new EffectChain(sampleRate, channels);
		this.scratch = Array.from({ length: channels }, () => new Float32Array(128));
	}

	message(m: FxSlotMessage): void {
		switch (m.type) {
			case 'effect':
				this.chain.setEffects([{ ...m.effect, enabled: true }]);
				if (this.chain.animated()) this.chain.automate(m.time);
				break;
			case 'time':
				if (this.chain.animated()) this.chain.automate(m.time);
				break;
			case 'meters':
				this.meters = m.on;
				break;
			case 'reset':
				this.chain.reset();
				break;
			case 'dispose':
				this.alive = false;
				break;
		}
	}

	/** One render quantum: input channels → output channels (missing input = silence). */
	render(input: readonly Float32Array[] | undefined, output: readonly Float32Array[]): void {
		const n = output[0]?.length ?? 0;
		if (n === 0) return;
		const buf = this.scratch;
		for (let c = 0; c < this.channels; c++) {
			const b = buf[c]!.length >= n ? buf[c]! : (buf[c] = new Float32Array(n));
			const src = input?.[c] ?? (input && input.length === 1 ? input[0] : undefined);
			if (src) b.set(src.subarray(0, n));
			else b.fill(0, 0, n);
		}
		this.chain.process(buf, 0, n);
		for (let c = 0; c < output.length; c++) output[c]!.set((buf[c] ?? buf[0]!).subarray(0, n));
		if (this.meters && this.port) {
			this.since += n;
			if (this.since >= METER_EVERY) {
				this.since = 0;
				const values: number[] = [];
				for (const p of this.chain.processors()) if (p.processor.meters) values.push(...p.processor.meters());
				this.port.postMessage({ type: 'meters', values } satisfies FxSlotReading);
			}
		}
	}
}
