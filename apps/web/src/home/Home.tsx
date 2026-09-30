// Home screen (S05:HD-020, R-PUI §6): left rail (New Project, Open Project…, Refresh), recent projects
// from the engine (poster, name, modified time), open / duplicate / export / delete, New Project dialog
// (name + preset from @jasper/project presets) and a three-step empty state.
import type { ProjectSummary } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import { BUILTIN_PRESETS } from '@jasper/project';
import { EngineProjectStore } from '@jasper/session';
import { Button, cx, Icon, IconButton } from '@jasper/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { HOME_NEW_PROJECT_FLAG } from '../commands/integration.ts';
import { Dialog } from '../import/ImportPromptHost.tsx';
import { useEngine } from '../state/engine.tsx';
import { DEMO_PROJECT_ID } from '../state/session-host.tsx';
import { NoticeHost, notices } from './notices.tsx';

type ListState =
	| { status: 'loading' }
	| { status: 'ok'; projects: ProjectSummary[] }
	| { status: 'error'; code: string; message: string };

/** M1 default preset (ARCHITECTURE §15: "New Project (1080p 29.97 preset)"). */
export const HOME_DEFAULT_PRESET = 'hd-1080p-29.97';

function errorOf(e: unknown): { code: string; message: string } {
	return {
		code: e instanceof EngineError ? e.code : 'NETWORK',
		message: e instanceof Error ? e.message : String(e),
	};
}

function relativeTime(iso: string, now = Date.now()): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return '';
	const s = Math.round((now - t) / 1000);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
	return new Date(t).toLocaleDateString();
}

function pickProjectFile(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.jasper,application/json';
		input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
		input.addEventListener('cancel', () => resolve(null), { once: true });
		input.click();
	});
}

export function Home() {
	const engine = useEngine();
	const navigate = useNavigate();
	const store = useMemo(() => new EngineProjectStore(engine.client), [engine.client]);
	const [list, setList] = useState<ListState>({ status: 'loading' });
	const [dialog, setDialog] = useState<null | { kind: 'new' } | { kind: 'delete'; project: ProjectSummary }>(
		null,
	);
	const [busy, setBusy] = useState(false);

	const load = useCallback(() => {
		setList({ status: 'loading' });
		store
			.list()
			.then((projects) => setList({ status: 'ok', projects }))
			.catch((e) => setList({ status: 'error', ...errorOf(e) }));
	}, [store]);
	useEffect(() => {
		if (engine.status !== 'connecting') load();
	}, [engine.status, load]);
	// File ▸ New ▸ Project… in the editor comes back here with the New Project dialog open.
	useEffect(() => {
		try {
			if (window.sessionStorage.getItem(HOME_NEW_PROJECT_FLAG) !== '1') return;
			window.sessionStorage.removeItem(HOME_NEW_PROJECT_FLAG);
			setDialog({ kind: 'new' });
		} catch {
			// storage unavailable
		}
	}, []);

	const run = async (what: string, fn: () => Promise<void>) => {
		setBusy(true);
		try {
			await fn();
		} catch (e) {
			const { code, message } = errorOf(e);
			notices.push({ kind: 'error', message: `${what} failed`, detail: `${code}: ${message}` });
		} finally {
			setBusy(false);
		}
	};

	const create = (name: string, preset: string) =>
		run('Creating the project', async () => {
			const id = await store.create({ name: name.trim() || 'Untitled Project', preset });
			setDialog(null);
			navigate(`/project/${id}`);
		});
	const openFile = () =>
		run('Opening the project file', async () => {
			const file = await pickProjectFile();
			if (!file) return;
			const id = await store.importFile(file);
			navigate(`/project/${id}`);
		});
	const duplicate = (p: ProjectSummary) =>
		run('Duplicating', async () => {
			await store.duplicate(p.projectId, `${p.name} copy`);
			load();
		});
	const exportFile = (p: ProjectSummary) =>
		run('Exporting the project', async () => {
			const blob = await store.exportFile(p.projectId);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${p.name}.jasper`;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		});
	const remove = (p: ProjectSummary) =>
		run('Deleting', async () => {
			await store.delete(p.projectId);
			setDialog(null);
			load();
		});

	const connected = engine.status === 'connected';
	return (
		<div className="flex h-full bg-pr-app text-pr-text" data-testid="home">
			{/* Left rail */}
			<aside className="flex w-56 shrink-0 flex-col gap-2 border-r border-pr-border-subtle bg-pr-panel-alt p-4">
				<div className="mb-4 flex items-center gap-2">
					<span className="text-pr-accent">
						<Icon id="panel.program" size={20} />
					</span>
					<span className="text-pr-strong">JasperEditor</span>
				</div>
				<Button
					variant="primary"
					pill
					disabled={!connected || busy}
					onClick={() => setDialog({ kind: 'new' })}
					data-testid="home-new"
				>
					New Project
				</Button>
				<Button disabled={!connected || busy} onClick={() => void openFile()}>
					Open Project…
				</Button>
				<Button variant="quiet" onClick={load}>
					Refresh
				</Button>
				<Button variant="quiet" onClick={() => navigate(`/project/${DEMO_PROJECT_ID}`)}>
					Open demo project
				</Button>
				<p className="mt-auto text-pr-small text-pr-muted" data-testid="engine-status">
					Engine: {engine.status}
					{engine.version ? ` (v${engine.version})` : ''}
					{engine.status === 'disconnected' ? ' — start it with `pnpm dev:engine`' : ''}
				</p>
			</aside>

			{/* Recent projects */}
			<main className="min-w-0 flex-1 overflow-auto bg-pr-panel p-6">
				<h1 className="mb-4 text-[length:var(--pr-font-size-dialog-title)] font-semibold text-pr-strong">
					Recent projects
				</h1>
				{list.status === 'loading' ? <p className="text-pr-muted">Loading projects…</p> : null}
				{list.status === 'error' ? (
					<p className="text-pr-small text-pr-warning" data-testid="projects-error">
						Projects unavailable ({list.code}).{' '}
						{list.code === 'NOT_IMPLEMENTED'
							? 'The engine project store is not available yet.'
							: list.message}
					</p>
				) : null}
				{list.status === 'ok' && list.projects.length === 0 ? (
					<EmptyState onCreate={() => setDialog({ kind: 'new' })} disabled={!connected} />
				) : null}
				{list.status === 'ok' && list.projects.length > 0 ? (
					<ul
						className="grid gap-4"
						style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
						data-testid="project-list"
					>
						{list.projects.map((p) => (
							<li key={p.projectId} className="group flex flex-col gap-1" data-testid="project-card">
								<button
									type="button"
									className="relative aspect-video overflow-hidden rounded-pr-frame bg-pr-raised text-left hover:outline hover:outline-1 hover:outline-pr-accent"
									onClick={() => navigate(`/project/${p.projectId}`)}
									aria-label={`Open ${p.name}`}
								>
									{p.thumbnail ? (
										<img src={p.thumbnail} alt="" className="size-full object-cover" />
									) : (
										<span className="flex size-full items-center justify-center text-pr-icon">
											<Icon id="panel.timeline" size={32} />
										</span>
									)}
								</button>
								<div className="flex items-start gap-1">
									<div className="min-w-0 flex-1">
										<p className="truncate text-pr-ui text-pr-strong" title={p.name}>
											{p.name}
										</p>
										<p
											className="text-pr-small text-pr-muted"
											title={new Date(p.modifiedAt).toLocaleString()}
										>
											{relativeTime(p.modifiedAt)} · rev {p.revision}
										</p>
									</div>
									<span className={cx('flex opacity-0 group-hover:opacity-100 focus-within:opacity-100')}>
										<IconButton
											icon="app.add"
											label="Duplicate"
											disabled={busy}
											onClick={() => void duplicate(p)}
										/>
										<IconButton
											icon="app.export"
											label="Export project file"
											disabled={busy}
											onClick={() => void exportFile(p)}
										/>
										<IconButton
											icon="app.close"
											label="Delete"
											disabled={busy}
											data-testid="project-delete"
											onClick={() => setDialog({ kind: 'delete', project: p })}
										/>
									</span>
								</div>
							</li>
						))}
					</ul>
				) : null}
			</main>

			{dialog?.kind === 'new' ? (
				<NewProjectDialog
					busy={busy}
					onCancel={() => setDialog(null)}
					onCreate={(n, preset) => void create(n, preset)}
				/>
			) : null}
			{dialog?.kind === 'delete' ? (
				<Dialog
					title="Delete project?"
					testId="dialog-delete-project"
					onEscape={() => setDialog(null)}
					footer={
						<>
							<Button onClick={() => setDialog(null)}>Cancel</Button>
							<Button
								variant="danger"
								data-autofocus
								data-testid="confirm-delete-project"
								onClick={() => void remove(dialog.project)}
							>
								Delete
							</Button>
						</>
					}
				>
					<p>
						“{dialog.project.name}” and its autosave versions are deleted from the engine. Imported media
						files are not deleted.
					</p>
				</Dialog>
			) : null}
			<NoticeHost />
		</div>
	);
}

function EmptyState(props: { onCreate(): void; disabled: boolean }) {
	const steps = [
		{ n: 1, title: 'Create', text: 'Start a project with a sequence preset.' },
		{ n: 2, title: 'Import', text: 'Drop clips, audio and stills into the Project panel.' },
		{ n: 3, title: 'Edit', text: 'Cut on the timeline, add titles and export.' },
	];
	return (
		<div className="flex flex-col items-start gap-4" data-testid="home-empty">
			<ol className="grid w-full max-w-3xl grid-cols-3 gap-4">
				{steps.map((s) => (
					<li key={s.n} className="rounded-pr-frame bg-pr-raised p-4">
						<p className="text-pr-accent">{s.n}</p>
						<p className="text-pr-strong">{s.title}</p>
						<p className="text-pr-small text-pr-muted">{s.text}</p>
					</li>
				))}
			</ol>
			<Button variant="primary" pill disabled={props.disabled} onClick={props.onCreate}>
				Create your first project
			</Button>
		</div>
	);
}

export function NewProjectDialog(props: {
	busy?: boolean;
	onCancel(): void;
	onCreate(name: string, preset: string): void;
}) {
	const [name, setName] = useState('Untitled Project');
	const [preset, setPreset] = useState(HOME_DEFAULT_PRESET);
	return (
		<Dialog
			title="New Project"
			testId="dialog-new-project"
			onEscape={props.onCancel}
			footer={
				<>
					<Button onClick={props.onCancel}>Cancel</Button>
					<Button
						variant="primary"
						data-testid="new-project-create"
						disabled={props.busy}
						onClick={() => props.onCreate(name, preset)}
					>
						Create
					</Button>
				</>
			}
		>
			<form
				className="flex flex-col gap-3"
				onSubmit={(e) => {
					e.preventDefault();
					props.onCreate(name, preset);
				}}
			>
				<label className="flex flex-col gap-1">
					<span className="text-pr-small text-pr-muted">Name</span>
					<input
						data-autofocus
						data-testid="new-project-name"
						className="h-[var(--pr-control-h)] rounded-pr-control bg-pr-field px-2 text-pr-text"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-pr-small text-pr-muted">Sequence preset</span>
					<select
						data-testid="new-project-preset"
						className="h-[var(--pr-control-h)] rounded-pr-control bg-pr-field px-2 text-pr-text"
						value={preset}
						onChange={(e) => setPreset(e.target.value)}
					>
						{BUILTIN_PRESETS.map((p) => (
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
