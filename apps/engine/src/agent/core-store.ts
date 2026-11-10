import type { EnvelopeJson } from '@jasper/api';
import type { LeaseManager } from '../projects/leases.ts';
import { ProjectError, type ProjectStoreFs } from '../projects/store.ts';
import type { AgentProjectStore, LeaseInfo, SaveOutcome, StoredEnvelope } from './store.ts';

export function createCoreAgentStore(projects: ProjectStoreFs, leases: LeaseManager): AgentProjectStore {
	return {
		async load(projectId: string): Promise<StoredEnvelope | null> {
			try {
				const { envelope, revision } = await projects.get(projectId);
				return { envelope, revision };
			} catch (e) {
				if (e instanceof ProjectError && e.code === 'PROJECT_NOT_FOUND') return null;
				throw e;
			}
		},
		async save(
			projectId: string,
			envelope: EnvelopeJson,
			baseRevision: number,
			opts: { unleased?: boolean } = {},
		): Promise<SaveOutcome> {
			try {
				const { revision } = await projects.save(projectId, envelope, baseRevision, opts);
				return { ok: true, revision };
			} catch (e) {
				if (e instanceof ProjectError && e.code === 'REVISION_CONFLICT') {
					const current = (e.detail as { revision?: number } | undefined)?.revision;
					return { ok: false, conflict: true, revision: current ?? baseRevision };
				}
				if (e instanceof ProjectError && e.code === 'LEASE_HELD') {
					const holder = (e.detail as { holderSessionId?: string } | undefined)?.holderSessionId;
					return { ok: false, leaseHeld: true, sessionId: holder ?? '?' };
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
