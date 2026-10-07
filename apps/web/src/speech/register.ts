// wp speech: registers the Generate Transcript dialog, Preferences ▸ Transcription, and the "Generate Transcript…" entries of
// the Project panel item menu and the timeline clip menu (extension points, ARCHITECTURE §19.10). Called at module load
// of `commands/speech.ts` (in COMMAND_MODULES).
import { type MediaAsset, transcriptForMedia } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { openDialog, registerDialog } from '@jasper/ui';
import {
	clipMenuExtensions,
	type MenuItemSpec,
	programOverlays,
	projectItemMenuExtensions,
} from '../extensions/index.ts';
import { registerPreferencesDialog, registerPreferencesPage } from '../shell/preferences/index.ts';
import { AutoTranscribeHost } from './auto.tsx';
import {
	GENERATE_TRANSCRIPT_DIALOG,
	GenerateTranscriptDialog,
	type GenerateTranscriptTarget,
} from './GenerateTranscriptDialog.tsx';
import { clipMedia, hasAudio } from './model.ts';
import { SpeechPreferencesPage } from './PreferencesPage.tsx';

export const GENERATE_MENU_LABEL = 'Generate Transcript…';

export function openGenerateTranscript(session: EditorSession, target: GenerateTranscriptTarget): void {
	void openDialog(GENERATE_TRANSCRIPT_DIALOG, { session, target });
}

let registered = false;
export function registerSpeechUi(): void {
	if (registered) return;
	registered = true;
	registerDialog(GENERATE_TRANSCRIPT_DIALOG, GenerateTranscriptDialog);
	registerPreferencesDialog();
	registerPreferencesPage({
		id: 'speech',
		title: 'Transcription',
		order: 55,
		component: SpeechPreferencesPage,
	});

	// Automatic transcription of imported media (Preferences ▸ Transcription)
	programOverlays.register({
		id: 'speech.auto',
		active: () => true,
		component: AutoTranscribeHost,
		order: 0,
	});

	projectItemMenuExtensions.register({
		id: 'speech',
		order: 55,
		items: ({ session, items, readOnly }) => {
			const doc = session.getCommitted();
			const mediaIds = items
				.map((it) => (it as { kind: string; mediaId?: string }).mediaId)
				.filter((id): id is string => !!id && hasAudio(doc.media[id] as MediaAsset));
			if (!mediaIds.length || mediaIds.length !== items.length) return [];
			const again = mediaIds.every((id) => !!transcriptForMedia(doc, id));
			return [
				{
					kind: 'item',
					label: again ? 'Generate Transcript Again…' : GENERATE_MENU_LABEL,
					disabled: readOnly,
					run: () => openGenerateTranscript(session, { kind: 'media', mediaIds }),
				} satisfies MenuItemSpec,
			];
		},
	});

	clipMenuExtensions.register({
		id: 'speech',
		order: 55,
		items: ({ session, clip, selection }) => {
			if (clip.kind !== 'audio' && clip.kind !== 'video') return [];
			const doc = session.getCommitted();
			const mediaIds = clipMedia(doc, selection.includes(clip.id) ? selection : [clip.id]);
			if (!mediaIds.length) return [];
			return [
				{
					kind: 'item',
					label: GENERATE_MENU_LABEL,
					disabled: session.getState().readOnly,
					run: () => openGenerateTranscript(session, { kind: 'media', mediaIds }),
				},
			];
		},
	});
}
