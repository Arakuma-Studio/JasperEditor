import type { RecoveryListResponse, VersionInfo } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import { type EditorSession, hasRecovery, persistenceFor, reopenSession } from '@jasper/session';
import { Button, confirmDialog, Dialog, type HostedDialogProps, registerDialog, TextField } from '@jasper/ui';
import { useEffect, useId, useState } from 'react';
import { saveBeforeLeaving } from '../runtime/save.ts';
import { recoveryChangeLabel } from '../shell/history-labels.ts';

export const PROJECT_FILE_DIALOGS = {
	saveAs: 'project.file.saveAs',
	versions: 'project.file.versions',
	recovery: 'project.file.recovery',
} as const;

export type ProjectFileActions = {
	readonly session: EditorSession;
	/** Writes the current document to a new project named `name`; with `open`, the editor switches to it. */
	saveAs(name: string, opts: { open: boolean }): Promise<string>;
	/** Discards unsaved changes and reloads the last saved state (File ▸ Revert). */
	revert(): Promise<void>;
	listVersions(): Promise<VersionInfo[]>;
	/** Writes a saved version over the project (the current state is kept as a version) and reloads it. */
	restoreVersion(versionId: string): Promise<void>;
	/** Opens a saved version as a new project. */
	openVersionAsCopy(versionId: string): Promise<string>;
	listRecovery(): Promise<RecoveryListResponse>;
	/** Applies a journal's unsaved changes as one undoable step, then deletes that journal. */
	recover(sessionId: string): Promise<void>;
	discardRecovery(sessionId: string): Promise<void>;
};

let current: ProjectFileActions | null = null;
const listeners = new Set<() => void>();

/** Registered by <ProjectLifecycle> for its session; returns the unregister function. */
export function registerProjectFileActions(a: ProjectFileActions): () => void {
	current = a;
	for (const l of [...listeners]) l();
	return () => {
		if (current === a) current = null;
		for (const l of [...listeners]) l();
	};
}

/** The actions of the open project, or null (Home, demo project without a store). */
export function projectFileActions(session?: EditorSession | null): ProjectFileActions | null {
	if (!current) return null;
	return session && current.session !== session ? null : current;
}

/** Whether the session's store keeps saved versions and recovery journals (the engine store does). */
export const supportsVersions = (session: EditorSession | null | undefined) =>
	hasRecovery(session?.projectStore);

const errorText = (e: unknown) =>
	e instanceof EngineError ? e.message : e instanceof Error ? e.message : String(e);

/**
 * Builds the actions for a session. `replace` swaps the lifecycle's session (revert, restore), `open` navigates to
 * another project.
 */
export function createProjectFileActions(
	session: EditorSession,
	deps: {
		replace(next: EditorSession): void;
		open(projectId: string): void;
	},
): ProjectFileActions {
	const store = session.projectStore;
	const recovery = hasRecovery(store) ? store : null;
	const need = () => {
		if (!recovery) throw new Error('This project is not stored by the engine: it has no saved versions');
		return recovery;
	};
	const leaseId = () => {
		const l = session.getState().lease;
		return l.status === 'held' && l.leaseId ? l.leaseId : undefined;
	};
	return {
		session,
		async saveAs(name, opts) {
			if (!store) throw new Error('This project has no store');
			const id = await store.saveDocumentAs(session.getCommitted(), name);
			if (opts.open) deps.open(id);
			return id;
		},
		async revert() {
			deps.replace(await reopenSession(session, { discardUnsaved: true }));
		},
		listVersions: () => need().listVersions(session.projectId),
		async restoreVersion(versionId) {
			const r = need();
			// what is on screen is saved first, so the state the restore replaces is kept as a version in full
			await saveBeforeLeaving(session);
			await r.revertToVersion(session.projectId, versionId, leaseId());
			deps.replace(await reopenSession(session));
		},
		async openVersionAsCopy(versionId) {
			const id = await need().restoreVersion(session.projectId, versionId);
			deps.open(id);
			return id;
		},
		async listRecovery() {
			if (!recovery) return { candidates: [], warnings: [] };
			const { candidates, warnings } = await recovery.listRecovery(session.projectId);
			return { candidates: candidates.filter((c) => c.sessionId !== session.sessionId), warnings };
		},
		async recover(sessionId) {
			const r = need();
			const snap = await r.readRecovery(session.projectId, sessionId);
			const res = session.replaceDocument(snap.document, 'Recover Unsaved Changes');
			if (!res.ok) throw new Error(res.errors[0]?.message ?? 'Could not apply the unsaved changes');
			// the recovered state goes into this session's journal (and the project file) before the old one goes
			const p = persistenceFor(session);
			await p?.journal?.flush();
			await saveBeforeLeaving(session);
			await r.discardRecovery(session.projectId, sessionId);
		},
		discardRecovery: (sessionId) => need().discardRecovery(session.projectId, sessionId),
	};
}

const when = (iso: string) => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

function SaveAsDialog(props: HostedDialogProps<{ title: string; initial: string; primary: string }>) {
	const [name, setName] = useState(props.initial);
	const id = useId();
	const trimmed = name.trim();
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title={props.title}
			size="small"
			primaryLabel={props.primary}
			primaryDisabled={!trimmed}
			onPrimary={() => {
				props.close(trimmed);
				return false;
			}}
			data-testid="save-as-dialog"
		>
			<div className="flex flex-col gap-1.5">
				<label htmlFor={id} className="text-pr-muted">
					Project name
				</label>
				<TextField
					id={id}
					value={name}
					maxLength={200}
					onChange={(e) => setName(e.target.value)}
					data-testid="save-as-name"
				/>
			</div>
		</Dialog>
	);
}

const KIND_LABEL: Record<string, string> = {
	auto: 'Auto-saved',
	'before-restore': 'Before a restore',
	'schema-backup': 'Older-format backup',
};

function VersionsDialog(props: HostedDialogProps<{ actions: ProjectFileActions }>) {
	const { actions } = props;
	const [versions, setVersions] = useState<VersionInfo[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let live = true;
		actions.listVersions().then(
			(v) => live && setVersions(v),
			(e) => live && setError(errorText(e)),
		);
		return () => {
			live = false;
		};
	}, [actions]);
	const run = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		try {
			await fn();
			props.close(true);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Project Versions"
			description="Saved versions of this project: restore one, or open it as a new project."
			size="medium"
			cancelLabel="Close"
			data-testid="versions-dialog"
		>
			<div className="flex flex-col gap-2">
				<p className="text-pr-muted">
					A version is kept every 5 minutes of editing (the newest 20), before each restore, and before the
					first save over a project from an older JasperEditor. Restoring keeps the current state as a
					version.
				</p>
				{error ? (
					<p className="text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
				{versions === null && !error ? <p className="text-pr-muted">Loading…</p> : null}
				{versions?.length === 0 ? (
					<p className="text-pr-muted" data-testid="versions-empty">
						No saved versions yet: the first one is kept the next time the project is saved.
					</p>
				) : null}
				<ul className="flex max-h-[360px] flex-col gap-1 overflow-auto" data-testid="versions-list">
					{versions?.map((v) => (
						<li
							key={v.versionId}
							className="flex items-center gap-2 rounded-pr-control bg-pr-field px-2 py-1"
							data-testid={`version-${v.versionId}`}
						>
							<div className="min-w-0 flex-1">
								<div className="text-pr-text">{when(v.savedAt)}</div>
								<div className="text-pr-small text-pr-muted">
									{KIND_LABEL[v.kind ?? 'auto'] ?? v.kind} · revision {v.revision}
									{v.schemaVersion !== undefined ? ` · format v${v.schemaVersion}` : ''} ·{' '}
									{Math.max(1, Math.round(v.sizeBytes / 1024))} KB
								</div>
							</div>
							<Button
								disabled={busy}
								onClick={() => void run(() => actions.openVersionAsCopy(v.versionId))}
								data-testid={`version-${v.versionId}-copy`}
							>
								Open as Copy
							</Button>
							<Button
								variant="primary"
								disabled={busy || v.kind === 'schema-backup'}
								title={
									v.kind === 'schema-backup'
										? 'An older-format backup is for older JasperEditor builds: open it as a copy'
										: undefined
								}
								onClick={() =>
									void confirmDialog({
										title: 'Restore this version?',
										body: `The project goes back to ${when(v.savedAt)}. The current state is kept as a version, so you can come back to it.`,
										confirmLabel: 'Restore',
									}).then((ok) => {
										if (ok) void run(() => actions.restoreVersion(v.versionId));
									})
								}
								data-testid={`version-${v.versionId}-restore`}
							>
								Restore
							</Button>
						</li>
					))}
				</ul>
			</div>
		</Dialog>
	);
}

function RecoveryDialog(
	props: HostedDialogProps<RecoveryListResponse & { actions: ProjectFileActions; atOpen: boolean }>,
) {
	const { actions, warnings } = props;
	const [candidates, setCandidates] = useState(props.candidates);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const c = candidates[0];
	const act = async (fn: () => Promise<void>, recovered: boolean) => {
		setBusy(true);
		setError(null);
		try {
			await fn();
			const rest = candidates.slice(1);
			if (recovered || (rest.length === 0 && warnings.length === 0))
				props.close(recovered ? 'recovered' : 'done');
			else setCandidates(rest);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close('later')}
			title="Recover Unsaved Changes"
			size="medium"
			cancelLabel={c ? 'Not Now' : 'Close'}
			footerExtra={
				c ? (
					<Button
						variant="danger"
						disabled={busy}
						onClick={() => void act(() => actions.discardRecovery(c.sessionId), false)}
						data-testid="recovery-discard"
					>
						Discard
					</Button>
				) : null
			}
			primaryLabel={c ? 'Recover' : undefined}
			primaryDisabled={busy}
			onPrimary={() => {
				if (c) void act(() => actions.recover(c.sessionId), true);
				return false;
			}}
			data-testid="recovery-dialog"
		>
			<div className="flex flex-col gap-2">
				{warnings.length > 0 ? (
					<div className="text-pr-warning" role="alert" data-testid="recovery-warnings">
						<p>Some recovery files could not be read. They have been kept so they can be repaired.</p>
						<ul>
							{warnings.map((warning) => (
								<li key={warning.sessionId}>
									{warning.sessionId}: {warning.message} ({warning.code})
								</li>
							))}
						</ul>
					</div>
				) : null}
				{c ? (
					<>
						<p className="text-pr-text">
							{props.atOpen ? 'JasperEditor closed' : 'An editing session ended'} before “{c.projectName}” was
							saved. Recover the unsaved changes from {when(c.savedAt)}?
						</p>
						<p className="text-pr-muted" data-testid="recovery-changes">
							{c.changeCount} unsaved {c.changeCount === 1 ? 'change' : 'changes'}
							{c.changes.length
								? `: ${c.changes.slice(-8).map(recoveryChangeLabel).join(', ')}${c.changes.length > 8 || c.changeCount > c.changes.length ? '…' : ''}`
								: ''}
						</p>
						{c.projectRevision > c.baseRevision ? (
							<p className="text-pr-warning" role="alert">
								The project was saved again afterwards (revision {c.projectRevision}). Recovering replaces
								that saved state with these changes; Undo takes it back.
							</p>
						) : null}
						<p className="text-pr-small text-pr-muted">
							Recover applies them as one step you can undo. Not Now keeps them: File ▸ Recover Unsaved
							Changes… offers them again.
							{candidates.length > 1 ? ` ${candidates.length - 1} more after this one.` : ''}
						</p>
					</>
				) : null}
				{error ? (
					<p className="text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

registerDialog(PROJECT_FILE_DIALOGS.saveAs, SaveAsDialog);
registerDialog(PROJECT_FILE_DIALOGS.versions, VersionsDialog);
registerDialog(PROJECT_FILE_DIALOGS.recovery, RecoveryDialog);
