// The `export-verify` job (spec 18 AF-VER-001…003): measures a finished export (its `output.*` and the `verify.json`
// it recorded) and judges it (verify.ts). `fast` probes only (streams, duration, A/V skew); `full` also decodes the
// picture and the sound (decode, cut-black / cut-flash / cut-click, loudness, true peak, silence). A delivery target
// adds its `target-*` rows.
import type { ChildProcess } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type ExportVerifyResult, isAudioOnlyContainer } from '@jasper/api';
import { type DeliveryTargetId, deliveryTarget, isDeliveryTargetId } from '@jasper/project';
import { z } from 'zod';
import type { JobQueue } from '../jobs/queue.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import {
	type FrameLuma,
	type FullMeasurements,
	type JudgeInput,
	judgeExport,
	summarizeRows,
	VERIFY_THRESHOLDS,
	type VerifyChecks,
} from './verify.ts';
import { type ExportVerifyContext, fileOffsetOf, readVerifyContext } from './verify-context.ts';
import { measureAudio, measureVideo, probeOutput } from './verify-measure.ts';

export const EXPORT_JOB_ID_RE = /^job_[0-9a-f]{16}$/;

export const ExportVerifyInputSchema = z.object({
	exportId: z.string().regex(EXPORT_JOB_ID_RE),
	target: z.string().refine(isDeliveryTargetId).optional(),
	checks: z.enum(['fast', 'full']),
});
export type ExportVerifyInput = { exportId: string; target?: DeliveryTargetId; checks: VerifyChecks };

export type ExportVerifyDeps = { ff: Ffmpeg; rendersDir: string; queue: JobQueue };

/** The output file of a finished export job (null when it is gone). */
export async function exportOutputPath(rendersDir: string, exportId: string): Promise<string | null> {
	if (!EXPORT_JOB_ID_RE.test(exportId)) return null;
	try {
		const f = (await readdir(join(rendersDir, exportId))).find((n) => n.startsWith('output.'));
		return f ? join(rendersDir, exportId, f) : null;
	} catch {
		return null;
	}
}

/** What a container holds (exports of builds without a recorded kind): a GIF, an audio-only file or a video file. */
export function deliverableOfContainer(container: unknown): 'video' | 'gif' | 'audio' {
	if (container === 'gif') return 'gif';
	return typeof container === 'string' && isAudioOnlyContainer(container) ? 'audio' : 'video';
}

/** Why a delivery target does not apply to a GIF or an audio-only export (TARGET_NOT_APPLICABLE). */
export function targetRefusal(container: unknown): string {
	const name = typeof container === 'string' ? container.toUpperCase() : 'This';
	return `${name} exports are not platform videos: delivery targets check video files (MP4, MOV, WebM). Verify without a target, or export with a platform preset and verify that.`;
}

/** File frames whose luma the cut checks read: every cut's window and the black-run reach beyond it. */
export function framesAroundCuts(ctx: ExportVerifyContext): Set<number> {
	const seqFps = ctx.fps.num / ctx.fps.den;
	const rate = ctx.expected.video?.frameRate ?? ctx.fps;
	const fps = rate.num / rate.den;
	const reach = VERIFY_THRESHOLDS.cutWindowFrames + Math.ceil(VERIFY_THRESHOLDS.blackMinSec * fps) + 1;
	const keep = new Set<number>();
	for (const c of ctx.cuts) {
		// the file frame of the cut (the file's rate may differ from the sequence's: a GIF, a platform preset)
		const f = Math.round((fileOffsetOf(ctx, c) / seqFps) * fps);
		for (let i = Math.max(0, f - reach); i <= f + reach; i++) keep.add(i);
	}
	return keep;
}

export async function runExportVerify(ctx: JobContext, deps: ExportVerifyDeps): Promise<ExportVerifyResult> {
	const parsed = ExportVerifyInputSchema.safeParse(ctx.input);
	if (!parsed.success) throw new JobError('BAD_REQUEST', 'Invalid export verification input', false);
	const input = parsed.data as ExportVerifyInput;
	const exportJob = deps.queue.get(input.exportId);
	if (exportJob && (exportJob.kind !== 'export' || exportJob.state !== 'succeeded'))
		throw new JobError('EXPORT_NOT_FINISHED', 'Only a finished export can be verified', false);
	const file = await exportOutputPath(deps.rendersDir, input.exportId);
	if (!file)
		throw new JobError(
			'NOT_FOUND',
			'The export file is no longer on the engine (removed or cleaned up): export again to verify.',
			false,
		);
	const context = await readVerifyContext(join(deps.rendersDir, input.exportId));
	const result = (exportJob?.result ?? {}) as { container?: unknown; durationSec?: unknown };
	const kind = context?.deliverable ?? deliverableOfContainer(result.container);
	if (input.target && kind !== 'video')
		throw new JobError('TARGET_NOT_APPLICABLE', targetRefusal(result.container), false);
	const v = await verifyExportFile({
		ff: deps.ff,
		file,
		context,
		fallback: {
			container: typeof result.container === 'string' ? result.container : undefined,
			durationSec: typeof result.durationSec === 'number' ? result.durationSec : undefined,
		},
		target: input.target ?? null,
		checks: input.checks,
		signal: ctx.signal,
		onSpawn: (c) => ctx.trackChild(c),
		progress: (p, stage) => ctx.progress(p, { stage }),
	});
	return {
		exportId: input.exportId,
		checks: input.checks,
		...(input.target ? { target: input.target } : {}),
		...(context ? { sequenceId: context.sequenceId, range: context.range } : {}),
		deliverable: kind,
		...v,
	};
}

/** Measures and judges one exported file (the job's work, without the job). */
export async function verifyExportFile(o: {
	ff: Ffmpeg;
	file: string;
	context: ExportVerifyContext | null;
	fallback?: JudgeInput['fallback'];
	target: DeliveryTargetId | null;
	checks: VerifyChecks;
	signal?: AbortSignal;
	onSpawn?: (c: ChildProcess) => void;
	progress?: (p: number, stage: string) => void;
}): Promise<Pick<ExportVerifyResult, 'output' | 'rows' | 'verified' | 'counts'>> {
	const { context } = o;
	const target = o.target ? deliveryTarget(o.target) : null;
	const run = { signal: o.signal, onSpawn: o.onSpawn };
	o.progress?.(0, 'Probing the file');
	const probed = await probeOutput(o.ff, o.file, run).catch((e: Error) => {
		if (o.signal?.aborted) throw e;
		throw new JobError(
			'UNSUPPORTED_MEDIA',
			`The export file cannot be read: ${e.message}`.slice(0, 800),
			false,
		);
	});
	const output = probed.info;
	let full: FullMeasurements | undefined;
	if (o.checks === 'full') {
		const v = output.streams.find((s) => s.type === 'video');
		const a = output.streams.find((s) => s.type === 'audio');
		const errors: string[] = [];
		let luma = new Map<number, FrameLuma>();
		let videoFrames = 0;
		if (v) {
			o.progress?.(0.1, 'Decoding the picture');
			const keep = context ? framesAroundCuts(context) : new Set<number>();
			const m = await measureVideo(o.ff, o.file, keep, probed.fullRangeVideo, run, probed.rgbVideo);
			luma = m.luma;
			videoFrames = m.frames;
			errors.push(...m.errors);
		}
		let clicks: FullMeasurements['clicks'] = null;
		let loudness: FullMeasurements['loudness'] = null;
		let silences: FullMeasurements['silences'] = [];
		if (a?.sampleRate && a.channels) {
			o.progress?.(0.6, 'Measuring the sound');
			const fps = context ? context.fps.num / context.fps.den : 1;
			const cutSecs = context ? context.cuts.map((c) => fileOffsetOf(context, c) / fps) : [];
			const m = await measureAudio(
				o.ff,
				o.file,
				{ sampleRate: a.sampleRate, channels: a.channels },
				cutSecs,
				run,
			);
			clicks = m.clicks;
			loudness = m.loudness;
			silences = m.silences;
			errors.push(...m.errors);
		} else if (a) errors.push('The audio stream reports no sample rate or channel count');
		full = { decodeErrors: errors, luma, videoFrames, clicks, loudness, silences };
	}
	o.progress?.(0.98, 'Judging');
	const rows = judgeExport({
		checks: o.checks,
		context,
		fallback: o.fallback ?? {},
		output,
		target,
		...(full ? { full } : {}),
	});
	const { verified, counts } = summarizeRows(rows);
	return { output, rows, verified, counts };
}
