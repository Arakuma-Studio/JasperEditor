// EngineProjectStore (ARCHITECTURE D-08, §6, §9.2): the S01:PER-001 ProjectStore over the engine HTTP API.
// - save: `PUT /api/projects/:pid` with `If-Match: <baseRevision>`; a 409 REVISION_CONFLICT becomes a
//   `{ok: false, conflict: true, revision}` result (S01:PER-025) instead of an exception.
// - leases (S01:PER-040): acquire / heartbeat / release, with transparent re-acquisition when the engine
//   forgot the lease (restart, expiry while the laptop slept) and "take over" support.
// - duplicate / export / import are composed client-side from the M1 routes;
// - saved versions (read, restore in place or as a copy) and the crash-recovery journal use the routes of the
//   process workstream (ARCHITECTURE D-39, docs/project-files.md).
import type { Lease, ProjectSummary, RecoveryInfo, VersionInfo } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import {
	createRandomIdSource,
	loadProject,
	type MgTemplateRegistry,
	makeEnvelope,
	type ProjectDocument,
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

export type EngineProjectStoreOptions = {
	/** Re-stamps template renderers that contradict the registry on load (S11:ATP-002). */
	mgTemplates?: MgTemplateRegistry;
	/** `savedBy.platform` written into envelopes (`web` | `desktop` | `pwa`). */
	platform?: string;
	appVersion?: string;
};

type LeaseRecord = {
	sessionId: string;
	lease: Lease;
	/** Earlier lease ids of the same session (the session keeps heartbeating with its first id). */
	aliases: Set<string>;
};

/** Session ids holding (or releasing) leases from this page; see acquireLease. */
const TAB_SESSIONS = new Set<string>();
const LOCAL_RELEASE_RETRIES = 20;
const LOCAL_RELEASE_WAIT_MS = 150;

const isCode = (e: unknown, ...codes: string[]): e is EngineError =>
	e instanceof EngineError && codes.includes(e.code);

function randomSessionId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	return c?.randomUUID ? c.randomUUID() : `ses_${Math.random().toString(36).slice(2, 14)}`;
}

export class EngineProjectStore implements ProjectStore, RecoveryStore {
	private readonly ids = createRandomIdSource();
	private readonly mgTemplates: MgTemplateRegistry | undefined;
	private readonly platform: string;
	private readonly appVersion: string | undefined;
	private readonly leases = new Map<string, LeaseRecord>();
	private readonly unloadTarget: EventTarget | null;
	private readonly keepaliveFetch: typeof fetch | undefined;
	/** The `pagehide` listener is attached only while this store holds leases (no leak per store instance). */
	private unloadAttached = false;
	private readonly onPageHide = () => {
		if (this.keepaliveFetch) this.releaseAllKeepalive(this.keepaliveFetch);
	};

	constructor(
		readonly engine: EngineClient,
		opts: EngineProjectStoreOptions = {},
	) {
		this.mgTemplates = opts.mgTemplates;
		this.platform = opts.platform ?? 'web';
		this.appVersion = opts.appVersion;
		this.unloadTarget = (globalThis as { window?: EventTarget }).window ?? null;
		this.keepaliveFetch = globalThis.fetch as typeof fetch | undefined;
	}

	/** Attaches the pagehide release while leases are held and detaches it when the last one goes. */
	private syncUnloadListener(): void {
		const want = this.leases.size > 0;
		if (want === this.unloadAttached || !this.unloadTarget) return;
		if (want) this.unloadTarget.addEventListener('pagehide', this.onPageHide);
		else this.unloadTarget.removeEventListener('pagehide', this.onPageHide);
		this.unloadAttached = want;
	}

	private envelope(doc: ProjectDocument, revision: number) {
		return makeEnvelope(doc, {
			revision,
			savedAt: new Date().toISOString(),
			platform: this.platform,
			...(this.appVersion ? { appVersion: this.appVersion } : {}),
		});
	}

	// ------------------------------------------------------------ projects

	async list(): Promise<ProjectSummary[]> {
		const { projects } = await this.engine.listProjects();
		return [...projects].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
	}

	async create(init: { name: string; preset: string }): Promise<string> {
		return (await this.engine.createProject(init)).projectId;
	}

	async open(projectId: string, opts: { readOnly?: boolean } = {}): Promise<OpenedProject> {
		const r = await this.engine.getProject(projectId);
		const loaded = loadProject(r.envelope, { ids: this.ids, mgTemplates: this.mgTemplates });
		const held = this.leases.get(projectId);
		return {
			document: loaded.document,
			revision: r.revision,
			view: (r.view as ProjectViewState | null) ?? null,
			lease: held?.lease ?? null,
			// Newer schema → read-only (S01:MIG-003); callers may also ask for read-only explicitly.
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
		try {
			const r = await this.engine.putProject(projectId, this.envelope(doc, meta.revision), meta.baseRevision);
			return { ok: true, revision: r.revision };
		} catch (e) {
			if (isCode(e, 'REVISION_CONFLICT')) {
				const rev = (e.detail as { revision?: number } | undefined)?.revision;
				return { ok: false, conflict: true, revision: typeof rev === 'number' ? rev : -1 };
			}
			throw e;
		}
	}

	async saveView(projectId: string, view: ProjectViewState): Promise<void> {
		await this.engine.putView(projectId, view);
	}

	async listVersions(projectId: string): Promise<VersionInfo[]> {
		const { versions } = await this.engine.listVersions(projectId);
		return [...versions].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
	}

	/** S01:PER-001: restores a saved version as a new project copy; returns its id. */
	async restoreVersion(projectId: string, versionId: string): Promise<string> {
		return (await this.engine.restoreVersion(projectId, versionId, { mode: 'copy' })).projectId;
	}

	/** Writes a saved version over the project (the engine keeps the replaced state as a version). */
	async revertToVersion(projectId: string, versionId: string, leaseId?: string): Promise<number> {
		const r = await this.engine.restoreVersion(projectId, versionId, {
			mode: 'replace',
			...(leaseId ? { leaseId } : {}),
		});
		return r.revision;
	}

	async saveDocumentAs(doc: ProjectDocument, name: string): Promise<string> {
		return this.createFrom(doc, name);
	}

	// ------------------------------------------------------------ crash recovery (S01:PER-021, AC-18)

	async writeRecovery(projectId: string, sessionId: string, w: RecoveryWrite): Promise<void> {
		await this.engine.putRecovery(projectId, sessionId, {
			leaseId: w.leaseId,
			baseRevision: w.baseRevision,
			revision: w.revision,
			changes: w.changes,
			changeCount: w.changeCount,
			envelope: this.envelope(w.document, w.revision),
		});
	}

	async listRecovery(projectId: string): Promise<RecoveryInfo[]> {
		return (await this.engine.listRecovery(projectId)).candidates;
	}

	async readRecovery(projectId: string, sessionId: string): Promise<RecoveredSnapshot> {
		const r = await this.engine.getRecovery(projectId, sessionId);
		const loaded = loadProject(r.envelope, { ids: this.ids, mgTemplates: this.mgTemplates });
		if (loaded.readOnly)
			throw new EngineError('VALIDATION_FAILED', 'The unsaved changes were made by a newer JasperEditor');
		return { info: r.candidate, document: loaded.document, repairs: loaded.repairs };
	}

	async discardRecovery(projectId: string, sessionId: string, leaseId?: string): Promise<void> {
		try {
			await this.engine.deleteRecovery(projectId, sessionId, leaseId);
		} catch (e) {
			if (!isCode(e, 'NOT_FOUND', 'PROJECT_NOT_FOUND')) throw e;
		}
	}

	async duplicate(projectId: string, name: string): Promise<string> {
		const r = await this.engine.getProject(projectId);
		const loaded = loadProject(r.envelope, { ids: this.ids, mgTemplates: this.mgTemplates });
		return this.createFrom(loaded.document, name);
	}

	async delete(projectId: string): Promise<void> {
		const held = this.leases.get(projectId);
		if (held) await this.releaseLease(projectId, held.lease.leaseId);
		await this.engine.deleteProject(projectId);
	}

	/** PER-030: the envelope as a single `.jasper` JSON blob. */
	async exportFile(projectId: string): Promise<Blob> {
		const r = await this.engine.getProject(projectId);
		return new Blob([JSON.stringify(r.envelope, null, '\t')], { type: 'application/json' });
	}

	/** PER-030: reads a `.jasper` file, migrates it and creates a new engine project from it. */
	async importFile(file: Blob | { path: string }): Promise<string> {
		if (!(file instanceof Blob)) {
			throw new EngineError(
				'NOT_IMPLEMENTED',
				'Importing a project by path needs the desktop file route (M2)',
			);
		}
		let raw: unknown;
		try {
			raw = JSON.parse(await file.text());
		} catch {
			throw new EngineError('BAD_REQUEST', 'The file is not a JasperEditor project (invalid JSON)');
		}
		const loaded = loadProject(raw, { ids: this.ids, mgTemplates: this.mgTemplates });
		return this.createFrom(loaded.document, loaded.document.name);
	}

	/** Creates an engine project and replaces its document with `doc` (new project id, given name). */
	private async createFrom(doc: ProjectDocument, name: string): Promise<string> {
		const preset = doc.settings?.defaultSequencePreset ?? 'hd-1080p-30';
		const projectId = await this.create({ name, preset });
		const fresh = await this.engine.getProject(projectId);
		const copy = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
		copy.projectId = projectId;
		copy.name = name;
		await this.engine.putProject(projectId, this.envelope(copy, fresh.revision + 1), fresh.revision);
		return projectId;
	}

	// ------------------------------------------------------------ leases (S01:PER-040)

	async acquireLease(
		projectId: string,
		sessionId: string = randomSessionId(),
		opts: { takeOver?: boolean; refresh?: boolean } = {},
	): Promise<Lease> {
		const held = this.leases.get(projectId);
		// Already ours (e.g. taken over just before the session re-opens with the same session id).
		if (
			held &&
			held.sessionId === sessionId &&
			!opts.takeOver &&
			!opts.refresh &&
			Date.parse(held.lease.expiresAt) > Date.now()
		)
			return held.lease;
		let lease: Lease | null = null;
		for (let attempt = 0; lease === null; attempt++) {
			try {
				lease = opts.takeOver
					? await this.engine.call('leaseAcquire', {
							params: { projectId },
							body: { sessionId, takeOver: true },
						})
					: await this.engine.acquireLease(projectId, sessionId);
			} catch (e) {
				if (!isCode(e, 'LEASE_HELD')) throw e;
				const d = (e.detail ?? {}) as { holderSessionId?: string; expiresAt?: string };
				const holder = d.holderSessionId ?? 'unknown';
				// A session of this same page is closing (route change, React StrictMode double mount):
				// its release is in flight, so wait for it instead of opening read-only.
				if (!opts.takeOver && TAB_SESSIONS.has(holder) && attempt < LOCAL_RELEASE_RETRIES) {
					await new Promise((resolve) => setTimeout(resolve, LOCAL_RELEASE_WAIT_MS));
					continue;
				}
				throw new LeaseHeldError(projectId, holder, d.expiresAt ?? null);
			}
		}
		TAB_SESSIONS.add(sessionId);
		const aliases = new Set(
			held && held.sessionId === sessionId ? [...held.aliases, held.lease.leaseId] : [],
		);
		this.leases.set(projectId, { sessionId, lease, aliases });
		this.syncUnloadListener();
		return lease;
	}

	/**
	 * Heartbeat (every `lease.heartbeatMs`). When the engine no longer knows the lease (restart, expiry) the
	 * store re-acquires it for the same session; when someone else holds it now, `LeaseHeldError` is thrown
	 * (the session then shows "lost"). Network failures keep the last lease: the engine is unreachable, not
	 * contested, and the next heartbeat after reconnecting repairs the state.
	 */
	async heartbeatLease(projectId: string, leaseId: string): Promise<Lease> {
		const rec = this.leases.get(projectId);
		const current = rec && (rec.lease.leaseId === leaseId || rec.aliases.has(leaseId)) ? rec.lease : null;
		try {
			const lease = await this.engine.heartbeatLease(projectId, current?.leaseId ?? leaseId);
			if (rec && current) rec.lease = lease;
			return lease;
		} catch (e) {
			if (isCode(e, 'NETWORK') && current) return current;
			if (isCode(e, 'LEASE_NOT_FOUND', 'NOT_FOUND') && rec && current) {
				try {
					return await this.acquireLease(projectId, rec.sessionId, { refresh: true });
				} catch (e2) {
					if (e2 instanceof LeaseHeldError) {
						this.leases.delete(projectId);
						this.syncUnloadListener();
					}
					throw e2;
				}
			}
			if (isCode(e, 'LEASE_HELD')) {
				this.leases.delete(projectId);
				this.syncUnloadListener();
				const d = (e.detail ?? {}) as { holderSessionId?: string; expiresAt?: string };
				throw new LeaseHeldError(projectId, d.holderSessionId ?? 'unknown', d.expiresAt ?? null);
			}
			throw e;
		}
	}

	/** Fire-and-forget release of every held lease that survives page unload (`keepalive`). */
	private releaseAllKeepalive(fetchImpl: typeof fetch): void {
		for (const [projectId, rec] of this.leases) {
			const url = this.engine.url(
				`/api/projects/${encodeURIComponent(projectId)}/lease/${encodeURIComponent(rec.lease.leaseId)}`,
			);
			try {
				void fetchImpl(url, {
					method: 'DELETE',
					keepalive: true,
					credentials: 'include',
					// Token-only auth (no cookie) needs the bearer header too, or the lease just expires.
					headers: this.engine.authorizationHeaders(),
				}).catch(() => undefined);
			} catch {
				// unload: nothing else to do
			}
			TAB_SESSIONS.delete(rec.sessionId);
		}
		this.leases.clear();
		this.syncUnloadListener();
	}

	async releaseLease(projectId: string, leaseId: string): Promise<void> {
		const rec = this.leases.get(projectId);
		const current =
			rec && (rec.lease.leaseId === leaseId || rec.aliases.has(leaseId)) ? rec.lease.leaseId : leaseId;
		if (rec && current === rec.lease.leaseId) {
			this.leases.delete(projectId);
			this.syncUnloadListener();
		}
		try {
			await this.engine.releaseLease(projectId, current);
		} catch (e) {
			if (!isCode(e, 'LEASE_NOT_FOUND', 'NOT_FOUND', 'NETWORK')) throw e;
		} finally {
			if (rec) TAB_SESSIONS.delete(rec.sessionId);
		}
	}
}
