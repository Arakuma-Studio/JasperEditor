// Filesystem ProjectStore (ARCHITECTURE D-08, §4.3, §9.2; S01 §18): the S01:PER-002 envelope in
// `<appdir>/projects/<projectId>/project.jasper` with atomic writes (S01:PER-016), a view file (PER-019),
// versions every 5 minutes of saving (PER-020), and If-Match revisions with 409 on conflict (PER-025).
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectSummary, VersionInfo } from '@jasper/api';
import type { AppdirPaths } from '@jasper/config';
import {
	CURRENT_SCHEMA_VERSION,
	createEmptyProject,
	createRandomIdSource,
	defaultPresetRegistry,
	makeEnvelope,
	migrate,
	type ProjectDocument,
	ProjectDocumentSchema,
	type ProjectEnvelope,
} from '@jasper/project';
import { atomicWriteFile, atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';
import { KeyedMutex } from '../tools/mutex.ts';
import type { LeaseManager } from './leases.ts';

export const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{16}$/;
export const VERSION_INTERVAL_MS = 5 * 60 * 1000;
export const KEEP_VERSIONS = 20;

export class ProjectError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = 'ProjectError';
	}
}

type StoredEnvelope = Omit<ProjectEnvelope, 'document'> & { document: Record<string, unknown> };

export type ProjectStoreOptions = {
	paths: AppdirPaths;
	leases: LeaseManager;
	appVersion: string;
	platform?: string;
	now?: () => Date;
	versionIntervalMs?: number;
	keepVersions?: number;
};

export class ProjectStoreFs {
	private readonly mutex = new KeyedMutex();
	private readonly now: () => Date;

	constructor(private readonly opts: ProjectStoreOptions) {
		this.now = opts.now ?? (() => new Date());
	}

	get leases(): LeaseManager {
		return this.opts.leases;
	}

	private check(projectId: string): void {
		if (!PROJECT_ID_RE.test(projectId)) throw new ProjectError('PROJECT_NOT_FOUND', 404, 'Unknown project');
	}

	private file(projectId: string): string {
		return this.opts.paths.projectFile(projectId);
	}

	private async readEnvelope(projectId: string): Promise<StoredEnvelope> {
		this.check(projectId);
		const env = await readJsonOrNull<StoredEnvelope>(this.file(projectId));
		if (env?.format !== 'jasper-project' || typeof env.revision !== 'number') {
			throw new ProjectError('PROJECT_NOT_FOUND', 404, 'Unknown project');
		}
		return env;
	}

	async list(): Promise<ProjectSummary[]> {
		let ids: string[];
		try {
			ids = await readdir(this.opts.paths.projectsDir);
		} catch {
			return [];
		}
		const out: ProjectSummary[] = [];
		for (const id of ids) {
			if (!PROJECT_ID_RE.test(id)) continue;
			try {
				const text = await readFile(this.file(id), 'utf8');
				const env = JSON.parse(text) as StoredEnvelope;
				out.push({
					projectId: id,
					name: typeof env.document?.name === 'string' ? env.document.name : id,
					modifiedAt: env.savedAt,
					thumbnail: null,
					schemaVersion: env.schemaVersion,
					sizeBytes: Buffer.byteLength(text),
					revision: env.revision,
				});
			} catch {
				// unreadable project folders are skipped (never deleted)
			}
		}
		return out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
	}

	async create(init: { name: string; preset: string }): Promise<string> {
		if (!defaultPresetRegistry.get(init.preset)) {
			throw new ProjectError('VALIDATION_FAILED', 400, `Unknown sequence preset "${init.preset}"`);
		}
		const doc = createEmptyProject({ ids: createRandomIdSource(), name: init.name, preset: init.preset });
		const env = makeEnvelope(doc, {
			revision: 0,
			savedAt: this.now().toISOString(),
			platform: this.opts.platform ?? process.platform,
			appVersion: this.opts.appVersion,
		});
		await mkdir(this.opts.paths.projectDir(doc.projectId), { recursive: true });
		await atomicWriteJson(this.file(doc.projectId), env);
		return doc.projectId;
	}

	async get(
		projectId: string,
	): Promise<{ envelope: StoredEnvelope; view: Record<string, unknown> | null; revision: number }> {
		const envelope = await this.readEnvelope(projectId);
		const view = await readJsonOrNull<Record<string, unknown>>(this.opts.paths.projectViewFile(projectId));
		return {
			envelope,
			view: view && typeof view === 'object' && typeof view.version === 'number' ? view : null,
			revision: envelope.revision,
		};
	}

	/** Current revision, or null when the project does not exist. */
	async revision(projectId: string): Promise<number | null> {
		try {
			return (await this.readEnvelope(projectId)).revision;
		} catch {
			return null;
		}
	}

	/**
	 * Saves an envelope when `ifMatch` equals the stored revision (or is `'*'`). The stored revision is
	 * `max(envelope.revision, current + 1)`; a mismatch throws 409 REVISION_CONFLICT with `{revision}`.
	 */
	save(projectId: string, envelope: StoredEnvelope, ifMatch: number | '*'): Promise<{ revision: number }> {
		this.check(projectId);
		return this.mutex.run(projectId, async () => {
			const current = await this.readEnvelope(projectId);
			if (ifMatch !== '*' && ifMatch !== current.revision) {
				throw new ProjectError('REVISION_CONFLICT', 409, 'The project was saved by another writer', {
					revision: current.revision,
				});
			}
			this.validate(projectId, envelope.document);
			const revision = Math.max(envelope.revision, current.revision + 1);
			await this.maybeKeepVersion(projectId);
			const next: StoredEnvelope = { ...envelope, revision, savedAt: this.now().toISOString() };
			await atomicWriteJson(this.file(projectId), next);
			return { revision };
		});
	}

	private validate(projectId: string, document: Record<string, unknown>): void {
		if (document.projectId !== projectId) {
			throw new ProjectError('VALIDATION_FAILED', 400, 'document.projectId does not match the project');
		}
		let migrated: ReturnType<typeof migrate>;
		try {
			migrated = migrate(document);
		} catch (e) {
			throw new ProjectError('VALIDATION_FAILED', 400, `Invalid project document: ${(e as Error).message}`);
		}
		if (migrated.readOnly) return; // newer schema: stored verbatim, never downgraded (S01:MIG-003)
		const parsed = ProjectDocumentSchema.safeParse(migrated.document);
		if (!parsed.success) {
			const msg = parsed.error.issues
				.slice(0, 5)
				.map((i) => `${i.path.join('.')}: ${i.message}`)
				.join('; ');
			throw new ProjectError('VALIDATION_FAILED', 400, `Project does not match the schema: ${msg}`, {
				issues: parsed.error.issues.slice(0, 20),
			});
		}
	}

	/** Keeps the previous file as a version when the newest version is older than 5 minutes (S01:PER-020). */
	private async maybeKeepVersion(projectId: string): Promise<void> {
		const dir = this.opts.paths.projectVersionsDir(projectId);
		const versions = await this.listVersionFiles(projectId);
		const newest = versions[versions.length - 1];
		const interval = this.opts.versionIntervalMs ?? VERSION_INTERVAL_MS;
		if (newest && this.now().getTime() - newest.mtimeMs < interval) return;
		await mkdir(dir, { recursive: true });
		const stamp = this.now().toISOString().replace(/[:.]/g, '-');
		await copyFile(this.file(projectId), join(dir, `${stamp}.jasper`));
		const keep = this.opts.keepVersions ?? KEEP_VERSIONS;
		const all = await this.listVersionFiles(projectId);
		for (const old of all.slice(0, Math.max(0, all.length - keep))) await rm(old.path, { force: true });
	}

	private async listVersionFiles(
		projectId: string,
	): Promise<{ id: string; path: string; mtimeMs: number; size: number }[]> {
		const dir = this.opts.paths.projectVersionsDir(projectId);
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return [];
		}
		const out: { id: string; path: string; mtimeMs: number; size: number }[] = [];
		for (const n of names) {
			if (!n.endsWith('.jasper')) continue;
			const path = join(dir, n);
			const s = await stat(path).catch(() => null);
			if (s) out.push({ id: n.slice(0, -'.jasper'.length), path, mtimeMs: s.mtimeMs, size: s.size });
		}
		return out.sort((a, b) => (a.id < b.id ? -1 : 1));
	}

	async versions(projectId: string): Promise<VersionInfo[]> {
		await this.readEnvelope(projectId);
		const out: VersionInfo[] = [];
		for (const v of (await this.listVersionFiles(projectId)).reverse()) {
			const env = await readJsonOrNull<StoredEnvelope>(v.path);
			if (!env) continue;
			out.push({ versionId: v.id, savedAt: env.savedAt, revision: env.revision, sizeBytes: v.size });
		}
		return out;
	}

	async saveView(projectId: string, view: Record<string, unknown>): Promise<void> {
		await this.readEnvelope(projectId);
		await atomicWriteFile(this.opts.paths.projectViewFile(projectId), JSON.stringify(view));
	}

	async delete(projectId: string): Promise<void> {
		await this.readEnvelope(projectId);
		await this.mutex.run(projectId, () =>
			rm(this.opts.paths.projectDir(projectId), { recursive: true, force: true }),
		);
		this.opts.leases.forget(projectId);
	}

	// ------------------------------------------------------------------ document-level API (agents, headless)

	/** Loads and migrates the document (for headless agent transactions, WP-2H). */
	async loadDocument(
		projectId: string,
	): Promise<{ document: ProjectDocument; revision: number; readOnly: boolean }> {
		const env = await this.readEnvelope(projectId);
		const m = migrate(env);
		return { document: m.document, revision: env.revision, readOnly: m.readOnly };
	}

	/** Saves a document with optimistic concurrency (`baseRevision` must be current). */
	async saveDocument(
		projectId: string,
		document: ProjectDocument,
		meta: { baseRevision: number; revision?: number },
	): Promise<{ revision: number }> {
		const env = makeEnvelope(document, {
			revision: meta.revision ?? meta.baseRevision + 1,
			savedAt: this.now().toISOString(),
			platform: this.opts.platform ?? process.platform,
			appVersion: this.opts.appVersion,
		});
		return this.save(projectId, env as unknown as StoredEnvelope, meta.baseRevision);
	}
}

export { CURRENT_SCHEMA_VERSION };
