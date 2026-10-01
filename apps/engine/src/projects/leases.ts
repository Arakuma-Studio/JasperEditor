// Single-writer leases (S01:PER-040, ARCHITECTURE §6): in-memory, 30 s TTL, extended by heartbeats
// (the client heartbeats every 10 s). A second session gets 409 LEASE_HELD.
import type { Lease } from '@jasper/api';
import { randomId } from '../tools/fs.ts';

export const LEASE_TTL_MS = 30_000;
export const LEASE_HEARTBEAT_MS = 10_000;

export class LeaseError extends Error {
	constructor(
		readonly code: 'LEASE_HELD' | 'LEASE_NOT_FOUND',
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = 'LeaseError';
	}
}

export class LeaseManager {
	private readonly leases = new Map<string, Lease>();

	constructor(
		private readonly now: () => number = () => Date.now(),
		private readonly ttlMs = LEASE_TTL_MS,
	) {}

	private live(projectId: string): Lease | null {
		const l = this.leases.get(projectId);
		if (!l) return null;
		if (Date.parse(l.expiresAt) <= this.now()) {
			this.leases.delete(projectId);
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
	}

	/** Drops any lease on a deleted project. */
	forget(projectId: string): void {
		this.leases.delete(projectId);
	}
}
