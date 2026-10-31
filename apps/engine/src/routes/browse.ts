// Browsing is local-only, like path registration (S04:SC-002): remote engines never expose their disks.
//   GET /api/browse/roots              Home, the usual media folders, mounted volumes, the file-system root(s)
//   GET /api/browse/list?path=&all=    one folder: sub-folders and importable files (all=1: everything)
//   GET /api/browse/info?path=         size, date and the ffprobe summary of audio / video / stills
//   GET /api/browse/thumbnail?path=    JPEG thumbnail of a video frame or a still (cached under tmp/)
//   GET /api/browse/file?path=         the bytes of a video / audio / image (Range) for the preview player
// Import itself goes through `POST /api/media/register` (paths are registered in place), like File ▸ Import on
// the desktop.
//
// Path safety (docs/security-review.md §5 "Path-taking routes", and what a browser of the whole disk adds):
//   - local mode only; absolute paths without NUL, normalised;
//   - bytes are served for video / audio / picture extensions only (an allowlist), checked on the name asked for
//     and on the file it resolves to (a symlink `clip.mp4 → ~/.ssh/id_rsa` is refused), with the `nosniff` and
//     `CSP: sandbox` headers of every served user file; thumbnails likewise for video and pictures;
//   - a request a browser marks as coming from another site (`Sec-Fetch-Site: cross-site` / `same-site`) is
//     refused: on an engine without a token a web page could otherwise embed (not read) the user's pictures and
//     videos by guessing paths — media keys cannot be guessed, paths can;
//   - FFmpeg reads the files with `-protocol_whitelist file,crypto,data`: a playlist-like file that names network
//     or other local resources is not followed just because the user clicked it in a listing.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir, platform as osPlatform, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
	BROWSE_PREVIEWABLE,
	type BrowseCategory,
	type BrowseEntry,
	type BrowseInfo,
	BrowseListQuerySchema,
	BrowsePathQuerySchema,
	type BrowseRoot,
	BrowseThumbnailQuerySchema,
	browseCategoryOf,
} from '@jasper/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isLoopbackHost } from '../context.ts';
import { mapProbe } from '../media/probe.ts';
import { randomId } from '../tools/fs.ts';
import { contentTypeFor, serveFile } from '../tools/http.ts';
import { LOCAL_PROTOCOLS } from '../tools/protocols.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

/** At most this many entries per listing (folders first, then by name); `truncated` says when more exist. */
const BROWSE_LIST_LIMIT = 2000;
const STAT_CONCURRENCY = 32;
const PROBE_TIMEOUT_MS = 15_000;
const THUMB_TIMEOUT_MS = 20_000;
/** Thumbnails kept in `<tmp>/browse-thumbs`; the oldest are pruned past this count. */
const THUMB_CACHE_MAX = 1500;
/** ffmpeg thumbnail renders at once (a folder of videos must not spawn one ffmpeg per tile). */
const THUMB_CONCURRENCY = 2;

/** Validates an absolute host path from a query (no NUL, absolute) and normalises it (`..` resolved). */
function checkBrowsePath(p: string): string {
	if (p.includes('\0')) throw new HttpError(400, 'BAD_PATH', 'The path contains a NUL byte');
	if (!isAbsolute(p)) throw new HttpError(400, 'BAD_PATH', 'The path must be absolute');
	return resolve(p);
}

const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then by name in natural order ("clip 2" before "clip 10"). */
function sortEntries<T extends { kind: 'folder' | 'file'; name: string }>(list: T[]): T[] {
	return list.sort((a, b) =>
		a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : naturalOrder.compare(a.name, b.name),
	);
}

function fsError(e: unknown, what: string): HttpError {
	const code = (e as NodeJS.ErrnoException).code;
	if (code === 'ENOENT') return new HttpError(404, 'NOT_FOUND', `${what} not found`);
	if (code === 'EACCES' || code === 'EPERM')
		return new HttpError(403, 'PERMISSION_DENIED', `${what} cannot be read (permission denied)`);
	if (code === 'ENOTDIR') return new HttpError(400, 'NOT_A_FOLDER', 'The path is not a folder');
	return new HttpError(500, 'FS_ERROR', `${what} cannot be read: ${(e as Error).message}`);
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

/** Lists one folder. */
async function listFolder(
	path: string,
	all: boolean,
): Promise<{ entries: BrowseEntry[]; truncated: boolean }> {
	let dirents: import('node:fs').Dirent[];
	try {
		dirents = await readdir(path, { withFileTypes: true });
	} catch (e) {
		throw fsError(e, 'The folder');
	}
	type Pending = { name: string; kind: 'folder' | 'file'; link: boolean };
	const pending: Pending[] = [];
	for (const d of dirents) {
		const name = String(d.name);
		const hidden = name.startsWith('.');
		if (hidden && !all) continue;
		if (d.isDirectory()) pending.push({ name, kind: 'folder', link: false });
		else if (d.isFile()) {
			if (all || browseCategoryOf(name)) pending.push({ name, kind: 'file', link: false });
		} else if (d.isSymbolicLink()) pending.push({ name, kind: 'file', link: true });
	}
	// Symlinks: follow them to learn what they point at (broken links are dropped).
	const resolved = (
		await mapLimit(pending, STAT_CONCURRENCY, async (p) => {
			if (!p.link) return p;
			try {
				const s = await stat(join(path, p.name));
				if (s.isDirectory()) return { ...p, kind: 'folder' as const };
				if (s.isFile() && (all || browseCategoryOf(p.name))) return { ...p, kind: 'file' as const };
				return null;
			} catch {
				return null;
			}
		})
	).filter((p): p is Pending => p !== null);
	const sorted = sortEntries(resolved);
	const truncated = sorted.length > BROWSE_LIST_LIMIT;
	const kept = sorted.slice(0, BROWSE_LIST_LIMIT);
	const entries = await mapLimit(kept, STAT_CONCURRENCY, async (p): Promise<BrowseEntry> => {
		const full = join(path, p.name);
		let size: number | null = null;
		let modifiedAt: string | null = null;
		try {
			const s = await stat(full);
			size = p.kind === 'file' ? s.size : null;
			modifiedAt = Number.isFinite(s.mtimeMs) ? new Date(s.mtimeMs).toISOString() : null;
		} catch {
			// unreadable entry: listed without size / date
		}
		return {
			name: p.name,
			path: full,
			kind: p.kind,
			size,
			modifiedAt,
			category: p.kind === 'file' ? browseCategoryOf(p.name) : null,
			hidden: p.name.startsWith('.'),
		};
	});
	return { entries, truncated };
}

/** Home, its usual media folders, mounted volumes and the file-system root(s) that exist on this host. */
function browseRoots(): BrowseRoot[] {
	const home = homedir();
	const plat = osPlatform();
	const roots: BrowseRoot[] = [{ label: 'Home', path: home, kind: 'home' }];
	for (const name of ['Desktop', 'Movies', 'Videos', 'Music', 'Pictures', 'Downloads', 'Documents']) {
		const p = join(home, name);
		if (existsSync(p)) roots.push({ label: name, path: p, kind: 'folder' });
	}
	if (plat === 'win32') {
		for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
			const p = `${letter}:\\`;
			if (existsSync(p)) roots.push({ label: `${letter}:`, path: p, kind: 'root' });
		}
		return roots;
	}
	let user = '';
	try {
		user = userInfo().username;
	} catch {
		user = '';
	}
	const volumeDirs =
		plat === 'darwin'
			? ['/Volumes']
			: ['/media', ...(user ? [`/media/${user}`, `/run/media/${user}`] : []), '/mnt'];
	const seen = new Set<string>();
	for (const dir of volumeDirs) {
		for (const name of listDirSync(dir)) {
			const p = join(dir, name);
			if (seen.has(p) || (user && p === `/media/${user}`)) continue;
			seen.add(p);
			roots.push({ label: name, path: p, kind: 'volume' });
		}
	}
	roots.push({ label: plat === 'darwin' ? 'Macintosh HD' : 'File System', path: '/', kind: 'root' });
	return roots;
}

function listDirSync(p: string): string[] {
	try {
		return readdirSync(p, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith('.'))
			.map((d) => d.name);
	} catch {
		return [];
	}
}

const THUMBNAIL_KINDS: ReadonlySet<BrowseCategory> = new Set(['video', 'image']);

/** A tiny counting semaphore. */
function semaphore(n: number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (active >= n) await new Promise<void>((r) => waiting.push(r));
		active++;
		try {
			return await fn();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

export default async function browseRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	const local = () => core.config.dev || isLoopbackHost(core.config.host);
	const requireLocal = () => {
		if (!local())
			throw new HttpError(403, 'LOCAL_MODE_ONLY', 'The Media Browser is only available with a local engine');
	};
	/** Refuses outside local mode and for requests a browser sends on behalf of another site. */
	const guard = (req: FastifyRequest) => {
		requireLocal();
		const site = req.headers['sec-fetch-site'];
		if (site === 'cross-site' || site === 'same-site')
			throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'The Media Browser only answers the editor itself');
	};
	/**
	 * The file to read for a previewable path: its real location, which must be a file of an allowed kind too (the
	 * name asked for was checked by the caller).
	 */
	const previewable = async (path: string, kinds: ReadonlySet<BrowseCategory>): Promise<string> => {
		let real: string;
		try {
			real = await realpath(path);
		} catch (e) {
			throw fsError(e, 'The file');
		}
		const category = browseCategoryOf(real);
		if (!category || !kinds.has(category))
			throw new HttpError(403, 'NOT_PREVIEWABLE', 'The file this path points at is not a media file');
		return real;
	};
	const thumbsDir = join(core.config.paths.tmpDir, 'browse-thumbs');
	const limitThumbs = semaphore(THUMB_CONCURRENCY);
	let writes = 0;

	const fileStat = async (path: string) => {
		try {
			const s = await stat(path);
			if (!s.isFile()) throw new HttpError(400, 'NOT_A_FILE', 'The path is not a file');
			return s;
		} catch (e) {
			if (e instanceof HttpError) throw e;
			throw fsError(e, 'The file');
		}
	};

	app.get(
		'/api/browse/roots',
		guarded(async (req) => {
			guard(req);
			return { sep, home: homedir(), roots: browseRoots() };
		}),
	);

	app.get(
		'/api/browse/list',
		guarded(async (req) => {
			guard(req);
			const q = parseOr400(BrowseListQuerySchema, req.query);
			const path = checkBrowsePath(q.path);
			const { entries, truncated } = await listFolder(path, q.all === '1');
			const up = dirname(path);
			return { path, parent: up === path ? null : up, entries, truncated };
		}),
	);

	app.get(
		'/api/browse/info',
		guarded(async (req) => {
			guard(req);
			const path = checkBrowsePath(parseOr400(BrowsePathQuerySchema, req.query).path);
			const s = await fileStat(path);
			const category = browseCategoryOf(path);
			const out: BrowseInfo = {
				path,
				name: basename(path),
				size: s.size,
				modifiedAt: new Date(s.mtimeMs).toISOString(),
				category,
				media: null,
			};
			if (category && BROWSE_PREVIEWABLE.has(category)) {
				try {
					const real = await previewable(path, BROWSE_PREVIEWABLE);
					const r = mapProbe(
						await core.ffmpeg.probeJson([...LOCAL_PROTOCOLS, '-show_format', '-show_streams', real], {
							signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
						}),
					);
					const v = r.probe.streams.find((x) => x.type === 'video');
					const a = r.probe.streams.find((x) => x.type === 'audio');
					const fps =
						v && v.frameRate.den > 0 && category === 'video' ? v.frameRate.num / v.frameRate.den : null;
					out.media = {
						durationSec: r.durationSec !== null && Number.isFinite(r.durationSec) ? r.durationSec : null,
						width: r.display?.width ?? null,
						height: r.display?.height ?? null,
						fps: fps !== null && Number.isFinite(fps) ? Math.round(fps * 1000) / 1000 : null,
						videoCodec: v?.codec ?? null,
						audioCodec: a?.type === 'audio' ? a.codec : null,
						sampleRate: a?.type === 'audio' ? a.sampleRate : null,
						channels: a?.type === 'audio' ? a.channels : null,
						browserPlayable: r.browserPlayable,
					};
				} catch (e) {
					out.error = (e as Error).message.slice(0, 300);
				}
			}
			return out;
		}),
	);

	app.get(
		'/api/browse/thumbnail',
		guarded(async (req, reply) => {
			guard(req);
			const q = parseOr400(BrowseThumbnailQuerySchema, req.query);
			const path = checkBrowsePath(q.path);
			const width = q.width ?? 160;
			const s = await fileStat(path);
			const category = browseCategoryOf(path);
			if (category !== 'video' && category !== 'image')
				throw new HttpError(404, 'NO_THUMBNAIL', 'This kind of file has no thumbnail');
			const real = await previewable(path, THUMBNAIL_KINDS);
			const key = createHash('sha1').update(`${real}\0${s.size}\0${s.mtimeMs}\0${width}`).digest('hex');
			const out = join(thumbsDir, `${key}.jpg`);
			if (!existsSync(out)) {
				await limitThumbs(async () => {
					if (existsSync(out)) return;
					await mkdir(thumbsDir, { recursive: true });
					const tmp = join(thumbsDir, `.${randomId('t', 6)}.jpg`);
					const signal = AbortSignal.timeout(THUMB_TIMEOUT_MS);
					const render = (at: number | null) =>
						core.ffmpeg.run(
							[
								...LOCAL_PROTOCOLS,
								...(at !== null ? ['-ss', String(at)] : []),
								'-i',
								real,
								'-frames:v',
								'1',
								'-vf',
								`scale='min(${width},iw)':-2`,
								'-q:v',
								'5',
								'-f',
								'image2',
								'-c:v',
								'mjpeg',
								tmp,
							],
							{ signal },
						);
					try {
						if (category === 'video') {
							// A frame a little into the clip (black leaders), else the first one (short clips).
							await render(1).catch(() => render(null));
							if (!existsSync(tmp)) await render(null);
						} else await render(null);
						await rename(tmp, out);
					} catch {
						await rm(tmp, { force: true }).catch(() => undefined);
						throw new HttpError(404, 'NO_THUMBNAIL', 'No thumbnail could be made of this file');
					}
					if (++writes % 100 === 0) void pruneThumbs(thumbsDir);
				});
			}
			return serveFile(req, reply, out, { cache: 'revalidate', contentType: 'image/jpeg' });
		}),
	);

	app.get(
		'/api/browse/file',
		guarded(async (req, reply) => {
			guard(req);
			const path = checkBrowsePath(parseOr400(BrowsePathQuerySchema, req.query).path);
			const category = browseCategoryOf(path);
			if (!category || !BROWSE_PREVIEWABLE.has(category))
				throw new HttpError(403, 'NOT_PREVIEWABLE', 'Only video, audio and image files are served');
			await fileStat(path);
			const real = await previewable(path, BROWSE_PREVIEWABLE);
			return serveFile(req, reply, real, { cache: 'revalidate', contentType: contentTypeFor(path) });
		}),
	);
}

/** Keeps the thumbnail cache bounded: drops the oldest files past THUMB_CACHE_MAX. */
async function pruneThumbs(dir: string): Promise<void> {
	try {
		const names = (await readdir(dir)).filter((n) => n.endsWith('.jpg') && !n.startsWith('.'));
		if (names.length <= THUMB_CACHE_MAX) return;
		const withTime = await mapLimit(names, STAT_CONCURRENCY, async (n) => {
			try {
				return { n, t: (await stat(join(dir, n))).mtimeMs };
			} catch {
				return { n, t: 0 };
			}
		});
		withTime.sort((a, b) => a.t - b.t);
		for (const { n } of withTime.slice(0, names.length - Math.floor(THUMB_CACHE_MAX / 2)))
			await rm(join(dir, n), { force: true }).catch(() => undefined);
	} catch {
		// the cache folder is optional
	}
}
