// spec 13 AS-032: linked text style actions on the editor session (shared by the Properties ▸ Text Style section, the
// Edit menu and the command palette). Each action is one transaction = one History entry.
import type { Clip, Command, ProjectDocument, Sequence, TransactionResult } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { confirmDialog, toast } from '@jasper/ui';
import { promptName } from '../gaps/SmallDialogs.tsx';
import { t } from '../i18n/runtime.ts';
import { selectionHelpers } from '../selection/helpers.ts';
import {
	applyCommands,
	createFromSelectionCommands,
	deleteCommands,
	detachCommands,
	freeStyleName,
	isTextClip,
	redefineCommands,
	renameCommands,
	resetCommands,
	selectionLink,
	styleNameProblem,
	styleRows,
} from './model.ts';

export type TextSelection = { doc: ProjectDocument; seq: Sequence; clips: Clip[]; primary: Clip | null };

/** The selected clips of the active sequence (committed document) and the primary one. */
export function currentSelection(session: EditorSession): TextSelection | null {
	const s = session.getState();
	const doc = session.getCommitted();
	const seq = s.activeSequenceId ? doc.sequences[s.activeSequenceId] : undefined;
	if (!seq) return null;
	const clips = s.selection.timeline.clips.map((id) => seq.clips[id]).filter((c): c is Clip => !!c);
	const pid = s.selection.timeline.primaryClip;
	const primary = (pid ? seq.clips[pid] : undefined) ?? clips[clips.length - 1] ?? null;
	return { doc, seq, clips, primary };
}

function run(session: EditorSession, label: string, commands: Command[]): TransactionResult | null {
	if (!commands.length) return null;
	const r = session.apply({ label, origin: 'user', commands });
	if (!r.ok) toast({ kind: 'error', message: `${label}: ${r.errors.map((e) => e.message).join('; ')}` });
	return r;
}

/** "(3 clips)" in History labels (stored in English like every step label, translated where shown). */
const count = (n: number) => (n === 1 ? '1 clip' : `${n} clips`);
const clipsText = (n: number) => (n === 1 ? t('1 clip') : t('{0} clips', n));

/** New Style from Selection…: names a style made from the primary text clip and links every selected text clip. */
export async function newStyleFromSelection(session: EditorSession): Promise<void> {
	const sel = currentSelection(session);
	const text = sel?.clips.filter(isTextClip) ?? [];
	const primary = sel?.primary && isTextClip(sel.primary) ? sel.primary : text[text.length - 1];
	if (!sel || !primary) {
		toast({ kind: 'info', message: 'Select a text clip first.' });
		return;
	}
	const name = await promptName({
		title: 'New Text Style',
		label: 'Name',
		initial: freeStyleName(sel.doc, 'Text Style'),
		primaryLabel: 'Create',
		maxLength: 120,
		validate: (n) => styleNameProblem(session.getCommitted(), n),
	});
	if (!name) return;
	run(session, `New Text Style (${count(text.length)})`, createFromSelectionCommands(primary, text, name));
}

export function applyStyle(session: EditorSession, styleId: string, clips?: readonly Clip[]): void {
	const text = (clips ?? currentSelection(session)?.clips ?? []).filter(isTextClip);
	if (!text.length) return;
	run(session, `Apply Text Style (${count(text.length)})`, applyCommands(styleId, text));
}

export function detachSelection(session: EditorSession): void {
	const sel = currentSelection(session);
	const linked = sel ? selectionLink(sel.doc, sel.clips).linked : [];
	if (!linked.length) {
		toast({ kind: 'info', message: 'No selected clip is linked to a text style.' });
		return;
	}
	run(session, `Detach From Text Style (${count(linked.length)})`, detachCommands(linked));
}

export function resetSelection(session: EditorSession): void {
	const sel = currentSelection(session);
	const linked = sel ? selectionLink(sel.doc, sel.clips).linked : [];
	if (!linked.length) {
		toast({ kind: 'info', message: 'No selected clip is linked to a text style.' });
		return;
	}
	run(session, `Reset to Text Style (${count(linked.length)})`, resetCommands(linked));
}

/** Redefine Style from Clip: the style takes this clip's look and every linked clip follows. */
export function redefineStyle(session: EditorSession, styleId: string, clip: Clip): void {
	const uses = styleRows(session.getCommitted()).find((r) => r.style.id === styleId)?.uses ?? 0;
	run(session, `Update Text Style (${count(uses)})`, redefineCommands(styleId, clip));
}

export async function renameStyle(session: EditorSession, styleId: string): Promise<void> {
	const row = styleRows(session.getCommitted()).find((r) => r.style.id === styleId);
	if (!row) return;
	const name = await promptName({
		title: 'Rename Text Style',
		label: 'Name',
		initial: row.style.name,
		primaryLabel: 'Rename',
		maxLength: 120,
		validate: (n) => styleNameProblem(session.getCommitted(), n, styleId),
	});
	if (!name || name === row.style.name) return;
	run(session, 'Rename Text Style', renameCommands(styleId, name));
}

/** Delete Style… (with its usage count): linked clips keep their look and are detached. Undoable. */
export async function deleteStyle(session: EditorSession, styleId: string): Promise<void> {
	const row = styleRows(session.getCommitted()).find((r) => r.style.id === styleId);
	if (!row) return;
	const ok = await confirmDialog({
		title: `Delete the text style “${row.style.name}”?`,
		body:
			row.uses > 0
				? t('{0} linked to it keep their look and are detached. You can undo this.', clipsText(row.uses))
				: t('No clip is linked to it. You can undo this.'),
		confirmLabel: 'Delete Style',
	});
	if (!ok) return;
	run(session, 'Delete Text Style', deleteCommands(styleId));
}

/** Selects every clip of the active sequence linked to a style (Text Styles list ▸ Select Clips). */
export function selectStyleClips(session: EditorSession, styleId: string): number {
	const sel = currentSelection(session);
	if (!sel) return 0;
	const ids = Object.values(sel.seq.clips)
		.filter((c) => c.kind === 'text' && (c as { styleId?: string }).styleId === styleId)
		.sort((a, b) => a.start - b.start)
		.map((c) => c.id);
	session.select('timeline', ids, 'replace', { linked: false });
	return ids.length;
}

/** Runs a Select ▸ helper on the current selection; returns how many clips it selected (null = refused). */
export function runSelectionHelper(session: EditorSession, helperId: string): number | null {
	const helper = selectionHelpers.get(helperId);
	const sel = currentSelection(session);
	if (!helper || !sel) return null;
	const input = { doc: sel.doc, seq: sel.seq, selected: sel.clips, primary: sel.primary };
	const reason = helper.unavailable?.(input) ?? null;
	if (reason) {
		toast({ kind: 'info', message: reason });
		return null;
	}
	const ids = helper.select(input);
	session.select('timeline', ids, 'replace', { linked: false, ...(sel.primary && ids.includes(sel.primary.id) ? { primary: sel.primary.id } : {}) });
	return ids.length;
}
