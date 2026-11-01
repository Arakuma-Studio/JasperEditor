// Spec 18 AF-ACT-001…003 in the UI: the bridge links each activity entry to its History entry; the Agent Activity
// panel renders the log with filters, keyboard navigation and a safe Undo; the header chip shows the agents' states;
// the burst toast collapses a burst into "Agent: N edits" whose Undo takes back exactly that burst — never the user's
// own edits.
import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { ToastHost, toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceSummary } from '../src/agent-activity/presence.ts';
import { AgentStatusChipView } from '../src/agent-activity/StatusChip.tsx';
import { wireActivityToasts } from '../src/agent-activity/toasts.ts';
import { AgentBridge } from '../src/agent-bridge/bridge.ts';
import { AgentActivityView } from '../src/panels/agentActivity/AgentActivityPanel.tsx';

const bridges: AgentBridge[] = [];
beforeEach(() => toasts.dismissAll());
afterEach(() => {
	cleanup();
	for (const b of bridges.splice(0)) b.dispose();
	vi.useRealTimers();
});

function setup() {
	const ids = createCounterIdSource(11);
	const doc = createEmptyProject({ ids, name: 'Activity', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-10-31T00:00:00.000Z', registries: defaultRegistries() },
	});
	const bridge = new AgentBridge(session, null).start();
	bridges.push(bridge);
	return { session, bridge };
}

const marker = (frame: number, agent = 'bot', label = `Marker ${frame}`) => ({
	label,
	origin: { agent },
	commands: [{ type: 'marker.add', frame }],
});
const userMarker = (s: EditorSession, frame: number) =>
	s.apply({ label: 'User marker', origin: 'user', commands: [{ type: 'marker.add', frame }] as never });
const markerCount = (s: EditorSession) => {
	const seq = Object.values(s.getState().document.sequences)[0]!;
	return (seq as { markers?: unknown[] }).markers?.length ?? 0;
};

describe('activity entries name their History entry (AF-ACT-001)', () => {
	it('applied transactions carry their entry; dry runs, failures and history steps do not', async () => {
		const { session, bridge } = setup();
		await bridge.transact(marker(1), { via: 'relay' });
		await bridge.transact({ ...marker(2), dryRun: true }, { via: 'relay' });
		await bridge.transact(
			{ label: 'Bad', origin: { agent: 'bot' }, commands: [{ type: 'clip.remove', clipId: 'clp_X' }] },
			{ via: 'relay' },
		);
		await bridge.transact(
			{ label: 'Undo', origin: { agent: 'bot' }, commands: [{ type: 'history.undo' }] },
			{ via: 'relay' },
		);
		const [undo, bad, dry, applied] = bridge.store.getState().activity;
		expect(applied!.historyEntryId).toBe(session.getState().history.entries[0]!.id);
		expect(dry!.historyEntryId).toBeNull();
		expect(bad!.ok).toBe(false);
		expect(bad!.historyEntryId).toBeNull();
		expect(undo!.ok).toBe(true);
		expect(undo!.historyEntryId).toBeNull();
	});
});

const noAgents: PresenceSummary['agents'] = [];

describe('Agent Activity panel (AF-ACT-001)', () => {
	it('lists time, agent, action and outcome, newest first; filters by agent and outcome', async () => {
		const { session, bridge } = setup();
		await bridge.transact(marker(1, 'bot', 'First'), { via: 'relay' });
		await bridge.transact(marker(2, 'codex', 'Second'), { via: 'relay' });
		await bridge.transact(
			{ label: 'Broken', origin: { agent: 'bot' }, commands: [{ type: 'clip.remove', clipId: 'clp_X' }] },
			{ via: 'relay' },
		);
		render(<AgentActivityView session={session} bridge={bridge} agents={noAgents} />);
		const rows = () => screen.getAllByTestId('agent-activity-row');
		expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
			expect.stringMatching(/^Broken by bot at .+: Failed$/),
			expect.stringMatching(/^Second by codex at .+: Applied$/),
			expect.stringMatching(/^First by bot at .+: Applied$/),
		]);
		expect(within(rows()[0]!).getByTestId('agent-activity-outcome').textContent).toBe('Failed');
		// a failed transaction has nothing to undo
		expect(within(rows()[0]!).queryByTestId('agent-activity-undo')).toBeNull();

		await choose(screen.getByRole('combobox', { name: 'Agent' }), 'bot');
		expect(rows().map((r) => r.dataset.activityId)).toHaveLength(2);
		await choose(screen.getByRole('combobox', { name: 'Outcome' }), 'Applied');
		expect(rows()).toHaveLength(1);
		expect(rows()[0]!.getAttribute('aria-label')).toMatch(/^First by bot/);
		await choose(screen.getByRole('combobox', { name: 'Agent' }), 'codex');
		await choose(screen.getByRole('combobox', { name: 'Outcome' }), 'Failed');
		expect(screen.getByTestId('agent-activity-empty').textContent).toBe('No activity matches the filters.');
	});

	it('offers Undo only on the agent’s top entry; never over a newer user edit', async () => {
		const { session, bridge } = setup();
		await bridge.transact(marker(1, 'bot', 'First'), { via: 'relay' });
		await bridge.transact(marker(2, 'bot', 'Second'), { via: 'relay' });
		render(<AgentActivityView session={session} bridge={bridge} agents={noAgents} />);
		const undoOf = (i: number) =>
			within(screen.getAllByTestId('agent-activity-row')[i]!).getByTestId('agent-activity-undo');
		expect(undoOf(0).dataset.undo).toBe('ok');
		expect(undoOf(1).dataset.undo).toBe('newer-edits');
		expect(undoOf(1).getAttribute('aria-disabled')).toBe('true');

		act(() => void userMarker(session, 5));
		expect(undoOf(0).dataset.undo).toBe('newer-edits');
		fireEvent.click(undoOf(0));
		expect(markerCount(session)).toBe(3);

		act(() => void session.undo()); // the user takes back their own edit
		expect(undoOf(0).dataset.undo).toBe('ok');
		act(() => fireEvent.click(undoOf(0)));
		expect(markerCount(session)).toBe(1);
		expect(undoOf(0).dataset.undo).toBe('undone');
		expect(undoOf(1).dataset.undo).toBe('ok');
	});

	it('rows are keyboard navigable; Enter shows the details', async () => {
		const { session, bridge } = setup();
		await bridge.transact(marker(1, 'bot', 'First'), { via: 'relay' });
		await bridge.transact(marker(2, 'bot', 'Second'), { via: 'relay' });
		await bridge.transact(marker(3, 'bot', 'Third'), { via: 'relay' });
		render(<AgentActivityView session={session} bridge={bridge} agents={noAgents} />);
		const rows = screen.getAllByTestId('agent-activity-row');
		expect(rows.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
		rows[0]!.focus();
		fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(rows[1]);
		fireEvent.keyDown(rows[1]!, { key: 'End' });
		expect(document.activeElement).toBe(rows[2]);
		expect(screen.getAllByTestId('agent-activity-row').map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
		fireEvent.keyDown(rows[2]!, { key: 'Home' });
		expect(document.activeElement).toBe(rows[0]);
		fireEvent.keyDown(rows[0]!, { key: 'Enter' });
		expect(within(rows[0]!).getByTestId('agent-activity-toggle').getAttribute('aria-expanded')).toBe('true');
		expect(rows[0]!.textContent).toContain('1 created · 0 changed · 0 deleted · 1 commands');
	});

	it('shows each agent’s state above the log', () => {
		const { session, bridge } = setup();
		render(
			<AgentActivityView
				session={session}
				bridge={bridge}
				agents={[
					{
						agent: 'bot',
						phase: 'error',
						approvals: 0,
						reviews: 0,
						runningJobs: 0,
						step: 'x',
						error: 'No such clip',
					},
					{
						agent: 'codex',
						phase: 'working',
						approvals: 0,
						reviews: 0,
						runningJobs: 1,
						step: 'Transcribe 40%',
						error: null,
					},
				]}
			/>,
		);
		const list = screen.getByTestId('agent-activity-agents');
		expect(list.textContent).toContain('botErrorNo such clip');
		expect(list.textContent).toContain('codexWorkingTranscribe 40%');
		expect(screen.getByTestId('agent-activity-empty').textContent).toMatch(/^No agent activity/);
	});
});

async function choose(trigger: HTMLElement, name: string) {
	await act(async () => {
		fireEvent.keyDown(trigger, { key: 'Enter' });
	});
	const option = await screen.findByRole('option', { name });
	await act(async () => {
		fireEvent.keyDown(option, { key: 'Enter' });
	});
}

const summary = (p: Partial<PresenceSummary>): PresenceSummary => ({
	agents: [],
	phase: 'idle',
	attention: 0,
	nextChangeAt: null,
	...p,
});
const agent = (name: string, phase: PresenceSummary['phase'], extra = {}) => ({
	agent: name,
	phase,
	approvals: 0,
	reviews: 0,
	runningJobs: 0,
	step: null,
	error: null,
	...extra,
});

describe('header agent status chip (AF-ACT-002)', () => {
	it('is a button with an accessible name for every state; clicking opens the panel', () => {
		const onOpen = vi.fn();
		const { rerender } = render(
			<AgentStatusChipView summary={summary({})} relayDown={false} onOpen={onOpen} />,
		);
		const chip = () => screen.getByRole('button', { name: /Open the Agent Activity panel/ });
		expect(chip().dataset.phase).toBe('none');
		expect(chip().getAttribute('aria-label')).toBe(
			'Agents: none active in this project. Open the Agent Activity panel',
		);
		fireEvent.click(chip());
		expect(onOpen).toHaveBeenCalledTimes(1);

		rerender(
			<AgentStatusChipView
				summary={summary({ agents: [agent('bot', 'working', { step: 'Add marker' })], phase: 'working' })}
				relayDown={false}
				onOpen={onOpen}
			/>,
		);
		expect(chip().dataset.phase).toBe('working');
		expect(chip().textContent).toBe('botWorking');
		expect(screen.getByTestId('agent-status-dot').className).toContain('animate-pulse');
		expect(chip().getAttribute('aria-label')).toBe(
			'Agents: bot: Working — Add marker. Open the Agent Activity panel',
		);

		rerender(
			<AgentStatusChipView
				summary={summary({
					agents: [
						agent('bot', 'approval', { approvals: 1 }),
						agent('codex', 'review', { reviews: 2, step: 'Rough cut' }),
					],
					phase: 'approval',
					attention: 3,
				})}
				relayDown
				onOpen={onOpen}
			/>,
		);
		expect(chip().dataset.phase).toBe('approval');
		expect(chip().textContent).toContain('2 agents');
		expect(screen.getByTestId('agent-status-badge').textContent).toBe('3');
		expect(chip().getAttribute('aria-label')).toBe(
			'Agents: bot: Approval pending; codex: Waiting for your review — Rough cut. The live link to the engine is down; agent edits cannot reach this window. Open the Agent Activity panel',
		);

		rerender(
			<AgentStatusChipView
				summary={summary({ agents: [agent('bot', 'error', { error: 'No such clip' })], phase: 'error' })}
				relayDown={false}
				onOpen={onOpen}
			/>,
		);
		expect(chip().dataset.phase).toBe('error');
		expect(screen.getByTestId('agent-status-dot').className).toContain('bg-pr-danger');
		expect(chip().getAttribute('aria-label')).toContain('bot: Error — No such clip');
	});
});

describe('burst toasts (AF-ACT-003)', () => {
	const agentToasts = () => toasts.getState().toasts.filter((x) => x.dedupeKey?.startsWith('agent-burst:'));
	const resultToast = () =>
		toasts.getState().toasts.find((x) => x.dedupeKey?.startsWith('agent-burst-undo:'));
	const undoAction = () =>
		agentToasts()
			.at(-1)!
			.actions!.find((a) => a.label === 'Undo')!;

	it('collapses transactions within 2 s into "Agent: N edits"; a pause starts a new toast', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(1_000_000);
		const { session, bridge } = setup();
		const off = wireActivityToasts(bridge, session);
		await bridge.transact(marker(1), { via: 'relay' });
		expect(agentToasts().map((x) => x.title)).toEqual(['Agent: Marker 1']);
		vi.setSystemTime(1_001_500);
		await bridge.transact(marker(2), { via: 'relay' });
		vi.setSystemTime(1_003_000);
		await bridge.transact(marker(3, 'codex'), { via: 'relay' });
		expect(agentToasts().map((x) => [x.title, x.detail])).toEqual([
			['Agent: 3 edits', 'bot, codex · 3 items changed'],
		]);
		// in-page calls and dry runs stay quiet
		await bridge.transact(marker(4), { via: 'in-page' });
		await bridge.transact({ ...marker(5), dryRun: true }, { via: 'relay' });
		expect(agentToasts()).toHaveLength(1);
		vi.setSystemTime(1_005_100);
		await bridge.transact(marker(6), { via: 'relay' });
		expect(agentToasts().map((x) => x.title)).toEqual(['Agent: 3 edits', 'Agent: Marker 6']);
		off();
	});

	it('Undo takes back exactly the burst', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(2_000_000);
		const { session, bridge } = setup();
		const off = wireActivityToasts(bridge, session);
		userMarker(session, 100);
		vi.setSystemTime(2_000_100);
		await bridge.transact(marker(1), { via: 'relay' });
		await bridge.transact(marker(2), { via: 'relay' });
		await bridge.transact(marker(3), { via: 'relay' });
		expect(markerCount(session)).toBe(4);
		undoAction().run!();
		expect(markerCount(session)).toBe(1);
		expect(session.getState().history.index).toBe(1); // the user's marker stays
		expect(resultToast()!.title).toBe('Undid 3 agent edits');
		expect(resultToast()!.actions).toBeUndefined();
		off();
	});

	it('the result of Undo stays visible after the toast host closes the burst toast', async () => {
		const { session, bridge } = setup();
		const off = wireActivityToasts(bridge, session);
		await bridge.transact(marker(1), { via: 'relay' });
		await bridge.transact(marker(2), { via: 'relay' });
		render(<ToastHost />);
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
		});
		expect(markerCount(session)).toBe(0);
		expect(screen.queryByText('Agent: 2 edits')).toBeNull();
		expect(screen.getAllByText('Undid 2 agent edits').length).toBeGreaterThan(0);
		expect(resultToast()!.title).toBe('Undid 2 agent edits');
		off();
	});

	it('a user edit inside the window splits the burst; Undo after a later user edit is refused', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(3_000_000);
		const { session, bridge } = setup();
		const off = wireActivityToasts(bridge, session);
		await bridge.transact(marker(1), { via: 'relay' });
		userMarker(session, 50);
		await bridge.transact(marker(2), { via: 'relay' });
		expect(agentToasts().map((x) => x.title)).toEqual(['Agent: Marker 1', 'Agent: Marker 2']);

		userMarker(session, 60);
		undoAction().run!();
		expect(markerCount(session)).toBe(4);
		const refused = resultToast()!;
		expect(refused.kind).toBe('warning');
		expect(refused.title).toBe('The agent’s edits were not undone');
		expect(refused.detail).toBe('Newer edits came after it; use the History panel');
		off();
	});
});
