// spec 13 AS-030 / AS-031 / AS-032: multi-clip text rows with mixed values (–, split swatch, Mixed), the stroke list,
// shadow rows with relative scrubs and one History entry, the Text Style section and Effect Controls "N clips" mode.
import type { Clip, EffectInstance } from '@jasper/project';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { PropertiesPanel } from '../src/panels/properties/PropertiesPanel.tsx';
import { selectionHelpers } from '../src/selection/helpers.ts';
import { runSelectionHelper } from '../src/text-styles/actions.ts';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

type TextClip = Extract<Clip, { kind: 'text' }> & { styleId?: string };
const F = 705_600_000 / 30;

beforeEach(() => {
	globalThis.localStorage?.setItem(
		'jasper.inspector.sections',
		JSON.stringify({
			'properties.textShadow': true,
			'properties.textStrokes': true,
			'properties.textStyle': true,
		}),
	);
});
afterEach(() => cleanup());

function texts(n = 3) {
	const session = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: Array.from({ length: n }, (_, i) => ({
			type: 'clip.addText',
			at: i * 40,
			duration: 30,
			track: 'V2',
			content: { text: `w${i}` },
		})) as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const ids = r.created.filter((id) => id.startsWith('clp_'));
	return { session, ids };
}
const text = (s: ReturnType<typeof makeSession>, id: string) => clipOf(s, id) as TextClip;

describe('Properties: many text clips (AS-030)', () => {
	it('mixed values show –, a split swatch and Mixed; a scrub moves each clip in one History entry', () => {
		const { session, ids } = texts(3);
		session.apply({
			label: 'look',
			origin: 'user',
			commands: ids.map((id, i) => ({
				type: 'text.setStyle',
				clipIds: [id],
				patch: {
					strokes: [
						{
							color: [
								[1, 0, 0, 1],
								[0, 1, 0, 1],
								[0, 0, 1, 1],
							][i],
							widthPx: 4 + i,
							position: 'outside',
						},
					],
					shadow: { blurPx: [2, 4, 6][i] },
					align: i === 0 ? 'left' : 'center',
				},
			})) as never,
		});
		act(() => session.select('timeline', ids));
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		// Split swatch for the differing stroke colours.
		const swatch = screen.getByTestId('prop-text.stroke.0.color').closest('label')!;
		expect(swatch.getAttribute('data-mixed')).toBe('true');
		// Mixed select.
		const align = screen.getByTestId('prop-text.align') as HTMLSelectElement;
		expect(align.value).toBe('');
		expect(within(align).getByText('Mixed')).toBeTruthy();
		// Mixed number: –, and a +5 px scrub adds 5 to each clip's blur, one History entry.
		const blur = screen.getByTestId('prop-text.shadowBlur');
		expect(blur.textContent).toContain('–');
		const entries = session.getState().history.entries.length;
		act(() => {
			fireEvent.pointerDown(blur, { clientX: 100, button: 0 });
			for (const x of [102, 104, 106, 110]) fireEvent.pointerMove(window, { clientX: x });
			fireEvent.pointerUp(window, { clientX: 110 });
		});
		expect(ids.map((id) => text(session, id).content.style.shadow!.blurPx)).toEqual([7, 9, 11]);
		const hist = session.getState().history;
		expect(hist.entries.length).toBe(entries + 1);
		expect(hist.entries.at(-1)!.label).toBe('Shadow Blur (3 clips)');
		act(() => {
			session.undo();
		});
		expect(ids.map((id) => text(session, id).content.style.shadow!.blurPx)).toEqual([2, 4, 6]);
	});

	it('typing sets every clip; the stroke list adds and removes strokes on all clips', () => {
		const { session, ids } = texts(3);
		act(() => session.select('timeline', ids));
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		act(() => {
			fireEvent.click(screen.getByTestId('text-stroke-add'));
		});
		expect(ids.every((id) => text(session, id).content.style.strokes.length === 1)).toBe(true);
		expect(session.getState().history.entries.at(-1)!.label).toBe('Add Stroke (3 clips)');
		const width = screen.getByTestId('prop-text.stroke.0.width');
		act(() => {
			fireEvent.pointerDown(width, { clientX: 10, button: 0 });
			fireEvent.pointerUp(window, { clientX: 10 });
		});
		const input = screen.getByTestId('prop-text.stroke.0.width-input');
		act(() => {
			fireEvent.change(input, { target: { value: '11.5' } });
			fireEvent.keyDown(input, { key: 'Enter' });
		});
		expect(ids.map((id) => text(session, id).content.style.strokes[0]!.widthPx)).toEqual([11.5, 11.5, 11.5]);
		expect(session.getState().history.entries.at(-1)!.label).toBe('Stroke 1 Width (3 clips)');
		act(() => {
			fireEvent.click(screen.getByTestId('text-stroke-remove-0'));
		});
		expect(ids.every((id) => text(session, id).content.style.strokes.length === 0)).toBe(true);
	});
});

describe('Text Style section and Select ▸ Same Style (AS-032)', () => {
	it('shows Mixed for differing links, applies a style to all in one step, then Same Style selects them', () => {
		const { session, ids } = texts(3);
		session.apply({
			label: 'style',
			origin: 'user',
			commands: [
				{ type: 'textStyle.create', name: 'Pop', fromClipId: ids[0], ref: '$s' },
				{ type: 'textStyle.apply', styleId: '$s', clipIds: [ids[0]] },
			] as never,
		});
		const styleId = text(session, ids[0]!).styleId!;
		act(() => session.select('timeline', ids));
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		const select = screen.getByTestId('text-style-select') as HTMLSelectElement;
		expect(select.value).toBe('');
		expect(within(select).getByText('Mixed')).toBeTruthy();
		const entries = session.getState().history.entries.length;
		act(() => {
			fireEvent.change(select, { target: { value: styleId } });
		});
		expect(ids.every((id) => text(session, id).styleId === styleId)).toBe(true);
		expect(session.getState().history.entries.length).toBe(entries + 1);
		act(() => session.select('timeline', [ids[1]!]));
		expect(selectionHelpers.get('same-style')).toBeTruthy();
		act(() => {
			expect(runSelectionHelper(session, 'same-style')).toBe(3);
		});
		expect([...session.getState().selection.timeline.clips].sort()).toEqual([...ids].sort());
	});

	it('a deviating linked clip can be reset to its style', () => {
		const { session, ids } = texts(2);
		session.apply({
			label: 'style',
			origin: 'user',
			commands: [
				{ type: 'textStyle.create', name: 'Pop', fromClipId: ids[0], ref: '$s' },
				{ type: 'textStyle.apply', styleId: '$s', clipIds: ids },
				{ type: 'text.setStyle', clipIds: [ids[1]], patch: { sizePx: 33 } },
			] as never,
		});
		act(() => session.select('timeline', ids));
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		expect(screen.getByTestId('text-style-status').textContent).toContain('Font Size');
		act(() => {
			fireEvent.click(screen.getByTestId('text-style-reset'));
		});
		expect(text(session, ids[1]!).content.style.sizePx).toBe(text(session, ids[0]!).content.style.sizePx);
	});
});

describe('Effect Controls "N clips" mode (AS-031)', () => {
	it('lists shared effects, sets every instance in one step and keys relative to each clip In', () => {
		const session = makeSession();
		const ids = addSolids(session, [0, 100, 200], 60);
		session.apply({
			label: 'blur',
			origin: 'user',
			commands: [{ type: 'effect.addMany', clipIds: ids, effectId: 'jasper.gaussian-blur' }] as never,
		});
		act(() => {
			session.select('timeline', ids);
			session.transport.seek(205);
		});
		renderWithSession(session, <EffectControlsPanel instanceId="ec-multi" visible />);
		expect(screen.getByTestId('ec-multi-chip').textContent).toContain('3');
		const rowId = 'effects.jasper.gaussian-blur#0.radius';
		const field = screen.getByTestId(`prop-${rowId}`);
		act(() => {
			fireEvent.pointerDown(field, { clientX: 5, button: 0 });
			fireEvent.pointerUp(window, { clientX: 5 });
		});
		const entries = session.getState().history.entries.length;
		act(() => {
			fireEvent.change(screen.getByTestId(`prop-${rowId}-input`), { target: { value: '7' } });
			fireEvent.keyDown(screen.getByTestId(`prop-${rowId}-input`), { key: 'Enter' });
		});
		const fx = (id: string) => (clipOf(session, id) as unknown as { effects: EffectInstance[] }).effects[0]!;
		expect(ids.map((id) => fx(id).params.radius!.value)).toEqual([7, 7, 7]);
		expect(session.getState().history.entries.length).toBe(entries + 1);
		// Stopwatch at In + 5 frames: a key at frame 5 of every clip (content time 5 frames).
		act(() => {
			fireEvent.click(screen.getByTestId(`stopwatch-${rowId}`));
		});
		expect(ids.map((id) => fx(id).params.radius!.keyframes.map((k) => k.time / F))).toEqual([[5], [5], [5]]);
		// Remove on all.
		act(() => {
			fireEvent.click(screen.getByTestId('ec-multi-remove-jasper.gaussian-blur#0'));
		});
		expect(
			ids.every(
				(id) => (clipOf(session, id) as unknown as { effects: EffectInstance[] }).effects.length === 0,
			),
		).toBe(true);
	});
});
