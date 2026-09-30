import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx.ts';

export type PanelFrameProps = HTMLAttributes<HTMLElement> & {
	title: ReactNode;
	/** Right side of the tab strip (panel menu, actions). */
	actions?: ReactNode;
	/** Focused panel: 1 px focus-ring outline (S05:FO-002). */
	focused?: boolean;
	children?: ReactNode;
};

/**
 * Minimal panel chrome for placeholders and non-docked contexts: a 28 px tab strip and a body
 * (S05 §6). Docked panels get their chrome from the dock host (WP-2A).
 */
export function PanelFrame({ title, actions, focused, className, children, ...rest }: PanelFrameProps) {
	return (
		<section
			className={cx(
				'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-pr-frame bg-pr-panel text-pr-text',
				focused ? 'outline outline-1 -outline-offset-1 outline-pr-focus' : '',
				className,
			)}
			{...rest}
		>
			<header className="flex h-[var(--pr-tab-h)] shrink-0 items-center gap-2 border-b border-pr-border-subtle px-3">
				<h2 className="truncate text-pr-ui font-normal text-pr-strong">{title}</h2>
				<div className="ml-auto flex items-center gap-1">{actions}</div>
			</header>
			<div className="min-h-0 flex-1 overflow-auto">{children}</div>
		</section>
	);
}
