// The Bento container (Apple, "Bento Specification" revision 1.0d5), the storage layer of OMF Interchange 2.0 files.
//
// A Bento container is a heap of value bytes, a table of contents (TOC) describing every value of every object, and a
// fixed-size label at the very end of the file that locates the TOC:
//
//   label (24 bytes, big-endian): magic A4 'C' 'M' A5 'H' 'd' 'r' D7, u16 flags, u16 buffer size (KiB),
//                                 u16 major version (1), u16 minor version (0), u32 TOC offset, u32 TOC size
//
// Every value belongs to an (object id, property id, type id) triple. Properties and types are themselves objects
// carrying a global name ("OMFI:CPNT:Length", "omfi:Length32"). The TOC is a stream of one-byte operations, each
// followed by big-endian operands:
//
//   1 NewObject u32 · 2 NewProperty u32 · 3 NewType u32 · 4 ExplicitGen u32 · 5 Offset4Len4 / 6 Contd (u32, u32) ·
//   7 Offset8Len4 / 8 Contd (u64, u32) · 9–13 Immediate0–4 (4 bytes) · 14 ContdImmediate4 · 15 ReferenceListID u32 ·
//   24 EndOfBufr (skip to the end of the TOC buffer) · 0xFF padding
//
// Object references (OMF's omfi:ObjRef) are 4-byte keys resolved through the referencing object's reference list
// (standard property 22: pairs of u32 key, u32 object id). The writer uses the referenced object's id as the key.
//
// Port of FilmCraft `crates/interchange/src/omf/bento.rs` (MIT OR Apache-2.0).

import { encodeUtf8 } from '../paths.ts';

export const MAGIC = Uint8Array.of(0xa4, 0x43, 0x4d, 0xa5, 0x48, 0x64, 0x72, 0xd7);
export const LABEL_SIZE = 24;

const TOC_OBJECT = 1;
const TOC_SEED = 2;
const TOC_MIN_SEED = 3;
const TOC_TYPE = 19;
const TYPE_7BIT_ASCII = 21;
export const OBJ_REFERENCES = 22;
const GLOBAL_TYPE_NAME = 23;
const GLOBAL_PROP_NAME = 24;
const MIN_USER_ID = 100;

const OP_NEW_OBJECT = 1;
const OP_NEW_PROPERTY = 2;
const OP_NEW_TYPE = 3;
const OP_EXPLICIT_GEN = 4;
const OP_OFFSET4_LEN4 = 5;
const OP_CONTD_OFFSET4_LEN4 = 6;
const OP_OFFSET8_LEN4 = 7;
const OP_CONTD_OFFSET8_LEN4 = 8;
const OP_IMMEDIATE0 = 9;
const OP_IMMEDIATE4 = 13;
const OP_CONTD_IMMEDIATE4 = 14;
const OP_REFERENCE_LIST_ID = 15;
const OP_END_OF_BUFFER = 24;
const OP_PADDING = 0xff;

const TOC_BUFFER_KIB = 8;

type Seg = { imm: Uint8Array } | { at: number; len: number };

export class BentoError extends Error {}

const be32 = (v: number) => {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, v >>> 0);
	return b;
};

/** A growable byte buffer. */
class Bytes {
	buf = new Uint8Array(1024);
	len = 0;
	private grow(n: number) {
		if (this.len + n <= this.buf.length) return;
		let cap = this.buf.length * 2;
		while (cap < this.len + n) cap *= 2;
		const b = new Uint8Array(cap);
		b.set(this.buf.subarray(0, this.len));
		this.buf = b;
	}
	push(...v: number[]) {
		this.grow(v.length);
		for (const x of v) this.buf[this.len++] = x;
	}
	append(v: Uint8Array) {
		this.grow(v.length);
		this.buf.set(v, this.len);
		this.len += v.length;
	}
	bytes() {
		return this.buf.subarray(0, this.len);
	}
}

/** Builds a Bento container. */
export class BentoWriter {
	private data = new Bytes();
	private names = new Map<string, number>();
	private next = MIN_USER_ID;
	/** (object, property, type, segments) */
	private entries: [number, number, number, Seg[]][] = [];

	private named(kind: number, name: string): number {
		const k = `${kind}:${name}`;
		const known = this.names.get(k);
		if (known !== undefined) return known;
		const id = this.newObject();
		const v = encodeUtf8(`${name}\0`);
		this.entries.push([id, kind, TYPE_7BIT_ASCII, [this.store(v)]]);
		this.names.set(k, id);
		return id;
	}

	property(name: string): number {
		return this.named(GLOBAL_PROP_NAME, name);
	}

	typeId(name: string): number {
		return this.named(GLOBAL_TYPE_NAME, name);
	}

	newObject(): number {
		return this.next++;
	}

	private store(v: Uint8Array): Seg {
		if (v.length <= 4) return { imm: v.slice() };
		const at = this.data.len;
		this.data.append(v);
		return { at, len: v.length };
	}

	/** Set a value of `obj`. */
	set(obj: number, property: string, type: string, value: Uint8Array) {
		const p = this.property(property);
		const t = this.typeId(type);
		this.entries.push([obj, p, t, [this.store(value)]]);
	}

	/** The reference list of `obj` (keys are object ids). */
	setReferences(obj: number, targets: readonly number[]) {
		const v = new Uint8Array(targets.length * 8);
		const dv = new DataView(v.buffer);
		targets.forEach((t, i) => {
			dv.setUint32(i * 8, t);
			dv.setUint32(i * 8 + 4, t);
		});
		this.entries.push([obj, OBJ_REFERENCES, TYPE_7BIT_ASCII, [this.store(v)]]);
	}

	finish(): Uint8Array {
		this.entries.push([TOC_OBJECT, TOC_SEED, TOC_TYPE, [{ imm: be32(this.next) }]]);
		this.entries.push([TOC_OBJECT, TOC_MIN_SEED, TOC_TYPE, [{ imm: be32(MIN_USER_ID) }]]);
		// stable sort: values of one (object, property, type) keep their order
		this.entries.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
		const toc = new Bytes();
		const u32 = (v: number) => toc.append(be32(v));
		let curObj = -1;
		let curProp = -1;
		for (const [obj, prop, ty, segs] of this.entries) {
			if (obj !== curObj) {
				toc.push(OP_NEW_OBJECT);
				u32(obj);
				curObj = obj;
				curProp = -1;
			}
			if (prop !== curProp) {
				toc.push(OP_NEW_PROPERTY);
				u32(prop);
				curProp = prop;
			}
			toc.push(OP_NEW_TYPE);
			u32(ty);
			segs.forEach((s, i) => {
				if ('imm' in s) {
					toc.push(i > 0 ? OP_CONTD_IMMEDIATE4 : OP_IMMEDIATE0 + s.imm.length);
					const w = new Uint8Array(4);
					w.set(s.imm);
					toc.append(w);
				} else if (s.at <= 0xffffffff) {
					toc.push(i > 0 ? OP_CONTD_OFFSET4_LEN4 : OP_OFFSET4_LEN4);
					u32(s.at);
					u32(s.len);
				} else {
					toc.push(i > 0 ? OP_CONTD_OFFSET8_LEN4 : OP_OFFSET8_LEN4);
					u32(Math.floor(s.at / 2 ** 32));
					u32(s.at % 2 ** 32);
					u32(s.len);
				}
			});
		}
		const tocAt = this.data.len;
		const t = toc.bytes();
		const out = new Uint8Array(tocAt + t.length + LABEL_SIZE);
		out.set(this.data.bytes(), 0);
		out.set(t, tocAt);
		const label = out.subarray(tocAt + t.length);
		label.set(MAGIC, 0);
		const dv = new DataView(label.buffer, label.byteOffset, LABEL_SIZE);
		dv.setUint16(8, 0); // flags
		dv.setUint16(10, TOC_BUFFER_KIB);
		dv.setUint16(12, 1);
		dv.setUint16(14, 0);
		dv.setUint32(16, Math.min(0xffffffff, tocAt));
		dv.setUint32(20, t.length);
		return out;
	}
}

/** One value of a parsed object. */
export type Prop = { prop: number; ty: number; segs: Seg[] };

/** Whether `b` ends with a Bento label. */
export function sniffBento(b: Uint8Array): boolean {
	if (b.length < LABEL_SIZE) return false;
	const at = b.length - LABEL_SIZE;
	return MAGIC.every((v, i) => b[at + i] === v);
}

const MAX_SEGMENTS = 1 << 20;
/** A global name ("OMFI:CPNT:Length") is a few dozen bytes. */
const MAX_NAME_BYTES = 1024;
/** Entries of an object's reference list that are considered (an object has at most 65 535 references per list). */
const MAX_REFERENCES = 1 << 20;

/** A parsed Bento container. */
export class BentoContainer {
	readonly objects = new Map<number, Prop[]>();
	private readonly names = new Map<number, string>();
	private readonly byName = new Map<string, number>();
	private readonly refs = new Map<number, Map<number, number>>();
	/**
	 * Work the reader may still do (security review PAR-2). A Bento file is a graph: values may overlap, an object
	 * may reference itself, and every lookup scans a list. Each scan, copy and decode is charged; the allowance
	 * grows with the table of contents, so a real file never comes near it and a hostile one is refused after a
	 * bounded amount of work instead of running for hours or allocating gigabytes.
	 */
	private work = 0;

	private constructor(private readonly data: Uint8Array) {}

	/** Charges `n` units of work; throws when the file asks for more than its size can justify. */
	charge(n: number): void {
		this.work -= n;
		if (this.work < 0) throw new BentoError('the file is too complex to read (damaged?)');
	}

	static open(data: Uint8Array): BentoContainer {
		if (!sniffBento(data)) throw new BentoError('no Bento label at the end of the file');
		const l = new DataView(data.buffer, data.byteOffset + data.length - LABEL_SIZE, LABEL_SIZE);
		const buf = Math.max(1, l.getUint16(10)) * 1024;
		const tocAt = l.getUint32(16);
		const tocLen = l.getUint32(20);
		if (tocAt + tocLen > data.length) throw new BentoError('the TOC lies outside the file');
		const toc = data.subarray(tocAt, tocAt + tocLen);
		const tv = new DataView(toc.buffer, toc.byteOffset, toc.byteLength);
		const c = new BentoContainer(data);
		c.work = tocLen * 64 + 2_000_000;
		let obj = 0;
		let prop = 0;
		let i = 0;
		let segments = 0;
		const need = (n: number) => {
			if (i + n > toc.length) throw new BentoError('truncated TOC');
		};
		const push = (seg: Seg) => {
			const p = c.objects.get(obj)?.at(-1);
			if (!p) throw new BentoError('a value without a type in the TOC');
			if (++segments > MAX_SEGMENTS) throw new BentoError('too many value segments');
			p.segs.push(seg);
		};
		while (i < toc.length) {
			const op = toc[i++]!;
			switch (op) {
				case OP_NEW_OBJECT:
					need(4);
					obj = tv.getUint32(i);
					i += 4;
					break;
				case OP_NEW_PROPERTY:
					need(4);
					prop = tv.getUint32(i);
					i += 4;
					break;
				case OP_NEW_TYPE: {
					need(4);
					const ty = tv.getUint32(i);
					i += 4;
					let list = c.objects.get(obj);
					if (!list) c.objects.set(obj, (list = []));
					list.push({ prop, ty, segs: [] });
					break;
				}
				case OP_EXPLICIT_GEN:
				case OP_REFERENCE_LIST_ID:
					need(4);
					i += 4;
					break;
				case OP_OFFSET4_LEN4:
				case OP_CONTD_OFFSET4_LEN4:
					need(8);
					push({ at: tv.getUint32(i), len: tv.getUint32(i + 4) });
					i += 8;
					break;
				case OP_OFFSET8_LEN4:
				case OP_CONTD_OFFSET8_LEN4:
					need(12);
					push({ at: tv.getUint32(i) * 2 ** 32 + tv.getUint32(i + 4), len: tv.getUint32(i + 8) });
					i += 12;
					break;
				case OP_END_OF_BUFFER:
					// the rest of this TOC buffer is unused
					i = Math.floor((i - 1) / buf) * buf + buf;
					break;
				case OP_PADDING:
				case 0:
					break;
				default:
					if ((op >= OP_IMMEDIATE0 && op <= OP_IMMEDIATE4) || op === OP_CONTD_IMMEDIATE4) {
						need(4);
						const n = op === OP_CONTD_IMMEDIATE4 ? 4 : op - OP_IMMEDIATE0;
						push({ imm: toc.slice(i, i + n) });
						i += 4;
						break;
					}
					throw new BentoError(`unknown TOC operation ${op}`);
			}
		}
		for (const [id, props] of c.objects) {
			const p = props.find((x) => x.prop === GLOBAL_PROP_NAME || x.prop === GLOBAL_TYPE_NAME);
			if (!p) continue;
			const v = c.tryValue(p);
			// Every object could name the whole file as its "name": names are short, anything else is not one.
			if (!v || v.length > MAX_NAME_BYTES) continue;
			let s = '';
			for (const b of v) s += String.fromCharCode(b);
			s = s.replace(/\0+$/, '');
			c.byName.set(s, id);
			c.names.set(id, s);
		}
		return c;
	}

	/** The bytes of a value (null when a segment lies outside the file). */
	tryValue(p: Prop): Uint8Array | null {
		if (p.segs.length === 1) {
			const s = p.segs[0]!;
			if ('imm' in s) return s.imm;
			return s.at + s.len <= this.data.length ? this.data.subarray(s.at, s.at + s.len) : null;
		}
		let total = 0;
		for (const s of p.segs) {
			if ('imm' in s) total += s.imm.length;
			else {
				if (s.at + s.len > this.data.length) return null;
				total += s.len;
			}
		}
		// Segments of one value do not overlap: together they cannot be larger than the file. (A table of contents
		// can name the same megabytes a million times; the sum would be allocated.)
		if (total > this.data.length) return null;
		this.charge(total + p.segs.length);
		const out = new Uint8Array(total);
		let at = 0;
		for (const s of p.segs) {
			const b = 'imm' in s ? s.imm : this.data.subarray(s.at, s.at + s.len);
			out.set(b, at);
			at += b.length;
		}
		return out;
	}

	idOf(name: string): number | undefined {
		return this.byName.get(name);
	}

	nameOf(id: number): string | undefined {
		return this.names.get(id);
	}

	/** The first value of property `name` of `obj`. */
	get(obj: number, name: string): Uint8Array | null {
		const pid = this.byName.get(name);
		if (pid === undefined) return null;
		const props = this.objects.get(obj);
		if (!props) return null;
		this.charge(1 + props.length);
		const p = props.find((x) => x.prop === pid);
		return p ? this.tryValue(p) : null;
	}

	/** Resolve an object reference key of `obj` through its reference list. */
	resolve(obj: number, key: number): number {
		this.charge(1);
		let map = this.refs.get(obj);
		if (!map) {
			// Built once per object (the first key wins, as in a scan from the start).
			map = new Map();
			const p = this.objects.get(obj)?.find((x) => x.prop === OBJ_REFERENCES);
			const v = p ? this.tryValue(p) : null;
			if (v) {
				const n = Math.min(Math.floor(v.length / 8), MAX_REFERENCES);
				this.charge(n);
				const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
				for (let i = 0; i < n; i++) {
					const k = dv.getUint32(i * 8);
					if (!map.has(k)) map.set(k, dv.getUint32(i * 8 + 4));
				}
			}
			this.refs.set(obj, map);
		}
		return map.get(key) ?? key;
	}
}
