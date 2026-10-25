// crop-order (schema v8): Effect Controls pins a Crop only at the top of the stack; the pinned Crop is an effect header
// (drag it, drop on it), a crop placed after other effects is listed at its stack position, and reordering is one
// undoable step that the renderers follow (they apply the stored order).
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => cleanup());

type Fx = { id: string; effectId: string; params: Record<string, { value: unknown }> };
const stack = (s: ReturnType<typeof makeSession>, id: string) =>
	(clipOf(s, id) as unknown as { effects: Fx[] }).effects;

function setup(effects: string[]) {
	const session = makeSession();
	const [id] = addSolids(session, [0], 60);
	act(() => {
		session.apply({
			label: 'fx',
			origin: 'user',
			commands: effects.map((effectId) => ({
				type: 'effect.add',
				target: { clipId: id },
				effectId,
			})) as never,
		});
		session.select('timeline', [id!]);
		session.transport.seek(10);
	});
	renderWithSession(session, <EffectControlsPanel instanceId="ec-crop" visible />);
	return { session, id: id! };
}

const section = (id: string) => document.querySelector(`[data-ec-section="${id}"]`);
const header = (id: string) => document.querySelector<HTMLElement>(`[data-ec-header="${id}"]`)!;

function drag(from: HTMLElement, to: HTMLElement) {
	const data: Record<string, string> = {};
	const dt = {
		types: [] as string[],
		setData: (t: string, v: string) => {
			data[t] = v;
			dt.types.push(t);
		},
		getData: (t: string) => data[t] ?? '',
		effectAllowed: 'none',
		dropEffect: 'none',
	};
	act(() => {
		fireEvent.dragStart(from, { dataTransfer: dt });
		fireEvent.dragOver(to, { dataTransfer: dt });
		fireEvent.drop(to, { dataTransfer: dt });
	});
}

describe('Crop in the Effect Controls stack', () => {
	it('pins a crop at the top of the stack as a draggable effect header; dropping an effect on it puts that effect first', () => {
		const { session, id } = setup(['jasper.crop', 'jasper.gaussian-blur']);
		const [, blur] = stack(session, id);
		const pinned = header(`${id}:crop`);
		// Drag the blur onto the pinned Crop: Blur → Crop.
		drag(header(`${id}:fx:${blur!.id}`), pinned);
		expect(stack(session, id).map((e) => e.effectId)).toEqual(['jasper.gaussian-blur', 'jasper.crop']);
		// The crop is no longer pinned: listed after the blur, at its stack position; no defaults section either.
		expect(section(`${id}:crop`)).toBeNull();
		// One undo step restores Crop → Blur and the pinned section.
		act(() => void session.undo());
		expect(stack(session, id).map((e) => e.effectId)).toEqual(['jasper.crop', 'jasper.gaussian-blur']);
		expect(section(`${id}:crop`)).not.toBeNull();
		act(() => void session.redo());
		expect(stack(session, id).map((e) => e.effectId)).toEqual(['jasper.gaussian-blur', 'jasper.crop']);
	});

	it('drags the pinned Crop down the stack', () => {
		const { session, id } = setup(['jasper.crop', 'jasper.flip-horizontal', 'jasper.gaussian-blur']);
		drag(header(`${id}:crop`), screen.getByTestId('ec-drop-end'));
		expect(stack(session, id).map((e) => e.effectId)).toEqual([
			'jasper.flip-horizontal',
			'jasper.gaussian-blur',
			'jasper.crop',
		]);
	});

	it('edits an existing later Crop without adding a second crop', () => {
		const { session, id } = setup(['jasper.flip-horizontal', 'jasper.crop']);
		const [, crop] = stack(session, id);
		const controls = section(`${id}:fx:${crop!.id}`) as HTMLElement;
		act(() =>
			fireEvent.keyDown(within(controls).getByRole('spinbutton', { name: 'Left' }), {
				key: 'ArrowUp',
				shiftKey: true,
			}),
		);
		expect(stack(session, id).map((e) => e.effectId)).toEqual(['jasper.flip-horizontal', 'jasper.crop']);
		expect(stack(session, id)[1]!.params.left!.value).toBe(1);
	});
});
