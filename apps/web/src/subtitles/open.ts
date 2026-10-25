// spec 13: opening the subtitle dialogs (registered in register.ts).
import type { EditorSession } from '@jasper/session';
import { openDialog } from '@jasper/ui';
import type { SubtitleSourceChoice } from './model.ts';

export const CREATE_SUBTITLES_DIALOG = 'subtitles.create';
export const SAVE_TEMPLATE_DIALOG = 'subtitles.saveTemplate';
export const APPLY_TEMPLATE_DIALOG = 'subtitles.applyTemplate';

export function openCreateSubtitles(session: EditorSession, sequenceId: string, source?: SubtitleSourceChoice): void {
	void openDialog(CREATE_SUBTITLES_DIALOG, { session, sequenceId, ...(source ? { source } : {}) });
}

export function openSaveTemplate(session: EditorSession, clipId: string): void {
	void openDialog(SAVE_TEMPLATE_DIALOG, { session, clipId });
}

export type ApplyTarget = { groupId: string; templateId: string } | { clipIds: string[]; templateId: string };

export function openApplyTemplate(session: EditorSession, target: ApplyTarget): void {
	void openDialog(APPLY_TEMPLATE_DIALOG, { session, target });
}
