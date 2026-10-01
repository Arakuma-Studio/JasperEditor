// Tooltips (S05:TT-001…004): `--pr-tooltip-bg`, 12 px text, radius 4, max 280 px, 600 ms delay, 0 ms
// when moving between tooltipped controls within 300 ms, hidden on press. Format `Name (Shortcut)`;
// disabled controls add a second line with the reason (SH-031). Never shown on touch (Radix ignores
// touch pointers). Without a <TooltipHost> (tests, isolated widgets) the native `title` is used.
import { Tooltip as RTooltip } from 'radix-ui';
import {
	cloneElement,
	createContext,
	isValidElement,
	type ReactElement,
	type ReactNode,
	useContext,
} from 'react';
import { cx } from '../cx.ts';

const HostContext = createContext<boolean | null>(null);

export type TooltipHostProps = {
	children?: ReactNode;
	/** Global preference (Preferences ▸ General, S05:TT-003). */
	enabled?: boolean;
	delayMs?: number;
};

/** Mount once per window, above every tooltipped control (S05:SH-004). */
export function TooltipHost({ children, enabled = true, delayMs = 600 }: TooltipHostProps) {
	return (
		<HostContext.Provider value={enabled}>
			<RTooltip.Provider delayDuration={delayMs} skipDelayDuration={300}>
				{children}
			</RTooltip.Provider>
		</HostContext.Provider>
	);
}

/** "Razor Tool (C)" (S05:TT-002). */
export function tooltipText(name: string, shortcut?: string | null): string {
	return shortcut ? `${name} (${shortcut})` : name;
}

export type TooltipProps = {
	/** First line, usually `Name (Shortcut)`. */
	content: ReactNode;
	/** Second line (disabled reason, rich detail). */
	detail?: ReactNode;
	side?: 'top' | 'right' | 'bottom' | 'left';
	align?: 'start' | 'center' | 'end';
	/** A single element that accepts a ref and pointer handlers. */
	children: ReactElement;
};

function plainText(node: ReactNode): string | undefined {
	return typeof node === 'string' || typeof node === 'number' ? String(node) : undefined;
}

export function Tooltip({ content, detail, side = 'bottom', align = 'center', children }: TooltipProps) {
	const host = useContext(HostContext);
	if (host === null) {
		const title = [plainText(content), plainText(detail)].filter(Boolean).join('\n');
		if (!title || !isValidElement(children)) return children;
		return cloneElement(children as ReactElement<{ title?: string }>, { title });
	}
	if (!host) return children;
	return (
		<RTooltip.Root>
			<RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
			<RTooltip.Portal>
				<RTooltip.Content
					side={side}
					align={align}
					sideOffset={6}
					collisionPadding={8}
					className={cx(
						'z-[var(--pr-z-tooltip)] max-w-[280px] rounded-pr-control bg-pr-tooltip px-2 py-1',
						'font-pr text-pr-ui text-pr-text shadow-pr-overlay select-none',
					)}
					data-testid="tooltip"
				>
					<div>{content}</div>
					{detail ? <div className="text-pr-muted">{detail}</div> : null}
				</RTooltip.Content>
			</RTooltip.Portal>
		</RTooltip.Root>
	);
}
