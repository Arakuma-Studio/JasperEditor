// Notices for import results and export completion, including download links (S05 §13).
import { Button, IconButton, Z } from '@jasper/ui';
import { useEffect, useSyncExternalStore } from 'react';
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

export function toastFromRequest(r: ToastRequest, store: NoticeStore = notices): void {
	store.push({ kind: r.kind, message: r.message, detail: r.detail, durationMs: r.durationMs });
}

function NoticeView({ n, store }: { n: Notice; store: NoticeStore }) {
	useEffect(() => {
		const ms = n.durationMs === undefined ? (n.kind === 'error' ? null : 6000) : n.durationMs;
		if (!ms) return;
		const t = setTimeout(() => store.dismiss(n.id), ms);
		return () => clearTimeout(t);
	}, [n, store]);
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
								onClick={() => store.dismiss(n.id)}
							>
								{n.action.label}
							</a>
						) : (
							<Button
								variant="quiet"
								onClick={() => {
									n.action?.onClick?.();
									store.dismiss(n.id);
								}}
							>
								{n.action.label}
							</Button>
						)}
					</div>
				) : null}
			</div>
			<IconButton icon="app.close" label="Dismiss" onClick={() => store.dismiss(n.id)} />
		</div>
	);
}

/** Sits above the bottom action bars (Export mode footer: Cancel / Export) so sticky notices never hide them. */
export function NoticeHost({ store = notices }: { store?: NoticeStore }) {
	const list = useSyncExternalStore(store.subscribe, store.getAll, store.getAll);
	if (!list.length) return null;
	return (
		<div
			className="pointer-events-auto fixed right-3 bottom-12 flex flex-col gap-2"
			style={{ zIndex: Z.toast }}
		>
			{list.map((n) => (
				<NoticeView key={n.id} n={n} store={store} />
			))}
		</div>
	);
}
