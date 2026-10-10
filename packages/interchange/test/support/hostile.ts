// Hostile AAF / OMF containers (security review PAR-2): small files built to make a reader loop, recurse or
// allocate far beyond their own size. Measured against the readers before the fixes (each in its own process, 25 s
// limit, docs/security-review.md §8): the weak set of empty keys crashed Node (out of memory), the overlapping Bento
// segments and the self-containing OMF sequence never finished, the repeated AAF children took 5 s and 350 MiB for
// a 12 KiB file; the compound-file cycle and the 65 535 properties were already refused (they stay as regression
// tests of that). Used by hostile.test.ts (each one alone, with a time limit) and as fuzz seeds (fuzz.test.ts), so
// mutation starts from the shapes that hurt.
import { utf16z } from '../../src/aaf/store.ts';
import { CfbWriter, ENDOFCHAIN, FATSECT, FREESECT } from '../../src/cfb.ts';
import { BentoWriter, LABEL_SIZE, MAGIC } from '../../src/omf/bento.ts';
import { encodeUtf8 } from '../../src/paths.ts';

const le16 = (v: number) => Uint8Array.of(v & 0xff, (v >> 8) & 0xff);
const le32 = (v: number) => Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
const be32 = (v: number) => Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
const concat = (parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

// ---------------------------------------------------------------- compound files

/**
 * A version 4 compound file (4096-byte sectors) whose header names the same FAT sector in all 109 DIFAT slots and
 * whose directory chain is a one-sector cycle: the FAT then has 109 × 1024 entries, far more than the file has
 * sectors, and the cycle must be recognised by the chain's length before anything is assembled from it.
 */
export function cfbDirectoryCycle(): Uint8Array {
	const SS = 4096;
	const sectors = 109;
	const b = new Uint8Array((sectors + 1) * SS);
	const dv = new DataView(b.buffer);
	b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
	dv.setUint16(24, 0x3e, true);
	dv.setUint16(26, 4, true);
	dv.setUint16(28, 0xfffe, true);
	dv.setUint16(30, 12, true);
	dv.setUint16(32, 6, true);
	dv.setUint32(44, 109, true); // FAT sectors
	dv.setUint32(48, 0, true); // first directory sector
	dv.setUint32(56, 4096, true);
	dv.setUint32(60, ENDOFCHAIN, true); // no mini FAT
	dv.setUint32(68, ENDOFCHAIN, true); // no DIFAT sectors
	for (let i = 0; i < 109; i++) dv.setUint32(76 + i * 4, 1, true); // every slot: sector 1
	// Sector 1 is the FAT: sector 0 (the directory) points at itself.
	const fat = SS * 2;
	for (let i = 0; i < SS / 4; i++) dv.setUint32(fat + i * 4, FREESECT, true);
	dv.setUint32(fat, 0, true);
	dv.setUint32(fat + 4, FATSECT, true);
	// Sector 0: a root entry, so the directory looks plausible.
	const dir = SS;
	b.set(utf16z('Root Entry'), dir);
	dv.setUint16(dir + 64, 22, true);
	b[dir + 66] = 5;
	for (const at of [68, 72, 76]) dv.setUint32(dir + at, 0xffffffff, true);
	dv.setUint32(dir + 116, ENDOFCHAIN, true);
	return b;
}

/** The `properties` stream of an AAF object: (pid, stored form, value) triples. */
function properties(props: [number, number, Uint8Array][], declared = props.length): Uint8Array {
	return concat([
		Uint8Array.of(0x4c, 0x20),
		le16(declared),
		...props.map(([pid, sf, v]) => concat([le16(pid), le16(sf), le16(v.length)])),
		...props.map(([, , v]) => v),
	]);
}

/**
 * An AAF object store in which every object has a strong reference vector of `fanout` entries that all name the
 * same child storage, `depth` levels deep: seven storages that were read until the two-million-object limit.
 */
export function aafRepeatedChildren(fanout = 60, depth = 6): Uint8Array {
	const w = new CfbWriter(3);
	const clsid = new Uint8Array(16).fill(9);
	w.setClsid(CfbWriter.ROOT, clsid);
	let parent = CfbWriter.ROOT;
	for (let level = 0; level <= depth; level++) {
		const leaf = level === depth;
		w.stream(parent, 'properties', properties(leaf ? [] : [[0x1901, 0x32, utf16z('V')]]));
		if (leaf) break;
		// u32 count, first free key, last free key, then `count` local keys: all 0.
		w.stream(parent, 'V index', concat([le32(fanout), le32(1), le32(1), new Uint8Array(fanout * 4)]));
		parent = w.storage(parent, 'V{0}', clsid);
	}
	return w.finish();
}

/**
 * An AAF object with a weak reference set whose index says: 4 294 967 295 keys of 0 bytes each. The length check
 * (9 + count × size ≤ stream) passes; the reader then built that many keys.
 */
export function aafWeakSetOfEmptyKeys(): Uint8Array {
	const w = new CfbWriter(3);
	w.setClsid(CfbWriter.ROOT, new Uint8Array(16).fill(9));
	w.stream(CfbWriter.ROOT, 'properties', properties([[0x0601, 0x1a, utf16z('W')]]));
	w.stream(CfbWriter.ROOT, 'W index', concat([le32(0xffffffff), le16(0), le16(0x3c0a), Uint8Array.of(0)]));
	return w.finish();
}

/** An AAF object that declares 65 535 properties (lookups scan the list; real classes have a few dozen). */
export function aafManyProperties(): Uint8Array {
	const w = new CfbWriter(3);
	w.setClsid(CfbWriter.ROOT, new Uint8Array(16).fill(9));
	const props: [number, number, Uint8Array][] = Array.from({ length: 65_535 }, (_, i) => [
		i + 1,
		0x82,
		new Uint8Array(0),
	]);
	w.stream(CfbWriter.ROOT, 'properties', properties(props));
	return w.finish();
}

// ---------------------------------------------------------------- Bento / OMF

/**
 * A Bento container whose table of contents gives one value (an object's global name, which `open` reads) `segments`
 * segments that each cover the same megabyte: the value was assembled into segments × 1 MiB (default 4 GiB) and
 * then turned into a string character by character.
 */
export function bentoOverlappingSegments(segments = 4096, heapBytes = 1 << 20): Uint8Array {
	const heap = new Uint8Array(heapBytes).fill(0x41);
	const ops: Uint8Array[] = [
		Uint8Array.of(1),
		be32(100), // NewObject 100
		Uint8Array.of(2),
		be32(24), // NewProperty: global property name
		Uint8Array.of(3),
		be32(21), // NewType: 7-bit ASCII
	];
	for (let i = 0; i < segments; i++) ops.push(Uint8Array.of(i === 0 ? 5 : 6), be32(0), be32(heap.length));
	const toc = concat(ops);
	const label = new Uint8Array(LABEL_SIZE);
	label.set(MAGIC, 0);
	const dv = new DataView(label.buffer);
	dv.setUint16(10, 8);
	dv.setUint16(12, 1);
	dv.setUint32(16, heap.length);
	dv.setUint32(20, toc.length);
	return concat([heap, toc, label]);
}

/** What `omfSelfContaining` and friends share: a header, one composition mob, one slot, and the slot's segment. */
function omf(build: (w: BentoWriter, o: { obj(cls: string): number }, seq: number) => number[]): Uint8Array {
	const w = new BentoWriter();
	const refs = new Map<number, number[]>();
	const o = {
		obj(cls: string) {
			const id = w.newObject();
			w.set(id, 'OMFI:OOBJ:ObjClass', 'omfi:ClassID', encodeUtf8(cls));
			return id;
		},
	};
	const ref = (from: number, prop: string, to: number) => {
		w.set(from, prop, 'omfi:ObjRef', be32(to));
		refs.set(from, [...(refs.get(from) ?? []), to]);
	};
	const refList = (from: number, prop: string, to: number[]) => {
		w.set(
			from,
			prop,
			'omfi:ObjRefArray',
			concat([Uint8Array.of(to.length >> 8, to.length & 0xff), ...to.map(be32)]),
		);
		refs.set(from, [...(refs.get(from) ?? []), ...to]);
	};
	const head = o.obj('HEAD');
	w.set(head, 'OMFI:HEAD:ByteOrder', 'omfi:Int16', Uint8Array.of(0x4d, 0x4d));
	const mob = o.obj('CMOB');
	w.set(mob, 'OMFI:MOBJ:MobID', 'omfi:UID', new Uint8Array(12).fill(1));
	const slot = o.obj('MSLT');
	const seq = o.obj('SEQU');
	// A sound slot (the reader imports audio): the segment's data kind is a DDEF object named omfi:data:Sound.
	const sound = o.obj('DDEF');
	w.set(sound, 'OMFI:DDEF:DataKindID', 'omfi:UniqueName', encodeUtf8('omfi:data:Sound\0'));
	ref(seq, 'OMFI:CPNT:DataKind', sound);
	refList(head, 'OMFI:HEAD:Mobs', [mob]);
	refList(mob, 'OMFI:MOBJ:Slots', [slot]);
	ref(slot, 'OMFI:MSLT:Segment', seq);
	refList(seq, 'OMFI:SEQU:Components', build(w, o, seq));
	for (const [from, to] of refs) w.setReferences(from, to);
	return w.finish();
}

/**
 * An OMF file whose sequence lists itself `fanout` times among its components. Objects are referenced by id, so
 * this is a legal Bento graph; the reader walked it along every path to its depth limit (fanout³² segments).
 */
export function omfSelfContaining(fanout = 4): Uint8Array {
	return omf((_w, _o, seq) => Array.from({ length: fanout }, () => seq));
}

/** Every crafted file, named (for fuzz seeds and failure messages). */
export const HOSTILE_FILES: Record<string, () => Uint8Array> = {
	'cfb: directory chain cycle behind a 109-fold FAT': cfbDirectoryCycle,
	'aaf: the same child storage named 60 times, 6 levels deep': () => aafRepeatedChildren(),
	'aaf: weak set of 4 294 967 295 empty keys': aafWeakSetOfEmptyKeys,
	'aaf: 65 535 properties on one object': aafManyProperties,
	'bento: 4096 segments over the same megabyte': () => bentoOverlappingSegments(),
	'omf: a sequence that contains itself four times': () => omfSelfContaining(),
};

/** Small versions of the same shapes: seeds for the mutation fuzzers (fuzz.test.ts). */
export function hostileSeeds(): Uint8Array[] {
	return [
		aafRepeatedChildren(8, 4),
		aafWeakSetOfEmptyKeys(),
		bentoOverlappingSegments(256, 4096),
		omfSelfContaining(2),
	];
}
