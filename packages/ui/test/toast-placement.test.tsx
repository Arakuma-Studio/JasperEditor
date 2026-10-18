// Toasts never cover a modal dialog's actions (wp-note sound-design "final carry-over cleanup", item 2): the e2e
// "Auto Sound Pass… → export" failed because a "Proposed sounds" toast sat on the Export dialog's Export button.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
		expect(placeToasts(VIEW, STACK, 16, [])).toEqual({ bottom: 16, maxHeight: null, avoided: 'none' });
		// a small dialog in the middle leaves the corner free
		expect(placeToasts(VIEW, STACK, 16, [dialog(400, 200)]).avoided).toBe('none');
		// no toasts: nothing to place
		expect(placeToasts(VIEW, { width: 0, height: 0 }, 16, [dialog(1200, 700)]).avoided).toBe('none');
	});

	it('moves above a dialog whose footer it would cover, when there is room above it', () => {
		const d = dialog(880, 400);
		const p = placeToasts(VIEW, STACK, 16, [d]);
		expect(p.avoided).toBe('dialog');
		expect(p.maxHeight).toBeNull();
		const r = stackRect(p);
		expect(r.bottom).toBe(d.rect.top - 8);
		expect(r.top).toBeGreaterThanOrEqual(8);
		expect(overlaps(r, d.rect)).toBe(false);
	});

	it('a tall dialog (the Export dialog at 1280 × 720): between its title bar and its footer, never on either', () => {
		const d = dialog(880, 648);
		const p = placeToasts(VIEW, STACK, 16, [d]);
		expect(p.avoided).toBe('actions');
		const r = stackRect(p);
		expect(overlaps(r, d.actions!)).toBe(false);
		expect(overlaps(r, d.header!)).toBe(false);
		expect(r.bottom).toBe(d.actions!.top - 8);
	});

	it('caps the stack when the room between title bar and footer is smaller than it', () => {
		const d = dialog(880, 240 + 88, { width: 1280, height: 330 });
		const view = { width: 1280, height: 330 };
		const p = placeToasts(view, { width: 360, height: 400 }, 16, [d]);
		expect(p.avoided).toBe('actions');
		expect(p.maxHeight).toBe(d.actions!.top - 8 - (d.header!.bottom + 8));
		const r = stackRect(p, view, { width: 360, height: 400 });
		expect(overlaps(r, d.actions!)).toBe(false);
		expect(overlaps(r, d.header!)).toBe(false);
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
	let root: Root | null = null;
	let host: HTMLDivElement | null = null;
	const saved = {
		rect: Element.prototype.getBoundingClientRect,
		scroll: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'),
	};
	afterEach(async () => {
		if (root) await act(async () => root!.unmount());
		root = null;
		host?.remove();
		document.body.innerHTML = '';
		Element.prototype.getBoundingClientRect = saved.rect;
		if (saved.scroll) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', saved.scroll);
	});

	it('the toast moves off the Export button while the dialog is open, and back when it closes', async () => {
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEW.width });
		Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEW.height });
		const d = dialog(880, 648);
		const rectFor = (el: Element): Rect | null => {
			if (el.getAttribute('data-testid') === 'export-dialog') return d.rect;
			if (el.hasAttribute('data-dialog-header') && el.closest('[data-testid="export-dialog"]'))
				return d.header;
			if (el.hasAttribute('data-dialog-actions') && el.closest('[data-testid="export-dialog"]'))
				return d.actions;
			if (el.getAttribute('data-testid') === 'toast-host') return box(904, 0, 1264, STACK.height);
			return null;
		};
		Element.prototype.getBoundingClientRect = function (this: Element) {
			const r = rectFor(this) ?? box(0, 0, 0, 0);
			return {
				...r,
				x: r.left,
				y: r.top,
				width: r.right - r.left,
				height: r.bottom - r.top,
				toJSON() {},
			} as DOMRect;
		};
		Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
			configurable: true,
			get(this: HTMLElement) {
				return this.getAttribute('data-testid') === 'toast-host' ? STACK.height : 0;
			},
		});
		const store = new ToastStore();
		const onOpenChange = vi.fn();
		host = document.createElement('div');
		document.body.append(host);
		root = createRoot(host);
		const render = (open: boolean) =>
			root!.render(
				<>
					<Dialog
						open={open}
						onOpenChange={onOpenChange}
						title="Export"
						size="large"
						primaryLabel="Export"
						onPrimary={() => false}
						data-testid="export-dialog"
					>
						<p>settings</p>
					</Dialog>
					<ToastHost store={store} />
				</>,
			);
		await act(async () => render(false));
		await act(async () => {
			store.show({ kind: 'info', title: 'Proposed sounds for 3 cues', durationMs: 'sticky' });
		});
		const hostEl = () => document.querySelector<HTMLElement>('[data-testid="toast-host"]')!;
		expect(hostEl().style.bottom).toBe('16px');

		await act(async () => render(true));
		// before: still 16 px from the bottom, on the footer's Export button
		expect(hostEl().style.bottom).toBe(`${VIEW.height - (d.actions!.top - 8)}px`);
		expect(hostEl().dataset.avoiding).toBe('actions');
		const r = stackRect({ bottom: Number.parseFloat(hostEl().style.bottom), maxHeight: null });
		expect(overlaps(r, d.actions!)).toBe(false);

		// a click on the toast is not a click outside the dialog
		await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
		const card = document.querySelector<HTMLElement>('[data-testid="toast"]')!;
		await act(async () => {
			card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
			card.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		});
		expect(onOpenChange).not.toHaveBeenCalledWith(false);

		await act(async () => render(false));
		expect(hostEl().style.bottom).toBe('16px');
		expect(hostEl().dataset.avoiding).toBe('none');
	});
});
