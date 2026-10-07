// AudioWorklet processors of the preview mix (audio-mix). Loaded with `audioWorklet.addModule(url)`; the web app
// bundles this module (with @jasper/audio-dsp) and hands the URL to `setMixWorkletUrl`.
//
// * `jasper-meter`: pass-through tap; posts per-channel peak / RMS / clip every ~33 ms and, with
//   `processorOptions.loudness`, the BS.1770-4 / R128 readouts (momentary, short-term, integrated, LRA, true peak).
// * `jasper-limiter`: look-ahead true-peak limiter at the loudness-normalisation ceiling (bypass when disabled).
import { LevelMeter, LoudnessMeter, TruePeakLimiter } from '@jasper/audio-dsp';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
	readonly port: MessagePort;
	constructor(options?: unknown);
}

type Options = {
	processorOptions?: { channels?: number; loudness?: boolean; ceilingDb?: number; enabled?: boolean };
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
			const msg: Record<string, unknown> = {
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

class LimiterProcessor extends AudioWorkletProcessor {
	private readonly channels: number;
	private limiter: TruePeakLimiter;
	private enabled: boolean;
	private readonly buf: Float32Array[];

	constructor(options: Options) {
		super(options);
		const o = options.processorOptions ?? {};
		this.channels = Math.max(1, o.channels ?? 2);
		this.enabled = o.enabled ?? true;
		this.limiter = new TruePeakLimiter(sampleRate, this.channels, {
			ceilingDb: o.ceilingDb ?? -1,
			lookaheadMs: 5,
		});
		this.buf = Array.from({ length: this.channels }, () => new Float32Array(128));
		this.port.onmessage = (e: MessageEvent) => {
			const m = e.data as { ceilingDb?: number; enabled?: boolean };
			if (m.ceilingDb !== undefined && Math.abs(m.ceilingDb - 20 * Math.log10(this.limiter.ceiling)) > 1e-6)
				this.limiter = new TruePeakLimiter(sampleRate, this.channels, {
					ceilingDb: m.ceilingDb,
					lookaheadMs: 5,
				});
			if (m.enabled !== undefined) this.enabled = m.enabled;
		};
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

registerProcessor('jasper-meter', MeterProcessor);
registerProcessor('jasper-limiter', LimiterProcessor);
