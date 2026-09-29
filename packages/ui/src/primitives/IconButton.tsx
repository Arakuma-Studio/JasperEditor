import type { ButtonHTMLAttributes } from 'react';
import { cx } from '../cx.ts';
import { Icon } from '../icons/Icon.tsx';
import type { IconId } from '../icons/registry.ts';

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
	icon: IconId;
	/** Accessible label; also used as tooltip text "Name (Shortcut)". */
	label: string;
	shortcut?: string;
	/** Toggle state: `on` colors the glyph with the accent; `selected` fills (current tool). */
	toggled?: 'off' | 'on' | 'selected';
	size?: 'normal' | 'transport';
};

/** 24×24 (transport 28×28) icon button with a 16 px glyph (S05 §11.1, R-PUI §3.5). */
export function IconButton({
	icon,
	label,
	shortcut,
	toggled = 'off',
	size = 'normal',
	className,
	type = 'button',
	...rest
}: IconButtonProps) {
	const title = shortcut ? `${label} (${shortcut})` : label;
	return (
		<button
			type={type}
			aria-label={label}
			aria-pressed={toggled === 'off' ? undefined : true}
			title={title}
			className={cx(
				'inline-flex items-center justify-center rounded-pr-control transition-colors duration-100',
				'disabled:text-pr-dim disabled:pointer-events-none',
				size === 'transport' ? 'size-[var(--pr-transport-btn)]' : 'size-[var(--pr-icon-btn)]',
				toggled === 'selected'
					? 'bg-pr-accent-fill text-pr-on-accent'
					: toggled === 'on'
						? 'text-pr-accent hover:bg-pr-hover'
						: 'text-pr-icon hover:text-pr-icon-hover hover:bg-pr-hover',
				className,
			)}
			{...rest}
		>
			<Icon id={icon} size={16} />
		</button>
	);
}
