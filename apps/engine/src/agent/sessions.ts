// WS /agent session registry and request/response relay (ARCHITECTURE §11, S01:AGT-001 surface 2).
// An editor that opens a project connects, says hello {projectId, sessionId, leaseId}, answers
// {type:'request'} messages with {type:'response'} and forwards its events ({type:'event'}).
import { randomUUID } from 'node:crypto';
import { AgentWsClientMessageSchema, type AgentWsServerMessage } from '@jasper/api';

/** The subset of a `ws` WebSocket the registry needs (keeps tests and the relay decoupled). */
export interface AgentSocket {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	terminate?(): void;
	ping?(): void;
	on(event: 'message', cb: (data: unknown) => void): unknown;
	on(event: 'close', cb: () => void): unknown;
	on(event: 'pong', cb: () => void): unknown;
	on(event: 'error', cb: (err: Error) => void): unknown;
}

const OPEN = 1;

export type RequestKind = 'tx' | 'query' | 'schema';

export type RelayOutcome = { result: unknown; error?: { code: string; message: string } };

export class RelayError extends Error {
	constructor(
		readonly code: 'E_NO_SESSION' | 'E_TIMEOUT',
		message: string,
	) {
		super(message);
		this.name = 'RelayError';
	}
}

type Pending = {
	resolve(o: RelayOutcome): void;
	reject(e: RelayError): void;
	timer: ReturnType<typeof setTimeout>;
};

export type AgentConnection = {
	readonly id: string;
	readonly socket: AgentSocket;
	projectId: string | null;
	sessionId: string | null;
	leaseId: string | null;
	readonly connectedAt: number;
	helloAt: number;
	lastSeen: number;
	readonly pending: Map<string, Pending>;
};

export type ConnectionInfo = {
	id: string;
	projectId: string | null;
	sessionId: string | null;
	leaseId: string | null;
	connectedAt: string;
};

export type SessionRegistryOptions = {
	engineVersion: string;
	/** A session forwarded an event (doc.changed, selection.changed, agent.approval.resolve…). */
	onEvent(conn: AgentConnection, event: string, payload: unknown): void;
	/** Heartbeat interval (protocol pings); connections silent for 3 intervals are dropped. */
	heartbeatMs?: number;
	now?(): number;
};

function decode(data: unknown): string | null {
	if (typeof data === 'string') return data;
	if (Buffer.isBuffer(data)) return data.toString('utf8');
	if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
	return null;
}

export class SessionRegistry {
	private readonly conns = new Set<AgentConnection>();
	private readonly heartbeat: ReturnType<typeof setInterval> | null;
	private readonly now: () => number;

	constructor(private readonly opts: SessionRegistryOptions) {
		this.now = opts.now ?? (() => Date.now());
		const every = opts.heartbeatMs ?? 15_000;
		this.heartbeat =
			every > 0
				? setInterval(() => {
						const cutoff = this.now() - every * 3;
						for (const c of this.conns) {
							if (c.lastSeen < cutoff) {
								this.drop(c, 'heartbeat timeout');
								continue;
							}
							try {
								c.socket.ping?.();
							} catch {
								this.drop(c, 'ping failed');
							}
						}
					}, every)
				: null;
		(this.heartbeat as { unref?: () => void } | null)?.unref?.();
	}

	/** Registers a new socket; messages are handled until it closes. */
	attach(socket: AgentSocket): AgentConnection {
		const t = this.now();
		const conn: AgentConnection = {
			id: randomUUID(),
			socket,
			projectId: null,
			sessionId: null,
			leaseId: null,
			connectedAt: t,
			helloAt: 0,
			lastSeen: t,
			pending: new Map(),
		};
		this.conns.add(conn);
		socket.on('message', (data) => this.onMessage(conn, data));
		socket.on('pong', () => {
			conn.lastSeen = this.now();
		});
		socket.on('close', () => this.drop(conn, 'closed'));
		socket.on('error', () => this.drop(conn, 'socket error'));
		return conn;
	}

	private send(conn: AgentConnection, msg: AgentWsServerMessage): boolean {
		if (conn.socket.readyState !== OPEN) return false;
		try {
			conn.socket.send(JSON.stringify(msg));
			return true;
		} catch {
			return false;
		}
	}

	private onMessage(conn: AgentConnection, data: unknown): void {
		conn.lastSeen = this.now();
		const text = decode(data);
		if (text === null) return;
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return;
		}
		const parsed = AgentWsClientMessageSchema.safeParse(raw);
		if (!parsed.success) return;
		const msg = parsed.data;
		switch (msg.type) {
			case 'hello':
				conn.projectId = msg.projectId;
				conn.sessionId = msg.sessionId;
				conn.leaseId = msg.leaseId;
				conn.helloAt = this.now();
				this.send(conn, { type: 'welcome', engineVersion: this.opts.engineVersion });
				return;
			case 'response': {
				const p = conn.pending.get(msg.id);
				if (!p) return;
				conn.pending.delete(msg.id);
				clearTimeout(p.timer);
				p.resolve({ result: msg.result, ...(msg.error ? { error: msg.error } : {}) });
				return;
			}
			case 'event':
				this.opts.onEvent(conn, msg.event, msg.payload);
				return;
			case 'ping':
				this.send(conn, { type: 'pong' });
				return;
			case 'pong':
				return;
		}
	}

	private drop(conn: AgentConnection, why: string): void {
		if (!this.conns.delete(conn)) return;
		for (const [id, p] of conn.pending) {
			clearTimeout(p.timer);
			p.reject(new RelayError('E_NO_SESSION', `The editor session disconnected (${why})`));
			conn.pending.delete(id);
		}
		try {
			if (conn.socket.readyState === OPEN) conn.socket.close(1001, why);
		} catch {
			// already gone
		}
	}

	/**
	 * The session that answers for a project: the most recent hello that carries a lease (the lease
	 * holder, S01:AGT-001), else null. Read-only sessions (no lease) never receive transactions.
	 */
	holder(projectId: string): AgentConnection | null {
		let best: AgentConnection | null = null;
		for (const c of this.conns) {
			if (c.projectId !== projectId || !c.leaseId || c.socket.readyState !== OPEN) continue;
			if (!best || c.helloAt > best.helloAt) best = c;
		}
		return best;
	}

	/** Every connected session of a project (for events such as approval requests). */
	connectionsFor(projectId: string): AgentConnection[] {
		return [...this.conns].filter((c) => c.projectId === projectId && c.socket.readyState === OPEN);
	}

	/** Sends a request and waits for the matching response (rejects on timeout or disconnect). */
	request(
		conn: AgentConnection,
		kind: RequestKind,
		payload: unknown,
		timeoutMs: number,
	): Promise<RelayOutcome> {
		return new Promise<RelayOutcome>((resolve, reject) => {
			const id = randomUUID();
			const timer = setTimeout(() => {
				conn.pending.delete(id);
				reject(new RelayError('E_TIMEOUT', `The editor session did not answer within ${timeoutMs} ms`));
			}, timeoutMs);
			conn.pending.set(id, { resolve, reject, timer });
			if (!this.send(conn, { type: 'request', id, kind, payload })) {
				clearTimeout(timer);
				conn.pending.delete(id);
				reject(new RelayError('E_NO_SESSION', 'The editor session is not connected'));
			}
		});
	}

	/** Pushes an engine event to every session of a project. */
	sendEvent(projectId: string, event: string, payload: unknown): number {
		let n = 0;
		for (const c of this.connectionsFor(projectId)) if (this.send(c, { type: 'event', event, payload })) n++;
		return n;
	}

	list(): ConnectionInfo[] {
		return [...this.conns].map((c) => ({
			id: c.id,
			projectId: c.projectId,
			sessionId: c.sessionId,
			leaseId: c.leaseId,
			connectedAt: new Date(c.connectedAt).toISOString(),
		}));
	}

	close(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		for (const c of [...this.conns]) this.drop(c, 'engine shutting down');
	}
}
