import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx.ts';
import { Icon } from '../icons/Icon.tsx';
import { Tooltip } from './Tooltip.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: ButtonVariant;
	/** Pill radius for dialog confirmation buttons (R-PUI §3.5, S05:DG-001). */
	pill?: boolean;
	/** Async command in flight: inline spinner, disabled until done (S05:CT-003). */
	busy?: boolean;
	/** Shown as a tooltip when disabled (S05:SH-031). */
	disabledReason?: string;
	children?: ReactNode;
};

const VARIANTS: Record<ButtonVariant, string> = {
	primary: 'bg-pr-accent-fill text-pr-on-accent hover:bg-pr-accent-fill-hover border border-transparent',
	secondary: 'bg-transparent text-pr-text border border-pr-border-strong hover:bg-pr-hover',
	quiet: 'bg-transparent text-pr-text border border-transparent hover:bg-pr-hover',
	danger: 'bg-pr-danger text-pr-on-accent border border-transparent hover:opacity-90',
};

export function Button({
	variant = 'secondary',
	pill,
	busy,
	disabledReason,
	className,
	type = 'button',
	disabled,
	children,
	...rest
}: ButtonProps) {
	const inert = disabled || busy;
	const button = (
		<button
			type={type}
			disabled={inert && !disabledReason}
			aria-disabled={inert || undefined}
			aria-busy={busy || undefined}
			className={cx(
				'inline-flex items-center justify-center gap-1 px-[10px] font-pr text-pr-ui select-none whitespace-nowrap',
				'h-[var(--pr-control-h)] transition-colors duration-100',
				'disabled:opacity-40 disabled:pointer-events-none aria-disabled:opacity-40',
				pill ? 'rounded-pr-pill px-4' : 'rounded-pr-control',
				VARIANTS[variant],
				className,
			)}
			{...rest}
			onClick={inert ? (e) => e.preventDefault() : rest.onClick}
		>
			{busy ? <Icon id="app.spinner" size={14} className="animate-spin" /> : null}
			{children}
		</button>
	);
	return disabled && disabledReason ? <Tooltip content={disabledReason}>{button}</Tooltip> : button;
}
