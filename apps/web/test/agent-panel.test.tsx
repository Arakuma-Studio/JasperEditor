// Agent panel (WP-2H): activity feed with Undo, approval cards, JSON console, schema browser, commands.
import { EngineClient } from '@jasper/engine-client';
import { createEmptyProject, createSeededIdSource, defaultRegistries } from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getAgentBridge, startAgentBridge } from '../src/agent-bridge/index.ts';
import { agentCommands } from '../src/commands/agent.ts';
import { createCommandContext } from '../src/commands/context.ts';
import { AgentPanel } from '../src/panels/agent/AgentPanel.tsx';
import { runConsoleInput } from '../src/panels/agent/console-run.ts';
import agentPanel from '../src/panels/agent/index.ts';

const stops: (() => void)[] = [];
afterEach(() => {
	cleanup();
	for (const s of stops.splice(0)) s();
});

function setup() {
	const ids = createSeededIdSource(5);
	const doc = createEmptyProject({ ids, name: 'Panel', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-09-30T00:00:00.000Z', registries: defaultRegistries() },
	});
	stops.push(startAgentBridge(session, null, { relay: false, exposeWindow: true }));
	const bridge = getAgentBridge(session)!;
	render(
		<SessionProvider session={session}>
			<AgentPanel instanceId="agent-1" visible />
		</SessionProvider>,
	);
	return { session, bridge };
}

describe('Agent panel (ARCHITECTURE §11)', () => {
	it('keeps the placeholder contract and exposes window.jasper while the bridge runs', () => {
		expect(agentPanel).toMatchObject({ kind: 'agent', instance: 'single', keymapScope: 'agent' });
		setup();
		expect(window.jasper?.version).toBe(1);
	});

	it('lists agent transactions with an Undo link on the top entry', async () => {
		const { session } = setup();
		await act(async () => {
			await window.jasper!.transact({
				label: 'Add marker',
				origin: { agent: 'bot' },
				commands: [{ type: 'marker.add', frame: 3 }],
			});
		});
		expect(screen.getByText('Add marker')).toBeTruthy();
		const undo = screen.getByTestId('agent-activity-undo');
		act(() => fireEvent.click(undo));
		expect(session.getState().history.index).toBe(0);
		await waitFor(() => expect(screen.queryByTestId('agent-activity-undo')).toBeNull());
	});

	it('shows approval cards and resolves them with Approve / Deny', async () => {
		const { session } = setup();
		let result: unknown;
		await act(async () => {
			void window
				.jasper!.transact({
					label: 'Drop V3',
					origin: { agent: 'bot' },
					commands: [{ type: 'track.remove', trackIds: ['V3'] }],
				})
				.then((r) => {
					result = r;
				});
		});
		await waitFor(() => expect(screen.getByTestId('agent-approval-card')).toBeTruthy());
		expect(screen.getByText('Drop V3')).toBeTruthy();
		await act(async () => {
			fireEvent.click(screen.getByText('Approve'));
		});
		await waitFor(() => expect(result).toMatchObject({ ok: true }));
		expect(Object.values(session.getCommitted().sequences)[0]!.videoTracks).toHaveLength(2);
	});

	it('runs the JSON console (transactions, dry runs, queries) and the agent commands', async () => {
		const { session, bridge } = setup();
		fireEvent.click(screen.getByText('Console'));
		await act(async () => {
			fireEvent.click(screen.getByText('Run'));
		});
		await waitFor(() => expect(screen.getByTestId('agent-console-result').textContent).toMatch(/Applied/));
		expect(Object.values(session.getCommitted().sequences)[0]!.markers).toHaveLength(1);

		const dry = await runConsoleInput(
			bridge,
			JSON.stringify({ commands: [{ type: 'marker.add', frame: 9 }] }),
			{ dryRun: true },
		);
		expect(dry).toMatchObject({ kind: 'transaction', ok: true });
		expect(Object.values(session.getCommitted().sequences)[0]!.markers).toHaveLength(1);
		const q = await runConsoleInput(bridge, '{"query":"doc.revision"}', { dryRun: false });
		expect(q).toMatchObject({ kind: 'query', ok: true, output: { revision: 1 } });
		expect((await runConsoleInput(bridge, '{oops', { dryRun: false })).kind).toBe('error');

		const ctx = createCommandContext({
			engine: new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch }),
			session,
		});
		const runCmd = agentCommands.find((c) => c.id === 'agent.console.run')!;
		expect(runCmd.when!(ctx)).toBe(true);
		const approveAll = agentCommands.find((c) => c.id === 'agent.approval.approveAll')!;
		expect(approveAll.when!(ctx)).toBe(false);
		expect(agentCommands.map((c) => c.id)).toEqual([
			'panel.focus.agent',
			'agent.console.run',
			'agent.approval.approveAll',
		]);
	});

	it('browses command and query schemas', () => {
		setup();
		fireEvent.click(screen.getByText('Schema'));
		fireEvent.change(screen.getByLabelText('Filter schema'), { target: { value: 'marker.add' } });
		fireEvent.click(screen.getByText('marker.add'));
		expect(screen.getByText(/"type"/)).toBeTruthy();
	});
});
