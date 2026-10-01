// Vertical layout of the split video/audio regions (S02 §3.5: TL-114…116, TL-261…263; S05:TLC-006/007).
// The video region is bottom-aligned (V1 sits on the divider, tracks grow upward); the audio region is
// top-aligned (A1 under the divider, tracks grow downward). Each region scrolls on its own.

const DIVIDER_PX = 4;
const MASTER_ROW_PX = 28;
const TRACK_MIN_PX = 20;
const TRACK_MAX_PX = 240;
export const DEFAULT_VIDEO_PX = 32;
export const DEFAULT_AUDIO_PX = 40;
/** TL-263 height steps. */
const HEIGHT_STEPS = [20, 32, 48, 72, 108, 160, 240] as const;

export type RegionKind = 'video' | 'audio';

export type TrackRow = {
	trackId: string;
	kind: RegionKind;
	/** Index within its kind (0 = V1 / A1). */
	index: number;
	/** Top edge in track-area coordinates (after region scroll). */
	y: number;
	height: number;
};

export type RegionLayout = {
	kind: RegionKind;
	/** Region top in track-area coordinates and visible height. */
	top: number;
	height: number;
	maxScroll: number;
	rows: TrackRow[];
};

export type TrackAreaLayout = {
	height: number;
	video: RegionLayout;
	audio: RegionLayout;
	dividerTop: number;
	/** Y of the master row (header only) in track-area coordinates, or null when hidden. */
	masterY: number | null;
};

export const clampHeight = (h: number) => Math.min(TRACK_MAX_PX, Math.max(TRACK_MIN_PX, Math.round(h)));

export function trackHeight(
	heights: Readonly<Record<string, number>>,
	trackId: string,
	kind: RegionKind,
): number {
	return clampHeight(heights[trackId] ?? (kind === 'video' ? DEFAULT_VIDEO_PX : DEFAULT_AUDIO_PX));
}

/** Next/previous step on the TL-263 ladder. */
export function stepHeight(h: number, dir: 1 | -1): number {
	if (dir > 0) return HEIGHT_STEPS.find((s) => s > h) ?? TRACK_MAX_PX;
	return [...HEIGHT_STEPS].reverse().find((s) => s < h) ?? TRACK_MIN_PX;
}

export function computeLayout(opts: {
	height: number;
	dividerRatio: number;
	videoTracks: readonly { id: string }[];
	audioTracks: readonly { id: string }[];
	heights: Readonly<Record<string, number>>;
	scrollYVideo: number;
	scrollYAudio: number;
	showMaster?: boolean;
}): TrackAreaLayout {
	const avail = Math.max(0, opts.height - DIVIDER_PX);
	const ratio = Math.min(0.9, Math.max(0.1, opts.dividerRatio));
	const vh = Math.round(avail * ratio);
	const ah = avail - vh;
	const dividerTop = vh;
	const audioTop = vh + DIVIDER_PX;

	// Video: rows stack upward from the divider. Content coordinates measured from the content top.
	const vHeights = opts.videoTracks.map((t) => trackHeight(opts.heights, t.id, 'video'));
	const vContent = vHeights.reduce((a, b) => a + b, 0);
	const vMax = Math.max(0, vContent - vh);
	const vScroll = Math.min(vMax, Math.max(0, opts.scrollYVideo));
	// scrollYVideo = px scrolled up from the bottom; bottom-aligned when content is shorter.
	const vOffset = vh - vContent + vScroll;
	const videoRows: TrackRow[] = [];
	let acc = 0;
	for (let i = opts.videoTracks.length - 1; i >= 0; i--) {
		const h = vHeights[i]!;
		videoRows.push({
			trackId: opts.videoTracks[i]!.id,
			kind: 'video',
			index: i,
			y: vOffset + acc,
			height: h,
		});
		acc += h;
	}

	const aHeights = opts.audioTracks.map((t) => trackHeight(opts.heights, t.id, 'audio'));
	const aContent = aHeights.reduce((a, b) => a + b, 0);
	const master = opts.showMaster !== false ? MASTER_ROW_PX : 0;
	const aMax = Math.max(0, aContent + master - ah);
	const aScroll = Math.min(aMax, Math.max(0, opts.scrollYAudio));
	const audioRows: TrackRow[] = [];
	acc = audioTop - aScroll;
	opts.audioTracks.forEach((t, i) => {
		const h = aHeights[i]!;
		audioRows.push({ trackId: t.id, kind: 'audio', index: i, y: acc, height: h });
		acc += h;
	});

	return {
		height: opts.height,
		dividerTop,
		video: {
			kind: 'video',
			top: 0,
			height: vh,
			maxScroll: vMax,
			// Top → bottom (V_n first, V1 last).
			rows: videoRows,
		},
		audio: {
			kind: 'audio',
			top: audioTop,
			height: ah,
			maxScroll: aMax,
			rows: audioRows,
		},
		masterY: master ? acc : null,
	};
}

/** Rows (plus one of overscan) that intersect the region's visible band (TL-151). */
export function visibleRows(region: RegionLayout): TrackRow[] {
	const top = region.top;
	const bottom = region.top + region.height;
	const rows = region.rows;
	const hit = rows.map((r) => r.y < bottom && r.y + r.height > top);
	return rows.filter((_, i) => hit[i] || hit[i - 1] || hit[i + 1]);
}

type YHit =
	| { kind: 'track'; row: TrackRow }
	| { kind: 'above-video'; region: 'video'; index: number }
	| { kind: 'below-audio'; region: 'audio'; index: number }
	| { kind: 'divider' }
	| { kind: 'master' }
	| { kind: 'none' };

/** Which track (or new-track zone, TL-266) is at `y` in track-area coordinates. */
export function hitY(layout: TrackAreaLayout, y: number): YHit {
	if (y >= layout.dividerTop && y < layout.dividerTop + DIVIDER_PX) return { kind: 'divider' };
	const region = y < layout.dividerTop ? layout.video : layout.audio;
	for (const row of region.rows) if (y >= row.y && y < row.y + row.height) return { kind: 'track', row };
	if (region.kind === 'video') {
		const topRow = region.rows[0];
		if (!topRow || y < topRow.y) return { kind: 'above-video', region: 'video', index: region.rows.length };
		return { kind: 'none' };
	}
	if (layout.masterY !== null && y >= layout.masterY && y < layout.masterY + MASTER_ROW_PX)
		return { kind: 'master' };
	const last = region.rows[region.rows.length - 1];
	if (!last || y >= last.y + last.height)
		return { kind: 'below-audio', region: 'audio', index: region.rows.length };
	return { kind: 'none' };
}

/** Row of a track in the layout, if present. */
export function rowOf(layout: TrackAreaLayout, trackId: string): TrackRow | undefined {
	return (
		layout.video.rows.find((r) => r.trackId === trackId) ??
		layout.audio.rows.find((r) => r.trackId === trackId)
	);
}

/**
 * Track index under `y` counted within its region; beyond the top video / bottom audio track this is
 * the (virtual) index of a track that would be created (TL-266, TL-486).
 */
export function regionIndexAt(layout: TrackAreaLayout, region: RegionKind, y: number): number {
	const r = region === 'video' ? layout.video : layout.audio;
	if (r.rows.length === 0) return 0;
	if (region === 'video') {
		// rows[] is ordered top → bottom (highest index first).
		const bottom = r.rows[r.rows.length - 1]!;
		if (y >= bottom.y + bottom.height) return 0;
		for (const row of r.rows) if (y >= row.y && y < row.y + row.height) return row.index;
		const top = r.rows[0]!;
		if (y < top.y) return top.index + 1 + Math.floor((top.y - y) / DEFAULT_VIDEO_PX);
		return 0;
	}
	const first = r.rows[0]!;
	if (y < first.y) return 0;
	for (const row of r.rows) if (y >= row.y && y < row.y + row.height) return row.index;
	const last = r.rows[r.rows.length - 1]!;
	return last.index + 1 + Math.floor((y - (last.y + last.height)) / DEFAULT_AUDIO_PX);
}
