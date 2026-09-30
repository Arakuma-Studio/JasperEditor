// EngineProjectStore (ARCHITECTURE D-08, §6, §9.2): the S01:PER-001 ProjectStore over the engine HTTP API.
// - save: `PUT /api/projects/:pid` with `If-Match: <baseRevision>`; a 409 REVISION_CONFLICT becomes a
//   `{ok: false, conflict: true, revision}` result (S01:PER-025) instead of an exception.
// - leases (S01:PER-040): acquire / heartbeat / release, with transparent re-acquisition when the engine
//   forgot the lease (restart, expiry while the laptop slept) and "take over" support.
// - duplicate / export / import are composed client-side from the M1 routes; restoring a version needs a
//   route that M1 does not have (see docs/wp-notes/WP-2E.md).
import type { EnvelopeJson, Lease, ProjectSummary, VersionInfo } from '@jasper/api';
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

export type EngineProjectStoreOptions = {
	ids?: IdSource;
	/** `savedBy.platform` written into envelopes (`web` | `desktop` | `pwa`). */
	platform?: string;
	appVersion?: string;
	now?: () => Date;
	/** Session id generator for leases taken without an explicit id. */
	newSessionId?: () => string;
};

type LeaseRecord = {
	sessionId: string;
	lease: Lease;
	/** Earlier lease ids of the same session (the session keeps heartbeating with its first id). */
	aliases: Set<string>;
};

const isCode = (e: unknown, ...codes: string[]): e is EngineError =>
	e instanceof EngineError && codes.includes(e.code);

function randomSessionId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	return c?.randomUUID ? c.randomUUID() : `ses_${Math.random().toString(36).slice(2, 14)}`;
}

export class EngineProjectStore implements ProjectStore {
	private readonly ids: IdSource;
	private readonly platform: string;
	private readonly appVersion: string | undefined;
	private readonly now: () => Date;
	private readonly newSessionId: () => string;
	private readonly leases = new Map<string, LeaseRecord>();

	constructor(
		readonly engine: EngineClient,
		opts: EngineProjectStoreOptions = {},
	) {
		this.ids = opts.ids ?? createRandomIdSource();
		this.platform = opts.platform ?? 'web';
		this.appVersion = opts.appVersion;
		this.now = opts.now ?? (() => new Date());
		this.newSessionId = opts.newSessionId ?? randomSessionId;
	}

	private envelope(doc: ProjectDocument, revision: number) {
		return makeEnvelope(doc, {
			revision,
			savedAt: this.now().toISOString(),
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
		const loaded = loadProject(r.envelope, { ids: this.ids });
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

	async restoreVersion(projectId: string, versionId: string): Promise<string> {
		// TODO(WP-2F/M2): needs `GET /api/projects/:pid/versions/:versionId` (not in the M1 route table).
		throw new EngineError(
			'NOT_IMPLEMENTED',
			`Restoring version ${versionId} of ${projectId} needs an engine route that arrives after M1`,
		);
	}

	async duplicate(projectId: string, name: string): Promise<string> {
		const r = await this.engine.getProject(projectId);
		const loaded = loadProject(r.envelope, { ids: this.ids });
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
		const loaded = loadProject(raw, { ids: this.ids });
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
		await this.engine.putProject(
			projectId,
			this.envelope(copy, fresh.revision + 1) as unknown as EnvelopeJson,
			fresh.revision,
		);
		return projectId;
	}

	// ------------------------------------------------------------ leases (S01:PER-040)

	/** The lease this store holds for a project (if any). */
	heldLease(projectId: string): Lease | null {
		return this.leases.get(projectId)?.lease ?? null;
	}

	async acquireLease(
		projectId: string,
		sessionId: string = this.newSessionId(),
		opts: { takeOver?: boolean; refresh?: boolean } = {},
	): Promise<Lease> {
		const held = this.leases.get(projectId);
		// Already ours (e.g. taken over just before the session re-opens with the same session id).
		if (
			held &&
			held.sessionId === sessionId &&
			!opts.takeOver &&
			!opts.refresh &&
			Date.parse(held.lease.expiresAt) > this.now().getTime()
		)
			return held.lease;
		let lease: Lease;
		try {
			lease = opts.takeOver
				? await this.engine.call('leaseAcquire', {
						params: { projectId },
						body: { sessionId, takeOver: true },
					})
				: await this.engine.acquireLease(projectId, sessionId);
		} catch (e) {
			if (isCode(e, 'LEASE_HELD')) {
				const d = (e.detail ?? {}) as { holderSessionId?: string; expiresAt?: string };
				throw new LeaseHeldError(projectId, d.holderSessionId ?? 'unknown', d.expiresAt ?? null);
			}
			throw e;
		}
		const aliases = new Set(
			held && held.sessionId === sessionId ? [...held.aliases, held.lease.leaseId] : [],
		);
		this.leases.set(projectId, { sessionId, lease, aliases });
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
					if (e2 instanceof LeaseHeldError) this.leases.delete(projectId);
					throw e2;
				}
			}
			if (isCode(e, 'LEASE_HELD')) {
				this.leases.delete(projectId);
				const d = (e.detail ?? {}) as { holderSessionId?: string; expiresAt?: string };
				throw new LeaseHeldError(projectId, d.holderSessionId ?? 'unknown', d.expiresAt ?? null);
			}
			throw e;
		}
	}

	async releaseLease(projectId: string, leaseId: string): Promise<void> {
		const rec = this.leases.get(projectId);
		const current =
			rec && (rec.lease.leaseId === leaseId || rec.aliases.has(leaseId)) ? rec.lease.leaseId : leaseId;
		if (rec && current === rec.lease.leaseId) this.leases.delete(projectId);
		try {
			await this.engine.releaseLease(projectId, current);
		} catch (e) {
			if (!isCode(e, 'LEASE_NOT_FOUND', 'NOT_FOUND', 'NETWORK')) throw e;
		}
	}
}
