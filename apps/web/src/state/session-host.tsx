// Opens an EditorSession for /project/:projectId and provides it to the tree (ARCHITECTURE §7.5).
// `demo` opens an in-memory project so the shell can run without an engine.
import { mgRegistry } from '@jasper/mg-templates';
import { createEmptyProject, createRandomIdSource, defaultRegistries } from '@jasper/project';
import { EditorSession, EngineProjectStore, MemoryProjectStore, type ProjectStore } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { type ReactNode, useEffect, useState } from 'react';
import { connectFonts } from '../fonts/store.ts';
import { editorTextMeasurer, followFontCatalog } from '../fonts/text-measure.ts';
import { useEngineClient } from './engine.tsx';

export const DEMO_PROJECT_ID = 'demo';

export type SessionHostState =
	| { status: 'opening' }
	| { status: 'open'; session: EditorSession }
	| { status: 'error'; message: string };

function demoStore(): { store: ProjectStore; projectId: string } {
	const ids = createRandomIdSource();
	const store = new MemoryProjectStore({ ids, mgTemplates: mgRegistry });
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
		let unfollow: (() => void) | null = null;
		setState({ status: 'opening' });
		const demo = projectId === DEMO_PROJECT_ID;
		const target = demo
			? demoStore()
			: { store: new EngineProjectStore(engine, { mgTemplates: mgRegistry }), projectId };
		// spec 13 SH-004: text boxes follow the glyph metrics of the faces the Program monitor draws.
		if (!demo) connectFonts(engine);
		const textMeasurer = editorTextMeasurer(!demo);
		EditorSession.open({
			store: target.store,
			projectId: target.projectId,
			engine,
			ctx: {
				ids: createRandomIdSource(),
				now: () => new Date().toISOString(),
				registries: defaultRegistries(mgRegistry),
				textMeasurer,
			},
		})
			.then((s) => {
				session = s;
				if (cancelled) void s.close();
				else {
					unfollow = followFontCatalog(s, textMeasurer);
					setState({ status: 'open', session: s });
				}
			})
			.catch((e) => {
				if (!cancelled) setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
			});
		return () => {
			cancelled = true;
			unfollow?.();
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
	if (state.status !== 'open') return <>{props.fallback(state)}</>;
	return <SessionProvider session={state.session}>{props.children}</SessionProvider>;
}
