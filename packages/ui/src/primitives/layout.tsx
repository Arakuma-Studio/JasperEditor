import { Tabs as RTabs } from 'radix-ui';
import type { ReactNode } from 'react';
import { cx } from '../cx.ts';
import { Icon } from '../icons/Icon.tsx';
import type { IconId } from '../icons/registry.ts';
import { Button } from './Button.tsx';

export type TabItem = { value: string; label: ReactNode; disabled?: boolean; content: ReactNode };

export type TabsProps = {
	items: readonly TabItem[];
	value?: string;
	defaultValue?: string;
	onValueChange?(value: string): void;
	className?: string;
	/** Keep inactive tab contents mounted (hidden). */
	keepMounted?: boolean;
};

export function Tabs({ items, value, defaultValue, onValueChange, className, keepMounted }: TabsProps) {
	return (
		<RTabs.Root
			value={value}
			defaultValue={defaultValue ?? items[0]?.value}
			onValueChange={onValueChange}
			className={cx('flex min-h-0 flex-col', className)}
		>
			<RTabs.List className="flex h-[var(--pr-tab-h)] shrink-0 items-stretch gap-0 border-b border-pr-border-subtle">
				{items.map((t) => (
					<RTabs.Trigger
						key={t.value}
						value={t.value}
						disabled={t.disabled}
						className="px-3 font-pr text-pr-ui text-pr-muted outline-none hover:text-pr-text data-[disabled]:text-pr-dim data-[state=active]:text-pr-strong data-[state=active]:shadow-[inset_0_-2px_0_var(--pr-tab-underline)] focus-visible:bg-pr-hover"
					>
						{t.label}
					</RTabs.Trigger>
				))}
			</RTabs.List>
			{items.map((t) => (
				<RTabs.Content
					key={t.value}
					value={t.value}
					forceMount={keepMounted ? true : undefined}
					className="min-h-0 flex-1 outline-none data-[state=inactive]:hidden"
				>
					{t.content}
				</RTabs.Content>
			))}
		</RTabs.Root>
	);
}

export type EmptyStateProps = {
	icon?: IconId;
	/** One-line message, e.g. "Select a clip to edit its effects". */
	message: ReactNode;
	detail?: ReactNode;
	action?: { label: string; onClick(): void; disabled?: boolean; disabledReason?: string };
	className?: string;
};

export function EmptyState({ icon, message, detail, action, className }: EmptyStateProps) {
	return (
		<div
			className={cx(
				'flex h-full min-h-0 flex-col items-center justify-center gap-2 p-4 text-center',
				className,
			)}
			data-testid="empty-state"
		>
			{icon ? (
				<span className="text-pr-dim">
					<Icon id={icon} size={24} />
				</span>
			) : null}
			<p className="max-w-[260px] text-pr-ui text-pr-muted">{message}</p>
			{detail ? <p className="max-w-[260px] text-pr-small text-pr-dim">{detail}</p> : null}
			{action ? (
				<Button
					variant="secondary"
					onClick={action.onClick}
					disabled={action.disabled}
					disabledReason={action.disabledReason}
				>
					{action.label}
				</Button>
			) : null}
		</div>
	);
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
	return <kbd className={cx('font-pr text-pr-small text-pr-muted pr-tabular', className)}>{children}</kbd>;
}
