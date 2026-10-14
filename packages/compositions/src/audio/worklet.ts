// AudioWorklet processors of the preview mix (audio-mix). Loaded with `audioWorklet.addModule(url)`; the web app
// bundles this module (with @jasper/audio-dsp) and hands the URL to `setMixWorkletUrl`.
//
// * `jasper-meter`: pass-through tap; posts per-channel peak / RMS / clip every ~33 ms and, with
//   `processorOptions.loudness`, the BS.1770-4 / R128 readouts (momentary, short-term, integrated, LRA, true peak).
// * `jasper-limiter`: look-ahead true-peak limiter at the loudness-normalisation ceiling (bypass when disabled).
// * `jasper-audio-fx` (audio-fx): one audio effect slot running the shared effect DSP (fx-processor.ts).
// * `jasper-capture`: voice-over recording tap: posts the input (planar copies, ~85 ms batches) with the frame
//   index of the first sample (`currentFrame`), plus per-channel input peaks for the record meter.
import { LevelMeter, LoudnessMeter, TruePeakLimiter } from '@jasper/audio-dsp';
import { FX_PROCESSOR_NAME, FxSlotCore, type FxSlotMessage } from './fx-processor.ts';
import type { MeterReading } from './graph.ts';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: new (options: Options) => AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
	readonly port: MessagePort;
	constructor(options?: Options);
}

type Options = {
	processorOptions?: {
		channels?: number;
		loudness?: boolean;
		ceilingDb?: number;
		enabled?: boolean;
		lookaheadMs?: number;
	};
};

const POST_EVERY = Math.max(1, Math.round((sampleRate * 0.033) / 128));

class MeterProcessor extends AudioWorkletProcessor {
	private readonly channels: number;
	private level: LevelMeter;
	private loud: LoudnessMeter | null;
	private blocks = 0;
	private active = true;
	private readonly view: Float32Array[];

	constructor(options: Options) {
		super(options);
		const o = options.processorOptions ?? {};
		this.channels = Math.max(1, o.channels ?? 2);
		this.level = new LevelMeter(sampleRate, this.channels, { rmsWindowMs: 300 });
		this.loud = o.loudness ? new LoudnessMeter(sampleRate, this.channels) : null;
		this.view = Array.from({ length: this.channels }, () => new Float32Array(128));
		this.port.onmessage = (e: MessageEvent) => {
			const m = e.data as { type?: string; on?: boolean };
			if (m.type === 'reset') {
				this.loud?.reset();
				this.level.reset();
			} else if (m.type === 'active') this.active = !!m.on;
		};
	}

	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		const input = inputs[0] ?? [];
		const output = outputs[0] ?? [];
		const n = input[0]?.length ?? 128;
		for (let c = 0; c < this.channels; c++) {
			const src = input[c];
			const v = this.view[c]!;
			if (src) v.set(src);
			else v.fill(0);
			if (output[c]) output[c]!.set(v.subarray(0, n));
		}
		if (!this.active) return true;
		this.level.process(this.view, 0, n);
		this.loud?.process(this.view, 0, n);
		if (++this.blocks >= POST_EVERY) {
			this.blocks = 0;
			const r = this.level.take();
			const msg: Omit<MeterReading, 'at'> = {
				peak: Array.from(r.peak),
				rms: Array.from(r.rms),
				clipped: Array.from(r.clipped),
			};
			if (this.loud) {
				const s = this.loud.summary();
				msg.loudness = {
					momentary: this.loud.momentary(),
					shortTerm: this.loud.shortTerm(),
					integrated: s.integrated,
					lra: s.lra,
					truePeakDb: s.truePeakDb,
					samplePeakDb: s.samplePeakDb,
					maxMomentary: s.maxMomentary,
					maxShortTerm: s.maxShortTerm,
				};
			}
			this.port.postMessage(msg);
		}
		return true;
	}
}

// The mix graph counts the limiter's latency in its read-ahead only while it is enabled (disabled = no delay), and a
// re-enabled limiter starts from a clean state (no stale look-ahead audio from before it was bypassed).
class LimiterProcessor extends AudioWorkletProcessor {
	private readonly channels: number;
	private readonly lookaheadMs: number;
	private limiter: TruePeakLimiter;
	private enabled: boolean;
	private readonly buf: Float32Array[];

	constructor(options: Options) {
		super(options);
		const o = options.processorOptions ?? {};
		this.channels = Math.max(1, o.channels ?? 2);
		this.enabled = o.enabled ?? true;
		this.lookaheadMs = o.lookaheadMs ?? 5;
		this.limiter = this.make(o.ceilingDb ?? -1);
		this.buf = Array.from({ length: this.channels }, () => new Float32Array(128));
		this.port.onmessage = (e: MessageEvent) => {
			const m = e.data as { ceilingDb?: number; enabled?: boolean };
			const ceiling = m.ceilingDb ?? 20 * Math.log10(this.limiter.ceiling);
			const enabling = m.enabled === true && !this.enabled;
			if (
				enabling ||
				(m.ceilingDb !== undefined && Math.abs(m.ceilingDb - 20 * Math.log10(this.limiter.ceiling)) > 1e-6)
			)
				this.limiter = this.make(ceiling);
			if (m.enabled !== undefined) this.enabled = m.enabled;
		};
	}

	private make(ceilingDb: number): TruePeakLimiter {
		const c = Number.isFinite(ceilingDb) ? ceilingDb : -1;
		return new TruePeakLimiter(sampleRate, this.channels, { ceilingDb: c, lookaheadMs: this.lookaheadMs });
	}

	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		const input = inputs[0] ?? [];
		const output = outputs[0] ?? [];
		const n = output[0]?.length ?? 128;
		for (let c = 0; c < this.channels; c++) {
			const b = this.buf[c]!;
			if (input[c]) b.set(input[c]!);
			else b.fill(0);
		}
		if (this.enabled) this.limiter.process(this.buf, 0, n);
		for (let c = 0; c < this.channels; c++) output[c]?.set(this.buf[c]!.subarray(0, n));
		return true;
	}
}

declare const currentFrame: number;

class CaptureProcessor extends AudioWorkletProcessor {
	private recording = false;
	private batch: Float32Array[][] = [];
	private batchFrames = 0;
	private batchStart = 0;
	private readonly flushFrames: number;
	private peaks: number[] = [];

	constructor(options: Options) {
		super(options);
		this.flushFrames = Math.max(128, Math.round(sampleRate * 0.085));
		this.port.onmessage = (e: MessageEvent) => {
			const m = e.data as { type?: string };
			if (m.type === 'start') {
				this.recording = true;
				this.batch = [];
				this.batchFrames = 0;
			} else if (m.type === 'stop') {
				this.flush();
				this.recording = false;
				this.port.postMessage({ type: 'stopped', frame: currentFrame });
			}
		};
	}

	private flush(): void {
		if (this.batchFrames === 0) return;
		const nch = this.batch[0]?.length ?? 0;
		const out = Array.from({ length: nch }, () => new Float32Array(this.batchFrames));
		let o = 0;
		for (const block of this.batch) {
			for (let c = 0; c < nch; c++) out[c]!.set(block[c]!, o);
			o += block[0]!.length;
		}
		this.port.postMessage(
			{ type: 'data', start: this.batchStart, channels: out },
			out.map((c) => c.buffer),
		);
		this.batch = [];
		this.batchFrames = 0;
	}

	process(inputs: Float32Array[][]): boolean {
		const input = inputs[0] ?? [];
		const n = input[0]?.length ?? 0;
		if (n === 0) return true;
		for (let c = 0; c < input.length; c++) {
			let p = this.peaks[c] ?? 0;
			const x = input[c]!;
			for (let i = 0; i < n; i++) {
				const a = x[i]! < 0 ? -x[i]! : x[i]!;
				if (a > p) p = a;
			}
			this.peaks[c] = p;
		}
		if (this.recording) {
			if (this.batchFrames === 0) this.batchStart = currentFrame;
			this.batch.push(input.map((c) => c.slice()));
			this.batchFrames += n;
			if (this.batchFrames >= this.flushFrames) this.flush();
		}
		if (currentFrame % 4096 < 128) {
			this.port.postMessage({ type: 'peaks', peaks: this.peaks });
			this.peaks = [];
		}
		return true;
	}
}

registerProcessor('jasper-meter', MeterProcessor);
registerProcessor('jasper-capture', CaptureProcessor);
registerProcessor('jasper-limiter', LimiterProcessor);

/** audio-fx: one audio effect slot (clip effect or strip insert), see fx-processor.ts. */
class FxProcessor extends AudioWorkletProcessor {
	private readonly core: FxSlotCore;
	constructor(options: { processorOptions?: { channels?: number } }) {
		super(options);
		const channels = Math.max(1, options.processorOptions?.channels ?? 2);
		this.core = new FxSlotCore(sampleRate, channels, this.port);
		this.port.onmessage = (e: MessageEvent) => this.core.message(e.data as FxSlotMessage);
	}
	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		if (!this.core.alive) return false;
		const out = outputs[0];
		if (out) this.core.render(inputs[0], out);
		return true;
	}
}
registerProcessor(FX_PROCESSOR_NAME, FxProcessor);
