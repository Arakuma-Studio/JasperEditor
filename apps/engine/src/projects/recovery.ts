// Crash-recovery journal (S01:PER-021, AC-18; ARCHITECTURE D-39; docs/project-files.md "Crash recovery").
//
// While an editor session has unsaved changes it sends its committed document here about 1 s after each edit (at
// most every 5 s during continuous editing). Each session has its own directory
// `<appdir>/projects/<pid>/recovery/<sessionId>/` with
//   - `snapshot.jasper`: the S01:PER-002 envelope of the unsaved document (atomic write, PER-016);
//   - `session.json`: who wrote it and when (`RecoveryInfo` minus the live fields);
//   - `lock`: `{pid, instance}` of the engine process that accepted the writes.
// The journal is **held** while the session that wrote it can still write: its engine process is alive and, when
// that is this engine, the session still holds the project's lease (the lease is the lock: it expires 30 s after
// the editor stops heartbeating — a crashed or killed tab — and an engine restart forgets every lease). Held
// journals are never offered, read for recovery or deleted by anyone but their session. A journal that is no longer
// held and whose document differs from the saved project is a **recovery candidate**; one whose document equals
// the saved project (the last autosave caught up before the crash) is stale and is removed when listed.
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type RecoveryInfo as RecoveryCandidate,
	RecoveryInfoSchema,
	type RecoveryPutRequest,
} from '@jasper/api';
import type { AppdirPaths } from '@jasper/config';
import { atomicWriteJson, randomId, readJsonOrNull } from '../tools/fs.ts';
import { KeyedMutex } from '../tools/mutex.ts';
import type { LeaseManager } from './leases.ts';
import { isProjectId, ProjectError } from './store.ts';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** Newest unsaved-change labels kept in `session.json` (shown in the recovery prompt). */
const MAX_LABELS = 50;
/** Largest snapshot accepted (the engine's JSON body limit is the other bound). */
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;

type RecoveryInfo = Omit<RecoveryCandidate, 'projectRevision'>;

export type { RecoveryCandidate };
export type RecoveryWrite = RecoveryPutRequest;
const JournalInfoSchema = RecoveryInfoSchema.omit({ projectRevision: true });
type Lock = { pid: number; instance: string };

/** Whether a process with this pid exists (signal 0 checks without signalling; EPERM means it exists). */
function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as { code?: string }).code === 'EPERM';
	}
}

export class RecoveryJournal {
	/** This engine process (a restarted engine with a reused pid is a different instance). */
	readonly instance = randomId('eng', 8);
	/** Writes and deletes of one session's journal run one at a time. */
	private readonly mutex = new KeyedMutex();
	private readonly now: () => Date;
	private readonly alive: (pid: number) => boolean;

	constructor(
		private readonly opts: {
			paths: AppdirPaths;
			leases: LeaseManager;
			/** Current revision and document of the saved project (null when it does not exist). */
			saved(projectId: string): Promise<{ revision: number; document: Record<string, unknown> } | null>;
			now?: () => Date;
			processAlive?: (pid: number) => boolean;
		},
	) {
		this.now = opts.now ?? (() => new Date());
		this.alive = opts.processAlive ?? processAlive;
	}

	private dir(projectId: string, sessionId?: string): string {
		// Security review ENG-4: the id comes from a URL parameter (`..%2F` decodes to `../`).
		if (!isProjectId(projectId)) throw new ProjectError('PROJECT_NOT_FOUND', 404, 'Unknown project');
		const base = join(this.opts.paths.projectDir(projectId), 'recovery');
		if (sessionId === undefined) return base;
		if (!SESSION_ID_RE.test(sessionId))
			throw new ProjectError('VALIDATION_FAILED', 400, 'Invalid session id');
		return join(base, sessionId);
	}

	/** Whether the session that wrote this journal can still write it (see the header). */
	private async held(projectId: string, sessionId: string): Promise<boolean> {
		const lock = await readJsonOrNull<Lock>(join(this.dir(projectId, sessionId), 'lock'));
		if (!lock || typeof lock.pid !== 'number') return false;
		if (lock.pid === process.pid && lock.instance === this.instance)
			return this.opts.leases.get(projectId)?.sessionId === sessionId;
		if (lock.pid === process.pid) return false; // an earlier engine whose pid we reuse: it is gone
		return this.alive(lock.pid);
	}

	/** The session must hold the project's lease with `leaseId` to write or clear its own journal. */
	private assertLease(projectId: string, sessionId: string, leaseId: string): void {
		const lease = this.opts.leases.get(projectId);
		if (!lease || lease.leaseId !== leaseId)
			throw new ProjectError('LEASE_NOT_FOUND', 404, 'Lease not found or expired');
		if (lease.sessionId !== sessionId)
			throw new ProjectError('LEASE_HELD', 409, 'Another session holds this project', {
				holderSessionId: lease.sessionId,
				expiresAt: lease.expiresAt,
			});
	}

	/** Writes (replaces) a session's snapshot. */
	write(projectId: string, sessionId: string, w: RecoveryWrite): Promise<{ savedAt: string }> {
		const dir = this.dir(projectId, sessionId);
		return this.mutex.run(`${projectId}/${sessionId}`, () => this.writeLocked(projectId, sessionId, dir, w));
	}

	private async writeLocked(
		projectId: string,
		sessionId: string,
		dir: string,
		w: RecoveryWrite,
	): Promise<{ savedAt: string }> {
		this.assertLease(projectId, sessionId, w.leaseId);
		const doc = w.envelope?.document;
		if (!doc || typeof doc !== 'object' || doc.projectId !== projectId)
			throw new ProjectError('VALIDATION_FAILED', 400, 'The snapshot is not a document of this project');
		const text = JSON.stringify(w.envelope);
		if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES)
			throw new ProjectError('VALIDATION_FAILED', 400, 'The snapshot is too large to journal');
		await mkdir(dir, { recursive: true });
		const prev = await readJsonOrNull<RecoveryInfo>(join(dir, 'session.json'));
		const savedAt = this.now().toISOString();
		const changes = w.changes.slice(-MAX_LABELS).map((c) => String(c).slice(0, 200));
		const info: RecoveryInfo = {
			sessionId,
			projectId,
			projectName: typeof doc.name === 'string' ? doc.name : projectId,
			baseRevision: w.baseRevision,
			revision: w.revision,
			startedAt: prev?.startedAt ?? savedAt,
			savedAt,
			changes,
			changeCount: Math.max(w.changeCount ?? changes.length, changes.length),
			sizeBytes: Buffer.byteLength(text),
		};
		await atomicWriteJson(join(dir, 'lock'), { pid: process.pid, instance: this.instance } satisfies Lock);
		await atomicWriteJson(join(dir, 'snapshot.jasper'), w.envelope);
		await atomicWriteJson(join(dir, 'session.json'), info);
		return { savedAt };
	}

	/**
	 * Deletes a journal: the session's own (with its lease: it saved, or closed cleanly) or a candidate (Discard,
	 * or after its recovery went into the new session's journal). A journal held by another session is refused.
	 */
	remove(projectId: string, sessionId: string, leaseId?: string): Promise<void> {
		const dir = this.dir(projectId, sessionId);
		return this.mutex.run(`${projectId}/${sessionId}`, () =>
			this.removeLocked(projectId, sessionId, dir, leaseId),
		);
	}

	private async removeLocked(
		projectId: string,
		sessionId: string,
		dir: string,
		leaseId?: string,
	): Promise<void> {
		const lease = this.opts.leases.get(projectId);
		const own = !!leaseId && lease?.leaseId === leaseId && lease.sessionId === sessionId;
		if (!own && (await this.held(projectId, sessionId)))
			throw new ProjectError('LEASE_HELD', 409, 'That session is still editing; its journal is in use', {
				holderSessionId: sessionId,
				expiresAt: lease?.expiresAt ?? null,
			});
		await rm(dir, { recursive: true, force: true });
	}

	/** Recovery candidates of a project, newest first (stale journals are removed on the way). */
	async list(projectId: string): Promise<RecoveryCandidate[]> {
		let names: string[];
		try {
			names = await readdir(this.dir(projectId));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
		const saved = await this.opts.saved(projectId);
		if (!saved) return [];
		const savedDoc = JSON.stringify(saved.document);
		const out: RecoveryCandidate[] = [];
		for (const sessionId of names) {
			if (!SESSION_ID_RE.test(sessionId)) continue;
			if (await this.held(projectId, sessionId)) continue;
			const dir = this.dir(projectId, sessionId);
			const info = JournalInfoSchema.safeParse(await readJsonOrNull(join(dir, 'session.json')));
			const snap = await readJsonOrNull<{ document?: unknown }>(join(dir, 'snapshot.jasper'));
			// Interrupted writes can leave a recoverable snapshot without complete metadata.
			if (!info.success || !snap?.document || typeof snap.document !== 'object')
				throw new ProjectError(
					'VALIDATION_FAILED',
					422,
					`Recovery journal ${sessionId} is incomplete or unreadable; its files have been preserved for recovery`,
					{ projectId, sessionId },
				);
			if (JSON.stringify(snap.document) === savedDoc) {
				await rm(dir, { recursive: true, force: true });
				continue;
			}
			out.push({ ...info.data, projectRevision: saved.revision });
		}
		return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
	}

	/** A candidate's snapshot (refused while its session still holds it). */
	async read(
		projectId: string,
		sessionId: string,
	): Promise<{ info: RecoveryCandidate; envelope: Record<string, unknown> }> {
		const candidate = (await this.list(projectId)).find((c) => c.sessionId === sessionId);
		if (!candidate) {
			if (await this.held(projectId, sessionId))
				throw new ProjectError('LEASE_HELD', 409, 'That session is still editing; its journal is in use');
			throw new ProjectError('NOT_FOUND', 404, 'No unsaved changes to recover for that session');
		}
		const envelope = await readJsonOrNull<Record<string, unknown>>(
			join(this.dir(projectId, sessionId), 'snapshot.jasper'),
		);
		if (!envelope) throw new ProjectError('NOT_FOUND', 404, 'No unsaved changes to recover for that session');
		return { info: candidate, envelope };
	}
}
