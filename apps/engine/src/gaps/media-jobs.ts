// Create Proxies and ingest (workstream gaps, docs/wp-notes/gaps.md §PRJ-8): one background job (`proxy-create`) over
// several media. `proxy` transcodes each video to a preset size with the engine's browser-playable proxy encoder
// (H.264, else VP9 / AV1; short GOPs for scrubbing; the display matrix kept with -noautorotate so the proxy turns like
// its original); `transcode` writes a full-size ProRes 422 HQ (or browser-playable) version; `copy` copies the file
// and checks the copy's fingerprint. Each output is registered with the engine and returned as RegisteredMedia: the
// client attaches proxies (`media.attachProxy`) or relinks copies and transcodes (`media.relink`), one undo step.
// Outputs are written to `<name>.partial.<ext>` first and renamed; a cancelled or failed job deletes its partials.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { EngineJob, MediaJobRequest, MediaJobResult, RegisteredMedia } from '@jasper/api';
import { DEFAULT_PROXY_PRESET, DEFAULT_TRANSCODE_PRESET, proxyPreset, proxySize } from '@jasper/project';
import { isLoopbackHost } from '../context.ts';
import { inColor } from '../export/native.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { MediaRecord } from '../media/registry.ts';
import { audioEncodeArgs, videoEncodeArgs } from '../tools/encoders.ts';
import { exists } from '../tools/fs.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';
import { PROJECT_MEDIA_DIR } from './paths.ts';

/** ITU-T H.273 code points of ffmpeg's colour names (unknown → 2, unspecified). */
const H273_PRIMARIES: Record<string, number> = {
	bt709: 1,
	bt470m: 4,
	bt470bg: 5,
	smpte170m: 6,
	smpte240m: 7,
	film: 8,
	bt2020: 9,
	smpte428: 10,
	smpte431: 11,
	smpte432: 12,
};
const H273_TRC: Record<string, number> = {
	bt709: 1,
	gamma22: 4,
	gamma28: 5,
	smpte170m: 6,
	smpte240m: 7,
	linear: 8,
	'iec61966-2-4': 11,
	'iec61966-2-1': 13,
	'bt2020-10': 14,
	'bt2020-12': 15,
	smpte2084: 16,
	smpte428: 17,
	'arib-std-b67': 18,
};

const SUBFOLDER = { proxy: 'Proxies', transcode: 'Ingested Media', copy: 'Ingested Media' } as const;
const SUFFIX = { proxy: '_Proxy', transcode: '', copy: '' } as const;

/** `<dir>/<stem><suffix>.<ext>`, numbered (" 2", " 3"…) when the name is taken on disk or in this job. */
export async function uniquePath(
	dir: string,
	stem: string,
	suffix: string,
	ext: string,
	taken: Set<string>,
): Promise<string> {
	for (let n = 1; n < 10_000; n++) {
		const name = `${stem}${suffix}${n === 1 ? '' : ` ${n}`}${ext}`;
		const p = join(dir, name);
		if (!taken.has(p) && !(await exists(p))) {
			taken.add(p);
			return p;
		}
	}
	throw new JobError('DESTINATION_FAILED', `No free file name for ${stem} in ${dir}`, false);
}

export class MediaJobService {
	constructor(private readonly core: CoreServices) {}

	registerRunner(): void {
		this.core.queue.registerRunner('proxy-create', (ctx) => this.run(ctx));
	}

	private local(): boolean {
		return this.core.config.dev || isLoopbackHost(this.core.config.host);
	}

	async submit(req: MediaJobRequest, origin: EngineJob['origin'] = { type: 'user' }): Promise<EngineJob> {
		if (req.destination.mode === 'folder' || req.destination.folder) {
			if (!this.local())
				throw new HttpError(403, 'LOCAL_MODE_ONLY', 'Choosing a folder is only available on a local engine');
			if (!req.destination.folder || !isAbsolute(req.destination.folder))
				throw new HttpError(400, 'VALIDATION_FAILED', 'The destination folder must be an absolute path');
		}
		if (req.destination.mode === 'project' && !req.projectId && !req.destination.folder)
			throw new HttpError(400, 'VALIDATION_FAILED', 'A project destination needs the projectId');
		const preset =
			req.op === 'copy'
				? null
				: proxyPreset(req.preset ?? (req.op === 'proxy' ? DEFAULT_PROXY_PRESET : DEFAULT_TRANSCODE_PRESET));
		if (req.op !== 'copy' && (!preset || preset.kind !== (req.op === 'proxy' ? 'proxy' : 'transcode')))
			throw new HttpError(400, 'UNKNOWN_PRESET', `Unknown ${req.op} preset: ${req.preset}`);
		if (req.op !== 'copy' && !this.core.encoders.select({ purpose: 'proxy' }))
			throw new HttpError(
				409,
				'ENCODER_UNAVAILABLE',
				'No usable video encoder for proxies (see capabilities)',
			);
		for (const it of req.items)
			if (!this.core.registry.get(it.mediaKey))
				throw new HttpError(404, 'ASSET_NOT_FOUND', `Unknown media key ${it.mediaKey}`);
		const n = req.items.length;
		const what =
			req.op === 'proxy' ? 'Create Proxies' : req.op === 'transcode' ? 'Ingest: transcode' : 'Ingest: copy';
		return this.core.queue.submit({
			kind: 'proxy-create',
			title: `${what} (${n} clip${n === 1 ? '' : 's'})`,
			priority: 'background',
			cpuSlots: Math.max(1, Math.min(4, this.core.queue.totalSlots)),
			minSlots: 1,
			origin,
			...(req.projectId ? { projectId: req.projectId } : {}),
			input: { ...req, ...(preset ? { preset: preset.id } : {}) },
		});
	}

	/** Folder an output of `source` goes to. */
	private folderFor(req: MediaJobRequest, source: string, managed: boolean): string {
		const sub = SUBFOLDER[req.op];
		const d = req.destination;
		if (d.mode === 'folder' && d.folder) return d.folder;
		if (d.mode === 'project' || managed) {
			const base =
				d.folder ??
				(req.projectId ? join(this.core.config.paths.projectDir(req.projectId), PROJECT_MEDIA_DIR) : null);
			if (!base) throw new JobError('DESTINATION_FAILED', 'No project folder for the outputs', false);
			return join(base, sub);
		}
		return join(dirname(source), sub);
	}

	private async run(ctx: JobContext): Promise<MediaJobResult> {
		const req = ctx.input as MediaJobRequest;
		const preset = req.op === 'copy' ? null : proxyPreset(req.preset);
		const outputs: MediaJobResult['outputs'] = [];
		const skipped: MediaJobResult['skipped'] = [];
		const taken = new Set<string>();
		const total = req.items.length;
		for (const [i, it] of req.items.entries()) {
			ctx.signal.throwIfAborted();
			const rec = this.core.registry.get(it.mediaKey);
			const src = rec ? await this.core.registry.resolvePath(it.mediaKey) : null;
			const name = it.name ?? rec?.originalName ?? it.mediaKey;
			if (!rec || !src) {
				skipped.push({ mediaId: it.mediaId, reason: `${name} is offline; link it first` });
				continue;
			}
			if (req.op === 'copy' && rec.storage.type === 'managed') {
				skipped.push({
					mediaId: it.mediaId,
					reason: `${name} was uploaded: the engine already keeps its own copy`,
				});
				continue;
			}
			if (req.op !== 'copy' && rec.kind !== 'video') {
				skipped.push({
					mediaId: it.mediaId,
					reason: `${name} has no video to ${req.op === 'proxy' ? 'proxy' : 'transcode'}`,
				});
				continue;
			}
			ctx.progress(i / total, { stage: `${name} (${i + 1} of ${total})` });
			const managed = rec.storage.type === 'managed';
			const dir = this.folderFor(req, src, managed);
			try {
				await mkdir(dir, { recursive: true });
			} catch (e) {
				throw new JobError('DESTINATION_FAILED', `Cannot create ${dir}: ${(e as Error).message}`, false);
			}
			const stem = basename(src, extname(src));
			const ext = req.op === 'copy' ? extname(src) : preset?.codec === 'prores-422-hq' ? '.mov' : '.mp4';
			const out = await uniquePath(dir, stem, SUFFIX[req.op], ext, taken);
			const partial = `${out.slice(0, -ext.length)}.partial${ext}`;
			ctx.addPartial(partial);
			const onFraction = (f: number) => ctx.progress((i + Math.min(1, Math.max(0, f))) / total);
			try {
				if (req.op === 'copy') await this.copy(src, partial, ctx, onFraction);
				else await this.transcode(rec, src, partial, preset!, ctx, onFraction);
				await rename(partial, out);
			} catch (e) {
				await rm(partial, { force: true }).catch(() => undefined);
				if (ctx.signal.aborted) throw e;
				const code = (e as NodeJS.ErrnoException).code;
				if (code === 'ENOSPC') throw new JobError('DISK_FULL', `The disk is full writing ${out}`, false);
				throw e instanceof JobError
					? e
					: new JobError('MEDIA_JOB_FAILED', `${name}: ${(e as Error).message}`, true);
			}
			let reg: RegisteredMedia;
			try {
				reg = await this.core.media.registerPath(out, req.projectId ? { projectId: req.projectId } : {});
			} catch (e) {
				throw new JobError(
					'MEDIA_JOB_FAILED',
					`${name}: the output could not be registered: ${(e as Error).message}`,
					false,
				);
			}
			if (req.op === 'copy' && reg.fingerprint !== rec.fingerprint) {
				await rm(out, { force: true }).catch(() => undefined);
				throw new JobError('COPY_MISMATCH', `The copy of ${name} does not match the original`, false);
			}
			if (req.op === 'copy') {
				// The same bytes have the same media key: the engine now reads them from the ingested copy.
				const st = await stat(out);
				await this.core.registry.put({ ...rec, storage: { type: 'path', path: out }, mtimeMs: st.mtimeMs });
			}
			outputs.push({ mediaId: it.mediaId, path: out, registered: reg });
		}
		ctx.progress(1, { stage: 'Done' });
		return { op: req.op, preset: preset?.id ?? null, outputs, skipped };
	}

	private async copy(
		src: string,
		dest: string,
		ctx: JobContext,
		onFraction: (f: number) => void,
	): Promise<void> {
		const size = (await stat(src)).size || 1;
		let done = 0;
		const rs = createReadStream(src);
		rs.on('data', (c) => {
			done += (c as Buffer).length;
			onFraction(done / size);
		});
		await pipeline(rs, createWriteStream(dest), { signal: ctx.signal });
	}

	private async transcode(
		rec: MediaRecord,
		src: string,
		dest: string,
		preset: NonNullable<ReturnType<typeof proxyPreset>>,
		ctx: JobContext,
		onFraction: (f: number) => void,
	): Promise<void> {
		const vs = rec.probe.streams.find((s) => s.type === 'video');
		if (vs?.type !== 'video') throw new JobError('UNSUPPORTED_MEDIA', 'No video stream', false);
		const hasAudio = rec.probe.streams.some((s) => s.type === 'audio');
		const { width, height } = proxySize(vs.width, vs.height, preset);
		const rate = vs.frameRate.num > 0 && vs.frameRate.den > 0 ? vs.frameRate : { num: 30, den: 1 };
		const dur = rec.durationSec ?? 0;
		// The proxy keeps the file's R'G'B' signal: decoded with the matrix every export path assumes for the original
		// (`inColor`: its tag, else BT.709 from 720 lines up, BT.601 below) and re-encoded as BT.709 limited range;
		// primaries and transfer keep the original's tags (untagged stays unspecified), so the proxy decodes to the
		// same picture as the original on every path.
		const known = (v: string | undefined): v is string => !!v && v !== 'unknown' && v !== 'unspecified';
		const scale = `scale=${width}:${height}:flags=bicubic${inColor({ record: rec } as never)}:out_color_matrix=bt709:out_range=tv`;
		const tags = [
			...(known(vs.color.primaries) ? ['-color_primaries', vs.color.primaries] : []),
			...(known(vs.color.transfer) ? ['-color_trc', vs.color.transfer] : []),
			'-colorspace',
			'bt709',
			'-color_range',
			'tv',
		];
		const colorCodes = {
			primaries: H273_PRIMARIES[vs.color.primaries] ?? 2,
			trc: H273_TRC[vs.color.transfer] ?? 2,
			matrix: 1,
		};
		let args: string[];
		if (preset.codec === 'prores-422-hq') {
			const enc = videoEncodeArgs(
				{ encoder: 'prores_ks' },
				{ crf: 18, speed: 'balanced', width, height, fps: rate, threads: ctx.slots },
			);
			args = [
				...enc.pre,
				'-noautorotate',
				'-i',
				src,
				'-map',
				'0:v:0',
				...(hasAudio ? ['-map', '0:a?'] : []),
				'-vf',
				[scale, ...enc.filters].join(','),
				...enc.video,
				...tags,
				...(hasAudio ? ['-c:a', 'pcm_s24le'] : []),
				'-f',
				'mov',
				dest,
			];
		} else {
			const choice = this.core.encoders.select({ purpose: 'proxy' });
			if (!choice) throw new JobError('ENCODER_UNAVAILABLE', 'No usable video encoder for proxies', false);
			const enc = videoEncodeArgs(choice, {
				crf: preset.kind === 'proxy' ? 24 : 18,
				speed: 'balanced',
				width,
				height,
				fps: rate,
				gop: preset.kind === 'proxy' ? 15 : undefined,
				colorCodes,
				realtime: preset.kind === 'proxy',
				threads: ctx.slots,
			});
			args = [
				...enc.pre,
				'-noautorotate',
				'-i',
				src,
				'-map',
				'0:v:0',
				...(hasAudio ? ['-map', '0:a:0?'] : []),
				'-vf',
				[scale, ...enc.filters].join(','),
				...enc.video,
				...tags,
				...(hasAudio ? [...audioEncodeArgs('aac', 192), '-ar', '48000'] : []),
				'-movflags',
				'+faststart',
				'-f',
				'mp4',
				dest,
			];
		}
		await this.core.ffmpeg.run(args, {
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			nice: 10,
			onProgress: (pr) => {
				if (dur > 0) onFraction(pr.outTimeUs / 1e6 / dur);
			},
		});
		if (!(await stat(dest)).size)
			throw new JobError('MEDIA_JOB_FAILED', 'The encoder wrote an empty file', true);
	}
}
