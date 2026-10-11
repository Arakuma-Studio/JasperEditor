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
	it('lists the 32 modes in labelled groups and sets one as one undo entry', () => {
		const { clip, history, session } = setup();
		const select = screen.getByTestId('prop-blendMode') as HTMLSelectElement;
		const groups = [...select.querySelectorAll('optgroup')].map((g) => [
			g.label,
			g.querySelectorAll('option').length,
		]);
		expect(groups).toEqual([
			['Normal', 2],
			['Subtractive', 5],
			['Additive', 5],
			['Complex', 7],
			['Difference', 4],
			['HSL', 4],
			['Utility', 5],
		]);
		expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toContain('Linear Dodge (Add)');
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
	it('right-click a middle key ▸ Rove Across Time toggles roving; the lane draws a dot', () => {
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
		// 80 of 100 units of a 40-frame span → frame 32.
		expect(clip().opacity.keyframes[1]!.time / (705_600_000 / 30)).toBeCloseTo(32, 3);
		expect(document.querySelector(`[data-kf-id="${mid.id}"]`)!.getAttribute('data-kf-shape')).toBe('roving');
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
	it('Ctrl/Cmd + wheel zooms one graph vertically; Fit returns to auto-fit; persisted per panel', () => {
		const { session } = setup();
		act(() => {
			fireEvent.click(screen.getByTestId('twirl-opacity'));
		});
		const labels = () => screen.getByTestId('graph-value-labels-opacity').textContent ?? '';
		const velocity = () => screen.getByTestId('graph-velocity-labels-opacity').textContent ?? '';
		const before = labels();
		const velBefore = velocity();
		expect(screen.getByTestId('graph-fit-value-opacity').getAttribute('aria-pressed')).toBe('true');
		act(() => {
			wheel(screen.getByTestId('graph-value-opacity'), { deltaY: -100, ctrlKey: true });
		});
		expect(labels()).not.toBe(before);
		expect(velocity()).toBe(velBefore);
		expect(screen.getByTestId('graph-fit-value-opacity').getAttribute('aria-pressed')).toBe('false');
		const zoomed = labels();
		cleanup();
		renderWithSession(session, <EffectControlsPanel instanceId="ecb" visible />);
		expect(labels()).toBe(zoomed);
		act(() => {
			wheel(screen.getByTestId('graph-value-opacity'), { deltaY: 100, shiftKey: true });
		});
		expect(labels()).not.toBe(zoomed);
		act(() => {
			fireEvent.click(screen.getByTestId('graph-fit-value-opacity'));
		});
		expect(labels()).toBe(before);
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
