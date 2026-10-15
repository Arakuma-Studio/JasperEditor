import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

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
					[0, 0],
					[10, 80],
					[40, 100],
				].map(([frames, value]) => ({
					type: 'keyframe.add',
					target: ['clip', id, 'opacity'],
					at: { frames },
					value,
				})) as never,
			}),
	);
	renderWithSession(session, <EffectControlsPanel instanceId="ecb" visible />);
	const clip = () =>
		clipOf(session, id!) as unknown as {
			blendMode: string;
			opacity: { keyframes: { id: string; time: number; roving?: boolean }[] };
		};
	return { session, id: id!, clip, history: () => session.getState().history.entries.length };
}

describe('Blend Mode menu (keyframes-blend)', () => {
	it('sets the selected blend mode in one undo entry', () => {
		const { clip, history, session } = setup();
		const select = screen.getByTestId('prop-blendMode') as HTMLSelectElement;
		const before = history();
		act(() => {
			fireEvent.change(select, { target: { value: 'vivid-light' } });
		});
		expect(clip().blendMode).toBe('vivid-light');
		expect(history()).toBe(before + 1);
		act(() => session.undo());
		expect(clip().blendMode).toBe('normal');
	});
});

describe('Rove Across Time (keyframes-blend)', () => {
	it('right-click a middle key toggles Rove Across Time', () => {
		const { clip } = setup();
		const mid = clip().opacity.keyframes[1]!;
		const lane = document.querySelector(`[data-kf-id="${mid.id}"]`)!;
		act(() => {
			fireEvent.contextMenu(lane, { clientX: 20, clientY: 20 });
		});
		const item = screen.getByTestId('ec-kf-rove');
		expect(item.getAttribute('aria-checked')).toBe('false');
		act(() => {
			fireEvent.click(item);
		});
		expect(clip().opacity.keyframes[1]!.roving).toBe(true);
		act(() => {
			fireEvent.contextMenu(document.querySelector(`[data-kf-id="${mid.id}"]`)!, {
				clientX: 20,
				clientY: 20,
			});
		});
		expect(screen.getByTestId('ec-kf-rove').getAttribute('aria-checked')).toBe('true');
		act(() => {
			fireEvent.click(screen.getByTestId('ec-kf-rove'));
		});
		expect(clip().opacity.keyframes[1]!.roving).toBeUndefined();
	});

	it('is not offered for the first or last key', () => {
		const { clip } = setup();
		const first = clip().opacity.keyframes[0]!;
		act(() => {
			fireEvent.contextMenu(document.querySelector(`[data-kf-id="${first.id}"]`)!, {
				clientX: 20,
				clientY: 20,
			});
		});
		expect(screen.queryByTestId('ec-kf-rove')).toBeNull();
	});
});

/** A wheel event with modifiers (happy-dom drops them from WheelEvent's init). */
function wheel(el: Element, init: { deltaY: number; ctrlKey?: boolean; shiftKey?: boolean }) {
	const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: init.deltaY });
	for (const k of ['ctrlKey', 'shiftKey'] as const) Object.defineProperty(ev, k, { value: !!init[k] });
	Object.defineProperty(ev, 'deltaY', { value: init.deltaY });
	el.dispatchEvent(ev);
}

describe('graph editor (keyframes-blend)', () => {
	it('Ctrl-wheel disables auto-fit for one graph, survives remount, and Fit restores it', () => {
		const { session } = setup();
		act(() => {
			fireEvent.click(screen.getByTestId('twirl-opacity'));
		});
		const fit = () => screen.getByTestId('graph-fit-value-opacity').getAttribute('aria-pressed');
		expect(fit()).toBe('true');
		act(() => {
			wheel(screen.getByTestId('graph-value-opacity'), { deltaY: -100, ctrlKey: true });
		});
		expect(fit()).toBe('false');
		expect(screen.getByTestId('graph-fit-velocity-opacity').getAttribute('aria-pressed')).toBe('true');
		cleanup();
		renderWithSession(session, <EffectControlsPanel instanceId="ecb" visible />);
		expect(fit()).toBe('false');
		act(() => {
			fireEvent.click(screen.getByTestId('graph-fit-value-opacity'));
		});
		expect(fit()).toBe('true');
	});

	it('vec2 Bezier handles on the X and Y curves edit the shared ease (one undo entry)', () => {
		const session = makeSession();
		const [id] = addSolids(session, [30], 60);
		act(() => {
			session.select('timeline', [id!]);
			session.transport.seek(5);
		});
		act(
			() =>
				void session.apply({
					label: 'keys',
					origin: 'user',
					commands: [
						{
							type: 'keyframe.add',
							target: ['clip', id, 'transform', 'position'],
							at: { frames: 0 },
							value: [100, 100],
							interpolation: 'bezier',
						},
						{
							type: 'keyframe.add',
							target: ['clip', id, 'transform', 'position'],
							at: { frames: 20 },
							value: [500, 300],
							interpolation: 'bezier',
						},
					] as never,
				}),
		);
		renderWithSession(session, <EffectControlsPanel instanceId="ecv" visible />);
		act(() => {
			fireEvent.click(screen.getByTestId('twirl-transform.position'));
		});
		const keys = () =>
			(
				clipOf(session, id!) as unknown as {
					transform: { position: { keyframes: { id: string; easeOut: { slope: number } }[] } };
				}
			).transform.position.keyframes;
		const first = keys()[0]!;
		act(() => {
			fireEvent.pointerDown(screen.getByTestId(`graph-value-key-${first.id}-0`), {
				clientX: 10,
				clientY: 10,
				button: 0,
			});
			fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
		});
		const hx = screen.getByTestId(`graph-value-handle-${first.id}-out-0`);
		expect(screen.getByTestId(`graph-value-handle-${first.id}-out-1`)).toBeTruthy();
		const before = session.getState().history.entries.length;
		const slope0 = keys()[0]!.easeOut.slope;
		act(() => {
			fireEvent.pointerDown(hx, { clientX: 100, clientY: 50, button: 0 });
		});
		act(() => {
			fireEvent.pointerMove(window, { clientX: 100, clientY: 30 });
			fireEvent.pointerMove(window, { clientX: 100, clientY: 20 });
			fireEvent.pointerUp(window, { clientX: 100, clientY: 20 });
		});
		expect(keys()[0]!.easeOut.slope).toBeGreaterThan(slope0);
		expect(session.getState().history.entries.length).toBe(before + 1);
	});
});
