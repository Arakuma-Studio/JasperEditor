// Integration adapter: WP-2H's headless AgentProjectStore over WP-2F's project store and lease manager,
// so agent writes share the store's mutex, schema validation, version snapshots and lease state
// (docs/wp-notes/WP-2H.md, "WP-2F store"). Registered by server.ts as `services.agentStore`.
import type { LeaseManager } from '../projects/leases.ts';
import { ProjectError, type ProjectStoreFs } from '../projects/store.ts';
import type { AgentProjectStore, LeaseInfo, SaveOutcome, StoredEnvelope } from './store.ts';

type SaveEnvelope = Parameters<ProjectStoreFs['save']>[1];

export function createCoreAgentStore(projects: ProjectStoreFs, leases: LeaseManager): AgentProjectStore {
	return {
		async load(projectId: string): Promise<StoredEnvelope | null> {
			try {
				const { envelope, revision } = await projects.get(projectId);
				return { envelope: envelope as unknown as Record<string, unknown>, revision };
			} catch (e) {
				if (e instanceof ProjectError && e.code === 'PROJECT_NOT_FOUND') return null;
				throw e;
			}
		},
		async save(
			projectId: string,
			envelope: Record<string, unknown>,
			baseRevision: number,
		): Promise<SaveOutcome> {
			try {
				const { revision } = await projects.save(
					projectId,
					envelope as unknown as SaveEnvelope,
					baseRevision,
				);
				return { ok: true, revision };
			} catch (e) {
				if (e instanceof ProjectError && e.code === 'REVISION_CONFLICT') {
					const current = (e.detail as { revision?: number } | undefined)?.revision;
					return { ok: false, conflict: true, revision: current ?? baseRevision };
				}
				throw e;
			}
		},
		leaseHolder(projectId: string): LeaseInfo | null {
			const l = leases.get(projectId);
			return l ? { sessionId: l.sessionId, leaseId: l.leaseId, expiresAt: l.expiresAt } : null;
		},
	};
}
