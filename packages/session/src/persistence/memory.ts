// In-memory ProjectStore (tests, headless tools). Same semantics as the engine store: envelopes,
// revisions with If-Match style conflicts, versions, single-writer leases and crash-recovery journals (a journal
// is held while its session holds the lease; `expireLease` simulates a crashed editor).
import type { Lease, ProjectSummary, RecoveryInfo, VersionInfo } from '@jasper/api';
import {
	createEmptyProject,
	createRandomIdSource,
	type IdSource,
	loadProject,
	type MgTemplateRegistry,
	makeEnvelope,
	type ProjectDocument,
	type ProjectEnvelope,
} from '@jasper/project';
import {
	LeaseHeldError,
	type OpenedProject,
	type ProjectStore,
	type ProjectViewState,
	type RecoveredSnapshot,
	type RecoveryStore,
	type RecoveryWrite,
	type SaveResult,
} from './types.ts';

type Entry = {
	envelope: ProjectEnvelope;
	view: ProjectViewState | null;
	versions: { info: VersionInfo; envelope: ProjectEnvelope }[];
	lease: Lease | null;
	/** Versions kept so far (ids `v1`, `v2`… stay unique when old ones drop off). */
	versionCount: number;
	journals: Map<string, { info: Omit<RecoveryInfo, 'projectRevision'>; document: ProjectDocument }>;
};

export class MemoryProjectStore implements ProjectStore, RecoveryStore {
	private readonly projects = new Map<string, Entry>();
	readonly ids: IdSource;
	private readonly mgTemplates: MgTemplateRegistry | undefined;
	private readonly now: () => string;

	/** `mgTemplates` re-stamps template renderers that contradict the registry on load (S11:ATP-002). */
	constructor(opts: { ids?: IdSource; now?: () => string; mgTemplates?: MgTemplateRegistry } = {}) {
		this.ids = opts.ids ?? createRandomIdSource();
		this.mgTemplates = opts.mgTemplates;
		this.now = opts.now ?? (() => new Date().toISOString());
	}

	/** Seeds a document directly (tests). */
	put(doc: ProjectDocument, revision = 0): void {
		this.projects.set(doc.projectId, {
			envelope: makeEnvelope(doc, { revision, savedAt: this.now(), platform: 'memory' }),
			view: null,
			versions: [],
			lease: null,
			versionCount: 0,
			journals: new Map(),
		});
	}

	private entry(projectId: string): Entry {
		const e = this.projects.get(projectId);
		if (!e) throw new Error(`Project not found: ${projectId}`);
		return e;
	}

	async list(): Promise<ProjectSummary[]> {
		return [...this.projects.values()].map((e) => ({
			projectId: e.envelope.document.projectId,
			name: e.envelope.document.name,
			modifiedAt: e.envelope.savedAt,
			thumbnail: null,
			schemaVersion: e.envelope.schemaVersion,
			sizeBytes: JSON.stringify(e.envelope).length,
			revision: e.envelope.revision,
		}));
	}
	async create(init: { name: string; preset: string }): Promise<string> {
		const doc = createEmptyProject({ ids: this.ids, name: init.name, preset: init.preset });
		this.put(doc);
		return doc.projectId;
	}
	async open(projectId: string, opts: { readOnly?: boolean } = {}): Promise<OpenedProject> {
		const e = this.entry(projectId);
		const loaded = loadProject(JSON.parse(JSON.stringify(e.envelope)), {
			ids: this.ids,
			mgTemplates: this.mgTemplates,
		});
		return {
			document: loaded.document,
			revision: e.envelope.revision,
			view: e.view,
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
		const e = this.entry(projectId);
		if (e.envelope.revision !== meta.baseRevision)
			return { ok: false, conflict: true, revision: e.envelope.revision };
		this.keepVersion(e, 'auto');
		e.envelope = makeEnvelope(doc, { revision: meta.revision, savedAt: this.now(), platform: 'memory' });
		return { ok: true, revision: meta.revision };
	}
	private keepVersion(e: Entry, kind: 'auto' | 'before-restore'): string {
		e.versionCount++;
		const versionId = `v${e.versionCount}`;
		e.versions.push({
			info: {
				versionId,
				savedAt: e.envelope.savedAt,
				revision: e.envelope.revision,
				sizeBytes: 0,
				kind,
				schemaVersion: e.envelope.schemaVersion,
			},
			envelope: e.envelope,
		});
		if (e.versions.length > 20) e.versions.shift();
		return versionId;
	}
	async saveView(projectId: string, view: ProjectViewState): Promise<void> {
		this.entry(projectId).view = view;
	}
	async listVersions(projectId: string): Promise<VersionInfo[]> {
		return this.entry(projectId).versions.map((v) => v.info);
	}
	async restoreVersion(projectId: string, versionId: string): Promise<string> {
		const v = this.entry(projectId).versions.find((x) => x.info.versionId === versionId);
		if (!v) throw new Error(`Version not found: ${versionId}`);
		return this.copyAs(v.envelope.document, `${v.envelope.document.name} (restored)`);
	}
	async saveDocumentAs(doc: ProjectDocument, name: string): Promise<string> {
		return this.copyAs(doc, name);
	}
	async revertToVersion(projectId: string, versionId: string, leaseId?: string): Promise<number> {
		const e = this.entry(projectId);
		const v = e.versions.find((x) => x.info.versionId === versionId);
		if (!v) throw new Error(`Version not found: ${versionId}`);
		if (e.lease && e.lease.leaseId !== leaseId && Date.parse(e.lease.expiresAt) > Date.now())
			throw new LeaseHeldError(projectId, e.lease.sessionId, e.lease.expiresAt);
		this.keepVersion(e, 'before-restore');
		const revision = e.envelope.revision + 1;
		e.envelope = { ...v.envelope, revision, savedAt: this.now() };
		return revision;
	}

	// ------------------------------------------------------------ crash recovery (S01:PER-021)

	private held(e: Entry, sessionId: string): boolean {
		return !!e.lease && e.lease.sessionId === sessionId && Date.parse(e.lease.expiresAt) > Date.now();
	}
	async writeRecovery(projectId: string, sessionId: string, w: RecoveryWrite): Promise<void> {
		const e = this.entry(projectId);
		if (!e.lease || e.lease.leaseId !== w.leaseId || e.lease.sessionId !== sessionId)
			throw new Error('Lease not held');
		const prev = e.journals.get(sessionId);
		const now = this.now();
		e.journals.set(sessionId, {
			info: {
				sessionId,
				projectId,
				projectName: w.document.name,
				baseRevision: w.baseRevision,
				revision: w.revision,
				startedAt: prev?.info.startedAt ?? now,
				savedAt: now,
				changes: w.changes.slice(-50),
				changeCount: w.changeCount,
				sizeBytes: JSON.stringify(w.document).length,
			},
			document: JSON.parse(JSON.stringify(w.document)),
		});
	}
	async listRecovery(projectId: string): Promise<RecoveryInfo[]> {
		const e = this.entry(projectId);
		const saved = JSON.stringify(e.envelope.document);
		const out: RecoveryInfo[] = [];
		for (const [sid, j] of e.journals) {
			if (this.held(e, sid)) continue;
			if (JSON.stringify(j.document) === saved) {
				e.journals.delete(sid);
				continue;
			}
			out.push({ ...j.info, projectRevision: e.envelope.revision });
		}
		return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
	}
	async readRecovery(projectId: string, sessionId: string): Promise<RecoveredSnapshot> {
		const e = this.entry(projectId);
		const j = e.journals.get(sessionId);
		if (!j || this.held(e, sessionId)) throw new Error('No unsaved changes to recover for that session');
		const loaded = loadProject(JSON.parse(JSON.stringify(j.document)), {
			ids: this.ids,
			mgTemplates: this.mgTemplates,
		});
		return {
			info: { ...j.info, projectRevision: e.envelope.revision },
			document: loaded.document,
			repairs: loaded.repairs,
		};
	}
	async discardRecovery(projectId: string, sessionId: string, leaseId?: string): Promise<void> {
		const e = this.entry(projectId);
		const own = !!leaseId && e.lease?.leaseId === leaseId;
		if (!own && this.held(e, sessionId)) throw new Error('That session is still editing');
		e.journals.delete(sessionId);
	}
	/** Tests: the editor holding the lease crashed (its lease expired without a release). */
	expireLease(projectId: string): void {
		this.entry(projectId).lease = null;
	}
	/** Tests: the journal a session wrote, if any. */
	journalOf(projectId: string, sessionId: string): { changes: string[]; document: ProjectDocument } | null {
		const j = this.entry(projectId).journals.get(sessionId);
		return j ? { changes: j.info.changes, document: j.document } : null;
	}

	async duplicate(projectId: string, name: string): Promise<string> {
		return this.copyAs(this.entry(projectId).envelope.document, name);
	}
	private copyAs(doc: ProjectDocument, name: string): string {
		const copy = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
		copy.projectId = this.ids.next('prj');
		copy.name = name;
		this.put(copy);
		return copy.projectId;
	}
	async delete(projectId: string): Promise<void> {
		this.projects.delete(projectId);
	}
	async exportFile(projectId: string): Promise<Blob> {
		return new Blob([JSON.stringify(this.entry(projectId).envelope)], { type: 'application/json' });
	}
	async importFile(file: Blob | { path: string }): Promise<string> {
		if (!(file instanceof Blob)) throw new Error('MemoryProjectStore imports Blobs only');
		const loaded = loadProject(JSON.parse(await file.text()), {
			ids: this.ids,
			mgTemplates: this.mgTemplates,
		});
		return this.copyAs(loaded.document, loaded.document.name);
	}
	async acquireLease(
		projectId: string,
		sessionId = 'session',
		opts: { takeOver?: boolean } = {},
	): Promise<Lease> {
		const e = this.entry(projectId);
		const now = Date.now();
		if (!opts.takeOver && e.lease && e.lease.sessionId !== sessionId && Date.parse(e.lease.expiresAt) > now) {
			throw new LeaseHeldError(projectId, e.lease.sessionId, e.lease.expiresAt);
		}
		e.lease = {
			leaseId: `lease_${sessionId}`,
			projectId,
			sessionId,
			acquiredAt: new Date(now).toISOString(),
			expiresAt: new Date(now + 30_000).toISOString(),
			heartbeatMs: 10_000,
		};
		return e.lease;
	}
	async heartbeatLease(projectId: string, leaseId: string): Promise<Lease> {
		const e = this.entry(projectId);
		if (!e.lease || e.lease.leaseId !== leaseId) throw new Error('Lease not held');
		e.lease = { ...e.lease, expiresAt: new Date(Date.now() + 30_000).toISOString() };
		return e.lease;
	}
	async releaseLease(projectId: string, leaseId: string): Promise<void> {
		const e = this.entry(projectId);
		if (e.lease?.leaseId === leaseId) e.lease = null;
	}
}
