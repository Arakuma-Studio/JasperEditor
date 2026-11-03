// Spec 19 TL-052 / §9 in the Looks tab: a category lists its title templates beside its looks; 3D holds only templates,
// real Advanced 3D solids, each stating its cost (TL-078) and asking before it is taken on; the depth that looks draw is
// the Drawn Depth category. A template click inserts its clips at the playhead, one undo step.
import { FACTORY_LOOKS, FACTORY_TEMPLATES, type Layer3D, LOOK_CATEGORIES } from '@jasper/project';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COST_3D_DIALOG } from '../src/three-d/Cost3DDialog.tsx';
import { LooksBrowser } from '../src/title-looks/LooksBrowser.tsx';
import { browserCategories, lookEntries, templateEntries } from '../src/title-looks/library.ts';
import { TemplateList } from '../src/title-looks/TemplateList.tsx';
import { makeSession, renderWithSession } from './inspector-helpers.tsx';

const dialogs = vi.hoisted(() => ({
	answer: true,
	acknowledged: false,
	calls: [] as { id: string; props: unknown }[],
}));
// "Do not show again" is kept in localStorage, which this environment does not have.
vi.mock('../src/three-d/Cost3DDialog.tsx', async (load) => ({
	...(await load<object>()),
	cost3dAcknowledged: vi.fn(() => dialogs.acknowledged),
}));
vi.mock('@jasper/ui', async (load) => ({
	...(await load<object>()),
	openDialog: vi.fn(async (id: string, props: unknown) => {
		dialogs.calls.push({ id, props });
		return dialogs.answer;
	}),
}));

beforeEach(() => {
	dialogs.answer = true;
	dialogs.calls = [];
	dialogs.acknowledged = false;
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

/** The grid measures real layout; give it one. */
function layout(width = 520, height = 500) {
	vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
	vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
}

const chip = (name: string) =>
	within(screen.getByRole('toolbar', { name: 'Categories' })).getByRole('button', { name });
const THREE_D = FACTORY_TEMPLATES.filter((t) => t.category === '3d');

describe('title templates in the Looks tab (TL-052)', () => {
	it('lists the 3D category, which holds templates only, after Drawn Depth', () => {
		const cats = browserCategories(lookEntries(null), templateEntries());
		const labels = LOOK_CATEGORIES.map((c) => c.label);
		expect(cats.slice(0, labels.length)).toEqual(labels);
		expect(cats.indexOf('Drawn Depth')).toBe(cats.indexOf('3D') - 1);
		expect(lookEntries(null).some((e) => e.category === '3D')).toBe(false);
	});

	it('3D shows its solid templates with their cost, and no look grid', () => {
		const session = makeSession();
		layout();
		renderWithSession(session, <LooksBrowser session={session} />);
		expect(screen.queryByTestId('looks-templates')).toBeNull();
		fireEvent.click(chip('3D'));
		const list = screen.getByTestId('looks-templates');
		const cards = within(list).getAllByRole('button');
		expect(cards.map((c) => c.dataset.testid)).toEqual(THREE_D.map((t) => `looks-template-${t.id}`));
		expect(cards.length).toBeGreaterThanOrEqual(4);
		for (const c of cards) {
			expect(c.dataset.cost).toMatch(/^3d/);
			expect(within(c).getByTestId('looks-template-cost').textContent).toMatch(/Remotion path/);
		}
		expect(screen.queryByTestId('look-grid')).toBeNull();
		expect(screen.queryByTestId('looks-no-match')).toBeNull();
		expect(screen.getByTestId('looks-status').textContent).toMatch(/Click a template to insert it/);
	});

	it('Drawn Depth shows the four looks that draw depth, and its flat template states no 3D cost', () => {
		const session = makeSession();
		layout();
		renderWithSession(session, <LooksBrowser session={session} />);
		fireEvent.click(chip('Drawn Depth'));
		expect(screen.getByRole('list', { name: 'Looks' }).dataset.count).toBe(
			String(FACTORY_LOOKS.filter((l) => l.category === 'drawn-depth').length),
		);
		const card = screen.getByTestId('looks-template-template.block-title');
		expect(card.dataset.cost).toBe('fast');
		expect(within(card).queryByTestId('looks-template-cost')).toBeNull();
	});

	it('a search finds templates as well as looks', () => {
		const session = makeSession();
		layout();
		renderWithSession(session, <LooksBrowser session={session} />);
		fireEvent.change(screen.getByTestId('looks-search'), { target: { value: 'inflado' } });
		expect(screen.getByTestId('looks-template-template.puffy-3d-hook')).toBeTruthy();
	});

	it('asks before a 3D template is inserted, and inserts nothing when cancelled', async () => {
		const session = makeSession();
		layout();
		renderWithSession(session, <LooksBrowser session={session} />);
		fireEvent.click(chip('3D'));
		const before = Object.keys(session.getCommitted().sequences[session.getState().activeSequenceId!]!.clips);
		dialogs.answer = false;
		fireEvent.click(screen.getByTestId('looks-template-template.gold-3d-title'));
		await waitFor(() => expect(dialogs.calls).toHaveLength(1));
		expect(dialogs.calls[0]).toEqual({
			id: COST_3D_DIALOG,
			props: { title: 'Insert 3D Title Template', primaryLabel: 'Insert' },
		});
		await act(async () => {});
		const seq = session.getCommitted().sequences[session.getState().activeSequenceId!]!;
		expect(Object.keys(seq.clips)).toEqual(before);
	});

	it('once accepted, inserts the template at the playhead as Advanced 3D, one undo step, selected', async () => {
		const session = makeSession();
		layout();
		renderWithSession(session, <LooksBrowser session={session} />);
		fireEvent.click(chip('3D'));
		act(() => session.transport.seek(12));
		const history = session.getState().history.entries.length;
		fireEvent.click(screen.getByTestId('looks-template-template.gold-3d-title'));
		await waitFor(() => expect(session.getState().history.entries.length).toBe(history + 1));
		const seq = session.getCommitted().sequences[session.getState().activeSequenceId!]!;
		expect(seq.threeD?.renderer).toBe('advanced');
		const selected = session.getState().selection.timeline.clips.map((id) => seq.clips[id]!);
		expect(selected.map((c) => c.kind).sort()).toEqual(['light', 'text', 'text']);
		expect(Math.min(...selected.map((c) => c.start))).toBe(12);
		const solid = selected.find(
			(c) => (c as unknown as { threeD?: Layer3D }).threeD?.enabled === true,
		) as unknown as { threeD: Layer3D };
		expect(solid.threeD.geometry?.bands).toHaveLength(1);
		expect(screen.getByTestId('looks-status').textContent).toMatch(/Inserted Gold 3D Title/);
	});

	it('does not ask again after Do not show again, nor for a template that is not 3D', async () => {
		dialogs.acknowledged = true;
		const session = makeSession();
		layout();
		renderWithSession(session, <LooksBrowser session={session} />);
		fireEvent.click(chip('3D'));
		fireEvent.click(screen.getByTestId('looks-template-template.chrome-plate-3d'));
		dialogs.acknowledged = false;
		fireEvent.click(chip('Drawn Depth'));
		fireEvent.click(screen.getByTestId('looks-template-template.block-title'));
		await act(async () => {});
		expect(dialogs.calls).toHaveLength(0);
		const seq = session.getCommitted().sequences[session.getState().activeSequenceId!]!;
		expect(Object.values(seq.clips).filter((c) => c.kind === 'text').length).toBe(3);
	});

	it('says why a template cannot be inserted', () => {
		render(
			<TemplateList
				templates={templateEntries().slice(0, 1)}
				fill
				disabledReason="Open a sequence to use looks."
				onInsert={() => {}}
			/>,
		);
		const card = screen.getAllByRole('button')[0]!;
		expect((card as HTMLButtonElement).disabled).toBe(true);
		expect(card.title).toBe('Open a sequence to use looks.');
	});
});
