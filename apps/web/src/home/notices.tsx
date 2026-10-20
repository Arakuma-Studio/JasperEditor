import { Button, cx, IconButton, useToastPlacement, Z } from '@jasper/ui';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ToastRequest } from '../commands/types.ts';

type Notice = {
	id: number;
	kind: 'info' | 'success' | 'warning' | 'error';
	message: string;
	detail?: string;
	/** Action button; `href` renders a download/open link. */
	action?: { label: string; href?: string; onClick?: () => void };
	/** Auto-dismiss (ms); errors stay until dismissed. */
	durationMs?: number | null;
};

class NoticeStore {
	private list: Notice[] = [];
	private readonly listeners = new Set<() => void>();
	private seq = 0;
	getAll = () => this.list;
	subscribe = (l: () => void) => {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	};
	private emit() {
		for (const l of [...this.listeners]) l();
	}
	push(n: Omit<Notice, 'id'>): number {
		const id = ++this.seq;
		this.list = [...this.list.slice(-4), { ...n, id }];
		this.emit();
		return id;
	}
	dismiss(id: number) {
		this.list = this.list.filter((n) => n.id !== id);
		this.emit();
	}
}

export const notices = new NoticeStore();

export function toastFromRequest(r: ToastRequest): void {
	notices.push({ kind: r.kind, message: r.message, detail: r.detail, durationMs: r.durationMs });
}

function NoticeView({ n }: { n: Notice }) {
	useEffect(() => {
		const ms = n.durationMs === undefined ? (n.kind === 'error' ? null : 6000) : n.durationMs;
		if (!ms) return;
		const t = setTimeout(() => notices.dismiss(n.id), ms);
		return () => clearTimeout(t);
	}, [n]);
	const tone =
		n.kind === 'error'
			? 'border-l-pr-danger'
			: n.kind === 'warning'
				? 'border-l-pr-warning'
				: n.kind === 'success'
					? 'border-l-pr-success'
					: 'border-l-pr-accent';
	return (
		<div
			role={n.kind === 'error' ? 'alert' : 'status'}
			data-testid="notice"
			className={`flex w-80 items-start gap-2 rounded-pr-menu border border-pr-menu-border border-l-4 ${tone} bg-pr-menu p-3 text-pr-ui text-pr-text shadow-pr-overlay`}
		>
			<div className="min-w-0 flex-1">
				<p className="text-pr-strong">{n.message}</p>
				{n.detail ? <p className="mt-1 break-words text-pr-small text-pr-muted">{n.detail}</p> : null}
				{n.action ? (
					<div className="mt-2">
						{n.action.href ? (
							<a
								href={n.action.href}
								download
								className="text-pr-accent underline"
								onClick={() => notices.dismiss(n.id)}
							>
								{n.action.label}
							</a>
						) : (
							<Button
								variant="quiet"
								onClick={() => {
									n.action?.onClick?.();
									notices.dismiss(n.id);
								}}
							>
								{n.action.label}
							</Button>
						)}
					</div>
				) : null}
			</div>
			<IconButton icon="app.close" label="Dismiss" onClick={() => notices.dismiss(n.id)} />
		</div>
	);
}

/**
 * Sits above the bottom action bars (Export mode footer: Cancel / Export) so sticky notices never hide them, and keeps
 * clear of an open modal dialog's title bar and footer like the toasts (`useToastPlacement`).
 */
export function NoticeHost() {
	const list = useSyncExternalStore(notices.subscribe, notices.getAll, notices.getAll);
	const ref = useRef<HTMLDivElement>(null);
	const place = useToastPlacement(ref, 48, list.map((n) => n.id).join(','), 12);
	if (!list.length) return null;
	return (
		<div
			ref={ref}
			className={cx(
				'pointer-events-auto fixed right-3 flex flex-col justify-end gap-2',
				place.maxHeight !== null && 'overflow-hidden',
			)}
			style={{
				zIndex: Z.toast,
				bottom: place.bottom,
				...(place.maxHeight !== null ? { maxHeight: place.maxHeight } : {}),
			}}
			data-testid="notice-host"
			data-avoiding={place.avoided}
			data-toast-host=""
		>
			{list.map((n) => (
				<NoticeView key={n.id} n={n} />
			))}
		</div>
	);
}
