import type { EnvelopeJson, Lease } from '@jasper/api';

export type StoredEnvelope = { envelope: EnvelopeJson; revision: number };
export type SaveOutcome = { ok: true; revision: number } | { ok: false; conflict: true; revision: number };
export type LeaseInfo = Pick<Lease, 'sessionId' | 'leaseId' | 'expiresAt'>;

export interface AgentProjectStore {
	/** The envelope and its revision, or null when the project does not exist. */
	load(projectId: string): Promise<StoredEnvelope | null>;
	/** Writes the envelope if the stored revision still equals `baseRevision`. */
	save(projectId: string, envelope: EnvelopeJson, baseRevision: number): Promise<SaveOutcome>;
	/** The live lease on the project, if the store tracks leases (S01:PER-040). */
	leaseHolder?(projectId: string): LeaseInfo | null | Promise<LeaseInfo | null>;
}
