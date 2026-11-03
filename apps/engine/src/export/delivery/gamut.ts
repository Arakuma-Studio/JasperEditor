// Spec 19 TL-116: the gamut overlay's measurement. The frame is the render the Program monitor stands for (full
// resolution, working signal, no display LUT), so the percentage is the export's, not a thumbnail's; the Program picture
// itself cannot be read back in general (it is DOM, only some stacks pass through a canvas).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GamutCheckRequest, GamutCheckResult } from '@jasper/api';
import { checkGamut, colorSpace, gamutMask, sequenceColorInfo } from '@jasper/project';
import { type JobContext, JobError } from '../../jobs/types.ts';
import { decodePngRgba } from '../stream/png.ts';
import { encodePngAsync } from '../synthetic.ts';
import { type DeliveryDeps, renderOptions } from './alpha.ts';

export async function runGamutCheck(
	ctx: JobContext,
	req: GamutCheckRequest,
	d: DeliveryDeps,
): Promise<GamutCheckResult> {
	const { doc } = await d.frames(ctx, req.envelope, req.sequenceId, { start: req.frame, end: req.frame + 1 });
	const { width, height } = doc.settings;
	const working = doc.settings.color ?? sequenceColorInfo(null);
	const output = !req.output || req.output === 'working' ? working.space : req.output;
	const space = colorSpace(output);
	if (!space) throw new JobError('VALIDATION_FAILED', `Unknown colour space "${output}"`, false);
	const scratch = await ctx.scratchDir();
	const png = join(scratch, 'gamut-frame.png');
	ctx.progress(0, { stage: 'Rendering the frame' });
	await d.remotion.renderStill({
		inputProps: { doc, options: renderOptions(false) },
		output: png,
		frame: 0,
		signal: ctx.signal,
		purpose: 'still',
	});
	const rgba = await decodePngRgba(await readFile(png), width, height);
	if (!rgba)
		throw new JobError('RENDER_FAILED', 'The frame did not render as an 8-bit PNG of its size', true);
	ctx.signal.throwIfAborted();
	ctx.progress(0.8, { stage: 'Measuring' });
	const check = checkGamut(rgba, width, height, working, output);
	const out = await d.outDir(ctx);
	ctx.addPartial(out);
	await writeFile(
		join(out, 'output.png'),
		await encodePngAsync(gamutMask(check, width, height), width, height),
	);
	return {
		frame: req.frame,
		output,
		outputLabel: space.label,
		width,
		height,
		gamutPercent: check.gamutPercent,
		legalPercent: check.legalPercent,
		anyPercent: check.anyPercent,
		maskUrl: `/renders/${ctx.job.id}/output`,
	};
}
