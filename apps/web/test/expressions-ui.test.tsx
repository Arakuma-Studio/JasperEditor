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
				commands: [
					{ type: 'expression.set', target: ['clip', id, 'transform', 'rotation'], text: 'time * 90' },
				] as never,
			});
		});
		// Frame 30 = 1 s → 90° in the value field.
		await waitFor(() => expect(screen.getByTestId('prop-transform.rotation').textContent).toContain('90'));
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
				commands: [
					{ type: 'expression.set', target: ['clip', id, 'transform', 'rotation'], text: 'nope(' },
				] as never,
			});
		});
		const pathId = `clip-${id}-transform-rotation`;
		await waitFor(() => expect(screen.getByTestId(`expr-error-${pathId}`).textContent).toBeTruthy());
		expect(screen.getByTestId('prop-transform.rotation').textContent).toContain('0');
		act(() => {
			fireEvent.click(screen.getByTestId(`expr-enable-${pathId}`));
		});
		expect(rotationOf(session, id).expression?.enabled).toBe(false);
		await waitFor(() => expect(screen.queryByTestId(`expr-error-${pathId}`)).toBeNull());
	});
});
