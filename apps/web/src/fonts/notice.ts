// wp fonts: when a project opens with fonts that are neither bundled nor installed, say so once (Premiere asks to
// resolve missing fonts on open), with a Resolve Fonts… action. Text set in them renders with the default font until
// they are installed.
import type { FontCatalog } from '@jasper/api';
import type { EditorSession } from '@jasper/session';
import { toast } from '@jasper/ui';
import { useEffect } from 'react';
import { t } from '../i18n/runtime.ts';
import { missingProjectFonts } from './actions.ts';

const notified = new Set<string>();

export function useMissingFontsNotice(session: EditorSession | null, catalog: FontCatalog | null): void {
	const projectId = session?.getCommitted().projectId ?? null;
	useEffect(() => {
		if (!session || !catalog || !projectId || notified.has(projectId)) return;
		notified.add(projectId);
		let missing: ReturnType<typeof missingProjectFonts>;
		try {
			missing = missingProjectFonts(session.getCommitted(), catalog);
		} catch {
			return;
		}
		if (!missing.length) return;
		const names = missing.map((m) => m.font.family);
		const list = `${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`;
		toast({
			kind: 'warning',
			title: missing.length === 1 ? 'A font is missing' : `${missing.length} fonts are missing`,
			detail:
				missing.length === 1
					? t('{0}: text set in it uses the default font until it is installed.', list)
					: t('{0}: text set in them uses the default font until they are installed.', list),
			actions: [{ label: 'Resolve Fonts…', commandId: 'fonts.resolve' }],
			dedupeKey: `fonts.missing:${projectId}`,
			durationMs: 12_000,
		});
	}, [session, catalog, projectId]);
}
