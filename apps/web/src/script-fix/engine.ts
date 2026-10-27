// Fix Transcript through the engine (spec 17 SC-090; docs/wp-notes/script-correction.md "Fix job, API and MCP" and
// "Editor UI"): the dry run (a fast `transcript-fix` job without the audio check, waited for) and the proposal (the
// full job followed here and in the Jobs panel; Cancel cancels it). Every failure comes back as a `FixRunError` with
// the engine's code (`E_NO_SOURCE`, `E_NO_TRANSCRIPT`, `E_NO_SPEECH_MODEL`, `E_LIMIT`, a job's error code…), never a
// throw of something else; job results are validated with zod before use.
import type { EngineJob } from '@jasper/api';
import { z } from 'zod';
import { t } from '../i18n/runtime.ts';
import type { FixReportLite, FixScope, FixSource, FixStrictness } from './model.ts';

export type FixRequest = {
	sources: FixSource[];
	scope: FixScope;
	strictness: FixStrictness;
	showRejected: boolean;
};

/** The engine calls Fix Transcript makes (the editor's EngineClient; tests pass a fake). */
export type FixEngine = {
	transcriptFix(
		projectId: string,
		sequenceId: string,
		req: FixRequest & { mode: 'propose' | 'dryRun' },
		opts?: { wait?: boolean; signal?: AbortSignal },
	): Promise<unknown>;
	getJob(jobId: string): Promise<EngineJob>;
	cancelJob(jobId: string): Promise<unknown>;
};

export class FixRunError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
	}
}

const Count = z.number().int().min(0).catch(0);
const Counts = z.record(z.string(), z.number()).catch({});
const MediaReport = z
	.looseObject({
		name: z.string().catch(''),
		words: Count,
		wordsInScope: Count,
		alignment: z
			.looseObject({
				transcriptTokens: z.number().catch(0),
				alignedShare: z.number().catch(0),
				offScriptShare: z.number().catch(0),
			})
			.nullable()
			.catch(null),
		unscored: z.object({ code: z.string(), message: z.string() }).optional().catch(undefined),
	});

/** The parts of `TranscriptFixResult` the editor reads (lenient: an engine may add fields). */
export const FixResultSchema = z
	.looseObject({
		mode: z.enum(['propose', 'dryRun']),
		proposalId: z.string().nullable(),
		itemCount: Count,
		report: z
			.looseObject({
				perMedia: z.array(MediaReport).max(10_000),
				candidates: z
					.looseObject({ total: Count, byGroup: Counts, byCategory: Counts })
					.catch({ total: 0, byGroup: {}, byCategory: {} }),
				skipped: Counts,
				patch: z
					.looseObject({
						edits: Count,
						patched: Count,
						skipped: z
							.array(z.looseObject({ clipId: z.string(), reason: z.string() }))
							.max(10_000)
							.catch([]),
						stale: Count,
					})
					.catch({ edits: 0, patched: 0, skipped: [], stale: 0 }),
				speech: z
					.looseObject({ model: z.string().nullable().catch(null), problem: z.string().optional() })
					.catch({ model: null }),
				estimate: z
					.looseObject({ seconds: z.number(), basis: z.enum(['measured', 'reference']) })
					.optional()
					.catch(undefined),
				warnings: z
					.array(z.looseObject({ code: z.string(), message: z.string() }))
					.max(1000)
					.catch([]),
			}),
	});
export type FixResult = { mode: 'propose' | 'dryRun'; proposalId: string | null; itemCount: number; report: FixReportLite };

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const POLL_MS = 400;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const asError = (e: unknown): FixRunError => {
	if (e instanceof FixRunError) return e;
	const err = e as { code?: string; message?: string; detail?: unknown } | null;
	return new FixRunError(err?.code ?? 'E_ENGINE', err?.message ?? String(e), err?.detail);
};

/** A job snapshot (the route's 202 body or `getJob`), or null when it is not one. */
function jobOf(v: unknown): EngineJob | null {
	const j = v as { id?: unknown; state?: unknown } | null;
	return j && typeof j.id === 'string' && typeof j.state === 'string' ? (v as EngineJob) : null;
}

function resultOf(job: EngineJob): FixResult {
	if (job.state !== 'succeeded') {
		if (job.state === 'cancelled') throw new FixRunError('E_CANCELLED', t('Cancelled'));
		throw new FixRunError(
			job.error?.code ?? 'E_JOB_FAILED',
			job.error?.message ?? t('Fix Transcript failed'),
			(job.error as { detail?: unknown } | undefined)?.detail,
		);
	}
	const parsed = FixResultSchema.safeParse(job.result);
	if (!parsed.success)
		throw new FixRunError('E_BAD_RESULT', t('The engine returned an unreadable Fix Transcript result'));
	return parsed.data as unknown as FixResult;
}

/** Whether this engine offers Fix Transcript (an older engine has no `transcript-fix` route). */
export function canFix(engine: unknown): engine is FixEngine {
	const e = engine as Partial<FixEngine> | null;
	return !!e && typeof e.transcriptFix === 'function' && typeof e.getJob === 'function';
}

/** The dry run: counts, the patch report and an estimate, nothing stored (SC-081). */
export async function dryRunFix(
	engine: FixEngine,
	projectId: string,
	sequenceId: string,
	req: FixRequest,
	signal?: AbortSignal,
): Promise<FixResult> {
	let job: EngineJob | null;
	try {
		job = jobOf(
			await engine.transcriptFix(projectId, sequenceId, { ...req, mode: 'dryRun' }, { wait: true, signal }),
		);
	} catch (e) {
		if (signal?.aborted) throw new FixRunError('E_CANCELLED', t('Cancelled'));
		throw asError(e);
	}
	if (!job) throw new FixRunError('E_BAD_RESULT', t('The engine returned an unreadable Fix Transcript result'));
	// `wait` answers when the job ended; an engine that returned it still running is followed like a proposal
	while (!TERMINAL.has(job.state)) {
		if (signal?.aborted) throw new FixRunError('E_CANCELLED', t('Cancelled'));
		await sleep(POLL_MS);
		try {
			job = await engine.getJob(job.id);
		} catch (e) {
			throw asError(e);
		}
	}
	return resultOf(job);
}

/**
 * The full run: the audio check and ONE `transcript-correction` proposal (SC-081 Run). `onJob` sees every snapshot
 * (progress, stage); aborting `signal` cancels the job (`E_CANCELLED`).
 */
export async function proposeFix(
	engine: FixEngine,
	projectId: string,
	sequenceId: string,
	req: FixRequest,
	opts: { signal?: AbortSignal; onJob?(job: EngineJob): void } = {},
): Promise<FixResult> {
	let job: EngineJob | null;
	try {
		job = jobOf(await engine.transcriptFix(projectId, sequenceId, { ...req, mode: 'propose' }, { signal: opts.signal }));
	} catch (e) {
		if (opts.signal?.aborted) throw new FixRunError('E_CANCELLED', t('Cancelled'));
		throw asError(e);
	}
	if (!job) throw new FixRunError('E_BAD_RESULT', t('The engine returned an unreadable Fix Transcript result'));
	opts.onJob?.(job);
	let transient = 0;
	while (!TERMINAL.has(job.state)) {
		if (opts.signal?.aborted) {
			try {
				await engine.cancelJob(job.id);
			} catch {
				// it may have just finished: its result is ignored
			}
			throw new FixRunError('E_CANCELLED', t('Cancelled'));
		}
		await sleep(POLL_MS);
		try {
			job = await engine.getJob(job.id);
			transient = 0;
		} catch (e) {
			const err = asError(e);
			// a dropped connection while polling is retried a few times before it fails the run
			if ((err.code === 'NETWORK' || (e as { retryable?: boolean }).retryable) && ++transient < 4) continue;
			throw err;
		}
		opts.onJob?.(job);
	}
	return resultOf(job);
}

/** The refusals of the route and the job in the user's words (the engine's own message otherwise). */
export function fixErrorText(e: unknown): string {
	const err = asError(e);
	switch (err.code) {
		case 'E_NO_SOURCE':
			return t('Nothing to fix from: attach the script or add names to your speech glossary first');
		case 'E_NO_TRANSCRIPT':
			return t('No transcribed words in the chosen scope: transcribe the recordings first');
		case 'E_NO_SPEECH_MODEL':
			return t(
				'No installed speech model fits the transcript’s language: download one in Preferences ▸ Transcription',
			);
		case 'E_LIMIT':
			return t('The transcript or the script is too long to align in one run ({0})', err.message);
		case 'E_CANCELLED':
			return t('Cancelled');
		case 'NETWORK':
			return t('The engine is not reachable: {0}', err.message);
		default:
			return err.code && err.code !== 'E_ENGINE' ? `${err.message} (${err.code})` : err.message;
	}
}
