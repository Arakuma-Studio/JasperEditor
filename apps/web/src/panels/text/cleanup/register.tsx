// Program monitor chip while a Clean Up derived preview plays (spec 14 TC-042): the monitor plays "the result" or "the
// removed parts", not the sequence — said in words, with a Stop button.
import { derivedPreviewFor, type EditorSession } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { programOverlays } from '../../../extensions/index.ts';
import { t } from '../../../i18n/runtime.ts';
import { cleanupFor } from './controller.ts';

function CleanupChip() {
	const session = useSessionOrNull();
	if (!session) return null;
	return <CleanupChipBody session={session} />;
}

function CleanupChipBody({ session }: { session: EditorSession }) {
	const active = useStoreSelector(derivedPreviewFor(session).store, (s) => s.active);
	if (!active?.kind.startsWith('cleanup.')) return null;
	return (
		<div className="absolute top-2 right-2 z-10" data-testid="cleanup-preview-chip">
			<span
				className="inline-flex items-center gap-2 rounded-pr-pill border border-pr-accent bg-pr-panel px-2 py-[1px] text-pr-small text-pr-text shadow-pr-floating"
				role="status"
				aria-live="polite"
			>
				{active.kind === 'cleanup.result'
					? t('Playing the Clean Up result (not applied)')
					: t('Playing what Clean Up removes')}
				<button
					type="button"
					className="text-pr-muted hover:text-pr-text"
					onClick={() => cleanupFor(session).stopPreview()}
					data-testid="cleanup-preview-chip.stop"
				>
					{t('Stop')}
				</button>
			</span>
		</div>
	);
}

let done = false;
export function registerCleanupUi(): void {
	if (done) return;
	done = true;
	programOverlays.register({
		id: 'cleanup.previewChip',
		active: () => true,
		component: CleanupChip,
		order: 92,
	});
}
