// wp interchange (docs/wp-notes/interchange.md): the engine side of timeline interchange and Link Media.
//
//   import  — reads the document (path or bytes), writes embedded AAF / OMF audio next to the project, registers every
//             file it finds (probe, fingerprint) and returns the `project.importTimeline` fragment with the rest as
//             offline placeholders;
//   export  — a job: pre-renders the clips the format cannot represent (ProRes 4444 with alpha through the export
//             pipeline, one movie per clip), decodes AAF / OMF audio essence with ffmpeg (embedded or separate,
//             handles, mono breakout), writes the document(s) and reports what was not carried;
//   relink  — S04:AS-011: registers a replacement file and compares it with the asset; folder search (job) by name,
//             size, duration, and by fingerprint for files of the same size.
//
// @jasper/interchange is pure (no fs); everything that touches files lives here.
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse as parsePath } from 'node:path';
import type {
	AssetRelinkRequest,
	AssetRelinkResponse,
	EngineJob,
	ExportSettings,
	InterchangeAudioOptions,
	InterchangeExportOptions,
	InterchangeExportRequest,
	InterchangeExportResult,
	InterchangeFormat,
	InterchangeImportRequest,
	InterchangeImportResponse,
	RegisteredMedia,
	RelinkScanRequest,
	RelinkScanResult,
} from '@jasper/api';
import { InterchangeExportRequestSchema, RelinkScanRequestSchema } from '@jasper/api';
import {
	type AudioEssence,
	aiffFile,
	audioNeeds,
	defaultPrerenderMode,
	type ExportOptions,
	formatInfo,
	fromJasper,
	InterchangeError,
	type IProject,
	type PrerenderedClip,
	planPrerender,
	Report,
	readDocument,
	toJasper,
	wavFile,
	writeDocument,
} from '@jasper/interchange';
import { mgRegistry } from '@jasper/mg-templates';
import {
	type Clip,
	flicksPerFrame,
	importedDescriptors,
	loadProject,
	type MediaAsset,
	type MediaLocator,
	type ProjectDocument,
	type Sequence,
} from '@jasper/project';
import { isLoopbackHost } from '../context.ts';
import { mediaKeyOf } from '../export/planner.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import { fingerprintFile } from '../media/fingerprint.ts';
import { sec } from '../tools/ffmpeg.ts';
import { safeFileName } from '../tools/fs.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';

/** Engine identity used in `engine-store` locators (M1 talks to exactly one local engine). */
const LOCAL_ENGINE_ID = 'local';
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TEXT_DOCUMENT_BYTES = 256 * 1024 * 1024;
const FLICKS = 705_600_000;
const SCAN_MAX_FILES = 200_000;
const SCAN_MAX_DEPTH = 32;

type StoredExport = { request: ReturnType<typeof InterchangeExportRequestSchema.parse> };

/** RegisteredMedia → document MediaAsset (an `engine-store` locator plus the file's path locators). */
export function assetFromRegistered(reg: RegisteredMedia, id: string, now: string): MediaAsset {
	const locators: MediaLocator[] = [{ type: 'engine-store', engineId: LOCAL_ENGINE_ID, key: reg.mediaKey }];
	const seen = new Set<string>();
	for (const l of reg.locators)
		if (l.type === 'path' && !seen.has(l.path)) {
			seen.add(l.path);
			locators.push(l);
		}
	return {
		id,
		kind: reg.kind,
		fingerprint: reg.fingerprint,
		originalName: reg.originalName,
		sizeBytes: reg.sizeBytes,
		container: reg.container,
		probe: JSON.parse(JSON.stringify(reg.probe)),
		locators,
		derivation: null,
		importedAt: now,
		...(reg.lut ? { lut: JSON.parse(JSON.stringify(reg.lut)) } : {}),
		...importedDescriptors(reg),
	} as MediaAsset;
}

/**
 * The first of `stem`, `stem (2)`, `stem (3)`… with no document (`<stem>.<ext>`, `<stem>_<suffix>.<ext>`) and no side
 * folder (`<stem> Media`) in `dir` (security review DATA-3: interchange exports used to overwrite both silently).
 */
export async function freeDestinationStem(dir: string, stem: string, ext: string): Promise<string> {
	const names = new Set(await readdir(dir).catch(() => [] as string[]));
	const clean = (s: string) => safeFileName(s, 'Sequence');
	for (let i = 1; ; i++) {
		const s = i === 1 ? stem : `${stem} (${i})`;
		const doc = clean(`${s}.${ext}`).slice(0, -(ext.length + 1));
		const clash =
			names.has(`${s} Media`) ||
			[...names].some((n) => n.endsWith(`.${ext}`) && (n === `${doc}.${ext}` || n.startsWith(`${doc}_`)));
		if (!clash) return s;
	}
}

const EXTENSION: Record<InterchangeFormat, string> = {
	fcp7: 'xml',
	fcpxml: 'fcpxml',
	otio: 'otio',
	edl: 'edl',
	aaf: 'aaf',
	omf: 'omf',
	ale: 'ale',
};

/** What differs between an asset and a candidate file (what the user is asked to confirm). */
export function relinkDiff(asset: MediaAsset, reg: RegisteredMedia): AssetRelinkResponse['diff'] {
	const out: AssetRelinkResponse['diff'] = [];
	const fmtDur = (f: number | null) => (f === null ? 'none' : `${(f / FLICKS).toFixed(2)} s`);
	const v = (p: MediaAsset['probe']) =>
		p.streams.find((s) => s.type === 'video') as
			| { width: number; height: number; frameRate: { num: number; den: number } }
			| undefined;
	const audio = (p: MediaAsset['probe']) =>
		p.streams
			.filter((s) => s.type === 'audio')
			.map((s) => `${(s as { channels: number }).channels} ch`)
			.join(' + ') || 'none';
	if (asset.kind !== reg.kind) out.push({ field: 'kind', was: asset.kind, now: reg.kind });
	const a = asset.probe.durationFlicks;
	const b = reg.probe.durationFlicks;
	const va = v(asset.probe);
	const vb = v(reg.probe as MediaAsset['probe']);
	const frame = va ? (FLICKS * va.frameRate.den) / va.frameRate.num : FLICKS / 100;
	// An imported placeholder knows at least the length its clips use (often only that): a longer file is fine.
	const placeholder = asset.fingerprint.startsWith('pending:interchange:');
	const durationDiffers =
		a !== null && b !== null
			? placeholder
				? b < a - frame
				: Math.abs(a - b) > frame
			: !placeholder && a !== b;
	if (durationDiffers) out.push({ field: 'duration', was: fmtDur(a), now: fmtDur(b) });
	if (va && vb && (va.width !== vb.width || va.height !== vb.height))
		out.push({ field: 'resolution', was: `${va.width}×${va.height}`, now: `${vb.width}×${vb.height}` });
	if (va && vb && va.frameRate.num * vb.frameRate.den !== vb.frameRate.num * va.frameRate.den) {
		const f = (r: { num: number; den: number }) => `${Math.round((r.num / r.den) * 1000) / 1000} fps`;
		out.push({ field: 'frameRate', was: f(va.frameRate), now: f(vb.frameRate) });
	}
	const aa = audio(asset.probe);
	const ab = audio(reg.probe as MediaAsset['probe']);
	if (aa !== ab && asset.probe.streams.some((s) => s.type === 'audio'))
		out.push({ field: 'audio', was: aa, now: ab });
	if (asset.originalName.toLowerCase() !== reg.originalName.toLowerCase())
		out.push({ field: 'name', was: asset.originalName, now: reg.originalName });
	if (asset.sizeBytes > 0 && asset.sizeBytes !== reg.sizeBytes)
		out.push({ field: 'size', was: `${asset.sizeBytes} bytes`, now: `${reg.sizeBytes} bytes` });
	return out;
}

export function relinkMatch(asset: MediaAsset, reg: RegisteredMedia): AssetRelinkResponse['match'] {
	if (asset.fingerprint === reg.fingerprint) return 'fingerprint';
	return asset.fingerprint.startsWith('pending:interchange:') ? 'placeholder' : 'different';
}

/**
 * A different file is relinked only when confirmed; so is a placeholder whose kind differs or whose file is shorter
 * than the document's clips need. A placeholder's resolution and frame rate are often guesses (EDL, ALE): their
 * differences are listed but do not block.
 */
export function relinkNeedsConfirm(
	match: AssetRelinkResponse['match'],
	diff: AssetRelinkResponse['diff'],
): boolean {
	if (match === 'fingerprint') return false;
	if (match === 'different') return true;
	return diff.some((d) => d.field === 'kind' || d.field === 'duration');
}

const nameKey = (name: string, ignoreExt: boolean) =>
	(ignoreExt ? parsePath(name).name : name).normalize('NFC').toLowerCase();

export class InterchangeService {
	constructor(private readonly core: CoreServices) {}

	registerRunners(): void {
		this.core.queue.registerRunner('interchange-export', (ctx) => this.runExport(ctx));
		this.core.queue.registerRunner('relink-scan', (ctx) => this.runScan(ctx));
	}

	private get local(): boolean {
		return this.core.config.dev || isLoopbackHost(this.core.config.host);
	}

	private requireLocal(what: string): void {
		if (!this.local) throw new HttpError(403, 'LOCAL_MODE_ONLY', `${what} is only available in local mode`);
	}

	async importDocument(req: InterchangeImportRequest): Promise<InterchangeImportResponse> {
		let bytes: Uint8Array;
		let fileName: string;
		let baseDir: string | null = req.baseDir ?? null;
		if (req.path) {
			this.requireLocal('Reading files by path');
			if (!isAbsolute(req.path)) throw new HttpError(400, 'VALIDATION_FAILED', 'The path must be absolute');
			const info = await stat(req.path).catch(() => null);
			if (!info?.isFile()) throw new HttpError(404, 'NOT_FOUND', 'No such file');
			if (info.size > MAX_DOCUMENT_BYTES)
				throw new HttpError(413, 'TOO_LARGE', 'The document is larger than 2 GB');
			bytes = new Uint8Array(await readFile(req.path));
			fileName = basename(req.path);
			baseDir ??= dirname(req.path);
		} else {
			const f = req.file!;
			if (f.contentBase64.length > (MAX_TEXT_DOCUMENT_BYTES * 4) / 3 + 4)
				throw new HttpError(413, 'TOO_LARGE', 'Upload documents larger than 256 MB by path');
			bytes = new Uint8Array(Buffer.from(f.contentBase64, 'base64'));
			fileName = f.name;
		}
		let read: ReturnType<typeof readDocument>;
		try {
			read = readDocument(bytes, {
				fileName,
				...(req.format ? { format: req.format } : {}),
				...(baseDir ? { baseDir } : {}),
				...(req.rate ? { rate: req.rate } : {}),
				...(req.dropFrame !== undefined ? { dropFrame: req.dropFrame } : {}),
			});
		} catch (e) {
			if (e instanceof InterchangeError)
				throw new HttpError(e.code === 'UNSUPPORTED' ? 415 : 422, `INTERCHANGE_${e.code}`, e.message);
			throw e;
		}
		const { project, report, format } = read;
		const now = new Date().toISOString();
		const extracted = await this.writeEmbedded(project, req.projectId, fileName);
		const assets: Record<string, MediaAsset> = {};
		const notFound = new Set<string>();
		const files = Object.values(project.media).filter((m) => m.path && !m.generator);
		let next = 0;
		const worker = async () => {
			for (let i = next++; i < files.length; i = next++) {
				const m = files[i]!;
				const p = m.path!;
				if (!isAbsolute(p) || !this.local) {
					notFound.add(m.id);
					continue;
				}
				try {
					const reg = await this.core.media.registerPath(p, { projectId: req.projectId });
					assets[m.id] = assetFromRegistered(reg, `med_${m.id}`, now);
				} catch {
					notFound.add(m.id);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
		const fragment = toJasper(project, { assets, notFound, now }, report);
		return {
			format,
			fragment: fragment as unknown as Record<string, unknown>,
			missing: fragment.missing,
			warnings: report.entries,
			extracted,
		};
	}

	/** Embedded AAF / OMF audio → WAV files under the project's folder (`Imported Audio/<document>/`). */
	private async writeEmbedded(
		project: IProject,
		projectId: string,
		docName: string,
	): Promise<InterchangeImportResponse['extracted']> {
		const embedded = Object.values(project.media).filter((m) => m.embedded);
		if (!embedded.length) return [];
		const dir = join(
			this.core.config.paths.projectDir(safeFileName(projectId, 'project')),
			'Imported Audio',
			safeFileName(parsePath(docName).name, 'Timeline'),
		);
		await mkdir(dir, { recursive: true });
		const out: InterchangeImportResponse['extracted'] = [];
		for (const m of embedded) {
			const name = safeFileName(m.embedded!.fileName, 'audio.wav');
			const path = join(dir, name);
			await writeFile(path, m.embedded!.bytes);
			m.path = path;
			m.offline = false;
			delete m.embedded;
			out.push({ name, path });
		}
		return out;
	}

	private load(envelope: { document: unknown }): ProjectDocument {
		try {
			return loadProject(envelope, { mgTemplates: mgRegistry }).document;
		} catch (e) {
			throw new HttpError(400, 'VALIDATION_FAILED', `Invalid project: ${(e as Error).message}`);
		}
	}

	prerenderPlan(req: {
		envelope: { document: unknown };
		sequenceId: string;
		format: InterchangeFormat;
		prerender?: 'unsupported' | 'all' | 'none';
	}) {
		const doc = this.load(req.envelope);
		if (!doc.sequences[req.sequenceId])
			throw new HttpError(404, 'NOT_FOUND', `Sequence ${req.sequenceId} not found`);
		const mode = req.prerender ?? defaultPrerenderMode(req.format);
		return { mode, clips: planPrerender(doc, req.sequenceId, req.format, mode) };
	}

	async startExport(
		raw: InterchangeExportRequest,
		origin: EngineJob['origin'] = { type: 'user' },
	): Promise<EngineJob> {
		const req = InterchangeExportRequestSchema.parse(raw);
		if (req.destination.type === 'path') {
			this.requireLocal('Export to a path');
			if (!isAbsolute(req.destination.path))
				throw new HttpError(400, 'VALIDATION_FAILED', 'The destination must be an absolute file path');
		}
		const doc = this.load(req.envelope);
		const seq = doc.sequences[req.sequenceId];
		if (!seq) throw new HttpError(404, 'NOT_FOUND', `Sequence ${req.sequenceId} not found`);
		const name = Object.values(doc.items).find(
			(i) => i.kind === 'sequence' && (i as { sequenceId: string }).sequenceId === req.sequenceId,
		)?.name;
		const dir = join(this.core.config.paths.rendersDir, '.requests');
		await mkdir(dir, { recursive: true });
		const file = join(dir, `interchange-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
		await writeFile(file, JSON.stringify({ request: req } satisfies StoredExport));
		return this.core.queue.submit({
			kind: 'interchange-export',
			title: `Export ${formatInfo(req.format).name} – ${name ?? 'Sequence'}`,
			priority: 'user',
			// I/O and orchestration only: pre-renders are export jobs with their own slots.
			cpuSlots: 0,
			origin,
			projectId: doc.projectId,
			input: { request: file },
			stage: 'Queued',
		});
	}

	/** A file of a finished interchange export (`/renders/:jobId/interchange/:name`). */
	async outputFile(jobId: string, name: string): Promise<string | null> {
		if (!/^[A-Za-z0-9_-]+$/.test(jobId) || name !== safeFileName(name) || name.includes('/')) return null;
		const job = this.core.queue.get(jobId);
		if (job?.kind !== 'interchange-export' || job.state !== 'succeeded') return null;
		const file = join(this.core.config.paths.renderDir(jobId), 'interchange', name);
		return (await stat(file).catch(() => null))?.isFile() ? file : null;
	}

	private async runExport(ctx: JobContext): Promise<InterchangeExportResult> {
		const stored = JSON.parse(
			await readFile((ctx.input as { request: string }).request, 'utf8'),
		) as StoredExport;
		const req = stored.request;
		const opts: InterchangeExportOptions = req.options;
		const doc = this.load(req.envelope);
		const seq = doc.sequences[req.sequenceId] as Sequence | undefined;
		if (!seq) throw new JobError('NOT_FOUND', `Sequence ${req.sequenceId} not found`, false);
		const info = formatInfo(req.format);
		const outDir = join(this.core.config.paths.renderDir(ctx.job.id), 'interchange');
		await mkdir(outDir, { recursive: true });
		ctx.addPartial(outDir);
		const destPath = req.destination.type === 'path' ? req.destination.path : null;
		// Never overwrite (like media exports, copyNoOverwrite): a name whose document or side folder exists gets " (2)"….
		const docStem = destPath
			? await freeDestinationStem(dirname(destPath), parsePath(destPath).name, EXTENSION[req.format])
			: safeFileName(opts.name ?? this.sequenceName(doc, req.sequenceId) ?? 'Sequence', 'Sequence');
		/** Where referenced side files (pre-renders, audio) end up: next to the document, else in the job folder. */
		const sideDir = destPath ? join(dirname(destPath), `${docStem} Media`) : outDir;
		const files: InterchangeExportResult['files'] = [];
		const addFile = async (name: string, role: 'document' | 'audio' | 'prerender', bytes?: Uint8Array) => {
			const local = join(outDir, name);
			if (bytes) await writeFile(local, bytes);
			const size = (await stat(local)).size;
			files.push({
				name,
				role,
				byteSize: size,
				downloadUrl: `/renders/${ctx.job.id}/interchange/${encodeURIComponent(name)}`,
				...(destPath
					? { path: role === 'document' ? join(dirname(destPath), name) : join(sideDir, name) }
					: {}),
			});
		};

		const mode = opts.prerender ?? defaultPrerenderMode(req.format);
		const jobs = planPrerender(doc, req.sequenceId, req.format, mode);
		const report = new Report();
		const prerendered: Record<string, PrerenderedClip> = {};
		const done: InterchangeExportResult['prerendered'] = [];
		for (const [i, j] of jobs.entries()) {
			ctx.progress((0.7 * i) / Math.max(1, jobs.length), {
				stage: `Pre-rendering ${i + 1}/${jobs.length}: ${j.clipName || j.clipId}`,
			});
			try {
				const r = await this.prerenderClip(req.envelope, doc, j.sequenceId, j.clipId, ctx);
				const name = safeFileName(`${j.clipName || 'Clip'} ${j.clipId}.mov`, `${j.clipId}.mov`);
				await copyFile(r.file, join(outDir, name));
				await addFile(name, 'prerender');
				const s = doc.sequences[j.sequenceId]!;
				prerendered[j.clipId] = {
					path: destPath ? join(sideDir, name) : join(outDir, name),
					width: s.settings.width,
					height: s.settings.height,
					rate: s.settings.frameRate,
					durationFlicks: j.durationFrames * flicksPerFrame(s.settings.frameRate),
					sizeBytes: (await stat(r.file)).size,
				};
				done.push({ clipId: j.clipId, clipName: j.clipName, reason: j.reason });
			} catch (e) {
				if (ctx.signal.aborted) throw e;
				report.warn(`pre-rendering ${j.reason} "${j.clipName}" failed: ${(e as Error).message}`, {
					subject: { kind: 'clip', id: j.clipId, name: j.clipName, frame: j.startFrame },
					instead: 'the clip as the format carries it (see the other entries)',
				});
			}
		}

		ctx.progress(0.75, { stage: `Writing ${info.name}` });
		const paths = await this.mediaPaths(doc);
		const ir = fromJasper(
			doc,
			req.sequenceId,
			{ format: req.format, prerendered, mediaPath: (a) => paths.get(a.id) ?? pathLocator(a) },
			report,
		);
		const exportOpts: ExportOptions & { perTrack?: boolean } = {
			...(opts.name ? { name: opts.name } : {}),
			...(opts.xmemlVersion ? { xmemlVersion: opts.xmemlVersion } : {}),
			...(opts.fcpxmlVersion ? { fcpxmlVersion: opts.fcpxmlVersion } : {}),
			...(opts.relativePaths && destPath ? { relativeTo: dirname(destPath) } : {}),
			...(opts.aafSmallSectors ? { aafSmallSectors: true } : {}),
			...(opts.ale ? { ale: opts.ale } : {}),
			...(opts.edl
				? {
						edl: {
							...(opts.edl.videoTrack !== undefined ? { videoTrack: opts.edl.videoTrack } : {}),
							...(opts.edl.audioTracks ? { audioTracks: opts.edl.audioTracks } : {}),
							...(opts.edl.reelMode ? { reelMode: opts.edl.reelMode } : {}),
							...(opts.edl.reelLength ? { reelLength: opts.edl.reelLength } : {}),
							...(opts.edl.clipNames !== undefined ? { clipNames: opts.edl.clipNames } : {}),
							...(opts.edl.sourceFiles !== undefined ? { sourceFiles: opts.edl.sourceFiles } : {}),
							...(opts.edl.effectNames !== undefined ? { effectNames: opts.edl.effectNames } : {}),
							...(opts.edl.markers !== undefined ? { markers: opts.edl.markers } : {}),
						},
						perTrack: !!opts.edl.perTrack,
					}
				: {}),
		};
		if (req.format === 'aaf' || req.format === 'omf') {
			const audio = opts.audio ?? {
				mode: 'link',
				handlesFrames: 0,
				breakoutToMono: false,
				bitDepth: 24,
				fileFormat: 'wav',
			};
			exportOpts.media = {
				breakoutToMono: audio.breakoutToMono,
				essence:
					audio.mode === 'link'
						? []
						: await this.essence(ir, doc, req.sequenceId, audio as InterchangeAudioOptions, {
								ctx,
								outDir,
								sideDir,
								stem: docStem,
								addFile,
							}),
			};
		}
		let written: ReturnType<typeof writeDocument>;
		try {
			written = writeDocument(ir, req.sequenceId, req.format, exportOpts);
		} catch (e) {
			if (e instanceof InterchangeError) throw new JobError(`INTERCHANGE_${e.code}`, e.message, false);
			throw e;
		}
		report.merge(written.report);
		for (const f of written.files) {
			const name = safeFileName(`${docStem}${f.suffix ? `_${f.suffix}` : ''}.${EXTENSION[req.format]}`);
			await addFile(name, 'document', f.bytes);
		}

		if (destPath) {
			ctx.progress(0.97, { stage: 'Copying to the destination' });
			await mkdir(dirname(destPath), { recursive: true });
			for (const f of files) {
				if (f.role !== 'document') await mkdir(sideDir, { recursive: true });
				try {
					await copyFile(join(outDir, f.name), f.path!, fsConstants.COPYFILE_EXCL);
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code === 'EEXIST')
						throw new JobError(
							'DESTINATION_EXISTS',
							`${f.path} appeared while exporting; nothing was overwritten`,
							true,
						);
					throw e;
				}
			}
		}
		ctx.progress(1, { stage: 'Done' });
		return { format: req.format, files, prerendered: done, warnings: report.entries };
	}

	private sequenceName(doc: ProjectDocument, sequenceId: string): string | null {
		return (
			Object.values(doc.items).find(
				(i) => i.kind === 'sequence' && (i as { sequenceId: string }).sequenceId === sequenceId,
			)?.name ?? null
		);
	}

	/** Engine-local paths of the document's media (engine-store keys only, S04:SC-003). */
	private async mediaPaths(doc: ProjectDocument): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		for (const a of Object.values(doc.media)) {
			const key = mediaKeyOf(a);
			const p = key ? await this.core.registry.resolvePath(key) : null;
			if (p) out.set(a.id, p);
		}
		return out;
	}

	/**
	 * Renders one clip alone (its sequence with only that clip) to ProRes 4444 with alpha through the export
	 * pipeline; frame 0 of the movie is the clip's first frame.
	 */
	private async prerenderClip(
		envelope: { document: unknown } & Record<string, unknown>,
		doc: ProjectDocument,
		sequenceId: string,
		clipId: string,
		ctx: JobContext,
	): Promise<{ file: string }> {
		const copy = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
		const s = copy.sequences[sequenceId]!;
		const clip = s.clips[clipId] as Clip | undefined;
		if (!clip) throw new Error('the clip is gone');
		s.clips = { [clipId]: { ...clip, linkId: null, groupId: null } as Clip };
		s.transitions = {};
		s.links = {};
		s.groups = {};
		const settings: ExportSettings = {
			sequenceId,
			range: { type: 'custom', startFrame: clip.start, endFrame: clip.start + clip.duration },
			container: 'mov',
			video: {
				codec: 'prores',
				proresProfile: '4444',
				alpha: true,
				width: s.settings.width,
				height: s.settings.height,
				frameRate: s.settings.frameRate,
				scaling: 'fit',
				quality: { mode: 'crf', value: 18 },
				encoderSpeed: 'balanced',
			},
			engine: 'remotion',
			destination: { type: 'download' },
		};
		const job = await this.core.exports.start(
			{ envelope: { ...envelope, document: copy } as never, sequenceId, settings },
			{ type: 'user' },
		);
		const onAbort = () => this.core.queue.cancel(job.id);
		ctx.signal.addEventListener('abort', onAbort, { once: true });
		try {
			const end = await this.core.queue.wait(job.id);
			if (end.state !== 'succeeded') throw new Error(end.error?.message ?? `the render ${end.state}`);
		} finally {
			ctx.signal.removeEventListener('abort', onAbort);
		}
		const file = await this.core.exports.outputFile(job.id);
		if (!file) throw new Error('the render produced no file');
		return { file };
	}

	/** AAF / OMF audio essence: every used range (with handles) decoded by ffmpeg, embedded or written as files. */
	private async essence(
		ir: IProject,
		doc: ProjectDocument,
		sequenceId: string,
		audio: InterchangeAudioOptions,
		io: {
			ctx: JobContext;
			outDir: string;
			sideDir: string;
			stem: string;
			addFile: (name: string, role: 'audio', bytes?: Uint8Array) => Promise<void>;
		},
	): Promise<AudioEssence[]> {
		const seq = doc.sequences[sequenceId]!;
		const rate = seq.settings.frameRate;
		const sampleRate = seq.settings.audioSampleRate;
		const handles = audio.handlesFrames * flicksPerFrame(rate);
		const needs = audioNeeds(ir, sequenceId, { handles, wholeMedia: audio.copyComplete });
		const paths = await this.mediaPaths(doc);
		const out: AudioEssence[] = [];
		const bps = audio.bitDepth / 8;
		for (const [i, n] of needs.entries()) {
			io.ctx.progress(0.75 + (0.2 * i) / Math.max(1, needs.length), {
				stage: `Audio ${i + 1}/${needs.length}`,
			});
			const src = paths.get(n.mediaId);
			if (!src) continue; // offline: the clip keeps its link to the original file (reported by the writer)
			const channels = Math.max(1, n.channels);
			const frames = Math.max(0, Math.round(((n.end - n.start) * sampleRate) / FLICKS));
			if (frames === 0) continue;
			const pcm = await this.decode(src, n.start, frames, channels, sampleRate, audio.bitDepth, io.ctx);
			const parts =
				audio.breakoutToMono && channels > 1
					? Array.from({ length: channels }, (_, c) => ({
							channel: c as number | null,
							data: splitChannel(pcm, channels, c, bps),
						}))
					: [{ channel: null as number | null, data: pcm }];
			const base = safeFileName(parsePath(ir.media[n.mediaId]?.name ?? 'Audio').name, 'Audio');
			for (const p of parts) {
				const ch = p.channel === null ? channels : 1;
				let data: AudioEssence['data'];
				if (audio.mode === 'embed') data = { embedded: p.data };
				else {
					const ext = audio.fileFormat === 'aiff' ? 'aif' : 'wav';
					const name = safeFileName(
						`${io.stem} ${base} ${i + 1}${p.channel === null ? '' : ` ch${p.channel + 1}`}.${ext}`,
					);
					const bytes =
						ext === 'aif'
							? aiffFile(p.data, ch, sampleRate, audio.bitDepth)
							: wavFile(p.data, ch, sampleRate, audio.bitDepth);
					await io.addFile(name, 'audio', bytes);
					data = { file: join(io.sideDir, name) };
				}
				out.push({
					key: n.key,
					channel: p.channel,
					start: n.start,
					frames,
					sampleRate,
					bits: audio.bitDepth,
					channels: ch,
					data,
					effectsRendered: false,
				});
			}
		}
		return out;
	}

	/** Interleaved little-endian PCM of `frames` sample frames from `start` (flicks), zero-padded past the end. */
	private decode(
		path: string,
		start: number,
		frames: number,
		channels: number,
		sampleRate: number,
		bits: 16 | 24,
		ctx: JobContext,
	): Promise<Uint8Array> {
		const fmt = bits === 24 ? 's24le' : 's16le';
		const args = [
			'-ss',
			sec(start / FLICKS),
			'-i',
			path,
			'-map',
			'0:a:0',
			'-vn',
			'-ac',
			String(channels),
			'-ar',
			String(sampleRate),
			'-frames:a',
			String(frames),
			'-acodec',
			`pcm_${fmt}`,
			'-f',
			fmt,
			'pipe:1',
		];
		const want = frames * channels * (bits / 8);
		return new Promise((resolve, reject) => {
			const child = this.core.ffmpeg.spawnRaw(args, { signal: ctx.signal });
			ctx.trackChild(child);
			const out = new Uint8Array(want);
			let at = 0;
			let err = '';
			child.stdout!.on('data', (b: Buffer) => {
				const n = Math.min(b.length, want - at);
				if (n > 0) out.set(b.subarray(0, n), at);
				at += n;
			});
			child.stderr!.setEncoding('utf8').on('data', (c: string) => {
				err = (err + c).slice(-4000);
			});
			child.on('error', (e) => reject(e));
			child.on('close', (code) => {
				if (ctx.signal.aborted) reject(new JobError('JOB_CANCELLED', 'cancelled'));
				else if (code !== 0)
					reject(new JobError('TOOL_FAILED', `audio decode failed: ${err.trim().slice(-500)}`));
				else resolve(out);
			});
		});
	}

	async relink(req: AssetRelinkRequest): Promise<AssetRelinkResponse> {
		this.requireLocal('Linking media by path');
		if (!isAbsolute(req.path)) throw new HttpError(400, 'VALIDATION_FAILED', 'The path must be absolute');
		let reg: RegisteredMedia;
		try {
			reg = await this.core.media.registerPath(req.path, { projectId: req.projectId });
		} catch (e) {
			const err = e as { code?: string; message?: string };
			throw new HttpError(404, err.code ?? 'ASSET_NOT_FOUND', err.message ?? 'Cannot read the file');
		}
		const asset = req.asset as MediaAsset;
		const match = relinkMatch(asset, reg);
		const diff = relinkDiff(asset, reg);
		return {
			media: reg,
			match,
			diff,
			needsConfirm: relinkNeedsConfirm(match, diff),
		};
	}

	async startScan(projectId: string, raw: RelinkScanRequest): Promise<EngineJob> {
		this.requireLocal('Searching folders');
		const req = RelinkScanRequestSchema.parse(raw);
		if (!isAbsolute(req.folder)) throw new HttpError(400, 'VALIDATION_FAILED', 'The folder must be absolute');
		const info = await stat(req.folder).catch(() => null);
		if (!info?.isDirectory()) throw new HttpError(404, 'NOT_FOUND', 'No such folder');
		return this.core.queue.submit({
			kind: 'relink-scan',
			title: `Search for media – ${basename(req.folder) || req.folder}`,
			priority: 'user',
			cpuSlots: 1,
			origin: { type: 'user' },
			projectId,
			input: { projectId, request: req },
			stage: 'Scanning',
		});
	}

	private async runScan(ctx: JobContext): Promise<RelinkScanResult> {
		const { projectId, request: req } = ctx.input as {
			projectId: string;
			request: ReturnType<typeof RelinkScanRequestSchema.parse>;
		};
		const files: { path: string; name: string; size: number }[] = [];
		let truncated = false;
		const walk = async (dir: string, depth: number): Promise<void> => {
			if (depth > SCAN_MAX_DEPTH || ctx.signal.aborted) return;
			const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
			for (const e of entries) {
				if (files.length >= SCAN_MAX_FILES) {
					truncated = true;
					return;
				}
				if (e.name.startsWith('.')) continue;
				const p = join(dir, e.name);
				if (e.isDirectory()) await walk(p, depth + 1);
				else if (e.isFile()) {
					const st = await stat(p).catch(() => null);
					if (st) files.push({ path: p, name: e.name, size: st.size });
				}
			}
			if (files.length % 500 === 0) ctx.progress(null, { stage: `Scanning (${files.length} files)` });
		};
		await walk(req.folder, 0);
		const byName = new Map<string, typeof files>();
		const bySize = new Map<number, typeof files>();
		for (const f of files) {
			const k = nameKey(f.name, req.ignoreExtension);
			byName.set(k, [...(byName.get(k) ?? []), f]);
			bySize.set(f.size, [...(bySize.get(f.size) ?? []), f]);
		}
		const found: RelinkScanResult['found'] = [];
		const notFound: string[] = [];
		const assets = req.assets as MediaAsset[];
		for (const [i, a] of assets.entries()) {
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'cancelled');
			ctx.progress(i / assets.length, { stage: `Matching ${i + 1}/${assets.length}: ${a.originalName}` });
			const want = new Set(req.match);
			let hit: {
				file: (typeof files)[number];
				reg: RegisteredMedia;
				matched: RelinkScanResult['found'][number]['matched'];
			} | null = null;
			for (const f of byName.get(nameKey(a.originalName, req.ignoreExtension)) ?? []) {
				if (want.has('size') && a.sizeBytes > 0 && f.size !== a.sizeBytes) continue;
				let reg: RegisteredMedia;
				try {
					reg = await this.core.media.registerPath(f.path, { projectId });
				} catch {
					continue;
				}
				if (want.has('duration') && relinkDiff(a, reg).some((d) => d.field === 'duration')) continue;
				// Media Start: the start timecode, when the asset knows one.
				if (
					want.has('mediaStart') &&
					a.probe.startTimecode &&
					reg.probe.startTimecode !== a.probe.startTimecode
				)
					continue;
				hit = {
					file: f,
					reg,
					matched: req.match.filter(
						(m) => (m !== 'size' || a.sizeBytes > 0) && (m !== 'mediaStart' || !!a.probe.startTimecode),
					),
				};
				break;
			}
			// Then by fingerprint: files of the asset's size whose content is the asset's (moved and renamed).
			if (!hit && a.sizeBytes > 0 && !a.fingerprint.startsWith('pending:'))
				for (const f of bySize.get(a.sizeBytes) ?? []) {
					const fp = await fingerprintFile(f.path).catch(() => null);
					if (fp?.fingerprint !== a.fingerprint) continue;
					try {
						hit = { file: f, reg: await this.core.media.registerPath(f.path, { projectId }), matched: [] };
						break;
					} catch {}
				}
			if (!hit) {
				notFound.push(a.id);
				continue;
			}
			const match = relinkMatch(a, hit.reg);
			found.push({
				assetId: a.id,
				path: hit.file.path,
				media: hit.reg,
				matched: hit.matched,
				match,
				diff: relinkDiff(a, hit.reg),
			});
		}
		return { found, notFound, scannedFiles: files.length, truncated };
	}
}

function pathLocator(a: MediaAsset): string | null {
	for (const l of a.locators) if (l.type === 'path' && l.path) return l.path;
	return null;
}

function splitChannel(pcm: Uint8Array, channels: number, c: number, bps: number): Uint8Array {
	const frames = Math.floor(pcm.length / (channels * bps));
	const out = new Uint8Array(frames * bps);
	for (let i = 0; i < frames; i++)
		out.set(pcm.subarray((i * channels + c) * bps, (i * channels + c + 1) * bps), i * bps);
	return out;
}
