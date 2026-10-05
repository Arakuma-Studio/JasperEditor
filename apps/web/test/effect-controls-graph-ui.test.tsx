// Effect Controls Value / Velocity graphs (S03:KF-022, S05:ECP-006): twirl, key and handle drags (one
// undo entry each, transient preview while dragging), shared selection and the key context menu.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

type Key = {
	id: string;
	time: number;
	value: number;
	interpolation: string;
	easeIn: { influence: number; slope: number };
	easeOut: { influence: number; slope: number };
};
const F = 705_600_000 / 30;

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => cleanup());

function setup(
	keys: [number, number, string?][] = [
		[0, 0],
		[20, 100],
	],
) {
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
				commands: keys.map(([frames, value, interpolation]) => ({
					type: 'keyframe.add',
					target: ['clip', id, 'opacity'],
					at: { frames },
					value,
					...(interpolation ? { interpolation } : {}),
				})) as never,
			}),
	);
	renderWithSession(session, <EffectControlsPanel instanceId="ecg" visible />);
	const keysOf = () =>
		(clipOf(session, id!) as unknown as { opacity: { keyframes: Key[] } }).opacity.keyframes;
	const history = () => session.getState().history.entries.length;
	const open = () =>
		act(() => {
			fireEvent.click(screen.getByTestId('twirl-opacity'));
		});
	const click = (el: Element) =>
		act(() => {
			fireEvent.pointerDown(el, { clientX: 10, clientY: 10, button: 0 });
			fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
		});
	const drag = (el: Element, dx: number, dy: number, init: { altKey?: boolean; shiftKey?: boolean } = {}) => {
		act(() => {
			// Shift on pointer-down toggles the selection (like the lanes); it only disables snapping mid-drag.
			fireEvent.pointerDown(el, { clientX: 100, clientY: 50, button: 0, altKey: init.altKey });
		});
		act(() => {
			fireEvent.pointerMove(window, { clientX: 100 + dx / 2, clientY: 50 + dy / 2, ...init });
		});
		const transient = session.getState().transient;
		act(() => {
			fireEvent.pointerMove(window, { clientX: 100 + dx, clientY: 50 + dy, ...init });
			fireEvent.pointerUp(window, { clientX: 100 + dx, clientY: 50 + dy });
		});
		return transient;
	};
	return { session, id: id!, keysOf, history, open, click, drag };
}

describe('Effect Controls graphs (S03:KF-022)', () => {
	it('the twirl opens the Value and Velocity graphs with min/max labels; the state persists', () => {
		const { open, session } = setup();
		expect(screen.queryByTestId('graphs-opacity')).toBeNull();
		// Numeric and vec2 rows have a twirl; others (Blend Mode) do not.
		expect(screen.getByTestId('twirl-transform.position')).toBeTruthy();
		expect(screen.queryByTestId('twirl-blendMode')).toBeNull();
		open();
		expect(screen.getByTestId('twirl-opacity').getAttribute('aria-expanded')).toBe('true');
		expect(screen.getByTestId('graph-value-curve-opacity-0').getAttribute('d')).toMatch(/^M.+L/);
		expect(screen.getByTestId('graph-velocity-curve-opacity').getAttribute('d')).toMatch(/^M.+L/);
		// Fit with 10 % headroom: 0..100 → -10..110; velocity 0..150 / s → -15..165.
		const values = screen.getByTestId('graph-value-labels-opacity').textContent;
		expect(values).toContain('110.0%');
		expect(values).toContain('-10.0%');
		expect(screen.getByTestId('graph-velocity-labels-opacity').textContent).toContain('165.0%/s');
		cleanup();
		renderWithSession(session, <EffectControlsPanel instanceId="ecg" visible />);
		expect(screen.getByTestId('graphs-opacity')).toBeTruthy();
	});

	it('dragging a value-graph key vertically changes its value as one undo entry, previewed live', () => {
		const { keysOf, history, drag, session } = setup();
		const [first] = keysOf();
		const before = history();
		act(() => {
			fireEvent.click(screen.getByTestId('twirl-opacity'));
		});
		// 82 px value box over -10..110 → 1.463 per px; 20 px up ≈ +29.3.
		const transient = drag(screen.getByTestId(`graph-value-key-${first!.id}`), 0, -20);
		expect(transient).not.toBeNull();
		expect(keysOf()[0]!.value).toBeCloseTo(29.27, 1);
		expect(keysOf()[0]!.time).toBe(0);
		expect(history()).toBe(before + 1);
		expect(session.getState().selection.keyframes?.keyframeIds).toEqual([first!.id]);
		act(() => session.undo());
		expect(keysOf()[0]!.value).toBe(0);
	});

	it('dragging a key horizontally moves it in time (whole frames, Shift = no snap); Esc cancels', () => {
		const { keysOf, history, drag, open } = setup();
		open();
		const [first] = keysOf();
		// 68 frames over the 300 px fallback width: 44 px ≈ 10 frames.
		drag(screen.getByTestId(`graph-value-key-${first!.id}`), 44, 0, { shiftKey: true });
		expect(keysOf()[0]!.time).toBe(10 * F);
		expect(keysOf()[0]!.value).toBe(0);
		const before = history();
		const el = screen.getByTestId(`graph-value-key-${first!.id}`);
		act(() => {
			fireEvent.pointerDown(el, { clientX: 100, clientY: 50, button: 0 });
			fireEvent.pointerMove(window, { clientX: 100, clientY: 10 });
			fireEvent.keyDown(window, { key: 'Escape' });
		});
		expect(keysOf()[0]!.value).toBe(0);
		expect(history()).toBe(before);
	});

	it('velocity handles: vertical = speed, horizontal = influence; a Linear key becomes Bezier', () => {
		const { keysOf, history, drag, open, click } = setup();
		open();
		const [first] = keysOf();
		expect(screen.queryByTestId(`graph-velocity-handle-${first!.id}-out`)).toBeNull();
		click(screen.getByTestId(`graph-value-key-${first!.id}`)); // handles show on selected keys
		const handle = screen.getByTestId(`graph-velocity-handle-${first!.id}-out`);
		const before = history();
		// 67 px velocity box over -15..165 / s: 20 px up ≈ +53.7 → 203.7 / s = 1.358 × the linear speed.
		drag(handle, 0, -20);
		const k = keysOf()[0]!;
		expect(k.interpolation).toBe('bezier');
		expect(k.easeOut.slope).toBeCloseTo(1.358, 2);
		expect(k.easeOut.influence).toBeCloseTo(1 / 3, 6);
		expect(history()).toBe(before + 1);
		// Horizontal: 20 frames segment = 88.2 px; +22 px ≈ +0.25 influence; clamped to 1 far right.
		drag(screen.getByTestId(`graph-velocity-handle-${first!.id}-out`), 22, 0);
		expect(keysOf()[0]!.easeOut.influence).toBeCloseTo(1 / 3 + 0.25, 1);
		drag(screen.getByTestId(`graph-velocity-handle-${first!.id}-out`), 500, 0);
		expect(keysOf()[0]!.easeOut.influence).toBe(1);
		drag(screen.getByTestId(`graph-velocity-handle-${first!.id}-out`), -500, 0);
		expect(keysOf()[0]!.easeOut.influence).toBe(0.01);
	});

	it('Continuous Bezier keeps in/out speeds linked; Alt-drag breaks the link into Bezier', () => {
		const { keysOf, drag, open, click } = setup([
			[0, 0],
			[20, 60, 'continuous-bezier'],
			[40, 0],
		]);
		open();
		const mid = keysOf()[1]!;
		click(screen.getByTestId(`graph-value-key-${mid.id}`));
		drag(screen.getByTestId(`graph-velocity-handle-${mid.id}-out`), 0, 10);
		let k = keysOf()[1]!;
		expect(k.interpolation).toBe('continuous-bezier');
		expect(k.easeOut.slope).toBeGreaterThan(0);
		// Linked: equal speeds on both sides (both segments are 60 over 20 frames).
		expect(k.easeIn.slope).toBeCloseTo(k.easeOut.slope, 6);
		const inBefore = k.easeIn.slope;
		drag(screen.getByTestId(`graph-velocity-handle-${mid.id}-out`), 0, 10, { altKey: true });
		k = keysOf()[1]!;
		expect(k.interpolation).toBe('bezier');
		expect(k.easeIn.slope).toBeCloseTo(inBefore, 6);
		expect(k.easeOut.slope).not.toBeCloseTo(inBefore, 3);
	});

	it('value-graph Bezier handles edit the ease; graph keys share selection and the context menu', () => {
		const { keysOf, drag, open, click, session } = setup([
			[0, 0, 'bezier'],
			[20, 100],
		]);
		open();
		const [first, second] = keysOf();
		click(screen.getByTestId(`graph-value-key-${first!.id}`));
		// The lane glyph shows the same selection.
		expect(document.querySelector(`button[data-kf-id="${first!.id}"]`)?.getAttribute('aria-pressed')).toBe(
			'true',
		);
		drag(screen.getByTestId(`graph-value-handle-${first!.id}-out`), 0, -15);
		expect(keysOf()[0]!.interpolation).toBe('bezier');
		expect(keysOf()[0]!.easeOut.slope).toBeGreaterThan(1);
		// Shift-click toggles the second key into the selection (no drag).
		act(() => {
			fireEvent.pointerDown(screen.getByTestId(`graph-value-key-${second!.id}`), {
				button: 0,
				shiftKey: true,
			});
		});
		expect(session.getState().selection.keyframes?.keyframeIds).toEqual([first!.id, second!.id]);
		act(() => {
			fireEvent.contextMenu(screen.getByTestId(`graph-value-key-${second!.id}`), { clientX: 5, clientY: 5 });
		});
		act(() => {
			fireEvent.click(within(screen.getByTestId('ec-kf-menu')).getByText('Hold'));
		});
		expect(keysOf().map((k) => k.interpolation)).toEqual(['hold', 'hold']);
	});

	it('the graph height is resizable', () => {
		const { open } = setup();
		open();
		const graphs = screen.getByTestId('graphs-opacity');
		expect(graphs.style.height).toBe('150px');
		act(() => {
			fireEvent.pointerDown(screen.getByTestId('graph-resize-opacity'), { clientY: 100 });
			fireEvent.pointerMove(window, { clientY: 160 });
			fireEvent.pointerUp(window, { clientY: 160 });
		});
		expect(screen.getByTestId('graphs-opacity').style.height).toBe('210px');
	});
});
