import type { Lease, ProjectSummary, RecoveryInfo, VersionInfo } from '@jasper/api';
import type { Issue, ProjectDocument, RepairEntry } from '@jasper/project';
import type { ProjectViewState } from '../view.ts';

export type { ProjectViewState } from '../view.ts';

export type { Lease, ProjectSummary, RecoveryInfo, VersionInfo };

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

/** What a session journals for crash recovery (S01:PER-021, AC-18, ARCHITECTURE D-39). */
export type RecoveryWrite = {
	leaseId: string;
	/** Revision of the saved project the unsaved changes are based on. */
	baseRevision: number;
	/** The session's local revision. */
	revision: number;
	/** Labels of the unsaved History steps, oldest first. */
	changes: string[];
	changeCount: number;
	document: ProjectDocument;
};

/** A recovered snapshot, already through the load pipeline (migrated, validated, repaired). */
export type RecoveredSnapshot = { info: RecoveryInfo; document: ProjectDocument; repairs: RepairEntry[] };

/**
 * Crash-recovery journals and saved-version restores (D-39). Optional: stores without them
 * (tests, headless tools) simply don't journal.
 */
export interface RecoveryStore {
	writeRecovery(projectId: string, sessionId: string, w: RecoveryWrite): Promise<void>;
	/** Journals no live session holds any more, newest first. */
	listRecovery(projectId: string): Promise<RecoveryInfo[]>;
	readRecovery(projectId: string, sessionId: string): Promise<RecoveredSnapshot>;
	/** Deletes a journal: the session's own (with its `leaseId`) or a candidate nobody holds. */
	discardRecovery(projectId: string, sessionId: string, leaseId?: string): Promise<void>;
	/** Writes a saved version over the project (the replaced state is kept as a version); returns the new revision. */
	revertToVersion(projectId: string, versionId: string, leaseId?: string): Promise<number>;
}

export function hasRecovery(store: ProjectStore | undefined | null): store is ProjectStore & RecoveryStore {
	return !!store && typeof (store as Partial<RecoveryStore>).writeRecovery === 'function';
}

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
	/** Restores a saved version as a new project copy (S01:PER-001); returns the new project id. */
	restoreVersion(projectId: string, versionId: string): Promise<string>;
	/** File ▸ Save As / Save a Copy: a new project holding `doc` under `name`; returns its id. */
	saveDocumentAs(doc: ProjectDocument, name: string): Promise<string>;
	duplicate(projectId: string, name: string): Promise<string>;
	delete(projectId: string): Promise<void>;
	exportFile(projectId: string): Promise<Blob | { path: string }>;
	importFile(file: Blob): Promise<string>;
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
