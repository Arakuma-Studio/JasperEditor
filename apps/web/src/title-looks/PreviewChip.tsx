// Spec 19 TL-088: while Program shows a preview, it says so in words: what it shows is not in the project.
import { derivedPreviewFor } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { t } from '../i18n/runtime.ts';

function Chip({ label }: { label: string }) {
	return (
		<div className="pointer-events-none absolute top-2 left-2 z-10" data-testid="look-preview-chip">
			<span
				className="inline-flex items-center gap-1 rounded-pr-pill border border-pr-accent bg-pr-panel px-2 py-[1px] text-pr-small text-pr-text shadow-pr-floating"
				role="status"
			>
				{t('Preview: {0}', label)}
			</span>
		</div>
	);
}

function Body({ session }: { session: NonNullable<ReturnType<typeof useSessionOrNull>> }) {
	const active = useStoreSelector(derivedPreviewFor(session).store, (s) => s.active);
	return active?.kind === 'title-looks.preview' ? <Chip label={active.label} /> : null;
}

export function LookPreviewChip() {
	const session = useSessionOrNull();
	return session ? <Body session={session} /> : null;
}
