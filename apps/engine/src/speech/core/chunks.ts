// VAD-chunked transcription (`chunking: "vad"`, docs/wp-notes/speech.md §11.3 "Hidden takes"). Whisper conditioned on a long window
// can write a phrase said twice back to back only once; short chunks decoded independently, without the previous
// text, write each take. The audio is split at short pauses into chunks of a few seconds — long enough for names
// ("Sokol", "RmlUi"), which too-short chunks get wrong — and decoded twice: once with chunk boundaries at pauses, once
// with boundaries at other pauses (about the middle of the first pass's chunks), so a take that a boundary cut in the
// first pass lies inside a chunk of the second. The passes are merged around each first-pass boundary.
//
// - Pauses: runs of at least `CHUNK_PAUSE_FRAMES` (100 ms) unvoiced frames between voice.
// - Chunks: consecutive voice joined while the chunk stays within `CHUNK_MAX_FRAMES` (10 s); a chunk shorter than
//   `CHUNK_MIN_FRAMES` (3 s) takes the next voice even past 10 s (up to one 30 s Whisper window); a silence of at least
//   `CHUNK_SILENCE_FRAMES` (2 s) always ends a chunk. Boundaries lie in the middle of the pause they split at; across a
//   long silence a chunk keeps `CHUNK_EDGE_FRAMES` (0.2 s) of it on each side.
// - Shifted pass: one boundary per first-pass chunk, at its interior pause closest to its middle; long silences stay
//   boundaries (nothing is said across them).
// - Merge: around each first-pass boundary `c` that lies inside a shifted chunk, the words whose midpoint lies within
//   `CHUNK_ZONE_FRAMES` (1.5 s) of `c` (and inside that shifted chunk, and nearer `c` than the neighbouring boundaries)
//   come from the shifted pass when it has at least as many there — its words at `c` are whole, the first pass's were
//   cut by the chunk edge — else from the first pass. Chunks of one pass never overlap, so no word is written twice.
//
// Frames are 10 ms.

/** Unvoiced frames (100 ms) that make a pause a chunk may split at. */
export const CHUNK_PAUSE_FRAMES = 10;
/** A chunk ends at a pause before it grows past this (10 s)… */
export const CHUNK_MAX_FRAMES = 1000;
/** … unless it is shorter than this (3 s). */
export const CHUNK_MIN_FRAMES = 300;
/** Never longer than one Whisper window (30 s) when it can split. */
export const CHUNK_HARD_MAX_FRAMES = 3000;
/** A silence this long (2 s) always ends a chunk. */
export const CHUNK_SILENCE_FRAMES = 200;
/** Silence a chunk keeps at a long silence (0.2 s). */
export const CHUNK_EDGE_FRAMES = 20;
/** Half-width (1.5 s) of the merge zone around a first-pass boundary. */
export const CHUNK_ZONE_FRAMES = 150;

export type Chunk = { start: number; end: number };

/**
 * Voiced runs of `mask` within `range` separated by pauses of at least `CHUNK_PAUSE_FRAMES` (frames `[start, end)`).
 */
function voiceRuns(mask: ArrayLike<number>, range: Chunk): Chunk[] {
	const runs: Chunk[] = [];
	let f = Math.max(0, range.start);
	const n = Math.min(mask.length, range.end);
	while (f < n) {
		while (f < n && !(mask[f]! > 0)) f++;
		if (f >= n) break;
		const start = f;
		let last = f;
		let silent = 0;
		for (; f < n; f++) {
			if (mask[f]! > 0) {
				last = f;
				silent = 0;
			} else if (++silent >= CHUNK_PAUSE_FRAMES) break;
		}
		runs.push({ start, end: last + 1 });
	}
	return runs;
}

/** Splits the runs into groups (index ranges) at long silences. */
function bySilence(runs: readonly Chunk[]): Array<[number, number]> {
	const groups: Array<[number, number]> = [];
	let a = 0;
	for (let i = 1; i <= runs.length; i++)
		if (i === runs.length || runs[i]!.start - runs[i - 1]!.end >= CHUNK_SILENCE_FRAMES) {
			if (i > a) groups.push([a, i]);
			a = i;
		}
	return groups;
}

/**
 * Frame bounds of the chunk of runs `[a, b)` of a group `[g0, g1)`: pause middles inside, edges at long silences
 * (within `range`).
 */
function bounds(runs: readonly Chunk[], a: number, b: number, g0: number, g1: number, range: Chunk): Chunk {
	const start =
		a === g0
			? Math.max(range.start, runs[a]!.start - CHUNK_EDGE_FRAMES)
			: (runs[a - 1]!.end + runs[a]!.start) >> 1;
	const end =
		b === g1
			? Math.min(range.end, runs[b - 1]!.end + CHUNK_EDGE_FRAMES)
			: (runs[b - 1]!.end + runs[b]!.start) >> 1;
	return { start, end };
}

/** The first-pass chunks of `mask` within `range` (default all; see the module docs), in time order. */
export function vadChunks(mask: ArrayLike<number>, range: Chunk = { start: 0, end: mask.length }): Chunk[] {
	const runs = voiceRuns(mask, range);
	const out: Chunk[] = [];
	for (const [g0, g1] of bySilence(runs)) {
		let a = g0;
		for (let i = g0 + 1; i < g1; i++) {
			const len = runs[i - 1]!.end - runs[a]!.start;
			const grown = runs[i]!.end - runs[a]!.start;
			if ((grown > CHUNK_MAX_FRAMES && len >= CHUNK_MIN_FRAMES) || grown > CHUNK_HARD_MAX_FRAMES) {
				out.push(bounds(runs, a, i, g0, g1, range));
				a = i;
			}
		}
		out.push(bounds(runs, a, g1, g0, g1, range));
	}
	return out;
}

/**
 * The shifted chunks within `range` (default all): boundaries at the interior pause of each first-pass chunk closest
 * to its middle, plus the long silences (see the module docs), in time order.
 */
export function shiftedChunks(
	mask: ArrayLike<number>,
	first: readonly Chunk[],
	range: Chunk = { start: 0, end: mask.length },
): Chunk[] {
	const runs = voiceRuns(mask, range);
	const out: Chunk[] = [];
	for (const [g0, g1] of bySilence(runs)) {
		const gStart = runs[g0]!.start;
		const gEnd = runs[g1 - 1]!.end;
		// cut indices i (between run i − 1 and run i) nearest the middle of each first-pass chunk of this group
		const cuts: number[] = [];
		for (const c of first) {
			if (c.end <= gStart || c.start >= gEnd) continue;
			const middle = (c.start + c.end) / 2;
			let best = -1;
			for (let i = g0 + 1; i < g1; i++) {
				const p = (runs[i - 1]!.end + runs[i]!.start) / 2;
				if (p <= c.start || p >= c.end) continue;
				if (
					best < 0 ||
					Math.abs(p - middle) < Math.abs((runs[best - 1]!.end + runs[best]!.start) / 2 - middle)
				)
					best = i;
			}
			if (best > 0 && !cuts.includes(best)) cuts.push(best);
		}
		cuts.sort((x, y) => x - y);
		let a = g0;
		for (const i of cuts) {
			out.push(bounds(runs, a, i, g0, g1, range));
			a = i;
		}
		out.push(bounds(runs, a, g1, g0, g1, range));
	}
	return out;
}

/**
 * The merge zones (frames): around each first-pass boundary that lies strictly inside a shifted chunk, within
 * `CHUNK_ZONE_FRAMES`, that shifted chunk and halfway to the neighbouring first-pass boundaries.
 */
export function mergeZones(first: readonly Chunk[], shifted: readonly Chunk[]): Chunk[] {
	const cuts: number[] = [];
	for (let k = 1; k < first.length; k++)
		if (first[k]!.start === first[k - 1]!.end) cuts.push(first[k]!.start);
	const zones: Chunk[] = [];
	for (let k = 0; k < cuts.length; k++) {
		const c = cuts[k]!;
		const s = shifted.find((x) => x.start < c && c < x.end);
		if (!s) continue;
		const lo = Math.max(c - CHUNK_ZONE_FRAMES, s.start, k > 0 ? (cuts[k - 1]! + c) >> 1 : 0);
		const hi = Math.min(
			c + CHUNK_ZONE_FRAMES,
			s.end,
			k + 1 < cuts.length ? (c + cuts[k + 1]!) >> 1 : Number.POSITIVE_INFINITY,
		);
		if (hi > lo) zones.push({ start: lo, end: hi });
	}
	return zones;
}
