// Stand-alone driver for a FrameStep over a DecodeSpec (tests and validate.ts; the jasper-proc runner does the
// same with progress events and the encoder). Not used by the runtime itself.
import { decodeFrames, RawWriter, spawnFfmpeg, u16 } from '../ffio.ts';
import type { DecodeSpec, FrameStep, RgbFrame, StepContext } from '../types.ts';

type RecordingContext = StepContext & { notes: string[]; facts: Record<string, unknown> };

export function makeStepContext(spec: DecodeSpec, init: Partial<StepContext> = {}): RecordingContext {
	const notes: string[] = [];
	const facts: Record<string, unknown> = {};
	return {
		ffmpeg: spec.ffmpeg,
		ffprobe: spec.ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'),
		threads: 2,
		device: 'cpu',
		scratch: '',
		width: spec.width,
		height: spec.height,
		frames: spec.frames,
		fps: spec.fps,
		models: {},
		note: (m) => notes.push(m),
		info: (k, v) => {
			facts[k] = v;
		},
		analysisProgress: () => {},
		signal: new AbortController().signal,
		...init,
		notes,
		facts,
	};
}

/**
 * Runs `step` over the frames of `spec` (analyse → open → push… → end) and hands every output frame, in order,
 * to `onFrame` (default: collect them). Checks the 1-in-1-out contract.
 */
export async function runFrameStep(
	step: FrameStep,
	spec: DecodeSpec,
	ctx: StepContext,
	onFrame?: (f: RgbFrame) => Promise<void> | void,
): Promise<{ frames: RgbFrame[]; inputFrames: number; outputFrames: number }> {
	const frames: RgbFrame[] = [];
	const sink = onFrame ?? ((f: RgbFrame) => void frames.push(f));
	let inputFrames = 0;
	let outputFrames = 0;
	const take = async (out: RgbFrame[]) => {
		for (const f of out) {
			if (f.index !== outputFrames) throw new Error(`frame order: got ${f.index}, expected ${outputFrames}`);
			outputFrames++;
			await sink(f);
		}
	};
	try {
		await step.analyse?.(spec, ctx);
		await step.open(ctx);
		for await (const buf of decodeFrames(spec, { pixFmt: 'rgb48le', signal: ctx.signal })) {
			await take(
				await step.push({ index: inputFrames++, width: spec.width, height: spec.height, data: u16(buf) }),
			);
		}
		await take(await step.end());
	} finally {
		await step.close?.();
	}
	if (outputFrames !== inputFrames) throw new Error(`frame count: ${inputFrames} in, ${outputFrames} out`);
	return { frames, inputFrames, outputFrames };
}

/** A lossless FFV1 (gbrp16le) writer for rgb48 frames. */
export function ffv1Writer(
	ffmpeg: string,
	file: string,
	width: number,
	height: number,
	fps: { num: number; den: number },
): RawWriter {
	return new RawWriter(
		spawnFfmpeg(
			ffmpeg,
			[
				'-y',
				'-f',
				'rawvideo',
				'-pix_fmt',
				'rgb48le',
				'-s',
				`${width}x${height}`,
				'-r',
				`${fps.num}/${fps.den}`,
				'-i',
				'-',
				'-c:v',
				'ffv1',
				'-level',
				'3',
				'-pix_fmt',
				'gbrp16le',
				file,
			],
			'pipe',
		),
	);
}

/** DecodeSpec of a whole file (from frame 0). */
export function fileSpec(
	ffmpeg: string,
	file: string,
	frames: number,
	width: number,
	height: number,
	fps = { num: 30, den: 1 },
): DecodeSpec {
	return { ffmpeg, inputArgs: ['-i', file], frames, width, height, fps };
}
