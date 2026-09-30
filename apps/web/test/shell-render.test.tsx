import { EngineClient } from '@jasper/engine-client';
import { openDialog, toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../src/App.tsx';
import { createCommandContext, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { exportMode } from '../src/export/mode.ts';
import { MCP_ENTRY_PLACEHOLDER } from '../src/shell/connect-agent.tsx';
import { focusStore } from '../src/shell/focus.ts';
import { GlobalHosts } from '../src/shell/GlobalHosts.tsx';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { prefsStore } from '../src/shell/prefs.ts';
import { resetWorkspaceStore } from '../src/shell/workspaces/instance.ts';
import { memoryStorage } from '../src/shell/workspaces/storage.ts';
import { WORKSPACES_KEY } from '../src/shell/workspaces/store.ts';
import { EngineProvider } from '../src/state/engine.tsx';

function fakeEngine() {
	const fetchImpl = (async (url: string) =>
		url === '/health'
			? new Response(JSON.stringify({ ok: true, version: '0.1.0', apiVersion: 1 }), {
					headers: { 'x-jasper-api': '1' },
				})
			: new Response(JSON.stringify({ code: 'NOT_IMPLEMENTED', message: 'later', retryable: false }), {
					status: 501,
					headers: { 'x-jasper-api': '1' },
				})) as unknown as typeof fetch;
	return new EngineClient({ fetch: fetchImpl });
}

function mountEditor() {
	(
		window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }
	).happyDOM.setViewport({
		width: 1920,
		height: 1080,
	});
	return render(
		<EngineProvider client={fakeEngine()} connectEvents={false}>
			<GlobalHosts>
				<MemoryRouter initialEntries={['/project/demo']}>
					<AppRoutes />
				</MemoryRouter>
			</GlobalHosts>
		</EngineProvider>,
	);
}

registerAllCommands();

describe('editor shell (rendered)', () => {
	afterEach(() => cleanup());
	beforeEach(() => {
		toasts.dismissAll();
		toasts.clearLog();
		focusStore.clear();
	});

	it('AC-SH-4: a corrupt stored layout opens the default layout with exactly one warning toast', async () => {
		resetWorkspaceStore(memoryStorage({ [WORKSPACES_KEY]: '{not json' }));
		mountEditor();
		await waitFor(() => expect(screen.getByTestId('editor-shell').dataset.workspace).toBe('editing'));
		await act(async () => {});
		const warnings = toasts.getState().log.filter((e) => e.title.startsWith('Workspace layout was reset'));
		expect(warnings).toHaveLength(1);
		for (const kind of ['program', 'timeline', 'project', 'properties', 'tools', 'audioMeters', 'source'])
			expect(document.querySelector(`[data-slot="${kind}"]`), kind).toBeTruthy();
	});

	it('AC-FO-1: clicking inside a panel outlines its group only; opening a menu keeps it', async () => {
		resetWorkspaceStore(memoryStorage());
		mountEditor();
		await waitFor(() => screen.getByTestId('editor-shell'));
		const program = document.querySelector('[data-panel-body][data-panel-kind="program"]') as HTMLElement;
		fireEvent.pointerDown(program);
		expect(focusStore.getState().kind).toBe('program');
		const outlined = [...document.querySelectorAll('.dv-groupview.pr-focused')];
		expect(outlined).toHaveLength(1);
		expect(outlined[0]?.contains(document.querySelector('[data-testid="tab-program"]'))).toBe(true);
		// Menus are portaled outside panels: interacting with them does not move panel focus (FO-004).
		fireEvent.pointerDown(screen.getByTestId('workspaces-menu'));
		expect(focusStore.getState().kind).toBe('program');
	});

	it('AC-DT-1/2: theme and contrast switch via data attributes without reload', async () => {
		resetWorkspaceStore(memoryStorage());
		mountEditor();
		await waitFor(() => screen.getByTestId('editor-shell'));
		act(() => prefsStore.set({ theme: 'dark', contrast: 'high' }));
		expect(document.documentElement.getAttribute('data-pr-theme')).toBe('dark');
		expect(document.documentElement.getAttribute('data-pr-contrast')).toBe('high');
		expect(JSON.parse(localStorage.getItem('jasper:ui-prefs') ?? '{}').theme).toBe('dark');
		act(() => prefsStore.set({ theme: 'darkest', contrast: 'normal' }));
		expect(document.documentElement.getAttribute('data-pr-theme')).toBe('darkest');
	});

	it('header: mode tabs, workspace tabs and the palette button work through commands', async () => {
		resetWorkspaceStore(memoryStorage());
		mountEditor();
		await waitFor(() => screen.getByTestId('editor-shell'));
		fireEvent.click(screen.getByTestId('workspace-tab-assembly'));
		await waitFor(() => expect(screen.getByTestId('editor-shell').dataset.workspace).toBe('assembly'));
		fireEvent.click(screen.getByTestId('mode-export'));
		expect(screen.getByTestId('mode-view-export')).toBeTruthy();
		// The header tab and WP-2E's Export mode store stay in sync (one Export view, in the mode area).
		await waitFor(() => expect(exportMode.get().open).toBe(true));
		fireEvent.click(screen.getByTestId('mode-edit'));
		await waitFor(() => expect(exportMode.get().open).toBe(false));
		act(() => exportMode.open(null));
		await waitFor(() => screen.getByTestId('mode-view-export'));
		act(() => exportMode.close());
		await waitFor(() => expect(screen.queryByTestId('mode-view-export')).toBeNull());
		fireEvent.click(screen.getByTestId('palette-button'));
		await waitFor(() => screen.getByTestId('palette-input'));
		fireEvent.change(screen.getByTestId('palette-input'), { target: { value: 'make the intro punchier' } });
		// No in-app agent: free text only matches commands, panels and project items.
		expect(
			screen.queryAllByTestId('palette-row').some((r) => /Ask the agent/.test(r.textContent ?? '')),
		).toBe(false);
	});

	it('has no Agent panel, tab, menu or header button (agents connect over MCP)', async () => {
		resetWorkspaceStore(memoryStorage());
		mountEditor();
		await waitFor(() => screen.getByTestId('editor-shell'));
		expect(screen.queryByTestId('tab-agent')).toBeNull();
		expect(screen.queryByTestId('agent-button')).toBeNull();
		expect(screen.queryByTestId('workspace-tab-agent')).toBeNull();
		expect(document.querySelector('[data-menu-id="agent"]')).toBeNull();
		expect(document.querySelector('[data-panel-kind="agent"]')).toBeNull();
		expect(document.querySelector('[data-tool="agent"]')).toBeNull();
	});

	it('a destructive agent transaction shows an approval card; Deny rejects, Approve applies', async () => {
		resetWorkspaceStore(memoryStorage());
		mountEditor();
		await waitFor(() => screen.getByTestId('editor-shell'));
		await waitFor(() => expect(window.jasper).toBeTruthy());
		const api = window.jasper!;
		const tracks = async () =>
			((await api.query('sequence.summary')) as { tracks: { label: string }[] }).tracks.map((t) => t.label);
		const remove = (label: string) =>
			api.transact({
				protocol: 'jasper.tx/1',
				label: `Remove ${label}`,
				origin: { agent: 'claude-code' },
				commands: [{ type: 'track.remove', trackIds: [label] }],
			} as never);
		expect(screen.queryByTestId('agent-approval-card')).toBeNull();

		const denied = remove('A3');
		const card = await waitFor(() => screen.getByTestId('agent-approval-card'));
		expect(card.textContent).toContain('Agent request: Remove A3');
		expect(screen.getByTestId('agent-approval-summary').textContent).toBe(
			'claude-code wants to run 1 command: track.remove',
		);
		expect(card.getAttribute('role')).toBe('alertdialog');
		fireEvent.click(screen.getByTestId('agent-approval-deny'));
		expect(await denied).toMatchObject({ ok: false, errors: [{ code: 'E_APPROVAL_DENIED' }] });
		await waitFor(() => expect(screen.queryByTestId('agent-approval-card')).toBeNull());
		expect(await tracks()).toContain('A3');

		const approved = remove('A3');
		await waitFor(() => screen.getByTestId('agent-approval-card'));
		fireEvent.click(screen.getByTestId('agent-approval-approve'));
		expect(await approved).toMatchObject({ ok: true });
		await waitFor(() => expect(screen.queryByTestId('agent-approval-card')).toBeNull());
		expect(await tracks()).not.toContain('A3');
	});

	it('Help ▸ Connect an AI Agent… shows copyable MCP configuration', async () => {
		resetWorkspaceStore(memoryStorage());
		mountEditor();
		await waitFor(() => screen.getByTestId('editor-shell'));
		const help = MENUBAR.find((m) => m.id === 'help')!;
		expect(JSON.stringify(help.items)).toContain('help.connectAgent');
		expect(MENUBAR.map((m) => m.id)).not.toContain('agent');
		await act(async () => {
			await runCommand(
				'help.connectAgent',
				createCommandContext({
					engine: fakeEngine(),
					openDialog: (kind, props) => void openDialog(kind, props),
				}),
			);
		});
		const dialog = await waitFor(() => screen.getByTestId('connect-agent-dialog'));
		// The fake engine has no MCP info route: the dialog falls back to the placeholder path.
		await waitFor(() => screen.getByTestId('connect-agent-missing'));
		expect(screen.getByTestId('agent-snippet-claude-cli').textContent).toContain(
			`claude mcp add --transport stdio jasper -- node ${MCP_ENTRY_PLACEHOLDER}`,
		);
		expect(screen.getByTestId('agent-snippet-codex-toml').textContent).toContain('[mcp_servers.jasper]');
		expect(screen.getByTestId('agent-snippet-cursor-json').textContent).toContain('"mcpServers"');
		expect(dialog.textContent).not.toMatch(/token/i);
	});
});
