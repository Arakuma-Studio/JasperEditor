// Compound File Binary format ("structured storage", the container of AAF files), from the public Microsoft Open
// Specification [MS-CFB] (protocol revision 10.0; the on-disk format has not changed since 1.0).
//
// A compound file is a small FAT file system inside one file: fixed-size sectors (512 bytes in version 3, 4096 in
// version 4) chained by a file allocation table, a directory of 128-byte entries arranged as one red-black tree of
// siblings per storage, and a "mini stream" with a mini FAT for streams smaller than 4096 bytes.
//
// - `CompoundFile.open` parses a file held in memory; every chain is bounds- and cycle-checked, so damaged files
//   give a `CfbError`, never an exception of another kind or an endless loop.
// - `CfbWriter` builds a tree of storages and streams and lays it out in one pass: stream sectors, mini stream,
//   mini FAT, directory, FAT and DIFAT.
//
// Port of FilmCraft `crates/cfb` (MIT OR Apache-2.0).

export const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
export const MAXREGSECT = 0xfffffffa;
export const DIFSECT = 0xfffffffc;
export const FATSECT = 0xfffffffd;
export const ENDOFCHAIN = 0xfffffffe;
export const FREESECT = 0xffffffff;
export const NOSTREAM = 0xffffffff;
export const MINI_STREAM_CUTOFF = 4096;
export const MINI_SECTOR_SIZE = 64;
export const MAX_NAME_LEN = 31;

export class CfbError extends Error {
	constructor(
		readonly kind: 'not-cfb' | 'invalid' | 'not-found' | 'bad-name',
		message: string,
	) {
		super(message);
		this.name = 'CfbError';
	}
}

const invalid = (m: string) => new CfbError('invalid', `invalid compound file: ${m}`);

export function sniffCfb(b: Uint8Array): boolean {
	return b.length >= 8 && SIGNATURE.every((v, i) => b[i] === v);
}

function upper(u: number): number {
	if (u >= 0x61 && u <= 0x7a) return u - 32;
	if (u < 0x80) return u;
	const s = String.fromCharCode(u).toUpperCase();
	return s.length === 1 ? s.charCodeAt(0) : u;
}

/** Sibling order (§2.6.4): shorter names first, then a code-unit comparison of the upper-cased names. */
export function compareNames(a: string, b: string): number {
	if (a.length !== b.length) return a.length - b.length;
	for (let i = 0; i < a.length; i++) {
		const d = upper(a.charCodeAt(i)) - upper(b.charCodeAt(i));
		if (d) return d;
	}
	return 0;
}

export function validateName(name: string): void {
	if (!name.length || name.length > MAX_NAME_LEN || /[/\\:!]/.test(name))
		throw new CfbError('bad-name', `invalid entry name ${JSON.stringify(name)}`);
}

export type EntryKind = 'root' | 'storage' | 'stream' | 'unknown';

export type Entry = {
	name: string;
	kind: EntryKind;
	clsid: Uint8Array;
	stateBits: number;
	start: number;
	size: number;
	/** Child entries of a storage, in sibling-tree order. */
	children: number[];
	left: number;
	right: number;
	child: number;
};

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) =>
	(b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

export class CompoundFile {
	version = 4;
	headerClsid: Uint8Array = new Uint8Array(16);
	sectorSize = 512;
	private miniCutoff = MINI_STREAM_CUTOFF;
	private fat: Uint32Array = new Uint32Array(0);
	private minifat: Uint32Array = new Uint32Array(0);
	private miniStream: Uint8Array = new Uint8Array(0);
	entries: Entry[] = [];

	private constructor(private readonly data: Uint8Array) {}

	static open(data: Uint8Array): CompoundFile {
		if (data.length < 512 || !sniffCfb(data) || u16(data, 28) !== 0xfffe)
			throw new CfbError('not-cfb', 'not a compound file');
		const cf = new CompoundFile(data);
		cf.version = u16(data, 26);
		const shift = u16(data, 30);
		if (shift < 7 || shift > 16) throw invalid(`sector shift ${shift}`);
		if (u16(data, 32) !== 6) throw invalid(`mini sector shift ${u16(data, 32)}`);
		const ss = 1 << shift;
		cf.sectorSize = ss;
		const nFat = u32(data, 44);
		const firstDir = u32(data, 48);
		cf.miniCutoff = u32(data, 56);
		const firstMinifat = u32(data, 60);
		const firstDifat = u32(data, 68);
		const nDifat = u32(data, 72);
		cf.headerClsid = data.slice(8, 24);
		const maxSectors = Math.floor(data.length / ss) + 1;
		if (nFat > maxSectors) throw invalid(`${nFat} FAT sectors in a ${data.length}-byte file`);
		const fatSectors: number[] = [];
		for (let i = 0; i < 109; i++) {
			const s = u32(data, 76 + i * 4);
			if (s <= MAXREGSECT) fatSectors.push(s);
		}
		let d = firstDifat;
		let seen = 0;
		while (d <= MAXREGSECT && fatSectors.length < nFat) {
			if (++seen > Math.max(nDifat, 1) + maxSectors) throw invalid('DIFAT chain loops');
			const s = cf.sector(d);
			const per = ss / 4 - 1;
			for (let i = 0; i < per; i++) {
				const v = u32(s, i * 4);
				if (v <= MAXREGSECT) fatSectors.push(v);
			}
			d = u32(s, per * 4);
		}
		fatSectors.length = Math.min(fatSectors.length, nFat);
		const fat = new Uint32Array(fatSectors.length * (ss / 4));
		fatSectors.forEach((s, k) => {
			const b = cf.sector(s);
			for (let i = 0; i < ss / 4; i++) fat[k * (ss / 4) + i] = u32(b, i * 4);
		});
		cf.fat = fat;
		const dir = cf.readChain(firstDir, null);
		const n = Math.floor(dir.length / 128);
		if (!n) throw invalid('empty directory');
		for (let i = 0; i < n; i++) cf.entries.push(parseEntry(dir.subarray(i * 128, (i + 1) * 128), cf.version));
		if (cf.entries[0]!.kind !== 'root') throw invalid('the first directory entry is not the root');
		if (firstMinifat <= MAXREGSECT) {
			const mf = cf.readChain(firstMinifat, null);
			cf.minifat = new Uint32Array(Math.floor(mf.length / 4));
			for (let i = 0; i < cf.minifat.length; i++) cf.minifat[i] = u32(mf, i * 4);
		}
		const root = cf.entries[0]!;
		if (root.start <= MAXREGSECT && root.size > 0)
			cf.miniStream = cf.readChain(root.start, Math.min(root.size, data.length));
		cf.buildTree();
		return cf;
	}

	private sector(n: number): Uint8Array {
		const start = (n + 1) * this.sectorSize;
		const end = start + this.sectorSize;
		if (n > MAXREGSECT || end > this.data.length) throw invalid(`sector ${n} is outside the file`);
		return this.data.subarray(start, end);
	}

	private readChain(start: number, limit: number | null): Uint8Array {
		const parts: Uint8Array[] = [];
		let len = 0;
		let s = start;
		let steps = 0;
		while (s !== ENDOFCHAIN) {
			if (s > MAXREGSECT) throw invalid(`bad sector 0x${s.toString(16)} in a chain`);
			if (++steps > Math.max(this.fat.length, 1)) throw invalid('sector chain loops');
			const b = this.sector(s);
			parts.push(b);
			len += b.length;
			if (limit !== null && len >= limit) break;
			if (s >= this.fat.length) throw invalid(`sector ${s} has no FAT entry`);
			s = this.fat[s]!;
			if (s === FREESECT) throw invalid('a chain runs into a free sector');
		}
		if (limit !== null && len < limit) throw invalid('stream is truncated');
		const out = new Uint8Array(limit ?? len);
		let at = 0;
		for (const p of parts) {
			const take = Math.min(p.length, out.length - at);
			out.set(p.subarray(0, take), at);
			at += take;
			if (at >= out.length) break;
		}
		return out;
	}

	private readMiniChain(start: number, size: number): Uint8Array {
		const out = new Uint8Array(size);
		let at = 0;
		let s = start;
		let steps = 0;
		while (at < size) {
			if (s > MAXREGSECT) throw invalid('mini stream chain ends early');
			if (++steps > Math.max(this.minifat.length, 1)) throw invalid('mini sector chain loops');
			const off = s * MINI_SECTOR_SIZE;
			if (off + MINI_SECTOR_SIZE > this.miniStream.length)
				throw invalid('mini sector outside the mini stream');
			const take = Math.min(MINI_SECTOR_SIZE, size - at);
			out.set(this.miniStream.subarray(off, off + take), at);
			at += take;
			if (s >= this.minifat.length) throw invalid('mini sector has no mini FAT entry');
			s = this.minifat[s]!;
		}
		return out;
	}

	private buildTree(): void {
		const n = this.entries.length;
		const owner = new Uint8Array(n);
		owner[0] = 1;
		for (let parent = 0; parent < n; parent++) {
			const pe = this.entries[parent]!;
			if (pe.kind !== 'root' && pe.kind !== 'storage') continue;
			const kids: number[] = [];
			const stack: number[] = [];
			let cur = pe.child;
			let steps = 0;
			while (cur !== NOSTREAM || stack.length) {
				while (cur !== NOSTREAM) {
					if (cur >= n || owner[cur])
						throw invalid(`directory entry ${cur} is referenced twice or does not exist`);
					owner[cur] = 1;
					stack.push(cur);
					cur = this.entries[cur]!.left;
					if (++steps > n) throw invalid('directory tree loops');
				}
				const top = stack.pop();
				if (top !== undefined) {
					kids.push(top);
					cur = this.entries[top]!.right;
				}
			}
			pe.children = kids;
		}
	}

	root(): Entry {
		return this.entries[0]!;
	}

	/** Child of storage `parent` named `name` (case-insensitive as in §2.6.4). */
	child(parent: number, name: string): number | null {
		const p = this.entries[parent];
		if (!p) return null;
		for (const c of p.children) if (compareNames(this.entries[c]!.name, name) === 0) return c;
		return null;
	}

	/** Entry at a `/`-separated path below the root. */
	find(path: string): number {
		let cur = 0;
		for (const part of path.split('/').filter(Boolean)) {
			const c = this.child(cur, part);
			if (c === null) throw new CfbError('not-found', `no entry ${JSON.stringify(path)}`);
			cur = c;
		}
		return cur;
	}

	read(id: number): Uint8Array {
		const e = this.entries[id];
		if (!e) throw new CfbError('not-found', `no entry ${id}`);
		if (e.kind !== 'stream') throw invalid(`${JSON.stringify(e.name)} is not a stream`);
		if (e.size === 0) return new Uint8Array(0);
		if (e.size > this.data.length) throw invalid(`stream ${JSON.stringify(e.name)} is larger than the file`);
		return e.size < this.miniCutoff ? this.readMiniChain(e.start, e.size) : this.readChain(e.start, e.size);
	}

	readPath(path: string): Uint8Array {
		return this.read(this.find(path));
	}
}

function parseEntry(b: Uint8Array, version: number): Entry {
	const nameLen = Math.min(u16(b, 64), 64);
	let name = '';
	for (let i = 0; i < nameLen / 2; i++) {
		const u = u16(b, i * 2);
		if (u === 0) break;
		name += String.fromCharCode(u);
	}
	const kind: EntryKind = b[66] === 5 ? 'root' : b[66] === 1 ? 'storage' : b[66] === 2 ? 'stream' : 'unknown';
	const lo = u32(b, 120);
	const hi = u32(b, 124);
	return {
		name,
		kind,
		clsid: b.slice(80, 96),
		stateBits: u32(b, 96),
		start: u32(b, 116),
		// Version 3 files may leave garbage in the high 32 bits (§2.6.3).
		size: version === 3 ? lo : hi * 0x100000000 + lo,
		children: [],
		left: u32(b, 68),
		right: u32(b, 72),
		child: u32(b, 76),
	};
}

// ---------------------------------------------------------------- writer

type WNode = {
	name: string;
	kind: 'root' | 'storage' | 'stream';
	clsid: Uint8Array;
	data: Uint8Array;
	children: number[];
};

export type CfbVersion = 3 | 4;

export class CfbWriter {
	static readonly ROOT = 0;
	private readonly nodes: WNode[] = [
		{ name: 'Root Entry', kind: 'root', clsid: new Uint8Array(16), data: new Uint8Array(0), children: [] },
	];

	constructor(readonly version: CfbVersion = 4) {}

	private add(
		parent: number,
		name: string,
		kind: 'storage' | 'stream',
		clsid: Uint8Array,
		data: Uint8Array,
	): number {
		validateName(name);
		const p = this.nodes[parent];
		if (!p) throw new CfbError('not-found', `node ${parent}`);
		if (p.kind === 'stream') throw invalid(`${JSON.stringify(p.name)} is a stream, not a storage`);
		if (p.children.some((c) => compareNames(this.nodes[c]!.name, name) === 0))
			throw new CfbError('bad-name', `duplicate name ${name}`);
		this.nodes.push({ name, kind, clsid, data, children: [] });
		const id = this.nodes.length - 1;
		p.children.push(id);
		return id;
	}

	storage(parent: number, name: string, clsid: Uint8Array = new Uint8Array(16)): number {
		return this.add(parent, name, 'storage', clsid, new Uint8Array(0));
	}

	stream(parent: number, name: string, data: Uint8Array): number {
		return this.add(parent, name, 'stream', new Uint8Array(16), data);
	}

	setClsid(node: number, clsid: Uint8Array): void {
		const n = this.nodes[node];
		if (n) n.clsid = clsid;
	}

	finish(): Uint8Array {
		const ss = this.version === 3 ? 512 : 4096;
		const per = ss / 4;
		const nodes = this.nodes;
		// Directory order: depth-first pre-order from the root.
		const order: number[] = [];
		const stack = [0];
		while (stack.length) {
			const n = stack.pop()!;
			order.push(n);
			const ch = nodes[n]!.children;
			for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]!);
		}
		const dirIndex = new Array<number>(nodes.length).fill(0);
		order.forEach((n, i) => {
			dirIndex[n] = i;
		});
		const start = new Array<number>(nodes.length).fill(ENDOFCHAIN);
		let next = 0;
		const big: [number, number][] = [];
		for (const n of order) {
			const node = nodes[n]!;
			if (node.kind === 'stream' && node.data.length >= MINI_STREAM_CUTOFF) {
				const count = Math.ceil(node.data.length / ss);
				start[n] = next;
				big.push([next, count]);
				next += count;
			}
		}
		let nextMini = 0;
		const mini: [number, number][] = [];
		for (const n of order) {
			const node = nodes[n]!;
			if (node.kind === 'stream' && node.data.length > 0 && node.data.length < MINI_STREAM_CUTOFF) {
				const count = Math.ceil(node.data.length / MINI_SECTOR_SIZE);
				start[n] = nextMini;
				mini.push([nextMini, count]);
				nextMini += count;
			}
		}
		const miniBytes = nextMini * MINI_SECTOR_SIZE;
		const miniSectors = Math.ceil(miniBytes / ss);
		const miniStart = miniSectors > 0 ? next : ENDOFCHAIN;
		next += miniSectors;
		const minifatSectors = Math.ceil((nextMini * 4) / ss);
		const minifatStart = minifatSectors > 0 ? next : ENDOFCHAIN;
		next += minifatSectors;
		const dirSectors = Math.ceil((order.length * 128) / ss);
		const dirStart = next;
		next += dirSectors;
		const base = next;
		let fatN = 1;
		let difatN = 0;
		for (;;) {
			const total = base + fatN + difatN;
			const needFat = Math.ceil(total / per);
			const needDifat = needFat > 109 ? Math.ceil((needFat - 109) / (per - 1)) : 0;
			if (needFat === fatN && needDifat === difatN) break;
			fatN = Math.max(needFat, fatN);
			difatN = Math.max(needDifat, difatN);
		}
		const fatStart = next;
		const difatStart = fatStart + fatN;
		const total = base + fatN + difatN;
		const fat = new Uint32Array(fatN * per).fill(FREESECT);
		const chain = (first: number, count: number, t: Uint32Array) => {
			for (let i = 0; i < count; i++) t[first + i] = i + 1 === count ? ENDOFCHAIN : first + i + 1;
		};
		for (const [f, c] of big) chain(f, c, fat);
		if (miniSectors) chain(miniStart, miniSectors, fat);
		if (minifatSectors) chain(minifatStart, minifatSectors, fat);
		chain(dirStart, dirSectors, fat);
		for (let i = 0; i < fatN; i++) fat[fatStart + i] = FATSECT;
		for (let i = 0; i < difatN; i++) fat[difatStart + i] = DIFSECT;
		const minifat = new Uint32Array(minifatSectors * per).fill(FREESECT);
		for (const [f, c] of mini) chain(f, c, minifat);
		// Directory sibling trees.
		const tree = nodes.map(() => ({ l: NOSTREAM, r: NOSTREAM, c: NOSTREAM, color: 1 }));
		nodes.forEach((node, p) => {
			if (node.kind === 'stream' || !node.children.length) return;
			const kids = [...node.children].sort((a, b) => compareNames(nodes[a]!.name, nodes[b]!.name));
			const height = Math.floor(Math.log2(kids.length + 1));
			const perfect = 2 ** height - 1 === kids.length;
			const build = (list: number[], depth: number): number => {
				if (!list.length) return NOSTREAM;
				const mid = list.length >> 1;
				const n = list[mid]!;
				tree[n]!.l = build(list.slice(0, mid), depth + 1);
				tree[n]!.r = build(list.slice(mid + 1), depth + 1);
				tree[n]!.color = !perfect && depth === height ? 0 : 1;
				return dirIndex[n]!;
			};
			tree[p]!.c = build(kids, 0);
		});
		const out = new Uint8Array((total + 1) * ss);
		const dv = new DataView(out.buffer);
		// Header.
		out.set(SIGNATURE, 0);
		dv.setUint16(24, 0x003e, true);
		dv.setUint16(26, this.version, true);
		dv.setUint16(28, 0xfffe, true);
		dv.setUint16(30, this.version === 3 ? 9 : 12, true);
		dv.setUint16(32, 6, true);
		dv.setUint32(40, this.version === 3 ? 0 : dirSectors, true);
		dv.setUint32(44, fatN, true);
		dv.setUint32(48, dirStart, true);
		dv.setUint32(52, 0, true);
		dv.setUint32(56, MINI_STREAM_CUTOFF, true);
		dv.setUint32(60, minifatStart, true);
		dv.setUint32(64, minifatSectors, true);
		dv.setUint32(68, difatN > 0 ? difatStart : ENDOFCHAIN, true);
		dv.setUint32(72, difatN, true);
		for (let i = 0; i < 109; i++) dv.setUint32(76 + i * 4, i < fatN ? fatStart + i : FREESECT, true);
		const sec = (n: number) => (n + 1) * ss;
		for (const n of order) {
			const node = nodes[n]!;
			if (node.kind === 'stream' && node.data.length >= MINI_STREAM_CUTOFF)
				out.set(node.data, sec(start[n]!));
		}
		if (miniSectors)
			for (const n of order) {
				const node = nodes[n]!;
				if (node.kind === 'stream' && node.data.length > 0 && node.data.length < MINI_STREAM_CUTOFF)
					out.set(node.data, sec(miniStart) + start[n]! * MINI_SECTOR_SIZE);
			}
		for (let i = 0; i < minifat.length; i++) dv.setUint32(sec(minifatStart) + i * 4, minifat[i]!, true);
		order.forEach((n, i) => {
			const node = nodes[n]!;
			const at = sec(dirStart) + i * 128;
			for (let k = 0; k < node.name.length; k++) dv.setUint16(at + k * 2, node.name.charCodeAt(k), true);
			dv.setUint16(at + 64, (node.name.length + 1) * 2, true);
			out[at + 66] = node.kind === 'root' ? 5 : node.kind === 'storage' ? 1 : 2;
			const t = tree[n]!;
			out[at + 67] = node.kind === 'root' ? 1 : t.color;
			dv.setUint32(at + 68, t.l, true);
			dv.setUint32(at + 72, t.r, true);
			dv.setUint32(at + 76, t.c, true);
			out.set(node.clsid.subarray(0, 16), at + 80);
			const [st, size] =
				node.kind === 'root'
					? [miniStart, miniBytes]
					: node.kind === 'storage'
						? [0, 0]
						: [node.data.length ? start[n]! : ENDOFCHAIN, node.data.length];
			dv.setUint32(at + 116, st, true);
			dv.setUint32(at + 120, size % 0x100000000, true);
			dv.setUint32(at + 124, Math.floor(size / 0x100000000), true);
		});
		for (let i = order.length; i < (dirSectors * ss) / 128; i++) {
			const at = sec(dirStart) + i * 128;
			for (let k = 68; k < 80; k++) out[at + k] = 0xff;
		}
		for (let i = 0; i < fat.length; i++) dv.setUint32(sec(fatStart) + i * 4, fat[i]!, true);
		const remaining: number[] = [];
		for (let i = 109; i < fatN; i++) remaining.push(fatStart + i);
		for (let i = 0; i < difatN; i++) {
			const at = sec(difatStart + i);
			const take = remaining.splice(0, per - 1);
			for (let k = 0; k < per - 1; k++) dv.setUint32(at + k * 4, take[k] ?? FREESECT, true);
			dv.setUint32(at + (per - 1) * 4, i + 1 < difatN ? difatStart + i + 1 : ENDOFCHAIN, true);
		}
		return out;
	}
}
