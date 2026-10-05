import { EngineClient } from '@jasper/engine-client';
import { toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/App.tsx';
import { registerAllCommands } from '../src/commands/index.ts';
import { exportMode } from '../src/export/mode.ts';
import { focusStore } from '../src/shell/focus.ts';
import { GlobalHosts } from '../src/shell/GlobalHosts.tsx';
import { prefsStore } from '../src/shell/prefs.ts';
import { WORKSPACES_KEY, WorkspaceStore } from '../src/shell/workspaces/store.ts';
import { EngineProvider } from '../src/state/engine.tsx';
import { memoryStorage } from './shell-storage.ts';

let workspace: WorkspaceStore;
vi.mock('../src/shell/workspaces/instance.ts', () => ({ getWorkspaceStore: () => workspace }));

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
		<EngineProvider client={fakeEngine()}>
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
		workspace = new WorkspaceStore(memoryStorage({ [WORKSPACES_KEY]: '{not json' }));
		mountEditor();
		await waitFor(() => expect(screen.getByTestId('editor-shell').dataset.workspace).toBe('editing'));
		await act(async () => {});
		const warnings = toasts.getState().log.filter((e) => e.title.startsWith('Workspace layout was reset'));
		expect(warnings).toHaveLength(1);
	});

	it('AC-DT-1/2: theme and contrast switch via data attributes without reload', async () => {
		workspace = new WorkspaceStore(memoryStorage());
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
		workspace = new WorkspaceStore(memoryStorage());
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
	});
});
