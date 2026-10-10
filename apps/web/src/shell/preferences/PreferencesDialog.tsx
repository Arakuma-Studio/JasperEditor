// Edit ▸ Preferences (S07:PRU-004): a dialog shell with the registered pages listed on the left
// (`registerPreferencesPage`) and the selected page on the right. Pages apply or save their own settings
// (UI preferences apply immediately; engine settings have their own Save button because the engine validates
// them), so the dialog has no OK/Cancel footer. The opener passes the editor session when a project is open
// (`session`, M3): pages read it with `useSessionOrNull()` for project-scoped settings (Timeline ▸ durations).
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { cx, Dialog, type HostedDialogProps, registerDialog } from '@jasper/ui';
import { useState } from 'react';
import { useRegistry } from '../../extensions/react.ts';
import { useLanguageEpoch } from '../../i18n/react.ts';
import { GeneralPreferencesPage } from './GeneralPage.tsx';
import { preferencesPages, registerPreferencesPage } from './registry.ts';

export const PREFERENCES_DIALOG = 'shell.preferences';

export function PreferencesDialog(
	props: HostedDialogProps<{ page?: string; session?: EditorSession | null }>,
) {
	const pages = useRegistry(preferencesPages);
	const [selected, setSelected] = useState<string | undefined>(props.page);
	// polish: a language change (Appearance ▸ Language) re-renders the dialog and remounts the page, so every string
	// is looked up again while the dialog stays open on the same page.
	const epoch = useLanguageEpoch();
	const current = pages.find((p) => p.id === selected) ?? pages[0];
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title={current ? `Preferences — ${current.title}` : 'Preferences'}
			size="large"
			data-testid="preferences-dialog"
		>
			<div className="-m-4 flex h-[min(600px,calc(90vh-40px))] min-h-0">
				<nav
					aria-label="Preference pages"
					className="flex w-[168px] shrink-0 flex-col gap-px overflow-auto border-r border-pr-border-subtle bg-pr-panel-alt py-2"
				>
					{pages.map((p) => (
						<button
							key={p.id}
							type="button"
							data-testid={`prefs-page-${p.id}`}
							aria-current={p.id === current?.id ? 'page' : undefined}
							onClick={() => setSelected(p.id)}
							className={cx(
								'flex h-6 items-center px-3 text-left text-pr-ui outline-none focus-visible:bg-pr-hover',
								p.id === current?.id ? 'bg-pr-selected text-pr-strong' : 'text-pr-text hover:bg-pr-hover',
							)}
						>
							{p.title}
						</button>
					))}
				</nav>
				<div className="min-w-0 flex-1 overflow-auto p-4" data-testid="preferences-page">
					{current ? (
						<SessionProvider key={epoch} session={props.session ?? null}>
							<current.component />
						</SessionProvider>
					) : (
						<p className="text-pr-muted">No preference pages are registered.</p>
					)}
				</div>
			</div>
		</Dialog>
	);
}

let registered = false;
/** Registers the dialog and the built-in General page (idempotent). */
export function registerPreferencesDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(PREFERENCES_DIALOG, PreferencesDialog);
	registerPreferencesPage({ id: 'general', title: 'General', order: 0, component: GeneralPreferencesPage });
}
