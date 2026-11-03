// Spec 19 TL-114: PNG frames with alpha, one job for a sequence, a transparent frame and Export Title. Frames are drawn by
// the compositions on a transparent page, the path of the layer bake, and written straight (never premultiplied), so
// low-alpha colour survives. ffmpeg only filters and encodes PNG (`crop`, `lut3d`, `format`: no GPL filter is involved).
//
// Export Title (`clipIds` + `trim`) renders on a canvas larger than the sequence, so a glow past the frame is drawn, then
// measures every frame and crops them all to the union of what they paint plus the margin. If the content reaches the
// canvas edge the canvas doubles once; if it still does, the job says so instead of pretending.
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AlphaDeliveryRequest, AlphaDeliveryResult } from '@jasper/api';
import type { RenderSnapshot } from '@jasper/project';
import { type JobContext, JobError } from '../../jobs/types.ts';
import type { RemotionService } from '../../remotion/service.ts';
import type { Ffmpeg } from '../../tools/ffmpeg.ts';
import { decodePngRgba } from '../stream/png.ts';
import { drawsIn3d, onLargerCanvas, onlyClips } from './frames.ts';
import { alphaBounds, type Bounds, grownBox, touchesEdge, unionBounds } from './trim.ts';
import { StoredZipWriter, ZipTooLargeError } from './zip-writer.ts';

/** A frame range on the Remotion path, ready to draw. */
export type DeliveryFrames = {
	/** `{doc, options}`: signed media, the range as the document's range. */
	doc: RenderSnapshot;
	/** The display rendition's `lut3d` filter when the working space is not shown as it is, else null. */
	displayLut: string | null;
	/**
	 * The export planner's warnings for the range (AGENTS §4: what the render path changes is said, never dropped); every
	 * delivery returns them with its own. The planner's blockers refuse the job before this exists.
	 */
	warnings: { code: string; message: string }[];
};

export type DeliveryDeps = {
	frames(
		ctx: JobContext,
		envelope: unknown,
		sequenceId: string,
		range: { start: number; end: number },
	): Promise<DeliveryFrames>;
	remotion: RemotionService;
	ff: Ffmpeg;
	outDir(ctx: JobContext): Promise<string>;
	copyOut(src: string, dest: string, ctx: JobContext): Promise<string>;
	concurrency(ctx: JobContext): number;
};

/** Largest canvas side: Chrome's and most compositors' texture limit. */
const MAX_CANVAS_SIDE = 16384;

export const renderOptions = (transparentBackground: boolean) => ({
	isPreview: false,
	useProxies: false,
	transparentBackground,
});

/** First canvas pad of Export Title: a quarter of the frame's long side per edge (as Pachislop's probe canvas). */
export function canvasPads(w: number, h: number): number[] {
	const first = Math.round(Math.max(w, h) / 4);
	const fits = (pad: number) => Math.max(w, h) + 2 * pad <= MAX_CANVAS_SIDE;
	return [first, first * 2].filter(fits);
}

/**
 * The canvases Export Title tries, smallest first; the last one is kept even when the title still reaches its edge. A
 * frame no pad fits (long side over 10 922 px) and a 3D scene (drawn through the frame) render on the frame alone.
 */
export function padLadder(w: number, h: number, in3d: boolean): number[] {
	const pads = in3d ? [] : canvasPads(w, h);
	return pads.length ? pads : [0];
}

/** Renders `doc` as `dir/000000.png…`, straight alpha, in document frame order. */
async function renderFrames(
	ctx: JobContext,
	d: DeliveryDeps,
	doc: RenderSnapshot,
	dir: string,
	total: number,
): Promise<void> {
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	await d.remotion.renderStillSheet({
		inputProps: { doc, options: renderOptions(true) },
		outputDir: dir,
		signal: ctx.signal,
		concurrency: d.concurrency(ctx),
		log: ctx.log,
		onProgress: (p) =>
			ctx.progress((0.8 * p.renderedFrames) / p.totalFrames, {
				stage: `Rendering ${p.renderedFrames}/${p.totalFrames} frames`,
			}),
	});
	const files = (await readdir(dir))
		.filter((f) => /^\d+\.png$/.test(f))
		.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
	if (files.length !== total)
		throw new JobError('FRAME_COUNT_MISMATCH', `Rendered ${files.length} frames, expected ${total}`, true, {
			expected: total,
			actual: files.length,
		});
	for (const [i, f] of files.entries()) await rename(join(dir, f), join(dir, `${pad6(i)}.tmp`));
	for (let i = 0; i < files.length; i++)
		await rename(join(dir, `${pad6(i)}.tmp`), join(dir, `${pad6(i)}.png`));
}

const pad6 = (i: number) => String(i).padStart(6, '0');

/** The union over every frame of what it paints. */
async function measure(
	ctx: JobContext,
	dir: string,
	total: number,
	w: number,
	h: number,
): Promise<Bounds | null> {
	let all: Bounds | null = null;
	for (let i = 0; i < total; i++) {
		ctx.signal.throwIfAborted();
		const rgba = await decodePngRgba(await readFile(join(dir, `${pad6(i)}.png`)), w, h);
		if (!rgba)
			throw new JobError('RENDER_FAILED', 'A rendered frame is not an 8-bit PNG of the canvas size', true);
		all = unionBounds(all, alphaBounds(rgba, w, h));
		if ((i & 15) === 0)
			ctx.progress(0.8 + (0.1 * i) / total, { stage: `Measuring ${i + 1}/${total} frames` });
	}
	return all;
}

/** ffmpeg arguments that apply `filters` to a numbered sequence, keeping straight alpha. */
export function frameFilterArgs(from: string, to: string, filters: readonly string[]): string[] {
	return [
		'-f',
		'image2',
		'-framerate',
		'25',
		'-start_number',
		'0',
		'-i',
		join(from, '%06d.png'),
		'-vf',
		['format=rgba', ...filters].join(','),
		'-c:v',
		'png',
		'-pix_fmt',
		'rgba',
		'-start_number',
		'0',
		'-f',
		'image2',
		join(to, '%06d.png'),
	];
}

async function filterFrames(
	ctx: JobContext,
	d: DeliveryDeps,
	from: string,
	to: string,
	filters: string[],
): Promise<void> {
	await mkdir(to, { recursive: true });
	await d.ff.run(frameFilterArgs(from, to, filters), { signal: ctx.signal, onSpawn: ctx.trackChild });
}

/** `alpha-delivery` job. */
export async function runAlphaDelivery(
	ctx: JobContext,
	req: AlphaDeliveryRequest,
	d: DeliveryDeps,
): Promise<AlphaDeliveryResult> {
	const {
		doc: full,
		displayLut,
		warnings: planned,
	} = await d.frames(ctx, req.envelope, req.sequenceId, req.range);
	const warnings: AlphaDeliveryResult['warnings'] = [...planned];
	const doc = req.clipIds ? onlyClips(full, new Set(req.clipIds)) : full;
	if (
		!doc.videoTracks.some((t) =>
			t.clips.some((c) => c.start < req.range.end && c.start + c.duration > req.range.start),
		)
	)
		throw new JobError(
			'NOTHING_TO_EXPORT',
			'No clip of the selection is on the timeline in this range',
			false,
		);
	const scratch = await ctx.scratchDir();
	const total = req.range.end - req.range.start;
	const seqW = doc.settings.width;
	const seqH = doc.settings.height;

	let pad = 0;
	let dir = join(scratch, 'frames');
	let crop: Bounds | null = null;
	if (req.trim) {
		const in3d = drawsIn3d(doc);
		if (in3d)
			warnings.push({
				code: 'TRIM_AT_FRAME',
				message: 'A 3D scene is drawn through the sequence frame: it is trimmed inside the frame',
			});
		const pads = padLadder(seqW, seqH, in3d);
		let bounds: Bounds | null = null;
		for (const [i, p] of pads.entries()) {
			pad = p;
			dir = join(scratch, `frames-${p}`);
			await renderFrames(ctx, d, onLargerCanvas(doc, p), dir, total);
			bounds = await measure(ctx, dir, total, seqW + 2 * p, seqH + 2 * p);
			if (!bounds)
				throw new JobError('NOTHING_TO_EXPORT', 'The selection paints nothing in this range', false);
			if (!touchesEdge(bounds, seqW + 2 * p, seqH + 2 * p)) break;
			if (i === pads.length - 1 || !p)
				warnings.push({
					code: 'TITLE_CLIPPED_AT_CANVAS',
					message: p
						? `The title still reaches the edge of a canvas ${p} px larger than the frame on each side: it may be cut there`
						: 'The title reaches the frame edge and could not be rendered past it',
				});
			else await rm(dir, { recursive: true, force: true });
		}
		crop = grownBox(bounds!, req.trim.marginPx, seqW + 2 * pad, seqH + 2 * pad);
	} else await renderFrames(ctx, d, doc, dir, total);

	const width = crop ? crop.x1 - crop.x0 : seqW;
	const height = crop ? crop.y1 - crop.y0 : seqH;
	const origin = crop ? { x: crop.x0 - pad, y: crop.y0 - pad } : { x: 0, y: 0 };
	const filters = [
		...(displayLut ? [displayLut] : []),
		...(crop ? [`crop=${width}:${height}:${crop.x0}:${crop.y0}`] : []),
	];
	let finished = dir;
	if (filters.length) {
		ctx.progress(0.9, { stage: 'Writing frames' });
		finished = join(scratch, 'final');
		await filterFrames(ctx, d, dir, finished, filters);
	}

	const out = await d.outDir(ctx);
	ctx.addPartial(out);
	const name = req.destination?.name ?? 'frame';
	let path: string | undefined;
	if (total === 1) {
		const dest = join(out, 'output.png');
		await rename(join(finished, `${pad6(0)}.png`), dest);
		if (req.destination) path = await d.copyOut(dest, join(req.destination.folder, `${name}.png`), ctx);
	} else {
		const zip = await StoredZipWriter.create(join(out, 'output.zip'));
		try {
			for (let i = 0; i < total; i++) {
				await zip.add(`${name}_${pad6(i)}.png`, join(finished, `${pad6(i)}.png`), ctx.signal);
				if ((i & 15) === 0) ctx.progress(0.92 + (0.06 * i) / total, { stage: 'Packing frames' });
			}
			await zip.finish();
		} catch (e) {
			await zip.abort();
			if (e instanceof ZipTooLargeError && !req.destination)
				throw new JobError('ZIP_TOO_LARGE', e.message, false);
			if (!(e instanceof ZipTooLargeError)) throw e;
			warnings.push({ code: 'ZIP_TOO_LARGE', message: e.message });
		}
		if (req.destination) {
			const folder = await uniqueFolder(req.destination.folder, name);
			ctx.addPartial(folder);
			for (let i = 0; i < total; i++)
				await d.copyOut(join(finished, `${pad6(i)}.png`), join(folder, `${name}_${pad6(i)}.png`), ctx);
			path = folder;
		}
	}
	return {
		url: `/renders/${ctx.job.id}/output`,
		format: total === 1 ? 'png' : 'zip',
		frames: total,
		width,
		height,
		origin,
		...(path ? { path } : {}),
		warnings,
	};
}

/** `<parent>/<name>`, or `<name> (2)`…: a new, empty folder (nothing is overwritten). */
async function uniqueFolder(parent: string, name: string): Promise<string> {
	await mkdir(parent, { recursive: true });
	for (let i = 1; ; i++) {
		const candidate = join(parent, i === 1 ? name : `${name} (${i})`);
		try {
			await mkdir(candidate);
			return candidate;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
		}
	}
}
