// EngineProjectStore (ARCHITECTURE D-08, §6): the ProjectStore over the engine HTTP API.
// WP-00 ships the straightforward operations; WP-2E owns this file and completes it (versions restore,
// duplicate, import/export, 409 conflict UX, lease heartbeats).
import type { Lease, ProjectSummary, VersionInfo } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import {
	createRandomIdSource,
	type IdSource,
	loadProject,
	makeEnvelope,
	type ProjectDocument,
} from '@jasper/project';
import {
	LeaseHeldError,
	type OpenedProject,
	type ProjectStore,
	type ProjectViewState,
	type SaveResult,
} from './types.ts';

const notYet = (what: string) => new Error(`EngineProjectStore.${what} is not implemented yet (WP-2E)`);

export class EngineProjectStore implements ProjectStore {
	private readonly ids: IdSource;
	constructor(
		private readonly engine: EngineClient,
		opts: { ids?: IdSource; platform?: string } = {},
	) {
		this.ids = opts.ids ?? createRandomIdSource();
		this.platform = opts.platform ?? 'web';
	}
	private readonly platform: string;

	async list(): Promise<ProjectSummary[]> {
		return (await this.engine.listProjects()).projects;
	}
	async create(init: { name: string; preset: string }): Promise<string> {
		return (await this.engine.createProject(init)).projectId;
	}
	async open(projectId: string, opts: { readOnly?: boolean } = {}): Promise<OpenedProject> {
		const r = await this.engine.getProject(projectId);
		const loaded = loadProject(r.envelope, { ids: this.ids });
		return {
			document: loaded.document,
			revision: r.revision,
			view: (r.view as ProjectViewState | null) ?? null,
			lease: null,
			readOnly: loaded.readOnly || !!opts.readOnly,
			repairs: loaded.repairs,
			issues: loaded.issues,
		};
	}
	async save(
		projectId: string,
		doc: ProjectDocument,
		meta: { revision: number; baseRevision: number },
	): Promise<SaveResult> {
		const envelope = makeEnvelope(doc, {
			revision: meta.revision,
			savedAt: new Date().toISOString(),
			platform: this.platform,
		});
		try {
			const r = await this.engine.putProject(projectId, envelope, meta.baseRevision);
			return { ok: true, revision: r.revision };
		} catch (e) {
			if (e instanceof EngineError && e.code === 'REVISION_CONFLICT') {
				const rev = (e.detail as { revision?: number } | undefined)?.revision ?? -1;
				return { ok: false, conflict: true, revision: rev };
			}
			throw e;
		}
	}
	async saveView(projectId: string, view: ProjectViewState): Promise<void> {
		await this.engine.putView(projectId, view);
	}
	async listVersions(projectId: string): Promise<VersionInfo[]> {
		return (await this.engine.listVersions(projectId)).versions;
	}
	async restoreVersion(): Promise<string> {
		throw notYet('restoreVersion');
	}
	async duplicate(): Promise<string> {
		throw notYet('duplicate');
	}
	async delete(projectId: string): Promise<void> {
		await this.engine.deleteProject(projectId);
	}
	async exportFile(): Promise<Blob> {
		throw notYet('exportFile');
	}
	async importFile(): Promise<string> {
		throw notYet('importFile');
	}
	async acquireLease(projectId: string, sessionId = crypto.randomUUID()): Promise<Lease> {
		try {
			return await this.engine.acquireLease(projectId, sessionId);
		} catch (e) {
			if (e instanceof EngineError && e.code === 'LEASE_HELD') {
				throw new LeaseHeldError(
					projectId,
					(e.detail as { holderSessionId?: string } | undefined)?.holderSessionId ?? 'unknown',
				);
			}
			throw e;
		}
	}
	async heartbeatLease(projectId: string, leaseId: string): Promise<Lease> {
		return this.engine.heartbeatLease(projectId, leaseId);
	}
	async releaseLease(projectId: string, leaseId: string): Promise<void> {
		await this.engine.releaseLease(projectId, leaseId);
	}
}
