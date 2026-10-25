// keyframe-sides: Premiere's Temporal Interpolation menu (Ease In / Ease Out set one side), the key glyph halves,
// the graph editor's per-side handles and the timeline lane menu helpers (docs/wp-notes/keyframe-sides.md).
import type { Clip, Keyframe } from '@jasper/project';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { planEaseEdit, sideHasHandle } from '../src/panels/effectControls/graph.ts';
import {
	commonPreset,
	glyphHalves,
	interpolationCommand,
	presetOf,
} from '../src/panels/effectControls/lib.ts';
import { clipKeysById } from '../src/panels/timeline/model/keyframe-lane.ts';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

type Key = Keyframe<number>;
const EASY = { influence: 1 / 3, slope: 0 };
const LIN = { influence: 1 / 3, slope: 1 };
const k = (interpolation: Key['interpolation'], extra: Partial<Key> = {}): Key => ({
	id: 'k',
	time: 0,
	value: 0,
	interpolation,
	easeIn: { ...LIN },
	easeOut: { ...LIN },
	...extra,
});

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
	it('Ease In sets only the incoming side of the key; the menu checks it; the glyph shows both halves; undo', () => {
		const { session, keys, menuOn } = setup();
		const [a, b] = keys();
		menuOn(b!.id);
		const menu = screen.getByTestId('ec-kf-menu');
		expect(within(menu).getByText('Temporal Interpolation')).toBeTruthy();
		expect(menu.querySelector('[data-preset="linear"]')!.getAttribute('aria-checked')).toBe('true');
		act(() => {
			fireEvent.click(within(menu).getByText('Ease In'));
		});
		expect(keys()[0]).toEqual(a);
		expect(keys()[1]).toMatchObject({ interpolation: 'linear', inInterpolation: 'bezier', easeIn: EASY });
		expect(document.querySelector(`button[data-kf-id="${b!.id}"]`)!.getAttribute('data-kf-shape')).toBe(
			'bezier/linear',
		);
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
	});
});

describe('menu and graph helpers (keyframe-sides)', () => {
	it('interpolationCommand: Ease In / Ease Out / Hold set one side', () => {
		expect(interpolationCommand(['a'], 'ease-in')).toMatchObject({
			side: 'in',
			interpolation: 'bezier',
			easeIn: EASY,
		});
		expect(interpolationCommand(['a'], 'ease-out')).toMatchObject({
			side: 'out',
			interpolation: 'bezier',
			easeOut: EASY,
		});
		expect(interpolationCommand(['a'], 'hold')).toMatchObject({ side: 'out', interpolation: 'hold' });
		expect(interpolationCommand(['a'], 'bezier')).not.toHaveProperty('side');
	});

	it('presetOf / commonPreset: the checked item', () => {
		expect(presetOf(k('linear'))).toBe('linear');
		expect(presetOf(k('linear', { inInterpolation: 'bezier', easeIn: EASY }))).toBe('ease-in');
		expect(presetOf(k('bezier', { inInterpolation: 'linear', easeOut: EASY }))).toBe('ease-out');
		expect(presetOf(k('bezier', { easeIn: EASY, easeOut: EASY }))).toBe('easy-ease');
		expect(presetOf(k('hold', { inInterpolation: 'bezier' }))).toBe('hold');
		expect(presetOf(k('auto-bezier', { inInterpolation: 'auto-bezier' }))).toBe('auto-bezier');
		expect(
			presetOf(k('linear', { inInterpolation: 'bezier', easeIn: { influence: 0.7, slope: 0 } })),
		).toBeNull();
		expect(commonPreset([k('linear'), k('linear', { inInterpolation: 'linear' })])).toBe('linear');
		expect(commonPreset([k('linear'), k('bezier')])).toBeNull();
		expect(commonPreset([])).toBeNull();
	});

	it('glyph halves and handles follow each side', () => {
		const kfs = [
			k('hold'),
			k('linear', { inInterpolation: 'bezier' }),
			k('linear', { inInterpolation: 'bezier' }),
		];
		expect(glyphHalves(kfs, 1)).toEqual({ left: 'hold', right: 'linear' });
		expect(glyphHalves(kfs, 2)).toEqual({ left: 'bezier', right: 'linear' });
		expect(sideHasHandle(kfs[2]!, 'in')).toBe(true);
		expect(sideHasHandle(kfs[2]!, 'out')).toBe(false);
		expect(sideHasHandle(k('continuous-bezier'), 'in')).toBe(true);
	});

	it('planEaseEdit edits only the dragged side (Continuous keeps the link unless Alt)', () => {
		const kfs = [k('linear', { id: 'a' }), k('linear', { id: 'b', time: 10 })];
		expect(planEaseEdit(kfs, 1, 'in', EASY, false)).toEqual([
			{ type: 'keyframe.update', keyframeId: 'b', interpolation: 'bezier', side: 'in', easeIn: EASY },
		]);
		const cont = [
			k('linear', { id: 'a' }),
			k('continuous-bezier', { id: 'b', time: 10 }),
			k('linear', { id: 'c', time: 20 }),
		];
		expect(planEaseEdit(cont, 1, 'out', EASY, false)).toEqual([
			{ type: 'keyframe.update', keyframeId: 'b', interpolation: 'continuous-bezier', easeOut: EASY },
		]);
		expect(planEaseEdit(cont, 1, 'out', EASY, true)[0]).toMatchObject({
			interpolation: 'bezier',
			side: 'out',
		});
	});

	it('clipKeysById finds keys anywhere in a clip (the timeline key menu)', () => {
		const clip = {
			id: 'c',
			opacity: { value: 0, keyframes: [k('linear', { id: 'k1' })] },
			effects: [
				{ params: { radius: { value: 0, keyframes: [k('bezier', { id: 'k2' }), k('hold', { id: 'k3' })] } } },
			],
		} as unknown as Clip;
		expect(clipKeysById(clip, new Set(['k1', 'k3'])).map((x) => x.id)).toEqual(['k1', 'k3']);
	});
});
