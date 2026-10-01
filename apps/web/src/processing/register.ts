// Registers the clip-processing UI into the M2 extension points (ARCHITECTURE §19.10). Called at module load of
// `commands/process.ts` (in COMMAND_MODULES): the Process Clip dialog, Edit ▸ Preferences (dialog shell + the
// Processing page), the Properties ▸ Media Version section, the timeline clip and Project item context-menu
// entries and the "processed" badge host.
import type { MediaAsset, ProjectDocument } from '@jasper/project';
import { registerDialog } from '@jasper/ui';
import {
	clipMenuExtensions,
	clipSections,
	type MenuItemSpec,
	programOverlays,
	projectItemMenuExtensions,
} from '../extensions/index.ts';
import { registerPreferencesDialog, registerPreferencesPage } from '../shell/preferences/index.ts';
import { openProcessForClips, openProcessForMedia, switchMediaVersion } from './actions.ts';
import { ProcessedDecorations } from './decorations.tsx';
import { MediaVersionSection } from './MediaVersionSection.tsx';
import { originalOf, versionLabel, versionsOf } from './model.ts';
import { ProcessingPreferencesPage } from './PreferencesPage.tsx';
import { PROCESS_DIALOG, ProcessDialog } from './ProcessDialog.tsx';

export const PROCESS_MENU_LABEL = 'Process Clip…';

/** "Media Version" submenu for a clip (Original + processed versions of the same original). */
function versionMenu(doc: ProjectDocument, mediaId: string, run: (id: string) => void): MenuItemSpec | null {
	const original = originalOf(doc, mediaId);
	if (!original) return null;
	const versions = versionsOf(doc, original);
	if (versions.length < 2) return null;
	return {
		kind: 'submenu',
		label: 'Media Version',
		items: versions.map((id) => ({
			kind: 'item' as const,
			label: id === original ? 'Original' : versionLabel(doc, id),
			checked: id === mediaId,
			run: () => run(id),
		})),
	};
}

let registered = false;
export function registerProcessingUi(): void {
	if (registered) return;
	registered = true;
	registerDialog(PROCESS_DIALOG, ProcessDialog);
	registerPreferencesDialog();
	registerPreferencesPage({
		id: 'processing',
		title: 'Processing',
		order: 50,
		component: ProcessingPreferencesPage,
	});

	clipSections.register({
		id: 'process.mediaVersion',
		title: 'Media Version',
		order: 50,
		appliesTo: (clips) => clips.some((c) => c.kind === 'video'),
		component: MediaVersionSection,
	});

	clipMenuExtensions.register({
		id: 'process',
		order: 50,
		items: ({ session, clip, selection }) => {
			if (clip.kind !== 'video') return [];
			const readOnly = session.getState().readOnly;
			const ids = selection.includes(clip.id) ? selection : [clip.id];
			const items: MenuItemSpec[] = [
				{
					kind: 'item',
					label: PROCESS_MENU_LABEL,
					disabled: readOnly,
					run: () => void openProcessForClips(session, ids),
				},
			];
			const mediaId = (clip as { mediaId?: string }).mediaId;
			const sub = mediaId
				? versionMenu(session.getCommitted(), mediaId, (id) => void switchMediaVersion(session, ids, id))
				: null;
			if (sub && !readOnly) items.push(sub);
			return items;
		},
	});

	projectItemMenuExtensions.register({
		id: 'process',
		order: 50,
		items: ({ session, items, readOnly }) => {
			if (items.length !== 1) return [];
			const it = items[0] as { kind: string; mediaId?: string };
			if (it.kind !== 'media' || !it.mediaId) return [];
			const m = session.getCommitted().media[it.mediaId] as MediaAsset | undefined;
			if (m?.kind !== 'video') return [];
			const mediaId = it.mediaId;
			return [
				{
					kind: 'item',
					label: PROCESS_MENU_LABEL,
					disabled: readOnly,
					run: () => void openProcessForMedia(session, mediaId),
				},
			];
		},
	});

	// Hosts the "processed" badges (see decorations.tsx: no timeline/project badge hook exists yet).
	programOverlays.register({
		id: 'process.decorations',
		order: 1000,
		active: () => true,
		component: ProcessedDecorations,
	});
}
