import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateExpression, parseEntry } from '../src/panels/properties/controls/ScrubbyNumber.tsx';
import { PropertiesPanel } from '../src/panels/properties/PropertiesPanel.tsx';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

type Anim = { value: number; keyframes: { time: number; value: number }[] };
const scaleOf = (s: ReturnType<typeof makeSession>, id: string) =>
	(clipOf(s, id) as unknown as { transform: { scale: Anim } }).transform.scale;

afterEach(() => cleanup());

describe('Properties panel (S03 §14, S05:PRP)', () => {
	it('shows sequence settings when nothing is selected', () => {
		const session = makeSession();
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		expect(screen.getByTestId('sequence-properties')).toBeTruthy();
		expect(screen.getByTestId('seq-width').textContent).toContain('1920');
	});

	it('AC-INS-1: mixed scales show – and a +10 drag gives 60/90/110 as one undo step', () => {
		const session = makeSession();
		const ids = addSolids(session, [0, 0, 0]);
		session.apply({
			label: 'scales',
			origin: 'user',
			commands: ids.map((id, i) => ({
				type: 'param.set',
				target: ['clip', id, 'transform', 'scale'],
				value: [50, 80, 100][i],
			})) as never,
		});
		act(() => session.select('timeline', ids));
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		const scale = screen.getByTestId('prop-transform.scale');
		expect(scale.textContent).toBe('–%');
		const entries = session.getState().history.entries.length;
		act(() => {
			fireEvent.pointerDown(scale, { clientX: 100, button: 0 });
			// Scale steps 0.1 per px: +10 = 100 px, reached through several moves.
			for (const x of [120, 150, 180, 200]) fireEvent.pointerMove(window, { clientX: x });
			fireEvent.pointerUp(window, { clientX: 200 });
		});
		expect(ids.map((id) => scaleOf(session, id).value)).toEqual([60, 90, 110]);
		expect(session.getState().history.entries.length).toBe(entries + 1);
		act(() => {
			session.undo();
		});
		expect(ids.map((id) => scaleOf(session, id).value)).toEqual([50, 80, 100]);
	});

	it('typed relative entry on a mixed field applies to each clip; absolute sets all', () => {
		const session = makeSession();
		const ids = addSolids(session, [0, 0]);
		session.apply({
			label: 'rot',
			origin: 'user',
			commands: ids.map((id, i) => ({
				type: 'param.set',
				target: ['clip', id, 'transform', 'rotation'],
				value: [10, 20][i],
			})) as never,
		});
		act(() => session.select('timeline', ids));
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		const rot = screen.getByTestId('prop-transform.rotation');
		act(() => {
			fireEvent.pointerDown(rot, { clientX: 10, button: 0 });
			fireEvent.pointerUp(window, { clientX: 10 });
		});
		const input = screen.getByTestId('prop-transform.rotation-input') as HTMLInputElement;
		act(() => {
			fireEvent.change(input, { target: { value: '*2' } });
			fireEvent.keyDown(input, { key: 'Enter' });
		});
		const rotOf = (id: string) =>
			(clipOf(session, id) as unknown as { transform: { rotation: Anim } }).transform.rotation.value;
		expect(ids.map(rotOf)).toEqual([20, 40]);
	});

	it('the ◆ toggle creates a key at the playhead content time and removes it again', () => {
		const session = makeSession();
		const [id] = addSolids(session, [30], 60);
		act(() => {
			session.select('timeline', [id!]);
			session.transport.seek(45);
		});
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		act(() => {
			fireEvent.click(screen.getByTestId('kf-toggle-opacity'));
		});
		const F = 705_600_000 / 30;
		const opacity = () => (clipOf(session, id!) as unknown as { opacity: Anim }).opacity;
		expect(opacity().keyframes.map((k) => [k.time, k.value])).toEqual([[15 * F, 100]]);
		act(() => {
			fireEvent.click(screen.getByTestId('kf-toggle-opacity'));
		});
		expect(opacity().keyframes).toEqual([]);
	});

	it('crop edits create the jasper.crop effect at index 0 on first edit', () => {
		const session = makeSession();
		const [id] = addSolids(session, [0]);
		session.apply({
			label: 'blur',
			origin: 'user',
			commands: [{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.gaussian-blur' }] as never,
		});
		act(() => session.select('timeline', [id!]));
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		const crop = screen.getByText('Crop').closest('section')!;
		act(() => {
			fireEvent.click(within(crop).getByRole('button', { name: /Expand section|Collapse section/ }));
		});
		const left = within(crop).getByTestId('prop-crop.left');
		act(() => {
			fireEvent.keyDown(left, { key: 'ArrowUp', shiftKey: true });
		});
		const fx = (
			clipOf(session, id!) as unknown as { effects: { effectId: string; params: Record<string, Anim> }[] }
		).effects;
		expect(fx.map((e) => e.effectId)).toEqual(['jasper.crop', 'jasper.gaussian-blur']);
		expect(fx[0]!.params.left!.value).toBeCloseTo(1, 6);
	});

	it('parses scrubby arithmetic entries', () => {
		expect(evaluateExpression('2*(3+4)')).toBe(14);
		expect(evaluateExpression('1,5')).toBe(1.5);
		expect(evaluateExpression('2+')).toBeNull();
		expect(parseEntry('+10')!(5)).toBe(15);
		expect(parseEntry('-5')!(5)).toBe(0);
		expect(parseEntry('/2')!(5)).toBe(2.5);
		expect(parseEntry('=-5')!(99)).toBe(-5);
		expect(parseEntry('42')!(1)).toBe(42);
		expect(parseEntry('abc')).toBeNull();
	});
});
