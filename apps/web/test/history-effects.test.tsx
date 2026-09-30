import { EngineClient } from '@jasper/engine-client';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandContext, getCommand, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { effectTree, readEffectDragPayload, writeEffectDragPayload } from '../src/panels/effects/drag.ts';
import { EffectsPanel } from '../src/panels/effects/EffectsPanel.tsx';
import { entryKind, HistoryPanel, relativeTime } from '../src/panels/history/HistoryPanel.tsx';
import { inspectorFocus } from '../src/panels/properties/lib/focus.ts';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

afterEach(() => {
	cleanup();
	inspectorFocus.reset();
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
		expect(screen.getByTestId('history-row-0').textContent).toContain('Open');
		const agentRow = screen.getByTestId('history-row-2');
		expect(agentRow.textContent).toContain('Agent: Fade in title');
		expect(agentRow.querySelector('[data-kind="agent"]')).toBeTruthy();
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

	it('formats relative times and classifies entries', () => {
		expect(relativeTime(0, 2000)).toBe('just now');
		expect(relativeTime(0, 42_000)).toBe('42 s ago');
		expect(relativeTime(0, 5 * 60_000)).toBe('5 min ago');
		expect(entryKind({ label: 'Apply Gaussian Blur', origin: 'user' })).toBe('effect');
		expect(entryKind({ label: 'Agent: x', origin: { agent: 'a' } })).toBe('agent');
		expect(entryKind({ label: 'Razor', origin: 'user' })).toBe('edit');
	});
});

describe('Effects panel (S05:EFX-001…003)', () => {
	it('filters by search and applies by double-click to the selected clips as one undo step', () => {
		const session = makeSession();
		const ids = addSolids(session, [0, 0], 30);
		act(() => session.select('timeline', ids));
		renderWithSession(session, <EffectsPanel instanceId="e1" visible />);
		expect(document.querySelectorAll('[data-effect-id]')).toHaveLength(7);
		act(() => {
			fireEvent.change(screen.getByTestId('effects-search'), { target: { value: 'gray' } });
		});
		const rows = document.querySelectorAll<HTMLElement>('[data-effect-id]');
		expect([...rows].map((r) => r.dataset.effectId)).toEqual(['jasper.black-white']);
		const entries = session.getState().history.entries.length;
		act(() => {
			fireEvent.doubleClick(rows[0]!);
		});
		expect(ids.map((id) => effectIds(session, id))).toEqual([['jasper.black-white'], ['jasper.black-white']]);
		expect(session.getState().history.entries.length).toBe(entries + 1);
		expect(session.getState().history.entries.at(-1)!.label).toBe('Apply Black & White (2 clips)');
		expect(screen.getByTestId('effects-status').textContent).toContain('2 clips');
	});

	it('writes and reads the jasper/effect drag payload; builds the category tree', () => {
		const store = new Map<string, string>();
		const dt = {
			setData: (t: string, v: string) => store.set(t, v),
			getData: (t: string) => store.get(t) ?? '',
			effectAllowed: 'none',
		} as unknown as DataTransfer;
		writeEffectDragPayload(dt, 'jasper.crop');
		expect(readEffectDragPayload(dt)).toEqual({ type: 'jasper/effect', effectId: 'jasper.crop' });
		const session = makeSession();
		const tree = effectTree(session.ctx.registries.effects, { query: '', realtime: false, native: true });
		expect(tree[0]!.medium).toBe('Video Effects');
		expect(tree[0]!.categories.map((c) => c.category)).toEqual([
			'Blur & Sharpen',
			'Color Correction',
			'Transform',
		]);
	});
});

describe('inspector UI commands', () => {
	const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });
	it('applies effects, toggles the focused stopwatch, navigates keys and steps history', async () => {
		registerAllCommands();
		const session = makeSession();
		const [id] = addSolids(session, [10], 40);
		session.select('timeline', [id!]);
		const ctx = createCommandContext({ engine, session });
		expect((await runCommand('inspector.applyEffect', ctx, { effectId: 'jasper.hue-saturation' })).ran).toBe(
			true,
		);
		expect(effectIds(session, id!)).toEqual(['jasper.hue-saturation']);
		inspectorFocus.set({ source: 'properties', clipIds: [id!], rowId: 'opacity' });
		ctx.transport.seek(20);
		await runCommand('inspector.toggleStopwatch', ctx);
		ctx.transport.seek(30);
		await runCommand('inspector.addRemoveKeyframe', ctx);
		const keys = () =>
			(clipOf(session, id!) as unknown as { opacity: { keyframes: { time: number }[] } }).opacity.keyframes;
		expect(keys()).toHaveLength(2);
		ctx.transport.seek(0);
		await runCommand('inspector.nextKeyframe', ctx);
		expect(ctx.transport.getState().frame).toBe(20);
		await runCommand('inspector.nextKeyframe', ctx);
		expect(ctx.transport.getState().frame).toBe(30);
		await runCommand('inspector.prevKeyframe', ctx);
		expect(ctx.transport.getState().frame).toBe(20);
		await runCommand('inspector.toggleStopwatch', ctx);
		expect(keys()).toHaveLength(0);
		const before = session.getState().history.index;
		await runCommand('history.stepBackward', ctx);
		expect(session.getState().history.index).toBe(before - 1);
		await runCommand('history.stepForward', ctx);
		expect(session.getState().history.index).toBe(before);
		inspectorFocus.set({
			effectInstanceId: (clipOf(session, id!) as unknown as { effects: { id: string }[] }).effects[0]!.id,
		});
		await runCommand('effectControls.removeEffect', ctx);
		expect(effectIds(session, id!)).toEqual([]);
		expect(getCommand('history.clear')).toBeTruthy();
		await runCommand('history.clear', ctx, { confirmed: true });
		expect(session.getState().history.entries).toHaveLength(0);
	});
});
