// Registers the clip-processing UI into the M2 extension points (ARCHITECTURE §19.10). Called at module load of
// `commands/process.ts` (in COMMAND_MODULES): the Process Clip dialog, Edit ▸ Preferences (dialog shell + the
// Processing page), the Properties ▸ Media Version section, the timeline clip and Project item context-menu
// entries and the "processed" badge host.
import { type MediaAsset, mediaVersionsOf, originalMediaId, type ProjectDocument } from '@jasper/project';
import { registerDialog, toast } from '@jasper/ui';
import {
	clipMenuExtensions,
	clipSections,
	type MenuItemSpec,
	programOverlays,
	projectItemMenuExtensions,
} from '../extensions/index.ts';
import { registerPreferencesDialog, registerPreferencesPage } from '../shell/preferences/index.ts';
import {
	openProcessForClips,
	openProcessForMedia,
	openReplaceFootage,
	replaceFootageBlocker,
	switchMediaVersionInteractive,
} from './actions.ts';
import { ProcessedDecorations } from './decorations.tsx';
import { MediaVersionSection } from './MediaVersionSection.tsx';
import { versionLabel } from './model.ts';
import { ProcessingPreferencesPage } from './PreferencesPage.tsx';
import { PROCESS_DIALOG, ProcessDialog } from './ProcessDialog.tsx';
import { REPLACE_FOOTAGE_DIALOG, ReplaceFootageDialog } from './ReplaceFootageDialog.tsx';

const PROCESS_MENU_LABEL = 'Process Clip…';
const REPLACE_FOOTAGE_MENU_LABEL = 'Replace Footage…';

/** "Media Version" submenu for a clip (Original + processed versions of the same original). */
function versionMenu(doc: ProjectDocument, mediaId: string, run: (id: string) => void): MenuItemSpec | null {
	const original = originalMediaId(doc, mediaId);
	if (!original) return null;
	const versions = mediaVersionsOf(doc, original);
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
	registerDialog(REPLACE_FOOTAGE_DIALOG, ReplaceFootageDialog);
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
				? versionMenu(session.getCommitted(), mediaId, (id) => {
						void switchMediaVersionInteractive(session, ids, id).then((r) => {
							if (r && !r.ok)
								toast({ kind: 'warning', title: 'Could not switch the version', detail: r.message });
						});
					})
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
			const doc = session.getCommitted();
			const m = doc.media[it.mediaId] as MediaAsset | undefined;
			const mediaId = it.mediaId;
			const out: MenuItemSpec[] = [];
			if (m?.kind === 'video')
				out.push({
					kind: 'item',
					label: PROCESS_MENU_LABEL,
					disabled: readOnly,
					run: () => void openProcessForMedia(session, mediaId),
				});
			// S07:PRC-018 (Premiere: Project panel ▸ Replace Footage…).
			if (m && (m.kind === 'video' || m.kind === 'audio' || m.kind === 'image'))
				out.push({
					kind: 'item',
					label: REPLACE_FOOTAGE_MENU_LABEL,
					disabled: readOnly || !!replaceFootageBlocker(doc, mediaId),
					run: () => void openReplaceFootage(session, mediaId),
				});
			return out;
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
