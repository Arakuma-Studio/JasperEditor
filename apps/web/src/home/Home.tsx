// Home placeholder (WP-00): lists projects from the engine. WP-2E replaces it with the real Home screen.
import type { ProjectSummary } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import { Button, PanelFrame } from '@jasper/ui';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useEngine } from '../state/engine.tsx';
import { DEMO_PROJECT_ID } from '../state/session-host.tsx';

type ListState =
	| { status: 'loading' }
	| { status: 'ok'; projects: ProjectSummary[] }
	| { status: 'error'; code: string; message: string };

export function Home() {
	const engine = useEngine();
	const navigate = useNavigate();
	const [list, setList] = useState<ListState>({ status: 'loading' });
	const [creating, setCreating] = useState<string | null>(null);

	const load = useCallback(() => {
		setList({ status: 'loading' });
		engine.client
			.listProjects()
			.then((r) => setList({ status: 'ok', projects: r.projects }))
			.catch((e) =>
				setList({
					status: 'error',
					code: e instanceof EngineError ? e.code : 'NETWORK',
					message: e instanceof Error ? e.message : String(e),
				}),
			);
	}, [engine.client]);
	useEffect(() => {
		if (engine.status !== 'connecting') load();
	}, [engine.status, load]);

	const create = async () => {
		setCreating(null);
		try {
			const { projectId } = await engine.client.createProject({
				name: 'Untitled Project',
				preset: 'hd-1080p-29.97',
			});
			navigate(`/project/${projectId}`);
		} catch (e) {
			setCreating(e instanceof EngineError ? `${e.code}: ${e.message}` : String(e));
		}
	};

	return (
		<div className="flex h-full items-start justify-center bg-pr-app p-6 text-pr-text" data-testid="home">
			<PanelFrame title="JasperEditor — Projects" className="w-full max-w-3xl" style={{ minHeight: 320 }}>
				<div className="flex flex-col gap-4 p-4">
					<p className="text-pr-small text-pr-muted" data-testid="engine-status">
						Engine: {engine.status}
						{engine.version ? ` (v${engine.version})` : ''}
						{engine.status === 'disconnected' ? ' — start it with `pnpm dev:engine`' : ''}
					</p>
					<div className="flex gap-2">
						<Button variant="primary" onClick={create} disabled={engine.status !== 'connected'}>
							New Project
						</Button>
						<Button onClick={() => navigate(`/project/${DEMO_PROJECT_ID}`)}>Open demo project</Button>
						<Button variant="quiet" onClick={load}>
							Refresh
						</Button>
					</div>
					{creating ? <p className="text-pr-small text-pr-warning">{creating}</p> : null}
					{list.status === 'loading' ? <p className="text-pr-muted">Loading projects…</p> : null}
					{list.status === 'error' ? (
						<p className="text-pr-small text-pr-warning" data-testid="projects-error">
							Projects unavailable ({list.code}).{' '}
							{list.code === 'NOT_IMPLEMENTED'
								? 'The engine project store arrives with WP-2F.'
								: list.message}
						</p>
					) : null}
					{list.status === 'ok' ? (
						list.projects.length === 0 ? (
							<p className="text-pr-muted">No projects yet.</p>
						) : (
							<ul className="flex flex-col divide-y divide-pr-border-subtle" data-testid="project-list">
								{list.projects.map((p) => (
									<li
										key={p.projectId}
										className="flex h-[var(--pr-row-h)] items-center gap-3 px-2 hover:bg-pr-hover"
									>
										<Link to={`/project/${p.projectId}`} className="text-pr-strong">
											{p.name}
										</Link>
										<span className="ml-auto text-pr-small text-pr-muted">
											{new Date(p.modifiedAt).toLocaleString()}
										</span>
									</li>
								))}
							</ul>
						)
					) : null}
				</div>
			</PanelFrame>
		</div>
	);
}
