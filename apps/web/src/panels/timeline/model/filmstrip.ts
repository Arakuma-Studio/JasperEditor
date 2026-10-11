// Filmstrip slots from the engine sprite contract (S04:TH-002/003, S02:TL-327…329, TL-102).
// Slots sit on quantized source times so adjacent zoom levels and clips cut from the same asset share
// requested frames; positions derive from exact time so thumbnails never drift from the clip edges.
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '@jasper/project';

type SpriteTile = { sheet: number; index: number; timeSec: number };
type SpriteIndexLike = { tileWidth: number; tileHeight: number; columns: number; tiles: SpriteTile[] };

/** TH-003: the tile at or before `timeSec` (tiles sorted by time), or the first tile. */
export function nearestTile(index: SpriteIndexLike, timeSec: number): SpriteTile | null {
	const tiles = index.tiles;
	if (tiles.length === 0) return null;
	let lo = 0;
	let hi = tiles.length - 1;
	if (timeSec < tiles[0]!.timeSec) return tiles[0]!;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (tiles[mid]!.timeSec <= timeSec + 1e-9) lo = mid;
		else hi = mid - 1;
	}
	return tiles[lo]!;
}

/** Source rectangle of a tile inside its sheet image. */
export function tileRect(index: SpriteIndexLike, tile: SpriteTile) {
	return {
		sx: (tile.index % index.columns) * index.tileWidth,
		sy: Math.floor(tile.index / index.columns) * index.tileHeight,
		sw: index.tileWidth,
		sh: index.tileHeight,
	};
}

type Slot = {
	/** Clip-area x (viewport px, unrounded) and width of the slot. */
	x: number;
	w: number;
	/** Source time shown by the slot (seconds). */
	timeSec: number;
};

type SlotInput = {
	/** Clip placement. */
	start: number;
	duration: number;
	sourceIn: number;
	rate: number;
	reverse: boolean;
	/** Viewport. */
	scrollFrame: number;
	pxPerFrame: number;
	/** Visible clip-area x range to fill (plus overscan). */
	visibleX0: number;
	visibleX1: number;
	/** Slot width = thumbnail height × aspect (TL-328 step 1). */
	slotWidth: number;
	fps: Rational;
	/** Source frame duration of the asset in flicks (ladder base); defaults to one sequence frame. */
	sourceFrameFlicks?: number;
	style?: 'continuous' | 'head' | 'head-tail';
};

/**
 * TL-328 continuous algorithm: σ = source span of one slot; q = smallest ladder step (source frame × 2^k)
 * ≥ σ; slots are placed at source multiples of q within the clip, clipped to the visible range.
 */
export function filmstripSlots(i: SlotInput): Slot[] {
	const F = flicksPerFrame(i.fps);
	const perFrame = F * i.rate; // content flicks per sequence frame
	const clipX0 = (i.start - i.scrollFrame) * i.pxPerFrame;
	const clipX1 = clipX0 + i.duration * i.pxPerFrame;
	const x0 = Math.max(clipX0, i.visibleX0);
	const x1 = Math.min(clipX1, i.visibleX1);
	if (x1 <= x0 || i.slotWidth <= 0) return [];
	const xOf = (t: number) => {
		const frames = (t - i.sourceIn) / perFrame;
		return i.reverse ? clipX1 - frames * i.pxPerFrame : clipX0 + frames * i.pxPerFrame;
	};
	const timeAtX = (x: number) => {
		const frames = (i.reverse ? clipX1 - x : x - clipX0) / i.pxPerFrame;
		return i.sourceIn + frames * perFrame;
	};
	if (i.style === 'head' || i.style === 'head-tail') {
		const out: Slot[] = [];
		const headW = Math.min(i.slotWidth, clipX1 - clipX0);
		if (clipX0 + headW > i.visibleX0 && clipX0 < i.visibleX1)
			out.push({ x: clipX0, w: headW, timeSec: timeAtX(i.reverse ? clipX1 : clipX0) / FLICKS_PER_SECOND });
		if (i.style === 'head-tail' && clipX1 - clipX0 > 2 * i.slotWidth) {
			const tx = clipX1 - i.slotWidth;
			if (tx < i.visibleX1 && clipX1 > i.visibleX0)
				out.push({
					x: tx,
					w: i.slotWidth,
					timeSec: timeAtX(i.reverse ? clipX0 + 1e-6 : clipX1 - 1e-6) / FLICKS_PER_SECOND,
				});
		}
		return out;
	}
	const base = i.sourceFrameFlicks ?? F;
	const sigma = (i.slotWidth / i.pxPerFrame) * perFrame;
	let q = base;
	while (q < sigma) q *= 2;
	const slotW = (q / perFrame) * i.pxPerFrame;
	const tA = Math.min(timeAtX(x0), timeAtX(x1));
	const tB = Math.max(timeAtX(x0), timeAtX(x1));
	const out: Slot[] = [];
	for (let k = Math.floor(tA / q); k * q < tB; k++) {
		const t = k * q;
		const xs = xOf(t);
		const x = i.reverse ? xs - slotW : xs;
		if (x + slotW <= x0 || x >= x1) continue;
		// The frame shown is the source time at the slot middle (TL-328 step 4).
		out.push({ x, w: slotW, timeSec: (t + q / 2) / FLICKS_PER_SECOND });
		if (out.length > 4096) break;
	}
	return out;
}

/**
 * Slots of a clip whose media time is not linear (Time Remapping, frame holds): one slot per
 * thumbnail width from the clip start, each showing the media time at its centre frame (`mediaSecondsAt`).
 */
export function mappedFilmstripSlots(i: {
	start: number;
	duration: number;
	scrollFrame: number;
	pxPerFrame: number;
	visibleX0: number;
	visibleX1: number;
	slotWidth: number;
	mediaSecondsAt(frame: number): number;
}): Slot[] {
	const clipX0 = (i.start - i.scrollFrame) * i.pxPerFrame;
	const clipX1 = clipX0 + i.duration * i.pxPerFrame;
	const x0 = Math.max(clipX0, i.visibleX0);
	const x1 = Math.min(clipX1, i.visibleX1);
	if (x1 <= x0 || i.slotWidth <= 0) return [];
	const out: Slot[] = [];
	const k0 = Math.floor((x0 - clipX0) / i.slotWidth);
	for (let k = k0; clipX0 + k * i.slotWidth < x1; k++) {
		const x = clipX0 + k * i.slotWidth;
		const mid = Math.min(clipX1 - 1e-6, x + i.slotWidth / 2);
		const frame = i.start + Math.min(i.duration - 1, Math.max(0, Math.floor((mid - clipX0) / i.pxPerFrame)));
		out.push({ x, w: i.slotWidth, timeSec: i.mediaSecondsAt(frame) });
	}
	return out;
}
