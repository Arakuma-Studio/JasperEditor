// Picture motion analysis (spec 12 §2.2 "pixel motion curve", §2.8 `POST /api/sound-design/motion` → job
// `motion-analysis`, P6-R2; wp-note "Phase 6 → WP6.2"). What footage does on screen is not in the edit: the engine
// renders the sequence's PICTURE through the export planner (the same paths, fallbacks and blockers as an export:
// what the Program monitor shows) at a small size (long side 128 px, H.264 intra, picture only), decodes it to gray and
// measures every frame against the one before (`measureFrameMotion`: frame difference + block matching). The curve
// (speed in screen diagonals per second, the keyframe source's unit; direction; moving area; centre x; unexplained
// change) and its events (`pixelMotionEvents`: moves, landings, cuts) are cached by the picture's fingerprint — the
// hashes of the render-preview segments over the range (any picture edit changes one) — so asking again is instant.
//
// Bounded: at most 10 minutes per analysis (MOTION_ANALYSIS_LIMITS.maxSeconds; the cue route analyses longer ranges
// in 10-minute windows); cancellable (the render and the decode are child processes of the job); progress: render
// 0–75 %, measure 75–100 %.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
	type EngineJob,
	type EnvelopeJson,
	type ExportStartRequest,
	MOTION_ANALYSIS_LIMITS,
	type MotionAnalysisResult,
	MotionAnalysisResultSchema,
	type MotionEvent,
} from '@jasper/api';
import {
	makeEnvelope,
	measureFrameMotion,
	type PixelMotionCurve,
	type ProjectDocument,
	pixelAnalysisSize,
	pixelMotionEvents,
	previewSegments,
	type Rational,
	type Sequence,
	sequenceDuration,
	sequenceTimecode,
} from '@jasper/project';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { CoreServices } from '../tools/services.ts';
import { AnalysisCache } from './analysis-cache.ts';

/** Bump when the measurement changes (older cached curves are not reused). */
export const MOTION_VERSION = 1;

export class MotionInputError extends Error {
	constructor(
		readonly code: 'RANGE_EMPTY' | 'RANGE_TOO_LONG',
		message: string,
	) {
		super(message);
	}
}

/** What one analysis covers: the clamped range, the analysis size and the picture's fingerprint. */
export type MotionPlan = {
	sequenceId: string;
	range: { start: number; end: number };
	width: number;
	height: number;
	rate: Rational;
	fingerprint: string;
};

export type MotionJobInput = {
	projectId: string | null;
	envelope: EnvelopeJson;
	plan: MotionPlan;
};

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Longest analysed range (frames) at a rate. */
export function maxMotionFrames(rate: Rational): number {
	return Math.max(1, Math.floor((MOTION_ANALYSIS_LIMITS.maxSeconds * rate.num) / rate.den));
}

/** The range, size and fingerprint of an analysis of `seq` (throws MotionInputError for an empty / too long range). */
export function planMotion(
	doc: ProjectDocument,
	seq: Sequence,
	range?: { start: number; end: number },
): MotionPlan {
	const rate = seq.settings.frameRate as Rational;
	const duration = Math.max(0, Math.ceil(sequenceDuration(seq)));
	const start = Math.max(0, Math.floor(range?.start ?? 0));
	const end = Math.min(duration, Math.ceil(range?.end ?? duration));
	if (!(end - start >= 2))
		throw new MotionInputError(
			'RANGE_EMPTY',
			`Nothing to analyse in this range (the sequence has ${duration} frames)`,
		);
	if (end - start > maxMotionFrames(rate))
		throw new MotionInputError(
			'RANGE_TOO_LONG',
			`Picture motion is analysed ${MOTION_ANALYSIS_LIMITS.maxSeconds / 60} minutes at a time: analyse a shorter range`,
		);
	const { width, height } = pixelAnalysisSize(
		seq.settings.width,
		seq.settings.height,
		MOTION_ANALYSIS_LIMITS.size,
	);
	// The picture's identity over the range: the render-preview segments' content hashes and where they sit.
	const segments = previewSegments(doc, seq.id)
		.filter((s) => s.startFrame < end && s.startFrame + s.frames > start)
		.map((s) => [s.startFrame, s.frames, s.hash]);
	const fingerprint = createHash('sha256')
		.update(
			JSON.stringify([
				MOTION_VERSION,
				width,
				height,
				rate.num,
				rate.den,
				seq.settings.width,
				seq.settings.height,
				start,
				end,
				segments,
			]),
		)
		.digest('hex')
		.slice(0, 40);
	return { sequenceId: seq.id, range: { start, end }, width, height, rate, fingerprint };
}

/** Sequence frames inside the range where a shown video track's clips start or end (edit points). */
export function editFrames(seq: Sequence, range: { start: number; end: number }): number[] {
	const shown = new Set(seq.videoTracks.filter((t) => t.output !== false).map((t) => t.id));
	const out = new Set<number>();
	for (const c of Object.values(seq.clips)) {
		if (!shown.has(c.trackId) || c.enabled === false || c.kind === 'adjustment') continue;
		for (const f of [c.start, c.start + c.duration]) if (f > range.start && f < range.end) out.add(f);
	}
	return [...out].sort((a, b) => a - b);
}

/** A job context whose progress maps into `[from, to]` of the parent's (inline analyses inside another job). */
export function subContext(ctx: JobContext, from: number, to: number, label?: string): JobContext {
	return {
		get job() {
			return ctx.job;
		},
		input: ctx.input,
		signal: ctx.signal,
		slots: ctx.slots,
		progress: (p, extra) =>
			ctx.progress(p === null ? null : from + (to - from) * Math.max(0, Math.min(1, p)), {
				...extra,
				...(label && extra?.stage ? { stage: `${label}: ${extra.stage}` } : label ? { stage: label } : {}),
			}),
		trackChild: (c) => ctx.trackChild(c),
		addPartial: (p) => ctx.addPartial(p),
		scratchDir: () => ctx.scratchDir(),
		log: (t) => ctx.log(t),
	};
}

export class MotionService {
	private readonly cache: AnalysisCache<MotionAnalysisResult>;

	constructor(
		private readonly core: Pick<CoreServices, 'queue' | 'exports' | 'ffmpeg'>,
		cacheDir: string,
	) {
		this.cache = new AnalysisCache(cacheDir, MotionAnalysisResultSchema, { max: 300, memory: 8 });
	}

	registerRunner(): void {
		this.core.queue.registerRunner('motion-analysis', (ctx) => this.run(ctx));
	}

	/** The cached analysis of a plan (null: not analysed yet), for `projectId`. */
	async cached(plan: MotionPlan, projectId: string | null): Promise<MotionAnalysisResult | null> {
		const hit = await this.cache.get(plan.fingerprint);
		return hit
			? { ...hit, projectId: projectId ?? hit.projectId, sequenceId: plan.sequenceId, cached: true }
			: null;
	}

	/** Starts (or joins: same fingerprint) a `motion-analysis` job. */
	submit(
		doc: ProjectDocument,
		plan: MotionPlan,
		opts: { projectId: string | null; origin?: EngineJob['origin']; revision?: number },
	): EngineJob {
		const seconds = ((plan.range.end - plan.range.start) * plan.rate.den) / plan.rate.num;
		const input: MotionJobInput = {
			projectId: opts.projectId,
			envelope: makeEnvelope(doc, {
				revision: opts.revision ?? 0,
				savedAt: new Date().toISOString(),
				platform: 'engine',
			}) as unknown as EnvelopeJson,
			plan,
		};
		return this.core.queue.submit({
			kind: 'motion-analysis',
			title: `Picture motion analysis (${seconds.toFixed(1)} s)`,
			priority: seconds <= 60 ? 'interactive' : 'user',
			// the render is an export (its threads follow the slots): half the machine, starting with whatever is free
			cpuSlots: Math.max(2, Math.ceil(this.core.queue.totalSlots / 2)),
			minSlots: 1,
			...(opts.origin ? { origin: opts.origin } : {}),
			...(opts.projectId ? { projectId: opts.projectId } : {}),
			dedupeKey: `motion-analysis:${plan.fingerprint}`,
			input,
			stage: 'Waiting',
		});
	}

	/**
	 * Analyses inside another job (the Sound Design plan job): no queue entry of its own (a job never waits for a slot
	 * another job holds). Cached like a job's result.
	 */
	async analyzeInline(
		ctx: JobContext,
		doc: ProjectDocument,
		plan: MotionPlan,
		projectId: string | null,
	): Promise<MotionAnalysisResult> {
		const hit = await this.cached(plan, projectId);
		if (hit) return hit;
		const envelope = makeEnvelope(doc, {
			revision: 0,
			savedAt: new Date().toISOString(),
			platform: 'engine',
		}) as unknown as EnvelopeJson;
		return this.analyze(ctx, { projectId, envelope, plan });
	}

	private async run(ctx: JobContext): Promise<MotionAnalysisResult> {
		const input = ctx.input as MotionJobInput;
		if (!input?.plan?.fingerprint || !input.envelope)
			throw new JobError('BAD_REQUEST', 'Not a motion analysis request', false);
		const hit = await this.cached(input.plan, input.projectId);
		if (hit) return hit;
		return this.analyze(ctx, input);
	}

	private async analyze(ctx: JobContext, input: MotionJobInput): Promise<MotionAnalysisResult> {
		const { plan } = input;
		const t0 = Date.now();
		const fps = plan.rate.num / plan.rate.den;
		const frames = plan.range.end - plan.range.start;
		const { width: W, height: H } = plan;
		const doc = input.envelope.document as unknown as ProjectDocument;
		const seq = doc.sequences?.[plan.sequenceId];
		if (!seq) throw new JobError('SEQUENCE_NOT_FOUND', `Sequence not found: ${plan.sequenceId}`, false);
		const dir = await ctx.scratchDir();
		const output = join(dir, `motion-${plan.fingerprint.slice(0, 12)}.mp4`);
		const kbps = Math.round((W * H * fps * 3) / 1000);
		const req: ExportStartRequest = {
			envelope: input.envelope,
			sequenceId: plan.sequenceId,
			settings: {
				sequenceId: plan.sequenceId,
				range: { type: 'custom', startFrame: plan.range.start, endFrame: plan.range.end },
				container: 'mp4',
				video: {
					codec: 'h264',
					width: W,
					height: H,
					frameRate: { num: plan.rate.num, den: plan.rate.den },
					scaling: 'stretch',
					quality: { mode: 'crf', value: 10 },
					bitrateKbps: Math.min(500_000, Math.max(100, kbps)),
					encoderSpeed: 'fast',
					keyframeInterval: 1,
				},
				engine: 'auto',
				destination: { type: 'download' },
				videoOnly: true,
				smartRender: false,
			},
		} as ExportStartRequest;
		ctx.progress(0, { stage: 'Rendering the picture' });
		ctx.addPartial(output);
		const rendered = await this.core.exports.renderToFile(
			subContext(ctx, 0, 0.75, 'Rendering the picture'),
			req,
			output,
		);
		const tRender = Date.now();
		if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Picture motion analysis cancelled');
		ctx.progress(0.75, { stage: 'Measuring motion' });
		const curve = await this.measure(ctx, output, W, H, frames, fps);
		const warnings = rendered.warnings.map((w) => ({ code: w.code, message: w.message }));
		if (curve.decoded < frames)
			warnings.push({
				code: 'W_FRAMES_SHORT',
				message: `The render had ${curve.decoded} of ${frames} frames; the rest measure as still`,
			});
		const edits = editFrames(seq, plan.range);
		const pc: PixelMotionCurve = {
			startFrame: plan.range.start,
			fps,
			width: W,
			height: H,
			speed: curve.speed,
			vx: curve.vx,
			vy: curve.vy,
			area: curve.area,
			cx: curve.cx,
			residual: curve.residual,
		};
		const events: MotionEvent[] = pixelMotionEvents(pc, { edits }).map((e) => {
			const base = { kind: e.kind, frame: e.frame, timecode: sequenceTimecode(seq, e.frame) };
			if (e.kind === 'move')
				return {
					...base,
					start: e.start,
					end: e.end,
					peakSpeed: r4(e.peakSpeed),
					area: r4(e.area),
					global: e.global,
					direction: e.direction,
					pan: e.pan,
					...(e.panSweep ? { panSweep: e.panSweep } : {}),
				};
			if (e.kind === 'land')
				return { ...base, how: e.how, energy: r4(e.energy), area: r4(e.area), pan: e.pan };
			return { ...base, residual: r4(e.residual) };
		});
		const tEnd = Date.now();
		const result: MotionAnalysisResult = {
			projectId: input.projectId ?? '',
			sequenceId: plan.sequenceId,
			fingerprint: plan.fingerprint,
			range: plan.range,
			frameRate: { num: plan.rate.num, den: plan.rate.den },
			frames,
			cached: false,
			renderPath: rendered.renderPath,
			curve: {
				startFrame: plan.range.start,
				fps,
				width: W,
				height: H,
				speed: Array.from(curve.speed, r4),
				vx: Array.from(curve.vx, r4),
				vy: Array.from(curve.vy, r4),
				area: Array.from(curve.area, r4),
				cx: Array.from(curve.cx, r4),
				residual: Array.from(curve.residual, r4),
				diff: Array.from(curve.diff, r4),
			},
			events,
			edits,
			timings: { renderMs: tRender - t0, analyseMs: tEnd - tRender, totalMs: tEnd - t0 },
			warnings,
		};
		ctx.log(
			`motion-analysis: ${frames} frames ${W}x${H} via ${rendered.renderPath}, render ${tRender - t0} ms, measure ${tEnd - tRender} ms, ${events.length} events`,
		);
		await this.cache.put(plan.fingerprint, result).catch((e) => ctx.log(`motion cache write failed: ${e}`));
		ctx.progress(1, { stage: `${events.length} motion events` });
		return result;
	}

	/** Decodes the rendered picture to gray and measures each frame against the previous one. */
	private async measure(
		ctx: JobContext,
		file: string,
		W: number,
		H: number,
		frames: number,
		fps: number,
	): Promise<{
		speed: Float32Array;
		vx: Float32Array;
		vy: Float32Array;
		area: Float32Array;
		cx: Float32Array;
		residual: Float32Array;
		diff: Float32Array;
		decoded: number;
	}> {
		const speed = new Float32Array(frames);
		const vx = new Float32Array(frames);
		const vy = new Float32Array(frames);
		const area = new Float32Array(frames);
		const cx = new Float32Array(frames).fill(0.5);
		const residual = new Float32Array(frames);
		const diff = new Float32Array(frames);
		const diag = Math.hypot(W, H);
		const k = fps / diag;
		const args = [
			'-i',
			file,
			...['-map', '0:v:0', '-an', '-sn', '-dn'],
			...['-vf', `scale=${W}:${H}:flags=area,format=gray`],
			...[
				'-fps_mode',
				'passthrough',
				'-frames:v',
				String(frames),
				'-f',
				'rawvideo',
				'-pix_fmt',
				'gray',
				'pipe:1',
			],
		];
		const child = this.core.ffmpeg.spawnRaw(args, { signal: ctx.signal });
		ctx.trackChild(child);
		const size = W * H;
		let prev: Uint8Array | null = null;
		let cur = new Uint8Array(size);
		let filled = 0;
		let n = 0;
		let stderr = '';
		child.stderr?.setEncoding('utf8').on('data', (d: string) => {
			stderr = (stderr + d).slice(-4000);
		});
		await new Promise<void>((resolve, reject) => {
			child.stdout!.on('data', (chunk: Buffer) => {
				let off = 0;
				while (off < chunk.length) {
					const take = Math.min(size - filled, chunk.length - off);
					cur.set(chunk.subarray(off, off + take), filled);
					filled += take;
					off += take;
					if (filled < size) break;
					if (n < frames) {
						if (prev) {
							const m = measureFrameMotion(prev, cur, W, H);
							speed[n] = m.speedPx * k;
							vx[n] = m.vx * k;
							vy[n] = m.vy * k;
							area[n] = m.area;
							cx[n] = m.cx;
							residual[n] = m.residual;
							diff[n] = m.diff;
						}
						n++;
						if (n % 30 === 0)
							ctx.progress(0.75 + (0.25 * n) / frames, { stage: `Measuring frame ${n} of ${frames}` });
					}
					prev = cur;
					cur = new Uint8Array(size);
					filled = 0;
				}
			});
			child.on('error', reject);
			child.on('close', (code, sig) => {
				if (ctx.signal.aborted)
					return reject(new JobError('JOB_CANCELLED', 'Picture motion analysis cancelled'));
				if (code !== 0)
					return reject(new JobError('TOOL_FAILED', `ffmpeg exited ${code ?? sig}: ${stderr.trim()}`, true));
				resolve();
			});
		});
		return { speed, vx, vy, area, cx, residual, diff, decoded: n };
	}
}
