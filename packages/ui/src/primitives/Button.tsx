import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: ButtonVariant;
	/** Pill radius for dialog confirmation buttons (R-PUI §3.5). */
	pill?: boolean;
	children?: ReactNode;
};

const VARIANTS: Record<ButtonVariant, string> = {
	primary: 'bg-pr-accent-fill text-pr-on-accent hover:bg-pr-accent-fill-hover border border-transparent',
	secondary: 'bg-transparent text-pr-text border border-pr-border-strong hover:bg-pr-hover',
	quiet: 'bg-transparent text-pr-text border border-transparent hover:bg-pr-hover',
	danger: 'bg-pr-danger text-pr-on-accent border border-transparent hover:opacity-90',
};

/** Text button: 24 px high, 4 px radius, token colors only (S05 §11.1). */
export function Button({
	variant = 'secondary',
	pill,
	className,
	type = 'button',
	children,
	...rest
}: ButtonProps) {
	return (
		<button
			type={type}
			className={cx(
				'inline-flex items-center justify-center gap-1 px-3 font-pr text-pr-ui select-none',
				'h-[var(--pr-control-h)] transition-colors duration-100 disabled:opacity-40 disabled:pointer-events-none',
				pill ? 'rounded-pr-pill' : 'rounded-pr-control',
				VARIANTS[variant],
				className,
			)}
			{...rest}
		>
			{children}
		</button>
	);
}
