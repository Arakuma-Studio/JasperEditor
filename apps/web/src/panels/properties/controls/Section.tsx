// Collapsible inspector section (S05:PRP-003: 28 px header, caret, right-aligned actions). The open
// state persists per section id (S03:INS-006) in localStorage, not per clip. `revealSection(id)` opens a
// section and scrolls it into view from elsewhere (S09:TRU-005: the timeline tracker glyphs reveal
// Properties ▸ Tracking), also when the section mounts just after the call (selection change, panel opening).
import { cx } from '@jasper/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
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

const revealListeners = new Set<(id: string) => void>();
/** A reveal not yet taken by a mounted section (the panel may open or re-render after the call). */
let pendingReveal: { id: string; until: number } | null = null;
const REVEAL_PENDING_MS = 3000;

/**
 * Opens the section `id` (persisted like a click on its caret) and scrolls it into view in every mounted
 * inspector; a section mounting within a few seconds takes the reveal too.
 */
export function revealSection(id: string): void {
	saveState(id, true);
	pendingReveal = { id, until: Date.now() + REVEAL_PENDING_MS };
	for (const l of [...revealListeners]) l(id);
}

function takePendingReveal(id: string): boolean {
	if (!pendingReveal || pendingReveal.id !== id) return false;
	const live = pendingReveal.until >= Date.now();
	pendingReveal = null;
	return live;
}

export function Section(props: {
	id: string;
	title: ReactNode;
	actions?: ReactNode;
	/** color-grade: a control before the caret (Lumetri's section on/off checkbox). */
	lead?: ReactNode;
	children?: ReactNode;
	defaultOpen?: boolean;
	/** Effect Controls style: 22 px bold group header. */
	variant?: 'section' | 'group';
	className?: string;
}) {
	const [open, setOpen] = useState(() => loadState()[props.id] ?? props.defaultOpen ?? true);
	const [reveal, setReveal] = useState(0);
	const ref = useRef<HTMLElement>(null);
	const toggle = () => {
		setOpen(!open);
		saveState(props.id, !open);
	};
	useEffect(() => {
		const id = props.id;
		const on = (target: string) => {
			if (target !== id) return;
			if (pendingReveal?.id === id) pendingReveal = null;
			setOpen(true);
			setReveal((n) => n + 1);
		};
		revealListeners.add(on);
		if (takePendingReveal(id)) on(id);
		return () => {
			revealListeners.delete(on);
		};
	}, [props.id]);
	useEffect(() => {
		if (reveal) ref.current?.scrollIntoView?.({ block: 'nearest' });
	}, [reveal]);
	return (
		<section
			ref={ref}
			className={cx('border-b border-pr-border-subtle', props.className)}
			data-section={props.id}
		>
			<header
				className={cx(
					'flex items-center gap-1 pr-2 pl-1',
					props.variant === 'group' ? 'h-[var(--pr-row-h)] font-semibold' : 'h-[28px]',
				)}
			>
				{props.lead ? <span className="flex items-center pl-1">{props.lead}</span> : null}
				<button
					type="button"
					aria-expanded={open}
					aria-label={`${open ? 'Collapse' : 'Expand'} section`}
					data-testid={`section-toggle-${props.id}`}
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
