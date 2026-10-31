// Spec 18 AF-BRF-006: Sequence ▸ Brief… — edit the sequence's brief (Save = one "Edit Brief" undo step) and see the
// notes agents kept about the project; Remove deletes a note in one undoable step ("Remove Agent Note", Undo in the
// toast and Edit ▸ Undo). Read-only projects show both without editing. Failures are shown in the dialog.
import { type AgentNote, readAgentNotes, readSequenceBrief } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { Button, Dialog, type HostedDialogProps, registerDialog, toast } from '@jasper/ui';
import { useMemo, useState } from 'react';
import { useDialogClose } from '../extensions/dialog.ts';
import { t } from '../i18n/runtime.ts';
import { sequenceName } from '../speech/model.ts';
import { BriefFields } from './BriefFields.tsx';
import {
	type BriefForm,
	briefFormProblem,
	briefPatch,
	formAspect,
	formOfBrief,
	frameAspectOf,
} from './model.ts';

export const BRIEF_DIALOG = 'brief.edit';

let registered = false;
export function registerBriefDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(BRIEF_DIALOG, BriefDialog);
}

export type BriefDialogProps = { session: EditorSession; sequenceId: string };

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
	const [error, setError] = useState<string | null>(null);
	const notes = useMemo(() => [...readAgentNotes(doc)].reverse(), [doc]);
	const problem = briefFormProblem(form);
	const changed = !sameForm(form, stored);
	const wanted = formAspect(form);
	const frame = seq ? frameAspectOf(seq.settings.width, seq.settings.height) : '?';

	const save = (): boolean => {
		if (!seq || readOnly || problem) return false;
		if (!changed) return true;
		const r = session.apply({
			label: t('Edit Brief'),
			origin: 'user',
			sequenceId,
			commands: [{ type: 'sequence.setBrief', sequenceId, brief: briefPatch(form) }] as never[],
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
		const revision = r.revision;
		toast({
			kind: 'info',
			title: t('Agent note removed'),
			detail: n.text.slice(0, 80),
			actions: [
				{
					label: t('Undo'),
					run: () => {
						if (session.getState().revision === revision) session.undo();
						else toast({ kind: 'info', title: t('Newer edits came after it; use the History panel') });
					},
				},
			],
		});
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
