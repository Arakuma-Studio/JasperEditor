import { CONNECT_AGENT_DIALOG, registerConnectAgentDialog } from '../shell/connect-agent.tsx';
import type { UiCommand } from './types.ts';

export const helpCommands: UiCommand[] = [
	{
		id: 'help.connectAgent',
		label: 'Connect an AI Agent…',
		description: 'Show how to connect Claude Code, Codex CLI or Cursor to JasperEditor over MCP.',
		icon: 'agent.sparkle',
		scope: 'global',
		run: (ctx) => {
			registerConnectAgentDialog();
			ctx.ui.openDialog(CONNECT_AGENT_DIALOG, { engine: ctx.engine });
		},
	},
];
