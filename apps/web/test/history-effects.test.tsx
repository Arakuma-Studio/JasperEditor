import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
	JASPER_EFFECT_MIME,
	readEffectDragPayload,
	writeEffectDragPayload,
} from '../src/panels/effects/drag.ts';
import { EffectsPanel } from '../src/panels/effects/EffectsPanel.tsx';
import { HistoryPanel } from '../src/panels/history/HistoryPanel.tsx';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

afterEach(() => {
	cleanup();
});

const effectIds = (s: ReturnType<typeof makeSession>, id: string) =>
	(clipOf(s, id) as unknown as { effects: { effectId: string }[] }).effects.map((e) => e.effectId);

describe('History panel (S05:HIS-001…003, S01:UND-009)', () => {
	it('lists labelled entries with agent sparkle, jumps on click and clears with confirmation', () => {
		const session = makeSession();
		const [id] = addSolids(session, [0], 30);
		act(() => {
			session.apply({
				label: 'Fade in title',
				origin: { agent: 'editor-assistant' },
				commands: [{ type: 'param.set', target: ['clip', id, 'opacity'], value: 40 }] as never,
			});
			session.apply({
				label: 'Rotation',
				origin: 'user',
				commands: [{ type: 'param.set', target: ['clip', id, 'transform', 'rotation'], value: 15 }] as never,
			});
		});
		renderWithSession(session, <HistoryPanel instanceId="h1" visible />);
		const agentRow = screen.getByTestId('history-row-2');
		expect(agentRow.textContent).toContain('Agent: Fade in title');
		expect(screen.getByTestId('history-row-3').getAttribute('aria-selected')).toBe('true');
		const opacity = () => (clipOf(session, id!) as unknown as { opacity: { value: number } }).opacity.value;
		act(() => {
			fireEvent.click(screen.getByTestId('history-row-1'));
		});
		expect(session.getState().history.index).toBe(1);
		expect(opacity()).toBe(100);
		act(() => {
			fireEvent.click(screen.getByTestId('history-row-3'));
		});
		expect(opacity()).toBe(40);
		act(() => {
			fireEvent.keyDown(screen.getByTestId('history-list'), { key: 'ArrowLeft' });
		});
		expect(session.getState().history.index).toBe(2);
		act(() => {
			fireEvent.click(screen.getByTestId('history-clear'));
		});
		expect(session.getState().history.entries).toHaveLength(3);
		act(() => {
			fireEvent.click(within(screen.getByTestId('inspector-confirm')).getByText('Clear History'));
		});
		expect(session.getState().history.entries).toHaveLength(0);
	});
});

describe('Effects panel (S05:EFX-001…003)', () => {
	it('filters by search and applies by double-click to the selected clips as one undo step', () => {
		const session = makeSession();
		const ids = addSolids(session, [0, 0], 30);
		act(() => session.select('timeline', ids));
		renderWithSession(session, <EffectsPanel instanceId="e1" visible />);
		act(() => {
			fireEvent.change(screen.getByTestId('effects-search'), { target: { value: 'gray' } });
		});
		// The fx catalogue grows (other effects may also match "gray"); the search must find Black & White.
		const rows = [...document.querySelectorAll<HTMLElement>('[data-effect-id]')];
		expect(rows.map((r) => r.dataset.effectId)).toContain('jasper.black-white');
		expect(rows.map((r) => r.dataset.effectId)).not.toContain('jasper.gaussian-blur');
		const entries = session.getState().history.entries.length;
		act(() => {
			fireEvent.doubleClick(rows.find((r) => r.dataset.effectId === 'jasper.black-white')!);
		});
		expect(ids.map((id) => effectIds(session, id))).toEqual([['jasper.black-white'], ['jasper.black-white']]);
		expect(session.getState().history.entries.length).toBe(entries + 1);
	});

	it('writes and reads the effect drag protocol', () => {
		const store = new Map<string, string>();
		const dt = {
			setData: (t: string, v: string) => store.set(t, v),
			getData: (t: string) => store.get(t) ?? '',
			effectAllowed: 'none',
		} as unknown as DataTransfer;
		writeEffectDragPayload(dt, 'jasper.crop');
		expect(JASPER_EFFECT_MIME).toBe('application/x-jasper-effect');
		expect(store.get('application/x-jasper-effect')).toBe(
			'{"type":"jasper/effect","effectId":"jasper.crop"}',
		);
		expect(
			readEffectDragPayload({
				getData: (key: string) =>
					key === JASPER_EFFECT_MIME ? '{"type":"jasper/effect","effectId":"jasper.crop"}' : '',
			} as DataTransfer),
		).toEqual({ type: 'jasper/effect', effectId: 'jasper.crop' });
		expect(readEffectDragPayload({ getData: () => 'garbage' } as unknown as DataTransfer)).toBeNull();
	});
});
