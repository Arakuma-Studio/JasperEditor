// Spec 19 TL-094 with TL-056: the badge on the library's real `lintAppearance`, not a stand-in. A look whose rim merges
// with its face and is too thin shows both issues, worded from the lint's template, and the lint's own fix applies.
import { type Appearance, clipLook, type LookRecipe, titleLooksOf } from '@jasper/project';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../src/i18n/runtime.ts';
import { PropertiesPanel } from '../src/panels/properties/PropertiesPanel.tsx';
import { clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

const recipe: LookRecipe = {
	palette: { face: [1, 1, 1, 1], keyline: [0.95, 0.95, 0.95, 1] },
	layers: [{ type: 'rim', params: { width: 1 } }, { type: 'face' }],
};

afterEach(async () => {
	cleanup();
	await setLanguage('en');
});

function paleTitle() {
	const session = makeSession();
	const r = session.apply({
		label: 's',
		origin: 'user',
		commands: [
			{ type: 'look.create', name: 'Pale', recipe },
			{
				type: 'clip.addText',
				at: 0,
				duration: 30,
				track: 'V2',
				content: { text: 'Title', style: { sizePx: 100 } },
			},
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const id = r.created.find((c) => c.startsWith('clp_'))!;
	session.apply({
		label: 'l',
		origin: 'user',
		commands: [
			{ type: 'look.apply', clipIds: [id], lookId: titleLooksOf(session.getCommitted())[0]!.id },
		] as never,
	});
	act(() => session.select('timeline', [id]));
	return { session, id };
}

describe('style check badge on the real lint (TL-094, TL-056)', () => {
	it('shows the issues the library finds, and applies its fix as one undo step', () => {
		const { session, id } = paleTitle();
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);

		const badge = screen.getByTestId('look-style-badge');
		expect(badge.textContent).toBe('2 issues');
		fireEvent.click(badge);
		const list = screen.getByTestId('look-style-list');
		const codes = [...list.querySelectorAll('[data-issue]')].map((e) => e.getAttribute('data-issue'));
		expect(codes).toEqual(expect.arrayContaining(['LOOK_RINGS_MERGE', 'LOOK_RIMS_THIN']));
		expect(list.textContent).toContain('Face and Rim 1 are close in lightness');
		expect(screen.getByTestId('look-style-unmeasured-backdrop-contrast')).toBeTruthy();

		const width = () =>
			(
				clipLook((clipOf(session, id) as unknown as { effects: never[] }).effects) as unknown as {
					appearance: Appearance;
				}
			).appearance.layers[0]!.params.width!.value as number;
		const n = session.getState().history.entries.length;
		fireEvent.click(screen.getByTestId('look-style-fix-LOOK_RIMS_THIN'));
		expect(session.getState().history.entries.length).toBe(n + 1);
		expect(width()).toBeGreaterThan(1);
		session.undo();
		expect(width()).toBe(1);
	});

	it('words an issue from its template, with translated arguments', async () => {
		await setLanguage('es');
		const { session } = paleTitle();
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		fireEvent.click(screen.getByTestId('look-style-badge'));
		expect(screen.getByTestId('look-style-list').textContent).toContain(
			'Cara y Borde 1 tienen una luminosidad parecida (ΔL 4)',
		);
	});
});
