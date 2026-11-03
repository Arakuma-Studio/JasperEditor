// The review bar at the top of the Timeline while a proposal is under review (spec 12 §2.7 "Review", P3-R6; WP3.3b):
// "✦ Reviewing: <author> · <title> · n items", ◀ ▶ (the items in time order: the ghost is selected and the playhead goes
// to its anchor), A/B ("Hear proposal": switches while playing), Accept all, Reject all, "Apply n of m" (a trusted click
// only), Discard (the proposal is deleted after a confirmation) and Exit (✕). Decisions are announced by the shell's
// review live region (`ReviewAnnouncer`).
import type { EditorSession } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import { Button, Icon } from '@jasper/ui';
import { useMemo } from 'react';
import { t } from '../i18n/runtime.ts';
import {
	acceptAll,
	applyReview,
	discardReview,
	exitReview,
	type RevealFn,
	rejectAll,
	stepReviewItem,
} from './actions.ts';
import { authorName, reviewCounts } from './review.ts';
import { useProposals, useProposalsController } from './state.ts';
import { isVisualProposal } from './title-art.tsx';

/** Height of the bar (px): the Timeline's playhead overlay starts below it. */
export const REVIEW_BAR_PX = 30;

/** Whether the bar shows in the Timeline of `sequenceId` (a proposal of that sequence, or of none, is under review). */
export function useReviewBarShown(session: EditorSession, sequenceId: string): boolean {
	return useProposals(
		session,
		(s) =>
			!!s.activeId &&
			!!s.proposal &&
			(s.proposal.sequenceId === null || s.proposal.sequenceId === sequenceId),
	);
}

export function ReviewBar(props: { session: EditorSession; reveal: RevealFn }) {
	const { session } = props;
	const c = useProposalsController(session);
	const proposal = useProposals(session, (s) => s.proposal);
	const items = useProposals(session, (s) => s.items);
	const hear = useProposals(session, (s) => s.hear);
	const busy = useProposals(session, (s) => s.busy);
	const waiting = useProposals(session, (s) => s.list.find((p) => p.id === s.activeId)?.waiting ?? null);
	const readOnly = useSessionState((s) => s.readOnly);
	const counts = useMemo(() => reviewCounts(items), [items]);
	if (!proposal) return null;
	const agent = typeof proposal.author === 'object';
	// spec 19 TL-098: a title is looked at, not heard.
	const visual = isVisualProposal(proposal.feature);
	return (
		<div
			className="flex shrink-0 items-center gap-1.5 overflow-hidden border-b border-pr-border bg-pr-panel-alt px-2 text-pr-small text-pr-text"
			style={{ height: REVIEW_BAR_PX, boxShadow: agent ? 'inset 3px 0 0 var(--pr-agent)' : undefined }}
			role="toolbar"
			aria-label={t('Proposal review')}
			data-testid="review-bar"
			data-keymap-local
			onKeyDown={(e) => {
				// the bar's buttons keep Enter / Space
				if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
			}}
		>
			<span className={agent ? 'inline-flex text-pr-agent' : 'inline-flex text-pr-muted'} aria-hidden="true">
				<Icon id="agent.sparkle" size={14} />
			</span>
			<span className="min-w-0 truncate" data-testid="review-bar-title" title={proposal.title}>
				<span className="text-pr-muted">{t('Reviewing:')} </span>
				{authorName(proposal.author)} · <span className="font-semibold text-pr-strong">{proposal.title}</span>{' '}
				· {t('{0} items', counts.total)}
			</span>
			{waiting ? (
				<span className="shrink-0 truncate text-pr-agent" data-testid="review-bar-waiting">
					· {t('{0} is waiting for your review', waiting.agent)}
				</span>
			) : null}
			<span className="ml-auto flex shrink-0 items-center gap-1">
				<Button
					variant="quiet"
					aria-label={t('Previous item')}
					title={t('Previous item')}
					onClick={() => stepReviewItem(session, -1, 'time', props.reveal)}
					data-testid="review-bar-prev"
				>
					◀
				</Button>
				<Button
					variant="quiet"
					aria-label={t('Next item')}
					title={t('Next item')}
					onClick={() => stepReviewItem(session, 1, 'time', props.reveal)}
					data-testid="review-bar-next"
				>
					▶
				</Button>
				<Button
					variant={hear ? 'primary' : 'secondary'}
					aria-pressed={hear}
					title={
						visual
							? t('Compare: show the proposal in the Program monitor, or the sequence as it is (A)')
							: t('A/B: hear the proposal in the Program monitor, or the sequence as it is (A)')
					}
					onClick={() => c.toggleHear()}
					data-testid="review-bar-ab"
				>
					{visual ? t('Compare') : 'A/B'}
				</Button>
				<Button
					variant="secondary"
					disabled={readOnly || counts.open === 0}
					onClick={() => void acceptAll(session)}
					data-testid="review-bar-accept-all"
				>
					{t('Accept all')}
				</Button>
				<Button
					variant="secondary"
					disabled={readOnly || counts.open + counts.accepted === 0}
					onClick={() => void rejectAll(session)}
					data-testid="review-bar-reject-all"
				>
					{t('Reject all')}
				</Button>
				<Button
					variant="primary"
					busy={busy}
					disabled={readOnly || counts.accepted === 0}
					disabledReason={counts.accepted === 0 ? t('Accept items first') : undefined}
					onClick={(e) => void applyReview(session, { trusted: e.nativeEvent.isTrusted })}
					title={t('Apply the accepted items as one undo step')}
					data-testid="review-bar-apply"
				>
					{t('Apply {0} of {1}', counts.accepted, counts.total)}
				</Button>
				<Button
					variant="quiet"
					disabled={readOnly}
					onClick={() => void discardReview(session)}
					data-testid="review-bar-discard"
				>
					{t('Discard')}
				</Button>
				<Button
					variant="quiet"
					aria-label={t('Exit review')}
					title={t('Exit review')}
					onClick={() => exitReview(session)}
					data-testid="review-bar-exit"
				>
					✕
				</Button>
			</span>
		</div>
	);
}
