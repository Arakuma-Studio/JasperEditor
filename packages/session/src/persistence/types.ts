// ProjectStore interface, exactly S01:PER-001 (WP-2E owns this folder after WP-00).
import type { Lease, ProjectSummary, VersionInfo } from '@jasper/api';
import type { Issue, ProjectDocument, RepairEntry } from '@jasper/project';

export type { Lease, ProjectSummary, VersionInfo };

/** Persisted, non-undoable view record (S01:SES-004). */
export type ProjectViewState = {
	version: 1;
	views: Record<string, unknown>;
	tabs: { open: string[] };
	activeSequenceId: string | null;
	[k: string]: unknown;
};

export type OpenedProject = {
	document: ProjectDocument;
	revision: number;
	view: ProjectViewState | null;
	lease: Lease | null;
	readOnly: boolean;
	repairs: RepairEntry[];
	issues: Issue[];
};

export type SaveResult = { ok: true; revision: number } | { ok: false; conflict: true; revision: number };

export interface ProjectStore {
	list(): Promise<ProjectSummary[]>;
	create(init: { name: string; preset: string }): Promise<string>;
	open(projectId: string, opts?: { readOnly?: boolean }): Promise<OpenedProject>;
	save(
		projectId: string,
		doc: ProjectDocument,
		meta: { revision: number; baseRevision: number },
	): Promise<SaveResult>;
	saveView(projectId: string, view: ProjectViewState): Promise<void>;
	listVersions(projectId: string): Promise<VersionInfo[]>;
	restoreVersion(projectId: string, versionId: string): Promise<string>;
	duplicate(projectId: string, name: string): Promise<string>;
	delete(projectId: string): Promise<void>;
	exportFile(projectId: string): Promise<Blob | { path: string }>;
	importFile(file: Blob | { path: string }): Promise<string>;
	/** `takeOver` revokes another session's lease ("Take over editing", S01:PER-040). */
	acquireLease(projectId: string, sessionId?: string, opts?: { takeOver?: boolean }): Promise<Lease>;
	/** Heartbeat / release (engine leases, S01:PER-040). Optional for stores without leases. */
	heartbeatLease?(projectId: string, leaseId: string): Promise<Lease>;
	releaseLease?(projectId: string, leaseId: string): Promise<void>;
}

export class LeaseHeldError extends Error {
	constructor(
		readonly projectId: string,
		readonly holderSessionId: string,
		/** When the holder's lease expires unless it heartbeats again (engine leases). */
		readonly expiresAt: string | null = null,
	) {
		super(`Project ${projectId} is being edited in another session`);
		this.name = 'LeaseHeldError';
	}
}
