// Warp Stabilizer ▸ the background analysis (workstream gaps, docs/wp-notes/gaps.md §FX-6): job `warp-analysis`.
// ffmpeg decodes the clip's source frames to gray at the analysis size (≤ 480 px on the long side, 960 with Detailed
// Analysis), one tracking worker runs the `warp` tracker over them in order (tracking/warp.ts: per-frame
// translation / similarity / homography and feature trajectories) and the result is converted to media px, the
// trajectories assembled (≥ 6 frames, 0.1 px, within the project-file budget) and returned as the analysis the effect
// stores (`effect.setWarpAnalysis`).
import { createHash } from 'node:crypto';
import type { EngineJob, WarpAnalysisRequest, WarpAnalysisResult } from '@jasper/api';
import { WARP_FRAME_STRIDE, WARP_MAX_TRACK_POINTS } from '@jasper/project';
import { type JobContext, JobError } from '../jobs/types.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';
import { readFrames, spawnDecoder } from '../tracking/decode.ts';
import * as G from '../tracking/geometry.ts';
import { acquireWorker, openCvPath, releaseWorker } from '../tracking/worker.ts';
import type { WarpConfig } from '../tracking/warp.ts';

type Input = {
	request: WarpAnalysisRequest;
	file: string;
	display: { width: number; height: number };
	fps: { num: number; den: number };
	frameCount: number | null;
};

const IN_FLIGHT = 4;

/** Analysis size: the long side capped (480, or 960 with Detailed Analysis), even dimensions. */
export function warpAnalysisSize(width: number, height: number, detailed: boolean) {
	const cap = detailed ? 960 : 480;
	const k = Math.min(1, cap / Math.max(width, height));
	let w = Math.max(16, Math.round(width * k));
	let h = Math.max(16, Math.round(height * k));
	w += w % 2;
	h += h % 2;
	return { width: w, height: h, sx: width / w, sy: height / h, scale: w !== width || h !== height };
}

/** A row-major homography in tracking px → media px (pixel centres): A⁻¹·H·A. */
function toMediaH(h: number[], sx: number, sy: number): number[] {
	const A = [1 / sx, 0, 0.5 / sx - 0.5, 0, 1 / sy, 0.5 / sy - 0.5, 0, 0, 1];
	const Ainv = [sx, 0, 0.5 * sx - 0.5, 0, sy, 0.5 * sy - 0.5, 0, 0, 1];
	return G.hNormalize(G.hMul(G.hMul(Ainv, h), A));
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r1 = (v: number) => Math.round(v * 10) / 10;

export class WarpAnalysisService {
	constructor(private readonly core: CoreServices) {}

	registerRunner(): void {
		this.core.queue.registerRunner('warp-analysis', (ctx) => this.run(ctx));
	}

	async submit(r: WarpAnalysisRequest): Promise<EngineJob> {
		try {
			openCvPath();
		} catch {
			throw new HttpError(503, 'CAPABILITY_UNAVAILABLE', 'OpenCV.js is not installed: the analysis cannot run');
		}
		const rec = this.core.registry.get(r.mediaKey);
		if (!rec) throw new HttpError(404, 'ASSET_NOT_FOUND', `Unknown media key ${r.mediaKey}`);
		const file = await this.core.registry.resolvePath(r.mediaKey);
		if (!file) throw new HttpError(404, 'ASSET_NOT_FOUND', 'The media file is offline');
		const vs = rec.probe.streams.find((s) => s.type === 'video');
		if (vs?.type !== 'video') throw new HttpError(400, 'VALIDATION_FAILED', 'The media has no video stream');
		if (rec.probe.streams.length && (vs as { stillImage?: boolean }).stillImage)
			throw new HttpError(400, 'VALIDATION_FAILED', 'A still image has no motion to stabilise');
		const display = rec.display ?? { width: vs.width, height: vs.height };
		const fps = { num: vs.frameRate.num, den: vs.frameRate.den };
		if (!(fps.num > 0 && fps.den > 0)) throw new HttpError(400, 'VALIDATION_FAILED', 'The video has no frame rate');
		const frameCount =
			rec.durationSec && fps.num > 0 ? Math.max(1, Math.round((rec.durationSec * fps.num) / fps.den)) : null;
		if (frameCount !== null && r.startFrame >= frameCount)
			throw new HttpError(400, 'VALIDATION_FAILED', `startFrame ${r.startFrame} is past the end of the media`);
		const input: Input = { request: r, file, display, fps, frameCount };
		return this.core.queue.submit({
			kind: 'warp-analysis',
			title: `Warp Stabilizer: analyse ${r.frameCount} frames`,
			priority: 'user',
			cpuSlots: 1,
			minSlots: 1,
			...(r.projectId ? { projectId: r.projectId } : {}),
			dedupeKey: `warp:${createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 32)}`,
			input,
			stage: 'Analyzing in background (step 1 of 2)',
		});
	}

	private async run(ctx: JobContext): Promise<WarpAnalysisResult> {
		const input = ctx.input as Input;
		const r = input.request;
		const size = warpAnalysisSize(input.display.width, input.display.height, r.detailed);
		const count = input.frameCount === null ? r.frameCount : Math.min(r.frameCount, input.frameCount - r.startFrame);
		const cfg: WarpConfig = {
			kind: 'warp',
			width: size.width,
			height: size.height,
			maxFeatures: r.detailed ? 700 : 350,
			qualityLevel: 0.01,
			minDistance: Math.max(4, Math.min(16, Math.max(size.width, size.height) / 40)),
			winSize: 15,
			maxLevel: 3,
			fbMax: 0.75,
			threshold: 1,
		};
		const worker = acquireWorker();
		const signal = ctx.signal;
		const onAbort = () => worker.terminate();
		signal.addEventListener('abort', onAbort, { once: true });
		const perFrame: number[][] = [];
		let ok = false;
		const t0 = performance.now();
		try {
			ctx.progress(0, { stage: 'Analyzing in background (step 1 of 2)' });
			await worker.ready;
			await worker.call({ type: 'init', cfg });
			const child = spawnDecoder(
				this.core.ffmpeg,
				{
					file: input.file,
					start: r.startFrame,
					count,
					fps: input.fps,
					width: size.width,
					height: size.height,
					scale: size.scale,
				},
				{ signal, onSpawn: (c) => ctx.trackChild(c) },
			);
			const inflight: Promise<void>[] = [];
			let frame = 0;
			for await (const buf of readFrames(child, size.width * size.height, signal)) {
				const i = frame++;
				const ab = buf.buffer as ArrayBuffer;
				const p = worker
					.result({ type: i === 0 ? 'reference' : 'frame', frame: i, buf: ab }, [ab])
					.then((res) => {
						perFrame[i] = res.values;
						ctx.progress(Math.min(0.99, perFrame.filter(Boolean).length / count), {
							stage: `Analyzing in background (step 1 of 2): frame ${i + 1}/${count}`,
						});
					});
				p.catch(() => undefined);
				inflight.push(p);
				while (inflight.length >= IN_FLIGHT) await inflight.shift();
			}
			await Promise.all(inflight);
			ok = true;
		} catch (e) {
			if (signal.aborted) throw new JobError('JOB_CANCELLED', 'Analysis cancelled');
			if (e instanceof JobError) throw e;
			const code = (e as { code?: string }).code;
			if (code === 'TOOL_FAILED' || code === 'BINARY_MISSING') throw e;
			throw new JobError('WARP_ANALYSIS_FAILED', (e as Error).message ?? String(e), false);
		} finally {
			signal.removeEventListener('abort', onAbort);
			if (ok) void releaseWorker(worker);
			else worker.terminate();
		}
		const n = perFrame.length;
		if (n < 2) throw new JobError('WARP_ANALYSIS_FAILED', 'The clip has fewer than two frames to analyse', false);
		ctx.progress(0.995, { stage: 'Stabilizing (step 2 of 2)' });
		return buildWarpAnalysis(perFrame, {
			size,
			display: input.display,
			fps: input.fps,
			startFrame: r.startFrame,
			detailed: r.detailed,
			...(r.mediaId ? { mediaId: r.mediaId } : {}),
			seconds: (performance.now() - t0) / 1000,
		});
	}
}

/** Converts the worker's per-frame values (tracking px) into the stored analysis (media px). Exported for tests. */
export function buildWarpAnalysis(
	perFrame: number[][],
	o: {
		size: { sx: number; sy: number };
		display: { width: number; height: number };
		fps: { num: number; den: number };
		startFrame: number;
		detailed: boolean;
		mediaId?: string;
		seconds?: number;
	},
): WarpAnalysisResult {
	const { sx, sy } = o.size;
	const frames: number[] = [];
	let inl = 0;
	let feat = 0;
	const open = new Map<number, { start: number; pts: number[] }>();
	const done: { start: number; pts: number[] }[] = [];
	perFrame.forEach((v, k) => {
		const t = [v[0]! * sx, v[1]! * sy];
		const S = toMediaH([v[2]!, -v[3]!, v[4]!, v[3]!, v[2]!, v[5]!, 0, 0, 1], sx, sy);
		let Hm = toMediaH([...v.slice(6, 14), 1], sx, sy);
		// A wild projective fit (few features): keep the similarity (effectcraft's sanity rule, in media px).
		if (!(Math.abs(Hm[6]!) < 0.01 && Math.abs(Hm[7]!) < 0.01) || !Hm.every(Number.isFinite)) Hm = S;
		if (k === 0) frames.push(0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0);
		else frames.push(...t.map(r6), ...[S[0]!, S[3]!, S[2]!, S[5]!].map(r6), ...Hm.slice(0, 8).map((x) => r6(x)));
		if (k > 0) {
			inl += v[14]!;
			feat += v[15]!;
		}
		const np = v[16]!;
		const seen = new Set<number>();
		for (let i = 0; i < np; i++) {
			const id = v[17 + 3 * i]!;
			const [x, y] = G.toMediaPx([v[18 + 3 * i]!, v[19 + 3 * i]!], sx, sy) as [number, number];
			seen.add(id);
			let tr = open.get(id);
			if (!tr) {
				tr = { start: k, pts: [] };
				open.set(id, tr);
			}
			tr.pts.push(r1(x), r1(y));
		}
		for (const [id, tr] of open)
			if (!seen.has(id)) {
				done.push(tr);
				open.delete(id);
			}
	});
	done.push(...open.values());
	// Short trajectories hardly constrain the subspace; keep the longest within the budget.
	const long = done.filter((t) => t.pts.length / 2 >= 6).sort((a, b) => b.pts.length - a.pts.length);
	const tracks: { start: number; pts: number[] }[] = [];
	let budget = WARP_MAX_TRACK_POINTS;
	for (const t of long) {
		if (t.pts.length / 2 > budget) continue;
		budget -= t.pts.length / 2;
		tracks.push(t);
	}
	tracks.sort((a, b) => a.start - b.start);
	const frameDuration = o.fps.den / o.fps.num;
	const body = {
		version: 1 as const,
		...(o.mediaId ? { mediaId: o.mediaId } : {}),
		start: o.startFrame * frameDuration,
		frameDuration,
		size: [o.display.width, o.display.height] as [number, number],
		detailed: o.detailed,
		frames,
		tracks,
		confidence: feat ? Math.round((inl / feat) * 1000) / 1000 : 0,
		analyzedAt: new Date().toISOString(),
	};
	const key = createHash('sha256')
		.update(JSON.stringify([body.start, body.frameDuration, body.size, frames, tracks.length]))
		.digest('hex')
		.slice(0, 24);
	if (frames.length !== perFrame.length * WARP_FRAME_STRIDE) throw new Error('warp analysis: frame records');
	return {
		...body,
		key: `warp-${key}`,
		analysedFrames: perFrame.length,
		...(o.seconds && o.seconds > 0 ? { framesPerSec: Math.round((perFrame.length / o.seconds) * 10) / 10 } : {}),
	};
}
