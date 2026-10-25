// Golden-frame testing: difference metrics, tolerances, reference PNGs, fingerprints and pins.
//
// A golden test renders a frame and calls `expectGolden(<committed PNG>, frame, tolerance)`. On mismatch the actual
// frame and a ×8 difference image go to `test-results/golden-failures/<name>.{actual,diff,expected}.png` for
// inspection. `JASPER_BLESS=1` (re)writes the references instead of comparing; a reference must stay under
// `MAX_GOLDEN_BYTES` (render smaller scenes otherwise). Fingerprints (`expectFingerprints`, a 4×4 mean-RGB grid per
// case) and exact pins (`expectPins`) are the compact forms for large case matrices. See docs/testing.md.
//
// Ported from FilmCraft's `crates/testkit/src/golden.rs` (MIT OR Apache-2.0; licenses/ported/golden-fuzz.md).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { envFlag, repoRoot, testResultsDir } from './env.ts';
import { meanGrid, type Rgba8, rgba8 } from './image.ts';
import { decodePng, encodePng } from './png.ts';

/** Size limit of a committed golden PNG. */
export const MAX_GOLDEN_BYTES = 50 * 1024;

/** Per-pixel difference statistics over all four channels (8-bit levels). */
export type Diff = {
	/** Largest absolute channel difference. */
	maxAbs: number;
	/** Mean absolute channel difference. */
	meanAbs: number;
	/** 99th percentile of the per-pixel maximum channel difference. */
	p99: number;
	/** PSNR in dB over all channels (`Infinity` when identical). */
	psnr: number;
	/** Pixels with any channel different. */
	differing: number;
};

export function formatDiff(d: Diff): string {
	return `PSNR ${d.psnr === Number.POSITIVE_INFINITY ? '∞' : d.psnr.toFixed(2)} dB, max ${d.maxAbs}, p99 ${d.p99}, mean ${d.meanAbs.toFixed(3)}, ${d.differing} pixels differ`;
}

/** Compares two images of equal size. Throws a RangeError on a size mismatch. */
export function diffImages(a: Rgba8, b: Rgba8): Diff {
	if (a.width !== b.width || a.height !== b.height)
		throw new RangeError(`size ${a.width}×${a.height} vs ${b.width}×${b.height}`);
	const hist = new Uint32Array(256);
	let sum = 0;
	let sq = 0;
	let max = 0;
	let differing = 0;
	for (let i = 0; i < a.data.length; i += 4) {
		let m = 0;
		for (let k = 0; k < 4; k++) {
			const d = Math.abs(a.data[i + k]! - b.data[i + k]!);
			sum += d;
			sq += d * d;
			if (d > m) m = d;
		}
		hist[m] = hist[m]! + 1;
		if (m > max) max = m;
		if (m > 0) differing++;
	}
	const pixels = Math.max(1, a.width * a.height);
	const target = Math.ceil((pixels * 99) / 100);
	let acc = 0;
	let p99 = 0;
	for (let v = 0; v < 256; v++) {
		acc += hist[v]!;
		if (acc >= target) {
			p99 = v;
			break;
		}
	}
	const n = pixels * 4;
	const mse = sq / n;
	return {
		maxAbs: max,
		meanAbs: sum / n,
		p99,
		psnr: mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse),
		differing,
	};
}

/** Acceptance thresholds; every limit must hold. */
export type Tolerance = { minPsnr: number; maxAbs: number; p99: number };

export const Tolerance = {
	/** Bit-exact. */
	EXACT: { minPsnr: Number.POSITIVE_INFINITY, maxAbs: 0, p99: 0 } satisfies Tolerance,
	/**
	 * CPU renders against CPU-made references (FilmCraft's default): absorbs float differences between platforms but
	 * not real changes.
	 */
	RENDER: { minPsnr: 45, maxAbs: 12, p99: 2 } satisfies Tolerance,
	/**
	 * WebGL2 (ANGLE/SwiftShader or a GPU) against references made in headless Chrome: shader float precision, texture
	 * filtering and rasteriser differences between Chrome/ANGLE versions and GPUs. Real changes (a parameter, a missed
	 * pass, a skipped pixel) move far more than this.
	 */
	GL: { minPsnr: 40, maxAbs: 24, p99: 3 } satisfies Tolerance,
	/**
	 * Whole Chrome pages (Remotion stills: DOM compositing, CSS transforms, text rasterisation): antialiased edges and
	 * glyph hinting move a few levels on edge pixels between Chrome versions.
	 */
	BROWSER: { minPsnr: 36, maxAbs: 64, p99: 6 } satisfies Tolerance,
	accepts(t: Tolerance, d: Diff): boolean {
		return d.psnr >= t.minPsnr && d.maxAbs <= t.maxAbs && d.p99 <= t.p99;
	},
	format(t: Tolerance): string {
		return `PSNR ≥ ${t.minPsnr} dB, max ≤ ${t.maxAbs}, p99 ≤ ${t.p99}`;
	},
};

/** Whether `JASPER_BLESS` asks to (re)write references instead of comparing. */
export function blessing(): boolean {
	return envFlag('JASPER_BLESS');
}

/** Where failing comparisons write `<name>.actual.png`, `<name>.diff.png` and `<name>.expected.png`. */
export function failuresDir(): string {
	return testResultsDir('golden-failures');
}

/** Difference image: |a − b| per channel ×8 (alpha differences show in every channel), opaque. */
export function diffImage(a: Rgba8, b: Rgba8): Rgba8 {
	const out = rgba8(a.width, a.height);
	for (let i = 0; i < a.data.length; i += 4) {
		const al = Math.min(255, Math.abs(a.data[i + 3]! - b.data[i + 3]!) * 8);
		for (let k = 0; k < 3; k++)
			out.data[i + k] = Math.max(al, Math.min(255, Math.abs(a.data[i + k]! - b.data[i + k]!) * 8));
		out.data[i + 3] = 255;
	}
	return out;
}

export function readPng(path: string): Rgba8 {
	return decodePng(readFileSync(path));
}

/** Writes a PNG (creating directories); returns its size in bytes. */
export function writePng(path: string, img: Rgba8): number {
	const bytes = encodePng(img);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
	return bytes.length;
}

/** A golden comparison that failed (the message has the metrics and where the actual/diff images went). */
export class GoldenMismatch extends Error {
	override readonly name = 'GoldenMismatch';
	constructor(
		message: string,
		readonly diff?: Diff,
	) {
		super(message);
	}
}

const rel = (p: string) => {
	const r = relative(repoRoot(), p);
	return !r || r.startsWith('..') || isAbsolute(r) ? p : r;
};
const stem = (p: string) => basename(p).replace(/\.png$/i, '');

export type GoldenOptions = {
	/** Name for the failure artefacts (default: the golden's file name without `.png`). */
	name?: string;
	/** Size cap on bless (default `MAX_GOLDEN_BYTES`). */
	maxBytes?: number;
};

/**
 * Compares `actual` with the golden PNG at `golden` (or blesses it with `JASPER_BLESS=1`). Returns the difference;
 * throws `GoldenMismatch` when the tolerance is exceeded, the golden is missing, or a blessed PNG is too large.
 */
export function checkGolden(golden: string, actual: Rgba8, tol: Tolerance, opts: GoldenOptions = {}): Diff {
	const name = opts.name ?? stem(golden);
	const cap = opts.maxBytes ?? MAX_GOLDEN_BYTES;
	if (blessing()) {
		const bytes = encodePng(actual);
		const size = bytes.length;
		if (size > cap)
			throw new GoldenMismatch(
				`${rel(golden)}: ${size} bytes exceeds the ${cap}-byte golden limit; render a smaller or simpler scene`,
			);
		const before = existsSync(golden) ? readFileSync(golden) : undefined;
		if (!before?.equals(bytes)) {
			mkdirSync(dirname(golden), { recursive: true });
			writeFileSync(golden, bytes);
			console.info(`blessed ${rel(golden)} (${size} bytes)`);
		}
		return { maxAbs: 0, meanAbs: 0, p99: 0, psnr: Number.POSITIVE_INFINITY, differing: 0 };
	}
	if (!existsSync(golden))
		throw new GoldenMismatch(
			`${rel(golden)}: missing golden; generate it with JASPER_BLESS=1 and review the PNG`,
		);
	const expected = readPng(golden);
	if (expected.width !== actual.width || expected.height !== actual.height) {
		writePng(join(failuresDir(), `${name}.actual.png`), actual);
		throw new GoldenMismatch(
			`${rel(golden)}: size ${actual.width}×${actual.height}, golden is ${expected.width}×${expected.height}; actual written to ${rel(failuresDir())}`,
		);
	}
	const d = diffImages(expected, actual);
	if (Tolerance.accepts(tol, d)) return d;
	const dir = failuresDir();
	writePng(join(dir, `${name}.actual.png`), actual);
	writePng(join(dir, `${name}.expected.png`), expected);
	writePng(join(dir, `${name}.diff.png`), diffImage(expected, actual));
	throw new GoldenMismatch(
		`${rel(golden)}: ${formatDiff(d)} (tolerance: ${Tolerance.format(tol)}); actual, expected and ×8 diff written to ${rel(dir)}/${name}.*.png`,
		d,
	);
}

/** `checkGolden` for tests (same behaviour; the name reads better in `it` bodies). */
export const expectGolden = checkGolden;

function readJsonRecord<T>(file: string): Record<string, T> {
	if (!existsSync(file)) return {};
	return JSON.parse(readFileSync(file, 'utf8')) as Record<string, T>;
}

/** One entry per line, keys sorted: reviewable diffs when re-blessed. */
function writeJsonRecord<T>(file: string, rec: Record<string, T>): void {
	const keys = Object.keys(rec).sort();
	const body = keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(rec[k])}`).join(',\n');
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `{\n${body}\n}\n`);
}

export type RecordOptions = {
	/**
	 * The run produced every case of the file: on bless, entries not produced are dropped; when comparing, they are
	 * reported as stale. Leave false when a run covers only part of the file (e.g. one family per test).
	 */
	complete?: boolean;
};

function checkRecord<T>(
	file: string,
	got: Record<string, T>,
	same: (want: T, got: T) => string | undefined,
	opts: RecordOptions,
): void {
	const stored = readJsonRecord<T>(file);
	if (blessing()) {
		const next = opts.complete ? { ...got } : { ...stored, ...got };
		const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
		writeJsonRecord(file, next);
		if (readFileSync(file, 'utf8') !== before) console.info(`blessed ${rel(file)}`);
		return;
	}
	const problems: string[] = [];
	for (const [k, v] of Object.entries(got)) {
		if (!(k in stored)) {
			problems.push(`${k}: not in ${rel(file)} (bless with JASPER_BLESS=1)`);
			continue;
		}
		const why = same(stored[k]!, v);
		if (why) problems.push(`${k}: ${why}`);
	}
	if (opts.complete) for (const k of Object.keys(stored)) if (!(k in got)) problems.push(`${k}: stale entry`);
	if (problems.length) {
		const out = join(failuresDir(), `${basename(file).replace(/\.json$/, '')}.actual.json`);
		writeJsonRecord(out, { ...stored, ...got });
		throw new GoldenMismatch(
			`${rel(file)}: ${problems.length} case(s) differ (actual record written to ${rel(out)}):\n  ${problems.join('\n  ')}`,
		);
	}
}

/** The fingerprint of a frame: its 4×4 mean-RGB grid (48 numbers). */
export function fingerprint(img: Rgba8, n = 4): number[] {
	return meanGrid(img, n);
}

/**
 * Compares fingerprints (`fingerprint(frame)` per case) with the JSON record at `file`; every grid cell channel must
 * be within `tolerance` levels (FilmCraft's transition fingerprints use ±4). Blesses with `JASPER_BLESS=1`.
 */
export function expectFingerprints(
	file: string,
	got: Record<string, number[]>,
	tolerance = 4,
	opts: RecordOptions = {},
): void {
	checkRecord<number[]>(
		file,
		got,
		(want, have) => {
			if (want.length !== have.length) return `length ${have.length}, recorded ${want.length}`;
			let worst = 0;
			let at = 0;
			for (let i = 0; i < want.length; i++) {
				const d = Math.abs(want[i]! - have[i]!);
				if (!(d <= worst)) {
					worst = Number.isNaN(d) ? Number.POSITIVE_INFINITY : d;
					at = i;
				}
			}
			return worst > tolerance
				? `cell ${Math.floor(at / 3)} channel ${'RGB'[at % 3]} off by ${worst.toFixed(1)} (> ${tolerance})`
				: undefined;
		},
		opts,
	);
}

/** Exact pins (checksums, counts, strings) per case in the JSON record at `file`. Blesses with `JASPER_BLESS=1`. */
export function expectPins(
	file: string,
	got: Record<string, number | string | boolean>,
	opts: RecordOptions = {},
): void {
	checkRecord(file, got, (want, have) => (want === have ? undefined : `${have}, pinned ${want}`), opts);
}
