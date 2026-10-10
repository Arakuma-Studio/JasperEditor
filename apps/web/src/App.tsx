// Routes (ARCHITECTURE §7.5): "/" Home, "/project/:projectId" editor. React Router 7 in library mode.
import { Button } from '@jasper/ui';
import { Component, type ReactNode, useEffect } from 'react';
import { BrowserRouter, Route, Routes, useParams } from 'react-router';
import { Home } from './home/Home.tsx';
import { ProjectLifecycle } from './home/ProjectLifecycle.tsx';
import { useLanguageEpoch } from './i18n/react.ts';
import { loadable, useLoaded } from './panels/lazy.ts';
import { EngineGate } from './runtime/bootstrap.tsx';
import { AgentOpenProject } from './shell/AgentOpenProject.tsx';
import { GlobalHosts } from './shell/GlobalHosts.tsx';
import { EngineProvider } from './state/engine.tsx';
import { ProjectSessionHost } from './state/session-host.tsx';

// Start fetching the docking workspace when its route mounts, alongside the project session.
// Home keeps the editor and dockview chunks out of its initial download. polish: the shell is mounted through
// state when its chunk has loaded, not through React.lazy + <Suspense> (a Suspense retry can be starved by frequent
// updates and leave "Opening project…" on screen; panels/lazy.ts).
const editorShell = loadable(() => import('./shell/EditorShell.tsx').then((module) => module.EditorShell));

function EditorLoadError() {
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

class EditorLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		return this.state.failed ? <EditorLoadError /> : this.props.children;
	}
}

/** The editor shell once its chunk has loaded ("Opening project…" until then, the reload offer when it failed). */
function LoadedEditorShell() {
	const state = useLoaded(editorShell);
	if (state.status === 'failed') return <EditorLoadError />;
	if (state.status === 'loading') return <OpeningProject />;
	return <state.Component />;
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
	// polish: a language change remounts the editor views (the session, its undo history and selection are held
	// above, by ProjectSessionHost / ProjectLifecycle, and stay as they are).
	const epoch = useLanguageEpoch();
	useEffect(() => {
		// Start the download with the route (the session opens meanwhile); a failure is shown by LoadedEditorShell.
		void editorShell.load().catch(() => undefined);
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
				<EditorLoadBoundary key={`${projectId}:${epoch}`}>
					<LoadedEditorShell />
				</EditorLoadBoundary>
			</ProjectLifecycle>
		</ProjectSessionHost>
	);
}

export function AppRoutes() {
	const epoch = useLanguageEpoch();
	return (
		<Routes>
			<Route path="/" element={<Home key={epoch} />} />
			<Route path="/project/:projectId" element={<EditorRoute />} />
			<Route path="*" element={<Home key={epoch} />} />
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
