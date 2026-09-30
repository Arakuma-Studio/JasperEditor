// Headless project access for the agent API (S01:AGT-020, ARCHITECTURE §11). A thin adapter owned by
// WP-2H: it reads and writes the S01:PER-002 envelope at <appdir>/projects/<id>/project.jasper with an
// atomic write (tmp + fsync + rename) and an optimistic revision check. When WP-2F's project store is
// registered as `app.jasper.services.agentStore` (same interface), the agent service uses it instead,
// so leases, versions and events stay in one place (WP-3I wiring).
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AppdirPaths } from '@jasper/config';

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

const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function isSafeProjectId(id: string): boolean {
	return PROJECT_ID.test(id) && id !== '.' && id !== '..';
}

/** Filesystem store over the appdir layout (ARCHITECTURE §4.3). */
export class FsAgentProjectStore implements AgentProjectStore {
	private readonly locks = new Map<string, Promise<unknown>>();
	constructor(private readonly paths: Pick<AppdirPaths, 'projectFile'>) {}

	async load(projectId: string): Promise<StoredEnvelope | null> {
		if (!isSafeProjectId(projectId)) return null;
		let text: string;
		try {
			text = await readFile(this.paths.projectFile(projectId), 'utf8');
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw e;
		}
		const envelope = JSON.parse(text) as Record<string, unknown>;
		const revision = typeof envelope.revision === 'number' ? envelope.revision : 0;
		return { envelope, revision };
	}

	save(projectId: string, envelope: Record<string, unknown>, baseRevision: number): Promise<SaveOutcome> {
		return this.serialize(projectId, async () => {
			if (!isSafeProjectId(projectId)) throw new Error(`Invalid project id: ${projectId}`);
			const current = await this.load(projectId);
			if (current && current.revision !== baseRevision)
				return { ok: false as const, conflict: true as const, revision: current.revision };
			const file = this.paths.projectFile(projectId);
			await writeFileAtomic(file, `${JSON.stringify(envelope)}\n`);
			return { ok: true as const, revision: typeof envelope.revision === 'number' ? envelope.revision : 0 };
		});
	}

	/** Runs `fn` after every earlier write to the same project finished (in-process mutex). */
	private serialize<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.locks.get(projectId) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		const tail = next.catch(() => undefined);
		this.locks.set(projectId, tail);
		void tail.then(() => {
			if (this.locks.get(projectId) === tail) this.locks.delete(projectId);
		});
		return next;
	}
}

/** tmp + fsync + rename, so readers see the old or the new file, never a torn one (S01:PER-002). */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
	const fh = await open(tmp, 'w');
	try {
		await fh.writeFile(data, 'utf8');
		await fh.sync();
	} finally {
		await fh.close();
	}
	try {
		await rename(tmp, file);
	} catch (e) {
		await rm(tmp, { force: true });
		throw e;
	}
}
