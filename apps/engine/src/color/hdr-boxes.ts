// HDR static metadata boxes for MP4 / MOV exports (workstream color-mgmt). FFmpeg 7.1 writes the ISO/IEC 14496-12
// `mdcv` (mastering display colour volume, SMPTE ST 2086) and `clli` (content light level, CTA-861.3) boxes only from
// stream side data, which an export graph has no way to set; this module appends them to the video sample entry of
// a finished file instead: the box sizes of the sample entry and its ancestors grow, and when the `moov` precedes
// `mdat` (`+faststart`) every `stco` / `co64` chunk offset moves by the same amount. The file is rewritten through a
// temporary file and renamed (atomic); the media data is copied, never decoded.
//
// `mdcv` payload (as FFmpeg's mov muxer and HEVC SEI): display primaries x/y for G, B, R and the white point in
// units of 0.00002, then max / min mastering luminance in 0.0001 cd/m². `clli`: MaxCLL, MaxFALL (cd/m², u16).
import { open, rename, rm } from 'node:fs/promises';

export type MasteringDisplay = {
	/** CIE xy of red, green, blue and the white point. */
	r: readonly [number, number];
	g: readonly [number, number];
	b: readonly [number, number];
	white: readonly [number, number];
	maxNits: number;
	minNits: number;
};

export class BoxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BoxError';
	}
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta']);
/** Sample entry header after the box header: VisualSampleEntry fields (78 bytes). */
const VISUAL_ENTRY_HEADER = 78;

type Box = { type: string; start: number; size: number; header: number };

function readBoxes(buf: Buffer, start: number, end: number): Box[] {
	const out: Box[] = [];
	let p = start;
	while (p + 8 <= end) {
		let size = buf.readUInt32BE(p);
		const type = buf.toString('latin1', p + 4, p + 8);
		let header = 8;
		if (size === 1) {
			if (p + 16 > end) throw new BoxError(`Truncated ${type} box`);
			const big = buf.readBigUInt64BE(p + 8);
			if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new BoxError('Box too large');
			size = Number(big);
			header = 16;
		} else if (size === 0) size = end - p;
		if (size < header || p + size > end) throw new BoxError(`Malformed ${type} box`);
		out.push({ type, start: p, size, header });
		p += size;
	}
	return out;
}

/** The `mdcv` and `clli` boxes (bytes). */
export function hdrBoxes(md: MasteringDisplay, cll: { maxCll?: number; maxFall?: number } | null): Buffer {
	const u16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v)));
	const u32 = (v: number) => Math.max(0, Math.min(0xffffffff, Math.round(v)));
	const mdcv = Buffer.alloc(32);
	mdcv.writeUInt32BE(32, 0);
	mdcv.write('mdcv', 4, 'latin1');
	let o = 8;
	for (const c of [md.g, md.b, md.r]) {
		mdcv.writeUInt16BE(u16(c[0] / 0.00002), o);
		mdcv.writeUInt16BE(u16(c[1] / 0.00002), o + 2);
		o += 4;
	}
	mdcv.writeUInt16BE(u16(md.white[0] / 0.00002), o);
	mdcv.writeUInt16BE(u16(md.white[1] / 0.00002), o + 2);
	mdcv.writeUInt32BE(u32(md.maxNits / 0.0001), o + 4);
	mdcv.writeUInt32BE(u32(md.minNits / 0.0001), o + 8);
	if (!cll || (cll.maxCll === undefined && cll.maxFall === undefined)) return mdcv;
	const clli = Buffer.alloc(12);
	clli.writeUInt32BE(12, 0);
	clli.write('clli', 4, 'latin1');
	clli.writeUInt16BE(u16(cll.maxCll ?? 0), 8);
	clli.writeUInt16BE(u16(cll.maxFall ?? 0), 10);
	return Buffer.concat([mdcv, clli]);
}

/**
 * The `moov` with the boxes appended to the first video track's sample entry, and the size delta. Chunk offsets are
 * shifted by `offsetShift` (the delta when the moov precedes the media data, else 0).
 */
export function patchMoov(moov: Buffer, extra: Buffer, shiftOffsets: boolean): Buffer {
	const top = readBoxes(moov, 0, moov.length)[0];
	if (top?.type !== 'moov') throw new BoxError('Not a moov box');
	// Find the video trak: mdia/hdlr handler 'vide'.
	let entry: Box | null = null;
	const chain: Box[] = [];
	const walk = (box: Box, ancestors: Box[]): boolean => {
		for (const ch of readBoxes(moov, box.start + box.header, box.start + box.size)) {
			if (ch.type === 'trak') {
				const mdia = readBoxes(moov, ch.start + ch.header, ch.start + ch.size).find((b) => b.type === 'mdia');
				const hdlr =
					mdia &&
					readBoxes(moov, mdia.start + mdia.header, mdia.start + mdia.size).find((b) => b.type === 'hdlr');
				if (
					!hdlr ||
					moov.toString('latin1', hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12) !== 'vide'
				)
					continue;
			}
			if (ch.type === 'stsd') {
				// full box (4) + entry_count (4), then sample entries
				const first = readBoxes(moov, ch.start + ch.header + 8, ch.start + ch.size)[0];
				if (!first) throw new BoxError('Empty sample description');
				entry = first;
				chain.push(...ancestors, box, ch);
				return true;
			}
			if (CONTAINERS.has(ch.type) && walk(ch, [...ancestors, box])) return true;
		}
		return false;
	};
	if (!walk(top, []) || !entry) throw new BoxError('No video sample entry');
	const e = entry as Box;
	// Drop existing mdcv / clli children (re-export over a patched file), then append ours.
	const childStart = e.start + e.header + VISUAL_ENTRY_HEADER;
	if (childStart > e.start + e.size) throw new BoxError('Sample entry too small');
	const kids = readBoxes(moov, childStart, e.start + e.size).filter(
		(b) => b.type !== 'mdcv' && b.type !== 'clli',
	);
	const newEntry = Buffer.concat([
		moov.subarray(e.start, childStart),
		...kids.map((k) => moov.subarray(k.start, k.start + k.size)),
		extra,
	]);
	const delta = newEntry.length - e.size;
	const out = Buffer.concat([moov.subarray(0, e.start), newEntry, moov.subarray(e.start + e.size)]);
	// Grow every ancestor (moov … stbl, stsd) by `delta`.
	for (const a of chain) {
		if (a.header === 16) out.writeBigUInt64BE(BigInt(a.size + delta), a.start + 8);
		else {
			if (a.size + delta > 0xffffffff) throw new BoxError('Box size overflow');
			out.writeUInt32BE(a.size + delta, a.start);
		}
	}
	// Fix the entry size itself (header kept from the original bytes).
	if (e.header === 16) out.writeBigUInt64BE(BigInt(newEntry.length), e.start + 8);
	else out.writeUInt32BE(newEntry.length, e.start);
	if (shiftOffsets && delta !== 0) shiftChunkOffsets(out, delta);
	return out;
}

/** Adds `delta` to every `stco` / `co64` entry of the moov (in place). */
function shiftChunkOffsets(moov: Buffer, delta: number): void {
	const visit = (start: number, end: number) => {
		for (const b of readBoxes(moov, start, end)) {
			if (b.type === 'stco' || b.type === 'co64') {
				const p = b.start + b.header + 4;
				const n = moov.readUInt32BE(p);
				const w = b.type === 'stco' ? 4 : 8;
				if (p + 4 + n * w > b.start + b.size) throw new BoxError(`Malformed ${b.type}`);
				for (let i = 0; i < n; i++) {
					const at = p + 4 + i * w;
					if (w === 4) {
						const v = moov.readUInt32BE(at) + delta;
						if (v > 0xffffffff) throw new BoxError('Chunk offset overflow (needs co64)');
						moov.writeUInt32BE(v, at);
					} else moov.writeBigUInt64BE(moov.readBigUInt64BE(at) + BigInt(delta), at);
				}
			} else if (CONTAINERS.has(b.type) || b.type === 'moov') visit(b.start + b.header, b.start + b.size);
		}
	};
	visit(0, moov.length);
}

const COPY_CHUNK = 8 * 1024 * 1024;

/** Writes HDR metadata boxes into an MP4 / MOV file in place (atomic rename). */
export async function writeHdrBoxes(
	file: string,
	md: MasteringDisplay,
	cll: { maxCll?: number; maxFall?: number } | null,
): Promise<void> {
	const fh = await open(file, 'r');
	let moovAt = -1;
	let moovSize = 0;
	let mdatAt = -1;
	let total = 0;
	try {
		total = (await fh.stat()).size;
		let p = 0;
		const head = Buffer.alloc(16);
		while (p + 8 <= total) {
			await fh.read(head, 0, 16, p);
			let size = head.readUInt32BE(0);
			const type = head.toString('latin1', 4, 8);
			if (size === 1) size = Number(head.readBigUInt64BE(8));
			else if (size === 0) size = total - p;
			if (size < 8 || p + size > total) throw new BoxError(`Malformed top-level ${type} box`);
			if (type === 'moov') {
				moovAt = p;
				moovSize = size;
			} else if (type === 'mdat' && mdatAt < 0) mdatAt = p;
			p += size;
		}
		if (moovAt < 0) throw new BoxError('No moov box');
		if (moovSize > 256 * 1024 * 1024) throw new BoxError('moov box too large');
		const moov = Buffer.alloc(moovSize);
		await fh.read(moov, 0, moovSize, moovAt);
		const patched = patchMoov(moov, hdrBoxes(md, cll), mdatAt > moovAt);
		const tmp = `${file}.${process.pid}.hdr.partial`;
		const out = await open(tmp, 'w');
		try {
			const copy = async (from: number, to: number) => {
				const buf = Buffer.alloc(Math.min(COPY_CHUNK, Math.max(1, to - from)));
				for (let q = from; q < to; ) {
					const n = Math.min(buf.length, to - q);
					const { bytesRead } = await fh.read(buf, 0, n, q);
					if (bytesRead <= 0) throw new BoxError('Unexpected end of file');
					await out.write(buf, 0, bytesRead);
					q += bytesRead;
				}
			};
			await copy(0, moovAt);
			await out.write(patched);
			await copy(moovAt + moovSize, total);
			await out.sync();
		} catch (e) {
			await out.close();
			await rm(tmp, { force: true });
			throw e;
		}
		await out.close();
		await fh.close();
		await rename(tmp, file);
	} finally {
		await fh.close().catch(() => undefined);
	}
}
