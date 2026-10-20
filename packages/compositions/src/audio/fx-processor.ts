// audio-fx: the AudioWorklet processor of one audio effect slot (`jasper-audio-fx`), registered by `worklet.ts`. It
// hosts the same `EffectChain` code as the export (`@jasper/audio-fx` EffectSlot in the offline mixer). The main
// thread posts the effect instance whenever it changes and the slot time (content flicks for clip effects, sequence
// flicks for inserts) every rendered frame. Paused, keyframed parameters are evaluated at that time. Playing, the time
// comes with its clock (`SlotClock`: the context time it is valid at, its rate and the export's control-block grid):
// the slot advances the time sample by sample and evaluates keyframed parameters every `CONTROL_BLOCK` samples on the
// export's grid, as the export's `EffectSlot` does (sound-design Phase 4 verification: a build sweep evaluated once
// per frame was up to 0.08 off the export at its release). Exported for tests (the class runs in Node with a stub
// `AudioWorkletProcessor`).
import { CONTROL_BLOCK, EffectChain } from '@jasper/audio-fx';
import type { EffectInstance } from '@jasper/project/audio';

/**
 * The clock of a slot's time while playing: `time` is valid at context time `at`, advances `rate` slot flicks per
 * sequence flick (a clip's speed, negative reversed; 1 for inserts), and `grid` is the sample index on the export's
 * control-block grid at `at` (samples since the slot's start in the export).
 */
export type SlotClock = { at: number; rate: number; grid: number };

/** Main → worklet messages. */
export type FxSlotMessage =
	| { type: 'effect'; effect: EffectInstance; time: number; clock?: SlotClock }
	| { type: 'time'; time: number; clock?: SlotClock }
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
	private readonly sampleRate: number;
	private readonly scratch: Float32Array[];
	private meters = false;
	private since = 0;
	/** Whether the parameters were snapped to the instance's values (first instance, or after a reset). */
	private primed = false;
	/** The running clock while playing (null: the time of the last message stands). */
	private clock: (SlotClock & { time: number }) | null = null;
	private readonly flicksPerSample: number;
	alive = true;

	constructor(
		sampleRate: number,
		readonly channels: number,
		private readonly port: Port | null,
	) {
		this.chain = new EffectChain(sampleRate, channels);
		this.sampleRate = sampleRate;
		this.flicksPerSample = 705_600_000 / sampleRate;
		this.scratch = Array.from({ length: channels }, () => new Float32Array(128));
	}

	message(m: FxSlotMessage): void {
		switch (m.type) {
			case 'effect':
				this.chain.setEffects([{ ...m.effect, enabled: true }]);
				this.clock = m.clock && validClock(m.clock) ? { ...m.clock, time: m.time } : null;
				if (this.chain.animated()) this.chain.automate(m.time);
				// The processors were built with the catalogue defaults: the first instance applies at once (nothing was
				// processed yet), like the export's EffectSlot; later edits glide (the smoothers avoid clicks).
				if (!this.primed) {
					this.chain.reset();
					this.primed = true;
				}
				break;
			case 'time':
				this.clock = m.clock && validClock(m.clock) ? { ...m.clock, time: m.time } : null;
				// with a clock the next control point on the grid evaluates it (at the sample it is valid for)
				if (!this.clock && this.chain.animated()) this.chain.automate(m.time);
				break;
			case 'meters':
				this.meters = m.on;
				break;
			case 'reset':
				this.chain.reset();
				this.primed = false;
				this.clock = null;
				break;
			case 'dispose':
				this.alive = false;
				break;
		}
	}

	/**
	 * One render quantum: input channels → output channels (missing input = silence). `now`: the context time of the
	 * quantum's first sample (the worklet's `currentTime`), for the running clock.
	 */
	render(input: readonly Float32Array[] | undefined, output: readonly Float32Array[], now?: number): void {
		const n = output[0]?.length ?? 0;
		if (n === 0) return;
		const buf = this.scratch;
		for (let c = 0; c < this.channels; c++) {
			const b = buf[c]!.length >= n ? buf[c]! : (buf[c] = new Float32Array(n));
			const src = input?.[c] ?? (input && input.length === 1 ? input[0] : undefined);
			if (src) b.set(src.subarray(0, n));
			else b.fill(0, 0, n);
		}
		const clock = this.clock;
		if (clock && now !== undefined && Number.isFinite(now) && this.chain.animated()) {
			// samples since the clock's time; control points where the export's grid has them
			const off = Math.round((now - clock.at) * this.sampleRate);
			const g0 = Math.round(clock.grid) + off;
			const step = this.flicksPerSample * clock.rate;
			let i = 0;
			while (i < n) {
				const phase = (((g0 + i) % CONTROL_BLOCK) + CONTROL_BLOCK) % CONTROL_BLOCK;
				if (phase === 0) this.chain.automate(clock.time + (off + i) * step);
				const k = Math.min(n - i, CONTROL_BLOCK - phase);
				this.chain.process(buf, i, i + k);
				i += k;
			}
		} else this.chain.process(buf, 0, n);
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

function validClock(c: SlotClock): boolean {
	return Number.isFinite(c.at) && Number.isFinite(c.rate) && Number.isFinite(c.grid);
}
