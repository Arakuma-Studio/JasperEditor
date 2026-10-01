// Optional fast path for vid.stab (S07:PST-002/003): FFmpeg's own `vidstabdetect`/`vidstabtransform` filters,
// used ONLY when the engine vouches that its FFmpeg is our LGPL source build with the pinned relicensed
// vid.stab (`spec.vidstabEngine === 'ffmpeg'`; the licence guard checks BUILDINFO.json). The portable default is
// the WASM build of the same library (proc/vidstab/).
import { join } from 'node:path';
import type { ProcessStep } from '@jasper/project';
import { exitOf, spawnFfmpeg } from './ffio.ts';
import { assertLgplFilters, fromFormatToRgb48, toFormat } from './filters.ts';
import type { DecodeSpec, FrameStep, StepContext } from './types.ts';

/** Escapes a value for a filtergraph option (`:`, `\`, `'`, `,`). */
function ffEscape(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,');
}

function vidstabDetectFilter(step: Extract<ProcessStep, { op: 'stabilize' }>, trf: string): string {
	return `vidstabdetect=shakiness=${step.shakiness ?? 5}:accuracy=15:stepsize=4:mincontrast=0.2:result=${ffEscape(trf)}`;
}

function vidstabTransformFilter(step: Extract<ProcessStep, { op: 'stabilize' }>, trf: string): string {
	const crop = step.borders === 'crop';
	return `vidstabtransform=input=${ffEscape(trf)}:smoothing=${step.smoothing}:optalgo=gauss:crop=${crop ? 'keep' : 'black'}:optzoom=${crop ? 1 : 0}:interpol=bicubic${step.rotation === false ? ':maxangle=0' : ''}`;
}

/**
 * The native two-pass step. `adapter` turns a filter into a raw rgb48le → rgb48le FrameStep (the runner's
 * filterAdapter), so the transform pass streams like any other step.
 */
export function createNativeVidstabStep(
	step: Extract<ProcessStep, { op: 'stabilize' }>,
	adapter: (filter: { name: string; format: 'yuv444p'; filter: () => string }) => FrameStep,
): FrameStep {
	let trf = '';
	let inner: FrameStep | null = null;
	return {
		name: 'stabilize(vid.stab ffmpeg)',
		async analyse(input: DecodeSpec, ctx: StepContext) {
			trf = join(ctx.scratch, `vidstab-${Date.now()}.trf`);
			const conv = toFormat('yuv444p', input.matrix, input.range);
			const vf = [input.vf, conv, vidstabDetectFilter(step, trf)].filter(Boolean).join(',');
			assertLgplFilters(vf, { allowVidstab: true });
			const child = spawnFfmpeg(input.ffmpeg, [
				...input.inputArgs,
				'-map',
				'0:v:0',
				'-fps_mode',
				'passthrough',
				'-frames:v',
				String(input.frames),
				'-vf',
				vf,
				'-f',
				'null',
				'-',
			]);
			let err = '';
			child.stderr?.on('data', (d: Buffer) => {
				err = (err + d.toString()).slice(-2000);
			});
			const code = await exitOf(child);
			if (code !== 0) throw new Error(`vidstabdetect failed (${code}): ${err.trim()}`);
			ctx.analysisProgress(1);
			ctx.info('engine', 'ffmpeg');
		},
		async open(ctx) {
			const f = vidstabTransformFilter(step, trf);
			assertLgplFilters(`${toFormat('yuv444p')},${f},${fromFormatToRgb48('yuv444p')}`, {
				allowVidstab: true,
			});
			inner = adapter({ name: 'vidstabtransform', format: 'yuv444p', filter: () => f });
			return inner.open(ctx);
		},
		push: (frame) => (inner as FrameStep).push(frame),
		end: () => (inner as FrameStep).end(),
		close: async () => inner?.close?.(),
	};
}
