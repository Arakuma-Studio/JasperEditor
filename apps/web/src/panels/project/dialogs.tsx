// Project panel dialogs: New Sequence (name + preset, S05:PRJ-003) and the in-use delete confirmation
// (S01:PRJ-006). Rendered by <ProjectDialogHost/> (mounted by ProjectLifecycle).

import { useSession } from '@jasper/session/react';
import { Button } from '@jasper/ui';
import { useState, useSyncExternalStore } from 'react';
import { labelDefault } from '../../gaps/app-prefs.ts';
import { notices } from '../../home/notices.tsx';
import { Dialog } from '../../import/ImportPromptHost.tsx';

type ProjectDialog =
	| { kind: 'newSequence'; binId: string | null }
	| {
			kind: 'confirm';
			title: string;
			message: string;
			confirmLabel: string;
			danger?: boolean;
			onConfirm(): void;
	  };

let current: ProjectDialog | null = null;
const listeners = new Set<() => void>();
const emit = () => {
	for (const l of [...listeners]) l();
};

export const projectDialogs = {
	get: () => current,
	subscribe(l: () => void) {
		listeners.add(l);
		return () => listeners.delete(l);
	},
	open(d: ProjectDialog) {
		current = d;
		emit();
	},
	close() {
		current = null;
		emit();
	},
};

/** Next free "Sequence N" name. */
function nextSequenceName(names: string[]): string {
	let n = 1;
	const taken = new Set(names);
	while (taken.has(`Sequence ${String(n).padStart(2, '0')}`)) n++;
	return `Sequence ${String(n).padStart(2, '0')}`;
}

function NewSequenceDialog({ binId }: { binId: string | null }) {
	const session = useSession();
	const doc = session.getCommitted();
	const presets = session.ctx.registries.presets.list();
	const [name, setName] = useState(() =>
		nextSequenceName(
			Object.values(doc.items)
				.filter((i) => i.kind === 'sequence')
				.map((i) => i.name),
		),
	);
	const [preset, setPreset] = useState(doc.settings.defaultSequencePreset);
	const create = () => {
		const r = session.apply({
			label: 'New Sequence',
			origin: 'user',
			commands: [
				{
					type: 'sequence.create',
					name: name.trim() || 'Sequence',
					preset,
					binId,
					...(labelDefault('sequence') ? { label: labelDefault('sequence') } : {}),
				},
			],
		});
		if (!r.ok) {
			notices.push({ kind: 'error', message: 'Could not create the sequence', detail: r.errors[0]?.message });
			return;
		}
		const out = r.results[0] as { sequenceId?: string; itemId?: string } | undefined;
		if (out?.sequenceId) session.openSequence(out.sequenceId);
		if (out?.itemId) session.select('project', [out.itemId], 'replace');
		projectDialogs.close();
	};
	return (
		<Dialog
			title="New Sequence"
			testId="dialog-new-sequence"
			onEscape={() => projectDialogs.close()}
			footer={
				<>
					<Button onClick={() => projectDialogs.close()}>Cancel</Button>
					<Button variant="primary" data-testid="new-sequence-ok" onClick={create}>
						OK
					</Button>
				</>
			}
		>
			<form
				className="flex flex-col gap-3"
				onSubmit={(e) => {
					e.preventDefault();
					create();
				}}
			>
				<label className="flex flex-col gap-1">
					<span className="text-pr-small text-pr-muted">Sequence name</span>
					<input
						data-autofocus
						data-testid="new-sequence-name"
						className="h-[var(--pr-control-h)] rounded-pr-control bg-pr-field px-2 text-pr-text"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-pr-small text-pr-muted">Preset</span>
					<select
						data-testid="new-sequence-preset"
						className="h-[var(--pr-control-h)] rounded-pr-control bg-pr-field px-2 text-pr-text"
						value={preset}
						onChange={(e) => setPreset(e.target.value)}
					>
						{presets.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
				</label>
			</form>
		</Dialog>
	);
}

export function ProjectDialogHost() {
	const d = useSyncExternalStore(projectDialogs.subscribe, projectDialogs.get, projectDialogs.get);
	if (!d) return null;
	if (d.kind === 'newSequence') return <NewSequenceDialog binId={d.binId} />;
	return (
		<Dialog
			title={d.title}
			testId="dialog-confirm"
			onEscape={() => projectDialogs.close()}
			footer={
				<>
					<Button onClick={() => projectDialogs.close()}>Cancel</Button>
					<Button
						variant={d.danger ? 'danger' : 'primary'}
						data-autofocus
						data-testid="confirm-ok"
						onClick={() => {
							projectDialogs.close();
							d.onConfirm();
						}}
					>
						{d.confirmLabel}
					</Button>
				</>
			}
		>
			<p>{d.message}</p>
		</Dialog>
	);
}
