// Single-writer leases (S01:PER-040, ARCHITECTURE §6): in-memory, 30 s TTL, extended by heartbeats
// (the client heartbeats every 10 s). A second session gets 409 LEASE_HELD.
import type { Lease } from '@jasper/api';
import { randomId } from '../tools/fs.ts';

const LEASE_TTL_MS = 30_000;
const LEASE_HEARTBEAT_MS = 10_000;

class LeaseError extends Error {
	constructor(
		readonly code: 'LEASE_HELD' | 'LEASE_NOT_FOUND',
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = 'LeaseError';
	}
}

/** A session started editing a project (a new lease, not a renewal), or stopped (released, expired, forgotten). */
type LeaseChange = { projectId: string; kind: 'acquired' | 'released' };

export class LeaseManager {
	private readonly leases = new Map<string, Lease>();
	private readonly listeners = new Set<(c: LeaseChange) => void>();

	/**
	 * Calls `fn` when a project gets a new editing session or loses its session (released, found expired, forgotten).
	 * A throwing listener is ignored. Returns the unsubscribe function. The History of a session that is gone cannot
	 * bring anything back: per-sequence caches of deleted sequences can go then (the kept Sound Check reports).
	 */
	onChange(fn: (c: LeaseChange) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(c: LeaseChange): void {
		for (const fn of this.listeners) {
			try {
				fn(c);
			} catch {
				// a listener never breaks a lease
			}
		}
	}

	constructor(
		private readonly now: () => number = () => Date.now(),
		private readonly ttlMs = LEASE_TTL_MS,
	) {}

	private live(projectId: string): Lease | null {
		const l = this.leases.get(projectId);
		if (!l) return null;
		if (Date.parse(l.expiresAt) <= this.now()) {
			this.leases.delete(projectId);
			this.emit({ projectId, kind: 'released' });
			return null;
		}
		return l;
	}

	/** Current holder, or null (expired leases are dropped). Agents use this to pick session vs headless. */
	get(projectId: string): Lease | null {
		const l = this.live(projectId);
		return l ? { ...l } : null;
	}

	/**
	 * Grants (or, for the same session, renews) the project's lease. `takeOver` (S01:PER-040, WP-2E) revokes
	 * another session's lease: the new lease has a fresh id, so the old holder's next heartbeat answers
	 * 404 LEASE_NOT_FOUND and its editor turns read-only.
	 */
	acquire(projectId: string, sessionId: string, opts: { takeOver?: boolean } = {}): Lease {
		let cur = this.live(projectId);
		if (cur && cur.sessionId !== sessionId && opts.takeOver) {
			this.leases.delete(projectId);
			cur = null;
		}
		if (cur && cur.sessionId !== sessionId) {
			throw new LeaseError('LEASE_HELD', 'Another session is editing this project', {
				holderSessionId: cur.sessionId,
				expiresAt: cur.expiresAt,
			});
		}
		const t = this.now();
		const lease: Lease = cur
			? { ...cur, expiresAt: new Date(t + this.ttlMs).toISOString() }
			: {
					leaseId: randomId('lse', 10),
					projectId,
					sessionId,
					acquiredAt: new Date(t).toISOString(),
					expiresAt: new Date(t + this.ttlMs).toISOString(),
					heartbeatMs: LEASE_HEARTBEAT_MS,
				};
		this.leases.set(projectId, lease);
		if (!cur) this.emit({ projectId, kind: 'acquired' });
		return { ...lease };
	}

	heartbeat(projectId: string, leaseId: string): Lease {
		const cur = this.live(projectId);
		if (!cur || cur.leaseId !== leaseId)
			throw new LeaseError('LEASE_NOT_FOUND', 'Lease not found or expired');
		cur.expiresAt = new Date(this.now() + this.ttlMs).toISOString();
		return { ...cur };
	}

	release(projectId: string, leaseId: string): void {
		const cur = this.live(projectId);
		if (!cur || cur.leaseId !== leaseId)
			throw new LeaseError('LEASE_NOT_FOUND', 'Lease not found or expired');
		this.leases.delete(projectId);
		this.emit({ projectId, kind: 'released' });
	}

	/** Drops any lease on a deleted project. */
	forget(projectId: string): void {
		if (this.leases.delete(projectId)) this.emit({ projectId, kind: 'released' });
	}
}
