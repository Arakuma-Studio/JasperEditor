// Downloadable sound packs (spec 12 §2.1 source 2, §2.8, P6-R1; wp-note "Phase 6 → WP6.1 sound packs").
//
// The catalogue is `packs.json` next to this file (the same rules as the model catalogue `processing/models.json`:
// every download pinned by sha256 and size, an allowlisted licence with the evidence it was checked against, the
// attribution, nothing hosted by us); `JASPER_SOUND_CATALOG` names another catalogue (tests: `file://` URLs or paths
// relative to it, no network). Installing a pack (`sound-pack-install` job) downloads from the upstream URL into a
// `.partial` file (resumed with a Range request after an interrupted download, removed when the user cancels or the
// bytes do not match), checks the archive's sha256, extracts **only the listed files** (each checked by size before
// it is inflated and by sha256 after; output paths come from the validated catalogue, never from the archive), writes
// `pack.json` (`SoundManifestSchema`, one pack, the licence, attribution and per-file metadata) into a staging folder
// and moves the finished folder into `<appdir>/sounds/packs/<id>/` in one rename. Files are installed as they were
// published (the engine decodes them); nothing is converted. Removing a pack deletes its folder; projects keep working
// because registering a library sound always copies it into managed media.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
	type EngineJob,
	type LicenseComponent,
	SOUND_PACK_ID_RE,
	type SoundManifestSound,
	type SoundPackCatalogEntry,
	SoundPackCatalogEntrySchema,
	SoundPackCatalogSchema,
	type SoundPackInfo,
	type SoundPackInstallResult,
} from '@jasper/api';
import { listZip, readZipEntry, ZipError } from '../imports/zip.ts';
import { JobError } from '../jobs/types.ts';
import { atomicWriteJson } from '../tools/fs.ts';
import builtin from './packs.json' with { type: 'json' };
import { loadPackManifest, PACK_MANIFEST_FILE } from './starter.ts';

export const SOUND_CATALOG_ENV = 'JASPER_SOUND_CATALOG';
/** A download that receives nothing for this long is stopped (`DOWNLOAD_TIMEOUT`, retryable). */
export const PACK_STALL_MS = 60_000;
/** A whole pack download (all its bytes) must finish within this. */
export const PACK_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/**
 * A `files` pack downloads its files one after the other, starting at most one http(s) request per this interval
 * (BigSoundBank asks for polite fetching; a 40-file pack takes ≥ 40 s).
 */
export const PACK_FILE_INTERVAL_MS = 1000;
/** Sent with every pack download: who is fetching, and why. */
export const PACK_USER_AGENT =
	'JasperEditor sound-pack installer (video editor; downloads a sound pack the user asked for; <=1 request/s)';
/** Partial downloads not touched for this long are deleted when the engine starts. */
const STALE_PARTIAL_MS = 30 * 24 * 3600_000;
const STAGING = '.staging';
const TRASH = '.trash';
const DOWNLOADS = '.downloads';
const LICENSE_TEXT_MAX = 1_048_576;

export class PackError extends JobError {
	constructor(code: string, message: string, retryable = false) {
		super(code, message, retryable);
		this.name = 'PackError';
	}
}

export type PackCatalog = {
	entries: SoundPackCatalogEntry[];
	/** Entries that did not validate (skipped) and why. */
	errors: string[];
	/** Folder relative URLs of an override catalogue resolve against (null: the built-in catalogue). */
	base: string | null;
};

const HTTPS = /^https:\/\//;

/** Every URL a built-in catalogue entry names must be https (the override may use http, file: and relative paths). */
function httpsOnly(e: SoundPackCatalogEntry): string | null {
	const urls = [
		e.licenseUrl,
		e.pageUrl,
		...e.licenseEvidence.map((x) => x.url),
		...(e.download.type === 'zip' ? [e.download.url] : []),
		...e.files.flatMap((f) => [f.url, f.sourceUrl, f.licenseEvidence?.url].filter((u): u is string => !!u)),
	];
	const bad = urls.find((u) => !HTTPS.test(u));
	return bad ? `${e.id}: "${bad.slice(0, 120)}" is not an https URL` : null;
}

/** Validates a catalogue document; never throws (invalid entries are skipped and reported). */
export function parsePackCatalog(raw: unknown, opts: { builtin: boolean; base: string | null }): PackCatalog {
	const out: PackCatalog = { entries: [], errors: [], base: opts.base };
	const top = SoundPackCatalogSchema.safeParse(raw);
	if (!top.success) {
		out.errors.push(`catalogue: ${top.error.issues[0]?.message ?? 'invalid'}`);
		return out;
	}
	const ids = new Set<string>();
	top.data.packs.forEach((p, i) => {
		const r = SoundPackCatalogEntrySchema.safeParse(p);
		if (!r.success) {
			const issue = r.error.issues[0];
			const id = (p as { id?: unknown } | null)?.id;
			out.errors.push(
				`packs[${i}]${typeof id === 'string' ? ` (${id.slice(0, 64)})` : ''}: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid'}`,
			);
			return;
		}
		if (ids.has(r.data.id)) {
			out.errors.push(`packs[${i}]: "${r.data.id}" is listed twice`);
			return;
		}
		const https = opts.builtin ? httpsOnly(r.data) : null;
		if (https) {
			out.errors.push(`packs[${i}]: ${https}`);
			return;
		}
		ids.add(r.data.id);
		out.entries.push(r.data);
	});
	return out;
}

/** The catalogue: `JASPER_SOUND_CATALOG` (a JSON file; URLs may be relative to it) or the built-in `packs.json`. */
export async function loadPackCatalog(
	env: Record<string, string | undefined> = process.env,
): Promise<PackCatalog> {
	const file = env[SOUND_CATALOG_ENV];
	if (file) {
		let raw: unknown;
		try {
			const bytes = await readFile(file);
			if (bytes.length > 16 * 1024 * 1024) throw new Error('larger than 16 MB');
			raw = JSON.parse(bytes.toString('utf8'));
		} catch (e) {
			return { entries: [], errors: [`${SOUND_CATALOG_ENV}: ${(e as Error).message}`], base: null };
		}
		return parsePackCatalog(raw, { builtin: false, base: dirname(resolve(file)) });
	}
	return parsePackCatalog(builtin, { builtin: true, base: null });
}

/** sha256 over a `files` pack's file list (its identity, like an archive's sha256). */
export function filesDigest(e: Pick<SoundPackCatalogEntry, 'files'>): string {
	const h = createHash('sha256');
	for (const f of [...e.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
		h.update(`${f.path}\t${f.sha256}\t${f.sizeBytes}\n`);
	return h.digest('hex');
}

/** The pack's download identity: the archive's sha256, or the file list's. */
export function packSha(e: SoundPackCatalogEntry): string {
	return e.download.type === 'zip' ? e.download.sha256 : filesDigest(e);
}

/** A revision of everything an installed pack is made from (files and metadata): another value = outdated. */
export function entryRevision(e: SoundPackCatalogEntry): string {
	const h = createHash('sha256');
	h.update(
		JSON.stringify([
			e.id,
			e.title,
			e.author,
			e.license,
			e.licenseUrl,
			e.attribution,
			e.pageUrl,
			packSha(e),
			e.licenseFile?.sha256 ?? null,
			e.files.map((f) => [
				f.path,
				f.sha256,
				f.sizeBytes,
				f.title,
				f.types,
				f.tags,
				f.author ?? null,
				f.sourceUrl ?? null,
				f.inferTypes ?? null,
			]),
		]),
	);
	return h.digest('hex').slice(0, 32);
}

export const downloadBytesOf = (e: SoundPackCatalogEntry) =>
	e.download.type === 'zip' ? e.download.sizeBytes : e.files.reduce((s, f) => s + f.sizeBytes, 0);
export const installBytesOf = (e: SoundPackCatalogEntry) =>
	e.files.reduce((s, f) => s + f.sizeBytes, 0) + (e.licenseFile?.sizeBytes ?? 0);

/** `child` (resolved) is inside `base`. */
function insideDir(base: string, child: string): boolean {
	const b = resolve(base);
	const c = resolve(child);
	return c.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Joins a catalogue path under a folder, refusing anything that would land outside it (zip-slip; the catalogue schema
 * already refuses `..`, absolute paths, backslashes and NUL: this is the second check, at write time).
 */
export function safeJoin(base: string, rel: string): string {
	const parts = rel.split('/');
	if (
		!rel ||
		rel.includes('\0') ||
		rel.includes('\\') ||
		isAbsolute(rel) ||
		/^[A-Za-z]:/.test(rel) ||
		parts.some((p) => p === '' || p === '.' || p === '..')
	)
		throw new PackError('PACK_INVALID', `"${rel.slice(0, 120)}" is not a path inside the pack`);
	const out = join(base, ...parts);
	if (!insideDir(base, out))
		throw new PackError('PACK_INVALID', `"${rel.slice(0, 120)}" would be written outside the pack`);
	return out;
}

/** Where a catalogue URL reads from: an http(s) URL, or a local file (file: URL, or a path relative to the catalogue). */
export function sourceOf(
	url: string,
	base: string | null,
): { kind: 'http'; url: string } | { kind: 'file'; path: string } {
	if (/^https?:\/\//i.test(url)) return { kind: 'http', url };
	if (base === null) throw new PackError('PACK_INVALID', `"${url.slice(0, 120)}" is not an https URL`);
	if (url.startsWith('file:')) return { kind: 'file', path: fileURLToPath(url) };
	if (/^[a-z][a-z0-9+.-]*:/i.test(url))
		throw new PackError('PACK_INVALID', `Unsupported URL scheme in "${url.slice(0, 120)}"`);
	return { kind: 'file', path: resolve(base, url) };
}

export type DownloadOptions = {
	sizeBytes: number;
	sha256: string;
	signal: AbortSignal;
	stallMs?: number;
	timeoutMs?: number;
	onProgress?: (bytes: number) => void;
	label: string;
};

/**
 * Downloads `url` into `partial` (resuming a partial file of an interrupted earlier download: a Range request, or a
 * read from the offset for local files), never past `sizeBytes`, and checks the sha256 of the whole file. Returns the
 * bytes transferred now. A short or failed transfer keeps the partial file (the next install resumes it); a body that
 * is too long or does not match the sha256 deletes it; the caller deletes it on cancel.
 */
export async function downloadTo(
	src: ReturnType<typeof sourceOf>,
	partial: string,
	o: DownloadOptions,
): Promise<number> {
	await mkdir(dirname(partial), { recursive: true });
	let have = (await stat(partial).catch(() => null))?.size ?? 0;
	if (have > o.sizeBytes) {
		await rm(partial, { force: true });
		have = 0;
	}
	let hash = createHash('sha256');
	if (have > 0) {
		// What is already there counts towards the sha256 (read back once).
		const prior = createReadStream(partial, { end: have - 1 });
		for await (const chunk of prior) hash.update(chunk as Buffer);
	}
	if (have === o.sizeBytes) {
		// A complete earlier download (the job stopped before extracting): use it when it is the pinned file.
		if (hash.copy().digest('hex') === o.sha256) return 0;
		await rm(partial, { force: true });
		have = 0;
		hash = createHash('sha256');
	}

	const stall = new AbortController();
	const signal = AbortSignal.any([o.signal, stall.signal]);
	let stallTimer: NodeJS.Timeout | undefined;
	let reason: PackError | null = null;
	const kick = () => {
		clearTimeout(stallTimer);
		stallTimer = setTimeout(() => {
			reason = new PackError(
				'DOWNLOAD_TIMEOUT',
				`${o.label}: no data for ${Math.round((o.stallMs ?? PACK_STALL_MS) / 1000)} s`,
				true,
			);
			stall.abort(reason);
		}, o.stallMs ?? PACK_STALL_MS);
	};
	const overall = setTimeout(() => {
		reason = new PackError('DOWNLOAD_TIMEOUT', `${o.label}: the download took too long`, true);
		stall.abort(reason);
	}, o.timeoutMs ?? PACK_DOWNLOAD_TIMEOUT_MS);
	let got = 0;
	try {
		kick();
		let body: Readable;
		let append = have > 0;
		if (src.kind === 'file') {
			const st = await stat(src.path).catch(() => null);
			if (!st?.isFile()) throw new PackError('DOWNLOAD_FAILED', `${o.label}: the file is not there`, true);
			body = createReadStream(src.path, { start: have });
		} else {
			let res: Response;
			try {
				res = await fetch(src.url, {
					redirect: 'follow',
					signal,
					headers: {
						'user-agent': PACK_USER_AGENT,
						...(have > 0 ? { range: `bytes=${have}-` } : {}),
					},
				});
			} catch (e) {
				if (reason) throw reason;
				if (o.signal.aborted) throw e;
				throw new PackError('DOWNLOAD_FAILED', `${o.label}: ${(e as Error).message}`, true);
			}
			if (have > 0 && res.status === 206) {
				const range = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '');
				if (!range || Number(range[1]) !== have) {
					await res.body?.cancel().catch(() => undefined);
					throw new PackError('DOWNLOAD_FAILED', `${o.label}: the server resumed at the wrong offset`, true);
				}
			} else if (res.status === 200) {
				if (have > 0) {
					// The server ignored the Range request: start over.
					append = false;
					have = 0;
				}
			} else {
				await res.body?.cancel().catch(() => undefined);
				throw new PackError(
					'DOWNLOAD_FAILED',
					`${o.label}: HTTP ${res.status}`,
					res.status >= 500 || res.status === 429 || res.status === 408,
				);
			}
			if (!res.body) throw new PackError('DOWNLOAD_FAILED', `${o.label}: empty response`, true);
			const declared = Number(res.headers.get('content-length'));
			if (Number.isFinite(declared) && declared > 0 && have + declared > o.sizeBytes)
				throw new PackError(
					'PACK_TOO_LARGE',
					`${o.label}: the server sends ${have + declared} bytes, the catalogue pins ${o.sizeBytes}`,
				);
			body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
		}
		const h = append ? hash : createHash('sha256');
		const meter = new Transform({
			transform(chunk: Buffer, _enc, cb) {
				got += chunk.length;
				kick();
				// A body longer than the pinned size is never the pinned file: stop before it fills the disk.
				if (have + got > o.sizeBytes)
					return cb(
						new PackError(
							'PACK_TOO_LARGE',
							`${o.label}: larger than the ${o.sizeBytes} bytes the catalogue pins`,
						),
					);
				h.update(chunk);
				o.onProgress?.(have + got);
				cb(null, chunk);
			},
		});
		try {
			await pipeline(body, meter, createWriteStream(partial, { flags: append ? 'a' : 'w' }), { signal });
		} catch (e) {
			if (e instanceof PackError) throw e;
			if (reason) throw reason;
			if (o.signal.aborted) throw e;
			throw new PackError('DOWNLOAD_FAILED', `${o.label}: ${(e as Error).message}`, true);
		}
		const total = have + got;
		if (total !== o.sizeBytes)
			throw new PackError(
				'DOWNLOAD_FAILED',
				`${o.label}: the download ended after ${total} of ${o.sizeBytes} bytes (it resumes next time)`,
				true,
			);
		const sha = h.digest('hex');
		if (sha !== o.sha256) {
			await rm(partial, { force: true });
			throw new PackError(
				'PACK_CHECKSUM',
				`${o.label}: sha256 ${sha} does not match the pinned ${o.sha256} (the file changed upstream)`,
			);
		}
		return got;
	} catch (e) {
		if (e instanceof PackError && (e.code === 'PACK_TOO_LARGE' || e.code === 'PACK_CHECKSUM'))
			await rm(partial, { force: true });
		throw e;
	} finally {
		clearTimeout(stallTimer);
		clearTimeout(overall);
	}
}

/** sha256 of a file, or null when it is not a regular file of `size` bytes. */
async function verifiedFile(path: string, size: number, sha256: string): Promise<boolean> {
	const st = await stat(path).catch(() => null);
	if (!st?.isFile() || st.size !== size) return false;
	const h = createHash('sha256');
	for await (const c of createReadStream(path)) h.update(c as Buffer);
	return h.digest('hex') === sha256;
}

/** The `pack.json` of an installed pack: a starter-kit style manifest plus the install record. */
export function packManifestOf(
	e: SoundPackCatalogEntry,
	installedAt: string,
): {
	version: 1;
	packs: [Record<string, unknown>];
	sounds: SoundManifestSound[];
	install: Record<string, unknown>;
} {
	return {
		version: 1,
		packs: [
			{
				id: e.id,
				title: e.title,
				url: e.download.type === 'zip' ? e.download.url : e.pageUrl,
				sha256: packSha(e),
				license: e.license,
				licenseUrl: e.licenseUrl,
				author: e.author,
			},
		],
		sounds: e.files.map((f) => ({
			file: f.path,
			title: f.title,
			types: f.types,
			tags: f.tags,
			author: f.author ?? e.author,
			license: e.license,
			licenseUrl: e.licenseUrl,
			sourceUrl: f.sourceUrl ?? e.pageUrl,
			packId: e.id,
			...(e.attribution ? { attribution: e.attribution } : {}),
			...(f.inferTypes === false ? { inferTypes: false } : {}),
		})),
		install: {
			revision: entryRevision(e),
			installedAt,
			pageUrl: e.pageUrl,
			description: e.description,
			attribution: e.attribution,
			licenseEvidence: e.licenseEvidence,
			licenseFile: e.licenseFile?.path ?? null,
			files: e.files.length,
			bytes: installBytesOf(e),
		},
	};
}

type InstallRecord = {
	revision?: string;
	installedAt?: string;
	pageUrl?: string;
	description?: string;
	attribution?: string | null;
	licenseFile?: string | null;
};

export type InstalledPack = {
	id: string;
	dir: string;
	status: 'ok' | 'invalid';
	title: string;
	author: string;
	license: string;
	licenseUrl: string | null;
	sha256: string;
	url: string;
	sounds: number;
	/** Listed files present with their size. */
	complete: boolean;
	bytes: number;
	record: InstallRecord;
};

export type PackStoreOptions = {
	packsDir: string;
	catalog: () => Promise<PackCatalog>;
	/** Stall / overall timeouts (tests make them short). */
	stallMs?: number;
	timeoutMs?: number;
	/** Least time between two http(s) requests of a `files` pack (default {@link PACK_FILE_INTERVAL_MS}). */
	fileIntervalMs?: number;
	now?: () => Date;
};

export class SoundPackStore {
	constructor(private readonly o: PackStoreOptions) {}

	get packsDir(): string {
		return this.o.packsDir;
	}

	dirOf(id: string): string {
		if (!SOUND_PACK_ID_RE.test(id)) throw new PackError('SOUND_PACK_UNKNOWN', 'Invalid pack id');
		return join(this.o.packsDir, id);
	}

	async entry(id: string): Promise<SoundPackCatalogEntry | null> {
		return (await this.o.catalog()).entries.find((e) => e.id === id) ?? null;
	}

	/** Installed packs on disk (folders with a valid id), with their manifest read and their files checked by size. */
	async installed(): Promise<InstalledPack[]> {
		let names: string[] = [];
		try {
			names = (await readdir(this.o.packsDir, { withFileTypes: true }))
				.filter((d) => d.isDirectory() && SOUND_PACK_ID_RE.test(d.name))
				.map((d) => d.name)
				.sort();
		} catch {
			return [];
		}
		return Promise.all(names.map((id) => this.readInstalled(id)));
	}

	async readInstalled(id: string): Promise<InstalledPack> {
		const dir = this.dirOf(id);
		const m = await loadPackManifest(dir, id);
		let record: InstallRecord = {};
		try {
			const raw = JSON.parse(await readFile(join(dir, PACK_MANIFEST_FILE), 'utf8')) as { install?: unknown };
			if (raw.install && typeof raw.install === 'object') record = raw.install as InstallRecord;
		} catch {
			record = {};
		}
		const pack = m.packs[0];
		let bytes = 0;
		let complete = m.status === 'ok';
		if (m.status === 'ok') {
			const sizes = await Promise.all(
				m.sounds.map((s) => stat(join(dir, ...s.file.split('/'))).catch(() => null)),
			);
			for (const st of sizes) {
				if (st?.isFile()) bytes += st.size;
				else complete = false;
			}
		}
		return {
			id,
			dir,
			status: m.status === 'ok' ? 'ok' : 'invalid',
			title: pack?.title ?? id,
			author: pack?.author ?? '',
			license: pack?.license ?? 'unknown',
			licenseUrl: pack?.licenseUrl ?? null,
			sha256: pack?.sha256 ?? '',
			url: pack?.url ?? '',
			sounds: m.sounds.length,
			complete,
			bytes,
			record,
		};
	}

	/** The catalogue merged with what is installed (installed packs the catalogue lacks are listed too). */
	async list(opts: {
		indexed: (id: string) => number;
		job: (id: string) => EngineJob | null;
	}): Promise<{ packs: SoundPackInfo[]; catalogErrors: string[] }> {
		const catalog = await this.o.catalog();
		const installed = new Map((await this.installed()).map((p) => [p.id, p]));
		const packs: SoundPackInfo[] = catalog.entries.map((e) => {
			const i = installed.get(e.id);
			installed.delete(e.id);
			const state: SoundPackInfo['state'] = !i
				? 'available'
				: i.status !== 'ok' || !i.complete
					? 'damaged'
					: i.record.revision !== entryRevision(e)
						? 'outdated'
						: 'installed';
			return {
				id: e.id,
				title: e.title,
				author: e.author,
				description: e.description,
				license: e.license,
				licenseUrl: e.licenseUrl,
				licenseEvidence: e.licenseEvidence,
				attribution: e.attribution,
				pageUrl: e.pageUrl,
				downloadUrl: e.download.type === 'zip' ? e.download.url : null,
				sha256: packSha(e),
				downloadBytes: downloadBytesOf(e),
				installBytes: installBytesOf(e),
				sounds: e.files.length,
				inCatalog: true,
				state,
				installedAt: i?.record.installedAt ?? null,
				installedBytes: i ? i.bytes : null,
				indexedSounds: opts.indexed(e.id),
				job: opts.job(e.id),
			};
		});
		for (const i of installed.values())
			packs.push({
				id: i.id,
				title: i.title,
				author: i.author,
				description: i.record.description ?? '',
				license: i.license,
				licenseUrl: i.licenseUrl,
				licenseEvidence: [],
				attribution: i.record.attribution ?? null,
				pageUrl: i.record.pageUrl ?? null,
				downloadUrl: null,
				sha256: i.sha256,
				downloadBytes: 0,
				installBytes: i.bytes,
				sounds: i.sounds,
				inCatalog: false,
				state: i.status === 'ok' && i.complete ? 'installed' : 'damaged',
				installedAt: i.record.installedAt ?? null,
				installedBytes: i.bytes,
				indexedSounds: opts.indexed(i.id),
				job: opts.job(i.id),
			});
		return { packs, catalogErrors: catalog.errors };
	}

	/**
	 * Deletes leftovers of earlier runs: staging and trash folders (a crash mid-install) and partial downloads that no
	 * catalogue entry can resume or that nobody touched for 30 days. Called once when the engine starts.
	 */
	async cleanup(): Promise<void> {
		await rm(join(this.o.packsDir, STAGING), { recursive: true, force: true }).catch(() => undefined);
		await rm(join(this.o.packsDir, TRASH), { recursive: true, force: true }).catch(() => undefined);
		const dl = join(this.o.packsDir, DOWNLOADS);
		const names = await readdir(dl).catch(() => [] as string[]);
		if (!names.length) return;
		const catalog = await this.o.catalog();
		const keep = new Set<string>();
		for (const e of catalog.entries) {
			if (e.download.type === 'zip') keep.add(partialName(e.id, e.download.sha256));
			else for (const f of e.files) keep.add(partialName(e.id, f.sha256));
		}
		const now = Date.now();
		for (const n of names) {
			const p = join(dl, n);
			const st = await stat(p).catch(() => null);
			if (!keep.has(n) || !st || now - st.mtimeMs > STALE_PARTIAL_MS)
				await rm(p, { recursive: true, force: true });
		}
	}

	/**
	 * Installs (or repairs / updates) a pack. Files already installed with the pinned sha256 are kept, the rest is
	 * downloaded; the finished folder replaces the old one in one rename.
	 */
	async install(
		id: string,
		ctx: { signal: AbortSignal; progress?: (p: number | null, stage: string) => void; jobId: string },
	): Promise<Omit<SoundPackInstallResult, 'indexJobId'>> {
		const catalog = await this.o.catalog();
		const e = catalog.entries.find((x) => x.id === id);
		if (!e) throw new PackError('SOUND_PACK_UNKNOWN', `Unknown sound pack ${id}`);
		const dir = this.dirOf(id);
		const current = await this.readInstalled(id).catch(() => null);
		const installBytes = installBytesOf(e);
		if (
			current?.status === 'ok' &&
			current.complete &&
			current.record.revision === entryRevision(e) &&
			current.sounds === e.files.length
		)
			return {
				packId: id,
				alreadyInstalled: true,
				sounds: e.files.length,
				installedBytes: current.bytes,
				downloadedBytes: 0,
			};

		const stage = join(
			this.o.packsDir,
			STAGING,
			`${id}-${ctx.jobId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}-${randomBytes(4).toString('hex')}`,
		);
		await rm(stage, { recursive: true, force: true });
		await mkdir(stage, { recursive: true });
		let downloaded = 0;
		try {
			// Files of the installed folder that already are the pinned bytes are reused (an update that only changed
			// metadata, or a repair, downloads nothing for them).
			const missing: typeof e.files = [];
			let kept = 0;
			for (const f of e.files) {
				if (ctx.signal.aborted) throw new PackError('JOB_CANCELLED', 'Cancelled');
				const old = safeJoin(dir, f.path);
				if (current && (await verifiedFile(old, f.sizeBytes, f.sha256))) {
					const to = safeJoin(stage, f.path);
					await mkdir(dirname(to), { recursive: true });
					await copyFile(old, to);
					kept++;
				} else missing.push(f);
			}
			let licenseNeeded = false;
			if (e.licenseFile) {
				const old = safeJoin(dir, e.licenseFile.path);
				if (current && (await verifiedFile(old, e.licenseFile.sizeBytes, e.licenseFile.sha256))) {
					await copyFile(old, safeJoin(stage, e.licenseFile.path));
				} else licenseNeeded = true;
			}
			if (missing.length || licenseNeeded) {
				const need =
					(e.download.type === 'zip' ? e.download.sizeBytes : 0) +
					missing.reduce((s, f) => s + f.sizeBytes, 0) +
					(e.licenseFile?.sizeBytes ?? 0);
				await this.checkSpace(need);
				if (e.download.type === 'zip')
					downloaded = await this.fromArchive(e, catalog.base, stage, missing, licenseNeeded, ctx);
				else downloaded = await this.fromFiles(e, catalog.base, stage, missing, ctx, kept);
			}
			if (ctx.signal.aborted) throw new PackError('JOB_CANCELLED', 'Cancelled');
			ctx.progress?.(null, 'Installing');
			const installedAt = (this.o.now?.() ?? new Date()).toISOString();
			await atomicWriteJson(join(stage, PACK_MANIFEST_FILE), packManifestOf(e, installedAt), true);
			// The finished folder must read back as the pack the catalogue describes before it replaces anything.
			const check = await loadPackManifest(stage, id);
			if (check.status !== 'ok' || check.sounds.length !== e.files.length)
				throw new PackError(
					'PACK_INVALID',
					`The pack's manifest did not validate: ${check.errors.slice(0, 3).join('; ') || 'sounds missing'}`,
				);
			await this.swapIn(stage, dir);
			return {
				packId: id,
				alreadyInstalled: false,
				sounds: e.files.length,
				installedBytes: installBytes,
				downloadedBytes: downloaded,
			};
		} finally {
			await rm(stage, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async checkSpace(bytes: number): Promise<void> {
		await mkdir(this.o.packsDir, { recursive: true });
		const fs = await statfs(this.o.packsDir).catch(() => null);
		if (!fs) return;
		const free = Number(fs.bavail) * Number(fs.bsize);
		// room for the download and the extracted files, plus a margin for the index and the rest of the engine
		if (Number.isFinite(free) && free < bytes + 64 * 1024 * 1024)
			throw new PackError(
				'DISK_FULL',
				`Not enough free disk space to install the pack (${Math.ceil(bytes / 1_048_576)} MB needed, ${Math.floor(free / 1_048_576)} MB free)`,
			);
	}

	private async fromArchive(
		e: SoundPackCatalogEntry,
		base: string | null,
		stage: string,
		missing: SoundPackCatalogEntry['files'],
		licenseNeeded: boolean,
		ctx: { signal: AbortSignal; progress?: (p: number | null, stage: string) => void },
	): Promise<number> {
		if (e.download.type !== 'zip') return 0;
		const z = e.download;
		const partial = join(this.o.packsDir, DOWNLOADS, partialName(e.id, z.sha256));
		let got: number;
		try {
			got = await downloadTo(sourceOf(z.url, base), partial, {
				sizeBytes: z.sizeBytes,
				sha256: z.sha256,
				signal: ctx.signal,
				label: e.title,
				...(this.o.stallMs !== undefined ? { stallMs: this.o.stallMs } : {}),
				...(this.o.timeoutMs !== undefined ? { timeoutMs: this.o.timeoutMs } : {}),
				onProgress: (n) => ctx.progress?.(z.sizeBytes ? (0.9 * n) / z.sizeBytes : null, 'Downloading'),
			});
		} catch (err) {
			if (ctx.signal.aborted) await rm(partial, { force: true });
			throw err;
		}
		ctx.progress?.(0.9, 'Extracting');
		try {
			const buf = await readFile(partial);
			let entries: ReturnType<typeof listZip>;
			try {
				entries = listZip(buf);
			} catch (err) {
				throw new PackError('PACK_INVALID', `${e.title}: ${(err as Error).message}`);
			}
			const byName = new Map<string, (typeof entries)[number]>();
			// The first entry of a name wins (a duplicate later entry cannot replace a checked one).
			for (const x of entries) if (!byName.has(x.name)) byName.set(x.name, x);
			const want = [
				...missing.map((f) => ({ path: f.path, sizeBytes: f.sizeBytes, sha256: f.sha256 })),
				...(licenseNeeded && e.licenseFile ? [e.licenseFile] : []),
			];
			for (const f of want) {
				if (ctx.signal.aborted) throw new PackError('JOB_CANCELLED', 'Cancelled');
				const entry = byName.get(f.path);
				if (!entry) throw new PackError('PACK_MEMBER_MISSING', `${e.title}: the archive has no "${f.path}"`);
				// Size first (before inflating: a bomb never gets past this), then the sha256 of the inflated bytes.
				if (entry.size !== f.sizeBytes)
					throw new PackError(
						'PACK_CHECKSUM',
						`${e.title}: "${f.path}" is ${entry.size} bytes, the catalogue pins ${f.sizeBytes}`,
					);
				let data: Buffer;
				try {
					data = readZipEntry(buf, entry, f.sizeBytes);
				} catch (err) {
					throw new PackError(
						'PACK_INVALID',
						`${e.title}: ${err instanceof ZipError ? err.message : String(err)}`,
					);
				}
				const sha = createHash('sha256').update(data).digest('hex');
				if (sha !== f.sha256)
					throw new PackError('PACK_CHECKSUM', `${e.title}: "${f.path}" does not match its pinned sha256`);
				const to = safeJoin(stage, f.path);
				await mkdir(dirname(to), { recursive: true });
				await writeFile(to, data, { flag: 'wx' });
			}
		} catch (err) {
			// The archive matched its pinned sha256: a member problem is the catalogue's, so the download is not kept.
			await rm(partial, { force: true });
			throw err;
		}
		await rm(partial, { force: true });
		return got;
	}

	private async fromFiles(
		e: SoundPackCatalogEntry,
		base: string | null,
		stage: string,
		missing: SoundPackCatalogEntry['files'],
		ctx: { signal: AbortSignal; progress?: (p: number | null, stage: string) => void },
		kept: number,
	): Promise<number> {
		const total = missing.reduce((s, f) => s + f.sizeBytes, 0);
		const interval = this.o.fileIntervalMs ?? PACK_FILE_INTERVAL_MS;
		let done = 0;
		let got = 0;
		let lastRequest = Number.NEGATIVE_INFINITY;
		for (const [i, f] of missing.entries()) {
			if (ctx.signal.aborted) throw new PackError('JOB_CANCELLED', 'Cancelled');
			if (!f.url) throw new PackError('PACK_INVALID', `${e.title}: "${f.path}" has no URL`);
			const partial = join(this.o.packsDir, DOWNLOADS, partialName(e.id, f.sha256));
			const src = sourceOf(f.url, base);
			if (src.kind === 'http') {
				// One request at a time and at most one per `interval` (the sites that publish these files are small and
				// ask to be fetched politely); local files are not paced.
				const wait = lastRequest + interval - Date.now();
				if (wait > 0) await abortableDelay(wait, ctx.signal);
				lastRequest = Date.now();
			}
			const label = `Downloading ${kept + i + 1} of ${kept + missing.length}…`;
			try {
				got += await downloadTo(src, partial, {
					sizeBytes: f.sizeBytes,
					sha256: f.sha256,
					signal: ctx.signal,
					label: `${e.title}: ${f.path}`,
					...(this.o.stallMs !== undefined ? { stallMs: this.o.stallMs } : {}),
					...(this.o.timeoutMs !== undefined ? { timeoutMs: this.o.timeoutMs } : {}),
					onProgress: (n) => ctx.progress?.(total ? (done + n) / total : null, label),
				});
			} catch (err) {
				if (ctx.signal.aborted) await rm(partial, { force: true });
				throw err;
			}
			const to = safeJoin(stage, f.path);
			await mkdir(dirname(to), { recursive: true });
			await rename(partial, to);
			done += f.sizeBytes;
		}
		return got;
	}

	/** Replaces `dir` with `stage` (the old folder is moved aside first and deleted after). */
	private async swapIn(stage: string, dir: string): Promise<void> {
		const trashDir = join(this.o.packsDir, TRASH);
		await mkdir(trashDir, { recursive: true });
		const old = join(trashDir, `${dir.split(sep).pop()}-${randomBytes(4).toString('hex')}`);
		const had = !!(await stat(dir).catch(() => null));
		if (had) await rename(dir, old);
		try {
			await rename(stage, dir);
		} catch (err) {
			if (had) await rename(old, dir).catch(() => undefined);
			throw err;
		}
		if (had) await rm(old, { recursive: true, force: true }).catch(() => undefined);
	}

	/** Deletes an installed pack's folder (moved aside first, so the index never sees half a folder). */
	async remove(id: string): Promise<{ removed: boolean; freedBytes: number }> {
		const dir = this.dirOf(id);
		const st = await stat(dir).catch(() => null);
		if (!st?.isDirectory()) return { removed: false, freedBytes: 0 };
		const freed = await folderBytes(dir);
		const trashDir = join(this.o.packsDir, TRASH);
		await mkdir(trashDir, { recursive: true });
		const old = join(trashDir, `${id}-${randomBytes(4).toString('hex')}`);
		await rename(dir, old);
		await rm(old, { recursive: true, force: true });
		return { removed: true, freedBytes: freed };
	}

	/** Help ▸ About ▸ Licenses: one entry per installed pack (its licence text when the archive had one). */
	async licenses(): Promise<LicenseComponent[]> {
		const catalog = await this.o.catalog();
		const out: LicenseComponent[] = [];
		for (const p of await this.installed()) {
			if (p.status !== 'ok') continue;
			const e = catalog.entries.find((x) => x.id === p.id);
			let text: string | null = null;
			const lf = p.record.licenseFile;
			if (typeof lf === 'string' && lf) {
				try {
					const path = safeJoin(p.dir, lf);
					const st = await stat(path);
					if (st.isFile() && st.size <= LICENSE_TEXT_MAX) text = await readFile(path, 'utf8');
				} catch {
					text = null;
				}
			}
			const evidence = e?.licenseEvidence.map((x) => x.url).join(', ');
			const perFile = e?.files.filter((f) => f.licenseEvidence).length ?? 0;
			const checked = e?.files.map((f) => f.licenseEvidence?.checkedAt).find(Boolean);
			out.push({
				id: `sound-pack:${p.id}`,
				name: `${p.title} — sound pack (${p.sounds} sounds)`,
				version: p.sha256.slice(0, 12) || null,
				license: p.license,
				bundled: false,
				sourceUrl: p.record.pageUrl ?? p.url,
				notice: [
					`By ${p.author}. Downloaded on request from ${p.url} and installed in this computer's sound library.`,
					p.licenseUrl ? `Licence: ${p.licenseUrl}.` : '',
					p.record.attribution ? `Attribution: ${p.record.attribution}.` : 'No attribution is required.',
					evidence ? `Licence evidence: ${evidence}.` : '',
					perFile
						? `The licence of each of its ${perFile} sounds was also checked on the sound's own page${checked ? ` (${checked})` : ''}.`
						: '',
				]
					.filter(Boolean)
					.join(' '),
				texts: text ? [{ title: `${p.title}: ${lf}`, text }] : [],
			});
		}
		return out;
	}
}

/** Waits `ms`, or rejects with `JOB_CANCELLED` as soon as `signal` aborts. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new PackError('JOB_CANCELLED', 'Cancelled'));
		const onAbort = () => {
			clearTimeout(timer);
			reject(new PackError('JOB_CANCELLED', 'Cancelled'));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

export function partialName(id: string, sha256: string): string {
	return `${id}-${sha256.slice(0, 16)}.partial`;
}

async function folderBytes(dir: string): Promise<number> {
	let n = 0;
	const stack = [dir];
	while (stack.length) {
		const d = stack.pop()!;
		const items = await readdir(d, { withFileTypes: true }).catch(() => []);
		for (const it of items) {
			const p = join(d, it.name);
			if (it.isDirectory()) stack.push(p);
			else if (it.isFile()) n += (await stat(p).catch(() => null))?.size ?? 0;
		}
	}
	return n;
}
