// Spec 18 AF-BRF-006: Sequence ▸ Brief… — edit the sequence's brief (Save = one "Edit Brief" undo step) and see the
// notes agents kept about the project; Remove deletes a note in one undoable step ("Remove Agent Note"; Undo right in
// the dialog, or Edit ▸ Undo / History later). Read-only projects show both without editing. Failures are shown in the dialog.
// When the brief changes while the dialog is open (an agent's set_brief, an undo), fields the user has not edited follow
// it, a notice names who changed it (and the agent's value of any field both edited), and Save writes only the fields the
// user edited: neither side is ever silently discarded.
import { type AgentNote, DELIVERY_TARGETS, readAgentNotes, readSequenceBrief } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { Button, Dialog, type HostedDialogProps, registerDialog } from '@jasper/ui';
import { useEffect, useMemo, useState } from 'react';
import { useDialogClose } from '../extensions/dialog.ts';
import { t } from '../i18n/runtime.ts';
import { sequenceName } from '../speech/model.ts';
import { BriefFields } from './BriefFields.tsx';
import {
	ASPECT_NAMES,
	type BriefForm,
	type BriefFormKey,
	briefFormProblem,
	editedBriefPatch,
	formAspect,
	formOfBrief,
	frameAspectOf,
	rebaseBriefForm,
} from './model.ts';

export const BRIEF_DIALOG = 'brief.edit';

let registered = false;
export function registerBriefDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(BRIEF_DIALOG, BriefDialog);
}

export type BriefDialogProps = { session: EditorSession; sequenceId: string };

function fieldValue(k: BriefFormKey, f: BriefForm): string {
	if (k === 'text')
		return f.text ? `“${f.text.length > 80 ? `${f.text.slice(0, 80)}…` : f.text}”` : t('(empty)');
	if (k === 'platform')
		return f.platform
			? (DELIVERY_TARGETS.find((x) => x.id === f.platform)?.name ?? f.platform)
			: t('Not decided');
	if (k === 'aspect') return f.aspect ? ASPECT_NAMES[f.aspect] : t("Platform's");
	return f.duration.trim() || t('none');
}

const FIELD_NAMES: Record<BriefFormKey, string> = {
	text: 'Description',
	platform: 'Platform',
	aspect: 'Frame',
	duration: 'Target length',
};

/** Who made the newest History entry: the agent's name, else null (the user, an undo or redo). */
function lastAgent(session: EditorSession): string | null {
	const h = session.getState().history;
	const top = h.entries[h.index - 1];
	return top && typeof top.origin === 'object' ? top.origin.agent : null;
}

type ChangedNotice = { by: string | null; conflicts: { key: BriefFormKey; theirs: string }[] };

const sameForm = (a: BriefForm, b: BriefForm) =>
	a.text === b.text &&
	a.platform === b.platform &&
	a.aspect === b.aspect &&
	a.duration.trim() === b.duration.trim();

function when(iso: string): string {
	const d = new Date(iso);
	return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

export function BriefDialog(props: HostedDialogProps<BriefDialogProps>) {
	const { open, finish } = useDialogClose(props.close);
	const { session, sequenceId } = props;
	const doc = useStoreSelector(session.store, (s) => s.document);
	const readOnly = useStoreSelector(session.store, (s) => s.readOnly);
	const seq = doc.sequences[sequenceId];
	const stored = useMemo(() => formOfBrief(readSequenceBrief(seq)), [seq]);
	const [form, setForm] = useState<BriefForm>(stored);
	// the stored brief the form is based on (what Save compares the user's edits with)
	const [base, setBase] = useState<BriefForm>(stored);
	const [changedBy, setChangedBy] = useState<ChangedNotice | null>(null);
	useEffect(() => {
		if (sameForm(stored, base)) return;
		const r = rebaseBriefForm(form, base, stored);
		setForm(r.form);
		setBase(stored);
		setChangedBy({
			by: lastAgent(session),
			conflicts: r.conflicts.map((key) => ({ key, theirs: fieldValue(key, stored) })),
		});
	}, [stored, base, form, session]);
	const [error, setError] = useState<string | null>(null);
	const [removed, setRemoved] = useState<{ note: AgentNote; revision: number } | null>(null);
	const notes = useMemo(() => [...readAgentNotes(doc)].reverse(), [doc]);
	const problem = briefFormProblem(form);
	const wanted = formAspect(form);
	const frame = seq ? frameAspectOf(seq.settings.width, seq.settings.height) : '?';

	const save = (): boolean => {
		if (!seq || readOnly || problem) return false;
		// only the fields the user edited: a brief an agent changed meanwhile keeps the agent's other fields
		const patch = editedBriefPatch(form, base);
		if (!patch) return true;
		const r = session.apply({
			label: t('Edit Brief'),
			origin: 'user',
			sequenceId,
			commands: [{ type: 'sequence.setBrief', sequenceId, brief: patch }] as never[],
		});
		if (!r.ok) {
			setError(r.errors.map((e) => `${e.code}: ${e.message}`).join('; '));
			return false;
		}
		return true;
	};

	const remove = (n: AgentNote) => {
		const r = session.apply({
			label: t('Remove Agent Note'),
			origin: 'user',
			commands: [{ type: 'project.removeAgentNote', noteId: n.id }] as never[],
		});
		if (!r.ok) {
			setError(r.errors.map((e) => `${e.code}: ${e.message}`).join('; '));
			return;
		}
		setError(null);
		setRemoved({ note: n, revision: r.revision });
	};

	// Undo of the last removal, while nothing else changed the project since (else History has it).
	const undoRemove = () => {
		if (!removed) return;
		if (session.getState().revision !== removed.revision) {
			setError(t('Newer edits came after it; use the History panel'));
			setRemoved(null);
			return;
		}
		const r = session.undo();
		if (!r.ok) setError(t('Undo failed ({0})', r.code ?? 'unknown'));
		setRemoved(null);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title={seq ? t('Brief — {0}', sequenceName(doc, sequenceId)) : t('Brief')}
			size="large"
			primaryLabel={readOnly ? t('Close') : t('Save')}
			hideCancel={readOnly}
			primaryDisabled={!seq || (!readOnly && !!problem)}
			onPrimary={() => {
				if (readOnly) return true;
				return save();
			}}
			data-testid="brief-dialog"
		>
			{!seq ? (
				<p className="text-pr-small text-pr-muted">{t('Open a sequence first')}</p>
			) : (
				<div className="flex flex-col gap-4 text-pr-ui">
					<p className="text-pr-small text-pr-muted">
						What this video should be. AI agents connected to JasperEditor read it (get_brief) before they
						cut; it is saved with the sequence.
					</p>
					{readOnly ? (
						<p className="text-pr-small text-pr-warning" role="status">
							{t('The project is read-only')}
						</p>
					) : null}
					<BriefFields
						form={form}
						onChange={setForm}
						disabled={readOnly}
						idPrefix="brief"
						autoFocus
						rows={6}
					/>
					{wanted && wanted !== frame ? (
						<p className="text-pr-small text-pr-muted" data-testid="brief-frame-note">
							{t(
								'The sequence frame is {0} ({1}×{2}); the brief asks for {3}. Change it in Sequence ▸ Sequence Settings… or with Auto Reframe Sequence….',
								frame,
								seq.settings.width,
								seq.settings.height,
								wanted,
							)}
						</p>
					) : null}
					{changedBy ? (
						<div className="flex flex-col gap-1 text-pr-small" role="status" data-testid="brief-changed">
							<p className="text-pr-warning">
								{changedBy.by
									? t(
											'{0} changed the brief while this dialog was open; the fields you did not edit now show the new brief.',
											changedBy.by,
										)
									: t(
											'The brief changed while this dialog was open; the fields you did not edit now show the new brief.',
										)}
							</p>
							{changedBy.conflicts.map((c) => (
								<p key={c.key} className="text-pr-muted">
									{t(
										'{0}: you edited it, so your value stays; Save replaces the new value {1}.',
										FIELD_NAMES[c.key],
										c.theirs,
									)}
								</p>
							))}
						</div>
					) : null}
					{removed ? (
						<div
							className="flex items-center gap-2 text-pr-small"
							role="status"
							data-testid="brief-note-removed"
						>
							<span className="min-w-0 flex-1 truncate text-pr-muted">
								{t('Note removed: {0}', removed.note.text)}
							</span>
							<Button variant="quiet" onClick={undoRemove} data-testid="brief-note-undo">
								Undo
							</Button>
						</div>
					) : null}
					{error ? (
						<p className="text-pr-small text-pr-warning" role="alert" data-testid="brief-error">
							{error}
						</p>
					) : null}
					<section className="flex flex-col gap-2" aria-label={t('Agent notes')} data-testid="brief-notes">
						<h3 className="font-semibold text-pr-strong">
							{notes.length ? t('Agent notes ({0})', notes.length) : t('Agent notes')}
						</h3>
						{notes.length === 0 ? (
							<p className="text-pr-small text-pr-muted">
								No notes yet. Agents keep notes here (add_agent_note): decisions, chosen takes, open
								questions.
							</p>
						) : (
							<ul className="flex max-h-64 flex-col gap-2 overflow-auto">
								{notes.map((n) => (
									<li
										key={n.id}
										className="flex items-start gap-2 rounded-pr-control bg-pr-raised p-2"
										data-testid="brief-note"
									>
										<div className="min-w-0 flex-1">
											<p className="text-pr-small text-pr-muted">
												{n.author} · {when(n.at)}
											</p>
											<p className="whitespace-pre-wrap break-words text-pr-text select-text">{n.text}</p>
										</div>
										<Button
											variant="quiet"
											disabled={readOnly}
											onClick={() => remove(n)}
											data-testid="brief-note-remove"
											title={readOnly ? t('The project is read-only') : t('Remove this note (undoable)')}
										>
											Remove
										</Button>
									</li>
								))}
							</ul>
						)}
					</section>
				</div>
			)}
		</Dialog>
	);
}
