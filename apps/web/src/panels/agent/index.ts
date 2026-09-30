// Agent panel (WP-2H, ARCHITECTURE §11 Stage 1, S05 §17): activity feed, approvals, JSON console, schema.

import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const agentPanel: PanelDefinition = {
	kind: 'agent',
	title: () => 'Agent',
	icon: 'panel.agent',
	instance: 'single',
	minSize: { w: 260, h: 200 },
	keymapScope: 'agent',
	touch: 'tab',
	menu: [
		{ type: 'command', command: 'agent.console.run', label: 'Run Console' },
		{ type: 'command', command: 'agent.approval.approveAll', label: 'Approve All Pending' },
	],
	agentDescription: 'Agent activity, approvals and the JSON transaction console.',
	component: lazyPanel(() => import('./AgentPanel.tsx'), 'AgentPanel'),
};

export default agentPanel;
