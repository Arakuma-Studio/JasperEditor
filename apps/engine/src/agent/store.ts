// Headless project access shared by the agent service and the core project-store adapter.
export type StoredEnvelope = { envelope: Record<string, unknown>; revision: number };
export type SaveOutcome = { ok: true; revision: number } | { ok: false; conflict: true; revision: number };
export type LeaseInfo = { sessionId: string; leaseId: string; expiresAt: string };

export interface AgentProjectStore {
	/** The envelope and its revision, or null when the project does not exist. */
	load(projectId: string): Promise<StoredEnvelope | null>;
	/** Writes the envelope if the stored revision still equals `baseRevision`. */
	save(projectId: string, envelope: Record<string, unknown>, baseRevision: number): Promise<SaveOutcome>;
	/** The live lease on the project, if the store tracks leases (S01:PER-040). */
	leaseHolder?(projectId: string): LeaseInfo | null | Promise<LeaseInfo | null>;
}
