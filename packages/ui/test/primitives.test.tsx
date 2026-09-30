import { RATES } from '@jasper/project';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	CURSORS,
	clampValue,
	cursorCss,
	cursorSvg,
	customGlyphIds,
	DropdownMenu,
	evaluateEntry,
	ForcedCursorLayer,
	flattenTree,
	forceCursor,
	getForcedCursor,
	IconButton,
	parseHex,
	type ResolvedMenuItem,
	rgbaToHex,
	ScrubbyNumber,
	scrubDelta,
	TimecodeField,
	ToastStore,
	TooltipHost,
	TreeList,
	type TreeNode,
} from '../src/index.ts';

afterEach(() => {
	document.body.innerHTML = '';
});

function drag(el: Element, xs: number[], opts: { shiftKey?: boolean; escapeAt?: number } = {}) {
	fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: xs[0], buttons: 1 });
	xs.slice(1).forEach((x, i) => {
		if (opts.escapeAt === i) fireEvent.keyDown(window, { key: 'Escape' });
		fireEvent.pointerMove(el, { pointerId: 1, clientX: x, buttons: 1, shiftKey: opts.shiftKey });
	});
	fireEvent.pointerUp(el, { pointerId: 1, clientX: xs.at(-1), button: 0 });
}

describe('scrubby math (S05:CT-021/022/025)', () => {
	it('evaluates relative math and plain numbers', () => {
		expect(evaluateEntry('+10', 100)).toBe(110);
		expect(evaluateEntry('-5', 100)).toBe(95);
		expect(evaluateEntry('*2', 100)).toBe(200);
		expect(evaluateEntry('/2', 100)).toBe(50);
		expect(evaluateEntry('42.5', 100)).toBe(42.5);
		expect(evaluateEntry('=-5', 100)).toBe(-5);
		expect(evaluateEntry('/0', 100)).toBeNull();
		expect(evaluateEntry('abc', 100)).toBeNull();
	});
	it('applies step modifiers and clamps', () => {
		expect(scrubDelta(5, 1, {})).toBe(5);
		expect(scrubDelta(5, 1, { shiftKey: true })).toBe(50);
		expect(scrubDelta(5, 1, { ctrlKey: true })).toBeCloseTo(0.5);
		expect(clampValue(1234.567, { min: 0, max: 1000, precision: 1 })).toBe(1000);
		expect(clampValue(12.345, { precision: 1 })).toBe(12.3);
	});
});

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
		expect(getForcedCursor()).toBeNull();
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

	it('Shift-drag moves 10× faster', () => {
		const onScrubEnd = vi.fn();
		render(<ScrubbyNumber label="Scale" value={100} max={10_000} onScrubEnd={onScrubEnd} />);
		drag(screen.getByTestId('scrubby'), [0, 5, 10], { shiftKey: true });
		expect(onScrubEnd.mock.calls[0]?.[0]).toBe(200);
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
		expect(screen.getByTestId('timecode-display').className).toContain('pr-tabular');
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

describe('toasts (S05:TS-003/004, AC-TS-1)', () => {
	function clock() {
		let now = 0;
		const timers: { at: number; fn: () => void; id: number }[] = [];
		let id = 0;
		return {
			timers: {
				now: () => now,
				setTimeout: (fn: () => void, ms: number) => {
					timers.push({ at: now + ms, fn, id: ++id });
					return id;
				},
				clearTimeout: (h: unknown) => {
					const i = timers.findIndex((t) => t.id === h);
					if (i >= 0) timers.splice(i, 1);
				},
			},
			advance(ms: number) {
				now += ms;
				for (const t of [...timers].sort((a, b) => a.at - b.at)) {
					if (t.at <= now && timers.includes(t)) {
						timers.splice(timers.indexOf(t), 1);
						t.fn();
					}
				}
			},
		};
	}

	it('five rapid identical errors merge into one "×5" toast', () => {
		const c = clock();
		const store = new ToastStore(c.timers);
		for (let i = 0; i < 5; i++) {
			store.show({ kind: 'error', title: 'Export failed' });
			c.advance(300);
		}
		expect(store.getState().toasts).toHaveLength(1);
		expect(store.getState().toasts[0]?.count).toBe(5);
	});

	it('shows at most three and keeps an error with an action until dismissed', () => {
		const c = clock();
		const store = new ToastStore(c.timers);
		const sticky = store.show({
			kind: 'error',
			title: 'Disk full',
			actions: [{ label: 'Retry', run: () => {} }],
		});
		for (let i = 0; i < 4; i++) store.show({ kind: 'info', title: `Info ${i}` });
		expect(store.visible().shown).toHaveLength(3);
		expect(store.visible().hidden).toBe(2);
		c.advance(60_000);
		expect(store.getState().toasts.map((t) => t.id)).toEqual([sticky]);
		store.dismiss(sticky);
		expect(store.getState().toasts).toHaveLength(0);
		expect(store.getState().log).toHaveLength(5);
	});

	it('dedupeKey replaces in place and progress converts to success', () => {
		const c = clock();
		const store = new ToastStore(c.timers);
		const id = store.show({
			kind: 'progress',
			title: 'Exporting',
			dedupeKey: 'job-1',
			progress: { value: 0.1 },
		});
		store.show({ kind: 'progress', title: 'Exporting', dedupeKey: 'job-1', progress: { value: 0.5 } });
		expect(store.getState().toasts).toHaveLength(1);
		expect(store.getState().toasts[0]?.progress?.value).toBe(0.5);
		c.advance(60_000);
		expect(store.getState().toasts).toHaveLength(1);
		store.update(id, { kind: 'success', title: 'Export finished' });
		c.advance(4100);
		expect(store.getState().toasts).toHaveLength(0);
	});

	it('timers pause while hovered or blurred', () => {
		const c = clock();
		const store = new ToastStore(c.timers);
		store.show({ kind: 'info', title: 'Saved' });
		c.advance(3000);
		store.setPaused(true);
		c.advance(10_000);
		expect(store.getState().toasts).toHaveLength(1);
		store.setPaused(false);
		c.advance(1100);
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
	it('virtualizes long lists but keeps ARIA sizes', () => {
		render(
			<div style={{ height: 220 }}>
				<TreeList
					label="Items"
					nodes={many}
					expanded={new Set()}
					onExpandedChange={() => {}}
					selected={[]}
					onSelectionChange={() => {}}
				/>
			</div>,
		);
		const rows = screen.getAllByRole('treeitem');
		expect(rows.length).toBeLessThan(100);
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
		expect(flattenTree(tree, new Set(['bin'])).map((r) => r.node.id)).toEqual(['bin', 'a', 'b']);
	});
});

describe('icons, cursors and tooltips (S05:IC-004/010/011, TT-002)', () => {
	it('ships the custom NLE glyph inventory', () => {
		const ids = customGlyphIds();
		for (const id of [
			'tool.ripple',
			'tool.rolling',
			'tool.slip',
			'tool.slide',
			'tool.rateStretch',
			'tool.trackSelectBackward',
			'transport.markIn',
			'transport.insert',
			'transport.overwrite',
			'transport.lift',
			'transport.extract',
			'track.sourcePatch',
			'track.target',
			'track.keyframeAdd',
			'engine.remotion',
			'engine.fframes',
			'engine.native',
			'fx.badge',
		])
			expect(ids).toContain(id);
	});
	it('builds SVG cursors with hotspots and forces them on the window', () => {
		for (const id of Object.keys(CURSORS) as (keyof typeof CURSORS)[]) {
			expect(cursorSvg(id)).toContain('<svg');
			expect(cursorCss(id)).toMatch(/url\("data:image\/svg\+xml,.+"\)|image-set/);
		}
		render(<ForcedCursorLayer />);
		let release: () => void = () => {};
		act(() => {
			release = forceCursor('trimIn');
		});
		expect(screen.getByTestId('forced-cursor')).toBeTruthy();
		act(() => release());
		expect(screen.queryByTestId('forced-cursor')).toBeNull();
	});
	it('icon buttons fall back to a title tooltip and use Radix under a TooltipHost', () => {
		render(<IconButton icon="tool.razor" label="Razor Tool" shortcut="C" />);
		expect(screen.getByLabelText('Razor Tool').getAttribute('title')).toBe('Razor Tool (C)');
		document.body.innerHTML = '';
		render(
			<TooltipHost>
				<IconButton icon="tool.razor" label="Razor Tool" shortcut="C" disabled disabledReason="No sequence" />
			</TooltipHost>,
		);
		const b = screen.getByLabelText('Razor Tool');
		expect(b.getAttribute('title')).toBeNull();
		expect(b.getAttribute('aria-disabled')).toBe('true');
	});
	it('parses and prints hex colors', () => {
		expect(parseHex('#ff0000')).toEqual([1, 0, 0, 1]);
		expect(rgbaToHex([0, 1, 0, 0.5], true)).toBe('#00ff0080');
		expect(parseHex('zzz')).toBeNull();
	});
});
