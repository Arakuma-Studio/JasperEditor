// Apply Style and Style Check for the editor (spec 15 EA-012, EA-013, EA-040): the dry run (what each stage would do,
// at once), the proposal (an `apply-style` job followed here and in the Jobs panel; Cancel cancels it; review opens on
// the proposal) and Style Check (the engine measures dead air with the voice analyses already made).
import {
	type ApplyStyleRequest,
	type ApplyStyleResult,
	ApplyStyleResultSchema,
	type EngineJob,
	type StyleCheckResponse,
	StyleCheckResponseSchema,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { t } from '../i18n/runtime.ts';
import { AutomationRunError } from './run.ts';

export type StyleEngine = Pick<EngineClient, 'applyStyle' | 'styleCheck' | 'getJob' | 'cancelJob'>;

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const POLL_MS = 400;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const asRunError = (e: unknown) => {
	const err = e as { code?: string; message?: string; detail?: unknown };
	return new AutomationRunError(err.code ?? 'E_ENGINE', err.message ?? String(e), err.detail);
};

export async function dryRunStyle(
	engine: StyleEngine,
	projectId: string,
	req: Omit<ApplyStyleRequest, 'mode'>,
	signal?: AbortSignal,
): Promise<ApplyStyleResult> {
	try {
		return ApplyStyleResultSchema.parse(
			await engine.applyStyle(projectId, { ...req, mode: 'dryRun' }, signal),
		);
	} catch (e) {
		throw asRunError(e);
	}
}

/** Starts the `apply-style` job and waits for it; `E_CANCELLED` when `signal` aborted it (the job is cancelled too). */
export async function proposeStyle(
	engine: StyleEngine,
	projectId: string,
	req: Omit<ApplyStyleRequest, 'mode'>,
	opts: { signal?: AbortSignal; onJob?(job: EngineJob): void } = {},
): Promise<ApplyStyleResult> {
	let job: EngineJob;
	try {
		job = (await engine.applyStyle(projectId, { ...req, mode: 'propose' }, opts.signal)) as EngineJob;
	} catch (e) {
		if (opts.signal?.aborted) throw new AutomationRunError('E_CANCELLED', t('Cancelled'));
		throw asRunError(e);
	}
	opts.onJob?.(job);
	while (!TERMINAL.has(job.state)) {
		if (opts.signal?.aborted) {
			try {
				await engine.cancelJob(job.id);
			} catch {
				// it may have just finished: its result is ignored
			}
			throw new AutomationRunError('E_CANCELLED', t('Cancelled'));
		}
		await sleep(POLL_MS);
		try {
			job = (await engine.getJob(job.id)) as EngineJob;
		} catch (e) {
			throw asRunError(e);
		}
		opts.onJob?.(job);
	}
	if (job.state !== 'succeeded') {
		if (job.state === 'cancelled') throw new AutomationRunError('E_CANCELLED', t('Cancelled'));
		throw new AutomationRunError(
			job.error?.code ?? 'E_JOB_FAILED',
			job.error?.message ?? t('Apply Style failed'),
			(job.error as { detail?: unknown } | undefined)?.detail,
		);
	}
	const parsed = ApplyStyleResultSchema.safeParse(job.result);
	if (!parsed.success)
		throw new AutomationRunError('E_BAD_RESULT', t('The engine returned an unreadable result'));
	return parsed.data;
}

export async function runStyleCheck(
	engine: StyleEngine,
	projectId: string,
	req: { sequenceId: string; recipeId?: string; recipe?: Record<string, unknown> },
	signal?: AbortSignal,
): Promise<StyleCheckResponse> {
	try {
		return StyleCheckResponseSchema.parse(await engine.styleCheck(projectId, req, signal));
	} catch (e) {
		throw asRunError(e);
	}
}
