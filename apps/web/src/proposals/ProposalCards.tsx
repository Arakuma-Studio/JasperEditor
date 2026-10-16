// Proposal cards in the agent notices stack (spec 12 §2.7 "Review": "The proposal card goes into the AgentApprovals
// stack: no countdown, Review / Dismiss"; WP3.3b). One card per agent proposal with items to review that is not under
// review and not dismissed (newest three): "<agent> proposes <title>: <n> sounds on <k> new tracks", and "<agent> is
// waiting for your review" while the agent's `wait_for_proposal` polls it (the engine's `waiting`). Non-blocking: it
// never takes focus and never times out. Review opens the proposal in review (its sequence, the ghosts, the Review
// panel); Dismiss hides the card in this window (the proposal stays in the Review panel's list). The user's own
// proposals (Auto Sound Pass…, Fill Unfilled Cues) open review directly and get no card. Also the review's aria-live
// region (`ReviewAnnouncer`), mounted once with the stack.
import type { ProposalSummary } from '@jasper/api';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { Button, Icon } from '@jasper/ui';
import { useEffect, useMemo, useState } from 'react';
import { createStore } from 'zustand/vanilla';
import { t } from '../i18n/runtime.ts';
import { useShellRuntimeOrNull } from '../shell/context.tsx';
import { openReview, reviewAnnouncer } from './actions.ts';
import { type CardCounts, cardSentence, proposalCardCounts } from './review.ts';
import { proposalsFor, useProposals } from './state.ts';

/** Most cards shown at once (the Review panel lists every proposal). */
export const MAX_PROPOSAL_CARDS = 3;

const STORAGE_KEY = 'jasper:dismissed-proposals';

function readDismissed(): Record<string, true> {
	try {
		const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(STORAGE_KEY);
		const v = raw ? (JSON.parse(raw) as unknown) : null;
		if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
		const out: Record<string, true> = {};
		for (const k of Object.keys(v).slice(0, 500)) if (/^prp_[0-9A-Z]{16}$/.test(k)) out[k] = true;
		return out;
	} catch {
		return {};
	}
}

/** Proposals whose card the user dismissed in this window (kept for the browser session). */
export const dismissedProposals = createStore<{ ids: Record<string, true> }>(() => ({
	ids: readDismissed(),
}));
export function dismissProposalCard(id: string): void {
	const ids = { ...dismissedProposals.getState().ids, [id]: true as const };
	dismissedProposals.setState({ ids });
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
	} catch {
		// storage full or unavailable: dismissed until reload
	}
}

/** The agent proposals that get a card now. */
export function cardProposals(
	list: readonly ProposalSummary[],
	activeId: string | null,
	dismissed: Record<string, true>,
): ProposalSummary[] {
	return list
		.filter((p) => typeof p.author === 'object' && !p.decided && p.id !== activeId && !dismissed[p.id])
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
		.slice(0, MAX_PROPOSAL_CARDS);
}

export function ProposalCards({ session }: { session: EditorSession }) {
	const list = useProposals(session, (s) => s.list);
	const activeId = useProposals(session, (s) => s.activeId);
	const dismissed = useStoreSelector(dismissedProposals, (s) => s.ids);
	const shown = useMemo(() => cardProposals(list, activeId, dismissed), [list, activeId, dismissed]);
	return (
		<>
			{shown.map((p) => (
				<ProposalCard key={p.id} session={session} summary={p} />
			))}
		</>
	);
}

function ProposalCard({ session, summary: p }: { session: EditorSession; summary: ProposalSummary }) {
	const runtime = useShellRuntimeOrNull();
	const [counts, setCounts] = useState<CardCounts | null>(null);
	const agent = typeof p.author === 'object' ? p.author.agent : '';
	// "n sounds on k new tracks": a preview of the undecided items (never committed), once per change of the proposal
	// biome-ignore lint/correctness/useExhaustiveDependencies: p.updatedAt re-reads the proposal when it changed
	useEffect(() => {
		let live = true;
		void proposalsFor(session)
			.read(p.id)
			.then((proposal) => {
				if (!live || !proposal) return;
				const ctx = session.ctx;
				setCounts(
					proposalCardCounts(session.getCommitted(), proposal, {
						registries: ctx.registries,
						revision: session.revision,
						invariants: 'incremental',
					}),
				);
			});
		return () => {
			live = false;
		};
	}, [session, p.id, p.updatedAt]);
	const sentence = cardSentence(agent, p.title, p.feature, counts);
	return (
		<li
			aria-label={t('Proposal from {0}: {1}', agent, p.title)}
			data-testid="proposal-card"
			data-proposal-id={p.id}
			className="pointer-events-auto flex w-[420px] max-w-[calc(100vw-32px)] overflow-hidden rounded-pr-menu border border-pr-menu-border bg-pr-menu font-pr text-pr-ui text-pr-text shadow-pr-floating"
		>
			<span className="w-[3px] shrink-0 bg-pr-agent" />
			<div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2.5">
				<div className="flex items-center gap-2">
					<span className="inline-flex shrink-0 text-pr-agent" aria-hidden="true">
						<Icon id="agent.sparkle" size={16} />
					</span>
					<span className="min-w-0 flex-1 font-semibold text-pr-strong" data-testid="proposal-card-text">
						{sentence}
					</span>
				</div>
				{p.summary ? <p className="line-clamp-2 text-pr-small text-pr-muted">{p.summary}</p> : null}
				{p.waiting ? (
					<p className="text-pr-small text-pr-agent" data-testid="proposal-card-waiting">
						{t('{0} is waiting for your review', p.waiting.agent)}
					</p>
				) : null}
				<div className="mt-0.5 flex items-center justify-end gap-2">
					<Button
						variant="secondary"
						onClick={() => dismissProposalCard(p.id)}
						data-testid="proposal-card-dismiss"
					>
						{t('Dismiss')}
					</Button>
					<Button
						variant="primary"
						onClick={async () => {
							if (await openReview(session, p.id)) void runtime?.run('panel.focus.review');
						}}
						data-testid="proposal-card-review"
					>
						{t('Review')}
					</Button>
				</div>
			</div>
		</li>
	);
}

/** The review's aria-live region (decisions, Apply, navigation are announced here). */
export function ReviewAnnouncer() {
	const msg = useStoreSelector(reviewAnnouncer, (s) => s.message);
	return (
		<div aria-live="polite" className="sr-only" data-testid="review-live">
			{msg}
		</div>
	);
}
