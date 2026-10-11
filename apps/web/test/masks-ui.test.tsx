import { type Mask, rectPath } from '@jasper/project';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { maskSpace, offsetPolyline, outwardDistance, segmentAt } from '../src/masks/geometry.ts';
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

describe('Effect Controls masks', { timeout: 60_000 }, () => {
	it('creates ellipse / polygon masks under Opacity, edits mode / inverted / feather, keys the path, deletes', () => {
		const { session, id } = setup();
		act(() => {
			fireEvent.click(screen.getByTestId(`mask-ellipse-${id}:opacity`));
		});
		act(() => {
			fireEvent.click(screen.getByTestId(`mask-polygon-${id}:opacity`));
		});
		const ms = masksOf(session, id);
		expect(ms.map((m) => [m.name, m.shape])).toEqual([
			['Mask (1)', 'ellipse'],
			['Mask (2)', 'polygon'],
		]);
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
		expect(screen.getByTestId(`prop-masks.${m1}.path`).textContent).toBe('4 vertices');
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

describe('monitor mask geometry', () => {
	// A 200×100 layer at (100, 50), scale 1, on a view of scale 2 at the origin.
	const layer = {
		props: {
			box: { width: 200, height: 100 },
			projective: null,
			matrix: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 },
		},
	} as never;
	const view = { scale: 2, x: 0, y: 0 };

	it('maps normalised points to the screen and back', () => {
		const sp = maskSpace(layer, view)!;
		expect(sp.toScreen([0.5, 0.5])).toEqual([400, 200]);
		expect(sp.fromScreen([400, 200])).toEqual([0.5, 0.5]);
		expect(sp.scale).toBeCloseTo(2, 9);
	});

	it('signed outward distance, segment hits, offsets', () => {
		const sp = maskSpace(layer, view)!;
		const path = rectPath(0.25, 0.25, 0.75, 0.75); // layer px 50..150 × 25..75
		expect(outwardDistance(path, sp, [0.5, 0.1])).toBeCloseTo(15, 6); // 15 layer px above the top edge
		expect(outwardDistance(path, sp, [0.5, 0.5])).toBeCloseTo(-25, 6);
		const s = sp.toScreen([0.5, 0.25]);
		expect(segmentAt(path, sp, s, 4)).toMatchObject({ segment: 0 });
		const ring = offsetPolyline(
			[
				[0, 0],
				[10, 0],
				[10, 10],
				[0, 10],
			],
			2,
		);
		expect(ring[0]![1]).toBeLessThan(0); // outwards (up) for the top edge
	});
});
