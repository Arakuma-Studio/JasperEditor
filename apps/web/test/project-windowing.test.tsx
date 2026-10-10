// ui-perf: the Project panel renders every row of a small bin (as before) and only a window of a large one.
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectPanel } from '../src/panels/project/ProjectPanel.tsx';
import { INITIAL_ROWS, useRowWindow, VIRTUALIZE_MIN_ROWS } from '../src/panels/project/virtual.ts';
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

	it('a large bin is windowed from its first render (no render of every row first)', () => {
		const seen: { on: boolean; rows: number }[] = [];
		function Probe({ rows, enabled }: { rows: number; enabled: boolean }) {
			const scroll = useRef<HTMLDivElement>(null);
			const list = useRef<HTMLDivElement>(null);
			const win = useRowWindow({ scroll, list, rows, enabled, measure: () => null });
			seen.push({ on: win.on, rows: win.end - win.start });
			return (
				<div ref={scroll}>
					<div ref={list} />
				</div>
			);
		}
		const view = render(<Probe rows={5000} enabled />);
		// Every render, the first included: never more than the initial window.
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((w) => w.on && w.rows <= INITIAL_ROWS)).toBe(true);
		expect(seen[0]).toEqual({ on: true, rows: INITIAL_ROWS });

		// A small bin renders everything; when it grows past the threshold, the render that sees it is windowed.
		seen.length = 0;
		view.rerender(<Probe rows={50} enabled={false} />);
		expect(seen.at(-1)).toEqual({ on: false, rows: 50 });
		seen.length = 0;
		view.rerender(<Probe rows={900} enabled />);
		expect(seen[0]).toEqual({ on: true, rows: INITIAL_ROWS });
	});
});
