// Content fingerprint (S01:AST-003, S04:CA-001):
// "q1:" + hex(sha256(size as 8-byte big-endian || first 4 MiB || last 4 MiB)); whole file when ≤ 8 MiB.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

export const FINGERPRINT_PREFIX = 'q1:';
export const FINGERPRINT_EDGE_BYTES = 4 * 1024 * 1024;

async function readExactly(
	fh: Awaited<ReturnType<typeof open>>,
	position: number,
	length: number,
): Promise<Buffer> {
	const buf = Buffer.alloc(length);
	let off = 0;
	while (off < length) {
		const { bytesRead } = await fh.read(buf, off, length - off, position + off);
		if (bytesRead === 0) break;
		off += bytesRead;
	}
	return off === length ? buf : buf.subarray(0, off);
}

/** Fingerprint of a file on disk; reads at most 8 MiB. */
export async function fingerprintFile(path: string): Promise<{ fingerprint: string; sizeBytes: number }> {
	const fh = await open(path, 'r');
	try {
		const { size } = await fh.stat();
		const header = Buffer.alloc(8);
		header.writeBigUInt64BE(BigInt(size));
		const h = createHash('sha256').update(header);
		if (size <= 2 * FINGERPRINT_EDGE_BYTES) {
			h.update(await readExactly(fh, 0, size));
		} else {
			h.update(await readExactly(fh, 0, FINGERPRINT_EDGE_BYTES));
			h.update(await readExactly(fh, size - FINGERPRINT_EDGE_BYTES, FINGERPRINT_EDGE_BYTES));
		}
		return { fingerprint: FINGERPRINT_PREFIX + h.digest('hex'), sizeBytes: size };
	} finally {
		await fh.close();
	}
}

/** Hex part of a fingerprint (cache directory name). */
export function fingerprintHex(fingerprint: string): string {
	const hex = fingerprint.startsWith(FINGERPRINT_PREFIX)
		? fingerprint.slice(FINGERPRINT_PREFIX.length)
		: fingerprint;
	if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Invalid fingerprint ${fingerprint}`);
	return hex;
}

/** Engine media key: `mk_` + the first 24 hex characters of the fingerprint (ARCHITECTURE D-09). */
export function mediaKeyFor(fingerprint: string): string {
	return `mk_${fingerprintHex(fingerprint).slice(0, 24)}`;
}

export const MEDIA_KEY_RE = /^mk_[0-9a-f]{24}$/;
