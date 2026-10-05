// NDJSON `/events` reader with heartbeat timeout and exponential reconnect (S04:ENG-023, ARCHITECTURE §9.2).
import {
	type EventEnvelope,
	EventEnvelopeSchema,
	HEARTBEAT_INTERVAL_MS,
	parseEvent,
	type TypedEvent,
} from '@jasper/api';

export type EventStreamState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export type EventHandlers = {
	/** Every well-formed envelope (known or unknown type). */
	onEnvelope?(e: EventEnvelope): void;
	/** Envelopes of known types with validated payloads. */
	onEvent?(e: TypedEvent): void;
	onStateChange?(state: EventStreamState, info: { attempt: number; delayMs?: number; error?: unknown }): void;
};

export type EventStream = {
	close(): void;
	readonly lastEventId: number | null;
	readonly state: EventStreamState;
};

export function openEventStream(
	fetchImpl: typeof fetch,
	buildUrl: (since: number | null) => string,
	handlers: EventHandlers,
	opts: { since?: number | null; headers?: Record<string, string> } = {},
): EventStream {
	const heartbeatTimeout = Math.round(HEARTBEAT_INTERVAL_MS * 2.5);
	const minBackoff = 1000;
	const maxBackoff = 30_000;
	let lastEventId: number | null = opts.since ?? null;
	let state: EventStreamState = 'connecting';
	let closed = false;
	let attempt = 0;
	let controller: AbortController | null = null;
	let watchdog: ReturnType<typeof setTimeout> | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;

	const setState = (s: EventStreamState, info: { attempt: number; delayMs?: number; error?: unknown }) => {
		state = s;
		handlers.onStateChange?.(s, info);
	};
	const armWatchdog = () => {
		if (watchdog !== null) globalThis.clearTimeout(watchdog);
		watchdog = globalThis.setTimeout(
			() => controller?.abort(new Error('heartbeat timeout')),
			heartbeatTimeout,
		);
	};
	const scheduleReconnect = (error?: unknown) => {
		if (closed) return;
		const delayMs = Math.min(maxBackoff, minBackoff * 2 ** attempt);
		attempt++;
		setState('reconnecting', { attempt, delayMs, error });
		retryTimer = globalThis.setTimeout(() => {
			retryTimer = null;
			void connect();
		}, delayMs);
	};
	const handleLine = (line: string) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let json: unknown;
		try {
			json = JSON.parse(trimmed);
		} catch {
			return;
		}
		const env = EventEnvelopeSchema.safeParse(json);
		if (!env.success) return;
		lastEventId = env.data.id;
		handlers.onEnvelope?.(env.data);
		const typed = parseEvent(env.data);
		if (typed) handlers.onEvent?.(typed);
	};

	async function connect(): Promise<void> {
		if (closed) return;
		controller = new AbortController();
		const signal = controller.signal;
		if (attempt === 0) setState('connecting', { attempt });
		armWatchdog();
		try {
			const res = await fetchImpl(buildUrl(lastEventId), {
				headers: { accept: 'application/x-ndjson', ...(opts.headers ?? {}) },
				signal,
				credentials: 'include',
			});
			if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
			attempt = 0;
			setState('open', { attempt });
			armWatchdog();
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				armWatchdog();
				buf += decoder.decode(value, { stream: true });
				let nl = buf.indexOf('\n');
				while (nl >= 0) {
					handleLine(buf.slice(0, nl));
					buf = buf.slice(nl + 1);
					nl = buf.indexOf('\n');
				}
			}
			if (buf) handleLine(buf);
			throw new Error('events: stream ended');
		} catch (error) {
			if (watchdog !== null) globalThis.clearTimeout(watchdog);
			watchdog = null;
			if (closed) return;
			scheduleReconnect(error);
		}
	}

	void connect();
	return {
		close() {
			closed = true;
			if (watchdog !== null) globalThis.clearTimeout(watchdog);
			if (retryTimer !== null) globalThis.clearTimeout(retryTimer);
			controller?.abort();
			setState('closed', { attempt });
		},
		get lastEventId() {
			return lastEventId;
		},
		get state() {
			return state;
		},
	};
}
