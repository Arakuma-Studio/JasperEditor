// Toasts never cover a modal dialog's actions (wp-note sound-design "final carry-over cleanup", item 2): the e2e
// "Auto Sound Pass… → export" failed because a "Proposed sounds" toast sat on the Export dialog's Export button.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../src/dialog/Dialog.tsx';
import type { Rect } from '../src/menu/placement.ts';
import { type ModalBox, placeToasts } from '../src/toast/placement.ts';
import { ToastHost } from '../src/toast/ToastHost.tsx';
import { ToastStore } from '../src/toast/toast-store.ts';

const VIEW = { width: 1280, height: 720 };
const STACK = { width: 360, height: 140 };
const box = (left: number, top: number, right: number, bottom: number): Rect => ({
	left,
	top,
	right,
	bottom,
});
/** A centred dialog of the given size with a 40 px title bar and a 48 px footer. */
function dialog(width: number, height: number, view = VIEW): ModalBox {
	const left = (view.width - width) / 2;
	const top = (view.height - height) / 2;
	return {
		rect: box(left, top, left + width, top + height),
		header: box(left, top, left + width, top + 40),
		actions: box(left, top + height - 48, left + width, top + height),
	};
}
const overlaps = (a: Rect, b: Rect) =>
	a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
/** The stack's rectangle for a placement. */
function stackRect(p: { bottom: number; maxHeight: number | null }, view = VIEW, stack = STACK): Rect {
	const h = Math.min(stack.height, p.maxHeight ?? Number.POSITIVE_INFINITY);
	return box(
		view.width - 16 - stack.width,
		view.height - p.bottom - h,
		view.width - 16,
		view.height - p.bottom,
	);
}

describe('placeToasts', () => {
	it('stays bottom-right, 16 px from the edges, without a dialog or beside one', () => {
		expect(placeToasts(VIEW, STACK, 16, []).bottom).toBe(16);
		// a small dialog in the middle leaves the corner free
		expect(placeToasts(VIEW, STACK, 16, [dialog(400, 200)]).bottom).toBe(16);
	});

	it('a confirmation over a dialog: clear of both', () => {
		const big = dialog(880, 648);
		const confirm = dialog(400, 160);
		const r = stackRect(placeToasts(VIEW, STACK, 16, [big, confirm]));
		for (const d of [big, confirm]) {
			expect(overlaps(r, d.actions!)).toBe(false);
			expect(overlaps(r, d.header!)).toBe(false);
		}
	});

	it('property: at any window size, dialog size and stack height, no placement covers a title bar or a footer', () => {
		for (let i = 0; i < 2000; i++) {
			const view = { width: 400 + ((i * 97) % 1800), height: 300 + ((i * 53) % 1000) };
			const w = Math.min(view.width - 32, 300 + ((i * 31) % 900));
			const h = Math.min(view.height - 20, 120 + ((i * 17) % 900));
			const stack = { width: Math.min(360, view.width - 32), height: 60 + ((i * 41) % 500) };
			const d = dialog(w, h, view);
			const p = placeToasts(view, stack, 16 + (i % 3) * 24, [d]);
			const r = stackRect(p, view, stack);
			expect(overlaps(r, d.actions!), JSON.stringify({ view, w, h, stack, p })).toBe(false);
			expect(overlaps(r, d.header!), JSON.stringify({ view, w, h, stack, p })).toBe(false);
		}
	});
});

describe('ToastHost with an open Dialog', () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it('interacting with a toast does not dismiss an open dialog', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const store = new ToastStore();
		function Host() {
			const [open, setOpen] = useState(true);
			return (
				<>
					<Dialog
						open={open}
						onOpenChange={setOpen}
						title="Export"
						primaryLabel="Export"
						onPrimary={() => false}
					/>
					<ToastHost store={store} />
				</>
			);
		}
		render(<Host />);
		await act(async () => {
			store.show({ kind: 'info', title: 'Proposed sounds', durationMs: 'sticky' });
		});
		// Radix defers its outside-pointer listener; run that work before interacting.
		await act(async () => vi.runOnlyPendingTimersAsync());
		const toast = screen.getByRole('status', { hidden: true });
		await act(async () => {
			fireEvent.pointerDown(toast, { button: 0, pointerType: 'mouse' });
			fireEvent.pointerUp(toast, { button: 0, pointerType: 'mouse' });
			fireEvent.click(toast);
			fireEvent.focusIn(toast);
			await vi.runOnlyPendingTimersAsync();
		});
		expect(screen.getByRole('dialog')).toBeTruthy();
		// An ordinary outside click closes it: the toast assertion must exercise an armed listener.
		await act(async () => {
			fireEvent.pointerDown(document.body, { button: 0, pointerType: 'mouse' });
			fireEvent.pointerUp(document.body, { button: 0, pointerType: 'mouse' });
			fireEvent.click(document.body);
			await vi.runOnlyPendingTimersAsync();
		});
		expect(screen.queryByRole('dialog')).toBeNull();
	});
});
