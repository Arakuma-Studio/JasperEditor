// Spec 19 TL-112: the `psd-export` job. Each planned picture is rendered alone on a transparent page, trimmed, and handed
// to the assembler; only one is in memory at a time. Cancellation is checked between layers and every step takes the
// job's signal. A blocked plan never starts writing.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PsdPlan, PsdRequest, PsdResult } from '@jasper/api';
import type { RenderSnapshot } from '@jasper/project';
import type { SharedRenderBrowser } from '../../remotion/service.ts';
import { type JobContext, JobError } from '../../jobs/types.ts';
import { decodePngRgba } from '../stream/png.ts';
import type { DeliveryDeps } from './alpha.ts';
import { renderOptions } from './alpha.ts';
import { type PsdLayout, type PsdNode, type PsdRender, planPsd, psdRenderDoc } from './psd-plan.ts';
import { MAX_PSD_FILE_BYTES, PsdAssembler, type PsdPixels, PsdTooLargeError } from './psd-writer.ts';
import { alphaBounds } from './trim.ts';

/** Draws one planned picture: RGBA, straight alpha, the size of the frame. */
export type PsdPainter = (render: PsdRender) => Promise<Uint8Array>;

/** `rgba` of a `w × h` frame cut to its visible pixels, or null when it has none. */
export function trimmedPixels(rgba: Uint8Array, w: number, h: number): PsdPixels | null {
	const b = alphaBounds(rgba, w, h);
	if (!b) return null;
	const tw = b.x1 - b.x0;
	const th = b.y1 - b.y0;
	if (tw === w && th === h) return { data: rgba, width: w, height: h, left: 0, top: 0 };
	const data = new Uint8Array(tw * th * 4);
	for (let y = 0; y < th; y++) {
		const start = ((y + b.y0) * w + b.x0) * 4;
		data.set(rgba.subarray(start, start + tw * 4), y * tw * 4);
	}
	return { data, width: tw, height: th, left: b.x0, top: b.y0 };
}

const countPictures = (nodes: readonly PsdNode[]): number =>
	nodes.reduce((n, x) => n + (x.kind === 'pixels' ? 1 : countPictures(x.children)), 0);

/** Writes the planned layers and the composite to `dest` (atomically). Returns its size. */
export async function writePsdFile(o: {
	layout: PsdLayout;
	paint: PsdPainter;
	dest: string;
	scratch: string;
	signal: AbortSignal;
	onLayer?: (done: number, total: number, name: string) => void;
}): Promise<number> {
	const { width, height } = o.layout.plan;
	const assembler = new PsdAssembler(join(o.scratch, 'psd-channels.bin'), {
		width,
		height,
		resources: {
			resolutionInfo: {
				horizontalResolution: 72,
				horizontalResolutionUnit: 'PPI',
				widthUnit: 'Inches',
				verticalResolution: 72,
				verticalResolutionUnit: 'PPI',
				heightUnit: 'Inches',
			},
		},
	});
	const total = countPictures(o.layout.nodes) + 1;
	let done = 0;
	const walk = async (nodes: readonly PsdNode[]): Promise<void> => {
		for (const n of nodes) {
			o.signal.throwIfAborted();
			if (n.kind === 'group') {
				await assembler.openGroup();
				await walk(n.children);
				await assembler.closeGroup(n);
				continue;
			}
			o.onLayer?.(done, total, n.name);
			const rgba = await o.paint(n.render);
			await assembler.addPixels({
				name: n.name,
				blend: n.blend,
				opacity: n.opacity,
				hidden: n.hidden,
				pixels: trimmedPixels(rgba, width, height),
			});
			done++;
		}
	};
	try {
		await walk(o.layout.nodes);
		o.signal.throwIfAborted();
		o.onLayer?.(done, total, 'Composite');
		const composite = await o.paint(o.layout.composite);
		return await assembler.finish(composite, o.dest, o.signal);
	} finally {
		assembler.close();
		await rm(join(o.scratch, 'psd-channels.bin'), { force: true });
	}
}

/** Refuses a blocked plan with its blockers (they are shown before writing; a job that gets here is a stale request). */
export function assertWritable(plan: PsdPlan): void {
	if (plan.blockers.length)
		throw new JobError('PSD_BLOCKED', plan.blockers.map((b) => b.message).join('; '), false, {
			blockers: plan.blockers,
		});
}

/** `psd-export` job. */
export async function runPsdExport(ctx: JobContext, req: PsdRequest, d: DeliveryDeps): Promise<PsdResult> {
	const range = { start: req.frame, end: req.frame + 1 };
	const { doc, displayLut } = await d.frames(ctx, req.envelope, req.sequenceId, range);
	const layout = planPsd(doc, req.frame, { splitTitles: req.splitTitles === true });
	assertWritable(layout.plan);
	const scratch = await ctx.scratchDir();
	const out = await d.outDir(ctx);
	ctx.addPartial(out);
	const dest = join(out, 'output.psd');
	const { width, height } = layout.plan;
	const tmp = join(scratch, 'layer.png');
	const browser: SharedRenderBrowser = await d.remotion.openSharedBrowser();
	const paint: PsdPainter = async (render) => {
		const page: RenderSnapshot = psdRenderDoc(doc, render);
		await d.remotion.renderStill({
			inputProps: { doc: page, options: renderOptions(true) },
			output: tmp,
			frame: 0,
			signal: ctx.signal,
			purpose: 'still',
			browser,
		});
		let png = tmp;
		if (displayLut) {
			png = join(scratch, 'layer-display.png');
			await d.ff.run(['-i', tmp, '-vf', `format=rgba,${displayLut}`, '-frames:v', '1', '-y', png], {
				signal: ctx.signal,
				onSpawn: ctx.trackChild,
			});
		}
		const rgba = await decodePngRgba(await readFile(png), width, height);
		if (!rgba) throw new JobError('RENDER_FAILED', 'A layer did not render as an 8-bit PNG of the frame size', true);
		return rgba;
	};
	let bytes: number;
	try {
		bytes = await writePsdFile({
			layout,
			paint,
			dest,
			scratch,
			signal: ctx.signal,
			onLayer: (done, total, name) => ctx.progress(done / total, { stage: `Layer ${done + 1}/${total}: ${name}` }),
		});
	} catch (e) {
		if (e instanceof PsdTooLargeError)
			throw new JobError('PSD_TOO_LARGE', `${e.message} (${MAX_PSD_FILE_BYTES} bytes)`, false);
		throw e;
	} finally {
		await browser.close();
	}
	const path = req.destination
		? await d.copyOut(dest, join(req.destination.folder, `${req.destination.name}.psd`), ctx)
		: undefined;
	return {
		url: `/renders/${ctx.job.id}/output`,
		...(path ? { path } : {}),
		bytes,
		width,
		height,
		layers: layout.plan.layers,
		baked: layout.plan.baked,
		warnings: layout.plan.warnings,
	};
}
