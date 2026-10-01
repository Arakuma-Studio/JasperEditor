// `editor.openProject` engine event (ARCHITECTURE §11): an external agent (jasper-mcp
// `open_project_in_editor`) asks this window to show a project so its edits appear live. The window
// navigates to the project (the previous one is saved on the way out, like Home ▸ open) and comes to the
// front. Mounted once inside the router, so it works on Home and in the editor.
import { toast } from '@jasper/ui';
import { useLocation, useNavigate } from 'react-router';
import { getDesktopBridge } from '../runtime/platform.ts';
import { useEngineEvents } from '../state/engine.tsx';

const projectPath = (projectId: string) => `/project/${encodeURIComponent(projectId)}`;

export function AgentOpenProject() {
	const navigate = useNavigate();
	const location = useLocation();
	useEngineEvents(
		(e) => {
			if (e.type !== 'editor.openProject') return;
			const target = projectPath(e.payload.projectId);
			const bridge = getDesktopBridge();
			if (bridge?.focusWindow) bridge.focusWindow();
			else window.focus();
			if (location.pathname === target) return;
			navigate(target);
			toast({
				kind: 'agent',
				title: 'An agent opened this project',
				detail: e.payload.agent,
				source: 'agent',
				dedupeKey: 'agent-open-project',
			});
		},
		['editor.openProject'],
	);
	return null;
}
