// Spec 19 TL-115: split a picture into parts by its alpha islands (Photoshop's Layer via Cut, automated), ported from
// Pachislop src/io/imageSplit.ts (port record pachislop-interchange). Islands are labelled on a working grid of at most
// WORK_MAX cells on the long side, so a 10 240 px logo stays quick, and grouped into parts by the gap between their boxes.
// The cut runs at full resolution: every pixel with any alpha belongs to exactly one part (the part of its cell's island,
// or of the nearest island for faint pixels below the threshold), so the parts put back together are the picture again
// and no part takes another's pixels, even inside its box.
//
// Differences from the port: pixels are straight RGBA bytes copied untouched, 8- or 16-bit, never through a canvas (a
// canvas premultiplies, which loses the colour of low-alpha pixels and every glow with them); input sizes are checked.

/** Box in source-image px, half-open (x0 ≤ x < x1), top row first. */
export type PxBox = { x0: number; y0: number; x1: number; y1: number };

/** Straight RGBA, rows top first: 8 bits per channel, or 16 little-endian (`rgba64le`). */
export type SplitPicture = { width: number; height: number; depth: 8 | 16; data: Uint8Array };

/** Alpha islands of a picture on its working grid. */
export type IslandMap = {
	/** Source px. */
	width: number;
	height: number;
	/** Source px per working cell side (integer ≥ 1). */
	cell: number;
	cols: number;
	rows: number;
	/** Highest alpha (8 bits) per cell, row-major, top row first. */
	alpha: Uint8Array;
	/** Island index per cell: the island of its opaque pixels, else the nearest island (-1 only without any island). */
	owner: Int32Array;
	/** Box of each island's opaque cells (source px), in label order. */
	islands: PxBox[];
};

/** A part: the islands it is made of and their common box (source px, cell precision). */
export type ImagePart = { islands: number[]; box: PxBox };

/** Long side of the working grid, in cells. */
export const WORK_MAX = 2048;
/** Alpha (0…255) at or above which a pixel belongs to an island. */
export const ALPHA_THRESHOLD = 8;
/**
 * Default merge distance, % of the picture's long side: letters of a word (gaps around 1 %) stay one part, a logo set
 * apart from its word (2 % and more) becomes its own.
 */
export const DEFAULT_MERGE = 1.5;

const stride = (p: SplitPicture) => (p.depth === 16 ? 8 : 4);
/** Offset of the 8 most significant alpha bits in a pixel. */
const alphaByte = (p: SplitPicture) => (p.depth === 16 ? 7 : 3);

/** Label the islands of `img` (8-connected cells whose highest alpha is ≥ `threshold`). */
export function labelIslands(img: SplitPicture, threshold = ALPHA_THRESHOLD): IslandMap {
	const { width: W, height: H, data } = img;
	if (!(W > 0 && H > 0) || data.length < W * H * stride(img))
		throw new RangeError('The picture has no pixels, or fewer than its size says');
	const px = stride(img);
	const ax = alphaByte(img);
	const cell = Math.max(1, Math.ceil(Math.max(W, H) / WORK_MAX));
	const cols = Math.ceil(W / cell);
	const rows = Math.ceil(H / cell);
	const alpha = new Uint8Array(cols * rows);
	// A cell is as opaque as its most opaque pixel, so thin strokes survive the coarser grid.
	for (let y = 0; y < H; y++) {
		const row = ((y / cell) | 0) * cols;
		const base = y * W * px + ax;
		for (let cx = 0; cx < cols; cx++) {
			let m = alpha[row + cx]!;
			const end = base + Math.min(W, (cx + 1) * cell) * px;
			for (let i = base + cx * cell * px; i < end; i += px) if (data[i]! > m) m = data[i]!;
			alpha[row + cx] = m;
		}
	}

	const owner = new Int32Array(cols * rows).fill(-1);
	const islands: PxBox[] = [];
	const queue = new Int32Array(cols * rows);
	for (let start = 0; start < owner.length; start++) {
		if (owner[start]! >= 0 || alpha[start]! < threshold) continue;
		const id = islands.length;
		let x0 = cols;
		let y0 = rows;
		let x1 = -1;
		let y1 = -1;
		let head = 0;
		let tail = 0;
		owner[start] = id;
		queue[tail++] = start;
		while (head < tail) {
			const c = queue[head++]!;
			const cx = c % cols;
			const cy = (c - cx) / cols;
			if (cx < x0) x0 = cx;
			if (cx > x1) x1 = cx;
			if (cy < y0) y0 = cy;
			if (cy > y1) y1 = cy;
			for (let ny = Math.max(0, cy - 1); ny <= Math.min(rows - 1, cy + 1); ny++) {
				for (let nx = Math.max(0, cx - 1); nx <= Math.min(cols - 1, cx + 1); nx++) {
					const n = ny * cols + nx;
					if (owner[n]! >= 0 || alpha[n]! < threshold) continue;
					owner[n] = id;
					queue[tail++] = n;
				}
			}
		}
		islands.push({
			x0: x0 * cell,
			y0: y0 * cell,
			x1: Math.min(W, (x1 + 1) * cell),
			y1: Math.min(H, (y1 + 1) * cell),
		});
	}

	// Every other cell goes to the nearest island (breadth-first from all islands at once), so faint edge pixels and
	// specks below the threshold are cut with the island they belong to.
	let tail = 0;
	for (let c = 0; c < owner.length; c++) if (owner[c]! >= 0) queue[tail++] = c;
	for (let head = 0; head < tail; head++) {
		const c = queue[head]!;
		const cx = c % cols;
		const cy = (c - cx) / cols;
		const o = owner[c]!;
		for (let ny = Math.max(0, cy - 1); ny <= Math.min(rows - 1, cy + 1); ny++) {
			for (let nx = Math.max(0, cx - 1); nx <= Math.min(cols - 1, cx + 1); nx++) {
				const n = ny * cols + nx;
				if (owner[n]! >= 0) continue;
				owner[n] = o;
				queue[tail++] = n;
			}
		}
	}
	return { width: W, height: H, cell, cols, rows, alpha, owner, islands };
}

/** Distance between two boxes (0 when they touch or overlap). */
export function boxGap(a: PxBox, b: PxBox): number {
	const gx = Math.max(0, b.x0 - a.x1, a.x0 - b.x1);
	const gy = Math.max(0, b.y0 - a.y1, a.y0 - b.y1);
	return Math.hypot(gx, gy);
}

export function unionBox(boxes: readonly PxBox[]): PxBox {
	const out = { ...boxes[0]! };
	for (const b of boxes) {
		out.x0 = Math.min(out.x0, b.x0);
		out.y0 = Math.min(out.y0, b.y0);
		out.x1 = Math.max(out.x1, b.x1);
		out.y1 = Math.max(out.y1, b.y1);
	}
	return out;
}

/** Parts made of `groups` of island indices, ordered left to right (then top to bottom). */
export function partsOf(islands: readonly PxBox[], groups: readonly (readonly number[])[]): ImagePart[] {
	return groups
		.filter((g) => g.length > 0)
		.map((g) => ({ islands: [...g].sort((a, b) => a - b), box: unionBox(g.map((i) => islands[i]!)) }))
		.sort((a, b) => a.box.x0 - b.box.x0 || a.box.y0 - b.box.y0);
}

/**
 * Groups the islands whose boxes lie within `mergePct` % of the picture's long side of each other (chains join: a word's
 * letters become one part), as parts ordered left to right.
 */
export function clusterIslands(
	map: Pick<IslandMap, 'islands' | 'width' | 'height'>,
	mergePct: number,
): ImagePart[] {
	const boxes = map.islands;
	const d = (Math.max(0, Number.isFinite(mergePct) ? mergePct : 0) / 100) * Math.max(map.width, map.height);
	const root = boxes.map((_, i) => i);
	const find = (i: number): number => {
		let r = i;
		while (root[r] !== r) {
			root[r] = root[root[r]!]!;
			r = root[r]!;
		}
		return r;
	};
	const order = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.x0 - boxes[b]!.x0);
	for (let oi = 0; oi < order.length; oi++) {
		const a = boxes[order[oi]!]!;
		for (let oj = oi + 1; oj < order.length; oj++) {
			const b = boxes[order[oj]!]!;
			if (b.x0 - a.x1 > d) break;
			if (boxGap(a, b) <= d) root[find(order[oj]!)] = find(order[oi]!);
		}
	}
	const groups = new Map<number, number[]>();
	boxes.forEach((_, i) => {
		const r = find(i);
		const g = groups.get(r);
		if (g) g.push(i);
		else groups.set(r, [i]);
	});
	return partsOf(boxes, [...groups.values()]);
}

/** One cut part: its pixels (transparent outside the part) and their box in the source. */
export type CutPart = { box: PxBox; pixels: SplitPicture };

/**
 * Transparent margin a cut part keeps around its pixels (source px), and the grid of its box: the box starts on a
 * multiple of CUT_ALIGN and its size matches the picture's modulo CUT_ALIGN, so a part's mipmap levels line up with the
 * picture's and have the same odd or even sizes. Downscaled, the parts drawn where they were then render like the picture.
 */
const CUT_PAD = 16;
const CUT_ALIGN = 64;

/** The end of a box side starting at aligned `start`: at least `need`, ≡ `size` modulo CUT_ALIGN, at most `size`. */
const alignedEnd = (start: number, need: number, size: number) =>
	Math.min(size, start + Math.ceil((need - start - size) / CUT_ALIGN) * CUT_ALIGN + size);

/**
 * Cuts `parts` out of the full-resolution `img` (the picture `map` was labelled from): each part gets the pixels of its
 * islands' cells, in the box of its non-transparent pixels grown by CUT_PAD and aligned as above (within the picture).
 * A part with no visible pixel is dropped.
 */
export function cutParts(img: SplitPicture, map: IslandMap, parts: readonly ImagePart[]): CutPart[] {
	const { width: W, height: H, data, depth } = img;
	const { cell, cols, owner, alpha } = map;
	const px = stride(img);
	const ax = alphaByte(img);
	const partOf = new Int32Array(map.islands.length).fill(-1);
	parts.forEach((p, pi) => {
		for (const i of p.islands) partOf[i] = pi;
	});
	// Part of every cell (-1: none); the pixels are walked one cell-wide run at a time.
	const cellPart = new Int32Array(owner.length);
	for (let c = 0; c < owner.length; c++)
		cellPart[c] = alpha[c]! > 0 && owner[c]! >= 0 ? partOf[owner[c]!]! : -1;

	// Tight boxes of each part's non-transparent pixels (only cells with any alpha hold one).
	const boxes = parts.map((): PxBox => ({ x0: W, y0: H, x1: 0, y1: 0 }));
	for (let y = 0; y < H; y++) {
		const row = ((y / cell) | 0) * cols;
		for (let cx = 0; cx < cols; cx++) {
			const p = cellPart[row + cx]!;
			if (p < 0) continue;
			const b = boxes[p]!;
			const xEnd = Math.min(W, (cx + 1) * cell);
			for (let x = cx * cell, i = (y * W + x) * px + ax; x < xEnd; x++, i += px) {
				if (data[i] === 0 && (depth === 8 || data[i - 1] === 0)) continue;
				if (x < b.x0) b.x0 = x;
				if (x >= b.x1) b.x1 = x + 1;
				if (y < b.y0) b.y0 = y;
				if (y >= b.y1) b.y1 = y + 1;
			}
		}
	}

	const out: CutPart[] = [];
	boxes.forEach((b, p) => {
		if (b.x1 <= b.x0) return;
		b.x0 = Math.max(0, Math.floor((b.x0 - CUT_PAD) / CUT_ALIGN) * CUT_ALIGN);
		b.y0 = Math.max(0, Math.floor((b.y0 - CUT_PAD) / CUT_ALIGN) * CUT_ALIGN);
		b.x1 = alignedEnd(b.x0, b.x1 + CUT_PAD, W);
		b.y1 = alignedEnd(b.y0, b.y1 + CUT_PAD, H);
		const w = b.x1 - b.x0;
		const h = b.y1 - b.y0;
		const pixels = new Uint8Array(w * h * px);
		for (let y = b.y0; y < b.y1; y++) {
			const row = ((y / cell) | 0) * cols;
			const s = y * W;
			const d = (y - b.y0) * w - b.x0;
			for (let cx = (b.x0 / cell) | 0; cx * cell < b.x1; cx++) {
				if (cellPart[row + cx] !== p) continue;
				const x0 = Math.max(b.x0, cx * cell);
				const x1 = Math.min(b.x1, (cx + 1) * cell);
				pixels.set(data.subarray((s + x0) * px, (s + x1) * px), (d + x0) * px);
			}
		}
		out.push({ box: b, pixels: { width: w, height: h, depth, data: pixels } });
	});
	return out;
}
