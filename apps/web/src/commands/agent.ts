// Agent UI commands (WP-2H): focus the Agent panel, run its JSON console, approve pending agent
// transactions. Ids match keymap-defaults.ts where bound (Shift+0 is bound to `panel.open.agent`, which
// the shell (WP-2A) registers; `panel.focus.agent` delegates to it when present).
import { getAgentBridge } from '../agent-bridge/index.ts';
import { agentPanelServices } from '../panels/agent/AgentPanel.tsx';
import { getCommand } from './registry.ts';
import type { CommandCtx, UiCommand } from './types.ts';

function consoleService(ctx: CommandCtx) {
	return ctx.services.get('agentConsole') ?? agentPanelServices.get('agentConsole');
}

/** DOM event the shell may listen to for opening/focusing a panel kind (until WP-2A's dock API exists). */
export const PANEL_FOCUS_EVENT = 'jasper:panel-focus';

export const agentCommands: UiCommand[] = [
	{
		id: 'panel.focus.agent',
		label: 'Agent Panel',
		description: 'Show and focus the Agent panel (activity, approvals, JSON console).',
		icon: 'panel.agent',
		scope: 'global',
		agentExposed: true,
		async run(ctx) {
			const open = getCommand('panel.open.agent');
			if (open) await open.run(ctx, { focus: true });
			else if (typeof window !== 'undefined')
				window.dispatchEvent(new CustomEvent(PANEL_FOCUS_EVENT, { detail: { kind: 'agent' } }));
			consoleService(ctx)?.focus();
		},
	},
	{
		id: 'agent.console.run',
		label: 'Run Agent Console',
		description: 'Run the JSON transaction or query in the Agent panel console.',
		scope: 'agent',
		when: (ctx) => !!ctx.session && !!consoleService(ctx),
		async run(ctx) {
			const svc = consoleService(ctx);
			if (!svc) {
				ctx.ui.toast({ kind: 'info', message: 'Open the Agent panel console first' });
				return;
			}
			await svc.run();
		},
	},
	{
		id: 'agent.approval.approveAll',
		label: 'Approve All Agent Requests',
		description: 'Approve every pending agent transaction awaiting confirmation.',
		scope: 'global',
		agentExposed: false,
		when: (ctx) => (getAgentBridge(ctx.session)?.store.getState().approvals.length ?? 0) > 0,
		run(ctx) {
			const n = getAgentBridge(ctx.session)?.approveAll() ?? 0;
			ctx.ui.toast({
				kind: 'info',
				message: n ? `Approved ${n} agent request${n === 1 ? '' : 's'}` : 'Nothing to approve',
			});
		},
	},
];
