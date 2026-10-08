// A hand-drawn menu opened at a pointer position, kept inside the window (see placement.ts): rendered in a portal
// on <body> so `position: fixed` is relative to the window even inside a docked panel.
import type { HTMLAttributes, Ref } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../cx.ts';
import { Z } from '../z.ts';
import { placeAtPoint, useMenuFit } from './placement.ts';

export type PointMenuProps = HTMLAttributes<HTMLDivElement> & {
	/** Window coordinates (clientX / clientY) of the click that opened the menu. */
	x: number;
	y: number;
	menuRef?: Ref<HTMLDivElement>;
};

export function PointMenu({ x, y, className, style, menuRef, children, ...rest }: PointMenuProps) {
	const { ref, fit } = useMenuFit<HTMLDivElement>((size, viewport) => placeAtPoint({ x, y }, size, viewport));
	const setRef = (el: HTMLDivElement | null) => {
		ref.current = el;
		if (typeof menuRef === 'function') menuRef(el);
		else if (menuRef) (menuRef as { current: HTMLDivElement | null }).current = el;
	};
	const menu = (
		<div
			role="menu"
			{...rest}
			ref={setRef}
			className={cx('fixed overflow-y-auto', className)}
			style={{
				zIndex: Z.popover,
				...style,
				left: fit?.left ?? x,
				top: fit?.top ?? y,
				maxHeight: fit?.maxHeight,
			}}
		>
			{children}
		</div>
	);
	return typeof document === 'undefined' ? menu : createPortal(menu, document.body);
}
