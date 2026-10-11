// Implemented from the PKWARE APPNOTE (6.3.x):
// end of central directory record, central directory file headers, local file headers; stored (0) and deflated (8)
// entries (inflated with node:zlib). ZIP64, encryption and spanned archives are refused. Every size is bounded: an
// archive is hostile input (zip bombs, overlapping entries, truncated data).
import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
	readonly code = 'INVALID_ARCHIVE';
	constructor(message: string) {
		super(message);
		this.name = 'ZipError';
	}
}

export type ZipEntry = {
	name: string;
	method: number;
	compressedSize: number;
	size: number;
	/** Offset of the local file header. */
	offset: number;
};

/** Largest entry inflated (the whole Lottie JSON or one image). */
export const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** True when the bytes start like a ZIP archive (`PK\3\4`). */
export function looksLikeZip(buf: Uint8Array): boolean {
	return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 3 && buf[3] === 4;
}

/** Lists the entries of an archive (central directory). */
export function listZip(buf: Buffer): ZipEntry[] {
	if (buf.length < 22) throw new ZipError('Not a ZIP archive (too short)');
	// The end of central directory record is in the last 64 KiB + 22 bytes (the comment is at most 65535 bytes).
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
		if (buf.readUInt32LE(i) === EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ZipError('Not a ZIP archive (no end of central directory)');
	const disk = buf.readUInt16LE(eocd + 4);
	const cdDisk = buf.readUInt16LE(eocd + 6);
	const count = buf.readUInt16LE(eocd + 10);
	const cdSize = buf.readUInt32LE(eocd + 12);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	if (disk !== 0 || cdDisk !== 0) throw new ZipError('Spanned ZIP archives are not supported');
	if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported');
	if (count > MAX_ENTRIES) throw new ZipError(`Too many entries (${count})`);
	if (cdOffset + cdSize > eocd) throw new ZipError('Corrupt central directory');
	const out: ZipEntry[] = [];
	let p = cdOffset;
	for (let n = 0; n < count; n++) {
		if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG)
			throw new ZipError('Corrupt central directory');
		const flags = buf.readUInt16LE(p + 8);
		const method = buf.readUInt16LE(p + 10);
		const compressedSize = buf.readUInt32LE(p + 20);
		const size = buf.readUInt32LE(p + 24);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const offset = buf.readUInt32LE(p + 42);
		if (p + 46 + nameLen > buf.length) throw new ZipError('Corrupt central directory');
		const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
		if (flags & 1) throw new ZipError(`Encrypted entry ${name}`);
		if (offset >= buf.length) throw new ZipError(`Entry ${name} lies outside the archive`);
		out.push({ name, method, compressedSize, size, offset });
		p += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

/** The bytes of one entry (stored or deflated), bounded by `MAX_ENTRY_BYTES`. */
export function readZipEntry(buf: Buffer, e: ZipEntry, maxBytes = MAX_ENTRY_BYTES): Buffer {
	if (e.size > maxBytes) throw new ZipError(`Entry ${e.name} is too large (${e.size} bytes)`);
	const p = e.offset;
	if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) throw new ZipError(`Corrupt entry ${e.name}`);
	const nameLen = buf.readUInt16LE(p + 26);
	const extraLen = buf.readUInt16LE(p + 28);
	const start = p + 30 + nameLen + extraLen;
	const end = start + e.compressedSize;
	if (end > buf.length) throw new ZipError(`Entry ${e.name} is truncated`);
	const data = buf.subarray(start, end);
	if (e.method === 0) {
		if (data.length !== e.size) throw new ZipError(`Entry ${e.name} has a wrong size`);
		return Buffer.from(data);
	}
	if (e.method === 8) {
		let out: Buffer;
		try {
			out = inflateRawSync(data, { maxOutputLength: Math.min(maxBytes, Math.max(1, e.size)) + 1 });
		} catch (err) {
			throw new ZipError(`Entry ${e.name} does not inflate: ${(err as Error).message}`);
		}
		if (out.length !== e.size) throw new ZipError(`Entry ${e.name} inflates to a wrong size`);
		return out;
	}
	throw new ZipError(`Entry ${e.name} uses an unsupported compression method (${e.method})`);
}

/** A stored (uncompressed) archive of the given files (dotLottie export). */
export function writeStoredZip(files: { name: string; data: Uint8Array }[]): Buffer {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const f of files) {
		const name = Buffer.from(f.name, 'utf8');
		const crc = crc32(f.data);
		const loc = Buffer.alloc(30);
		loc.writeUInt32LE(LOC_SIG, 0);
		loc.writeUInt16LE(20, 4);
		loc.writeUInt16LE(0x0800, 6); // UTF-8 names
		loc.writeUInt16LE(0, 8);
		loc.writeUInt32LE(0, 10);
		loc.writeUInt32LE(crc, 14);
		loc.writeUInt32LE(f.data.length, 18);
		loc.writeUInt32LE(f.data.length, 22);
		loc.writeUInt16LE(name.length, 26);
		loc.writeUInt16LE(0, 28);
		locals.push(loc, name, Buffer.from(f.data));
		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(CEN_SIG, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(0x0800, 8);
		cen.writeUInt16LE(0, 10);
		cen.writeUInt32LE(0, 12);
		cen.writeUInt32LE(crc, 16);
		cen.writeUInt32LE(f.data.length, 20);
		cen.writeUInt32LE(f.data.length, 24);
		cen.writeUInt16LE(name.length, 28);
		cen.writeUInt32LE(offset, 42);
		central.push(cen, name);
		offset += 30 + name.length + f.data.length;
	}
	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(EOCD_SIG, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

let CRC_TABLE: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
	if (!CRC_TABLE) {
		CRC_TABLE = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			CRC_TABLE[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
