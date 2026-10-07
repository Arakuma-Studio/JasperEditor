// Wave expressions in Effect Controls: Alt-click the stopwatch, the expression row (editor, enable switch, errors),
// post-expression values in red, undo, Expression Controls editors and the post-expression graph.
import { loadExpressionEngine } from '@jasper/expressions';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

beforeAll(async () => {
	await loadExpressionEngine();
});
beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => cleanup());

type Rot = { expression?: { text: string; enabled: boolean } };
const rotationOf = (s: ReturnType<typeof makeSession>, id: string) =>
	(clipOf(s, id) as unknown as { transform: { rotation: Rot } }).transform.rotation;

function setup() {
	const session = makeSession();
	const [id] = addSolids(session, [0], 90);
	act(() => {
		session.select('timeline', [id!]);
		session.transport.seek(30);
	});
	renderWithSession(session, <EffectControlsPanel instanceId="ecx" visible />);
	return { session, id: id! };
}

describe('Effect Controls expressions', () => {
	it('Alt-click adds the default expression; the value shows post-expression; Alt-click removes; undo', async () => {
		const { session, id } = setup();
		act(() => {
			fireEvent.click(screen.getByTestId('stopwatch-transform.rotation'), { altKey: true });
		});
		expect(rotationOf(session, id).expression).toEqual({ text: 'transform.rotation', enabled: true });
		const pathId = `clip-${id}-transform-rotation`;
		await waitFor(() => expect(screen.getByTestId(`expr-row-${pathId}`)).toBeTruthy());
		act(() => {
			session.apply({
				label: 'expr',
				origin: 'user',
				commands: [{ type: 'expression.set', target: ['clip', id, 'transform', 'rotation'], text: 'time * 90' }] as never,
			});
		});
		// Frame 30 = 1 s → 90°, shown in red (data-expression="active").
		await waitFor(() => expect(screen.getByTestId('prop-transform.rotation').textContent).toContain('90'));
		expect(document.querySelector('[data-expression="active"]')).toBeTruthy();
		act(() => {
			fireEvent.click(screen.getByTestId('stopwatch-transform.rotation'), { altKey: true });
		});
		expect(rotationOf(session, id).expression).toBeUndefined();
		act(() => session.undo());
		expect(rotationOf(session, id).expression?.text).toBe('time * 90');
	});

	it('errors show under the field and the property keeps its keyframed value; the switch disables', async () => {
		const { session, id } = setup();
		act(() => {
			session.apply({
				label: 'expr',
				origin: 'user',
				commands: [{ type: 'expression.set', target: ['clip', id, 'transform', 'rotation'], text: 'nope(' }] as never,
			});
		});
		const pathId = `clip-${id}-transform-rotation`;
		await waitFor(() => expect(screen.getByTestId(`expr-error-${pathId}`).textContent).toMatch(/Error at line 1/));
		expect(screen.getByTestId('prop-transform.rotation').textContent).toContain('0');
		act(() => {
			fireEvent.click(screen.getByTestId(`expr-enable-${pathId}`));
		});
		expect(rotationOf(session, id).expression?.enabled).toBe(false);
		await waitFor(() => expect(screen.queryByTestId(`expr-error-${pathId}`)).toBeNull());
	});

	it('Expression Controls show their editors (dropdown items, layer picker, 3D point)', async () => {
		const { session, id } = setup();
		act(() => {
			session.apply({
				label: 'controls',
				origin: 'user',
				commands: [
					{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.dropdown-control', params: { items: 'Small\nLarge' } },
					{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.layer-control' },
					{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.point3d-control' },
				] as never,
			});
		});
		const fxs = (clipOf(session, id) as unknown as { effects: { id: string }[] }).effects;
		const menu = await screen.findByTestId(`prop-effects.${fxs[0]!.id}.menu`);
		expect([...menu.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Small', 'Large']);
		const layer = screen.getByTestId(`prop-effects.${fxs[1]!.id}.layer`);
		expect(layer.querySelectorAll('option').length).toBe(2);
		expect(screen.getByTestId(`prop-effects.${fxs[2]!.id}.point-2`)).toBeTruthy();
	});
});
