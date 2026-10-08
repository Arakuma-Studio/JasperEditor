// Keeps hand-drawn menus inside the window (S05:MN-020/021/030): a menu opened at a point goes right and down
// from it, flips left / up when that side has no room, and when neither side fits it is pinned to the window edge
// and scrolls (max-height = the window minus the margins). A submenu opens to the right of its item, flips to the
// left, and slides up to stay on screen. The Radix menus (Menu.tsx) get the same behaviour from Radix's collision
// handling plus `--radix-popper-available-height`; the app's own menus (timeline context menu, Project panel)
// use `useMenuFit`.
import { type RefObject, useLayoutEffect, useRef, useState } from 'react';

export type Size = { width: number; height: number };
export type Rect = { left: number; top: number; right: number; bottom: number };
export type MenuPlacement = { left: number; top: number; maxHeight: number };

/** Gap kept between a menu and the window edge (px). */
export const MENU_EDGE_MARGIN = 4;

function along(start: number, flipEnd: number, size: number, extent: number, margin: number): number {
	if (start + size <= extent - margin) return start; // fits on the preferred side
	if (flipEnd - size >= margin) return flipEnd - size; // fits on the other side
	return Math.max(margin, extent - margin - size); // neither: pin to the far edge (or the near one if too big)
}

/** A menu opened at a point (right-click): its top-left corner at the point when it fits. */
export function placeAtPoint(
	point: { x: number; y: number },
	size: Size,
	viewport: Size,
	margin = MENU_EDGE_MARGIN,
) {
	const maxHeight = Math.max(0, viewport.height - 2 * margin);
	const h = Math.min(size.height, maxHeight);
	return {
		left: along(point.x, point.x, size.width, viewport.width, margin),
		top: along(point.y, point.y, h, viewport.height, margin),
		maxHeight,
	} satisfies MenuPlacement;
}

/** A submenu beside its parent item: right of it, else left of it; top aligned with the item, slid up to fit. */
export function placeBeside(item: Rect, size: Size, viewport: Size, margin = MENU_EDGE_MARGIN) {
	const maxHeight = Math.max(0, viewport.height - 2 * margin);
	const h = Math.min(size.height, maxHeight);
	return {
		left: along(item.right, item.left, size.width, viewport.width, margin),
		top: Math.max(margin, Math.min(item.top, viewport.height - margin - h)),
		maxHeight,
	} satisfies MenuPlacement;
}

const same = (a: MenuPlacement | null, b: MenuPlacement) =>
	!!a &&
	Math.abs(a.left - b.left) < 0.5 &&
	Math.abs(a.top - b.top) < 0.5 &&
	Math.abs(a.maxHeight - b.maxHeight) < 0.5;

/**
 * Measures a `position: fixed` menu after every render (its content can grow, e.g. an inline Label list) and
 * returns where it fits. Until the first measurement it is `null`: render at the requested point; the layout effect
 * moves it before the browser paints.
 */
export function useMenuFit<T extends HTMLElement>(
	place: (size: Size, viewport: Size) => MenuPlacement,
): { ref: RefObject<T | null>; fit: MenuPlacement | null } {
	const ref = useRef<T | null>(null);
	const [fit, setFit] = useState<MenuPlacement | null>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || typeof window === 'undefined') return;
		// scrollHeight is the content's full height even while max-height clips it.
		const next = place(
			{ width: el.offsetWidth, height: el.scrollHeight },
			{ width: window.innerWidth, height: window.innerHeight },
		);
		if (!same(fit, next)) setFit(next);
	});
	return { ref, fit };
}
