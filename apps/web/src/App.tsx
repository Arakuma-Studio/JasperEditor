// Routes (ARCHITECTURE §7.5): "/" Home, "/project/:projectId" editor. React Router 7 in library mode.
import { BrowserRouter, Route, Routes, useParams } from 'react-router';
import { Home } from './home/Home.tsx';
import { EngineGate } from './runtime/bootstrap.tsx';
import { EditorShell } from './shell/EditorShell.tsx';
import { GlobalHosts } from './shell/GlobalHosts.tsx';
import { EngineProvider } from './state/engine.tsx';
import { ProjectSessionHost } from './state/session-host.tsx';

function EditorRoute() {
	const { projectId = '' } = useParams();
	return (
		<ProjectSessionHost
			projectId={projectId}
			fallback={(state) => (
				<div
					className="flex h-full items-center justify-center bg-pr-app text-pr-muted"
					data-testid="session-status"
				>
					{state.status === 'error' ? `Could not open project: ${state.message}` : 'Opening project…'}
				</div>
			)}
		>
			<EditorShell />
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
						<AppRoutes />
					</BrowserRouter>
				</EngineGate>
			</GlobalHosts>
		</EngineProvider>
	);
}
