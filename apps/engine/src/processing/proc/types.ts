// jasper-proc (S07:PRC-011…014): the processor runtime's shared types. jasper-proc is a standalone CLI bundled
// to dist/jasper-proc.mjs; everything under processing/proc/ must only depend on Node built-ins and the
// processing runtimes (onnxruntime-node, OpenCV.js, the vid.stab WASM module) — never on the engine server.
import type { ProcessStep } from '@jasper/project';

/**
 * One frame between steps (S07:PRC-012): interleaved R'G'B' 16 bit per channel (`rgb48le`), full range,
 * BT.709-encoded (display-referred, as decoded with an explicit BT.709 matrix). `data.length = w·h·3`.
 */
export type RgbFrame = {
	/** 0-based index of the frame within the processed range (output order). */
	index: number;
	width: number;
	height: number;
	data: Uint16Array;
};

export type Rational = { num: number; den: number };

/**
 * How to decode exactly the frames a step works on (the source range or an intermediate file). `inputArgs`
 * are ffmpeg arguments up to and including `-i <file>` (accurate seek, stream selection); `frames` is the
 * number of video frames to take; the decoder adds `-fps_mode passthrough -frames:v <frames>`.
 */
export type DecodeSpec = {
	ffmpeg: string;
	inputArgs: string[];
	frames: number;
	width: number;
	height: number;
	fps: Rational;
	/** Video filter applied before the pixel-format conversion (e.g. fused head filters). */
	vf?: string;
	/**
	 * YUV matrix / range of the frames entering the final conversion (after `vf`); absent for RGB inputs
	 * (FFV1 gbrp16le intermediates). decodeFrames uses them for an explicit, never-guessed conversion.
	 */
	matrix?: 'bt709' | 'bt601' | 'bt2020' | 'fcc' | 'smpte240m';
	range?: 'tv' | 'pc';
};

export type StepContext = {
	ffmpeg: string;
	ffprobe: string;
	/** Worker threads / filter threads the step may use. */
	threads: number;
	device: 'cpu' | 'cuda';
	/** Private scratch directory of this job (deleted afterwards). */
	scratch: string;
	/** Geometry of the step's INPUT. */
	width: number;
	height: number;
	frames: number;
	fps: Rational;
	/** Installed models: id → absolute path + sha256 (upscale). */
	models: Record<string, { path: string; sha256: string; scale?: number }>;
	/** Adds a human-readable note to the job result / sidecar (e.g. "dejudder: no cadence found"). */
	note(message: string): void;
	/** Machine-readable facts for the sidecar (`steps[i].info`). */
	info(key: string, value: unknown): void;
	/** Progress of an analysis pass (0..1); push/end progress is counted by the runner. */
	analysisProgress(fraction: number): void;
	signal: AbortSignal;
};

/**
 * A step that works on decoded frames (dejudder, upscale, vid.stab). Contract:
 *  - `analyse` (optional) runs first, once, over the whole input (two-pass steps). It may decode the input
 *    itself through `input` (any pixel format / scale it likes: see ffio.ts `decodeFrames`).
 *  - `open` returns the output geometry.
 *  - `push` receives every input frame in order and returns 0..n output frames; `end` flushes. The total
 *    number of output frames MUST equal the number of input frames (S07 §1.2: timing never changes).
 *  - Frames returned may reuse input buffers.
 */
export interface FrameStep {
	readonly name: string;
	analyse?(input: DecodeSpec, ctx: StepContext): Promise<void>;
	open(ctx: StepContext): Promise<{ width: number; height: number }>;
	push(frame: RgbFrame): Promise<RgbFrame[]>;
	end(): Promise<RgbFrame[]>;
	close?(): Promise<void>;
}

/** A step implemented as an ffmpeg filter chain (deblock, denoise, deshake): fused into one ffmpeg process. */
export type FilterStep = {
	readonly name: string;
	/** Filter text working on `format` frames; must keep the frame count and use only LGPL filters (D-13). */
	filter(ctx: StepContext): string;
	/** Pixel format the filter expects (conversion is added by the runner). */
	format: 'yuv444p16le' | 'yuv444p' | 'gbrp16le' | 'rgb48le';
	/** Output size when it differs from the input. */
	outputSize?(ctx: StepContext): { width: number; height: number };
};

export type StepImpl = { kind: 'frames'; step: FrameStep } | { kind: 'filter'; step: FilterStep };

/** `jasper-proc run --spec spec.json` input (S07:PRC-011). */
export type ProcSpec = {
	input: string;
	output: string;
	steps: ProcessStep[];
	/** Source frame range [startFrame, endFrame) at the source rate (PRC-015); absent = the whole file. */
	range?: { startFrame: number; endFrame: number };
	ffmpeg: string;
	ffprobe: string;
	/** Model id → file (+ sha256) for upscale steps. */
	models: Record<string, { path: string; sha256: string; scale?: number }>;
	threads: number;
	device: 'cpu' | 'cuda';
	scratch: string;
	/** Optional vid.stab engine preference (`auto` = native ffmpeg filters when present, else WASM). */
	vidstabEngine?: 'auto' | 'wasm' | 'ffmpeg';
};

/** NDJSON events on stderr (S07:PRC-011). */
export type ProcEvent =
	| { event: 'start'; frames: number; steps: string[] }
	| { event: 'progress'; step: number; stage: string; done: number; total: number }
	| { event: 'note'; message: string }
	| { event: 'done'; frames: number; output: string; sidecar: string }
	| { event: 'error'; code: string; message: string };

export const PROC_EXIT = { ok: 0, other: 1, invalidSpec: 2, cancelled: 3 } as const;
