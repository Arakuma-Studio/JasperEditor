// Measures a toast stack against the open modals (`placeToasts`; wp-note sound-design "final carry-over cleanup",
// item 2), for the window's ToastHost and any other toast-like host.
import { type RefObject, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import {
	MODAL_ACTIONS_ATTR,
	MODAL_HEADER_ATTR,
	openModals,
	subscribeModals,
} from '../dialog/modal-registry.ts';
import type { Rect } from '../menu/placement.ts';
import { type ModalBox, placeToasts, TOAST_EDGE, type ToastPlacement } from './placement.ts';

const rectOf = (el: Element | null): Rect | null => {
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/** The open modals' boxes: the dialog, its title bar and its footer. */
function modalBoxes(modals: readonly HTMLElement[]): ModalBox[] {
	return modals
		.filter((m) => m.isConnected)
		.map((m) => ({
			rect: rectOf(m)!,
			header: rectOf(m.querySelector(`[${MODAL_HEADER_ATTR}]`)),
			actions: rectOf(m.querySelector(`[${MODAL_ACTIONS_ATTR}]`)),
		}));
}

/**
 * Where a toast stack goes (`placeToasts`): measured against the open modals whenever they, the stack or the window
 * change size. `version` changes when the toasts shown change (their height). For every toast-like host.
 */
export function useToastPlacement(
	host: RefObject<HTMLElement | null>,
	baseBottom: number,
	version: string,
	right: number = TOAST_EDGE,
): ToastPlacement {
	const modals = useSyncExternalStore(subscribeModals, openModals, openModals);
	const [placement, setPlacement] = useState<ToastPlacement>({
		bottom: baseBottom,
		maxHeight: null,
		avoided: 'none',
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` (the toasts shown) changes the stack's height
	useLayoutEffect(() => {
		const el = host.current;
		if (!el || typeof window === 'undefined') return;
		const measure = () => {
			const r = el.getBoundingClientRect();
			const next = placeToasts(
				{ width: window.innerWidth, height: window.innerHeight },
				// the content's height, not the capped box's
				{ width: r.width, height: Math.max(r.height, el.scrollHeight) },
				baseBottom,
				modalBoxes(modals),
				right,
			);
			setPlacement((p) =>
				p.bottom === next.bottom && p.maxHeight === next.maxHeight && p.avoided === next.avoided ? p : next,
			);
		};
		measure();
		const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
		ro?.observe(el);
		for (const m of modals) ro?.observe(m);
		window.addEventListener('resize', measure);
		return () => {
			ro?.disconnect();
			window.removeEventListener('resize', measure);
		};
	}, [host, modals, baseBottom, version, right]);
	return placement;
}
