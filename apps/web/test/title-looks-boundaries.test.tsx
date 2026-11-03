// AGENTS §0 for spec 19's panels: a failure in the Looks tab, the Look section or the Appearance section of Properties
// is a visible line with Retry in its own place; Properties and the rest of the tab keep working.
import { titleLooksOf } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const boom = vi.hoisted(() => ({ appearance: false, selection: false, browser: false }));

vi.mock('../src/title-looks/AppearanceList.tsx', async (load) => {
	const m = await load<typeof import('../src/title-looks/AppearanceList.tsx')>();
	return {
		...m,
		AppearanceList: (props: Parameters<typeof m.AppearanceList>[0]) => {
			if (boom.appearance) throw new Error('layer stack unreadable');
			return m.AppearanceList(props);
		},
	};
});
vi.mock('../src/title-looks/selection.ts', async (load) => {
	const m = await load<typeof import('../src/title-looks/selection.ts')>();
	return {
		...m,
		lookSelection: (...a: Parameters<typeof m.lookSelection>) => {
			if (boom.selection) throw new Error('selection unreadable');
			return m.lookSelection(...a);
		},
	};
});
vi.mock('../src/title-looks/LooksBrowser.tsx', async (load) => {
	const m = await load<typeof import('../src/title-looks/LooksBrowser.tsx')>();
	return {
		...m,
		LooksBrowser: (props: Parameters<typeof m.LooksBrowser>[0]) => {
			if (boom.browser) throw new Error('grid unreadable');
			return <m.LooksBrowser {...props} />;
		},
	};
});

const { PropertiesPanel } = await import('../src/panels/properties/PropertiesPanel.tsx');
const { LooksTab } = await import('../src/title-looks/LooksTab.tsx');
const { makeSession, renderWithSession } = await import('./inspector-helpers.tsx');

function titleWithLook() {
	const session = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [
			{ type: 'look.create', name: 'Gold', recipe: { layers: [{ type: 'rim' }, { type: 'face' }] } },
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V2', content: { text: 'title' } },
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const id = r.created.find((x) => x.startsWith('clp_'))!;
	session.apply({
		label: 'look',
		origin: 'user',
		commands: [
			{ type: 'look.apply', clipIds: [id], lookId: titleLooksOf(session.getCommitted())[0]!.id },
		] as never,
	});
	act(() => session.select('timeline', [id]));
	return session;
}

afterEach(() => {
	boom.appearance = false;
	boom.selection = false;
	boom.browser = false;
	cleanup();
	vi.restoreAllMocks();
});

const crashed = (name: string) =>
	screen.getAllByTestId('section-crashed').find((e) => e.getAttribute('data-boundary') === name);

describe('Properties sections (TL-089)', () => {
	it('Appearance failing is a line in its section; the Look header and Transform stay', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const session = titleWithLook();
		boom.appearance = true;
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		expect(crashed('Appearance')?.textContent).toContain('layer stack unreadable');
		expect(screen.getByTestId('look-name').textContent).toBe('Gold');
		expect(screen.getByText('Transform')).toBeTruthy();
		boom.appearance = false;
		fireEvent.click(crashed('Appearance')!.querySelector('button')!);
		expect(screen.queryByTestId('section-crashed')).toBeNull();
	});

	it('the Look section failing is a line; the rest of Properties stays', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const session = titleWithLook();
		boom.selection = true;
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		expect(crashed('Look')?.textContent).toContain('selection unreadable');
		expect(screen.getByText('Transform')).toBeTruthy();
		expect(screen.queryByTestId('panel-crashed')).toBeNull();
	});
});

describe('Looks tab (TL-086)', () => {
	it('a failing browser is a line with Retry; the tab stays', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const session = titleWithLook();
		boom.browser = true;
		render(
			<SessionProvider session={session}>
				<p data-testid="other-tab">templates</p>
				<LooksTab onShowTemplates={() => {}} />
			</SessionProvider>,
		);
		expect(crashed('Looks')?.textContent).toContain('grid unreadable');
		expect(screen.getByTestId('other-tab')).toBeTruthy();
	});
});
