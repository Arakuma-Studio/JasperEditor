// keyframe-sides: Premiere's Temporal Interpolation menu (Ease In / Ease Out set one side), the key glyph halves,
// the graph editor's per-side handles and the timeline lane menu helpers (docs/wp-notes/keyframe-sides.md).
import type { Keyframe } from '@jasper/project';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

type Key = Keyframe<number>;
const EASY = { influence: 1 / 3, slope: 0 };
beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => cleanup());

function setup() {
	const session = makeSession();
	const [id] = addSolids(session, [30], 60);
	act(() => {
		session.select('timeline', [id!]);
		session.transport.seek(40);
	});
	act(
		() =>
			void session.apply({
				label: 'keys',
				origin: 'user',
				commands: [
					{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 0 }, value: 0 },
					{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 20 }, value: 100 },
					{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 40 }, value: 30 },
				] as never,
			}),
	);
	renderWithSession(session, <EffectControlsPanel instanceId="ec-sides" visible />);
	const keys = () => (clipOf(session, id!) as unknown as { opacity: { keyframes: Key[] } }).opacity.keyframes;
	const menuOn = (keyId: string) =>
		act(() => {
			fireEvent.contextMenu(document.querySelector(`button[data-kf-id="${keyId}"]`)!, {
				clientX: 10,
				clientY: 10,
			});
		});
	return { session, id: id!, keys, menuOn };
}

describe('Temporal Interpolation menu (keyframe-sides)', () => {
	it('Ease In and Ease Out edit their own sides, keep the menu checked and undo', () => {
		const { session, keys, menuOn } = setup();
		const [a, b] = keys();
		menuOn(b!.id);
		const menu = screen.getByTestId('ec-kf-menu');
		expect(menu.querySelector('[data-preset="linear"]')!.getAttribute('aria-checked')).toBe('true');
		act(() => {
			fireEvent.click(within(menu).getByText('Ease In'));
		});
		expect(keys()[0]).toEqual(a);
		expect(keys()[1]).toMatchObject({ interpolation: 'linear', inInterpolation: 'bezier', easeIn: EASY });

		menuOn(b!.id);
		const again = screen.getByTestId('ec-kf-menu');
		expect(again.querySelector('[data-preset="ease-in"]')!.getAttribute('aria-checked')).toBe('true');
		expect(again.querySelector('[data-preset="linear"]')!.getAttribute('aria-checked')).toBe('false');
		act(() => {
			fireEvent.click(within(again).getByText('Ease Out'));
		});
		expect(keys()[1]).toMatchObject({
			interpolation: 'bezier',
			inInterpolation: 'bezier',
			easeIn: EASY,
			easeOut: EASY,
		});
		act(() => session.undo());
		act(() => session.undo());
		expect(keys()[1]!.interpolation).toBe('linear');
		expect(keys()[1]!.inInterpolation).toBeUndefined();
	});

	it('the graph shows a handle on the eased side only and edits that side', () => {
		const { keys, menuOn } = setup();
		const b = keys()[1]!;
		menuOn(b.id);
		act(() => {
			fireEvent.click(within(screen.getByTestId('ec-kf-menu')).getByText('Ease In'));
		});
		act(() => {
			fireEvent.click(screen.getByTestId('twirl-opacity'));
		});
		act(() => {
			fireEvent.pointerDown(screen.getByTestId(`graph-value-key-${b.id}`), {
				clientX: 10,
				clientY: 10,
				button: 0,
			});
			fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
		});
		expect(screen.getByTestId(`graph-value-handle-${b.id}-in`)).toBeTruthy();
		expect(screen.queryByTestId(`graph-value-handle-${b.id}-out`)).toBeNull();
		act(() => {
			fireEvent.pointerDown(screen.getByTestId(`graph-value-handle-${b.id}-in`), {
				clientX: 100,
				clientY: 50,
				button: 0,
			});
		});
		act(() => {
			fireEvent.pointerMove(window, { clientX: 80, clientY: 50 });
			fireEvent.pointerMove(window, { clientX: 60, clientY: 50 });
			fireEvent.pointerUp(window, { clientX: 60, clientY: 50 });
		});
		const after = keys()[1]!;
		expect(after.interpolation).toBe('linear');
		expect(after.inInterpolation).toBe('bezier');
		expect(after.easeIn.influence).toBeGreaterThan(1 / 3);
		menuOn(b.id);
		act(() =>
			fireEvent.click(
				within(screen.getByTestId('ec-kf-menu')).getByRole('menuitemradio', { name: 'Continuous Bezier' }),
			),
		);
		const outgoing = structuredClone(keys()[1]!.easeOut);
		act(() => {
			fireEvent.pointerDown(screen.getByTestId(`graph-value-handle-${b.id}-out`), {
				clientX: 100,
				clientY: 50,
				button: 0,
			});
			fireEvent.pointerMove(window, { clientX: 120, clientY: 40 });
			fireEvent.pointerUp(window, { clientX: 120, clientY: 40 });
		});
		expect(keys()[1]!.interpolation).toBe('continuous-bezier');
		expect(keys()[1]!.easeOut).not.toEqual(outgoing);
		const incoming = structuredClone(keys()[1]!.easeIn);
		act(() => {
			fireEvent.pointerDown(screen.getByTestId(`graph-value-handle-${b.id}-out`), {
				clientX: 120,
				clientY: 40,
				button: 0,
				altKey: true,
			});
			fireEvent.pointerMove(window, { clientX: 140, clientY: 30, altKey: true });
			fireEvent.pointerUp(window, { clientX: 140, clientY: 30, altKey: true });
		});
		expect(keys()[1]!.interpolation).toBe('bezier');
		expect(keys()[1]!.easeIn).toEqual(incoming);
	});
});
