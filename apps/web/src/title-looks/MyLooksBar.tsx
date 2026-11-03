// Motion Templates ▸ Looks ▸ My Looks (TL-054): the header of the user's own looks, with what starts them: saving the
// selected clip's look, importing a looks file and exporting them all. Each button that cannot act says why.
import type { EditorSession } from '@jasper/session';
import { Button } from '@jasper/ui';
import { useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { type UserLookLibraryState, userLooksUnavailable } from './user-library.ts';
import { exportMyLooks, importMyLooks, saveToMyLooks, saveToMyLooksDisabled } from './user-look-actions.ts';

export function MyLooksBar(props: {
	session: EditorSession;
	library: UserLookLibraryState;
	onMessage(kind: 'info' | 'error', text: string): void;
}) {
	const { session, library, onMessage } = props;
	const [busy, setBusy] = useState<'save' | 'import' | 'export' | null>(null);
	const unavailable = userLooksUnavailable(library) ?? undefined;
	const saveWhy = saveToMyLooksDisabled(session);
	const exportWhy =
		library.status !== 'ready'
			? unavailable
			: library.looks.length === 0
				? t('There are no looks in My Looks to export yet.')
				: undefined;
	const run = async (which: 'save' | 'import' | 'export', fn: () => Promise<void>) => {
		setBusy(which);
		try {
			await fn();
		} catch (e) {
			// The actions report their own outcomes; anything else that fails (a dialog, the file picker) shows here too.
			onMessage('error', t('My Looks: {0}', e instanceof Error ? e.message : String(e)));
		} finally {
			setBusy(null);
		}
	};
	return (
		<div
			className="flex flex-wrap items-center gap-1 border-pr-border-subtle border-b pb-1"
			data-testid="my-looks-bar"
		>
			<span className="min-w-0 flex-1 truncate text-pr-small text-pr-muted" data-testid="my-looks-count">
				{library.status === 'ready'
					? library.looks.length === 1
						? t('1 look of your own, in every project')
						: t('{0} looks of your own, in every project', library.looks.length)
					: (unavailable ?? '')}
			</span>
			<Button
				variant="quiet"
				disabled={!!saveWhy}
				{...(saveWhy ? { disabledReason: saveWhy } : {})}
				busy={busy === 'save'}
				onClick={() =>
					void run('save', async () => {
						await saveToMyLooks(session);
					})
				}
				data-testid="my-looks-save"
			>
				Save Selected Look…
			</Button>
			<Button
				variant="quiet"
				disabled={!!unavailable}
				{...(unavailable ? { disabledReason: unavailable } : {})}
				busy={busy === 'import'}
				onClick={() =>
					void run('import', async () => {
						const r = await importMyLooks();
						if (r) onMessage(r.ok ? 'info' : 'error', r.message);
					})
				}
				data-testid="my-looks-import"
			>
				Import…
			</Button>
			<Button
				variant="quiet"
				disabled={!!exportWhy}
				{...(exportWhy ? { disabledReason: exportWhy } : {})}
				busy={busy === 'export'}
				onClick={() =>
					void run('export', async () => {
						const r = await exportMyLooks(undefined, t('My Looks'));
						onMessage(r.ok ? 'info' : 'error', r.message);
					})
				}
				data-testid="my-looks-export"
			>
				Export All…
			</Button>
		</div>
	);
}
