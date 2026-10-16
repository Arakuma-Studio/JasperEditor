// Program monitor chip while "Hear proposal" is on (spec 12 §2.5): the monitor is playing the proposal's preview
// document, not the sequence — said in words, not only by a colour.
import { useSessionOrNull } from '@jasper/session/react';
import { programOverlays } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { useHeardDocument, useProposals } from './state.ts';

function HearChip() {
	const session = useSessionOrNull();
	if (!session) return null;
	return <HearChipBody session={session} />;
}

function HearChipBody({ session }: { session: NonNullable<ReturnType<typeof useSessionOrNull>> }) {
	const heard = useHeardDocument(session);
	const title = useProposals(session, (s) => s.proposal?.title ?? '');
	if (!heard) return null;
	return (
		<div className="pointer-events-none absolute top-2 right-2 z-10" data-testid="proposal-hear-chip">
			<span
				className="inline-flex items-center gap-1 rounded-pr-pill border border-pr-agent bg-pr-panel px-2 py-[1px] text-pr-small text-pr-text shadow-pr-floating"
				role="status"
				aria-live="polite"
			>
				{t('Hearing proposal: {0}', title)}
			</span>
		</div>
	);
}

let done = false;
export function registerProposalUi(): void {
	if (done) return;
	done = true;
	programOverlays.register({ id: 'proposals.hearChip', active: () => true, component: HearChip, order: 91 });
}
