// Movable cache location (M3, wp-m3-cachegc, S04:CA-021) — Premiere's "Media Cache location".
//
// The cache folders `cache/`, `mg/`, `renders/` and `tmp/` (tmp moves along so that the renames from job scratch into
// the cache stay on one disk) live in the engine's data folder by default. With a custom location L they live in
// `L/JasperEditor Media Cache/<dir>` and `<appdir>/<dir>` is a directory link (symlink; a junction on Windows) to it,
// so every service keeps using its appdir paths and the switch is one atomic rename of a link per folder.
//
// A move is a `cache-move` job that runs alone (it takes every CPU slot, so it waits for running jobs and nothing
// starts meanwhile) inside the cache's pass chain (no GC pass runs). Steps, journalled in `engine/cache-move.json`:
//   copying    — other disk: each folder is copied to `<target>.partial-<id>` with progress, then renamed into place;
//   switching  — the setting is written first, then each link is switched (same disk: the folder is renamed);
//   cleanup    — the old files go (a `fresh` start keeps them with `keepOld`).
// `repairCacheLocation` (engine start, before anything else) finishes or rolls back an interrupted move, re-creates
// links, and falls back to a fresh cache in the data folder when the location is unavailable (drive unplugged).
import { randomBytes } from 'node:crypto';
import {
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { access, copyFile, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CacheLocationCheck } from '@jasper/api';
import { freeDiskBytes } from '../tools/fs.ts';

/** Folders that make up the cache (moved together). */
const MOVED_DIRS = ['cache', 'mg', 'renders', 'tmp'] as const;
/** Sub-folder created in a chosen location (never clobbers the folder's other contents). */
const CACHE_SUBDIR = 'JasperEditor Media Cache';
const OLD_PREFIX = '.cache-old-';

type Journal = {
	id: string;
	state: 'copying' | 'switching' | 'cleanup';
	from: string | null;
	to: string | null;
	mode: 'move' | 'fresh';
	keepOld: boolean;
};

const settingsFile = (appdir: string) => join(appdir, 'engine', 'cache.json');
const journalFile = (appdir: string) => join(appdir, 'engine', 'cache-move.json');

/** Physical folder that holds the cache folders for a location setting (null = the data folder). */
export function physicalRoot(appdir: string, location: string | null): string {
	return location ? join(location, CACHE_SUBDIR) : appdir;
}

/** The `location` of `engine/cache.json` (null when unset or unreadable). */
function readLocationSetting(appdir: string): string | null {
	try {
		const v = (JSON.parse(readFileSync(settingsFile(appdir), 'utf8')) as { location?: unknown }).location;
		return typeof v === 'string' && isAbsolute(v) ? v : null;
	} catch {
		return null;
	}
}

function writeLocationSettingSync(appdir: string, location: string | null): void {
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(readFileSync(settingsFile(appdir), 'utf8')) as Record<string, unknown>;
	} catch {
		// first setting
	}
	raw.location = location;
	mkdirSync(dirname(settingsFile(appdir)), { recursive: true });
	const tmp = `${settingsFile(appdir)}.${randomBytes(4).toString('hex')}.tmp`;
	writeFileSync(tmp, JSON.stringify(raw, null, 2));
	renameSync(tmp, settingsFile(appdir));
}

function readJournal(appdir: string): Journal | null {
	try {
		return JSON.parse(readFileSync(journalFile(appdir), 'utf8')) as Journal;
	} catch {
		return null;
	}
}

function writeJournal(appdir: string, j: Journal | null): void {
	if (!j) {
		rmSync(journalFile(appdir), { force: true });
		return;
	}
	mkdirSync(dirname(journalFile(appdir)), { recursive: true });
	const tmp = `${journalFile(appdir)}.tmp`;
	writeFileSync(tmp, JSON.stringify(j));
	renameSync(tmp, journalFile(appdir));
}

const isLink = (p: string) => {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
};

/** Points `link` at `target` atomically (a new link renamed over the old one). `link` must not be a real folder. */
function linkSync(target: string, link: string): void {
	const tmp = `${link}.link-${randomBytes(3).toString('hex')}`;
	symlinkSync(target, tmp, process.platform === 'win32' ? 'junction' : 'dir');
	try {
		renameSync(tmp, link);
	} catch (e) {
		// Windows cannot rename over a junction: remove, then rename.
		if (isLink(link)) {
			unlinkSync(link);
			renameSync(tmp, link);
		} else {
			unlinkSync(tmp);
			throw e;
		}
	}
}

/** Moves a real folder out of the way (into `<appdir>/.cache-old-<id>/`) for deletion. */
function setAsideSync(appdir: string, id: string, dir: string, keep = false): void {
	const p = join(appdir, dir);
	if (!existsSync(p) || isLink(p)) return;
	// Kept files (a fresh start with "keep the old files") get a visible name and are never deleted.
	const old = join(appdir, keep ? `Old Media Cache ${id}` : `${OLD_PREFIX}${id}`);
	mkdirSync(old, { recursive: true });
	renameSync(p, join(old, dir));
}

/**
 * Engine start (before the appdir is used): completes or rolls back an interrupted move and makes every cache folder
 * of the appdir point where the setting says. Never throws; returns the location in effect and a warning.
 */
export function repairCacheLocation(
	appdir: string,
	log?: (m: string) => void,
): { location: string | null; warning: string | null } {
	let location = readLocationSetting(appdir);
	let warning: string | null = null;
	const j = readJournal(appdir);
	try {
		if (j?.state === 'copying') {
			// Interrupted before the switch: the old location stays; drop the partial copies.
			const root = physicalRoot(appdir, j.to);
			for (const d of MOVED_DIRS)
				for (const n of existsSync(root) ? readdirSync(root) : [])
					if (n.startsWith(`${d}.partial-${j.id}`)) rmSync(join(root, n), { recursive: true, force: true });
			writeJournal(appdir, null);
		} else if (j?.state === 'switching') {
			// Interrupted switch (the setting may not be written yet): finish it below, delete what is old later.
			location = j.to;
			writeLocationSettingSync(appdir, j.to);
		}
		const root = physicalRoot(appdir, location);
		for (const d of MOVED_DIRS) {
			const link = join(appdir, d);
			if (!location) {
				// Default location: real folders. A link left over (interrupted move back): take the data if possible.
				if (isLink(link)) {
					const target = readlinkSync(link);
					unlinkSync(link);
					try {
						if (existsSync(target)) renameSync(target, link);
					} catch {
						// another disk: start empty here (the old copy is left where it was)
					}
				}
				mkdirSync(link, { recursive: true });
				continue;
			}
			const target = join(root, d);
			try {
				mkdirSync(target, { recursive: true });
			} catch (e) {
				warning = `The media cache location ${location} is not available (${(e as Error).message}); using a fresh cache in the data folder`;
				if (isLink(link)) unlinkSync(link);
				mkdirSync(link, { recursive: true });
				continue;
			}
			if (isLink(link)) {
				if (resolve(readlinkSync(link)) !== resolve(target)) linkSync(target, link);
				continue;
			}
			if (existsSync(link)) {
				// A real folder where a link belongs (interrupted switch): same disk → its data moves; else set aside.
				try {
					if (readdirSync(target).length === 0) {
						rmSync(target, { recursive: true, force: true });
						renameSync(link, target);
					} else setAsideSync(appdir, j?.id ?? 'repair', d);
				} catch {
					mkdirSync(target, { recursive: true });
					setAsideSync(appdir, j?.id ?? 'repair', d);
				}
			}
			linkSync(target, link);
		}
		if (j && j.state !== 'copying') writeJournal(appdir, { ...j, state: 'cleanup' });
	} catch (e) {
		warning = `Could not repair the media cache location: ${(e as Error).message}`;
	}
	if (warning) log?.(`[cache] ${warning}`);
	return { location, warning };
}

/** Deletes what a finished (or repaired) move left behind: `.cache-old-*` folders and the old location's files. */
export async function finishCleanup(appdir: string): Promise<void> {
	const j = readJournal(appdir);
	for (const n of await readdir(appdir).catch(() => [] as string[]))
		if (n.startsWith(OLD_PREFIX))
			await rm(join(appdir, n), { recursive: true, force: true }).catch(() => undefined);
	if (j?.state === 'cleanup') {
		if (!(j.mode === 'fresh' && j.keepOld) && j.from !== j.to && j.from) {
			const oldRoot = physicalRoot(appdir, j.from);
			for (const d of MOVED_DIRS)
				await rm(join(oldRoot, d), { recursive: true, force: true }).catch(() => undefined);
			await rm(oldRoot, { recursive: false, force: true }).catch(() => undefined);
		}
		writeJournal(appdir, null);
	}
}

async function nearestExisting(p: string): Promise<string> {
	let cur = resolve(p);
	for (;;) {
		if (
			await stat(cur).then(
				() => true,
				() => false,
			)
		)
			return cur;
		const up = dirname(cur);
		if (up === cur) return cur;
		cur = up;
	}
}

const inside = (child: string, parent: string) => {
	const r = relative(parent, child);
	return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

async function treeBytes(p: string): Promise<number> {
	const st = await lstat(p).catch(() => null);
	if (!st || st.isSymbolicLink()) return 0;
	if (!st.isDirectory()) return st.size;
	let n = 0;
	for (const c of await readdir(p).catch(() => [] as string[])) n += await treeBytes(join(p, c));
	return n;
}

/** Bytes of the cache folders at their physical location. */
export async function cacheBytes(appdir: string, location: string | null): Promise<number> {
	const root = physicalRoot(appdir, location);
	let n = 0;
	for (const d of MOVED_DIRS) if (d !== 'tmp') n += await treeBytes(join(root, d));
	return n;
}

/** CA-021: can the cache go to `path` (null = the data folder)? */
export async function checkLocation(
	appdir: string,
	current: string | null,
	path: string | null,
	mode: 'move' | 'fresh' = 'move',
): Promise<CacheLocationCheck> {
	const target = path === null ? null : resolve(path);
	const root = physicalRoot(appdir, target);
	const curRoot = physicalRoot(appdir, current);
	const base: CacheLocationCheck = {
		path: root,
		isDefault: target === null,
		ok: false,
		message: null,
		exists: false,
		writable: false,
		freeBytes: null,
		requiredBytes: 0,
		sameDevice: false,
		sameAsCurrent: resolve(root) === resolve(curRoot),
	};
	if (path !== null && !isAbsolute(path)) return { ...base, path, message: 'Choose an absolute folder path' };
	if (base.sameAsCurrent)
		return { ...base, ok: false, exists: true, writable: true, message: 'The cache is already there' };
	if (target) {
		for (const d of [...MOVED_DIRS, 'engine', 'projects', 'media'])
			if (inside(root, join(appdir, d)) || inside(root, join(curRoot, d)))
				return { ...base, message: 'Choose a folder outside the current cache and data folders' };
		if (inside(curRoot, root) && current !== null)
			return { ...base, message: 'Choose a folder that does not contain the current cache' };
	}
	const existing = await nearestExisting(root);
	base.exists = resolve(existing) === resolve(root);
	base.writable = await access(existing, constants.W_OK).then(
		() => true,
		() => false,
	);
	if (base.exists && target)
		for (const d of MOVED_DIRS) {
			const names = await readdir(join(root, d)).catch(() => [] as string[]);
			if (names.length) return { ...base, message: `${join(root, d)} is not empty: choose another folder` };
		}
	const [a, b] = await Promise.all([
		stat(existing).catch(() => null),
		stat(await nearestExisting(curRoot)).catch(() => null),
	]);
	base.sameDevice = !!a && !!b && a.dev === b.dev;
	base.freeBytes = await freeDiskBytes(existing);
	base.requiredBytes = mode === 'move' && !base.sameDevice ? await cacheBytes(appdir, current) : 0;
	if (!base.writable) return { ...base, message: `${existing} is not writable` };
	const margin = 100 * 1024 * 1024;
	if (base.freeBytes !== null && base.freeBytes < base.requiredBytes + margin)
		return {
			...base,
			message: `Not enough free space there: the cache needs ${Math.ceil(base.requiredBytes / 1048576)} MB`,
		};
	return { ...base, ok: true };
}

async function copyTree(
	src: string,
	dst: string,
	onBytes: (n: number) => void,
	signal: AbortSignal,
): Promise<void> {
	const st = await lstat(src).catch(() => null);
	if (!st) return;
	if (signal.aborted) throw new Error('Cancelled');
	if (st.isDirectory()) {
		await mkdir(dst, { recursive: true });
		for (const c of await readdir(src)) await copyTree(join(src, c), join(dst, c), onBytes, signal);
	} else if (st.isFile()) {
		await copyFile(src, dst);
		onBytes(st.size);
	}
}

type MoveOptions = {
	appdir: string;
	from: string | null;
	to: string | null;
	mode: 'move' | 'fresh';
	keepOld: boolean;
	signal: AbortSignal;
	onProgress(fraction: number | null, stage: string): void;
};

/**
 * Moves the cache (see the header). Call only when nothing uses the cache (the `cache-move` job runs alone, inside the
 * cache pass chain). On failure before the switch nothing changes (partial copies are removed).
 */
export async function moveCache(o: MoveOptions): Promise<{ movedBytes: number }> {
	const id = randomBytes(4).toString('hex');
	const fromRoot = physicalRoot(o.appdir, o.from);
	const toRoot = physicalRoot(o.appdir, o.to);
	const journal: Journal = { id, state: 'copying', from: o.from, to: o.to, mode: o.mode, keepOld: o.keepOld };
	await mkdir(toRoot, { recursive: true });
	const sameDevice = (await stat(toRoot)).dev === (await stat(await nearestExisting(fromRoot))).dev;
	writeJournal(o.appdir, journal);
	const physical = (d: string) => join(fromRoot, d);
	let moved = 0;
	try {
		// Copy (other disk). tmp is scratch: never copied.
		if (o.mode === 'move' && !sameDevice) {
			const total = await cacheBytes(o.appdir, o.from);
			for (const d of MOVED_DIRS) {
				const dst = join(toRoot, d);
				if (d === 'tmp') continue;
				const partial = `${dst}.partial-${id}`;
				o.onProgress(total ? moved / total : null, `Copying ${d}/`);
				await copyTree(
					physical(d),
					partial,
					(n) => {
						moved += n;
						o.onProgress(
							total ? Math.min(0.95, moved / total) : null,
							`Copying ${d}/ · ${Math.round(moved / 1048576)} MB`,
						);
					},
					o.signal,
				);
				await rm(dst, { recursive: true, force: true });
				await rename(partial, dst);
			}
		}
	} catch (e) {
		for (const d of MOVED_DIRS)
			await rm(join(toRoot, `${d}.partial-${id}`), { recursive: true, force: true }).catch(() => undefined);
		writeJournal(o.appdir, null);
		throw e;
	}
	// Switch: the setting first (a crash from here on is completed by repairCacheLocation at the next start).
	o.onProgress(0.96, 'Switching');
	writeJournal(o.appdir, { ...journal, state: 'switching' });
	writeLocationSettingSync(o.appdir, o.to);
	for (const d of MOVED_DIRS) {
		const link = join(o.appdir, d);
		const target = join(toRoot, d);
		const source = physical(d);
		const carry = o.mode === 'move' && sameDevice && d !== 'tmp';
		if (o.to === null) {
			// Back into the data folder: the link becomes a real folder.
			if (isLink(link)) unlinkSync(link);
			if (carry && existsSync(source)) {
				await rm(link, { recursive: true, force: true });
				await rename(source, link);
			}
			// (other disk: the copy was renamed into `<appdir>/<d>` above)
			await mkdir(link, { recursive: true });
			continue;
		}
		if (carry && existsSync(source)) {
			// Same disk: one rename (from the real `<appdir>/<d>` there is no folder until the link exists: no job runs).
			await rm(target, { recursive: true, force: true });
			await rename(source, target);
		} else await mkdir(target, { recursive: true });
		if (!isLink(link) && existsSync(link))
			setAsideSync(o.appdir, id, d, o.mode === 'fresh' && o.keepOld && d !== 'tmp');
		linkSync(target, link);
	}
	writeJournal(o.appdir, { ...journal, state: 'cleanup' });
	o.onProgress(0.98, 'Removing the old files');
	await finishCleanup(o.appdir);
	return { movedBytes: moved };
}
