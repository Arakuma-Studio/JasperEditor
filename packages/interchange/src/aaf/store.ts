// AAF objects in structured storage (the AAF Low-Level Container Specification): every object is a storage whose
// class id is the object's class AUID, holding a `properties` stream; strong references are child storages,
// collections have an index stream, weak references name a key in a target collection through the root's
// `referenced properties` table.
//
// `properties` stream (little-endian): u8 byte order (0x4C 'L'), u8 format version (0x20), u16 entry count,
// count × {u16 pid, u16 stored form, u16 value length}, then the values in entry order.
//
// | stored form | value |
// |---|---|
// | 0x82 data | the property's bytes |
// | 0x22 strong reference | UTF-16 name of the child storage |
// | 0x32 strong reference vector | UTF-16 collection name; storages `name{key}`, stream `name index`: u32 count, u32 first free key, u32 last free key, count × u32 local key |
// | 0x3A strong reference set | as a vector; the index adds u16 key pid, u8 key size, and each entry is u32 local key, u32 reference count, key bytes |
// | 0x02 weak reference | u16 referenced-property tag, u16 key pid, u8 key size, key bytes |
// | 0x12 / 0x1A weak reference vector / set | UTF-16 collection name; stream `name index`: u32 count, u16 tag, u16 key pid, u8 key size, count × key |
// | 0x42 data stream | u8 byte order, UTF-16 name of the stream |
//
// Port of FilmCraft `crates/interchange/src/aaf/store.rs` (MIT OR Apache-2.0).
import { type CfbVersion, CfbWriter, CompoundFile } from '../cfb.ts';

export type Auid = Uint8Array;

export const SF_DATA = 0x82;
export const SF_DATA_STREAM = 0x42;
export const SF_STRONG = 0x22;
export const SF_STRONG_VECTOR = 0x32;
export const SF_STRONG_SET = 0x3a;
export const SF_WEAK = 0x02;
export const SF_WEAK_VECTOR = 0x12;
export const SF_WEAK_SET = 0x1a;

const LE = 0x4c;
const FORMAT_VERSION = 0x20;

export type Value =
	| { t: 'data'; d: Uint8Array }
	| { t: 'strong'; o: Obj }
	| { t: 'strongVec'; items: Obj[] }
	| { t: 'strongSet'; items: Obj[]; keyPid: number; keySize?: number }
	| { t: 'weak'; path: number[]; keyPid: number; key: Uint8Array }
	| { t: 'weakVec'; path: number[]; keyPid: number; keys: Uint8Array[] }
	| { t: 'stream'; d: Uint8Array };

export class Obj {
	props: [number, Value][] = [];
	constructor(public cls: Auid) {}

	set(pid: number, v: Value): this {
		const slot = this.props.find((p) => p[0] === pid);
		if (slot) slot[1] = v;
		else this.props.push([pid, v]);
		return this;
	}
	data(pid: number, d: Uint8Array): this {
		return this.set(pid, { t: 'data', d });
	}
	get(pid: number): Value | undefined {
		return this.props.find((p) => p[0] === pid)?.[1];
	}
	bytes(pid: number): Uint8Array | null {
		const v = this.get(pid);
		return v?.t === 'data' ? v.d : null;
	}
	strong(pid: number): Obj | null {
		const v = this.get(pid);
		return v?.t === 'strong' ? v.o : null;
	}
	objs(pid: number): Obj[] {
		const v = this.get(pid);
		return v?.t === 'strongVec' || v?.t === 'strongSet' ? v.items : [];
	}
	weakKey(pid: number): Uint8Array | null {
		const v = this.get(pid);
		return v?.t === 'weak' ? v.key : null;
	}
	stream(pid: number): Uint8Array | null {
		const v = this.get(pid);
		return v?.t === 'stream' ? v.d : null;
	}
	u8(pid: number): number | null {
		const d = this.bytes(pid);
		return d && d.length >= 1 ? d[0]! : null;
	}
	u16(pid: number): number | null {
		const d = this.bytes(pid);
		return d && d.length >= 2 ? d[0]! | (d[1]! << 8) : null;
	}
	u32(pid: number): number | null {
		const d = this.bytes(pid);
		return d && d.length >= 4 ? (d[0]! | (d[1]! << 8) | (d[2]! << 16) | (d[3]! << 24)) >>> 0 : null;
	}
	i64(pid: number): number | null {
		const d = this.bytes(pid);
		if (!d) return null;
		const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
		if (d.length >= 8) {
			const v = dv.getBigInt64(0, true);
			const max = BigInt(Number.MAX_SAFE_INTEGER);
			return Number(v > max ? max : v < -max ? -max : v);
		}
		if (d.length >= 4) return dv.getInt32(0, true);
		return null;
	}
	rational(pid: number): [number, number] | null {
		const d = this.bytes(pid);
		return d ? rationalOf(d) : null;
	}
	string(pid: number): string | null {
		const d = this.bytes(pid);
		return d ? utf16Of(d) : null;
	}
	auid(pid: number): Auid | null {
		const d = this.bytes(pid);
		return d && d.length >= 16 ? d.subarray(0, 16) : null;
	}
	mobId(pid: number): Uint8Array | null {
		const d = this.bytes(pid);
		return d && d.length >= 32 ? d.subarray(0, 32) : null;
	}
}

export function rationalOf(d: Uint8Array): [number, number] | null {
	if (d.length < 8) return null;
	const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
	return [dv.getInt32(0, true), dv.getInt32(4, true)];
}

const clampI32 = (v: number) => Math.max(-2147483648, Math.min(2147483647, Math.round(v)));

export function rational(num: number, den: number): Uint8Array {
	const out = new Uint8Array(8);
	const dv = new DataView(out.buffer);
	dv.setInt32(0, clampI32(num), true);
	dv.setInt32(4, clampI32(den), true);
	return out;
}

export function i64(v: number): Uint8Array {
	const out = new Uint8Array(8);
	new DataView(out.buffer).setBigInt64(0, BigInt(Math.round(v)), true);
	return out;
}
export function u32le(v: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, v >>> 0, true);
	return out;
}
export function i32le(v: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setInt32(0, clampI32(v), true);
	return out;
}
export function u16le(v: number): Uint8Array {
	return Uint8Array.of(v & 0xff, (v >> 8) & 0xff);
}

/** UTF-16LE with a terminating NUL. */
export function utf16z(s: string): Uint8Array {
	const out = new Uint8Array((s.length + 1) * 2);
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		out[i * 2] = c & 0xff;
		out[i * 2 + 1] = c >> 8;
	}
	return out;
}

export function utf16Of(d: Uint8Array): string {
	let s = '';
	for (let i = 0; i + 1 < d.length; i += 2) {
		const c = d[i]! | (d[i + 1]! << 8);
		if (c === 0) break;
		s += String.fromCharCode(c);
	}
	return s;
}

export const auidEq = (a: Uint8Array | null | undefined, b: Uint8Array | null | undefined) =>
	!!a && !!b && a.length >= 16 && b.length >= 16 && a.subarray(0, 16).every((v, i) => v === b[i]);

const PROP_NAMES: Record<number, string> = {
	1: 'MetaDictionary',
	2: 'Header',
	15107: 'Content',
	15108: 'Dictionary',
	15110: 'IdentificationList',
	6401: 'Mobs',
	6402: 'EssenceData',
	9731: 'OperationDefinitions',
	9732: 'ParameterDefinitions',
	9733: 'DataDefinitions',
	9735: 'CodecDefinitions',
	9736: 'ContainerDefinitions',
	9737: 'InterpolationDefs',
	17411: 'Slots',
	17414: 'UserComments',
	18435: 'Segment',
	4097: 'Components',
	6145: 'OperationGroup',
	2818: 'InputSegments',
	2819: 'Parameters',
	19970: 'PointList',
	18177: 'EssenceDescription',
	12033: 'Locator',
	9986: 'Data',
	516: 'ComponentComments',
	7689: 'ParametersDefined',
};

function storageName(pid: number): string {
	const suffix = `-${pid.toString(16)}`;
	return `${(PROP_NAMES[pid] ?? 'Property').slice(0, 22 - suffix.length)}${suffix}`;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

// ---------------------------------------------------------------- writing

/** Serialises `root` (the Root object: MetaDictionary 0x0001, Header 0x0002) into a compound file. */
export function writeStore(root: Obj, version: CfbVersion): Uint8Array {
	const cfb = new CfbWriter(version);
	const paths: number[][] = [];
	const tag = (p: number[]) => {
		const i = paths.findIndex((x) => x.length === p.length && x.every((v, k) => v === p[k]));
		if (i >= 0) return i;
		paths.push([...p]);
		return paths.length - 1;
	};
	// Iterative (deep object trees must not overflow the stack).
	const work: { node: number; o: Obj }[] = [{ node: CfbWriter.ROOT, o: root }];
	while (work.length) {
		const { node, o } = work.pop()!;
		cfb.setClsid(node, o.cls);
		const entries: [number, number, Uint8Array][] = [];
		for (const [pid, v] of o.props) {
			let sf: number;
			let value: Uint8Array;
			switch (v.t) {
				case 'data':
					sf = SF_DATA;
					value = v.d;
					break;
				case 'strong': {
					const name = storageName(pid);
					const s = cfb.storage(node, name, v.o.cls);
					work.push({ node: s, o: v.o });
					sf = SF_STRONG;
					value = utf16z(name);
					break;
				}
				case 'strongVec':
				case 'strongSet': {
					const name = storageName(pid);
					const keyPid = v.t === 'strongSet' ? v.keyPid : null;
					const keySize =
						keyPid !== null
							? (v.items[0]?.bytes(keyPid)?.length ?? (v.t === 'strongSet' ? (v.keySize ?? 0) : 0))
							: 0;
					const idx: Uint8Array[] = [u32le(v.items.length), u32le(v.items.length), u32le(0xffffffff)];
					if (keyPid !== null) idx.push(u16le(keyPid), Uint8Array.of(keySize));
					v.items.forEach((item, i) => {
						const s = cfb.storage(node, `${name}{${i.toString(16)}}`, item.cls);
						work.push({ node: s, o: item });
						idx.push(u32le(i));
						if (keyPid !== null) {
							idx.push(u32le(1));
							const key = new Uint8Array(keySize);
							key.set((item.bytes(keyPid) ?? new Uint8Array(0)).subarray(0, keySize));
							idx.push(key);
						}
					});
					cfb.stream(node, `${name} index`, concat(idx));
					sf = keyPid !== null ? SF_STRONG_SET : SF_STRONG_VECTOR;
					value = utf16z(name);
					break;
				}
				case 'weak':
					sf = SF_WEAK;
					value = concat([u16le(tag(v.path)), u16le(v.keyPid), Uint8Array.of(v.key.length), v.key]);
					break;
				case 'weakVec': {
					const name = storageName(pid);
					const size = v.keys[0]?.length ?? 0;
					const idx: Uint8Array[] = [
						u32le(v.keys.length),
						u16le(tag(v.path)),
						u16le(v.keyPid),
						Uint8Array.of(size),
					];
					for (const k of v.keys) {
						const key = new Uint8Array(size);
						key.set(k.subarray(0, size));
						idx.push(key);
					}
					cfb.stream(node, `${name} index`, concat(idx));
					sf = SF_WEAK_VECTOR;
					value = utf16z(name);
					break;
				}
				case 'stream': {
					const name = storageName(pid);
					cfb.stream(node, name, v.d);
					sf = SF_DATA_STREAM;
					value = concat([Uint8Array.of(LE), utf16z(name)]);
					break;
				}
			}
			if (value.length > 0xffff)
				throw new Error(`property 0x${pid.toString(16)} is ${value.length} bytes (the limit is 65535)`);
			entries.push([pid, sf, value]);
		}
		const head: Uint8Array[] = [Uint8Array.of(LE, FORMAT_VERSION), u16le(entries.length)];
		for (const [pid, sf, v] of entries) head.push(u16le(pid), u16le(sf), u16le(v.length));
		for (const [, , v] of entries) head.push(v);
		cfb.stream(node, 'properties', concat(head));
	}
	const rp: Uint8Array[] = [
		Uint8Array.of(LE),
		u16le(paths.length),
		u32le(paths.reduce((n, p) => n + p.length + 1, 0)),
	];
	for (const p of paths) {
		for (const pid of p) rp.push(u16le(pid));
		rp.push(u16le(0));
	}
	cfb.stream(CfbWriter.ROOT, 'referenced properties', concat(rp));
	return cfb.finish();
}

// ---------------------------------------------------------------- reading

const MAX_DEPTH = 200;
const MAX_OBJECTS = 2_000_000;

export class StoreError extends Error {}

const rd16 = (b: Uint8Array, at: number): number | null =>
	at + 2 <= b.length ? b[at]! | (b[at + 1]! << 8) : null;
const rd32 = (b: Uint8Array, at: number): number | null =>
	at + 4 <= b.length ? (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0 : null;

/** Parses the object tree of an AAF compound file (the root object). */
export function readStore(bytes: Uint8Array): Obj {
	const cf = CompoundFile.open(bytes);
	const paths: number[][] = [];
	try {
		const rp = cf.readPath('referenced properties');
		if (rp.length >= 7) {
			const count = rd16(rp, 1)!;
			let cur: number[] = [];
			for (let at = 7; at + 1 < rp.length && paths.length < count; at += 2) {
				const pid = rd16(rp, at)!;
				if (pid === 0) {
					paths.push(cur);
					cur = [];
				} else cur.push(pid);
			}
		}
	} catch {
		// no referenced properties: weak references resolve by key only
	}
	let objects = 0;
	const child = (parent: number, name: string): number => {
		const c = cf.child(parent, name);
		if (c === null) throw new StoreError(`missing storage or stream "${name}"`);
		return c;
	};
	const stream = (parent: number, name: string) => cf.read(child(parent, name));
	const readObj = (entry: number, depth: number): Obj => {
		if (depth > MAX_DEPTH) throw new StoreError('objects nested too deeply');
		if (++objects > MAX_OBJECTS) throw new StoreError('too many objects');
		const e = cf.entries[entry];
		if (!e || (e.kind !== 'root' && e.kind !== 'storage'))
			throw new StoreError(`"${e?.name ?? entry}" is not a storage`);
		const o = new Obj(e.clsid);
		const props = stream(entry, 'properties');
		if (props.length < 4) throw new StoreError('short properties stream');
		if (props[0] !== LE) throw new StoreError('big-endian AAF files are not supported');
		const n = rd16(props, 2) ?? 0;
		let at = 4 + n * 6;
		if (at > props.length) throw new StoreError('truncated property index');
		for (let i = 0; i < n; i++) {
			const pid = rd16(props, 4 + i * 6)!;
			const sf = rd16(props, 6 + i * 6)!;
			const len = rd16(props, 8 + i * 6)!;
			if (at + len > props.length) throw new StoreError('truncated property value');
			const v = props.subarray(at, at + len);
			at += len;
			let value: Value;
			switch (sf) {
				case SF_STRONG:
					value = { t: 'strong', o: readObj(child(entry, utf16Of(v)), depth + 1) };
					break;
				case SF_STRONG_VECTOR:
				case SF_STRONG_SET: {
					const name = utf16Of(v);
					const idx = stream(entry, `${name} index`);
					const count = rd32(idx, 0);
					if (count === null) throw new StoreError('short collection index');
					if (count > idx.length) throw new StoreError('bad collection count');
					const items: Obj[] = [];
					if (sf === SF_STRONG_VECTOR) {
						for (let k = 0; k < count; k++) {
							const key = rd32(idx, 12 + k * 4);
							if (key === null) throw new StoreError('short vector index');
							items.push(readObj(child(entry, `${name}{${key.toString(16)}}`), depth + 1));
						}
						value = { t: 'strongVec', items };
					} else {
						const keyPid = rd16(idx, 12);
						const keySize = idx[14];
						if (keyPid === null || keySize === undefined) throw new StoreError('short set index');
						const stride = 8 + keySize;
						for (let k = 0; k < count; k++) {
							const key = rd32(idx, 15 + k * stride);
							if (key === null) throw new StoreError('short set index');
							items.push(readObj(child(entry, `${name}{${key.toString(16)}}`), depth + 1));
						}
						value = { t: 'strongSet', items, keyPid };
					}
					break;
				}
				case SF_WEAK: {
					const tg = rd16(v, 0);
					const keyPid = rd16(v, 2);
					const size = v[4];
					if (tg === null || keyPid === null || size === undefined || 5 + size > v.length)
						throw new StoreError('short weak reference');
					value = { t: 'weak', path: paths[tg] ?? [], keyPid, key: v.slice(5, 5 + size) };
					break;
				}
				case SF_WEAK_VECTOR:
				case SF_WEAK_SET: {
					const idx = stream(entry, `${utf16Of(v)} index`);
					const count = rd32(idx, 0);
					const tg = rd16(idx, 4);
					const keyPid = rd16(idx, 6);
					const size = idx[8];
					if (count === null || tg === null || keyPid === null || size === undefined)
						throw new StoreError('short weak collection index');
					if (9 + count * size > idx.length) throw new StoreError('short weak collection index');
					const keys: Uint8Array[] = [];
					for (let k = 0; k < count; k++) keys.push(idx.slice(9 + k * size, 9 + (k + 1) * size));
					value = { t: 'weakVec', path: paths[tg] ?? [], keyPid, keys };
					break;
				}
				case SF_DATA_STREAM:
					value = { t: 'stream', d: stream(entry, utf16Of(v.subarray(1))) };
					break;
				default:
					value = { t: 'data', d: v.slice() };
			}
			o.props.push([pid, value]);
		}
		return o;
	};
	return readObj(0, 0);
}
