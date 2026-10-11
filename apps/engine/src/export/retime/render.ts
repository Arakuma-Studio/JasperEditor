// The plan's frames are made from decoded media frames —
// Frame Sampling copies frame a, Frame Blending mixes a and b (`blendFrames`), Optical Flow interpolates them in the
// worker pool (`FlowPool`, the CPU kernel the GPU preview matches) — and encoded losslessly (FFV1, BGRA) into a
// layer-sized intermediate that the builder reads as the clip's `layer` override.
import type { ChildProcess } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { blendFrames, type Rational } from '@jasper/project';
import type { Ffmpeg } from '../../tools/ffmpeg.ts';
import { randomId } from '../../tools/fs.ts';
import { terminateTree } from '../../tools/process.ts';
import type { ChunkedFrames } from './frames.ts';
import { pairRuns, type RetimePlan } from './plan.ts';
import type { FlowPool } from './pool.ts';

export class RetimeRenderError extends Error {
	constructor(
		readonly code: 'JOB_CANCELLED' | 'TOOL_FAILED',
		message: string,
	) {
		super(message);
		this.name = 'RetimeRenderError';
	}
}

export type RetimeRenderJob = {
	plan: RetimePlan;
	frames: ChunkedFrames;
	width: number;
	height: number;
	fps: Rational;
	output: string;
	pool: FlowPool | null;
	signal: AbortSignal;
	threads: number;
	onProgress?(done: number, total: number): void;
};

/** FFV1 (lossless) BGRA intermediate from raw RGBA on stdin. */
export function encoderArgs(
	o: { width: number; height: number; fps: Rational; threads: number },
	output: string,
): string[] {
	return [
		'-y',
		'-f',
		'rawvideo',
		'-pix_fmt',
		'rgba',
		'-s',
		`${o.width}x${o.height}`,
		'-r',
		`${o.fps.num}/${o.fps.den}`,
		'-i',
		'pipe:0',
		'-map',
		'0:v',
		'-c:v',
		'ffv1',
		'-level',
		'3',
		'-pix_fmt',
		'bgra',
		'-slices',
		'4',
		'-threads',
		String(Math.max(1, o.threads)),
		'-f',
		'matroska',
		output,
	];
}

/** Renders the plan into `job.output` (atomically). */
export async function renderRetimeLayer(ff: Ffmpeg, job: RetimeRenderJob): Promise<void> {
	const { plan, frames: src, width: W, height: H } = job;
	const total = plan.frames.length;
	if (total === 0) throw new RetimeRenderError('TOOL_FAILED', 'retime: no frames to render');
	const tmp = `${job.output}.${randomId('part', 6)}.tmp`;
	const enc: ChildProcess = ff.spawnRaw(
		encoderArgs({ width: W, height: H, fps: job.fps, threads: job.threads }, tmp),
		{
			stdin: 'pipe',
			signal: job.signal,
		},
	);
	let encStderr = '';
	enc.stderr?.setEncoding('utf8').on('data', (c: string) => {
		encStderr = (encStderr + c).slice(-4000);
	});
	enc.stdout?.resume();
	const closed = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve) =>
		enc.on('close', (code, sig) => resolve({ code, sig })),
	);
	let encError: Error | null = null;
	enc.on('error', (e) => {
		encError = e;
	});
	enc.stdin!.on('error', (e) => {
		encError = e;
	});
	const write = (buf: Uint8Array) =>
		new Promise<void>((resolve, reject) => {
			if (encError) return reject(encError);
			enc.stdin!.write(buf, (e) => (e ? reject(e) : resolve()));
		});
	try {
		let written = 0;
		const runs = pairRuns(plan.frames);
		// Optical flow runs are computed ahead in the pool (bounded window), written in order.
		const window = Math.max(1, (job.pool?.size ?? 1) * 2);
		const pendingFlow = new Map<number, Promise<Uint8Array[]>>();
		const startFlow = async (r: number) => {
			const run = runs[r]!;
			if (pendingFlow.has(r) || !job.pool || run.a === run.b || plan.interpolation !== 'optical-flow') return;
			const ws = plan.frames.slice(run.from, run.to).map((f) => f.w);
			const a = await src.get(run.a);
			const b = await src.get(run.b);
			pendingFlow.set(r, job.pool.run(`${run.a}|${run.b}`, a, b, W, H, ws));
		};
		const blendOut = new Uint8Array(W * H * 4);
		for (let r = 0; r < runs.length; r++) {
			if (job.signal.aborted) throw new RetimeRenderError('JOB_CANCELLED', 'retime cancelled');
			for (let q = r; q < Math.min(runs.length, r + window); q++) await startFlow(q);
			const run = runs[r]!;
			if (run.a === run.b) {
				const a = await src.get(run.a);
				for (let i = run.from; i < run.to; i++) {
					await write(a);
					job.onProgress?.(++written, total);
				}
				continue;
			}
			if (plan.interpolation === 'optical-flow' && job.pool) {
				const outs = await pendingFlow.get(r)!;
				pendingFlow.delete(r);
				for (const o of outs) {
					await write(o);
					job.onProgress?.(++written, total);
				}
				continue;
			}
			const a = await src.get(run.a);
			const b = await src.get(run.b);
			const fa = { width: W, height: H, data: a };
			const fb = { width: W, height: H, data: b };
			for (let i = run.from; i < run.to; i++) {
				blendFrames(fa, fb, plan.frames[i]!.w, { data: blendOut });
				await write(blendOut.slice());
				job.onProgress?.(++written, total);
			}
		}
		enc.stdin!.end();
		const { code, sig } = await closed;
		if (job.signal.aborted) throw new RetimeRenderError('JOB_CANCELLED', 'retime cancelled');
		if (code !== 0)
			throw new RetimeRenderError(
				'TOOL_FAILED',
				`retime encoder exited ${code ?? sig}: ${encStderr.trim().slice(-1500)}`,
			);
		await rename(tmp, job.output);
	} catch (e) {
		if (enc.exitCode === null && enc.signalCode === null) await terminateTree(enc, 500);
		await rm(tmp, { force: true }).catch(() => {});
		if (e instanceof RetimeRenderError) throw e;
		if (job.signal.aborted) throw new RetimeRenderError('JOB_CANCELLED', 'retime cancelled');
		throw new RetimeRenderError('TOOL_FAILED', `retime: ${(e as Error).message}`);
	}
}
