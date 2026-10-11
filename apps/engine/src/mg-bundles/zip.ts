// Minimal zip reader for bundle uploads (S08:MGC-010, web path): stored and deflated entries, zip64 sizes and
// offsets, no encryption. Entries are extracted under `dest` only (no absolute paths, no `..`, no symlinks).
// Node's zlib does the inflate; no dependency.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

export class ZipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ZipError';
	}
}

type Entry = { name: string; method: number; compSize: number; size: number; offset: number; dir: boolean };

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

/** Limits against zip bombs (a built bundle is a few MB plus its public/ folder). */
const ZIP_LIMITS = { maxEntries: 50_000, maxTotalBytes: 8 * 1024 ** 3 };

type Handle = Awaited<ReturnType<typeof open>> & { size?: number };

/**
 * `len` bytes at `pos`. Offsets and lengths come from the archive: anything outside the file is a broken archive
 * (golden-fuzz: an out-of-range length reached `fh.read` and aborted the whole process in a native assertion).
 */
async function readAt(fh: Handle, pos: number, len: number): Promise<Buffer> {
	const size = fh.size ?? Number.POSITIVE_INFINITY;
	if (!Number.isSafeInteger(pos) || !Number.isSafeInteger(len) || pos < 0 || len < 0 || pos + len > size)
		throw new ZipError('Broken zip (an offset or size points outside the file)');
	const buf = Buffer.alloc(len);
	let off = 0;
	while (off < len) {
		const { bytesRead } = await fh.read(buf, off, len - off, pos + off);
		if (bytesRead === 0) break;
		off += bytesRead;
	}
	return buf.subarray(0, off);
}

async function readEntries(fh: Handle, size: number): Promise<Entry[]> {
	fh.size = size;
	const tailLen = Math.min(size, 65_557);
	const tail = await readAt(fh, size - tailLen, tailLen);
	let e = -1;
	for (let i = tail.length - 22; i >= 0; i--) {
		if (tail.readUInt32LE(i) === EOCD) {
			e = i;
			break;
		}
	}
	if (e < 0) throw new ZipError('Not a zip file (no end of central directory)');
	let count = tail.readUInt16LE(e + 10);
	let cdSize = tail.readUInt32LE(e + 12);
	let cdOffset = tail.readUInt32LE(e + 16);
	if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
		const loc = e - 20;
		if (loc < 0 || tail.readUInt32LE(loc) !== EOCD64_LOCATOR) throw new ZipError('Broken zip64 directory');
		const pos = Number(tail.readBigUInt64LE(loc + 8));
		const rec = await readAt(fh, pos, 56);
		if (rec.readUInt32LE(0) !== EOCD64) throw new ZipError('Broken zip64 directory');
		count = Number(rec.readBigUInt64LE(32));
		cdSize = Number(rec.readBigUInt64LE(40));
		cdOffset = Number(rec.readBigUInt64LE(48));
	}
	if (count > ZIP_LIMITS.maxEntries) throw new ZipError(`Too many entries (${count})`);
	const cd = await readAt(fh, cdOffset, cdSize);
	const out: Entry[] = [];
	let p = 0;
	for (let i = 0; i < count; i++) {
		if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN) throw new ZipError('Broken central directory');
		const flags = cd.readUInt16LE(p + 8);
		const method = cd.readUInt16LE(p + 10);
		let compSize = cd.readUInt32LE(p + 20);
		let usize = cd.readUInt32LE(p + 24);
		const nameLen = cd.readUInt16LE(p + 28);
		const extraLen = cd.readUInt16LE(p + 30);
		const commentLen = cd.readUInt16LE(p + 32);
		const attrs = cd.readUInt32LE(p + 38);
		let offset = cd.readUInt32LE(p + 42);
		const name = cd.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
		// zip64 extra field: the 0xffffffff fields in order (size, compressed size, offset).
		let x = p + 46 + nameLen;
		const xEnd = x + extraLen;
		if (xEnd + commentLen > cd.length) throw new ZipError('Broken central directory');
		if (name.includes('\0')) throw new ZipError('Invalid entry name (NUL character)');
		while (x + 4 <= xEnd) {
			const id = cd.readUInt16LE(x);
			const len = cd.readUInt16LE(x + 2);
			if (x + 4 + len > xEnd) throw new ZipError(`Broken extra field: ${name}`);
			if (id === 0x0001) {
				let q = x + 4;
				const need =
					(usize === 0xffffffff ? 8 : 0) +
					(compSize === 0xffffffff ? 8 : 0) +
					(offset === 0xffffffff ? 8 : 0);
				if (need > len) throw new ZipError(`Broken zip64 extra field: ${name}`);
				if (usize === 0xffffffff) {
					usize = Number(cd.readBigUInt64LE(q));
					q += 8;
				}
				if (compSize === 0xffffffff) {
					compSize = Number(cd.readBigUInt64LE(q));
					q += 8;
				}
				if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
			}
			x += 4 + len;
		}
		if (flags & 0x1) throw new ZipError(`Encrypted entry: ${name}`);
		const unixMode = attrs >>> 16;
		if ((unixMode & 0o170000) === 0o120000) throw new ZipError(`Symbolic links are not allowed: ${name}`);
		out.push({ name, method, compSize, size: usize, offset, dir: name.endsWith('/') });
		p = xEnd + commentLen;
	}
	return out;
}

/** Safe destination of an entry name under `dest`, or null for names that must be skipped. */
function safeEntryPath(dest: string, name: string): string | null {
	const n = name.replace(/\\/g, '/');
	if (n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) return null;
	if (n.startsWith('__MACOSX/') || n.split('/').some((s) => s === '.DS_Store')) return null;
	const out = normalize(join(dest, n));
	return out === dest || out.startsWith(dest.endsWith(sep) ? dest : dest + sep) ? out : null;
}

/**
 * Stream entries so untrusted declared sizes cannot force large allocations. Output is capped at the
 * declared size; a size mismatch or corrupt data removes the file and throws.
 */
async function writeEntry(zipFile: string, e: Entry, dataStart: number, target: string): Promise<void> {
	let written = 0;
	const limit = new Transform({
		transform(chunk: Buffer, _enc, cb) {
			written += chunk.length;
			if (written > e.size) return cb(new ZipError(`Size mismatch: ${e.name}`));
			cb(null, chunk);
		},
	});
	const source =
		e.compSize > 0
			? createReadStream(zipFile, { start: dataStart, end: dataStart + e.compSize - 1 })
			: Readable.from([]);
	try {
		if (e.method === 0) await pipeline(source, limit, createWriteStream(target));
		else await pipeline(source, createInflateRaw(), limit, createWriteStream(target));
		if (written !== e.size) throw new ZipError(`Size mismatch: ${e.name}`);
	} catch (err) {
		await rm(target, { force: true }).catch(() => undefined);
		if (err instanceof ZipError) throw err;
		throw new ZipError(`Corrupt compressed data: ${e.name} (${(err as Error).message})`);
	}
}

/** Extracts every file entry of `zipFile` into `dest`; returns the number of files written. */
export async function extractZip(zipFile: string, dest: string): Promise<number> {
	const fh = await open(zipFile, 'r');
	try {
		const { size } = await fh.stat();
		(fh as Handle).size = size;
		const entries = await readEntries(fh, size);
		let total = 0;
		let files = 0;
		for (const e of entries) {
			const target = safeEntryPath(dest, e.name);
			if (!target) {
				if (e.name.split(/[\\/]/).includes('..') || e.name.startsWith('/'))
					throw new ZipError(`Unsafe path in zip: ${e.name}`);
				continue;
			}
			if (e.dir) {
				await mkdir(target, { recursive: true });
				continue;
			}
			total += e.size;
			if (total > ZIP_LIMITS.maxTotalBytes) throw new ZipError('The zip expands beyond the size limit');
			const head = await readAt(fh, e.offset, 30);
			if (head.readUInt32LE(0) !== LOC) throw new ZipError(`Broken local header: ${e.name}`);
			const dataStart = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
			if (
				!Number.isSafeInteger(dataStart) ||
				!Number.isSafeInteger(e.compSize) ||
				dataStart + e.compSize > size
			)
				throw new ZipError('Broken zip (an offset or size points outside the file)');
			if (e.method !== 0 && e.method !== 8)
				throw new ZipError(`Unsupported compression method ${e.method}: ${e.name}`);
			await mkdir(dirname(target), { recursive: true });
			await writeEntry(zipFile, e, dataStart, target);
			files++;
		}
		return files;
	} finally {
		await fh.close();
	}
}
