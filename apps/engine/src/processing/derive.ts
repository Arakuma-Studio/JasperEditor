// Media derivation jobs (spec 18 AF-OPS-001; wp-note agent-footage-ops): `POST /api/media/:key/derive` queues a
// `derive` job that runs one NativeRecipe op (conform-cfr, reverse, denoise-audio, extract-audio, time-stretch,
// range) with FFmpeg (derive-plan.ts) and registers the output as a derived media (`MediaService.registerDerived`);
// the client commits it with `media.derive` (one undo step).
//
// - Refusals are coded JobErrors (HTTP 422 at submit): UNSUPPORTED_MEDIA, NO_VIDEO, NO_AUDIO, UNSUPPORTED_RATE,
//   OUT_OF_RANGE, EMPTY_RANGE (`deriveProblems`), MEDIA_OFFLINE, ENCODER_UNAVAILABLE.
// - Outputs are content-addressed: `<media>/processed/<fingerprint>/<recipeHash>/<stem>.<op><ext>` with a sidecar
//   `<file>.json` {recipeHash, recipe, output.bytes}; the same source + recipe reuses the file.
// - Atomic: FFmpeg writes `.partial-<job><ext>` in the output directory (and reverse segments in the job's scratch
//   directory); the partial is fsynced and renamed, then the directory fsynced. Cancelled / failed jobs delete it.
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { DeriveRequest, DeriveResult, EngineJob, RegisteredMedia } from '@jasper/api';
import {
	type AudioStream,
	type DeriveRecipe,
	deriveProblems,
	FLICKS_PER_SECOND,
	type MediaAsset,
	type VideoStream,
} from '@jasper/project';
import { z } from 'zod';
import { inColor } from '../export/native.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import { fingerprintHex } from '../media/fingerprint.ts';
import type { MediaRecord } from '../media/registry.ts';
import { atomicWriteJson, fsyncDir, safeFileName } from '../tools/fs.ts';
import { ToolError } from '../tools/process.ts';
import { LOCAL_PROTOCOLS } from '../tools/protocols.ts';
import type { CoreServices } from '../tools/services.ts';
import {
	concatArgs,
	concatList,
	DERIVE_RECIPE_VERSION,
	type DeriveSource,
	deriveLabel,
	deriveOutput,
	deriveRecipeHash,
	type FfmpegPass,
	planDerive,
} from './derive-plan.ts';

type DeriveJobInput = { mediaKey: string; recipe: DeriveRecipe; projectId?: string };

/** ffprobe start times, validated (the probe output is untrusted input). */
const StartProbeSchema = z.object({
	format: z.object({ start_time: z.string().optional() }).optional(),
	streams: z
		.array(z.object({ index: z.number().int().min(0), start_time: z.string().optional() }))
		.max(4096)
		.optional(),
});

const finiteOr = (s: string | undefined, d: number) => {
	const v = s === undefined ? Number.NaN : Number(s);
	return Number.isFinite(v) ? v : d;
};

export class DeriveService {
	constructor(private readonly core: CoreServices) {}

	registerRunner(): void {
		this.core.queue.registerRunner('derive', (ctx) => this.run(ctx));
	}

	/** Refusals that need only the record (submit) — the same checks run again when the job starts. */
	private check(r: MediaRecord | null | undefined, recipe: DeriveRecipe): MediaRecord {
		if (!r) throw new JobError('ASSET_NOT_FOUND', 'Unknown media key', false);
		const problem = deriveProblems({ kind: r.kind as MediaAsset['kind'], probe: r.probe }, recipe)[0];
		if (problem) throw new JobError(problem.code, problem.message, false, { field: problem.field });
		const out = deriveOutput({ kind: r.kind === 'audio' ? 'audio' : 'video' }, recipe);
		const need = out.kind === 'video' ? 'prores_ks' : out.ext === '.flac' ? 'flac' : null;
		if (need && !this.core.encoders.has(need))
			throw new JobError('ENCODER_UNAVAILABLE', `This FFmpeg has no ${need} encoder`, false);
		return r;
	}

	async submit(
		mediaKey: string,
		req: DeriveRequest,
		origin: EngineJob['origin'] = { type: 'user' },
	): Promise<EngineJob> {
		const r = this.check(this.core.registry.get(mediaKey), req.recipe);
		if ((await this.core.registry.availability(mediaKey)) !== 'online')
			throw new JobError('MEDIA_OFFLINE', `${r.originalName} is offline; relink it first`, false);
		const hash = deriveRecipeHash(r.fingerprint, req.recipe);
		return this.core.queue.submit({
			kind: 'derive',
			title: `Derive – ${r.originalName} [${deriveLabel(req.recipe)}]`,
			priority: 'user',
			cpuSlots: Math.max(1, Math.min(2, this.core.queue.totalSlots)),
			minSlots: 1,
			origin,
			assetId: mediaKey,
			...(req.projectId ? { projectId: req.projectId } : {}),
			dedupeKey: `derive:${fingerprintHex(r.fingerprint)}:${hash}`,
			input: {
				mediaKey,
				recipe: req.recipe,
				...(req.projectId ? { projectId: req.projectId } : {}),
			} satisfies DeriveJobInput,
		});
	}

	/** Content-addressed output: `<media>/processed/<fingerprint>/<recipeHash>/<stem>.<op><ext>`. */
	outputPath(
		r: MediaRecord,
		hash: string,
		recipe: DeriveRecipe,
		ext: string,
	): { file: string; name: string } {
		const stem = basename(r.originalName, extname(r.originalName)) || 'media';
		const dir = join(
			this.core.config.paths.mediaDir,
			'processed',
			fingerprintHex(r.fingerprint).slice(0, 32),
			hash.slice(0, 24),
		);
		return {
			file: join(dir, safeFileName(`${stem}.${recipe.op}${ext}`, `derived${ext}`)),
			name: `${stem} [${deriveLabel(recipe)}]${ext}`,
		};
	}

	private async reusable(file: string, hash: string): Promise<{ notes: string[] } | null> {
		try {
			const [st, side] = await Promise.all([stat(file), readFile(`${file}.json`, 'utf8')]);
			const sc = JSON.parse(side) as { recipeHash?: string; output?: { bytes?: number }; notes?: unknown };
			if (sc.recipeHash === hash && sc.output?.bytes === st.size && st.size > 0)
				return { notes: Array.isArray(sc.notes) ? sc.notes.filter((n) => typeof n === 'string') : [] };
		} catch {
			// not there (or unreadable): produce it again
		}
		return null;
	}

	private async startTimes(path: string, signal: AbortSignal): Promise<DeriveSource['start']> {
		let raw: unknown;
		try {
			raw = await this.core.ffmpeg.probeJson(
				[...LOCAL_PROTOCOLS, '-show_entries', 'format=start_time:stream=index,start_time', path],
				{ signal },
			);
		} catch (e) {
			if (signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			throw new JobError('UNSUPPORTED_MEDIA', `The media cannot be read: ${(e as Error).message}`, false);
		}
		const p = StartProbeSchema.safeParse(raw);
		if (!p.success) throw new JobError('UNSUPPORTED_MEDIA', 'ffprobe returned unexpected start times', false);
		const format = finiteOr(p.data.format?.start_time, 0);
		const streams: Record<number, number> = {};
		for (const s of p.data.streams ?? []) streams[s.index] = finiteOr(s.start_time, format);
		return { format, streams };
	}

	private async run(ctx: JobContext): Promise<DeriveResult> {
		const input = ctx.input as DeriveJobInput;
		const r = this.check(this.core.registry.get(input.mediaKey), input.recipe);
		const path = await this.core.registry.resolvePath(r.mediaKey);
		if (!path) throw new JobError('MEDIA_OFFLINE', `${r.originalName} is offline; relink it first`, true);
		const recipe = input.recipe;
		const hash = deriveRecipeHash(r.fingerprint, recipe);
		const kind = r.kind === 'audio' ? 'audio' : 'video';
		const output = deriveOutput({ kind }, recipe);
		const out = this.outputPath(r, hash, recipe, output.ext);
		await mkdir(dirname(out.file), { recursive: true });
		let notes: string[];
		let reused = false;
		let range: DeriveResult['range'];
		const reuse = await this.reusable(out.file, hash);
		const src = await this.source(r, path, ctx.signal);
		if (reuse) {
			notes = [...reuse.notes, 'reused an existing file of the same source and recipe'];
			reused = true;
			range = planDerive(src, recipe, out.file, '').range;
			ctx.progress(1, { stage: 'Reused' });
		} else {
			const partial = join(dirname(out.file), `.partial-${ctx.job.id}${output.ext}`);
			ctx.addPartial(partial);
			const scratch = await ctx.scratchDir();
			const plan = planDerive(src, recipe, partial, scratch);
			range = plan.range;
			notes = plan.notes;
			ctx.log(`derive ${recipe.op}: ${JSON.stringify(recipe)}`);
			const total = plan.passes.reduce((a, p) => a + Math.max(0.001, p.outSec), 0) * (plan.concat ? 1.05 : 1);
			let done = 0;
			for (const [i, pass] of plan.passes.entries()) {
				const stage =
					plan.passes.length > 1
						? `${deriveLabel(recipe)} · segment ${i + 1} of ${plan.passes.length}`
						: deriveLabel(recipe);
				await this.ffmpeg(ctx, pass, (sec) => ctx.progress(Math.min(0.99, (done + sec) / total), { stage }));
				done += Math.max(0.001, pass.outSec);
			}
			if (plan.concat) {
				ctx.progress(Math.min(0.99, done / total), { stage: 'Joining segments' });
				const list = join(scratch, 'segments.txt');
				await writeFile(list, concatList(plan.concat));
				await this.ffmpeg(ctx, { args: concatArgs(list, output), outSec: done, out: partial }, () => {});
			}
			const st = await stat(partial).catch(() => null);
			if (!st?.size) throw new JobError('DERIVE_FAILED', 'FFmpeg wrote an empty file', true);
			await publish(partial, out.file);
			await atomicWriteJson(
				`${out.file}.json`,
				{
					recipeHash: hash,
					recipeVersion: DERIVE_RECIPE_VERSION,
					recipe,
					from: { fingerprint: r.fingerprint, name: r.originalName },
					output: { bytes: st.size },
					notes,
				},
				true,
			);
		}
		ctx.progress(1, { stage: 'Registering' });
		let registered: RegisteredMedia;
		try {
			registered = await this.core.media.registerDerived(out.file, {
				fromMediaKey: r.mediaKey,
				recipeHash: hash,
				name: out.name,
				...(input.projectId ? { projectId: input.projectId } : {}),
				...(range ? { range } : {}),
			});
		} catch (e) {
			// An unreadable output is not reused next time.
			await rm(`${out.file}.json`, { force: true }).catch(() => undefined);
			throw new JobError(
				'DERIVE_FAILED',
				`The derived file could not be registered: ${(e as Error).message}`,
				true,
			);
		}
		const streams = registered.probe.streams;
		if (
			(output.kind === 'video' && !streams.some((s) => s.type === 'video')) ||
			(output.kind === 'audio' && !streams.some((s) => s.type === 'audio'))
		)
			throw new JobError('DERIVE_FAILED', `The derived file has no ${output.kind} stream`, true);
		return {
			registered,
			fromMediaKey: r.mediaKey,
			recipe,
			recipeVersion: DERIVE_RECIPE_VERSION,
			recipeHash: hash,
			reused,
			...(range ? { range } : {}),
			notes,
		};
	}

	private async source(r: MediaRecord, path: string, signal: AbortSignal): Promise<DeriveSource> {
		const video = (r.probe.streams.find((s) => s.type === 'video') as VideoStream | undefined) ?? null;
		const audioAll = r.probe.streams.filter((s): s is AudioStream => s.type === 'audio');
		const kind = r.kind === 'audio' ? 'audio' : 'video';
		const durationSec =
			r.probe.durationFlicks !== null ? r.probe.durationFlicks / FLICKS_PER_SECOND : (r.durationSec ?? 0);
		return {
			path,
			kind,
			video: kind === 'video' ? video : null,
			audio: kind === 'audio' ? audioAll.slice(0, 1) : audioAll,
			durationSec,
			hasAlpha: r.probe.hasAlpha,
			variableFrameRate: r.probe.variableFrameRate,
			inColor: inColor({ record: r } as never),
			start: await this.startTimes(path, signal),
		};
	}

	private async ffmpeg(ctx: JobContext, pass: FfmpegPass, onSec: (sec: number) => void): Promise<void> {
		ctx.log(`ffmpeg ${[...pass.args, pass.out].join(' ')}`);
		try {
			await this.core.ffmpeg.run([...pass.args, '-threads', String(Math.max(1, ctx.slots)), pass.out], {
				signal: ctx.signal,
				onSpawn: ctx.trackChild,
				nice: 10,
				onProgress: (p) => onSec(Math.min(pass.outSec, p.outTimeUs / 1e6)),
			});
		} catch (e) {
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			if (e instanceof ToolError) {
				const stderr = e.detail?.stderr ?? '';
				if (/No space left on device/i.test(stderr))
					throw new JobError('DISK_FULL', 'The disk is full writing the derived file', false);
				throw new JobError('DERIVE_FAILED', e.message, e.code !== 'BINARY_MISSING');
			}
			throw e;
		}
	}
}

/** fsync the finished file, rename it into place and fsync the directory (a crash leaves the old state or the new). */
async function publish(partial: string, file: string): Promise<void> {
	const fh = await open(partial, 'r+');
	try {
		await fh.sync();
	} finally {
		await fh.close();
	}
	await rename(partial, file);
	await fsyncDir(dirname(file));
}
