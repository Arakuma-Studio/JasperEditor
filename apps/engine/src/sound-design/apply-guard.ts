// Applying a measured mix change (rebalance, delivery; spec 12 §2.8 job error `CONFLICT`). Those jobs measure the
// live edit, solve, and only then apply: if anything audible changed meanwhile (the music raised, a fader ridden, a
// clip moved, media relinked), the gains and loudness they computed belong to another mix. The transaction's own
// fast-forward rule (S01:AGT-010) only refuses edits of the entities it touches, so before applying the job reads the
// edit again and compares the MIX FINGERPRINT (every input of the sequence's mix: tracks, clips, submixes, the Mix,
// media fingerprints) and the delivery setting with what it measured; any difference is a retryable `CONFLICT` and
// nothing is applied. The transaction then carries the revision it was checked at, and a refusal for a stale revision
// (`E_REVISION_MISMATCH`, an edit landing between the check and the apply) is the same retryable `CONFLICT`.
import { mixFingerprint, type ProjectDocument, type Sequence, soundDesignSettingsOf } from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import { JobError } from '../jobs/types.ts';
import { liveDocument } from './plan.ts';

/**
 * Test seams (never set in production): `afterMeasure` runs after the job measured and before it checks the edit
 * again; `beforeApply` after the check and before the transaction.
 */
export const soundDesignApplyHooks: {
	afterMeasure?: (projectId: string) => Promise<void>;
	beforeApply?: (projectId: string) => Promise<void>;
} = {};

/** What the mix of `seqId` depends on, for the conflict check (mix inputs + the delivery the solve used). */
export function measuredMixKey(doc: ProjectDocument, seqId: string): string {
	const seq = doc.sequences[seqId] as Sequence | undefined;
	if (!seq) return '';
	return `${mixFingerprint(doc, seqId)}|${soundDesignSettingsOf(seq).delivery}`;
}

/** Error codes of a refused transaction that mean "the document changed": retried as a new run. */
const STALE_CODES = new Set(['E_REVISION_MISMATCH', 'E_CONFLICT']);

/**
 * Applies `commands` to the project if the live mix of `seqId` is still the one `measured` describes; throws a
 * retryable `JobError('CONFLICT')` otherwise (nothing applied), and a `JobError` with the transaction's code when the
 * transaction is refused for another reason. Returns the new revision.
 */
export async function applyMeasuredMix(
	agent: AgentService,
	req: {
		projectId: string;
		sequenceId: string;
		measured: ProjectDocument;
		label: string;
		agentName: string;
		editor: boolean;
		commands: Record<string, unknown>[];
		/** "The gains were not applied" / "The delivery was not applied". */
		what: string;
	},
): Promise<number | null> {
	await soundDesignApplyHooks.afterMeasure?.(req.projectId);
	const now = await liveDocument(agent, req.projectId);
	if (now.revision === null)
		throw new JobError(
			'CONFLICT',
			`${req.what}: the edit's revision could not be read, so a concurrent change could not be ruled out; run it again`,
			true,
		);
	if (measuredMixKey(now.doc, req.sequenceId) !== measuredMixKey(req.measured, req.sequenceId))
		throw new JobError(
			'CONFLICT',
			`${req.what}: the mix changed while it was being measured (an edit to the sequence's audio, its mixer or its media); run it again on the new mix`,
			true,
		);
	await soundDesignApplyHooks.beforeApply?.(req.projectId);
	const out = await agent.transact(
		req.projectId,
		{
			label: req.label,
			origin: { agent: req.agentName },
			sequenceId: req.sequenceId,
			expectedRevision: now.revision,
			commands: req.commands,
		},
		{ fallbackAgent: req.agentName, ...(req.editor ? { preApproved: true, asUser: true } : {}) },
	);
	const r = out.result as {
		ok: boolean;
		revision?: number;
		errors?: { code: string; message: string; retryable?: boolean }[];
	};
	if (!r.ok) {
		const e = r.errors?.[0];
		const stale = !!e && STALE_CODES.has(e.code);
		throw new JobError(
			stale ? 'CONFLICT' : (e?.code ?? 'TRANSACTION_REJECTED'),
			stale
				? `${req.what}: the edit changed before it could be applied (${e!.message}); run it again on the new mix`
				: `${req.what}: ${e?.message ?? 'the transaction was refused'}`,
			stale || e?.retryable === true,
			{ errors: r.errors?.slice(0, 5) ?? [] },
		);
	}
	return r.revision ?? null;
}
