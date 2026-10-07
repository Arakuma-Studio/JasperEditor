// The 3D Camera Tracker on the engine (three-d, docs/wp-notes/three-d.md): `camtrack` jobs run the `jasper-camtrack`
// child process (feature tracking + camera solve; heavy work never runs in the engine process) on a span of one
// video and return the `CamTrackResult` the client commits with `cameraTracker.setResult`. Feature tracks are cached
// under `<cache>/camtrack` by media, span and analysis mode, so re-solving (deleted track points, other settings) skips
// the tracking. A cancelled job kills the process; a failed solve fails the job with its reason (CAMTRACK_FAILED).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CamTrackResult, CamTrackSolveRequest, EngineJob } from '@jasper/api';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { MediaRecord } from '../media/registry.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';
import { openCvPath } from '../tracking/worker.ts';
import { camtrackCommand } from './entry.ts';
import type { CamTrackJobOutput, CamTrackJobSpec } from './worker/run.ts';

export const CAMTRACK_METHOD = 'camtrack@1';

type CamTrackJobInput = {
	request: CamTrackSolveRequest;
	file: string;
	display: { width: number; height: number };
	rate: { num: number; den: number };
};

function mediaFacts(rec: MediaRecord) {
	const vs = rec.probe.streams.find((s) => s.type === 'video');
	if (rec.kind !== 'video' || vs?.type !== 'video') return null;
	const display = rec.display ?? { width: vs.width, height: vs.height };
	const rate = { num: vs.frameRate.num || 30, den: vs.frameRate.den || 1 };
	const frameCount =
		rec.durationSec && rate.num > 0 ? Math.max(1, Math.round((rec.durationSec * rate.num) / rate.den)) : null;
	return { display, rate, frameCount };
}

export class CamTrackService {
	constructor(
		private readonly core: CoreServices,
		private readonly env: Record<string, string | undefined> = process.env,
	) {}

	registerRunners(): void {
		this.core.queue.registerRunner('camtrack', (ctx) => this.run(ctx));
	}

	/** Whether jobs can run (ffmpeg and OpenCV.js present). */
	available(): { ok: true } | { ok: false; reason: string } {
		if (!this.core.ffmpeg.bins.ffmpeg) return { ok: false, reason: 'ffmpeg was not found' };
		try {
			openCvPath();
		} catch {
			return { ok: false, reason: 'OpenCV.js (@techstark/opencv-js) is not installed' };
		}
		return { ok: true };
	}

	/** Validates a request and queues the `camtrack` job (HttpError 404/400/409). */
	async submit(req: CamTrackSolveRequest, origin: EngineJob['origin'] = { type: 'user' }): Promise<EngineJob> {
		const rec = this.core.registry.get(req.mediaKey);
		if (!rec) throw new HttpError(404, 'ASSET_NOT_FOUND', `Unknown media key ${req.mediaKey}`);
		const file = await this.core.registry.resolvePath(req.mediaKey);
		if (!file) throw new HttpError(404, 'ASSET_NOT_FOUND', 'The media file is offline');
		const facts = mediaFacts(rec);
		if (!facts) throw new HttpError(400, 'VALIDATION_FAILED', 'The 3D Camera Tracker needs a video');
		const [a, b] = req.span;
		if (b < a + 1) throw new HttpError(400, 'VALIDATION_FAILED', 'The span must hold at least two frames');
		if (facts.frameCount !== null && a > facts.frameCount - 2)
			throw new HttpError(400, 'VALIDATION_FAILED', "The span starts at or after the media's last frame");
		const ok = this.available();
		if (!ok.ok) throw new HttpError(409, 'CAMTRACK_UNAVAILABLE', ok.reason);
		const frames = b - a + 1;
		const input: CamTrackJobInput = { request: req, file, display: facts.display, rate: facts.rate };
		const key = createHash('sha256').update(JSON.stringify(req)).digest('hex').slice(0, 32);
		return this.core.queue.submit({
			kind: 'camtrack',
			title: `3D Camera Tracker – ${rec.originalName} (${frames} frames)`,
			priority: 'user',
			cpuSlots: 2,
			minSlots: 1,
			origin,
			assetId: req.mediaKey,
			...(req.projectId ? { projectId: req.projectId } : {}),
			dedupeKey: `camtrack:${key}`,
			input,
			stage: 'Queued',
		});
	}

	private async tracksCache(req: CamTrackSolveRequest): Promise<string> {
		const dir = join(this.core.config.paths.cacheDir, 'camtrack');
		await mkdir(dir, { recursive: true });
		const key = createHash('sha256')
			.update(JSON.stringify(['camtrack-tracks@1', req.mediaKey, req.span, req.settings.detailed]))
			.digest('hex')
			.slice(0, 32);
		return join(dir, `${key}.json`);
	}

	private async run(ctx: JobContext): Promise<CamTrackResult> {
		const input = ctx.input as CamTrackJobInput;
		const req = input.request;
		const ffmpeg = this.core.ffmpeg.bins.ffmpeg;
		if (!ffmpeg) throw new JobError('BINARY_MISSING', 'ffmpeg was not found', false);
		const spec: CamTrackJobSpec = {
			ffmpeg,
			file: input.file,
			rate: input.rate,
			display: input.display,
			span: [req.span[0], req.span[1]],
			settings: { ...req.settings },
			deleted: req.deleted ?? [],
			tracksCache: await this.tracksCache(req),
		};
		const t0 = performance.now();
		const out = await this.runWorker(ctx, spec);
		const s = out.solve;
		const frames: number[] = [];
		for (const f of s.frames)
			frames.push(...f.rot.map(r6), ...f.center.map(r6), Math.round(f.focal * 1e3) / 1e3, f.solved ? 1 : 0);
		ctx.log(
			`camtrack: ${out.tracks} tracks, ${s.points.length} points, ${s.methodUsed}, error ${s.averageError.toFixed(3)} px, ${((performance.now() - t0) / 1000).toFixed(1)} s`,
		);
		return {
			...(req.clipId ? { clipId: req.clipId } : {}),
			...(req.trackerId ? { trackerId: req.trackerId } : {}),
			mediaKey: req.mediaKey,
			span: [req.span[0], req.span[1]],
			rate: input.rate,
			size: [input.display.width, input.display.height],
			shot: s.shot,
			methodUsed: s.methodUsed,
			averageError: Math.round(s.averageError * 1e4) / 1e4,
			frames,
			points: s.points.map((p) => ({
				id: p.id,
				pos: [r6(p.pos[0]), r6(p.pos[1]), r6(p.pos[2])],
				error: Math.round(p.error * 1e4) / 1e4,
				first: req.span[0] + p.first,
				last: req.span[0] + p.last,
			})),
			distortion: s.distortion,
			tracks: out.tracks,
			method: CAMTRACK_METHOD,
		};
	}

	private async runWorker(ctx: JobContext, spec: CamTrackJobSpec): Promise<CamTrackJobOutput> {
		const scratch = await ctx.scratchDir();
		const specPath = join(scratch, 'camtrack-spec.json');
		const outPath = join(scratch, 'camtrack-out.json');
		await writeFile(specPath, JSON.stringify(spec));
		const cmd = camtrackCommand(this.env);
		const child = spawn(cmd.command, [...cmd.args, specPath, outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
		ctx.trackChild(child);
		let stderr = '';
		let failure: string | null = null;
		let buf = '';
		child.stdout.on('data', (c: Buffer) => {
			buf += c.toString();
			let nl = buf.indexOf('\n');
			while (nl >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				nl = buf.indexOf('\n');
				if (!line) continue;
				try {
					const ev = JSON.parse(line) as { type: string; fraction?: number; stage?: string; message?: string };
					if (ev.type === 'progress' && typeof ev.fraction === 'number')
						ctx.progress(ev.fraction * 0.99, { stage: ev.stage ?? 'Solving camera' });
					else if (ev.type === 'error') failure = ev.message ?? 'failed';
				} catch {
					ctx.log(line);
				}
			}
		});
		child.stderr.on('data', (c: Buffer) => {
			const t = c.toString();
			if (stderr.length < 8000) stderr += t;
			ctx.log(t.trimEnd());
		});
		const code = await new Promise<number | null>((resolve, reject) => {
			child.on('error', reject);
			child.on('close', (c) => resolve(c));
		});
		if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		if (code !== 0)
			throw new JobError(
				'CAMTRACK_FAILED',
				failure ?? (stderr.trim().split('\n').pop() || `jasper-camtrack exited with ${code}`),
				false,
			);
		return JSON.parse(await readFile(outPath, 'utf8')) as CamTrackJobOutput;
	}
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
