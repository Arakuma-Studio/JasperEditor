// The `layers` job reads a registered PSD/PSB, writes every
// pixel layer as a PNG (masks applied) under `<media>/layers/<fingerprint>/` and registers each as media. The client
// turns the tree into project items (individual layers, a sequence with the layers stacked, or merged layers).
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineJob, LayeredExtractResult, LayeredLayer, RegisteredMedia } from '@jasper/api';
import type { JobQueue } from '../jobs/queue.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import { fingerprintHex } from '../media/fingerprint.ts';
import type { MediaRegistry } from '../media/registry.ts';
import type { MediaService } from '../media/service.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { writeRgbaPng } from './png.ts';
import {
	type ExtractedLayer,
	extractPsdLayers,
	psdCompositeSubset,
	psdLayeredInfo,
	readPsdFile,
} from './psd.ts';

/** Bump to re-extract cached layers. */
const EXTRACT_VERSION = 1;

type JobInput = { mediaKey: string; projectId?: string; merge?: number[] };

export class LayeredService {
	constructor(
		private readonly deps: {
			mediaDir: string;
			ff: Ffmpeg;
			queue: JobQueue;
			registry: MediaRegistry;
			media: MediaService;
		},
	) {}

	registerRunners(): void {
		this.deps.queue.registerRunner('layers', (ctx) => this.run(ctx));
	}

	submit(mediaKey: string, projectId?: string, merge?: number[]): EngineJob {
		const r = this.deps.registry.get(mediaKey);
		if (!r) throw new JobError('ASSET_NOT_FOUND', 'Unknown media key', false);
		if (!r.layered) throw new JobError('BAD_REQUEST', `${r.originalName} is not a layered document`, false);
		return this.deps.queue.submit({
			kind: 'layers',
			title: `Layers – ${r.originalName}`,
			priority: 'user',
			cpuSlots: 2,
			origin: { type: 'user' },
			assetId: mediaKey,
			...(projectId ? { projectId } : {}),
			dedupeKey: `layers:${fingerprintHex(r.fingerprint)}${merge ? `:${[...merge].sort((a, b) => a - b).join(',')}` : ''}`,
			input: {
				mediaKey,
				...(projectId ? { projectId } : {}),
				...(merge ? { merge } : {}),
			} satisfies JobInput,
		});
	}

	private async run(ctx: JobContext): Promise<LayeredExtractResult> {
		const input = ctx.input as JobInput;
		const r = this.deps.registry.get(input.mediaKey);
		if (!r) throw new JobError('ASSET_NOT_FOUND', 'Unknown media key', false);
		const src = await this.deps.registry.resolvePath(r.mediaKey);
		if (!src) throw new JobError('ASSET_NOT_FOUND', `${r.originalName} is offline`, true);
		ctx.progress(0, { stage: 'Reading the document' });
		const psd = await readPsdFile(src, { images: true });
		const dir = join(this.deps.mediaDir, 'layers', `${fingerprintHex(r.fingerprint)}-v${EXTRACT_VERSION}`);
		// A previous, interrupted extraction leaves partial files: start clean unless complete.
		const done = join(dir, '.complete');
		const complete = (await stat(done).catch(() => null))?.isFile();
		if (!complete) {
			await rm(dir, { recursive: true, force: true });
			await mkdir(dir, { recursive: true });
		}
		ctx.progress(0.05, { stage: 'Extracting layers' });
		const { layers, warnings } = await extractPsdLayers(this.deps.ff, psd, dir, {
			signal: ctx.signal,
			onLayer: (d, t) => ctx.progress(Math.min(0.9, (0.9 * d) / Math.max(1, t))),
		});
		if (!complete) await writeFile(done, '');
		ctx.progress(0.9, { stage: 'Registering layers' });
		const docName = r.originalName.replace(/\.(psd|psb)$/i, '');
		const register = async (l: ExtractedLayer): Promise<LayeredLayer> => {
			const { png, children, ...rest } = l;
			const media = png
				? await this.deps.media.registerProduced(png, {
						name: `${docName} – ${l.name}.png`,
						...(input.projectId ? { projectId: input.projectId } : {}),
					})
				: null;
			return {
				...rest,
				media,
				...(children ? { children: await Promise.all(children.map(register)) } : {}),
			};
		};
		const out: LayeredLayer[] = [];
		for (const l of layers) out.push(await register(l));
		let merged: RegisteredMedia | undefined;
		if (input.merge?.length) {
			const sel = [...new Set(input.merge)].sort((a, b) => a - b);
			const file = join(dir, `merged-${sel.join('-').slice(0, 120)}.png`);
			await writeRgbaPng(this.deps.ff, psdCompositeSubset(psd, new Set(sel)), file, { signal: ctx.signal });
			merged = await this.deps.media.registerProduced(file, {
				name: `${docName} (merged).png`,
				...(input.projectId ? { projectId: input.projectId } : {}),
			});
		}
		ctx.progress(1);
		return {
			mediaKey: r.mediaKey,
			info: psdLayeredInfo(psd, r.originalName),
			layers: out,
			warnings,
			...(merged ? { merged } : {}),
		};
	}
}
