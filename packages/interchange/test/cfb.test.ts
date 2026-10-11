import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CfbError, CfbWriter, CompoundFile, compareNames, NOSTREAM } from '../src/cfb.ts';

const pattern = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

function sample(version: 3 | 4, siblings: number) {
	const w = new CfbWriter(version);
	w.setClsid(CfbWriter.ROOT, new Uint8Array(16).fill(7));
	const expect: [string, Uint8Array][] = [];
	const a = w.storage(CfbWriter.ROOT, 'Header-2', new Uint8Array(16).fill(1));
	const b = w.storage(a, 'Content-3b03', new Uint8Array(16).fill(2));
	[0, 1, 63, 64, 65, 4095, 4096, 4097, 20000].forEach((size, i) => {
		const data = pattern(size, i);
		w.stream(b, `s${i}`, data);
		expect.push([`Header-2/Content-3b03/s${i}`, data]);
	});
	for (let i = 0; i < siblings; i++) {
		const name = `Mobs-1901{${i.toString(16)}}`;
		const s = w.storage(CfbWriter.ROOT, name, new Uint8Array(16).fill(3));
		const data = pattern(10 + i * 7, 99);
		w.stream(s, 'properties', data);
		expect.push([`${name}/properties`, data]);
	}
	return { bytes: w.finish(), expect };
}

function check(bytes: Uint8Array, expected: [string, Uint8Array][]) {
	const cf = CompoundFile.open(bytes);
	expect([...cf.root().clsid]).toEqual(new Array(16).fill(7));
	for (const [path, data] of expected) expect(cf.readPath(path)).toEqual(data);
	for (const e of cf.entries)
		for (let i = 1; i < e.children.length; i++)
			expect(
				compareNames(cf.entries[e.children[i - 1]!]!.name, cf.entries[e.children[i]!]!.name),
			).toBeLessThan(0);
}

/** Every path from a node to a nil leaf has the same number of black nodes; no red node has a red child. */
function checkRedBlack(bytes: Uint8Array) {
	const cf = CompoundFile.open(bytes);
	const blackHeight = (n: number, parentRed: boolean): number => {
		if (n === NOSTREAM) return 1;
		const e = cf.entries[n]!;
		const raw = new DataView(bytes.buffer);
		void raw;
		const red = colorOf(bytes, cf, n) === 0;
		expect(parentRed && red).toBe(false);
		const l = blackHeight(e.left, red);
		const r = blackHeight(e.right, red);
		expect(l).toBe(r);
		return l + (red ? 0 : 1);
	};
	for (const e of cf.entries) if (e.kind === 'root' || e.kind === 'storage') blackHeight(e.child, false);
}

function colorOf(bytes: Uint8Array, cf: CompoundFile, i: number): number {
	const dirStart = new DataView(bytes.buffer, bytes.byteOffset).getUint32(48, true);
	return bytes[(dirStart + 1) * cf.sectorSize + i * 128 + 67]!;
}

describe('MS-CFB', () => {
	it('round-trips mini and regular streams at both sector sizes, with valid red-black trees', () => {
		for (const v of [3, 4] as const)
			for (const n of [0, 1, 2, 3, 7, 8, 100, 300]) {
				const { bytes, expect: ex } = sample(v, n);
				check(bytes, ex);
				checkRedBlack(bytes);
				expect(CompoundFile.open(bytes).sectorSize).toBe(v === 3 ? 512 : 4096);
			}
	});

	it('handles DIFAT (more than 109 FAT sectors)', () => {
		const w = new CfbWriter(3);
		const big = pattern(8 * 1024 * 1024, 5);
		w.stream(CfbWriter.ROOT, 'big', big);
		const cf = CompoundFile.open(w.finish());
		// Native byte comparison avoids the per-element overhead of deep equality on 8 MiB buffers.
		const read = cf.readPath('big');
		expect(read.length).toBe(big.length);
		expect(Buffer.compare(Buffer.from(read.buffer, read.byteOffset, read.byteLength), Buffer.from(big))).toBe(
			0,
		);
	});

	it('rejects bad names and duplicates', () => {
		const w = new CfbWriter();
		expect(() => w.stream(CfbWriter.ROOT, 'a/b', new Uint8Array(1))).toThrow(CfbError);
		expect(() => w.stream(CfbWriter.ROOT, 'x'.repeat(32), new Uint8Array(1))).toThrow(CfbError);
		w.stream(CfbWriter.ROOT, 'Name', new Uint8Array(1));
		expect(() => w.stream(CfbWriter.ROOT, 'NAME', new Uint8Array(1))).toThrow(CfbError);
	});

	it('damaged files give CfbError, never another exception or a hang', () => {
		const { bytes } = sample(3, 20);
		const tryOpen = (b: Uint8Array) => {
			try {
				const cf = CompoundFile.open(b);
				for (let i = 0; i < cf.entries.length; i++) if (cf.entries[i]!.kind === 'stream') cf.read(i);
			} catch (e) {
				if (!(e instanceof CfbError)) throw e;
			}
		};
		for (let cut = 0; cut <= bytes.length; cut += 97) tryOpen(bytes.subarray(0, cut));
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 16 }),
				(muts) => {
					const b = Uint8Array.from(bytes);
					for (const [pos, v] of muts) b[pos % b.length] = v;
					tryOpen(b);
				},
			),
			{ numRuns: 400 },
		);
	});
});
