// Filesystem helpers: atomic writes (S01:PER-016), JSON read/write, disk space (S04:IN-005).
import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm, stat, statfs } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export function sha256File(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		createReadStream(file)
			.on('data', (chunk) => hash.update(chunk))
			.on('end', () => resolve(hash.digest('hex')))
			.on('error', reject);
	});
}

async function fsyncDir(dir: string): Promise<void> {
	// Directory fsync makes the rename durable. Not supported on every platform (Windows): best effort.
	let fh: Awaited<ReturnType<typeof open>> | null = null;
	try {
		fh = await open(dir, constants.O_RDONLY);
		await fh.sync();
	} catch {
		// ignore
	} finally {
		await fh?.close().catch(() => undefined);
	}
}

/**
 * Atomic replace: write `<file>.<rand>.tmp`, fsync, rename over the target, fsync the directory
 * (S01:PER-016). A crash leaves either the old or the new file, never a torn one.
 */
export async function atomicWriteFile(file: string, data: string | Uint8Array): Promise<void> {
	const dir = dirname(file);
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.${basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
	const fh = await open(tmp, 'w');
	try {
		await fh.writeFile(data);
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
	await fsyncDir(dir);
}

/**
 * Copies `src` to `dest` so that `dest` is either absent or complete (temporary file, fsync, rename): a crash or a
 * full disk mid-copy never leaves a truncated file under the final name (security review DATA-6).
 */
export async function atomicCopyFile(src: string, dest: string): Promise<void> {
	const dir = dirname(dest);
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.${basename(dest)}.${randomBytes(4).toString('hex')}.tmp`);
	try {
		await copyFile(src, tmp);
		const fh = await open(tmp, 'r+');
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
		await rename(tmp, dest);
	} catch (e) {
		await rm(tmp, { force: true });
		throw e;
	}
	await fsyncDir(dir);
}

export async function atomicWriteJson(file: string, value: unknown, pretty = false): Promise<void> {
	await atomicWriteFile(file, JSON.stringify(value, null, pretty ? 2 : undefined));
}

/** Parsed JSON, or `null` when the file is missing or not valid JSON. */
export async function readJsonOrNull<T = unknown>(file: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(file, 'utf8')) as T;
	} catch {
		return null;
	}
}

export async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Free bytes on the filesystem holding `path`, or null when unknown. */
export async function freeDiskBytes(path: string): Promise<number | null> {
	try {
		const s = await statfs(path);
		return Number(s.bavail) * Number(s.bsize);
	} catch {
		return null;
	}
}

/** A file name that is safe inside one directory: no separators, no leading dots, bounded length. */
export function safeFileName(name: string, fallback = 'file'): string {
	const base = name.split(/[\\/]/).pop() ?? '';
	const cleaned = [...base]
		.map((ch) => (ch.charCodeAt(0) < 32 || '<>:"|?*'.includes(ch) ? '_' : ch))
		.join('')
		.replace(/^\.+/, '')
		.trim();
	const out = cleaned.slice(-180);
	return out.length > 0 ? out : fallback;
}

export function randomId(prefix: string, bytes = 12): string {
	return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}
