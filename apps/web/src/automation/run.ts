// Runs an editing-automation pass for the editor (spec 15 EA-040): the dry run (what the pass would do, at once) and
// the proposal (an `edit-automation` job followed here and in the Jobs panel; Cancel cancels it). The proposal is the
// user's own (the editor key): review opens on it directly.
import {
	type AutomationPassId,
	type AutomationPassResult,
	AutomationPassResultSchema,
	type EngineJob,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { t } from '../i18n/runtime.ts';
import { openReview } from '../proposals/actions.ts';

export type AutomationEngine = Pick<EngineClient, 'automationPass' | 'getJob' | 'cancelJob'>;

export class AutomationRunError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
	}
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const POLL_MS = 400;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const asRunError = (e: unknown) => {
	const err = e as { code?: string; message?: string; detail?: unknown };
	return new AutomationRunError(err.code ?? 'E_ENGINE', err.message ?? String(e), err.detail);
};

/** What the pass would do on the live document (nothing stored). */
export async function dryRunPass(
	engine: AutomationEngine,
	projectId: string,
	pass: AutomationPassId,
	sequenceId: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<AutomationPassResult> {
	try {
		const r = await engine.automationPass(projectId, pass, { sequenceId, mode: 'dryRun', params }, signal);
		return AutomationPassResultSchema.parse(r);
	} catch (e) {
		throw asRunError(e);
	}
}

/** Starts the pass's job and waits for it; `E_CANCELLED` when `signal` aborted it (the job is cancelled too). */
export async function proposePass(
	engine: AutomationEngine,
	projectId: string,
	pass: AutomationPassId,
	sequenceId: string,
	params: Record<string, unknown>,
	opts: { signal?: AbortSignal; onJob?(job: EngineJob): void } = {},
): Promise<AutomationPassResult> {
	let job: EngineJob;
	try {
		job = (await engine.automationPass(
			projectId,
			pass,
			{ sequenceId, mode: 'propose', params },
			opts.signal,
		)) as EngineJob;
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
			job.error?.message ?? t('The pass failed'),
			(job.error as { detail?: unknown } | undefined)?.detail,
		);
	}
	const parsed = AutomationPassResultSchema.safeParse(job.result);
	if (!parsed.success)
		throw new AutomationRunError('E_BAD_RESULT', t('The engine returned an unreadable result'));
	return parsed.data;
}

/** After a proposal: open review on it, or say why there is none. */
export async function reviewPassResult(
	session: EditorSession,
	r: AutomationPassResult,
): Promise<{ ok: boolean; message: string }> {
	if (!r.proposalId) return { ok: false, message: t('Nothing to propose: no cut or clip qualifies here') };
	const ok = await openReview(session, r.proposalId);
	const n = r.summary.count;
	const message =
		r.pass === 'decorate-cuts'
			? n === 1
				? t('Proposed 1 cut kit')
				: t('Proposed {0} cut kits', n)
			: r.pass === 'punch-ins'
				? n === 1
					? t('Proposed 1 punch-in')
					: t('Proposed {0} punch-ins', n)
				: n === 1
					? t('Proposed 1 Ken Burns move')
					: t('Proposed {0} Ken Burns moves', n);
	return { ok, message };
}
