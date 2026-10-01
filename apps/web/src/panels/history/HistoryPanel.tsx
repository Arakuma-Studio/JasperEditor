// History panel (S05:HIS-001…003, S01:UND-009): undo steps with origin icons (agent sparkle), labels
// and relative time; the current state is highlighted and later (undone) states are dimmed. Clicking a
// row jumps there (repeated undo/redo); ←/→ step; Clear History asks for confirmation.
import type { EditorSession, HistoryEntryView } from '@jasper/session';
import { useSessionOrNull, useSessionState } from '@jasper/session/react';
import { Button, cx } from '@jasper/ui';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { MiniButton } from '../properties/controls/fields.tsx';
import { CaretGlyph, EditGlyph, FxGlyph, SparkleGlyph } from '../properties/controls/glyphs.tsx';
import { useNotices } from '../properties/controls/Notices.tsx';
import type { PanelProps } from '../types.ts';

export function relativeTime(then: number, now: number): string {
	const s = Math.max(0, Math.round((now - then) / 1000));
	if (s < 5) return 'just now';
	if (s < 60) return `${s} s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

type EntryKind = 'agent' | 'effect' | 'edit';
export function entryKind(e: Pick<HistoryEntryView, 'origin' | 'label'>): EntryKind {
	if (typeof e.origin === 'object') return 'agent';
	return /effect|keyframe|animation|interpolation|crop|blur/i.test(e.label) ? 'effect' : 'edit';
}

export function HistoryPanel(props: PanelProps) {
	const session = useSessionOrNull();
	return (
		<div
			className="flex h-full min-h-0 flex-col bg-pr-panel font-pr text-pr-ui text-pr-text"
			data-panel-kind="history"
			data-instance-id={props.instanceId}
			data-testid="history-panel"
		>
			{session ? (
				<HistoryBody session={session} />
			) : (
				<p className="p-3 text-pr-small text-pr-muted">No project open.</p>
			)}
		</div>
	);
}

function useNow(ms = 15000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(t);
	}, [ms]);
	return now;
}

function HistoryBody({ session }: { session: EditorSession }) {
	const history = useSessionState((s) => s.history);
	const gesture = useSessionState((s) => s.gesture);
	const now = useNow();
	const notices = useNotices();
	const [expanded, setExpanded] = useState<number | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const { entries, index } = history;

	useEffect(() => {
		listRef.current
			?.querySelector(`[data-testid="history-row-${index}"]`)
			?.scrollIntoView?.({ block: 'nearest' });
	}, [index]);

	const jump = (i: number) => {
		if (i !== index) session.jumpTo(i);
	};
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.defaultPrevented) return;
		if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
			e.preventDefault();
			jump(Math.max(0, index - 1));
		} else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
			e.preventDefault();
			jump(Math.min(entries.length, index + 1));
		}
	};
	const clear = () =>
		notices.confirm({
			message: 'Clear the undo history? The current state is kept; earlier states can no longer be restored.',
			actions: [
				{ label: 'Cancel', run: () => {} },
				{ label: 'Clear History', primary: true, run: () => session.clearHistory() },
			],
		});

	const rowCls = (i: number) =>
		cx(
			'flex h-[var(--pr-row-h)] w-full cursor-default items-center gap-2 px-2 text-left text-pr-ui',
			i === index
				? 'bg-pr-accent-fill text-pr-on-accent'
				: i > index
					? 'text-pr-dim hover:bg-pr-hover'
					: 'text-pr-text hover:bg-pr-hover',
		);
	return (
		<>
			<header className="flex h-[26px] shrink-0 items-center gap-2 border-b border-pr-border-subtle px-2">
				<span className="text-pr-small text-pr-muted">
					{entries.length} step{entries.length === 1 ? '' : 's'}
					{gesture ? ` · ${gesture.label}…` : ''}
				</span>
				<span className="ml-auto" />
				<Button variant="quiet" onClick={clear} disabled={entries.length === 0} data-testid="history-clear">
					Clear History
				</Button>
			</header>
			{notices.element}
			<div
				ref={listRef}
				role="listbox"
				aria-label="History"
				tabIndex={0}
				className="min-h-0 flex-1 overflow-y-auto outline-none"
				onKeyDown={onKeyDown}
				data-testid="history-list"
			>
				<div
					role="option"
					aria-selected={index === 0}
					tabIndex={-1}
					data-current={index === 0}
					className={rowCls(0)}
					onClick={() => jump(0)}
					onKeyDown={(e) => e.key === 'Enter' && jump(0)}
					data-testid="history-row-0"
				>
					<span className="w-[14px]" />
					<span className="flex-1 truncate">Open</span>
				</div>
				{entries.map((e, k) => {
					const i = k + 1;
					const kind = entryKind(e);
					return (
						<div key={e.id}>
							<div
								role="option"
								aria-selected={index === i}
								tabIndex={-1}
								data-current={index === i}
								className={rowCls(i)}
								onClick={() => jump(i)}
								onKeyDown={(ev) => ev.key === 'Enter' && jump(i)}
								data-testid={`history-row-${i}`}
								title={`${e.label} — revision ${e.revisionAfter}`}
							>
								<span
									className={cx(
										'flex w-[14px] justify-center',
										i === index ? '' : kind === 'agent' ? 'text-pr-agent' : 'text-pr-icon',
									)}
									data-kind={kind}
								>
									{kind === 'agent' ? (
										<SparkleGlyph size={12} />
									) : kind === 'effect' ? (
										<FxGlyph size={12} />
									) : (
										<EditGlyph size={12} />
									)}
								</span>
								<span className="min-w-0 flex-1 truncate">{e.label}</span>
								<span className={cx('shrink-0 text-pr-small', i === index ? '' : 'text-pr-muted')}>
									{relativeTime(e.time, now)}
								</span>
								{kind === 'agent' ? (
									<MiniButton
										label={expanded === e.id ? 'Hide details' : 'Show details'}
										onClick={() => setExpanded(expanded === e.id ? null : e.id)}
									>
										<CaretGlyph open={expanded === e.id} size={10} />
									</MiniButton>
								) : null}
							</div>
							{expanded === e.id ? (
								<p className="px-8 py-1 text-pr-small text-pr-muted">
									{typeof e.origin === 'object' ? `By ${e.origin.agent}. ` : ''}
									{e.created.length} created · {e.changed.length} changed · {e.deleted.length} deleted.
								</p>
							) : null}
						</div>
					);
				})}
			</div>
		</>
	);
}
