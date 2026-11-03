// A streaming stored ZIP (PKWARE APPNOTE 6.3): PNGs are already compressed, and a sequence can be far larger than memory,
// so `writeStoredZip` (imports/zip.ts, whole archive in a Buffer) does not fit. Written to a temporary name next to the
// result, fsynced and renamed (AGENTS §0). No ZIP64: more than the format holds is refused by name, not truncated.
import { createReadStream } from 'node:fs';
import { type FileHandle, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { fsyncDir } from '../../tools/fs.ts';

const LOC_SIG = 0x04034b50;
const CEN_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_NAMES = 0x0800;
const MAX_ENTRIES = 0xfffe;
const MAX_ZIP_BYTES = 0xffff_fffe;

export class ZipTooLargeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ZipTooLargeError';
	}
}

type Central = { name: Buffer; crc: number; size: number; offset: number };

export class StoredZipWriter {
	private entries: Central[] = [];
	private offset = 0;
	private constructor(
		private readonly fh: FileHandle,
		private readonly tmp: string,
		private readonly dest: string,
	) {}

	static async create(dest: string): Promise<StoredZipWriter> {
		const tmp = join(dirname(dest), `.${basename(dest)}.tmp`);
		return new StoredZipWriter(await open(tmp, 'w'), tmp, dest);
	}

	private async write(buf: Buffer): Promise<void> {
		await this.fh.write(buf, 0, buf.length, this.offset);
		this.offset += buf.length;
	}

	/** Adds one file: it is read twice (CRC, then copy), so memory stays at the stream's chunk size. */
	async add(name: string, file: string, signal?: AbortSignal): Promise<void> {
		if (this.entries.length >= MAX_ENTRIES)
			throw new ZipTooLargeError(`A ZIP holds at most ${MAX_ENTRIES} files: write to a folder instead`);
		let crc = 0;
		let size = 0;
		for await (const chunk of createReadStream(file, { signal })) {
			crc = crc32(chunk as Buffer, crc);
			size += (chunk as Buffer).length;
		}
		const bytes = Buffer.from(name, 'utf8');
		if (this.offset + size + 30 + bytes.length > MAX_ZIP_BYTES)
			throw new ZipTooLargeError('The ZIP would pass 4 GiB: write to a folder instead');
		const loc = Buffer.alloc(30);
		loc.writeUInt32LE(LOC_SIG, 0);
		loc.writeUInt16LE(20, 4);
		loc.writeUInt16LE(UTF8_NAMES, 6);
		loc.writeUInt32LE(crc, 14);
		loc.writeUInt32LE(size, 18);
		loc.writeUInt32LE(size, 22);
		loc.writeUInt16LE(bytes.length, 26);
		const offset = this.offset;
		await this.write(Buffer.concat([loc, bytes]));
		for await (const chunk of createReadStream(file, { signal })) await this.write(chunk as Buffer);
		this.entries.push({ name: bytes, crc, size, offset });
	}

	/** Central directory, fsync, rename, directory fsync. */
	async finish(): Promise<void> {
		const start = this.offset;
		for (const e of this.entries) {
			const cen = Buffer.alloc(46);
			cen.writeUInt32LE(CEN_SIG, 0);
			cen.writeUInt16LE(20, 4);
			cen.writeUInt16LE(20, 6);
			cen.writeUInt16LE(UTF8_NAMES, 8);
			cen.writeUInt32LE(e.crc, 16);
			cen.writeUInt32LE(e.size, 20);
			cen.writeUInt32LE(e.size, 24);
			cen.writeUInt16LE(e.name.length, 28);
			cen.writeUInt32LE(e.offset, 42);
			await this.write(Buffer.concat([cen, e.name]));
		}
		const eocd = Buffer.alloc(22);
		eocd.writeUInt32LE(EOCD_SIG, 0);
		eocd.writeUInt16LE(this.entries.length, 8);
		eocd.writeUInt16LE(this.entries.length, 10);
		eocd.writeUInt32LE(this.offset - start, 12);
		eocd.writeUInt32LE(start, 16);
		await this.write(eocd);
		await this.fh.sync();
		await this.fh.close();
		await rename(this.tmp, this.dest);
		await fsyncDir(dirname(this.dest));
	}

	async abort(): Promise<void> {
		await this.fh.close().catch(() => undefined);
		await rm(this.tmp, { force: true });
	}
}
