// keyframes-blend in Effect Controls (happy-dom): Opacity ▸ Blend Mode lists every mode grouped like Premiere's menu
// (Normal, Subtractive, Additive, Complex, Difference, HSL, then the utility modes) and sets it as one undo entry;
// right-click a key ▸ Rove Across Time (checkable, also from the graph editor's keys), drawn as a dot in the lanes.
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
