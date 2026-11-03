// Export verification for agents (spec 18 §2.5 AF-VER-001…003; docs/wp-notes/agent-footage-verify.md):
// `verify_export` runs the engine's `export-verify` job on a finished export and returns its rows; `fastVerification`
// gives start_export / wait_for_job the probe-only rows (AF-VER-002). The agent reads the rows instead of claiming the
// export is fine: `format` rows it may fix unasked (export again), `judgement` rows it asks the user about.
import { type ExportVerifyResult, ExportVerifyResultSchema } from '@jasper/api';
import { DELIVERY_TARGET_IDS } from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg } from '../arguments.ts';
import {
	cancelIfAborted,
	defineTool,
	type Extra,
	isTerminal,
	READ_ONLY,
	type ToolContext,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';

/** How long the fast rows may take before start_export / wait_for_job return without them. */
const FAST_TIMEOUT_MS = 60_000;

export const VERIFY_NEXT =
	'Fix a failing `format` row yourself by exporting again. Report `judgement` rows with their timecode and ask before changing the edit. Claim nothing beyond these rows; review at most three times.';

/** What each check measures: the second half of the `export` guide. */
export const VERIFY_GUIDE = `Verifying: rows are {id, kind: "format" | "judgement", status: pass | warn | fail | unverified, measured, expected, tolerance, at?: {sec, frame, timecode}, message}; verified = no fail row and no unverified format row. Kind "format" = what the file is (codec, size, duration, A/V skew, true peak, a platform limit). Kind "judgement" = what the cut does (black or flash frames and clicks at cuts, loudness, silences, platform recommendations). Checks: decode (the file decodes without errors), streams (codec, frame size, frame rate, pixel format, sample rate, channels match the export settings), duration (|file − range| ≤ max(1 frame, 50 ms)), av-skew (audio and video ends within 250 ms), cut-black (a black run ≥ 100 ms within ±2 frames of a cut where the timeline shows a picture — gaps, dark solids, fades and dips are intended black), cut-flash (one frame's luma jumping > 0.25 against both neighbours at a cut; warn when a transition or effect is over the cut), cut-click (a sample step > 12 dB over the local RMS of the steps within ±10 ms of a cut), loudness (BS.1770 integrated loudness within 1.0 LU of the export's normalisation or the target's level), true-peak (≤ ceiling + 0.1 dB; format) and silence (digital silence > 2 s, warn). target (${DELIVERY_TARGET_IDS.join(', ')}) adds the platform delivery rows target-container, target-aspect, target-resolution, target-duration, target-frame-rate, target-size and target-loudness: format rows (fail) where the platform refuses the file outright, judgement rows for its recommendations. checks "fast" probes only (streams, duration, av-skew; what start_export and wait_for_job already return).`;

/** The probe-only verification of a finished export (streams, duration, A/V skew), or why it is missing. */
export async function fastVerification(
	ctx: ToolContext,
	exportJobId: string,
	extra?: Extra,
): Promise<
	| { output: ExportVerifyResult['output']; rows: ExportVerifyResult['rows']; verified: boolean }
	| { verificationError: string }
> {
	try {
		const job = await ctx.engine((c) => c.verifyExport(exportJobId, { checks: 'fast' }));
		const { job: done } = await waitJob(ctx, job.id, FAST_TIMEOUT_MS, extra, { cancelJobOnAbort: true });
		if (done.state !== 'succeeded')
			return {
				verificationError: done.error?.message ?? `The verification is ${done.state}: call verify_export.`,
			};
		const r = ExportVerifyResultSchema.safeParse(done.result);
		if (!r.success) return { verificationError: 'The engine returned an unreadable verification' };
		return { output: r.data.output, rows: r.data.rows, verified: r.data.verified };
	} catch (e) {
		return { verificationError: e instanceof Error ? e.message : String(e) };
	}
}

export function registerVerifyTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'verify_export',
		{
			title: 'Verify export',
			description:
				'Measure a finished export (`exportId`: its job id): decode, streams, duration, A/V skew, black or flash frames and clicks at cuts, loudness, true peak, silence. `target` adds a platform\'s limits. `checks: "fast"` probes only.',
			input: {
				projectId: ProjectIdArg,
				exportId: z.string().min(1).max(64).describe('The job id of `start_export`.'),
				target: z.enum(DELIVERY_TARGET_IDS).optional(),
				checks: z.enum(['full', 'fast']).optional().describe('Default full.'),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(900)
					.optional()
					.describe('Default 300; then `wait_for_job`.'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, exportId, target, checks, timeoutSeconds }, extra) => {
			const exportJob = await ctx.engine((c) => c.getJob(exportId));
			if (exportJob.kind !== 'export')
				throw new ToolError(
					'E_INVALID_PARAM',
					`${exportId} is not an export job (${exportJob.kind})`,
					'Pass the jobId start_export returned.',
				);
			if (exportJob.projectId && exportJob.projectId !== projectId)
				throw new ToolError('E_NOT_FOUND', `Export ${exportId} belongs to another project`);
			if (exportJob.state !== 'succeeded')
				throw new ToolError(
					'E_INVALID_PARAM',
					`Export ${exportId} is ${exportJob.state}: only a finished export can be verified`,
					isTerminal(exportJob) ? 'Export again (start_export).' : 'wait_for_job with this jobId first.',
				);
			const job = await ctx.engine((c) =>
				c.verifyExport(exportId, { checks: checks ?? 'full', ...(target ? { target } : {}) }),
			);
			await cancelIfAborted(ctx, extra, job.id);
			const { job: done, timedOut } = await waitJob(ctx, job.id, (timeoutSeconds ?? 300) * 1000, extra);
			if (timedOut)
				return jsonResult({
					jobId: done.id,
					state: done.state,
					timedOut: true,
					next: `The verification is still running: wait_for_job {jobId: "${done.id}"} returns its rows.`,
				});
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'E_INTERNAL',
					done.error?.message ?? `The verification ${done.state}`,
					'Export again if the file is gone; engine_status may help.',
				);
			const r = ExportVerifyResultSchema.safeParse(done.result);
			if (!r.success) throw new ToolError('E_INTERNAL', 'The engine returned an unreadable verification');
			return jsonResult({ jobId: done.id, ...r.data, next: VERIFY_NEXT });
		},
	);
}
