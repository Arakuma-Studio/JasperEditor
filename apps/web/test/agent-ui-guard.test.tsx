// Security review AGT-1: an agent's live-UI automation cannot do what the approval gate refuses through
// apply_commands — destructive transactions, irreversible commands — and cannot approve its own requests.
import { AGENT_INPUT_HEADER } from '@jasper/api';
import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	AGENT_INPUT_GRACE_MS,
	agentInputActive,
	agentUiTxGuard,
	resetAgentInputForTests,
	runAgentInput,
} from '../src/agent-bridge/agent-input.ts';
import type { AgentBridge, PendingApproval } from '../src/agent-bridge/bridge.ts';
import { registerCommands, runCommand } from '../src/commands/registry.ts';
import type { CommandCtx } from '../src/commands/types.ts';
import { ApprovalCard } from '../src/shell/AgentApprovals.tsx';
import { createEditorEngineClient } from '../src/state/engine.tsx';

afterEach(() => {
	cleanup();
	resetAgentInputForTests();
	vi.useRealTimers();
});

function session() {
	const ids = createCounterIdSource(11);
	const doc = createEmptyProject({ ids, name: 'Guard', preset: 'hd-1080p-30' });
	const s = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-10-09T00:00:00.000Z', registries: defaultRegistries() },
	});
	s.addTxGuard(agentUiTxGuard);
	return s;
}

const deleteSequence = (s: EditorSession) => {
	const seqId = Object.keys(s.getState().document.sequences)[0]!;
	return {
		label: 'Delete',
		origin: 'user' as const,
		commands: [{ type: 'sequence.delete', sequenceId: seqId, force: true }] as never,
	};
};

describe('requests the editor makes while it handles agent input (security review AGT-3)', () => {
	it('are marked as the agent’s; the editor’s own housekeeping never is', async () => {
		const seen: { url: string; marked: boolean }[] = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			seen.push({ url: String(url), marked: headers[AGENT_INPUT_HEADER] === '1' });
			return new Response(JSON.stringify({ ok: true, revision: 1, removedPresets: [], removedFolders: [] }), {
				headers: { 'x-jasper-api': '1', 'content-type': 'application/json' },
			});
		}) as unknown as typeof fetch;
		vi.stubGlobal('fetch', fetchImpl);
		const client = createEditorEngineClient();
		const del = () => client.call('effectPresetDelete', { params: { presetId: 'fxp_1' } });
		const last = () => seen.at(-1)!;
		// The stand-in engine answers every route with the same body: what a route makes of it is not the point here.
		const sent = (p: Promise<unknown>) => p.catch(() => undefined);

		// The user's own click: an ordinary request.
		await del();
		expect(last()).toMatchObject({ marked: false });

		// A `ui_click` on Delete: the request says it comes from agent input, during the action and in its aftermath.
		await runAgentInput(del);
		expect(last()).toMatchObject({ url: '/api/effect-presets/fxp_1', marked: true });
		await del();
		expect(last().marked).toBe(true);

		// Autosave, the recovery journal and lease upkeep are the editor's own work, whatever input is in flight.
		await runAgentInput(async () => {
			await sent(client.putProject('prj_1', { revision: 2 }, 1));
			expect(last()).toMatchObject({ url: '/api/projects/prj_1', marked: false });
			await sent(client.putRecovery('prj_1', 'ses_1', {} as never));
			expect(last().marked).toBe(false);
			await sent(client.heartbeatLease('prj_1', 'lease_1'));
			expect(last().marked).toBe(false);
			// Its own journal (it holds the lease) is housekeeping; another session's unsaved changes are a decision.
			await sent(client.deleteRecovery('prj_1', 'ses_1', 'lease_1'));
			expect(last().marked).toBe(false);
			await sent(client.deleteRecovery('prj_1', 'ses_dead'));
			expect(last().marked).toBe(true);
			await sent(client.deleteProject('prj_1'));
			expect(last().marked).toBe(true);
		});

		// After the grace period (or a real key press) requests are the user's again.
		resetAgentInputForTests();
		await del();
		expect(last().marked).toBe(false);
		vi.unstubAllGlobals();
	});
});

describe('session guard', () => {
	it('refuses destructive user-origin transactions while agent input is handled', async () => {
		const s = session();
		const r = await runAgentInput(async () => s.apply(deleteSequence(s)));
		expect(r).toMatchObject({ ok: false, errors: [{ code: 'E_APPROVAL_DENIED' }] });
		expect(Object.keys(s.getState().document.sequences)).toHaveLength(1);
		// Non-destructive edits by agent UI input are fine.
		const m = await runAgentInput(async () =>
			s.apply({ label: 'Marker', origin: 'user', commands: [{ type: 'marker.add', frame: 1 }] }),
		);
		expect(m.ok).toBe(true);
	});

	it('covers asynchronous aftermath, ends after the grace period or a real user input', async () => {
		const s = session();
		await runAgentInput(async () => undefined);
		expect(agentInputActive()).toBe(true);
		expect(s.apply(deleteSequence(s)).ok).toBe(false);
		expect(agentInputActive(performance.now() + AGENT_INPUT_GRACE_MS + 1)).toBe(false);
		// A trusted user key press ends it at once (jsdom events are untrusted: simulate the flag).
		const e = new KeyboardEvent('keydown', { key: 'Delete' });
		Object.defineProperty(e, 'isTrusted', { value: true });
		window.dispatchEvent(e);
		expect(agentInputActive()).toBe(false);
		expect(s.apply(deleteSequence(s)).ok).toBe(true);
	});
});

describe('irreversible UI commands', () => {
	it('history.clear {confirmed: true} is refused for agent input and runs for the user', async () => {
		const run = vi.fn();
		const off = registerCommands([
			{ id: 'history.clear', label: 'Clear History…', scope: 'global', run },
		] as never);
		const toast = vi.fn();
		const ctx = { ui: { toast } } as unknown as CommandCtx;
		try {
			const r = await runAgentInput(() => runCommand('history.clear', ctx, { confirmed: true }));
			expect(r).toMatchObject({ ran: false, reason: 'error' });
			expect(run).not.toHaveBeenCalled();
			resetAgentInputForTests();
			expect(await runCommand('history.clear', ctx, { confirmed: true })).toEqual({ ran: true });
			expect(run).toHaveBeenCalledOnce();
		} finally {
			off();
		}
	});
});

describe('approval card', () => {
	const approval: PendingApproval = {
		approvalId: 'apr_1',
		projectId: 'prj_1',
		label: 'Delete sequence',
		agent: 'bot',
		reasons: ['sequence.delete (command 1)'],
		commandCount: 1,
		summary: 'sequence.delete',
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		source: 'engine',
	} as PendingApproval;

	it('synthetic (agent) clicks cannot approve; they may deny', () => {
		const resolveApproval = vi.fn(() => true);
		render(<ApprovalCard approval={approval} bridge={{ resolveApproval } as unknown as AgentBridge} />);
		fireEvent.click(screen.getByTestId('agent-approval-approve'));
		expect(resolveApproval).not.toHaveBeenCalled();
		fireEvent.click(screen.getByTestId('agent-approval-deny'));
		expect(resolveApproval).toHaveBeenCalledWith('apr_1', 'denied');
	});
});
