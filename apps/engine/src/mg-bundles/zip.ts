// Minimal zip reader for bundle uploads (S08:MGC-010, web path): stored and deflated entries, zip64 sizes and
// offsets, no encryption. Entries are extracted under `dest` only (no absolute paths, no `..`, no symlinks).
// Node's zlib does the inflate; no dependency.
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

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

async function readAt(fh: Awaited<ReturnType<typeof open>>, pos: number, len: number): Promise<Buffer> {
	const buf = Buffer.alloc(len);
	let off = 0;
	while (off < len) {
		const { bytesRead } = await fh.read(buf, off, len - off, pos + off);
		if (bytesRead === 0) break;
		off += bytesRead;
	}
	return buf.subarray(0, off);
}

async function readEntries(fh: Awaited<ReturnType<typeof open>>, size: number): Promise<Entry[]> {
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
		while (x + 4 <= xEnd) {
			const id = cd.readUInt16LE(x);
			const len = cd.readUInt16LE(x + 2);
			if (id === 0x0001) {
				let q = x + 4;
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
export function safeEntryPath(dest: string, name: string): string | null {
	const n = name.replace(/\\/g, '/');
	if (n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) return null;
	if (n.startsWith('__MACOSX/') || n.split('/').some((s) => s === '.DS_Store')) return null;
	const out = normalize(join(dest, n));
	return out === dest || out.startsWith(dest.endsWith(sep) ? dest : dest + sep) ? out : null;
}

/** Extracts every file entry of `zipFile` into `dest`; returns the number of files written. */
export async function extractZip(zipFile: string, dest: string): Promise<number> {
	const fh = await open(zipFile, 'r');
	try {
		const { size } = await fh.stat();
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
			const raw = await readAt(fh, dataStart, e.compSize);
			let data: Buffer;
			if (e.method === 0) data = raw;
			else if (e.method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) });
			else throw new ZipError(`Unsupported compression method ${e.method}: ${e.name}`);
			if (data.length !== e.size) throw new ZipError(`Size mismatch: ${e.name}`);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, data);
			files++;
		}
		return files;
	} finally {
		await fh.close();
	}
}
