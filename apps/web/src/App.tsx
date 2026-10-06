// Routes (ARCHITECTURE §7.5): "/" Home, "/project/:projectId" editor. React Router 7 in library mode.
import { Button } from '@jasper/ui';
import { Component, lazy, type ReactNode, Suspense, useEffect } from 'react';
import { BrowserRouter, Route, Routes, useParams } from 'react-router';
import { Home } from './home/Home.tsx';
import { ProjectLifecycle } from './home/ProjectLifecycle.tsx';
import { EngineGate } from './runtime/bootstrap.tsx';
import { AgentOpenProject } from './shell/AgentOpenProject.tsx';
import { GlobalHosts } from './shell/GlobalHosts.tsx';
import { EngineProvider } from './state/engine.tsx';
import { ProjectSessionHost } from './state/session-host.tsx';

// Start fetching the docking workspace when its route mounts, alongside the project session.
// Home keeps the editor and dockview chunks out of its initial download.
const loadEditorShell = () =>
	import('./shell/EditorShell.tsx').then((module) => ({ default: module.EditorShell }));
const EditorShell = lazy(loadEditorShell);

class EditorLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		if (!this.state.failed) return this.props.children;
		return (
			<div
				role="alert"
				className="flex h-full flex-col items-center justify-center gap-3 bg-pr-app text-pr-muted"
				data-testid="editor-load-error"
			>
				<p>Could not load the editor. Check your connection and reload.</p>
				<Button onClick={() => window.location.reload()}>Reload editor</Button>
			</div>
		);
	}
}

function OpeningProject() {
	return (
		<div
			className="flex h-full items-center justify-center bg-pr-app text-pr-muted"
			data-testid="session-status"
		>
			Opening project…
		</div>
	);
}

function EditorRoute() {
	const { projectId = '' } = useParams();
	useEffect(() => {
		// React.lazy reports a rejected import when rendered; avoid an unhandled preload rejection.
		void loadEditorShell().catch(() => undefined);
	}, []);
	return (
		<ProjectSessionHost
			projectId={projectId}
			fallback={(state) =>
				state.status === 'error' ? (
					<div
						className="flex h-full items-center justify-center bg-pr-app text-pr-muted"
						data-testid="session-status"
					>
						Could not open project: {state.message}
					</div>
				) : (
					<OpeningProject />
				)
			}
		>
			<ProjectLifecycle>
				<EditorLoadBoundary key={projectId}>
					<Suspense fallback={<OpeningProject />}>
						<EditorShell />
					</Suspense>
				</EditorLoadBoundary>
			</ProjectLifecycle>
		</ProjectSessionHost>
	);
}

export function AppRoutes() {
	return (
		<Routes>
			<Route path="/" element={<Home />} />
			<Route path="/project/:projectId" element={<EditorRoute />} />
			<Route path="*" element={<Home />} />
		</Routes>
	);
}

export function App() {
	return (
		<EngineProvider>
			<GlobalHosts>
				<EngineGate>
					<BrowserRouter>
						<AgentOpenProject />
						<AppRoutes />
					</BrowserRouter>
				</EngineGate>
			</GlobalHosts>
		</EngineProvider>
	);
}
