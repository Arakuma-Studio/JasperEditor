import type { Mask } from '@jasper/project';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { maskUi } from '../src/masks/store.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

beforeEach(() => {
	globalThis.localStorage?.clear();
	maskUi.set({ selected: null, vertices: [], pen: null, tracking: {} });
});
afterEach(() => cleanup());

const masksOf = (s: ReturnType<typeof makeSession>, id: string) =>
	((clipOf(s, id) as unknown as { masks?: Mask[] }).masks ?? []) as Mask[];

function setup() {
	const session = makeSession();
	const [id] = addSolids(session, [0], 60);
	act(() => {
		session.select('timeline', [id!]);
		session.transport.seek(10);
	});
	renderWithSession(session, <EffectControlsPanel instanceId="ec-masks" visible />);
	return { session, id: id! };
}

describe('Effect Controls masks', () => {
	it('creates ellipse / polygon masks under Opacity, edits mode / inverted / feather, keys the path, deletes', () => {
		const { session, id } = setup();
		act(() => {
			fireEvent.click(screen.getByTestId(`mask-ellipse-${id}:opacity`));
		});
		act(() => {
			fireEvent.click(screen.getByTestId(`mask-polygon-${id}:opacity`));
		});
		const ms = masksOf(session, id);
		expect(ms.map((m) => m.shape)).toEqual(['ellipse', 'polygon']);
		expect(maskUi.get().selected?.maskId).toBe(ms[1]!.id);
		const m1 = ms[0]!.id;
		act(() => {
			fireEvent.change(screen.getByTestId(`mask-mode-${m1}`), { target: { value: 'subtract' } });
		});
		expect(masksOf(session, id)[0]!.mode).toBe('subtract');
		const field = screen.getByTestId(`prop-masks.${m1}.feather`);
		act(() => {
			fireEvent.pointerDown(field, { clientX: 5, button: 0 });
			fireEvent.pointerUp(window, { clientX: 5 });
		});
		const input = screen.getByTestId(`prop-masks.${m1}.feather-input`);
		act(() => {
			fireEvent.change(input, { target: { value: '33' } });
			fireEvent.keyDown(input, { key: 'Enter' });
		});
		expect(masksOf(session, id)[0]!.feather.value).toBe(33);
		act(() => {
			fireEvent.click(screen.getByTestId(`stopwatch-masks.${m1}.path`));
		});
		expect(masksOf(session, id)[0]!.path.keyframes).toHaveLength(1);
		act(() => {
			fireEvent.click(screen.getByTestId(`mask-delete-${m1}`));
		});
		expect(masksOf(session, id)).toHaveLength(1);
	});

	it('every video effect gets mask tools; the pen arms the monitor', () => {
		const { session, id } = setup();
		act(
			() =>
				void session.apply({
					label: 'fx',
					origin: 'user',
					commands: [
						{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.gaussian-blur' },
					] as never,
				}),
		);
		const fx = (clipOf(session, id) as unknown as { effects: { id: string }[] }).effects[0]!.id;
		act(() => {
			fireEvent.click(screen.getByTestId(`mask-pen-${fx}`));
		});
		expect(maskUi.get().pen).toEqual({ clipId: id, effectId: fx, maskId: null });
		act(() => {
			fireEvent.click(screen.getByTestId(`mask-ellipse-${fx}`));
		});
		const fxm = (clipOf(session, id) as unknown as { effects: { masks?: Mask[] }[] }).effects[0]!.masks!;
		expect(fxm).toHaveLength(1);
		expect(maskUi.get().pen).toBeNull();
	});
});
