import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

// Agent Activity (spec 18 AF-ACT-001): what agents did in this window — the agents' states and the bridge's activity
// log with filters and Undo of an agent's top History entry. Opened from Window ▸ Agent Activity and the header's
// agent status chip; not part of a factory workspace (it docks with History or Jobs, else floats).
const agentActivity: PanelDefinition = {
	kind: 'agentActivity',
	title: () => 'Agent Activity',
	icon: 'agent.sparkle',
	instance: 'single',
	minSize: { w: 280, h: 160 },
	keymapScope: 'agentActivity',
	touch: 'sheet',
	dockWith: ['history', 'jobs'],
	agentDescription:
		'Agent Activity: the agents active in this project with their state (idle, working, waiting for review, approval pending, error) and the log of agent transactions in this window, newest first — time, agent, action, outcome (applied, failed, denied, dry run), filterable by agent and outcome; Undo on a row takes back that transaction only while it is the agent’s entry at the top of the undo stack. ↑/↓ move between rows, Enter shows details.',
	component: lazyPanel(() => import('./AgentActivityPanel.tsx'), 'AgentActivityPanel'),
};
export default agentActivity;
