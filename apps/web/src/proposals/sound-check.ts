// Sound Check of a proposal in review (spec 12 §4 P6-E5; wp-note "Phase 6 → WP-E2"): the Review panel's "Check
// proposal" runs the engine's `sound-check` job on the proposal's preview — the items the user has not rejected (pending
// and accepted here, what they require comes with them) on the committed document; nothing is applied — and shows
// "Sound Check of this proposal: fixes 3 · introduces 1" with each introduced finding linked to its item, badges per
// row and on the ghost card. The engine keeps the last result on the proposal (`report.check`): an agent's check before
// handing the proposal over shows here too. A result is stale when the mix changed since it was made, or the user's
// decisions changed which items it would cover.
import {
	type EngineJob,
	type SoundCheckDeltaFinding,
	type SoundCheckProposalSummary,
	SoundCheckProposalSummarySchema,
	SoundCheckResultSchema,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { mixFingerprint, type ProjectDocument, type Proposal } from '@jasper/project';
import type { EditorSession, ReviewItem } from '@jasper/session';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { t } from '../i18n/runtime.ts';
import { runSoundJob, SoundJobError } from '../sound/mix-jobs.ts';

export type ProposalCheckEngine = Pick<EngineClient, 'soundCheck' | 'getJob' | 'cancelJob'>;

/** The last check the engine keeps on a proposal (`report.check`), or null (never checked, or unreadable). */
export function storedProposalCheck(
	p: Pick<Proposal, 'report'> | null | undefined,
): SoundCheckProposalSummary | null {
	const r = SoundCheckProposalSummarySchema.safeParse((p?.report as { check?: unknown } | undefined)?.check);
	return r.success ? r.data : null;
}

/** The items a check of the review covers: the decisions the user can still make — pending and accepted, not setup. */
export function proposalCheckItems(items: readonly Pick<ReviewItem, 'id' | 'setup' | 'state'>[]): string[] {
	return items
		.filter((it) => !it.setup && (it.state === 'pending' || it.state === 'accepted'))
		.map((it) => it.id);
}

export type ProposalCheckStatus = {
	state: 'none' | 'current' | 'stale';
	/** Why it is stale: the mix changed, or the user's decisions changed which items it would cover. */
	reasons: ('mix' | 'items')[];
};

/** Whether a check still describes the review: the committed mix and the items it covered. Never throws. */
export function proposalCheckStatus(
	check: SoundCheckProposalSummary | null,
	doc: ProjectDocument,
	items: readonly Pick<ReviewItem, 'id' | 'setup' | 'state'>[],
): ProposalCheckStatus {
	if (!check) return { state: 'none', reasons: [] };
	const reasons: ProposalCheckStatus['reasons'] = [];
	try {
		if (mixFingerprint(doc, check.sequenceId) !== check.baseMixHash) reasons.push('mix');
	} catch {
		reasons.push('mix');
	}
	const covered = new Set(check.itemIds);
	const wanted = proposalCheckItems(items);
	const setup = new Set(items.filter((it) => it.setup).map((it) => it.id));
	const checkedNow = [...covered].filter((id) => !setup.has(id));
	if (wanted.some((id) => !covered.has(id)) || checkedNow.some((id) => !wanted.includes(id)))
		reasons.push('items');
	return { state: reasons.length ? 'stale' : 'current', reasons };
}

/** The findings a check says an item fixes and introduces. */
export function itemCheck(
	check: SoundCheckProposalSummary | null,
	itemId: string,
): { fixes: SoundCheckDeltaFinding[]; introduces: SoundCheckDeltaFinding[] } {
	if (!check) return { fixes: [], introduces: [] };
	return {
		fixes: check.delta.fixed.filter((f) => f.itemIds.includes(itemId)),
		introduces: check.delta.introduced.filter((f) => f.itemIds.includes(itemId)),
	};
}

/** "Sound Check of this proposal: fixes 3 · introduces 1". */
export function proposalCheckText(check: SoundCheckProposalSummary): string {
	return t(
		'Sound Check of this proposal: fixes {0} · introduces {1}',
		check.delta.fixedCount,
		check.delta.introducedCount,
	);
}

/** An item's badge text ("fixes 2 · introduces 1"), null when the check says nothing about it. */
export function itemCheckText(check: SoundCheckProposalSummary | null, itemId: string): string | null {
	const c = itemCheck(check, itemId);
	const parts = [
		c.fixes.length ? t('fixes {0}', c.fixes.length) : null,
		c.introduces.length ? t('introduces {0}', c.introduces.length) : null,
	].filter(Boolean);
	return parts.length ? parts.join(' · ') : null;
}

/** Why a check is stale, in words. */
export function proposalCheckStaleText(s: ProposalCheckStatus): string | null {
	if (s.state !== 'stale') return null;
	return t(
		'Out of date: {0} since this check',
		s.reasons
			.map((r) => (r === 'mix' ? t('the mix changed') : t('your decisions changed which items it covers')))
			.join(', '),
	);
}

export type ProposalCheckState = {
	/** A check running: its proposal, job, progress and stage. */
	running: {
		proposalId: string;
		jobId: string | null;
		progress: number | null;
		stage: string | null;
	} | null;
	error: { proposalId: string; message: string } | null;
	/** The last check finished in this window (shown until the proposal carries the same or a newer one). */
	last: SoundCheckProposalSummary | null;
};

const stores = new WeakMap<EditorSession, StoreApi<ProposalCheckState>>();
const aborts = new WeakMap<EditorSession, AbortController>();

/** The proposal check state of a session. */
export function proposalCheckStore(session: EditorSession): StoreApi<ProposalCheckState> {
	let s = stores.get(session);
	if (!s) {
		s = createStore<ProposalCheckState>(() => ({ running: null, error: null, last: null }));
		stores.set(session, s);
	}
	return s;
}

/**
 * Runs the Sound Check of the proposal's preview (the engine's job; nothing applied). A check already running in this
 * window is cancelled first. Resolves the summary, or null (cancelled or failed: the store says why). Never rejects.
 */
export async function checkProposal(
	session: EditorSession,
	engine: ProposalCheckEngine,
	req: { proposalId: string; sequenceId: string | null; itemIds: readonly string[] },
): Promise<SoundCheckProposalSummary | null> {
	const store = proposalCheckStore(session);
	aborts.get(session)?.abort();
	const ac = new AbortController();
	aborts.set(session, ac);
	store.setState({
		running: { proposalId: req.proposalId, jobId: null, progress: null, stage: t('Starting') },
		error: null,
	});
	try {
		const result = await runSoundJob(
			engine,
			(signal) =>
				engine.soundCheck(
					{
						projectId: session.projectId,
						...(req.sequenceId ? { sequenceId: req.sequenceId } : {}),
						proposalId: req.proposalId,
						...(req.itemIds.length ? { itemIds: [...req.itemIds] } : {}),
					},
					signal,
				),
			SoundCheckResultSchema,
			{
				signal: ac.signal,
				failure: t('The Sound Check of the proposal failed'),
				onJob: (j: EngineJob) =>
					store.setState((s) =>
						s.running
							? {
									running: {
										proposalId: req.proposalId,
										jobId: j.id,
										progress: typeof j.progress === 'number' ? j.progress : null,
										stage: j.stage ?? null,
									},
								}
							: {},
					),
			},
		);
		if (aborts.get(session) === ac) aborts.delete(session);
		const jobId = store.getState().running?.jobId ?? '';
		if (!result.proposal) throw new SoundJobError('E_ENGINE', t('The engine did not check the proposal'));
		const summary: SoundCheckProposalSummary = {
			...result.proposal,
			jobId,
			at: new Date().toISOString(),
			sequenceId: result.sequenceId,
		};
		store.setState({ running: null, error: null, last: summary });
		return summary;
	} catch (e) {
		if (aborts.get(session) === ac) aborts.delete(session);
		const err = e instanceof SoundJobError ? e : new SoundJobError('E_ENGINE', String(e));
		if (ac.signal.aborted && aborts.get(session)) return null; // a newer check replaced this one
		store.setState({
			running: null,
			error: err.code === 'E_CANCELLED' ? null : { proposalId: req.proposalId, message: err.message },
		});
		return null;
	}
}

/** Cancels the proposal check running in this window. */
export function cancelProposalCheck(session: EditorSession): void {
	aborts.get(session)?.abort();
}
