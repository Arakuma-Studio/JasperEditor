// Spec 19 TL-115: the `split-image` job. Decodes the still to straight RGBA with ffmpeg and encodes each part with ffmpeg's
// PNG encoder, so colours under low alpha are copied byte for byte: no canvas and no premultiplication anywhere. A 16-bit
// picture stays 16-bit. Analysis and cut are one job kind; a cut relabels the same pixels, so the island indices chosen
// from an analysis address the same islands (`labelIslands` is deterministic).
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type EngineJob,
	MAX_SPLIT_PARTS,
	MAX_SPLIT_PIXELS,
	type RegisteredMedia,
	type SplitImageAnalysis,
	type SplitImageRequest,
	type SplitImageResult,
} from '@jasper/api';
import { cutParts, type IslandMap, labelIslands, partsOf, type SplitPicture } from '@jasper/project';
import { type JobContext, JobError } from '../../jobs/types.ts';
import { fingerprintHex } from '../../media/fingerprint.ts';
import { fsyncDir, safeFileName } from '../../tools/fs.ts';
import type { CoreServices } from '../../tools/services.ts';
import { encodePngAsync } from '../synthetic.ts';

/** More islands than this are specks and noise: nobody chooses among them. */
export const MAX_ISLANDS = 20_000;

type Input = { mediaKey: string; groups?: number[][]; projectId?: string };

const DEEP_PIXELS = /(?:9|1[0-6])(?:le|be)$|64(?:le|be)$/;

async function decode(ctx: JobContext, core: CoreServices, file: string): Promise<SplitPicture> {
	const run = { signal: ctx.signal, onSpawn: ctx.trackChild };
	const j = await core.ffmpeg.probeJson(
		['-show_entries', 'stream=width,height,pix_fmt', '-select_streams', 'v:0', file],
		run,
	);
	const s = (j.streams as { width?: number; height?: number; pix_fmt?: string }[] | undefined)?.[0];
	const width = Number(s?.width);
	const height = Number(s?.height);
	if (!(width > 0 && height > 0)) throw new JobError('UNSUPPORTED_MEDIA', 'The picture has no size', false);
	const depth = DEEP_PIXELS.test(s?.pix_fmt ?? '') ? 16 : 8;
	if (width * height > MAX_SPLIT_PIXELS / (depth === 16 ? 2 : 1))
		throw new JobError('SPLIT_TOO_LARGE', `A picture of ${width} × ${height} is too large to split`, false);
	const raw = join(await ctx.scratchDir(), 'picture.raw');
	await core.ffmpeg.run(
		['-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', depth === 16 ? 'rgba64le' : 'rgba', raw],
		run,
	);
	const data = await readFile(raw);
	await rm(raw, { force: true });
	if (data.length < width * height * (depth === 16 ? 8 : 4))
		throw new JobError('UNSUPPORTED_MEDIA', 'The picture decoded to fewer pixels than its size', false);
	return { width, height, depth, data };
}

function labelled(img: SplitPicture): IslandMap {
	const map = labelIslands(img);
	if (!map.islands.length)
		throw new JobError('SPLIT_NO_ISLANDS', 'The image has no opaque pixels to split', false);
	if (map.islands.length > MAX_ISLANDS)
		throw new JobError(
			'SPLIT_TOO_COMPLEX',
			`The picture has ${map.islands.length} separate islands; at most ${MAX_ISLANDS} can be told apart`,
			false,
		);
	return map;
}

/** The label map as an opaque picture: index + 1 in R and G, cell alpha in B (an 8-bit canvas reads it back exactly). */
function labelPixels(map: IslandMap): Uint8Array {
	const px = new Uint8Array(map.cols * map.rows * 4);
	for (let c = 0; c < map.owner.length; c++) {
		const o = map.owner[c]! + 1;
		const a = map.alpha[c]!;
		const i = c * 4;
		px[i] = a ? o & 0xff : 0;
		px[i + 1] = a ? o >> 8 : 0;
		px[i + 2] = a;
		px[i + 3] = 255;
	}
	return px;
}

async function encodePart(
	ctx: JobContext,
	core: CoreServices,
	part: SplitPicture,
	file: string,
): Promise<void> {
	const raw = join(await ctx.scratchDir(), 'part.raw');
	await writeFile(raw, part.data);
	const tmp = `${file}.partial.png`;
	await core.ffmpeg.run(
		[
			'-f',
			'rawvideo',
			'-pix_fmt',
			part.depth === 16 ? 'rgba64le' : 'rgba',
			'-s',
			`${part.width}x${part.height}`,
			'-i',
			raw,
			'-frames:v',
			'1',
			'-c:v',
			'png',
			'-pix_fmt',
			part.depth === 16 ? 'rgba64be' : 'rgba',
			'-f',
			'image2',
			tmp,
		],
		{ signal: ctx.signal, onSpawn: ctx.trackChild },
	);
	const fh = await open(tmp, 'r+');
	try {
		await fh.sync();
	} finally {
		await fh.close();
	}
	await rename(tmp, file);
	await rm(raw, { force: true });
}

export class SplitImageService {
	constructor(private readonly core: CoreServices) {}

	registerRunner(): void {
		this.core.queue.registerRunner('split-image', (ctx) => this.run(ctx));
	}

	private recordOf(key: string) {
		const r = this.core.registry.get(key);
		if (!r) throw new JobError('ASSET_NOT_FOUND', `Unknown media ${key}`, false);
		if (r.kind !== 'image') throw new JobError('UNSUPPORTED_MEDIA', 'Only a still image can be split', false);
		return r;
	}

	async submit(
		key: string,
		req: SplitImageRequest | null,
		origin: EngineJob['origin'] = { type: 'user' },
	): Promise<EngineJob> {
		const r = this.recordOf(key);
		if ((await this.core.registry.availability(key)) !== 'online')
			throw new JobError('MEDIA_OFFLINE', `${r.originalName} is offline; relink it first`, false);
		if (req && req.groups.length > MAX_SPLIT_PARTS)
			throw new JobError('E_LIMIT', `A split makes at most ${MAX_SPLIT_PARTS} parts`, false);
		return this.core.queue.submit({
			kind: 'split-image',
			title: `${req ? 'Split' : 'Find parts of'} ${r.originalName}`,
			priority: 'interactive',
			cpuSlots: 1,
			minSlots: 1,
			origin,
			assetId: key,
			...(req?.projectId ? { projectId: req.projectId } : {}),
			input: {
				mediaKey: key,
				...(req ? { groups: req.groups } : {}),
				...(req?.projectId ? { projectId: req.projectId } : {}),
			} satisfies Input,
		});
	}

	private async run(ctx: JobContext): Promise<SplitImageAnalysis | SplitImageResult> {
		const input = ctx.input as Input;
		const r = this.recordOf(input.mediaKey);
		const file = await this.core.registry.resolvePath(r.mediaKey);
		if (!file) throw new JobError('MEDIA_OFFLINE', `${r.originalName} is offline; relink it first`, false);
		ctx.progress(0, { stage: 'Decoding' });
		const img = await decode(ctx, this.core, file);
		ctx.signal.throwIfAborted();
		ctx.progress(0.3, { stage: 'Finding the parts' });
		const map = labelled(img);
		if (!input.groups) return this.analysis(ctx, img, map);
		return this.cut(ctx, r, input, img, map);
	}

	private async analysis(ctx: JobContext, img: SplitPicture, map: IslandMap): Promise<SplitImageAnalysis> {
		const dir = join(this.core.config.paths.rendersDir, ctx.job.id);
		await mkdir(dir, { recursive: true });
		ctx.addPartial(dir);
		await writeFile(join(dir, 'output.png'), await encodePngAsync(labelPixels(map), map.cols, map.rows));
		return {
			width: img.width,
			height: img.height,
			cell: map.cell,
			cols: map.cols,
			rows: map.rows,
			bitDepth: img.depth,
			islands: map.islands,
			labelMapUrl: `/renders/${ctx.job.id}/output`,
		};
	}

	private async cut(
		ctx: JobContext,
		r: { mediaKey: string; fingerprint: string; originalName: string },
		input: Input,
		img: SplitPicture,
		map: IslandMap,
	): Promise<SplitImageResult> {
		const groups = input.groups!;
		const known = map.islands.length;
		const seen = new Set<number>();
		for (const g of groups)
			for (const i of g) {
				if (i >= known) throw new JobError('E_INVALID_PARAM', `The picture has no island ${i}`, false);
				if (seen.has(i)) throw new JobError('E_INVALID_PARAM', `Island ${i} is in two parts`, false);
				seen.add(i);
			}
		// Islands nobody chose stay with their nearest part? No: a split keeps every visible pixel, so the rest joins the first.
		const rest = map.islands.map((_, i) => i).filter((i) => !seen.has(i));
		const full = rest.length ? groups.map((g, i) => (i === 0 ? [...g, ...rest] : g)) : groups;
		const parts = partsOf(map.islands, full);
		const cut = cutParts(img, map, parts);
		const hash = createHash('sha256').update(JSON.stringify(full)).digest('hex').slice(0, 16);
		const dir = join(
			this.core.config.paths.mediaDir,
			'processed',
			fingerprintHex(r.fingerprint),
			`split-${hash}`,
		);
		await mkdir(dir, { recursive: true });
		const stem = safeFileName(r.originalName.replace(/\.[^.]+$/, '')) || 'part';
		const out: SplitImageResult['parts'] = [];
		for (const [i, p] of cut.entries()) {
			ctx.signal.throwIfAborted();
			ctx.progress(0.4 + (0.5 * i) / cut.length, { stage: `Writing part ${i + 1}/${cut.length}` });
			const file = join(dir, `${stem}.part${String(i + 1).padStart(2, '0')}.png`);
			await encodePart(ctx, this.core, p.pixels, file);
			const media: RegisteredMedia = await this.core.media.registerDerived(file, {
				fromMediaKey: r.mediaKey,
				recipeHash: `${hash}-${i}`,
				name: `${stem} part ${i + 1}.png`,
				...(input.projectId ? { projectId: input.projectId } : {}),
			});
			out.push({
				media,
				box: { x: p.box.x0, y: p.box.y0, w: p.box.x1 - p.box.x0, h: p.box.y1 - p.box.y0 },
			});
		}
		await fsyncDir(dir);
		if (out.length < 2)
			throw new JobError('SPLIT_ONE_PART', 'The choice leaves one part: nothing to split', false);
		return { parts: out };
	}
}
