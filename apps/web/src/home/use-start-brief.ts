// Spec 18 AF-BRF-005: the editor half of Home ▸ Describe your video (start-brief.ts): once the project's session is
// open, the pending start (if Home left one for this project) sets the brief, imports the files and, without a
// connected agent, opens Help ▸ Connect an AI Agent….
import type { EditorSession } from '@jasper/session';
import { openDialog } from '@jasper/ui';
import { useEffect } from 'react';
import { EngineImportService } from '../import/service.ts';
import { CONNECT_AGENT_DIALOG, registerConnectAgentDialog } from '../shell/connect-agent.tsx';
import { useEngine } from '../state/engine.tsx';
import { notices } from './notices.tsx';
import { runStart, takeStart } from './start-brief.ts';

export function useStartBrief(session: EditorSession): void {
	const engine = useEngine();
	const client = engine.client;
	useEffect(() => {
		// After this commit's other effects (autosave attaches in ProjectLifecycle) and after React's development
		// double-run of effects: an edit made while persistence attaches, detaches and attaches again would be saved
		// twice from the same base revision (a false "saved from somewhere else" conflict).
		const timer = setTimeout(() => {
			const start = takeStart(session.projectId);
			if (!start) return;
			void runStart(session, start, {
				importFiles: (input) =>
					new EngineImportService({ engine: client, session }).importFiles(input, {
						kind: 'bin',
						binId: null,
					}),
				presence: () => client.agentPresence(),
				openConnectAgent: () => {
					registerConnectAgentDialog();
					void openDialog(CONNECT_AGENT_DIALOG, { engine: client });
				},
				notify: (n) => notices.push({ ...n, durationMs: n.kind === 'error' ? 10_000 : 8000 }),
			});
		}, 0);
		return () => clearTimeout(timer);
	}, [session, client]);
}
