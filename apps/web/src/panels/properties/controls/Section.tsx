// Collapsible inspector section (S05:PRP-003: 28 px header, caret, right-aligned actions). The open
// state persists per section id (S03:INS-006) in localStorage, not per clip.
import { cx } from '@jasper/ui';
import { type ReactNode, useState } from 'react';
import { CaretGlyph } from './glyphs.tsx';

const KEY = 'jasper.inspector.sections';

function loadState(): Record<string, boolean> {
	try {
		return JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') as Record<string, boolean>;
	} catch {
		return {};
	}
}
function saveState(id: string, open: boolean): void {
	try {
		globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...loadState(), [id]: open }));
	} catch {
		// storage unavailable (private mode): state is per session only
	}
}

export function Section(props: {
	id: string;
	title: ReactNode;
	actions?: ReactNode;
	children?: ReactNode;
	defaultOpen?: boolean;
	/** Effect Controls style: 22 px bold group header. */
	variant?: 'section' | 'group';
	className?: string;
}) {
	const [open, setOpen] = useState(() => loadState()[props.id] ?? props.defaultOpen ?? true);
	const toggle = () => {
		setOpen(!open);
		saveState(props.id, !open);
	};
	return (
		<section className={cx('border-b border-pr-border-subtle', props.className)} data-section={props.id}>
			<header
				className={cx(
					'flex items-center gap-1 pr-2 pl-1',
					props.variant === 'group' ? 'h-[var(--pr-row-h)] font-semibold' : 'h-[28px]',
				)}
			>
				<button
					type="button"
					aria-expanded={open}
					aria-label={`${open ? 'Collapse' : 'Expand'} section`}
					onClick={toggle}
					className="flex min-w-0 flex-1 items-center gap-1 text-left text-pr-ui text-pr-strong"
				>
					<span className="text-pr-icon">
						<CaretGlyph open={open} size={12} />
					</span>
					<span className="truncate">{props.title}</span>
				</button>
				{props.actions ? <div className="flex items-center gap-[2px]">{props.actions}</div> : null}
			</header>
			{open ? <div className="pb-1">{props.children}</div> : null}
		</section>
	);
}
