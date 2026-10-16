// The Review panel tab's count (spec 12 §2.7 "Review"): items left to decide in the proposal under review, else the
// proposals with items to review. Nothing when there are none.
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull } from '@jasper/session/react';
import { t } from '../../i18n/runtime.ts';
import { reviewCounts } from '../../proposals/review.ts';
import { useProposals } from '../../proposals/state.ts';

export function ReviewBadge() {
	const session = useSessionOrNull();
	return session ? <Badge session={session} /> : null;
}

function Badge({ session }: { session: EditorSession }) {
	const n = useProposals(session, (s) =>
		s.activeId && s.proposal ? reviewCounts(s.items).open : s.list.filter((p) => !p.decided).length,
	);
	const reviewing = useProposals(session, (s) => !!s.activeId);
	if (!n) return null;
	const label = reviewing ? t('{0} items to review', n) : t('{0} proposals to review', n);
	return (
		<span
			className="ml-1 inline-flex min-w-3.5 shrink-0 items-center justify-center rounded-full bg-pr-accent-fill px-[3px] text-[10px] leading-3.5 text-pr-on-accent pr-tabular"
			data-testid="review-tab-badge"
			data-count={n}
			title={label}
		>
			<span aria-hidden="true">{n > 99 ? '99+' : n}</span>
			<span className="sr-only">{label}</span>
		</span>
	);
}
