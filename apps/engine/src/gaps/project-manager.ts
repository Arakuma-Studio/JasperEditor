// File ▸ Project Manager… on the engine (workstream gaps, docs/wp-notes/gaps.md §PRJ-6): one `project-manager` job
// that writes a self-contained copy of a project into a folder — the media it uses (whole files, or for Consolidate
// and Transcode only the used part plus handles, ProRes 422 HQ / browser-playable video or 24-bit WAV sound), their
// proxies and render previews when asked — then the project itself, `<folder>/<name>.jasper`, pointing at the copies,
// and registers it as a new engine project (it appears on Home). Files are written as `*.partial` and renamed; a
// cancelled or failed job deletes everything it wrote. Consolidated video is ProRes 422 HQ with 24-bit PCM sound
// (Premiere's default consolidation format family); sound-only media 24-bit WAV. The plan route estimates the disk space (Premiere's
// "Calculate"). Offline media are reported and left as they are in the copy (relink them there).
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import type {
	EngineJob,
	ProjectManagerOptions,
	ProjectManagerRequest,
	ProjectManagerResult,
} from '@jasper/api';
import {
	applyTransaction,
	audioPreviewSegments,
	createRandomIdSource,
	defaultRegistries,
	loadProject,
	makeEnvelope,
	type ProjectDocument,
	type ProjectManagerOutput,
	planProjectManager,
	previewSegments,
	previewSettingsOf,
	projectManagerCommands,
	proxyKeyOf,
} from '@jasper/project';
import { isLoopbackHost } from '../context.ts';
import { mediaKeyOf } from '../export/planner.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import { previewContainer, previewFormatKey } from '../previews/service.ts';
import { exists, freeDiskBytes } from '../tools/fs.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';
import { uniquePath } from './media-jobs.ts';

const safeName = (n: string) =>
	n
		.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
		.trim()
		.slice(0, 120) || 'Project';

export class ProjectManagerService {
	constructor(private readonly core: CoreServices) {}

	registerRunner(): void {
		this.core.queue.registerRunner('project-manager', (ctx) => this.run(ctx));
	}

	private local(): boolean {
		return this.core.config.dev || isLoopbackHost(this.core.config.host);
	}

	private load(req: ProjectManagerRequest): ProjectDocument {
		try {
			return loadProject(req.envelope, {}).document;
		} catch (e) {
			throw new HttpError(400, 'VALIDATION_FAILED', `Invalid project: ${(e as Error).message}`);
		}
	}

	private check(o: ProjectManagerOptions): void {
		if (!this.local())
			throw new HttpError(403, 'LOCAL_MODE_ONLY', 'Project Manager writes to a folder: local engines only');
		if (!isAbsolute(o.destination))
			throw new HttpError(400, 'VALIDATION_FAILED', 'The destination must be an absolute folder');
	}

	/** Premiere's "Calculate": the disk space of the copy, without writing anything. */
	async estimate(req: ProjectManagerRequest) {
		this.check(req.options);
		const doc = this.load(req);
		const plan = planProjectManager(doc, {
			mode: req.options.mode,
			excludeUnused: req.options.excludeUnused,
			handlesFrames: req.options.handlesFrames,
			...(req.options.sequenceIds ? { sequenceIds: req.options.sequenceIds } : {}),
		});
		const files = [];
		let originalBytes = 0;
		let resultBytes = 0;
		for (const f of plan.files) {
			const key = mediaKeyOf(doc.media[f.mediaId]!);
			const online = key ? await this.core.registry.resolvePath(key) : null;
			originalBytes += f.sizeBytes;
			resultBytes += online ? f.estimatedBytes : 0;
			files.push({
				mediaId: f.mediaId,
				name: f.name,
				action: online ? f.action : ('offline' as const),
				sizeBytes: f.sizeBytes,
				estimatedBytes: online ? f.estimatedBytes : 0,
			});
		}
		let probe = req.options.destination;
		let free: number | null = null;
		for (let i = 0; i < 64 && free === null; i++) {
			free = await freeDiskBytes(probe);
			const up = dirname(probe);
			if (up === probe) break;
			probe = up;
		}
		return {
			originalBytes,
			resultBytes,
			files,
			keptSequences: plan.sequences.length,
			droppedSequences: plan.droppedSequences.length,
			droppedItems: plan.droppedItems.length,
			destinationFreeBytes: free,
		};
	}

	async submit(
		req: ProjectManagerRequest,
		origin: EngineJob['origin'] = { type: 'user' },
	): Promise<EngineJob> {
		this.check(req.options);
		const doc = this.load(req);
		if (!Object.keys(doc.sequences).length)
			throw new HttpError(400, 'VALIDATION_FAILED', 'The project has no sequences');
		for (const id of req.options.sequenceIds ?? [])
			if (!doc.sequences[id]) throw new HttpError(404, 'NOT_FOUND', `Sequence ${id} not found`);
		const name = safeName(req.options.projectName ?? `${doc.name} Copy`);
		if (await exists(join(req.options.destination, `${name}.jasper`)))
			throw new HttpError(
				409,
				'ALREADY_EXISTS',
				`${name}.jasper already exists in ${req.options.destination}`,
			);
		const scratch = join(
			this.core.config.paths.tmpDir,
			`pm-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.json`,
		);
		await mkdir(dirname(scratch), { recursive: true });
		await writeFile(scratch, JSON.stringify(req));
		return this.core.queue.submit({
			kind: 'project-manager',
			title: `Project Manager: ${name}`,
			priority: 'user',
			cpuSlots: Math.max(1, Math.min(4, this.core.queue.totalSlots)),
			minSlots: 1,
			origin,
			...(typeof doc.projectId === 'string' ? { projectId: doc.projectId } : {}),
			input: { request: scratch, name },
		});
	}

	private async run(ctx: JobContext): Promise<ProjectManagerResult> {
		const { request, name } = ctx.input as { request: string; name: string };
		let req: ProjectManagerRequest;
		try {
			req = JSON.parse(await readFile(request, 'utf8')) as ProjectManagerRequest;
		} catch {
			throw new JobError('BAD_REQUEST', 'The Project Manager request is gone', false);
		}
		const o = req.options;
		const doc = loadProject(req.envelope, {}).document;
		const plan = planProjectManager(doc, {
			mode: o.mode,
			excludeUnused: o.excludeUnused,
			handlesFrames: o.handlesFrames,
			...(o.sequenceIds ? { sequenceIds: o.sequenceIds } : {}),
		});
		const dest = o.destination;
		try {
			await mkdir(dest, { recursive: true });
		} catch (e) {
			throw new JobError('DESTINATION_FAILED', `Cannot create ${dest}: ${(e as Error).message}`, false);
		}
		const taken = new Set<string>();
		const outputs: ProjectManagerOutput[] = [];
		const report: ProjectManagerResult['files'] = [];
		const skipped: ProjectManagerResult['skipped'] = [];
		let bytes = 0;
		const total = plan.files.length + 2;
		for (const [i, f] of plan.files.entries()) {
			ctx.signal.throwIfAborted();
			ctx.progress(i / total, { stage: `${f.name} (${i + 1} of ${plan.files.length})` });
			const asset = doc.media[f.mediaId]!;
			const key = mediaKeyOf(asset);
			const src = key ? await this.core.registry.resolvePath(key) : null;
			if (!key || !src) {
				skipped.push({ mediaId: f.mediaId, reason: `${f.name} is offline: it stays offline in the copy` });
				report.push({ mediaId: f.mediaId, from: null, to: null, action: 'offline' });
				continue;
			}
			const stem = basename(asset.originalName, extname(asset.originalName)) || 'media';
			const isVideo = asset.kind === 'video';
			const audioStreams = asset.probe.streams.filter((s) => s.type === 'audio').length;
			const ext =
				f.action === 'trim'
					? isVideo || audioStreams > 1
						? '.mov'
						: '.wav'
					: extname(src) || extname(asset.originalName);
			const out = await uniquePath(dest, stem, '', ext, taken);
			const partial = `${out}.partial${ext}`;
			ctx.addPartial(partial);
			ctx.addPartial(out);
			let streamMap: Record<number, number> | undefined;
			if (f.action === 'copy') await copyFile(src, partial);
			else streamMap = await this.trim(asset, src, partial, f.firstFrame, f.frames, f.rate, isVideo, ctx);
			await rename(partial, out);
			bytes += (await stat(out)).size;
			const reg = await this.core.media.registerPath(out, {});
			let proxy: ProjectManagerOutput['proxy'] = null;
			const pk = proxyKeyOf(asset);
			if (o.includeProxies && f.action === 'copy' && pk) {
				const psrc = await this.core.registry.resolvePath(pk);
				if (psrc) {
					await mkdir(join(dest, 'Proxies'), { recursive: true });
					const pout = await uniquePath(
						join(dest, 'Proxies'),
						basename(psrc, extname(psrc)),
						'',
						extname(psrc),
						taken,
					);
					ctx.addPartial(pout);
					await copyFile(psrc, pout);
					bytes += (await stat(pout)).size;
					const preg = await this.core.media.registerPath(pout, {});
					proxy = { path: pout, registered: preg as never };
				}
			}
			outputs.push({
				mediaId: f.mediaId,
				path: out,
				registered: reg as never,
				...(streamMap ? { streamMap } : {}),
				proxy,
			});
			report.push({ mediaId: f.mediaId, from: src, to: out, action: f.action });
		}
		// Render previews of the kept sequences.
		let previews = 0;
		if (o.includePreviews) {
			ctx.progress((total - 2) / total, { stage: 'Render files' });
			const root = join(this.core.config.paths.cacheDir, 'previews');
			for (const seqId of plan.sequences) {
				const seq = doc.sequences[seqId];
				if (!seq) continue;
				const settings = previewSettingsOf(seq);
				const key = previewFormatKey(settings);
				const container = previewContainer(settings);
				const names = [
					...previewSegments(doc, seqId).map((s) => `${s.hash}.${container}`),
					...audioPreviewSegments(doc, seqId).map((s) => `${s.hash}.wav`),
				];
				let present: Set<string>;
				try {
					present = new Set(await readdir(join(root, key)));
				} catch {
					continue;
				}
				for (const n of names) {
					if (!present.has(n)) continue;
					const to = join(dest, 'Render Files', key, n);
					if (await exists(to)) continue;
					await mkdir(dirname(to), { recursive: true });
					ctx.addPartial(to);
					await copyFile(join(root, key, n), to);
					bytes += (await stat(to)).size;
					previews++;
				}
			}
		}
		// The project copy: unused material dropped, media pointing at the copies.
		ctx.progress((total - 1) / total, { stage: 'Writing the project' });
		const cmds = projectManagerCommands(doc, plan, outputs);
		const ids = createRandomIdSource();
		let next = doc;
		if (cmds.length) {
			const { document, result } = applyTransaction(
				doc,
				{ label: 'Project Manager', origin: 'system', commands: cmds as never[] },
				{ ids, now: () => new Date().toISOString(), revision: 0, registries: defaultRegistries() },
			);
			if (!result.ok)
				throw new JobError(
					'PROJECT_MANAGER_FAILED',
					`The copy could not be built: ${result.errors[0]?.message ?? 'refused'}`,
					false,
					result.errors,
				);
			next = document;
		}
		const projectId = await this.core.projects.create({
			name,
			preset: next.settings.defaultSequencePreset || 'hd-1080p-30',
		});
		const copy = JSON.parse(JSON.stringify(next)) as ProjectDocument;
		copy.projectId = projectId;
		copy.name = name;
		const file = join(dest, `${name}.jasper`);
		const envelope = makeEnvelope(copy, {
			revision: 1,
			savedAt: new Date().toISOString(),
			platform: process.platform,
		});
		const part = `${file}.partial`;
		ctx.addPartial(part);
		await writeFile(part, JSON.stringify(envelope));
		await rename(part, file);
		bytes += (await stat(file)).size;
		const fresh = await this.core.projects.get(projectId);
		await this.core.projects.save(
			projectId,
			{ ...envelope, revision: fresh.revision + 1 } as never,
			fresh.revision,
		);
		await rm(request, { force: true });
		ctx.progress(1, { stage: 'Done' });
		return {
			projectId,
			projectFile: file,
			files: report,
			skipped,
			previews,
			bytes,
			droppedSequences: plan.droppedSequences.length,
			droppedItems: plan.droppedItems.length,
		};
	}

	/** Writes source frames [first, first + frames) of `src` (video: ProRes 422 HQ + PCM; sound: 24-bit WAV). */
	private async trim(
		asset: ProjectDocument['media'][string],
		src: string,
		out: string,
		first: number,
		frames: number,
		rate: { num: number; den: number },
		isVideo: boolean,
		ctx: JobContext,
	): Promise<Record<number, number>> {
		const start = (first * rate.den) / rate.num;
		const dur = (frames * rate.den) / rate.num;
		const audio = asset.probe.streams.filter((s) => s.type === 'audio').map((s) => s.index);
		const streamMap: Record<number, number> = {};
		audio.forEach((idx, i) => {
			streamMap[idx] = (isVideo ? 1 : 0) + i;
		});
		const args = [
			'-ss',
			start.toFixed(6),
			'-noautorotate',
			'-i',
			src,
			...(isVideo ? ['-map', '0:v:0'] : []),
			...audio.flatMap((idx) => ['-map', `0:${idx}`]),
			...(isVideo
				? [
						'-frames:v',
						String(frames),
						'-c:v',
						'prores_ks',
						'-profile:v',
						'3',
						'-vendor',
						'apl0',
						'-pix_fmt',
						'yuv422p10le',
					]
				: ['-t', dur.toFixed(6)]),
			...(audio.length ? ['-c:a', 'pcm_s24le'] : []),
			// Half a frame of slack: the frame count limits the picture, the sound ends with it.
			...(isVideo ? ['-t', (dur + (0.5 * rate.den) / rate.num).toFixed(6)] : []),
			'-f',
			isVideo || audio.length > 1 ? 'mov' : 'wav',
			out,
		];
		await this.core.ffmpeg.run(args, { signal: ctx.signal, onSpawn: ctx.trackChild, nice: 5 });
		return streamMap;
	}
}
