// Toast queue and notification log (S05 §13, TS-001…008), rendered by <ToastHost>.

export type ToastKind = 'info' | 'success' | 'warning' | 'error' | 'progress' | 'agent';

export type ToastAction = { label: string; commandId?: string; run?: () => void };

/** The toast API (S05:TS-002), called by UI code and by the agent's UI tool. */
export interface ToastRequest {
	kind: ToastKind;
	/** ≤ 60 chars, sentence case, no trailing period. */
	title: string;
	/** ≤ 2 lines shown; "Details" expands the rest. */
	detail?: string;
	/** Same key replaces the existing toast instead of stacking. */
	dedupeKey?: string;
	/** Max 2. */
	actions?: ToastAction[];
	/** For kind 'progress': value 0..1 or null (indeterminate). */
	progress?: { value: number | null; jobId?: string };
	durationMs?: number | 'sticky';
	source?: 'user' | 'system' | 'engine' | 'agent';
}

export type Toast = ToastRequest & {
	id: number;
	/** Identical toasts merged within 2 s ("×3", TS-004). */
	count: number;
	createdAt: number;
	updatedAt: number;
	/** Remaining lifetime; null = sticky. */
	remainingMs: number | null;
};

export type LogEntry = {
	id: number;
	time: number;
	kind: ToastKind;
	title: string;
	detail?: string;
	source: NonNullable<ToastRequest['source']>;
	actions?: ToastAction[];
};

export const MAX_VISIBLE = 3;
export const MERGE_WINDOW_MS = 2000;
export const LOG_CAPACITY = 200;

/** Default durations (S05:TS-003). */
export function defaultDuration(req: ToastRequest): number | null {
	if (req.durationMs === 'sticky') return null;
	if (typeof req.durationMs === 'number') return req.durationMs;
	switch (req.kind) {
		case 'info':
		case 'success':
			return 4000;
		case 'warning':
			return 8000;
		case 'error':
			return req.actions?.length ? null : 10_000;
		case 'progress':
			return null;
		case 'agent':
			return 6000;
	}
}

export type ToastState = { toasts: Toast[]; log: LogEntry[] };

export class ToastStore {
	private state: ToastState = { toasts: [], log: [] };
	private readonly listeners = new Set<() => void>();
	private readonly timers = new Map<number, { handle: ReturnType<typeof setTimeout>; startedAt: number }>();
	private paused = false;
	private nextId = 1;

	getState = (): ToastState => this.state;
	subscribe = (l: () => void): (() => void) => {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	};
	private set(next: Partial<ToastState>) {
		this.state = { ...this.state, ...next };
		for (const l of [...this.listeners]) l();
	}

	/** Shows a toast; returns its id (use it with update/dismiss). */
	show(req: ToastRequest): number {
		const now = Date.now();
		const req2: ToastRequest = { ...req, actions: req.actions?.slice(0, 2) };
		const toasts = this.state.toasts;
		const byKey = req.dedupeKey ? toasts.find((x) => x.dedupeKey === req.dedupeKey) : undefined;
		const same =
			byKey ??
			toasts.find(
				(x) =>
					x.kind === req.kind &&
					x.title === req.title &&
					(x.detail ?? '') === (req.detail ?? '') &&
					now - x.updatedAt <= MERGE_WINDOW_MS,
			);
		this.appendLog(req2, now);
		if (same) {
			const merged: Toast = {
				...same,
				...req2,
				id: same.id,
				count: byKey ? same.count : same.count + 1,
				createdAt: same.createdAt,
				updatedAt: now,
				remainingMs: defaultDuration(req2),
			};
			this.set({ toasts: toasts.map((x) => (x.id === same.id ? merged : x)) });
			this.schedule(merged);
			return same.id;
		}
		const toast: Toast = {
			...req2,
			id: this.nextId++,
			count: 1,
			createdAt: now,
			updatedAt: now,
			remainingMs: defaultDuration(req2),
		};
		this.set({ toasts: [...toasts, toast] });
		this.schedule(toast);
		return toast.id;
	}

	/** Updates a toast in place (progress value, or converting progress → success/error, TS-003). */
	update(id: number, patch: Partial<ToastRequest>): void {
		const cur = this.state.toasts.find((x) => x.id === id);
		if (!cur) return;
		const now = Date.now();
		const kindChanged = patch.kind !== undefined && patch.kind !== cur.kind;
		const restartTimer = kindChanged || patch.durationMs !== undefined;
		const next: Toast = { ...cur, ...patch, updatedAt: now };
		if (restartTimer) next.remainingMs = defaultDuration(next);
		this.set({ toasts: this.state.toasts.map((x) => (x.id === id ? next : x)) });
		if (restartTimer) this.schedule(next);
		if (kindChanged) this.appendLog(next, now);
	}

	dismiss(id: number): void {
		this.clearTimer(id);
		if (!this.state.toasts.some((x) => x.id === id)) return;
		this.set({ toasts: this.state.toasts.filter((x) => x.id !== id) });
	}

	dismissAll(): void {
		for (const id of this.timers.keys()) this.clearTimer(id);
		this.set({ toasts: [] });
	}

	clearLog(): void {
		this.set({ log: [] });
	}

	/** Timers pause while hovered or while the window is blurred (TS-003). */
	setPaused(paused: boolean): void {
		if (paused === this.paused) return;
		this.paused = paused;
		const now = Date.now();
		if (paused) {
			const toasts = this.state.toasts.map((x) => {
				const timer = this.timers.get(x.id);
				if (!timer || x.remainingMs === null) return x;
				this.clearTimer(x.id);
				return { ...x, remainingMs: Math.max(0, x.remainingMs - (now - timer.startedAt)) };
			});
			this.set({ toasts });
		} else for (const x of this.state.toasts) this.schedule(x);
	}

	/** Visible toasts (newest last) and how many older ones collapsed into "+N more" (TS-004). */
	visible(): { shown: Toast[]; hidden: number } {
		const all = this.state.toasts;
		return { shown: all.slice(-MAX_VISIBLE), hidden: Math.max(0, all.length - MAX_VISIBLE) };
	}

	private appendLog(req: ToastRequest, now: number) {
		const entry: LogEntry = {
			id: this.nextId++,
			time: now,
			kind: req.kind,
			title: req.title,
			detail: req.detail,
			source: req.source ?? 'system',
			actions: req.actions,
		};
		this.set({ log: [...this.state.log, entry].slice(-LOG_CAPACITY) });
	}

	private schedule(x: Toast) {
		this.clearTimer(x.id);
		if (this.paused || x.remainingMs === null) return;
		const handle = setTimeout(() => {
			this.timers.delete(x.id);
			this.dismiss(x.id);
		}, x.remainingMs);
		this.timers.set(x.id, { handle, startedAt: Date.now() });
	}

	private clearTimer(id: number) {
		const timer = this.timers.get(id);
		if (timer) clearTimeout(timer.handle);
		this.timers.delete(id);
	}
}

/** The window's toast store (one host per window, S05:TS-001). */
export const toasts = new ToastStore();

/** Shows a toast through the window store (S05:TS-002). */
export function toast(req: ToastRequest): number {
	return toasts.show(req);
}
