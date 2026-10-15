import { RATES } from '@jasper/project';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ColorPicker,
	Dialog,
	DropdownMenu,
	IconButton,
	PanelErrorBoundary,
	type ResolvedMenuItem,
	ScrubbyNumber,
	Select,
	TimecodeField,
	ToastStore,
	TreeList,
	type TreeNode,
} from '../src/index.ts';

afterEach(cleanup);

function drag(el: Element, xs: number[], opts: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
	fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: xs[0], buttons: 1 });
	xs.slice(1).forEach((x) => {
		fireEvent.pointerMove(el, {
			pointerId: 1,
			clientX: x,
			buttons: 1,
			shiftKey: opts.shiftKey,
			ctrlKey: opts.ctrlKey,
		});
	});
	fireEvent.pointerUp(el, { pointerId: 1, clientX: xs.at(-1), button: 0 });
}

describe('ScrubbyNumber (AC-CT-1)', () => {
	it('a drag produces exactly one commit and streams live values', () => {
		const onScrubStart = vi.fn();
		const onScrub = vi.fn();
		const onScrubEnd = vi.fn();
		const onCommit = vi.fn();
		render(
			<ScrubbyNumber
				label="Scale"
				value={100}
				unit="%"
				min={0}
				max={1000}
				onScrubStart={onScrubStart}
				onScrub={onScrub}
				onScrubEnd={onScrubEnd}
				onCommit={onCommit}
			/>,
		);
		const el = screen.getByTestId('scrubby');
		drag(el, [0, 10, 20, 30, 50]);
		expect(onScrubStart).toHaveBeenCalledOnce();
		expect(onScrubEnd).toHaveBeenCalledOnce();
		expect(onScrubEnd.mock.calls[0]?.[0]).toBe(150);
		expect(onScrub.mock.calls.at(-1)?.[0]).toBe(150);
		expect(onCommit).not.toHaveBeenCalled();
	});

	it('Esc during a drag restores the value and does not commit', () => {
		const onScrubEnd = vi.fn();
		const onScrubCancel = vi.fn();
		render(<ScrubbyNumber label="Scale" value={100} onScrubEnd={onScrubEnd} onScrubCancel={onScrubCancel} />);
		const el = screen.getByTestId('scrubby');
		fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 0 });
		fireEvent.pointerMove(el, { pointerId: 1, clientX: 40 });
		expect(el.textContent).toBe('140');
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(el.textContent).toBe('100');
		fireEvent.pointerMove(el, { pointerId: 1, clientX: 80 });
		fireEvent.pointerUp(el, { pointerId: 1, clientX: 80 });
		expect(onScrubCancel).toHaveBeenCalledOnce();
		expect(onScrubEnd).not.toHaveBeenCalled();
		expect(screen.getByTestId('scrubby').textContent).toBe('100');
	});

	it('Shift-drag moves 10× faster and Ctrl-drag 10× slower', () => {
		const onScrubEnd = vi.fn();
		render(<ScrubbyNumber label="Scale" value={100} max={10_000} onScrubEnd={onScrubEnd} />);
		drag(screen.getByTestId('scrubby'), [0, 5, 10], { shiftKey: true });
		expect(onScrubEnd.mock.calls[0]?.[0]).toBe(200);
		drag(screen.getByTestId('scrubby'), [0, 5, 10], { ctrlKey: true });
		expect(onScrubEnd.mock.calls[1]?.[0]).toBe(101);
	});

	it('a click enters edit mode; Enter commits math relative to the value; Esc cancels', () => {
		const onCommit = vi.fn();
		render(<ScrubbyNumber label="Scale" value={100} min={0} max={150} onCommit={onCommit} />);
		const el = screen.getByTestId('scrubby');
		fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 0 });
		fireEvent.pointerUp(el, { pointerId: 1, clientX: 1 });
		const input = screen.getByTestId('scrubby-input') as HTMLInputElement;
		fireEvent.change(input, { target: { value: '*2' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onCommit).toHaveBeenCalledWith(150);
		fireEvent.pointerDown(screen.getByTestId('scrubby'), { pointerId: 1, button: 0, clientX: 0 });
		fireEvent.pointerUp(screen.getByTestId('scrubby'), { pointerId: 1, clientX: 0 });
		fireEvent.change(screen.getByTestId('scrubby-input'), { target: { value: '5' } });
		fireEvent.keyDown(screen.getByTestId('scrubby-input'), { key: 'Escape' });
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it('mixed values show a dash and drags report a delta', () => {
		const onScrubEnd = vi.fn();
		render(<ScrubbyNumber label="Opacity" value={null} onScrubEnd={onScrubEnd} />);
		const el = screen.getByTestId('scrubby');
		expect(el.textContent).toBe('–');
		drag(el, [0, 10, 12]);
		expect(onScrubEnd.mock.calls[0]?.[1]).toBe(12);
	});
});

describe('TimecodeField (AC-TY-1)', () => {
	it('typing 1510 seeks to 00:00:15:10 and +15 moves 15 frames', () => {
		const onCommit = vi.fn();
		const { rerender } = render(<TimecodeField frame={0} rate={RATES.r30} onCommit={onCommit} />);
		expect(screen.getByTestId('timecode-display').textContent).toBe('00:00:00:00');
		fireEvent.click(screen.getByTestId('timecode-display'));
		fireEvent.change(screen.getByTestId('timecode-input'), { target: { value: '1510' } });
		fireEvent.keyDown(screen.getByTestId('timecode-input'), { key: 'Enter' });
		expect(onCommit).toHaveBeenLastCalledWith(15 * 30 + 10);
		rerender(<TimecodeField frame={460} rate={RATES.r30} onCommit={onCommit} />);
		fireEvent.click(screen.getByTestId('timecode-display'));
		fireEvent.change(screen.getByTestId('timecode-input'), { target: { value: '+15' } });
		fireEvent.keyDown(screen.getByTestId('timecode-input'), { key: 'Enter' });
		expect(onCommit).toHaveBeenLastCalledWith(475);
	});

	it('invalid entry keeps the old value and flags the field', () => {
		const onCommit = vi.fn();
		render(<TimecodeField frame={30} rate={RATES.r30} onCommit={onCommit} />);
		fireEvent.click(screen.getByTestId('timecode-display'));
		fireEvent.change(screen.getByTestId('timecode-input'), { target: { value: 'nope' } });
		fireEvent.keyDown(screen.getByTestId('timecode-input'), { key: 'Enter' });
		expect(onCommit).not.toHaveBeenCalled();
		expect(screen.getByTestId('timecode-display').textContent).toBe('00:00:01:00');
		expect(screen.getByTestId('timecode-display').getAttribute('data-invalid')).toBe('true');
	});

	it('drop-frame rates use semicolons and a live source writes without re-rendering', () => {
		let frame = 0;
		const subs = new Set<(f: number) => void>();
		const source = {
			get: () => frame,
			subscribe: (cb: (f: number) => void) => {
				subs.add(cb);
				return () => subs.delete(cb);
			},
		};
		render(<TimecodeField source={source} rate={RATES.r29_97} dropFrame />);
		act(() => {
			frame = 1800;
			for (const s of subs) s(frame);
		});
		expect(screen.getByTestId('timecode-display').textContent).toBe('00;01;00;02');
	});
});

describe('PanelErrorBoundary', () => {
	it.each([false, 0, '', null, undefined])('contains a child that throws %s', (value) => {
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		function Broken(): never {
			throw value;
		}
		try {
			render(
				<PanelErrorBoundary name="Broken">
					<Broken />
				</PanelErrorBoundary>,
			);
			expect(screen.getByTestId('panel-crashed')).toBeTruthy();
		} finally {
			errorLog.mockRestore();
		}
	});

	it('reports clipboard failures without losing the panel error', async () => {
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Clipboard denied'));
		function Broken(): never {
			throw new Error('Panel failed');
		}
		try {
			render(
				<PanelErrorBoundary name="Broken">
					<Broken />
				</PanelErrorBoundary>,
			);
			await act(async () => {
				fireEvent.click(screen.getByText('Copy Details'));
			});
			expect(screen.getByText('Clipboard denied')).toBeTruthy();
			expect(screen.getByText('Panel failed')).toBeTruthy();
		} finally {
			errorLog.mockRestore();
			write.mockRestore();
		}
	});

	it('reloads crashed children with fresh component state', () => {
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		function Panel({ crash = false }: { crash?: boolean }) {
			const [count, setCount] = useState(0);
			if (crash) throw new Error('Panel failed');
			return <button onClick={() => setCount(count + 1)}>Count {count}</button>;
		}
		try {
			const { rerender } = render(
				<PanelErrorBoundary name="Test panel">
					<Panel />
				</PanelErrorBoundary>,
			);
			fireEvent.click(screen.getByText('Count 0'));
			expect(screen.getByText('Count 1')).toBeTruthy();
			rerender(
				<PanelErrorBoundary name="Test panel">
					<Panel crash />
				</PanelErrorBoundary>,
			);
			expect(screen.getByRole('alert').textContent).toContain('Panel failed');
			rerender(
				<PanelErrorBoundary name="Test panel">
					<Panel />
				</PanelErrorBoundary>,
			);
			fireEvent.click(screen.getByText('Reload Panel'));
			expect(screen.queryByRole('alert')).toBeNull();
			expect(screen.getByText('Count 0')).toBeTruthy();
		} finally {
			errorLog.mockRestore();
		}
	});
});

describe('toasts (S05:TS-003/004, AC-TS-1)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('five rapid identical errors merge into one "×5" toast', () => {
		const store = new ToastStore();
		for (let i = 0; i < 5; i++) {
			store.show({ kind: 'error', title: 'Export failed' });
			vi.advanceTimersByTime(300);
		}
		expect(store.getState().toasts).toHaveLength(1);
		expect(store.getState().toasts[0]?.count).toBe(5);
	});

	it('shows at most three and keeps an error with an action until dismissed', () => {
		const store = new ToastStore();
		const sticky = store.show({
			kind: 'error',
			title: 'Disk full',
			actions: [{ label: 'Retry', run: () => {} }],
		});
		for (let i = 0; i < 4; i++) store.show({ kind: 'info', title: `Info ${i}` });
		expect(store.visible().shown).toHaveLength(3);
		expect(store.visible().hidden).toBe(2);
		vi.advanceTimersByTime(60_000);
		expect(store.getState().toasts.map((t) => t.id)).toEqual([sticky]);
		store.dismiss(sticky);
		expect(store.getState().toasts).toHaveLength(0);
		expect(store.getState().log).toHaveLength(5);
	});

	it('dedupeKey replaces in place and progress converts to success', () => {
		const store = new ToastStore();
		const id = store.show({
			kind: 'progress',
			title: 'Exporting',
			dedupeKey: 'job-1',
			progress: { value: 0.1 },
		});
		store.show({ kind: 'progress', title: 'Exporting', dedupeKey: 'job-1', progress: { value: 0.5 } });
		expect(store.getState().toasts).toHaveLength(1);
		expect(store.getState().toasts[0]?.progress?.value).toBe(0.5);
		vi.advanceTimersByTime(60_000);
		expect(store.getState().toasts).toHaveLength(1);
		store.update(id, { kind: 'success', title: 'Export finished' });
		vi.advanceTimersByTime(4100);
		expect(store.getState().toasts).toHaveLength(0);
	});

	it('timers pause while hovered or blurred', () => {
		const store = new ToastStore();
		store.show({ kind: 'info', title: 'Saved' });
		vi.advanceTimersByTime(3000);
		store.setPaused(true);
		vi.advanceTimersByTime(10_000);
		expect(store.getState().toasts).toHaveLength(1);
		store.setPaused(false);
		vi.advanceTimersByTime(1100);
		expect(store.getState().toasts).toHaveLength(0);
	});
});

describe('menus (S05:MN-002, SH-031)', () => {
	it('renders disabled items with their reason and runs enabled ones', async () => {
		const run = vi.fn();
		const items: ResolvedMenuItem[] = [
			{ type: 'item', id: 'history.undo', label: 'Undo Razor', shortcut: 'Ctrl+Z', onSelect: run },
			{ type: 'separator', id: 's1' },
			{
				type: 'item',
				id: 'export.media',
				label: 'Media…',
				disabled: true,
				disabledReason: 'Requires the native engine',
				onSelect: () => {},
			},
			{
				type: 'item',
				id: 'timeline.toggleSnap',
				label: 'Snap in Timeline',
				checked: true,
				onSelect: () => {},
			},
		];
		render(<DropdownMenu trigger={<button type="button">Open</button>} items={items} />);
		const trigger = screen.getByText('Open');
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
		const undo = await screen.findByText('Undo Razor');
		const media = screen.getByText('Media…').closest('[role="menuitem"]');
		expect(media?.getAttribute('data-disabled')).toBe('');
		expect(media?.getAttribute('aria-description')).toBe('Requires the native engine');
		expect(screen.getByText('Ctrl+Z')).toBeTruthy();
		expect(
			screen.getByText('Snap in Timeline').closest('[role="menuitemcheckbox"]')?.getAttribute('aria-checked'),
		).toBe('true');
		fireEvent.click(undo);
		expect(run).toHaveBeenCalledOnce();
	});
});

describe('TreeList (S05:CT-040…045)', () => {
	const many: TreeNode[] = Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}`, label: `Clip ${i}` }));
	it('reports the complete tree size to assistive technology', () => {
		render(
			<TreeList
				label="Items"
				nodes={many}
				expanded={new Set()}
				onExpandedChange={() => {}}
				selected={[]}
				onSelectionChange={() => {}}
			/>,
		);
		const rows = screen.getAllByRole('treeitem');
		expect(rows[0]?.getAttribute('aria-setsize')).toBe('1000');
	});
	it('keyboard: arrows move, Shift extends, → expands', () => {
		const tree: TreeNode[] = [
			{ id: 'bin', label: 'Bin', children: [{ id: 'a', label: 'A' }] },
			{ id: 'b', label: 'B' },
		];
		const onSel = vi.fn();
		const onExp = vi.fn();
		render(
			<TreeList
				label="Items"
				nodes={tree}
				expanded={new Set()}
				onExpandedChange={onExp}
				selected={['bin']}
				primary="bin"
				onSelectionChange={onSel}
			/>,
		);
		const root = screen.getByRole('tree');
		fireEvent.keyDown(root, { key: 'ArrowRight' });
		expect([...(onExp.mock.calls[0]?.[0] ?? [])]).toEqual(['bin']);
		fireEvent.keyDown(root, { key: 'ArrowDown', shiftKey: true });
		expect(onSel).toHaveBeenLastCalledWith(['bin', 'b'], 'b');
	});
});

describe('tooltip and color input contracts', () => {
	it('icon buttons expose the specified shortcut and disabled state', () => {
		render(
			<IconButton icon="tool.razor" label="Razor Tool" shortcut="C" disabled disabledReason="No sequence" />,
		);
		expect(screen.getByLabelText('Razor Tool').getAttribute('title')).toBe('Razor Tool (C)\nNo sequence');
		expect(screen.getByLabelText('Razor Tool').getAttribute('aria-disabled')).toBe('true');
	});
	it('commits valid hex colors and restores invalid input', () => {
		const onChange = vi.fn();
		render(<ColorPicker value={[0, 1, 0, 0.5]} onChange={onChange} />);
		const input = screen.getByRole('textbox', { name: 'Hex color' }) as HTMLInputElement;
		expect(input.value).toBe('#00ff0080');
		fireEvent.change(input, { target: { value: '#ff0000' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onChange).toHaveBeenCalledWith([1, 0, 0, 1], { final: true });
		fireEvent.change(input, { target: { value: 'zzz' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(input.value).toBe('#ff0000');
	});
});

describe('Dialog Enter key (S05)', () => {
	it('reports failed primary actions and keeps the dialog open', async () => {
		const close = vi.fn();
		render(
			<Dialog
				open
				onOpenChange={close}
				title="Save"
				primaryLabel="Save"
				onPrimary={async () => {
					throw new Error('Disk full');
				}}
			/>,
		);
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		});
		expect(screen.getByRole('alert').textContent).toBe('Disk full');
		expect(close).not.toHaveBeenCalled();
	});

	it('Enter runs the primary action, but not when it picks an option of a Select inside the dialog', async () => {
		const onPrimary = vi.fn(() => false);
		function Host() {
			const [v, setV] = useState('a');
			return (
				<Dialog open onOpenChange={() => {}} title="T" primaryLabel="Go" onPrimary={onPrimary}>
					<Select
						label="Pick"
						value={v}
						onValueChange={setV}
						options={[
							{ value: 'a', label: 'Alpha' },
							{ value: 'b', label: 'Beta' },
						]}
					/>
					<input aria-label="field" />
				</Dialog>
			);
		}
		render(<Host />);
		const trigger = screen.getByRole('combobox', { name: 'Pick' });
		await act(async () => {
			fireEvent.keyDown(trigger, { key: 'Enter' });
		});
		const option = await screen.findByRole('option', { name: 'Beta' });
		await act(async () => {
			fireEvent.keyDown(option, { key: 'Enter' });
		});
		expect(onPrimary).not.toHaveBeenCalled();
		expect(screen.getByRole('combobox', { name: 'Pick' }).textContent).toContain('Beta');
		await act(async () => {
			fireEvent.keyDown(screen.getByRole('textbox', { name: 'field' }), { key: 'Enter' });
		});
		expect(onPrimary).toHaveBeenCalledTimes(1);
	});
});

describe('Dialog is modal for assistive tech and keyboard dispatchers (S05)', () => {
	it('sets aria-modal on the dialog element', () => {
		render(
			<Dialog open onOpenChange={() => {}} title="M" primaryLabel="Go" onPrimary={() => false}>
				<span>body</span>
			</Dialog>,
		);
		const el = screen.getByRole('dialog');
		expect(el.getAttribute('aria-modal')).toBe('true');
	});
});
