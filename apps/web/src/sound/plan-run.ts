// Runs the engine's sound-design plan (spec 12 §2.8 `POST /api/sound-design/plan`, job `sound-design`; WP3.2) for the
// editor: Auto Sound Pass… and Fill Unfilled Cues propose instead of applying (spec 12 §1 "Review before commit"). The job
// is listed in the Jobs panel like any other; this follows it (progress, cancel) and reads its result. The proposal it
// stores is the user's own (the editor's request carries the editor key): review opens on it directly, no card.
import {
	type EngineJob,
	type SoundDesignPlanRequest,
	type SoundDesignPlanResult,
	SoundDesignPlanResultSchema,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { t } from '../i18n/runtime.ts';
import { openReview } from '../proposals/actions.ts';
import { cuesOf, isFilled } from './cues/model.ts';

export class PlanError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const POLL_MS = 400;

export type PlanRunOptions = {
	signal?: AbortSignal;
	onJob?(job: EngineJob): void;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Starts the plan job and waits for it: the result (`proposalId` null when no cue got a sound), or a `PlanError`
 * (`E_CANCELLED` when `signal` aborted it: the job is cancelled too, and a cancelled plan leaves no proposal).
 */
export async function runSoundPlan(
	engine: Pick<EngineClient, 'planSoundDesign' | 'getJob' | 'cancelJob'>,
	req: SoundDesignPlanRequest,
	opts: PlanRunOptions = {},
): Promise<SoundDesignPlanResult> {
	let job: EngineJob;
	try {
		job = (await engine.planSoundDesign(req, opts.signal)) as EngineJob;
	} catch (e) {
		if (opts.signal?.aborted) throw new PlanError('E_CANCELLED', t('Cancelled'));
		const err = e as { code?: string; message?: string };
		throw new PlanError(err.code ?? 'E_ENGINE', err.message ?? String(e));
	}
	opts.onJob?.(job);
	for (;;) {
		if (TERMINAL.has(job.state)) break;
		if (opts.signal?.aborted) {
			try {
				await engine.cancelJob(job.id);
			} catch {
				// the job may have just finished: its result is ignored
			}
			throw new PlanError('E_CANCELLED', t('Cancelled'));
		}
		await defaultSleep(POLL_MS);
		try {
			job = (await engine.getJob(job.id)) as EngineJob;
		} catch (e) {
			const err = e as { code?: string; message?: string };
			throw new PlanError(err.code ?? 'E_ENGINE', err.message ?? String(e));
		}
		opts.onJob?.(job);
	}
	if (job.state !== 'succeeded') {
		if (job.state === 'cancelled') throw new PlanError('E_CANCELLED', t('Cancelled'));
		throw new PlanError(
			job.error?.code ?? 'E_JOB_FAILED',
			job.error?.message ?? t('The sound design plan failed'),
		);
	}
	const parsed = SoundDesignPlanResultSchema.safeParse(job.result);
	if (!parsed.success) throw new PlanError('E_BAD_RESULT', t('The engine returned an unreadable plan'));
	return parsed.data;
}

/** "3 cues skipped: no sound of type …" (the first reasons), or null. */
export function skippedSummary(r: SoundDesignPlanResult): string | null {
	const n = r.report.counts.skipped;
	if (!n) return null;
	const first = r.report.skipped
		.slice(0, 2)
		.map((s) => `${s.timecode} ${s.reason}`)
		.join('; ');
	return n === 1 ? t('1 cue skipped: {0}', first) : t('{0} cues skipped: {1}', n, first);
}

/** The unfilled, unmuted cues of a sequence (what Fill Unfilled Cues proposes sounds for), frame order. */
export function unfilledCueIdsFor(session: EditorSession, sequenceId: string): string[] {
	const seq = session.getCommitted().sequences[sequenceId];
	if (!seq) return [];
	return cuesOf(seq)
		.filter((c) => !c.muted && c.kind !== 'silence' && !isFilled(c, seq.clips))
		.map((c) => c.id);
}

/** After a plan: open review on its proposal (the user's own: no card), or say why there is none. */
export async function reviewPlanResult(
	session: EditorSession,
	r: SoundDesignPlanResult,
): Promise<{ ok: boolean; message: string }> {
	const skipped = skippedSummary(r);
	if (!r.proposalId)
		return {
			ok: false,
			message: skipped ? t('Nothing to propose. {0}', skipped) : t('Nothing to propose: no cue in the range'),
		};
	const ok = await openReview(session, r.proposalId);
	const placed = r.report.counts.placed;
	return {
		ok,
		message:
			(placed === 1 ? t('Proposed a sound for 1 cue') : t('Proposed sounds for {0} cues', placed)) +
			(skipped ? `. ${skipped}` : ''),
	};
}
