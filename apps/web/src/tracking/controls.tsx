// Compact Premiere-like controls for the tracking UI: 22 px icon buttons (lucide glyph + tooltip), small text
// buttons with an icon, and the inspector row layout (label column 34 %).
import { cx, Tooltip } from '@jasper/ui';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function ToolButton(props: {
	icon: LucideIcon;
	label: string;
	onClick(): void;
	disabled?: boolean;
	active?: boolean;
	danger?: boolean;
	'data-testid'?: string;
}) {
	const Glyph = props.icon;
	return (
		<Tooltip content={props.label}>
			<button
				type="button"
				aria-label={props.label}
				aria-pressed={props.active === undefined ? undefined : props.active}
				aria-disabled={props.disabled || undefined}
				onClick={props.disabled ? undefined : props.onClick}
				className={cx(
					'inline-flex size-[22px] shrink-0 items-center justify-center rounded-pr-control transition-colors duration-100',
					props.disabled
						? 'cursor-default text-pr-dim'
						: props.active
							? 'bg-pr-pressed text-pr-accent'
							: props.danger
								? 'text-pr-icon hover:bg-pr-hover hover:text-pr-danger'
								: 'text-pr-icon hover:bg-pr-hover hover:text-pr-icon-hover active:bg-pr-pressed',
				)}
				data-testid={props['data-testid']}
			>
				<Glyph size={14} strokeWidth={1.75} aria-hidden />
			</button>
		</Tooltip>
	);
}

export function SmallButton(props: {
	icon?: LucideIcon;
	children: ReactNode;
	onClick(): void;
	disabled?: boolean;
	title?: string;
	primary?: boolean;
	'data-testid'?: string;
}) {
	const Glyph = props.icon;
	const button = (
		<button
			type="button"
			aria-disabled={props.disabled || undefined}
			onClick={props.disabled ? undefined : props.onClick}
			className={cx(
				'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-pr-control border px-1.5 text-pr-small whitespace-nowrap transition-colors duration-100',
				props.disabled
					? 'cursor-default border-pr-border-subtle text-pr-dim'
					: props.primary
						? 'border-transparent bg-pr-accent-fill text-pr-on-accent hover:bg-pr-accent-fill-hover'
						: 'border-pr-border-strong text-pr-text hover:bg-pr-hover',
			)}
			data-testid={props['data-testid']}
		>
			{Glyph ? <Glyph size={12} strokeWidth={1.75} aria-hidden /> : null}
			{props.children}
		</button>
	);
	return props.title ? <Tooltip content={props.title}>{button}</Tooltip> : button;
}

export function Row(props: {
	label?: ReactNode;
	children?: ReactNode;
	className?: string;
	'data-testid'?: string;
}) {
	return (
		<div
			className={cx('flex min-h-[var(--pr-row-h)] items-center gap-2 pr-1 pl-2', props.className)}
			data-testid={props['data-testid']}
		>
			{props.label !== undefined ? (
				<span className="w-[34%] shrink-0 truncate text-pr-ui text-pr-muted">{props.label}</span>
			) : null}
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-[2px]">{props.children}</div>
		</div>
	);
}
