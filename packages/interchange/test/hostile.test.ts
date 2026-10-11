// Malformed container graphs must fail with format errors before exhausting memory or time. Field-aware
// mutations target counts, offsets and links that random byte mutations rarely exercise.
import { describe, expect, it } from 'vitest';
import { importAaf } from '../src/aaf/index.ts';
import { readStore, StoreError } from '../src/aaf/store.ts';
import { CfbError, CfbWriter, CompoundFile } from '../src/cfb.ts';
import { exportTimeline, importTimeline } from '../src/index.ts';
import { BentoContainer } from '../src/omf/bento.ts';
import { importOmf } from '../src/omf/index.ts';
import { InterchangeError, Report } from '../src/report.ts';
import {
	aafManyProperties,
	aafRepeatedChildren,
	aafWeakSetOfEmptyKeys,
	bentoOverlappingSegments,
	cfbDirectoryCycle,
	HOSTILE_FILES,
	omfSelfContaining,
} from './support/hostile.ts';
import { richProject } from './support/rich.ts';

const NOW = '2026-10-07T00:00:00.000Z';

/** Allows for a loaded host while bounding malformed-container traversal. */
const LIMIT_MS = 20_000;

function timed<T>(fn: () => T): { ms: number; value?: T; error?: unknown } {
	const t0 = performance.now();
	try {
		return { value: fn(), ms: performance.now() - t0 };
	} catch (error) {
		return { error, ms: performance.now() - t0 };
	}
}

describe('compound files (MS-CFB)', () => {
	it('a directory chain that cycles is refused before anything is assembled from it', () => {
		const file = cfbDirectoryCycle();
		expect(file.length).toBe(110 * 4096);
		const r = timed(() => CompoundFile.open(file));
		expect(r.error).toBeInstanceOf(CfbError);
		expect((r.error as Error).message).toMatch(/chain loops/);
		expect(r.ms).toBeLessThan(LIMIT_MS);
	});

	it('streams cannot be read into more bytes than a few times the file', () => {
		const w = new CfbWriter(4);
		w.stream(CfbWriter.ROOT, 'big', new Uint8Array(200_000).fill(7));
		const file = w.finish();
		const cf = CompoundFile.open(file);
		const id = cf.find('big');
		let handedOut = 0;
		const r = timed(() => {
			for (let i = 0; i < 10_000; i++) handedOut += cf.read(id).length;
		});
		// A few reads are fine (the AAF reader reads each stream once); a file whose directory names the same sectors
		// from thousands of entries is stopped.
		expect(handedOut).toBeGreaterThanOrEqual(200_000 * 4);
		expect(handedOut).toBeLessThanOrEqual(file.length * 8 + (1 << 20));
		expect(r.error).toBeInstanceOf(CfbError);
		expect((r.error as Error).message).toMatch(/overlap/);
	});
});

describe('AAF object store', () => {
	it('an object storage is read once: a collection that names the same child again and again is refused', () => {
		const file = aafRepeatedChildren();
		expect(file.length).toBeLessThan(64 * 1024);
		const store = timed(() => readStore(file));
		expect(store.error).toBeInstanceOf(StoreError);
		expect((store.error as Error).message).toMatch(/referenced twice/);
		expect(store.ms).toBeLessThan(LIMIT_MS);
		const imp = timed(() => importAaf(file, {}, new Report()));
		expect(imp.error).toBeInstanceOf(InterchangeError);
		expect((imp.error as InterchangeError).code).toBe('PARSE');
	});

	it('a collection may name each child once (the legitimate case keeps working)', () => {
		expect(() => readStore(aafRepeatedChildren(1, 6))).not.toThrow();
	});

	it('a weak reference set of 2³² − 1 zero-length keys is refused', () => {
		const r = timed(() => readStore(aafWeakSetOfEmptyKeys()));
		expect(r.error).toBeInstanceOf(StoreError);
		expect(r.ms).toBeLessThan(LIMIT_MS);
	});

	it('an object with tens of thousands of properties is refused', () => {
		const r = timed(() => readStore(aafManyProperties()));
		expect(r.error).toBeInstanceOf(StoreError);
		expect((r.error as Error).message).toMatch(/too many properties/);
	});
});

describe('Bento containers and OMF', () => {
	it('a value whose segments overlap is not assembled (4096 × 1 MiB from a 1 MiB file)', () => {
		const file = bentoOverlappingSegments();
		expect(file.length).toBeLessThan(1.1 * (1 << 20));
		const before = process.memoryUsage().arrayBuffers;
		const r = timed(() => BentoContainer.open(file));
		expect(r.error).toBeUndefined();
		expect(r.ms).toBeLessThan(LIMIT_MS);
		const c = r.value!;
		expect(c.tryValue(c.objects.get(100)![0]!)).toBeNull();
		expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * (1 << 20));
		const imp = timed(() => importOmf(file, {}, new Report()));
		expect(imp.error).toBeInstanceOf(InterchangeError);
	});

	it('a sequence that contains itself is refused after bounded work, not walked 4³² times', () => {
		const file = omfSelfContaining(4);
		expect(file.length).toBeLessThan(8 * 1024);
		const r = timed(() => importOmf(file, {}, new Report()));
		expect(r.error).toBeInstanceOf(InterchangeError);
		expect((r.error as InterchangeError).code).toBe('PARSE');
		expect((r.error as Error).message).toMatch(/too complex/);
		expect(r.ms).toBeLessThan(LIMIT_MS);
	});

	it('the allowance does not get in the way of real files: a rich project round-trips', () => {
		const { h } = richProject();
		for (const format of ['omf', 'aaf'] as const) {
			const file = exportTimeline(h.doc, h.seqId, format).files[0]!.bytes;
			expect(() => importTimeline(file, { format, now: NOW, rate: { num: 30, den: 1 } })).not.toThrow();
		}
	});
});

describe('every crafted file, through the importers', () => {
	it.each(Object.entries(HOSTILE_FILES))('%s', (_name, make) => {
		const file = make();
		for (const imp of [importAaf, importOmf]) {
			const r = timed(() => imp(file, {}, new Report()));
			expect(r.error, 'a hostile file must not import').toBeDefined();
			expect(r.error).toBeInstanceOf(InterchangeError);
			expect(r.ms).toBeLessThan(LIMIT_MS);
		}
	});
});

/** xorshift32: deterministic across runs and hosts. */
function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s;
	};
}

/** Values that break container readers when they land in a count, an offset, a sector number or a size. */
const INTERESTING = [
	0, 1, 2, 3, 0x7f, 0x80, 0xff, 0x100, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xfffffffa, 0xfffffffc,
	0xfffffffd, 0xfffffffe, 0xffffffff,
];

function mutateFields(seed: Uint8Array, next: () => number, littleEndian: boolean): Uint8Array {
	const b = Uint8Array.from(seed);
	const dv = new DataView(b.buffer);
	const edits = 1 + (next() % 4);
	for (let e = 0; e < edits; e++) {
		// Half of the edits go where the structure is: the first sectors / the last kilobytes (header, FAT,
		// directory; the Bento label and table of contents). The rest anywhere, on a 4-byte boundary.
		const zone = next() % 4;
		const span = Math.min(b.length - 4, 8192);
		const at =
			zone === 0
				? (next() % span) & ~3
				: zone === 1
					? b.length - 4 - ((next() % span) & ~3)
					: (next() % (b.length - 4)) & ~3;
		const pick = next() % (INTERESTING.length + 3);
		const v =
			pick < INTERESTING.length
				? INTERESTING[pick]!
				: pick === INTERESTING.length
					? at >>> 0 // "points at itself"
					: pick === INTERESTING.length + 1
						? (at / 512) >>> 0 // its own sector number
						: next();
		if (next() % 5 === 0) dv.setUint16(at, v & 0xffff, littleEndian);
		else dv.setUint32(at, v >>> 0, littleEndian);
	}
	return b;
}

describe('field-aware mutation of real files', () => {
	const RUNS = process.env.FUZZ === '1' ? 20_000 : 1500;
	const { h } = richProject();
	const real = (format: 'aaf' | 'omf') => exportTimeline(h.doc, h.seqId, format).files[0]!.bytes;
	const read = (format: 'aaf' | 'omf') => (b: Uint8Array) =>
		importTimeline(b, { format, now: NOW, rate: { num: 30, den: 1 } });
	const cases: [string, Uint8Array, boolean, (b: Uint8Array) => unknown][] = [
		['AAF', real('aaf'), true, read('aaf')],
		['OMF', real('omf'), false, read('omf')],
	];

	it.each(cases)(
		'%s: imports or fails with InterchangeError, in bounded time',
		{ timeout: 600_000 },
		(name, seed, le, run) => {
			const next = rng(0x5eed ^ seed.length);
			let slowest = 0;
			for (let i = 0; i < RUNS; i++) {
				const file = mutateFields(seed, next, le);
				const r = timed(() => run(file));
				slowest = Math.max(slowest, r.ms);
				if (r.error !== undefined && !(r.error instanceof InterchangeError))
					throw new Error(`${name}, mutation ${i}: ${(r.error as Error).stack ?? r.error}`);
				if (r.ms > LIMIT_MS) throw new Error(`${name}, mutation ${i}: took ${Math.round(r.ms)} ms`);
			}
			console.info(
				`[hostile] ${name}: ${RUNS} mutations of a ${seed.length}-byte file, slowest ${slowest.toFixed(0)} ms`,
			);
		},
	);
});
