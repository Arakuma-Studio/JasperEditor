// Filesystem ProjectStore (ARCHITECTURE D-08, §4.3, §9.2; S01 §18): the S01:PER-002 envelope in
// `<appdir>/projects/<projectId>/project.jasper` with atomic writes (S01:PER-016), a view file (PER-019),
// versions every 5 minutes of saving (PER-020), and If-Match revisions with 409 on conflict (PER-025).
// Process workstream (D-39, docs/project-files.md): the first save over a project migrated from an older schema keeps
// `project (schema vN backup).jasper` next to it (S01:MIG-004); saved versions can be read and restored in place
// (keeping the replaced state as a `before-restore` version) or as a new project (S01:PER-001 `restoreVersion`).
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type EnvelopeJson,
	EnvelopeSchema,
	type ProjectSummary,
	type VersionInfo,
	type VersionKind,
} from '@jasper/api';
import type { AppdirPaths } from '@jasper/config';
import {
	createEmptyProject,
	createRandomIdSource,
	defaultPresetRegistry,
	makeEnvelope,
	migrate,
	ProjectDocumentSchema,
} from '@jasper/project';
import { atomicCopyFile, atomicWriteFile, atomicWriteJson, exists, readJsonOrNull } from '../tools/fs.ts';
import { KeyedMutex } from '../tools/mutex.ts';
import type { LeaseManager } from './leases.ts';

const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{16}$/;
/** Whether `id` is an engine project id (what every path under `<appdir>/projects/` is built from). */
export const isProjectId = (id: unknown): id is string => typeof id === 'string' && PROJECT_ID_RE.test(id);
const VERSION_INTERVAL_MS = 5 * 60 * 1000;
/** Version ids: `<ISO stamp>` (auto), `<ISO stamp>-restore` (before-restore), `schema-v<N>-backup`. */
const VERSION_ID_RE = /^(?:\d{4}-\d{2}-\d{2}T[\d-]+Z(?:-restore)?|schema-v\d{1,4}-backup)$/;
const SCHEMA_BACKUP_RE = /^project \(schema v(\d{1,4}) backup\)\.jasper$/;
/** File name of the schema backup kept before the first save over a project migrated from schema `v`. */
export const schemaBackupName = (v: number) => `project (schema v${v} backup).jasper`;
const schemaVersionOf = (doc: Record<string, unknown> | undefined, env?: { schemaVersion?: unknown }) => {
	const v = typeof doc?.schemaVersion === 'number' ? doc.schemaVersion : env?.schemaVersion;
	return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 1;
};
const KEEP_VERSIONS = 20;

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

type ProjectStoreOptions = {
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

	/** gaps (Preferences ▸ Auto Save): how often a saved version is kept and how many are kept. */
	setVersionPolicy(p: { versionIntervalMs?: number; keepVersions?: number }): void {
		if (p.versionIntervalMs !== undefined) this.opts.versionIntervalMs = p.versionIntervalMs;
		if (p.keepVersions !== undefined) this.opts.keepVersions = p.keepVersions;
	}

	versionPolicy(): { versionIntervalMs: number; keepVersions: number } {
		return {
			versionIntervalMs: this.opts.versionIntervalMs ?? VERSION_INTERVAL_MS,
			keepVersions: this.opts.keepVersions ?? KEEP_VERSIONS,
		};
	}

	private check(projectId: string): void {
		if (!PROJECT_ID_RE.test(projectId)) throw new ProjectError('PROJECT_NOT_FOUND', 404, 'Unknown project');
	}

	private async readEnvelope(projectId: string): Promise<EnvelopeJson> {
		this.check(projectId);
		let text: string;
		try {
			text = await readFile(this.opts.paths.projectFile(projectId), 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				throw new ProjectError('PROJECT_NOT_FOUND', 404, 'Unknown project');
			throw error;
		}
		return this.parseEnvelope(text);
	}

	private parseEnvelope(text: string): EnvelopeJson {
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			throw new ProjectError(
				'VALIDATION_FAILED',
				422,
				'The project file is not valid JSON; it has been preserved',
			);
		}
		const parsed = EnvelopeSchema.safeParse(raw);
		if (!parsed.success)
			throw new ProjectError(
				'VALIDATION_FAILED',
				422,
				'The project envelope is invalid; it has been preserved',
				{
					issues: parsed.error.issues.slice(0, 20),
				},
			);
		return parsed.data;
	}

	async list(): Promise<ProjectSummary[]> {
		let ids: string[];
		try {
			ids = await readdir(this.opts.paths.projectsDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
		const out: ProjectSummary[] = [];
		for (const id of ids) {
			if (!PROJECT_ID_RE.test(id)) continue;
			try {
				const text = await readFile(this.opts.paths.projectFile(id), 'utf8');
				const env = this.parseEnvelope(text);
				out.push({
					projectId: id,
					name: typeof env.document?.name === 'string' ? env.document.name : id,
					modifiedAt: env.savedAt,
					thumbnail: null,
					schemaVersion: env.schemaVersion,
					sizeBytes: Buffer.byteLength(text),
					revision: env.revision,
				});
			} catch (error) {
				if (error instanceof ProjectError && error.code === 'VALIDATION_FAILED') continue;
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
		await atomicWriteJson(this.opts.paths.projectFile(doc.projectId), env);
		return doc.projectId;
	}

	async get(
		projectId: string,
	): Promise<{ envelope: EnvelopeJson; view: Record<string, unknown> | null; revision: number }> {
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
		} catch (error) {
			if (error instanceof ProjectError && error.code === 'PROJECT_NOT_FOUND') return null;
			throw error;
		}
	}

	/**
	 * Saves an envelope when `ifMatch` equals the stored revision (or is `'*'`). The stored revision is
	 * `max(envelope.revision, current + 1)`; a mismatch throws 409 REVISION_CONFLICT with `{revision}`.
	 */
	save(projectId: string, envelope: EnvelopeJson, ifMatch: number | '*'): Promise<{ revision: number }> {
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
			await this.keepSchemaBackup(projectId, current, envelope);
			await this.maybeKeepVersion(projectId);
			const next: EnvelopeJson = { ...envelope, revision, savedAt: this.now().toISOString() };
			await atomicWriteJson(this.opts.paths.projectFile(projectId), next);
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

	/**
	 * The first save of a newer schema over a file written with an older one keeps the file as it was, as
	 * `project (schema vN backup).jasper` (never overwritten), so an older JasperEditor can still open that work.
	 */
	private async keepSchemaBackup(
		projectId: string,
		current: EnvelopeJson,
		next: EnvelopeJson,
	): Promise<void> {
		const from = schemaVersionOf(current.document, current);
		if (from >= schemaVersionOf(next.document, next)) return;
		const backup = join(this.opts.paths.projectDir(projectId), schemaBackupName(from));
		if (await exists(backup)) return;
		await atomicCopyFile(this.opts.paths.projectFile(projectId), backup);
	}

	/** Keeps the previous file as a version when the newest version is older than 5 minutes (S01:PER-020). */
	private async maybeKeepVersion(projectId: string): Promise<void> {
		const dir = this.opts.paths.projectVersionsDir(projectId);
		const versions = await this.listVersionFiles(projectId);
		const newest = versions[versions.length - 1];
		const interval = this.opts.versionIntervalMs ?? VERSION_INTERVAL_MS;
		if (newest && this.now().getTime() - versionTime(newest) < interval) return;
		await mkdir(dir, { recursive: true });
		const stamp = this.now().toISOString().replace(/[:.]/g, '-');
		await atomicCopyFile(this.opts.paths.projectFile(projectId), join(dir, `${stamp}.jasper`));
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
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
		const out: { id: string; path: string; mtimeMs: number; size: number }[] = [];
		for (const n of names) {
			if (!n.endsWith('.jasper')) continue;
			const id = n.slice(0, -'.jasper'.length);
			if (!VERSION_ID_RE.test(id)) continue;
			const path = join(dir, n);
			const s = await stat(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return null;
				throw error;
			});
			if (s) out.push({ id, path, mtimeMs: s.mtimeMs, size: s.size });
		}
		return out.sort((a, b) => (a.id < b.id ? -1 : 1));
	}

	/** Schema backups next to the project file (`project (schema vN backup).jasper`). */
	private async listSchemaBackups(
		projectId: string,
	): Promise<{ id: string; path: string; mtimeMs: number; size: number }[]> {
		let names: string[];
		try {
			names = await readdir(this.opts.paths.projectDir(projectId));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
		const out: { id: string; path: string; mtimeMs: number; size: number }[] = [];
		for (const n of names) {
			const m = SCHEMA_BACKUP_RE.exec(n);
			if (!m) continue;
			const path = join(this.opts.paths.projectDir(projectId), n);
			const s = await stat(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return null;
				throw error;
			});
			if (s) out.push({ id: `schema-v${Number(m[1])}-backup`, path, mtimeMs: s.mtimeMs, size: s.size });
		}
		return out;
	}

	private async versionFile(projectId: string, versionId: string) {
		if (!VERSION_ID_RE.test(versionId)) return null;
		const all = [...(await this.listVersionFiles(projectId)), ...(await this.listSchemaBackups(projectId))];
		return all.find((v) => v.id === versionId) ?? null;
	}

	private static kindOf(id: string): VersionKind {
		if (id.endsWith('-backup')) return 'schema-backup';
		if (id.endsWith('-restore')) return 'before-restore';
		return 'auto';
	}

	private static info(v: { id: string; size: number }, env: EnvelopeJson): VersionInfo {
		return {
			versionId: v.id,
			savedAt: env.savedAt,
			revision: env.revision,
			sizeBytes: v.size,
			kind: ProjectStoreFs.kindOf(v.id),
			schemaVersion: schemaVersionOf(env.document, env),
		};
	}

	/** Saved versions, newest first; schema backups last. */
	async versions(projectId: string): Promise<VersionInfo[]> {
		await this.readEnvelope(projectId);
		const out: VersionInfo[] = [];
		const files = [
			...(await this.listVersionFiles(projectId)).reverse(),
			...(await this.listSchemaBackups(projectId)).sort((a, b) => (a.id < b.id ? 1 : -1)),
		];
		for (const v of files) {
			const env = await readJsonOrNull<EnvelopeJson>(v.path);
			if (env?.format !== 'jasper-project' || !env.document || typeof env.revision !== 'number') continue;
			out.push(ProjectStoreFs.info(v, env));
		}
		return out;
	}

	/** One saved version (`GET …/versions/:versionId`). */
	async version(
		projectId: string,
		versionId: string,
	): Promise<{ version: VersionInfo; envelope: EnvelopeJson }> {
		await this.readEnvelope(projectId);
		const v = await this.versionFile(projectId, versionId);
		const env = v ? await readJsonOrNull<EnvelopeJson>(v.path) : null;
		if (!v || env?.format !== 'jasper-project' || !env.document || typeof env.revision !== 'number')
			throw new ProjectError('NOT_FOUND', 404, `No saved version ${versionId}`);
		return { version: ProjectStoreFs.info(v, env), envelope: env };
	}

	/**
	 * Restores a saved version. `replace`: refused while another session holds the lease (`leaseId` names the
	 * caller's own); the current file is kept as a `before-restore` version, then the version's document becomes
	 * the next revision. `copy`: a new project with the version's document (S01:PER-001 `restoreVersion`).
	 */
	async restoreVersion(
		projectId: string,
		versionId: string,
		opts: { mode: 'replace' | 'copy'; name?: string; leaseId?: string },
	): Promise<{ projectId: string; revision: number; keptAs: string | null }> {
		const { envelope } = await this.version(projectId, versionId);
		if (opts.mode === 'copy') {
			const doc = structuredClone(envelope.document);
			const newId = createRandomIdSource().next('prj');
			const stamp = this.now().toISOString().slice(0, 16).replace('T', ' ');
			doc.projectId = newId;
			doc.name = opts.name ?? `${typeof doc.name === 'string' ? doc.name : 'Project'} (restored ${stamp})`;
			const env: EnvelopeJson = {
				...envelope,
				revision: 0,
				savedAt: this.now().toISOString(),
				document: doc,
			};
			await mkdir(this.opts.paths.projectDir(newId), { recursive: true });
			await atomicWriteJson(this.opts.paths.projectFile(newId), env);
			return { projectId: newId, revision: 0, keptAs: null };
		}
		return this.mutex.run(projectId, async () => {
			const lease = this.opts.leases.get(projectId);
			if (lease && lease.leaseId !== opts.leaseId)
				throw new ProjectError('LEASE_HELD', 409, 'The project is open in an editor: restore it from there', {
					holderSessionId: lease.sessionId,
					expiresAt: lease.expiresAt,
				});
			if (envelope.document.projectId !== projectId)
				throw new ProjectError('VALIDATION_FAILED', 400, 'The version belongs to another project');
			const current = await this.readEnvelope(projectId);
			const dir = this.opts.paths.projectVersionsDir(projectId);
			await mkdir(dir, { recursive: true });
			const keptAs = `${this.now().toISOString().replace(/[:.]/g, '-')}-restore`;
			await atomicCopyFile(this.opts.paths.projectFile(projectId), join(dir, `${keptAs}.jasper`));
			const revision = current.revision + 1;
			const next: EnvelopeJson = { ...envelope, revision, savedAt: this.now().toISOString() };
			await atomicWriteJson(this.opts.paths.projectFile(projectId), next);
			return { projectId, revision, keptAs };
		});
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
}

/** Save time encoded in a version id (`2026-09-30T10-00-00-000Z`), falling back to the file mtime. */
function versionTime(v: { id: string; mtimeMs: number }): number {
	const m = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(v.id);
	const t = m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : Number.NaN;
	return Number.isNaN(t) ? v.mtimeMs : t;
}
