// Image sequences (imports workstream): numbered stills (`shot_0001.exr`, `frame12.png`) grouped into sequences —
// Premiere's Import ▸ Image Sequence. The number is the last run of digits before the extension; files group when
// their prefix, extension and (for zero-padded numbers) digit count agree. Pure; bounded.

export type FrameName = {
	name: string;
	prefix: string;
	/** Extension with its dot, lower-case (`.exr`). */
	ext: string;
	number: number;
	digits: number;
};

export type ImageSequenceGroup = {
	prefix: string;
	ext: string;
	/** Digit count when the numbers are zero-padded to a fixed width, else 0. */
	padding: number;
	/** The frames found, sorted by number (duplicates removed). */
	frames: { number: number; name: string }[];
	first: number;
	last: number;
	/** Numbers missing inside [first, last] (at most `MAX_MISSING_LISTED` listed). */
	missing: number[];
	/** Count of missing numbers (all of them). */
	missingCount: number;
	/** Display pattern, e.g. `shot_[0001-0120].exr`. */
	label: string;
	/** ffmpeg-style pattern with `#` per padded digit, e.g. `shot_####.exr`. */
	pattern: string;
};

/** Still extensions a sequence may be made of (ffmpeg-decodable stills). */
export const SEQUENCE_EXTENSIONS: ReadonlySet<string> = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.tif',
	'.tiff',
	'.exr',
	'.dpx',
	'.tga',
	'.bmp',
	'.webp',
	'.hdr',
	'.jxl',
	'.psd',
	'.sgi',
	'.rgb',
	'.pcx',
	'.qoi',
	'.ppm',
	'.pgm',
	'.pbm',
	'.pam',
	'.jp2',
	'.j2k',
	'.heic',
	'.heif',
	'.avif',
	'.cin',
]);

/** Largest number a frame may carry (keeps ranges and `missing` bounded). */
export const MAX_FRAME_NUMBER = 99_999_999;
/** Largest range (last − first + 1) a sequence may span. */
export const MAX_SEQUENCE_FRAMES = 1_000_000;
export const MAX_MISSING_LISTED = 10_000;

const FRAME_RE = /^(.*?)(\d+)(\.[A-Za-z0-9]{1,8})$/;

/** The frame number of a file name (last digit run before the extension), or null. */
export function parseFrameName(name: string): FrameName | null {
	const base = name.split(/[\\/]/).pop() ?? name;
	const m = FRAME_RE.exec(base);
	if (!m) return null;
	const ext = m[3]!.toLowerCase();
	if (!SEQUENCE_EXTENSIONS.has(ext)) return null;
	const digits = m[2]!;
	if (digits.length > 9) return null;
	const number = Number(digits);
	if (!Number.isSafeInteger(number) || number > MAX_FRAME_NUMBER) return null;
	return { name: base, prefix: m[1]!, ext, number, digits: digits.length };
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

function finish(prefix: string, ext: string, padding: number, frames: FrameName[]): ImageSequenceGroup | null {
	const byNumber = new Map<number, string>();
	for (const f of frames) if (!byNumber.has(f.number)) byNumber.set(f.number, f.name);
	const sorted = [...byNumber.entries()].sort((a, b) => a[0] - b[0]).map(([number, name]) => ({ number, name }));
	if (sorted.length < 2) return null;
	const first = sorted[0]!.number;
	const last = sorted[sorted.length - 1]!.number;
	if (last - first + 1 > MAX_SEQUENCE_FRAMES) return null;
	const missing: number[] = [];
	let missingCount = 0;
	let k = 0;
	for (let n = first; n <= last; n++) {
		if (sorted[k]?.number === n) {
			k++;
			continue;
		}
		missingCount++;
		if (missing.length < MAX_MISSING_LISTED) missing.push(n);
	}
	const w = padding;
	return {
		prefix,
		ext,
		padding,
		frames: sorted,
		first,
		last,
		missing,
		missingCount,
		label: `${prefix}[${pad(first, w)}-${pad(last, w)}]${ext}`,
		pattern: `${prefix}${'#'.repeat(Math.max(1, w || String(last).length))}${ext}`,
	};
}

/**
 * Groups file names into image sequences (≥ 2 frames) and the files that belong to none. A zero-padded sequence
 * (`0001`…`0120`) and an unpadded one (`1`…`120`) with the same prefix are different sequences, as in Premiere.
 */
export function groupImageSequences(names: readonly string[]): {
	sequences: ImageSequenceGroup[];
	singles: string[];
} {
	const groups = new Map<string, FrameName[]>();
	const singles: string[] = [];
	for (const n of names.slice(0, MAX_SEQUENCE_FRAMES)) {
		const f = parseFrameName(n);
		if (!f) {
			singles.push(n);
			continue;
		}
		// Padded when the digit run starts with 0 or every member has the same width (decided per group below).
		const key = `${f.prefix}\u0000${f.ext}`;
		const list = groups.get(key);
		if (list) list.push(f);
		else groups.set(key, [f]);
	}
	const sequences: ImageSequenceGroup[] = [];
	for (const list of groups.values()) {
		const f0 = list[0]!;
		// Split by padding: widths that a padded counter would print, else unpadded.
		const widths = new Set(list.map((f) => f.digits));
		const padded = list.some((f) => f.digits > String(f.number).length);
		if (padded && widths.size > 1) {
			// `0099` and `0100` share a width; numbers wider than the padding (`10000` after `9999`) still fit.
			const w = Math.min(...list.filter((f) => f.digits > String(f.number).length).map((f) => f.digits));
			const inside = list.filter((f) => f.digits === w || (f.digits > w && String(f.number).length === f.digits));
			const outside = list.filter((f) => !inside.includes(f));
			const g = finish(f0.prefix, f0.ext, w, inside);
			if (g) sequences.push(g);
			else singles.push(...inside.map((f) => f.name));
			const rest = finish(f0.prefix, f0.ext, 0, outside);
			if (rest) sequences.push(rest);
			else singles.push(...outside.map((f) => f.name));
			continue;
		}
		const g = finish(f0.prefix, f0.ext, padded ? f0.digits : 0, list);
		if (g) sequences.push(g);
		else singles.push(...list.map((f) => f.name));
	}
	sequences.sort((a, b) => a.label.localeCompare(b.label));
	return { sequences, singles };
}

/**
 * The frames of a sequence in clip order: for every number from `first` to `last`, the file shown — the frame with
 * that number, or the last one before it where numbers are missing (the gap holds the previous frame).
 */
export function sequenceFrameFiles(g: Pick<ImageSequenceGroup, 'frames' | 'first' | 'last'>): string[] {
	const out: string[] = [];
	let k = 0;
	let current = g.frames[0]?.name ?? '';
	for (let n = g.first; n <= g.last; n++) {
		while (k < g.frames.length && g.frames[k]!.number <= n) current = g.frames[k++]!.name;
		out.push(current);
	}
	return out;
}
