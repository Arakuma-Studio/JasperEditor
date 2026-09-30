// Toast host (S05:TS-001/004/005/007/008): bottom-right, 16 px from the edges, stacking upward, 360 px
// wide; menu colors, radius 6, overlay shadow; each kind has an icon and a 3 px accent bar. Max three
// visible; older ones collapse into "+N more", which opens the notification log. Focus is never stolen.
import { Popover } from 'radix-ui';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { cx } from '../cx.ts';
import { Icon } from '../icons/Icon.tsx';
import type { IconId } from '../icons/registry.ts';
import {
	type Toast,
	type ToastAction,
	type ToastKind,
	type ToastStore,
	toasts as windowStore,
} from './toast-store.ts';

const KIND: Record<ToastKind, { icon: IconId; bar: string; text: string }> = {
	info: { icon: 'status.info', bar: 'bg-pr-accent', text: 'text-pr-accent' },
	success: { icon: 'status.success', bar: 'bg-pr-success', text: 'text-pr-success' },
	warning: { icon: 'status.warning', bar: 'bg-pr-warning', text: 'text-pr-warning' },
	error: { icon: 'status.error', bar: 'bg-pr-danger', text: 'text-pr-danger' },
	progress: { icon: 'app.spinner', bar: 'bg-pr-accent', text: 'text-pr-accent' },
	agent: { icon: 'agent.sparkle', bar: 'bg-pr-agent', text: 'text-pr-agent' },
};

export type ToastHostProps = {
	store?: ToastStore;
	/** Runs an action's `commandId` through the app's command registry. */
	runCommand?(commandId: string): void;
	/** Lift the stack above a status bar / bottom tab bar. */
	bottomOffset?: number;
};

function ToastCard({ t, store, runCommand }: { t: Toast; store: ToastStore; runCommand?(id: string): void }) {
	const [expanded, setExpanded] = useState(false);
	const k = KIND[t.kind];
	const act = (a: ToastAction) => {
		if (a.run) a.run();
		else if (a.commandId) runCommand?.(a.commandId);
		store.dismiss(t.id);
	};
	const long = (t.detail?.length ?? 0) > 120;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a focused toast is dismissed with Esc (S05:TS-007)
		<div
			role={t.kind === 'error' || t.kind === 'warning' ? 'alert' : 'status'}
			tabIndex={-1}
			onKeyDown={(e) => {
				if (e.key === 'Escape') {
					e.preventDefault();
					store.dismiss(t.id);
				}
			}}
			data-testid="toast"
			data-kind={t.kind}
			className="pointer-events-auto relative flex w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-pr-menu border border-pr-menu-border bg-pr-menu font-pr text-pr-ui text-pr-text shadow-pr-floating"
		>
			<span className={cx('w-[3px] shrink-0', k.bar)} />
			<div className="flex min-w-0 flex-1 gap-2 p-2.5">
				<span className={cx('mt-px inline-flex shrink-0', k.text)}>
					<Icon id={k.icon} size={16} className={t.kind === 'progress' ? 'animate-spin' : undefined} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex items-baseline gap-1">
						<span className="font-semibold text-pr-strong" data-testid="toast-title">
							{t.title}
						</span>
						{t.count > 1 ? (
							<span className="text-pr-muted pr-tabular" data-testid="toast-count">
								×{t.count}
							</span>
						) : null}
					</div>
					{t.detail ? (
						<div className={cx('text-pr-muted', !expanded && 'line-clamp-2')}>{t.detail}</div>
					) : null}
					{long ? (
						<button
							type="button"
							className="self-start text-pr-accent hover:underline"
							onClick={() => setExpanded((x) => !x)}
						>
							{expanded ? 'Less' : 'Details'}
						</button>
					) : null}
					{t.actions?.length ? (
						<div className="mt-1 flex gap-2">
							{t.actions.map((a) => (
								<button
									key={a.label}
									type="button"
									className="h-6 rounded-pr-control border border-pr-border-strong px-2.5 hover:bg-pr-hover"
									onClick={() => act(a)}
								>
									{a.label}
								</button>
							))}
						</div>
					) : null}
				</div>
				<button
					type="button"
					aria-label="Dismiss"
					className="inline-flex size-5 shrink-0 items-center justify-center rounded-pr-control text-pr-icon hover:bg-pr-hover"
					onClick={() => store.dismiss(t.id)}
				>
					<Icon id="app.close" size={12} />
				</button>
			</div>
			{t.kind === 'progress' ? (
				<span className="absolute right-0 bottom-0 left-[3px] h-0.5 bg-pr-border">
					<span
						className={cx('block h-full bg-pr-accent', t.progress?.value == null && 'w-[30%] animate-pulse')}
						style={
							t.progress?.value != null ? { width: `${Math.round(t.progress.value * 100)}%` } : undefined
						}
					/>
				</span>
			) : null}
		</div>
	);
}

/** Mount once per window (S05:SH-004). */
export function ToastHost({ store = windowStore, runCommand, bottomOffset = 0 }: ToastHostProps) {
	const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
	const { shown, hidden } = (() => {
		const all = state.toasts;
		return { shown: all.slice(-3), hidden: Math.max(0, all.length - 3) };
	})();

	// Timers pause while the window is blurred (TS-003).
	useEffect(() => {
		const blur = () => store.setPaused(true);
		const focus = () => store.setPaused(false);
		window.addEventListener('blur', blur);
		window.addEventListener('focus', focus);
		return () => {
			window.removeEventListener('blur', blur);
			window.removeEventListener('focus', focus);
		};
	}, [store]);

	const latest = state.toasts.at(-1);
	const assertive = latest && (latest.kind === 'error' || latest.kind === 'warning');
	return (
		<>
			<div
				className="pointer-events-none fixed right-4 z-[var(--pr-z-toast)] flex flex-col items-end gap-2"
				style={{ bottom: 16 + bottomOffset }}
				data-testid="toast-host"
				onPointerEnter={() => store.setPaused(true)}
				onPointerLeave={() => store.setPaused(false)}
			>
				{hidden > 0 ? (
					<Popover.Root>
						<Popover.Trigger asChild>
							<button
								type="button"
								className="pointer-events-auto h-6 rounded-full border border-pr-menu-border bg-pr-menu px-3 font-pr text-pr-small text-pr-muted shadow-pr-floating hover:text-pr-text"
								data-testid="toast-more"
							>
								+{hidden} more
							</button>
						</Popover.Trigger>
						<Popover.Portal>
							<Popover.Content
								side="top"
								align="end"
								sideOffset={6}
								className="z-[var(--pr-z-toast)] max-h-[60vh] w-[360px] overflow-y-auto rounded-pr-menu border border-pr-menu-border bg-pr-menu p-1 font-pr text-pr-ui shadow-pr-overlay"
							>
								<NotificationLog store={store} />
							</Popover.Content>
						</Popover.Portal>
					</Popover.Root>
				) : null}
				{shown.map((t) => (
					<ToastCard key={t.id} t={t} store={store} runCommand={runCommand} />
				))}
			</div>
			<div className="sr-only" aria-live="polite">
				{latest && !assertive ? latest.title : ''}
			</div>
			<div className="sr-only" aria-live="assertive">
				{latest && assertive ? latest.title : ''}
			</div>
		</>
	);
}

/** The last 200 notifications (S05:TS-008), newest first. */
export function NotificationLog({ store = windowStore }: { store?: ToastStore }) {
	const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
	if (!state.log.length) return <div className="p-2 text-pr-muted">No notifications</div>;
	return (
		<ul className="flex flex-col" data-testid="notification-log">
			{[...state.log].reverse().map((e) => (
				<li key={e.id} className="flex gap-2 rounded-[3px] px-2 py-1 hover:bg-pr-hover">
					<span className={cx('mt-px inline-flex', KIND[e.kind].text)}>
						<Icon id={KIND[e.kind].icon === 'app.spinner' ? 'status.info' : KIND[e.kind].icon} size={14} />
					</span>
					<div className="min-w-0 flex-1">
						<div className="truncate text-pr-text">{e.title}</div>
						{e.detail ? <div className="truncate text-pr-small text-pr-muted">{e.detail}</div> : null}
					</div>
					<span className="shrink-0 text-pr-small text-pr-muted pr-tabular">
						{new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
					</span>
				</li>
			))}
		</ul>
	);
}
