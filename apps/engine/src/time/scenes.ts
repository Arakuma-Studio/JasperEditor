// ffmpeg decodes the media frames of a range at
// a small size (long side 192 px, raw RGBA), each frame is reduced to its signature (`sceneSignature` of
// @jasper/project: colour histogram + motion thumbnail) and compared with the previous one; the cuts are the media
// times of the frames that start a new shot (`detectSceneCuts`). Frame times come from the media's real timestamps
// (variable-frame-rate footage too).
import { createHash } from 'node:crypto';
import type { EngineJob, SceneDetectRequest, SceneDetectResult } from '@jasper/api';
import { SceneDetectResultSchema } from '@jasper/api';
import {
	detectSceneCuts,
	frameIndexAt,
	SCENE_DECODE,
	type SceneSignature,
	sceneDissimilarity,
	sceneSignature,
	sceneThreshold,
} from '@jasper/project';
import { cachedFrameTimes } from '../export/retime/frames.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import { AnalysisCache } from '../sound-design/analysis-cache.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';

type SceneJobInput = {
	request: SceneDetectRequest;
	file: string;
	fingerprint: string;
	width: number;
	height: number;
};

/** Bump when the detection changes (cached results of older versions are not reused). */
const SCENE_RESULTS_VERSION = 1;
const CacheEntrySchema = SceneDetectResultSchema;

export class SceneService {
	/** Finished detections by media file, settings and range (Sound Design's scene cue source reuses them). */
	private readonly results: AnalysisCache<SceneDetectResult> | null;

	constructor(
		private readonly core: CoreServices,
		private readonly cacheDir: string,
		resultsDir?: string,
	) {
		this.results = resultsDir
			? new AnalysisCache(resultsDir, CacheEntrySchema, { max: 2000, memory: 32 })
			: null;
	}

	registerRunner(): void {
		this.core.queue.registerRunner('scene-detect', (ctx) => this.run(ctx));
	}

	/** `<file>-<settings>-` prefix of a request's cache keys (null: unknown media). */
	private keyPrefix(r: SceneDetectRequest): string | null {
		const rec = this.core.registry.get(r.mediaKey);
		if (!rec) return null;
		const fp = createHash('sha256')
			.update(JSON.stringify([SCENE_RESULTS_VERSION, rec.fingerprint, rec.sizeBytes, rec.mtimeMs]))
			.digest('hex')
			.slice(0, 32);
		return `${fp}-${Math.round(r.sensitivity)}-${r.minShotFrames}-`;
	}

	/**
	 * A finished detection of the media that covers the request's range with the same settings (null: none yet). Cuts,
	 * scores and times outside the request's range are left out.
	 */
	async cachedCovering(r: SceneDetectRequest): Promise<SceneDetectResult | null> {
		if (!this.results) return null;
		const prefix = this.keyPrefix(r);
		if (!prefix) return null;
		for (const key of await this.results.keys(prefix)) {
			const m = /-(\d+)-(\d+)$/.exec(key);
			if (!m) continue;
			const a = Number(m[1]) / 1000;
			const b = Number(m[2]) / 1000;
			if (a > r.startSec + 1e-3 || b < r.endSec - 1e-3) continue;
			const hit = await this.results.get(key);
			if (!hit) continue;
			const keep = hit.times.map((t) => t >= r.startSec - 1e-6 && t < r.endSec + 1e-6);
			return {
				...hit,
				cuts: hit.cuts.filter((t) => t >= r.startSec - 1e-6 && t < r.endSec + 1e-6),
				scores: hit.scores.filter((_, i) => keep[i]),
				times: hit.times.filter((_, i) => keep[i]),
				frames: keep.filter(Boolean).length,
			};
		}
		return null;
	}

	private async remember(r: SceneDetectRequest, result: SceneDetectResult): Promise<void> {
		const prefix = this.results ? this.keyPrefix(r) : null;
		if (!this.results || !prefix) return;
		const key = `${prefix}${Math.round(r.startSec * 1000)}-${Math.round(r.endSec * 1000)}`;
		await this.results.put(key, result).catch(() => undefined);
	}

	/**
	 * Detects inside another job (the Sound Design plan job): the same analysis without a queue entry of its own, so a
	 * job never waits for a slot another job holds. Cached like a job's result.
	 */
	async detectInline(r: SceneDetectRequest, ctx: JobContext): Promise<SceneDetectResult> {
		const cached = await this.cachedCovering(r);
		if (cached) return cached;
		return this.analyze(await this.inputOf(r), ctx);
	}

	private async inputOf(r: SceneDetectRequest): Promise<SceneJobInput> {
		const rec = this.core.registry.get(r.mediaKey);
		if (!rec) throw new HttpError(404, 'ASSET_NOT_FOUND', `Unknown media key ${r.mediaKey}`);
		const file = await this.core.registry.resolvePath(r.mediaKey);
		if (!file) throw new HttpError(404, 'ASSET_NOT_FOUND', 'The media file is offline');
		const vs = rec.probe.streams.find((s) => s.type === 'video');
		if (vs?.type !== 'video') throw new HttpError(400, 'VALIDATION_FAILED', 'The media has no video stream');
		if (!(r.endSec > r.startSec))
			throw new HttpError(400, 'VALIDATION_FAILED', 'endSec must be after startSec');
		const display = rec.display ?? { width: vs.width, height: vs.height };
		const s = Math.min(1, SCENE_DECODE / Math.max(display.width, display.height));
		const width = Math.max(8, Math.round((display.width * s) / 2) * 2);
		const height = Math.max(8, Math.round((display.height * s) / 2) * 2);
		return {
			request: r,
			file,
			fingerprint: `${rec.fingerprint}|${rec.sizeBytes}|${rec.mtimeMs}`,
			width,
			height,
		};
	}

	async submit(r: SceneDetectRequest): Promise<EngineJob> {
		const input = await this.inputOf(r);
		const seconds = r.endSec - r.startSec;
		return this.core.queue.submit({
			kind: 'scene-detect',
			title: `Scene Edit Detection (${seconds.toFixed(1)} s)`,
			priority: seconds <= 60 ? 'interactive' : 'user',
			cpuSlots: 2,
			minSlots: 1,
			...(r.projectId ? { projectId: r.projectId } : {}),
			dedupeKey: `scene-detect:${createHash('sha256')
				.update(JSON.stringify({ r, fp: input.fingerprint }))
				.digest('hex')
				.slice(0, 32)}`,
			input,
			stage: 'Waiting',
		});
	}

	private async run(ctx: JobContext): Promise<SceneDetectResult> {
		return this.analyze(ctx.input as SceneJobInput, ctx);
	}

	private async analyze(input: SceneJobInput, ctx: JobContext): Promise<SceneDetectResult> {
		const { request: r, file, fingerprint, width, height } = input;
		const started = Date.now();
		ctx.progress(null, { stage: 'Reading frame times' });
		const ft = await cachedFrameTimes(
			this.core.ffmpeg,
			file,
			this.cacheDir,
			createHash('sha256').update(fingerprint).digest('hex').slice(0, 32),
			{ signal: ctx.signal },
		);
		const times = ft.kind === 'list' ? Array.from(ft.times) : [];
		const first = frameIndexAt(ft, r.startSec);
		let last = frameIndexAt(ft, r.endSec);
		if (last > first && times[last]! >= r.endSec - 1e-6) last--;
		const count = Math.max(1, last - first + 1);
		const t0 = times[first] ?? 0;
		const prev = first > 0 ? times[first - 1]! : 0;
		const seek = first > 0 ? t0 - Math.min(0.5 * (t0 - prev), 0.01) : 0;
		const args = [
			...(seek > 0 ? ['-ss', seek.toFixed(6)] : []),
			'-i',
			file,
			...['-map', '0:v:0', '-an', '-sn', '-dn'],
			...['-vf', `scale=${width}:${height}:flags=area,format=rgba`],
			...[
				'-fps_mode',
				'passthrough',
				'-frames:v',
				String(count),
				'-f',
				'rawvideo',
				'-pix_fmt',
				'rgba',
				'pipe:1',
			],
		];
		ctx.log(`scene-detect: ffmpeg ${args.join(' ')}`);
		const child = this.core.ffmpeg.spawnRaw(args, { signal: ctx.signal });
		ctx.trackChild(child);
		const frameBytes = width * height * 4;
		const sigs: SceneSignature[] = [];
		const scores: number[] = [];
		let stderr = '';
		child.stderr?.setEncoding('utf8').on('data', (d: string) => {
			stderr = (stderr + d).slice(-4000);
		});
		await new Promise<void>((resolve, reject) => {
			let cur = Buffer.alloc(frameBytes);
			let filled = 0;
			child.stdout!.on('data', (chunk: Buffer) => {
				let off = 0;
				while (off < chunk.length) {
					const n = Math.min(frameBytes - filled, chunk.length - off);
					chunk.copy(cur, filled, off, off + n);
					filled += n;
					off += n;
					if (filled === frameBytes) {
						const sig = sceneSignature({ width, height, data: cur });
						scores.push(sigs.length === 0 ? 0 : sceneDissimilarity(sigs[sigs.length - 1]!, sig));
						sigs.push(sig);
						cur = Buffer.alloc(frameBytes);
						filled = 0;
						if (sigs.length % 10 === 0)
							ctx.progress(sigs.length / count, { stage: `Analysing frame ${sigs.length} of ${count}` });
					}
				}
			});
			child.on('error', reject);
			child.on('close', (code, sig) => {
				if (ctx.signal.aborted)
					return reject(new JobError('JOB_CANCELLED', 'Scene Edit Detection cancelled'));
				if (code !== 0)
					return reject(new JobError('TOOL_FAILED', `ffmpeg exited ${code ?? sig}: ${stderr.trim()}`, true));
				resolve();
			});
		});
		const opts = { sensitivity: r.sensitivity, minShotFrames: r.minShotFrames };
		const cutIdx = detectSceneCuts(scores, opts, sigs);
		const frameTimes = sigs.map((_, k) => times[first + k] ?? t0);
		const secs = (Date.now() - started) / 1000;
		ctx.log(`scene-detect: ${sigs.length} frames, ${cutIdx.length} cut(s) in ${secs.toFixed(1)} s`);
		const result: SceneDetectResult = {
			cuts: cutIdx.map((k) => frameTimes[k]!),
			frames: sigs.length,
			scores,
			times: frameTimes,
			threshold: sceneThreshold(r.sensitivity),
			framesPerSec: sigs.length / Math.max(1e-3, secs),
		};
		await this.remember(r, result);
		return result;
	}
}
