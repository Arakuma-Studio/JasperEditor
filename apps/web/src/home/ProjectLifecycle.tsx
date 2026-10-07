// Everything an open project needs besides the shell (ARCHITECTURE §6, §7.5):
// - autosave + page-lifecycle flush (S01:PER-020/022) through @jasper/session's attachPersistence;
// - read-only / lease-lost / conflict / repaired banners with "Take over editing" (S01:PER-040, MIG-003);
// - the ImportService registration (state/services.ts) and media runtime sync (S01:LIFE-050);
// - OS file drops anywhere in the editor that no other target handled (S05:PRJ-007);
// - export completion toasts with Download (S05:EX-013) and the Export mode overlay (S05:EX-001);
// - hosts for import prompts, Project panel dialogs and notices;
// - File ▸ Save As / Save a Copy / Revert / Project Versions / Recover Unsaved Changes, and the crash-recovery prompt
//   when the project opens with unsaved changes of a session that ended uncleanly (project-files.tsx, D-39).
// Rendered by App.tsx inside ProjectSessionHost, around the shell.
import { TERMINAL_JOB_STATES } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import {
	type AutosaveStatus,
	attachPersistence,
	type EditorSession,
	LeaseHeldError,
	type PersistenceController,
	persistenceFor,
	readOnlyReason,
	reopenSession,
	takeOverSession,
} from '@jasper/session';
import { SessionProvider, useSession, useStoreSelector } from '@jasper/session/react';
import { Button, openDialog, Z } from '@jasper/ui';
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { ExportMode } from '../export/ExportMode.tsx';
import { takeTrackedExport, useExportMode, useExportModeHostedByShell } from '../export/mode.ts';
import { ImportPromptHost } from '../import/ImportPromptHost.tsx';
import { createMediaRuntimeSync } from '../import/media-runtime.ts';
import { EngineImportService } from '../import/service.ts';
import { ProjectDialogHost } from '../panels/project/dialogs.tsx';
import { activeProjectBin } from '../panels/project/instances.ts';
import { useEngine } from '../state/engine.tsx';
import { registerImportService } from '../state/services.ts';
import { NoticeHost, notices } from './notices.tsx';
import {
	createProjectFileActions,
	PROJECT_FILE_DIALOGS,
	registerProjectFileActions,
} from './project-files.tsx';

const IDLE_STATUS: AutosaveStatus = {
	saving: false,
	lastSavedRevision: 0,
	lastSavedAt: null,
	conflict: null,
	error: null,
	paused: null,
	saves: 0,
	serverRevision: 0,
};

/** Autosave status of a session (header dirty dot / "Saving…"; S01:PER-020, S05:HD-002). */
export function usePersistenceStatus(session: EditorSession | null): AutosaveStatus {
	const [controller, setController] = useState<PersistenceController | null>(() => persistenceFor(session));
	useEffect(() => {
		setController(persistenceFor(session));
		const t = setTimeout(() => setController(persistenceFor(session)), 0);
		return () => clearTimeout(t);
	}, [session]);
	const subscribe = (l: () => void) => controller?.autosaver.subscribe(l) ?? (() => undefined);
	const get = () => controller?.autosaver.getStatus() ?? IDLE_STATUS;
	return useSyncExternalStore(subscribe, get, get);
}

export function ProjectLifecycle(props: { children?: ReactNode }) {
	const outer = useSession();
	const [session, setSession] = useState<EditorSession>(outer);
	useEffect(() => setSession(outer), [outer]);
	// A session opened here (take over / reopen) is ours to close.
	useEffect(() => {
		if (session === outer) return;
		return () => {
			void session.close();
		};
	}, [session, outer]);

	return (
		<SessionProvider session={session}>
			<LifecycleBody session={session} onReplace={setSession}>
				{props.children}
			</LifecycleBody>
		</SessionProvider>
	);
}

function LifecycleBody(props: {
	session: EditorSession;
	onReplace(s: EditorSession): void;
	children?: ReactNode;
}) {
	const { session } = props;
	const engine = useEngine();
	const exportState = useExportMode();
	const exportHostedByShell = useExportModeHostedByShell();

	// Autosave + page lifecycle
	useEffect(() => {
		if (!session.projectStore) return;
		const c = attachPersistence(session, {
			onError: (e) =>
				notices.push({
					kind: 'error',
					message: 'Autosave failed',
					detail: e instanceof Error ? e.message : String(e),
					durationMs: 8000,
				}),
		});
		return () => {
			void c.dispose();
		};
	}, [session]);

	// File actions (Save As, Revert, versions, recovery) and the crash-recovery prompt (S01:PER-021, AC-18).
	const navigate = useNavigate();
	const { onReplace } = props;
	useEffect(() => {
		const actions = createProjectFileActions(session, {
			replace: onReplace,
			open: (projectId) => navigate(`/project/${projectId}`),
		});
		const off = registerProjectFileActions(actions);
		let live = true;
		if (!session.getState().readOnly)
			void actions
				.listRecovery()
				.then((candidates) => {
					if (!live || candidates.length === 0) return;
					return openDialog(PROJECT_FILE_DIALOGS.recovery, { actions, candidates, atOpen: true }).then(
						(r) => {
							if (r === 'recovered')
								notices.push({
									kind: 'success',
									message: 'Unsaved changes recovered',
									detail: 'Edit ▸ Undo takes them back.',
								});
						},
					);
				})
				.catch((e) =>
					notices.push({
						kind: 'warning',
						message: 'Could not check for unsaved changes',
						detail: e instanceof Error ? e.message : String(e),
					}),
				);
		return () => {
			live = false;
			off();
		};
	}, [session, onReplace, navigate]);

	// ImportService for timeline/program/project drops and File ▸ Import
	useEffect(() => {
		const service = new EngineImportService({ engine: engine.client, session });
		return registerImportService(service);
	}, [session, engine.client]);

	// Media runtime (availability, poster/sprite/peaks/proxy URLs); re-resolved when the engine reconnects.
	useEffect(() => {
		const sync = createMediaRuntimeSync(session, engine.client, engine.subscribe);
		return () => sync.dispose();
	}, [session, engine.client, engine.subscribe]);

	// Export completion toasts (jobs started from Export mode / Quick Export)
	useEffect(
		() =>
			engine.subscribe((e) => {
				if (!e || (e.type !== 'job.finished' && e.type !== 'job.updated')) return;
				const job = e.payload;
				if (!TERMINAL_JOB_STATES.has(job.state)) return;
				const fileName = takeTrackedExport(job.id);
				if (fileName === null) return;
				if (job.state === 'succeeded')
					notices.push({
						kind: 'success',
						message: `Export finished: ${fileName}`,
						action: { label: 'Download', href: engine.client.renderOutputUrl(job.id) },
						durationMs: null,
					});
				else if (job.state !== 'cancelled')
					notices.push({
						kind: 'error',
						message: `Export failed: ${fileName}`,
						detail: job.error?.message,
					});
			}),
		[engine.subscribe, engine.client],
	);

	const onDrop = (e: React.DragEvent) => {
		if (e.defaultPrevented || !e.dataTransfer.files?.length) return;
		e.preventDefault();
		if (session.getState().readOnly) {
			notices.push({ kind: 'warning', message: 'The project is read-only: nothing was imported.' });
			return;
		}
		const files = Array.from(e.dataTransfer.files);
		const service = new EngineImportService({ engine: engine.client, session });
		void service.importFiles({ files }, { kind: 'bin', binId: activeProjectBin() }).then((r) => {
			if (r.mediaIds.length)
				notices.push({ kind: 'success', message: service.describe(r, { kind: 'bin', binId: null }) });
		});
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: fallback drop zone for OS files (S05:PRJ-007)
		<div
			className="relative flex h-full min-h-0 flex-col"
			data-testid="project-lifecycle"
			onDragOver={(e) => {
				if (!e.defaultPrevented && Array.from(e.dataTransfer.types).includes('Files')) {
					e.preventDefault();
					e.dataTransfer.dropEffect = 'copy';
				}
			}}
			onDrop={onDrop}
		>
			<PersistenceBanners session={session} onReplace={props.onReplace} />
			<div className="relative min-h-0 flex-1">
				{props.children}
				{exportState.open && !exportHostedByShell ? (
					<div className="absolute inset-0" style={{ zIndex: Z.maximized }}>
						<ExportMode key={exportState.sequenceId ?? 'active'} sequenceId={exportState.sequenceId} />
					</div>
				) : null}
			</div>
			<ImportPromptHost />
			<ProjectDialogHost />
			<NoticeHost />
		</div>
	);
}

function Banner(props: {
	tone: 'info' | 'warning' | 'danger';
	children: ReactNode;
	actions?: ReactNode;
	testId: string;
}) {
	const tone =
		props.tone === 'danger'
			? 'border-l-pr-danger'
			: props.tone === 'warning'
				? 'border-l-pr-warning'
				: 'border-l-pr-accent';
	return (
		<div
			role="status"
			data-testid={props.testId}
			className={`flex min-h-[var(--pr-row-h)] shrink-0 items-center gap-3 border-b border-pr-border-subtle border-l-4 ${tone} bg-pr-raised px-3 py-1 text-pr-ui`}
		>
			<div className="min-w-0 flex-1">{props.children}</div>
			{props.actions}
		</div>
	);
}

function PersistenceBanners(props: { session: EditorSession; onReplace(s: EditorSession): void }) {
	const { session } = props;
	const state = useStoreSelector(
		session.store,
		(s) => ({ readOnly: s.readOnly, lease: s.lease, document: s.document, openIssues: s.openIssues }),
		(a, b) =>
			a.readOnly === b.readOnly &&
			a.lease === b.lease &&
			a.openIssues === b.openIssues &&
			a.document.schemaVersion === b.document.schemaVersion,
	);
	const status = usePersistenceStatus(session);
	const [busy, setBusy] = useState(false);
	const [repairedDismissed, setRepairedDismissed] = useState(false);
	const reason = readOnlyReason(state);

	const run = async (fn: () => Promise<EditorSession | undefined>) => {
		setBusy(true);
		try {
			const next = await fn();
			if (next) props.onReplace(next);
		} catch (e) {
			notices.push({
				kind: 'error',
				message:
					e instanceof LeaseHeldError
						? 'The other session still holds the project'
						: 'Could not complete the action',
				detail:
					e instanceof LeaseHeldError
						? e.expiresAt
							? `Its lease expires at ${new Date(e.expiresAt).toLocaleTimeString()} unless it stays open.`
							: undefined
						: e instanceof EngineError
							? `${e.code}: ${e.message}`
							: String(e),
			});
		} finally {
			setBusy(false);
		}
	};

	const banners: ReactNode[] = [];
	if (reason === 'lease')
		banners.push(
			<Banner
				key="lease"
				tone="warning"
				testId="banner-read-only"
				actions={
					<Button variant="primary" disabled={busy} onClick={() => void run(() => takeOverSession(session))}>
						Take over editing
					</Button>
				}
			>
				Read-only: this project is open in another session. Taking over asks that session to stop editing.
			</Banner>,
		);
	else if (reason === 'schema')
		banners.push(
			<Banner key="schema" tone="warning" testId="banner-read-only">
				Created with a newer JasperEditor — the project is open read-only and will not be changed.
			</Banner>,
		);
	else if (reason === 'requested')
		banners.push(
			<Banner key="ro" tone="info" testId="banner-read-only">
				Read-only.
			</Banner>,
		);
	if (state.lease.status === 'lost')
		banners.push(
			<Banner
				key="lost"
				tone="danger"
				testId="banner-lease-lost"
				actions={
					<Button disabled={busy} onClick={() => void run(() => reopenSession(session))}>
						Reopen
					</Button>
				}
			>
				Editing was taken over by another session. Changes made here are no longer saved.
			</Banner>,
		);
	if (status.conflict)
		banners.push(
			<Banner
				key="conflict"
				tone="danger"
				testId="banner-conflict"
				actions={
					<>
						<Button disabled={busy} onClick={() => void run(() => reopenSession(session))}>
							Reload
						</Button>
						<Button
							variant="danger"
							disabled={busy}
							onClick={() =>
								void run(async () => {
									await persistenceFor(session)?.autosaver.overwrite();
									return undefined;
								})
							}
						>
							Overwrite
						</Button>
					</>
				}
			>
				This project was saved from somewhere else (revision {status.conflict.serverRevision}). Autosave is
				paused: reload the saved version or overwrite it with yours.
			</Banner>,
		);
	const repairs = state.openIssues.filter((i) => i.code === 'W_REPAIRED');
	if (repairs.length && !repairedDismissed)
		banners.push(
			<Banner
				key="repaired"
				tone="info"
				testId="banner-repaired"
				actions={
					<Button variant="quiet" onClick={() => setRepairedDismissed(true)}>
						Dismiss
					</Button>
				}
			>
				<span title={repairs.map((r) => r.message).join('\n')}>
					This project was repaired when it was opened ({repairs.length}{' '}
					{repairs.length === 1 ? 'fix' : 'fixes'}).
				</span>
			</Banner>,
		);
	return <>{banners}</>;
}
