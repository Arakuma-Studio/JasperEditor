// The Pitch Shifter's `rubberband-r3` engine: Rubber Band Library 4 (GPL-2.0-or-later, an exception accepted by the
// user, AGENTS.md §2) compiled to its own WebAssembly module, `rubberband.wasm` (scripts/rubberband-wasm/build.sh).
// This file only drives that module through its C API; it never contains or links Rubber Band code. Hosts hand the
// compiled module over once with `setRubberBandModule` (the engine reads the file, the preview passes the module into
// its AudioWorklet); without it the Pitch Shifter falls back to Signalsmith and hosts warn (`rubberBandStatus`).
//
// Streaming: R3 in real-time mode (EngineFiner, PitchHighQuality, channels together for stereo), fed in fixed
// CHUNK-sample calls counted from the reset, so the output never depends on how the host cuts its blocks. The
// preferred start pad is fed at the reset and the start delay dropped, so the library's output stream is aligned
// with the input; a FIFO pre-filled with `latency()` zeros turns it into one output sample per input sample.

const CHUNK = 256;
const OPT_REALTIME = 0x0000_0001;
const OPT_WINDOW_SHORT = 0x0010_0000;
const OPT_FORMANT_PRESERVED = 0x0100_0000;
const OPT_PITCH_HQ = 0x0200_0000;
const OPT_CHANNELS_TOGETHER = 0x1000_0000;
const OPT_ENGINE_FINER = 0x2000_0000;
/** Most retrievable output stays behind the fed input (measured at 44.1 / 48 / 96 kHz, ±12 st, with a ~10 % margin). */
const LAG_SECONDS = { best: 0.11, fast: 0.07 } as const;

let rbModule: WebAssembly.Module | null = null;
let rbError: string | null = 'Rubber Band module not loaded';

/** Installs (or clears, with the reason) the compiled `rubberband.wasm` for this thread's Pitch Shifters. */
export function setRubberBandModule(module: WebAssembly.Module | null, error?: string): void {
	rbModule = module;
	rbError = module ? null : (error ?? 'Rubber Band module not loaded');
}

/** Whether the Rubber Band engine can run in this thread (else the Pitch Shifter uses Signalsmith). */
export function rubberBandStatus(): { available: boolean; error: string | null } {
	return { available: rbModule !== null && rbError === null, error: rbError };
}

/** Output delay of the Rubber Band engine at `sampleRate` (independent of whether the module is available). */
export function rubberBandLatency(quality: 'best' | 'fast', sampleRate: number): number {
	return Math.ceil(sampleRate * LAG_SECONDS[quality]) + CHUNK;
}

type Exports = {
	memory: WebAssembly.Memory;
	_initialize(): void;
	rbx_malloc(n: number): number;
	rbx_free(p: number): void;
	rubberband_new(sr: number, ch: number, options: number, timeRatio: number, pitchScale: number): number;
	rubberband_delete(s: number): void;
	rubberband_set_pitch_scale(s: number, scale: number): void;
	rubberband_set_formant_option(s: number, options: number): void;
	rubberband_get_preferred_start_pad(s: number): number;
	rubberband_get_start_delay(s: number): number;
	rubberband_set_max_process_size(s: number, n: number): void;
	rubberband_process(s: number, input: number, n: number, final: number): void;
	rubberband_available(s: number): number;
	rubberband_retrieve(s: number, output: number, n: number): number;
	rubberband_set_default_debug_level(level: number): void;
};

/** WASI preview1 imports: no files, no environment, a zero clock (Rubber Band's timing is compiled out). */
function wasi(memory: () => WebAssembly.Memory): WebAssembly.ModuleImports {
	const EBADF = 8;
	return {
		environ_sizes_get: (countPtr: number, sizePtr: number) => {
			const v = new DataView(memory().buffer);
			v.setUint32(countPtr, 0, true);
			v.setUint32(sizePtr, 0, true);
			return 0;
		},
		environ_get: () => 0,
		clock_time_get: (_id: number, _precision: bigint, outPtr: number) => {
			new DataView(memory().buffer).setBigUint64(outPtr, 0n, true);
			return 0;
		},
		fd_write: (_fd: number, iovs: number, iovsLen: number, nwrittenPtr: number) => {
			const v = new DataView(memory().buffer);
			let n = 0;
			for (let i = 0; i < iovsLen; i++) n += v.getUint32(iovs + i * 8 + 4, true);
			v.setUint32(nwrittenPtr, n, true);
			return 0;
		},
		fd_close: () => EBADF,
		fd_fdstat_get: () => EBADF,
		fd_prestat_get: () => EBADF,
		fd_prestat_dir_name: () => EBADF,
		fd_read: () => EBADF,
		fd_seek: () => EBADF,
		proc_exit: (code: number) => {
			throw new Error(`rubberband.wasm exited (${code})`);
		},
	};
}

/** A Rubber Band R3 pitch shifter on its own module instance; null when the module is missing or fails to start. */
export function createRubberBand(
	sampleRate: number,
	channels: number,
	quality: 'best' | 'fast',
): RubberBandEngine | null {
	if (!rbModule || rbError) return null;
	try {
		return new RubberBandEngine(rbModule, sampleRate, Math.max(1, channels), quality);
	} catch (e) {
		// A module that cannot start here (a trap, or a host refusing synchronous instantiation) stays off.
		rbError = `Rubber Band failed to start: ${e instanceof Error ? e.message : String(e)}`;
		return null;
	}
}

export class RubberBandEngine {
	private readonly x: Exports;
	private state = 0;
	private readonly inPtrs: number;
	private readonly outPtrs: number;
	private readonly inBuf: number;
	private readonly outBuf: number;
	private readonly outCap: number;
	private readonly fifo: Float32Array[];
	private readonly cap: number;
	private head = 0;
	private count = 0;
	private fill = 0;
	private discard = 0;
	private pitch = 1;
	private formants = false;
	private readonly lat: number;
	/** Samples output as silence because the library had not produced them yet (never seen in the measurements). */
	underruns = 0;
	failed: string | null = null;

	constructor(
		module: WebAssembly.Module,
		readonly sampleRate: number,
		readonly channels: number,
		readonly quality: 'best' | 'fast',
	) {
		let mem: WebAssembly.Memory | null = null;
		const inst = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi(() => mem!) });
		this.x = inst.exports as unknown as Exports;
		mem = this.x.memory;
		this.x._initialize();
		this.x.rubberband_set_default_debug_level(0);
		this.lat = rubberBandLatency(quality, sampleRate);
		this.outCap = 8192;
		this.inPtrs = this.x.rbx_malloc(4 * channels);
		this.outPtrs = this.x.rbx_malloc(4 * channels);
		this.inBuf = this.x.rbx_malloc(4 * CHUNK * channels);
		this.outBuf = this.x.rbx_malloc(4 * this.outCap * channels);
		const p = new Uint32Array(this.x.memory.buffer);
		for (let c = 0; c < channels; c++) {
			p[(this.inPtrs >> 2) + c] = this.inBuf + 4 * CHUNK * c;
			p[(this.outPtrs >> 2) + c] = this.outBuf + 4 * this.outCap * c;
		}
		this.cap = this.lat + 4 * this.outCap;
		this.fifo = Array.from({ length: channels }, () => new Float32Array(this.cap));
		this.reset();
	}

	latency(): number {
		return this.lat;
	}

	private view: Float32Array | null = null;
	/** The input chunk in module memory (re-taken when the library grew its memory, which detaches old views). */
	private inView(): Float32Array {
		const buf = this.x.memory.buffer;
		if (!this.view || this.view.buffer !== buf)
			this.view = new Float32Array(buf, this.inBuf, CHUNK * this.channels);
		return this.view;
	}

	private options(): number {
		return (
			OPT_REALTIME |
			OPT_ENGINE_FINER |
			OPT_PITCH_HQ |
			(this.channels === 2 ? OPT_CHANNELS_TOGETHER : 0) |
			(this.quality === 'fast' ? OPT_WINDOW_SHORT : 0) |
			(this.formants ? OPT_FORMANT_PRESERVED : 0)
		);
	}

	setPitch(scale: number): void {
		if (scale === this.pitch) return;
		this.pitch = scale;
		if (this.state) this.x.rubberband_set_pitch_scale(this.state, scale);
	}

	setFormants(on: boolean): void {
		if (on === this.formants) return;
		this.formants = on;
		if (this.state) this.x.rubberband_set_formant_option(this.state, on ? OPT_FORMANT_PRESERVED : 0);
	}

	reset(): void {
		const x = this.x;
		if (this.state) x.rubberband_delete(this.state);
		this.state = x.rubberband_new(this.sampleRate, this.channels, this.options(), 1, this.pitch);
		x.rubberband_set_max_process_size(this.state, CHUNK);
		for (const f of this.fifo) f.fill(0);
		this.head = 0;
		this.count = this.lat;
		this.fill = 0;
		this.underruns = 0;
		this.discard = x.rubberband_get_start_delay(this.state);
		// the preferred start pad: silence before the first input, so the processing starts at the input's start
		const pad = x.rubberband_get_preferred_start_pad(this.state);
		this.inView().fill(0);
		for (let left = pad; left > 0; left -= CHUNK) {
			x.rubberband_process(this.state, this.inPtrs, Math.min(CHUNK, left), 0);
			this.drain();
		}
	}

	/** Moves every available output sample (after the start delay) into the FIFO. */
	private drain(): void {
		const x = this.x;
		for (;;) {
			const a = x.rubberband_available(this.state);
			if (a <= 0) return;
			const got = x.rubberband_retrieve(this.state, this.outPtrs, Math.min(a, this.outCap));
			if (got <= 0) return;
			const out = new Float32Array(x.memory.buffer, this.outBuf, this.outCap * this.channels);
			let from = 0;
			if (this.discard > 0) {
				from = Math.min(got, this.discard);
				this.discard -= from;
			}
			for (let i = from; i < got; i++) {
				if (this.count >= this.cap) break; // cannot happen at time ratio 1 (bounded by the measured lag)
				const at = (this.head + this.count) % this.cap;
				for (let c = 0; c < this.channels; c++) this.fifo[c]![at] = out[c * this.outCap + i]!;
				this.count++;
			}
		}
	}

	process(ch: readonly Float32Array[], start: number, end: number, flush: (v: number) => number): void {
		const nch = Math.min(ch.length, this.channels);
		const x = this.x;
		for (let i = start; i < end; i++) {
			const inp = this.inView();
			for (let c = 0; c < this.channels; c++) inp[c * CHUNK + this.fill] = c < nch ? ch[c]![i]! : 0;
			if (++this.fill === CHUNK) {
				this.fill = 0;
				x.rubberband_process(this.state, this.inPtrs, CHUNK, 0);
				this.drain();
			}
			if (this.count > 0) {
				for (let c = 0; c < nch; c++) ch[c]![i] = flush(this.fifo[c]![this.head]!);
				this.head = this.head + 1 === this.cap ? 0 : this.head + 1;
				this.count--;
			} else {
				this.underruns++;
				for (let c = 0; c < nch; c++) ch[c]![i] = 0;
			}
		}
	}
}
