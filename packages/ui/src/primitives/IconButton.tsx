import type { ButtonHTMLAttributes, Ref } from 'react';
import { cx } from '../cx.ts';
import { Icon } from '../icons/Icon.tsx';
import type { IconId } from '../icons/registry.ts';
import { Tooltip, tooltipText } from './Tooltip.tsx';

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
	icon: IconId;
	/** Accessible label; also the tooltip text "Name (Shortcut)" (S05:CT-001, TT-002). */
	label: string;
	shortcut?: string | null;
	/** Toggle state: `on` colors the glyph with the accent; `selected` fills (current tool). */
	toggled?: 'off' | 'on' | 'selected';
	size?: 'normal' | 'transport' | 'small';
	/** Second tooltip line for disabled controls (S05:SH-031). Disabled buttons stay hoverable. */
	disabledReason?: string;
	/** Async command in flight (S05:CT-003). */
	busy?: boolean;
	/** Numeric badge (jobs count, proposals waiting). */
	badge?: number | null;
	/** Pulsing activity dot (agent working, S05:HD-003). */
	dot?: boolean;
	tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
	ref?: Ref<HTMLButtonElement>;
};

const SIZES = {
	normal: 'size-[var(--pr-icon-btn)]',
	transport: 'size-[var(--pr-transport-btn)]',
	small: 'size-5',
};

/** 24×24 (transport 28×28) icon button with a 16 px glyph (S05:CT-001, R-PUI §3.5). */
export function IconButton({
	icon,
	label,
	shortcut,
	toggled = 'off',
	size = 'normal',
	disabledReason,
	busy,
	badge,
	dot,
	tooltipSide,
	className,
	type = 'button',
	disabled,
	onClick,
	ref,
	...rest
}: IconButtonProps) {
	const inert = disabled || busy;
	const button = (
		<button
			ref={ref}
			type={type}
			aria-label={label}
			aria-pressed={toggled === 'off' ? undefined : true}
			aria-disabled={inert || undefined}
			data-disabled={inert || undefined}
			className={cx(
				'relative inline-flex shrink-0 items-center justify-center rounded-pr-control transition-colors duration-100',
				SIZES[size],
				inert
					? 'text-pr-dim cursor-default'
					: toggled === 'selected'
						? 'bg-pr-accent-fill text-pr-on-accent'
						: toggled === 'on'
							? 'text-pr-accent hover:bg-pr-hover active:bg-pr-pressed'
							: 'text-pr-icon hover:text-pr-icon-hover hover:bg-pr-hover active:bg-pr-pressed',
				className,
			)}
			onClick={inert ? (e) => e.preventDefault() : onClick}
			{...rest}
		>
			<Icon
				id={busy ? 'app.spinner' : icon}
				size={size === 'small' ? 14 : 16}
				className={busy ? 'animate-spin' : undefined}
			/>
			{badge ? (
				<span
					className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-pr-accent-fill px-[3px] text-center text-[10px] leading-3.5 text-pr-on-accent pr-tabular"
					data-testid="icon-badge"
				>
					{badge > 99 ? '99+' : badge}
				</span>
			) : null}
			{dot ? (
				<span className="absolute top-0.5 right-0.5 size-1.5 animate-pulse rounded-full bg-pr-agent" />
			) : null}
		</button>
	);
	return (
		<Tooltip
			content={tooltipText(label, shortcut)}
			detail={inert ? disabledReason : undefined}
			side={tooltipSide}
		>
			{button}
		</Tooltip>
	);
}
