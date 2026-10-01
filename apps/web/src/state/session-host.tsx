// Opens an EditorSession for /project/:projectId and provides it to the tree (ARCHITECTURE §7.5).
// `demo` opens an in-memory project so the shell can run without an engine.
import { mgRegistry } from '@jasper/mg-templates';
import { createEmptyProject, createRandomIdSource, defaultRegistries } from '@jasper/project';
import { EditorSession, EngineProjectStore, MemoryProjectStore, type ProjectStore } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { type ReactNode, useEffect, useState } from 'react';
import { useAgentBridge } from '../agent-bridge/index.ts';
import { useEngineClient } from './engine.tsx';

export const DEMO_PROJECT_ID = 'demo';

export type SessionHostState =
	| { status: 'opening' }
	| { status: 'open'; session: EditorSession }
	| { status: 'error'; message: string };

function demoStore(): { store: ProjectStore; projectId: string } {
	const ids = createRandomIdSource();
	const store = new MemoryProjectStore({ ids });
	const doc = createEmptyProject({ ids, name: 'Demo project', preset: 'hd-1080p-29.97' });
	store.put(doc);
	return { store, projectId: doc.projectId };
}

function useProjectSession(projectId: string): SessionHostState {
	const engine = useEngineClient();
	const [state, setState] = useState<SessionHostState>({ status: 'opening' });
	useEffect(() => {
		let session: EditorSession | null = null;
		let cancelled = false;
		setState({ status: 'opening' });
		const target =
			projectId === DEMO_PROJECT_ID ? demoStore() : { store: new EngineProjectStore(engine), projectId };
		EditorSession.open({
			store: target.store,
			projectId: target.projectId,
			engine,
			ctx: {
				ids: createRandomIdSource(),
				now: () => new Date().toISOString(),
				registries: defaultRegistries(mgRegistry),
			},
		})
			.then((s) => {
				session = s;
				if (cancelled) void s.close();
				else setState({ status: 'open', session: s });
			})
			.catch((e) => {
				if (!cancelled) setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
			});
		return () => {
			cancelled = true;
			void session?.close();
		};
	}, [engine, projectId]);
	return state;
}

export function ProjectSessionHost(props: {
	projectId: string;
	children: ReactNode;
	fallback: (state: SessionHostState) => ReactNode;
}) {
	const state = useProjectSession(props.projectId);
	useAgentBridge(state.status === 'open' ? state.session : null); // WP-2H: window.jasper + WS /agent relay
	if (state.status !== 'open') return <>{props.fallback(state)}</>;
	return <SessionProvider session={state.session}>{props.children}</SessionProvider>;
}
