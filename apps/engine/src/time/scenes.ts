// ffmpeg decodes the media frames of a range at
// a small size (long side 192 px, raw RGBA), each frame is reduced to its signature (`sceneSignature` of
// @jasper/project: colour histogram + motion thumbnail) and compared with the previous one; the cuts are the media
// times of the frames that start a new shot (`detectSceneCuts`). Frame times come from the media's real timestamps
// (variable-frame-rate footage too).
import { createHash } from 'node:crypto';
import type { EngineJob, SceneDetectRequest, SceneDetectResult } from '@jasper/api';
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
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';

type SceneJobInput = {
	request: SceneDetectRequest;
	file: string;
	fingerprint: string;
	width: number;
	height: number;
};

export class SceneService {
	constructor(
		private readonly core: CoreServices,
		private readonly cacheDir: string,
	) {}

	registerRunner(): void {
		this.core.queue.registerRunner('scene-detect', (ctx) => this.run(ctx));
	}

	async submit(r: SceneDetectRequest): Promise<EngineJob> {
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
		const input: SceneJobInput = {
			request: r,
			file,
			fingerprint: `${rec.fingerprint}|${rec.sizeBytes}|${rec.mtimeMs}`,
			width,
			height,
		};
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
		const { request: r, file, fingerprint, width, height } = ctx.input as SceneJobInput;
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
		return {
			cuts: cutIdx.map((k) => frameTimes[k]!),
			frames: sigs.length,
			scores,
			times: frameTimes,
			threshold: sceneThreshold(r.sensitivity),
			framesPerSec: sigs.length / Math.max(1e-3, secs),
		};
	}
}
