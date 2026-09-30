import { EngineClient } from '@jasper/engine-client';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../src/App.tsx';
import { EngineProvider } from '../src/state/engine.tsx';

function fakeEngine() {
	const fetchImpl = (async (url: string) => {
		const json = (b: unknown, status = 200) =>
			new Response(JSON.stringify(b), { status, headers: { 'x-jasper-api': '1' } });
		if (url === '/health') return json({ ok: true, version: '0.1.0', apiVersion: 1 });
		return json({ code: 'NOT_IMPLEMENTED', message: 'later', retryable: false }, 501);
	}) as unknown as typeof fetch;
	return new EngineClient({ fetch: fetchImpl });
}

describe('web app', () => {
	it('shows Home with the engine status and a friendly projects error while the store is stubbed', async () => {
		render(
			<EngineProvider client={fakeEngine()} connectEvents={false}>
				<MemoryRouter initialEntries={['/']}>
					<AppRoutes />
				</MemoryRouter>
			</EngineProvider>,
		);
		await waitFor(() => expect(screen.getByTestId('engine-status').textContent).toContain('connected'));
		await waitFor(() =>
			expect(screen.getByTestId('projects-error').textContent).toContain('NOT_IMPLEMENTED'),
		);
	});

	it('opens the in-memory demo project in the editor shell', async () => {
		// Desktop layout (≥ 1280 px) → the Editing workspace (S05:AC-SH-1).
		(
			window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }
		).happyDOM.setViewport({
			width: 1920,
			height: 1080,
		});
		const { unmount } = render(
			<EngineProvider client={fakeEngine()} connectEvents={false}>
				<MemoryRouter initialEntries={['/project/demo']}>
					<AppRoutes />
				</MemoryRouter>
			</EngineProvider>,
		);
		await waitFor(() => expect(screen.getByTestId('editor-shell')).toBeTruthy());
		for (const kind of ['program', 'timeline', 'project', 'properties']) {
			expect(document.querySelector(`[data-slot="${kind}"]`)).toBeTruthy();
		}
		// Panel bodies are code-split (React.lazy): let every chunk resolve first (slow under a loaded
		// `pnpm verify`), and before the environment is torn down, or React renders them after `window` is gone.
		await waitFor(() => expect(document.querySelectorAll('[data-testid="panel-loading"]').length).toBe(0), {
			timeout: 20_000,
		});
		// The real Project panel (WP-2E) replaced the placeholder that printed "Demo project · rev 0".
		await waitFor(
			() => expect(screen.getByTestId('project-breadcrumb').textContent).toContain('Demo project'),
			{ timeout: 20_000 },
		);
		unmount();
	});
});
