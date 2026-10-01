// WS /agent client (ARCHITECTURE §11): the open editor registers with the engine
// ({type:'hello', projectId, sessionId, leaseId}), answers relayed requests and forwards its events.
// Reconnects with backoff (1 s → 30 s) and re-sends hello after every (re)connect or lease change.
import { type AgentWsClientMessage, AgentWsServerMessageSchema } from '@jasper/api';

export type RelayState = 'off' | 'connecting' | 'connected' | 'disconnected';

type RelayHello = { projectId: string; sessionId: string; leaseId: string | null };

type RelayRequestHandler = (
	kind: 'tx' | 'query' | 'schema',
	payload: unknown,
) => Promise<{ result?: unknown; error?: { code: string; message: string } }>;

/** Minimal browser-WebSocket shape (injectable for tests). */
export interface RelaySocket {
	readonly readyState: number;
	onopen: ((ev: unknown) => void) | null;
	onclose: ((ev: unknown) => void) | null;
	onerror: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}
export type RelaySocketFactory = (url: string) => RelaySocket;

export type RelayClientOptions = {
	url: string;
	hello(): RelayHello;
	onRequest: RelayRequestHandler;
	onEvent?(event: string, payload: unknown): void;
	onState?(state: RelayState): void;
	socketFactory?: RelaySocketFactory;
	minBackoffMs?: number;
	maxBackoffMs?: number;
};

const OPEN = 1;

export class AgentRelayClient {
	private socket: RelaySocket | null = null;
	private stopped = true;
	private backoff: number;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private stateValue: RelayState = 'off';

	constructor(private readonly opts: RelayClientOptions) {
		this.backoff = opts.minBackoffMs ?? 1000;
	}

	get state(): RelayState {
		return this.stateValue;
	}

	private setState(s: RelayState) {
		if (s === this.stateValue) return;
		this.stateValue = s;
		this.opts.onState?.(s);
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		const s = this.socket;
		this.socket = null;
		if (s) {
			s.onclose = null;
			s.onmessage = null;
			s.onerror = null;
			try {
				s.close(1000, 'session closed');
			} catch {
				// ignore
			}
		}
		this.setState('off');
	}

	private connect(): void {
		if (this.stopped) return;
		this.setState('connecting');
		let socket: RelaySocket;
		try {
			socket = (this.opts.socketFactory ?? ((u) => new WebSocket(u) as unknown as RelaySocket))(
				this.opts.url,
			);
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		socket.onopen = () => {
			this.backoff = this.opts.minBackoffMs ?? 1000;
			this.sendHello();
			this.setState('connected');
		};
		socket.onmessage = (ev) => void this.onMessage(ev.data);
		socket.onerror = () => undefined;
		socket.onclose = () => {
			if (this.socket === socket) this.socket = null;
			if (this.stopped) return;
			this.setState('disconnected');
			this.scheduleReconnect();
		};
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.timer) return;
		const wait = this.backoff;
		this.backoff = Math.min(this.opts.maxBackoffMs ?? 30_000, this.backoff * 2);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.connect();
		}, wait);
	}

	private send(msg: AgentWsClientMessage): boolean {
		const s = this.socket;
		if (!s || s.readyState !== OPEN) return false;
		try {
			s.send(JSON.stringify(msg));
			return true;
		} catch {
			return false;
		}
	}

	/** Re-announces the session (e.g. after the lease changed). */
	sendHello(): void {
		this.send({ type: 'hello', ...this.opts.hello() });
	}

	sendEvent(event: string, payload: unknown): boolean {
		return this.send({ type: 'event', event, payload });
	}

	private async onMessage(data: unknown): Promise<void> {
		if (typeof data !== 'string') return;
		let raw: unknown;
		try {
			raw = JSON.parse(data);
		} catch {
			return;
		}
		const parsed = AgentWsServerMessageSchema.safeParse(raw);
		if (!parsed.success) return;
		const msg = parsed.data;
		switch (msg.type) {
			case 'ping':
				this.send({ type: 'pong' });
				return;
			case 'event':
				this.opts.onEvent?.(msg.event, msg.payload);
				return;
			case 'request': {
				let out: { result?: unknown; error?: { code: string; message: string } };
				try {
					out = await this.opts.onRequest(msg.kind, msg.payload);
				} catch (e) {
					out = { error: { code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) } };
				}
				this.send({
					type: 'response',
					id: msg.id,
					result: out.result ?? null,
					...(out.error ? { error: out.error } : {}),
				});
				return;
			}
			default:
				return;
		}
	}
}
