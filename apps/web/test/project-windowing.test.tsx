// ui-perf: the Project panel renders every row of a small bin (as before) and only a window of a large one.
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectPanel } from '../src/panels/project/ProjectPanel.tsx';
import { VIRTUALIZE_MIN_ROWS } from '../src/panels/project/virtual.ts';
import { EngineProvider } from '../src/state/engine.tsx';
import { memorySession, ScriptedEngine } from './wp2e/helpers.ts';

afterEach(() => cleanup());

function bins(session: EditorSession, n: number) {
	const r = session.apply({
		label: 'Bins',
		origin: 'user',
		commands: Array.from({ length: n }, (_, i) => ({ type: 'bin.create', name: `Bin ${i}` })),
	});
	if (!r.ok) throw new Error(r.errors[0]!.message);
}

function mount(session: EditorSession) {
	render(
		<EngineProvider client={new ScriptedEngine().client()}>
			<MemoryRouter initialEntries={['/']}>
				<SessionProvider session={session}>
					<ProjectPanel instanceId="p" visible />
				</SessionProvider>
			</MemoryRouter>
		</EngineProvider>,
	);
}

describe('Project panel windowing (ui-perf)', () => {
	it('renders every row below the threshold', async () => {
		const { session } = await memorySession();
		bins(session, VIRTUALIZE_MIN_ROWS - 20);
		mount(session);
		expect(screen.getAllByTestId('project-row').length).toBe(
			Object.keys(session.getCommitted().items).length,
		);
	});

	it('renders a window of a large bin', async () => {
		const { session } = await memorySession();
		bins(session, 600);
		mount(session);
		const rows = screen.getAllByTestId('project-row').length;
		expect(rows).toBeGreaterThan(0);
		expect(rows).toBeLessThan(200);
		expect(screen.getByTestId('project-count').textContent).toMatch(/60\d items/);
	});
});
