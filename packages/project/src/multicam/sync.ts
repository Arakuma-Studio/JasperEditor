// Sync points for Clip ▸ Synchronize, Merge Clips and Create Multi-Camera Source Sequence (wp-multicam).
//
// Every method reduces a clip to an ANCHOR: the content time (flicks) that lines up with one common instant. The
// OFFSET of clip i is `anchor_i − anchor_ref`: the content time of clip i at the instant the reference shows its
// content time 0, so coincident content times satisfy `t_i = t_ref + offset_i`.
//
// | method   | anchor                                                                                  |
// |----------|-----------------------------------------------------------------------------------------|
// | in       | the In point (project items: the source In mark, else 0; timeline clips: their source In) |
// | out      | the Out point (exclusive: the source Out mark, else the media end; timeline: source out) |
// | timecode | −(timecode of content time 0), optionally ignoring hours                                  |
// | marker   | the first clip marker (or the first one with the given name, case-insensitive)          |
// | audio    | measured by the engine (GCC-PHAT, `POST /api/sync/audio`) and passed in as offsets      |
//
// Adapted from FilmCraft `crates/engine/src/sync.rs` (MIT OR Apache-2.0, licenses/ported/multicam.md).
import { contentSpanFlicks, FRAME_EPS, flicksPerFrame, type Rational } from '../time.ts';
import { fieldsToFrames, parseTimecode } from '../timecode.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset } from '../schema/media.ts';
import type { Clip, Sequence, SyncMethod } from '../schema/sequence.ts';

/** What syncing needs to know about one clip (a project item or a timeline clip), in content flicks. */
export type SyncSource = {
	/** Item id or clip id. */
	key: string;
	name: string;
	inPoint: number;
	outPoint: number;
	/** Timecode of content time 0 as a duration in flicks (frame count × frame duration), null = none. */
	timecode: { flicks: number; hourFlicks: number } | null;
	markers: { flicks: number; name: string }[];
};

export type SyncSpec = {
	method: SyncMethod;
	/** Timecode: compare minutes/seconds/frames only (cameras whose hour digits differ). */
	ignoreHours?: boolean;
	/** Clip marker: use the first marker with this name instead of the first marker. */
	marker?: string;
	/** Audio: offset (flicks) of every non-reference source, keyed by `SyncSource.key` (engine analysis). */
	audioOffsets?: Readonly<Record<string, number>>;
};

export class SyncError extends Error {
	constructor(
		readonly code: 'E_INVALID_PARAM' | 'E_SYNC_NO_POINT',
		message: string,
	) {
		super(message);
	}
}

/** Video frame rate of an asset (null for audio-only / images). */
export function mediaVideoRate(asset: MediaAsset | undefined): Rational | null {
	const vs = asset?.probe.streams.find((s) => s.type === 'video');
	return vs && vs.type === 'video' ? vs.frameRate : null;
}

/**
 * The media's embedded start timecode as `{flicks, hourFlicks}`: the frame count of the timecode label at `rate`
 * (drop-frame when the label uses `;`) × the frame duration. Null when the media has none or it does not parse.
 */
export function mediaTimecode(asset: MediaAsset | undefined, fallbackRate: Rational): SyncSource['timecode'] {
	const tc = asset?.probe.startTimecode;
	if (!tc) return null;
	const rate = mediaVideoRate(asset) ?? fallbackRate;
	const drop = tc.includes(';');
	const frames = parseTimecode(tc, rate, { dropFrame: drop });
	if (frames === null || frames < 0) return null;
	const F = flicksPerFrame(rate);
	// One timecode hour: 3600 nominal seconds of labels (drop-frame: the frames that remain after dropping).
	const hourFrames = fieldsToFrames(1, 0, 0, 0, rate, { dropFrame: drop });
	return { flicks: Math.round(frames * F), hourFlicks: Math.round(hourFrames * F) };
}

function itemMarkers(doc: ProjectDocument, mediaId: string): { flicks: number; name: string }[] {
	const out: { flicks: number; name: string }[] = [];
	for (const it of Object.values(doc.items)) {
		if (it.kind !== 'media' || it.mediaId !== mediaId) continue;
		for (const m of (it as { markers?: { flicks: number; name: string }[] }).markers ?? [])
			out.push({ flicks: m.flicks, name: m.name });
	}
	return out;
}

/**
 * A project item (media item) as a sync source: the whole media, In/Out marks as In/Out points, its source clip
 * markers. Null for items that are not audio/video media.
 */
export function itemSyncSource(
	doc: ProjectDocument,
	itemId: string,
	fallbackRate: Rational,
): (SyncSource & { mediaId: string; duration: number }) | null {
	const it = doc.items[itemId];
	if (!it || it.kind !== 'media') return null;
	const asset = doc.media[it.mediaId];
	if (!asset || (asset.kind !== 'video' && asset.kind !== 'audio')) return null;
	const duration = asset.probe.durationFlicks;
	if (duration === null || duration <= 0) return null;
	const markers = ((it as { markers?: { flicks: number; name: string }[] }).markers ?? []).map((m) => ({
		flicks: m.flicks,
		name: m.name,
	}));
	return {
		key: itemId,
		name: it.name,
		mediaId: it.mediaId,
		duration,
		inPoint: it.marks.in?.flicks ?? 0,
		outPoint: it.marks.out?.flicks ?? duration,
		timecode: mediaTimecode(asset, fallbackRate),
		markers,
	};
}

/** A timeline clip as a sync source: its source In/Out, its clip markers plus its media item's markers. */
export function clipSyncSource(doc: ProjectDocument, seq: Sequence, clip: Clip): SyncSource {
	const rate = seq.settings.frameRate;
	const mediaId = (clip as { mediaId?: string }).mediaId;
	const asset = mediaId ? doc.media[mediaId] : undefined;
	const span = contentSpanFlicks(clip.duration, rate, clip.speed.rate);
	const markers = clip.markers.map((m) => ({ flicks: m.flicks, name: m.name }));
	if (mediaId) markers.push(...itemMarkers(doc, mediaId));
	return {
		key: clip.id,
		name: clip.name,
		inPoint: clip.sourceIn,
		outPoint: clip.sourceIn + span,
		timecode: asset ? mediaTimecode(asset, rate) : null,
		markers,
	};
}

function anchorOf(s: SyncSource, spec: SyncSpec): number {
	switch (spec.method) {
		case 'in':
			return s.inPoint;
		case 'out':
			return s.outPoint;
		case 'timecode': {
			if (!s.timecode) throw new SyncError('E_SYNC_NO_POINT', `${s.name} has no timecode`);
			const tc = spec.ignoreHours
				? ((s.timecode.flicks % s.timecode.hourFlicks) + s.timecode.hourFlicks) % s.timecode.hourFlicks
				: s.timecode.flicks;
			return -tc;
		}
		case 'marker': {
			const want = spec.marker?.trim().toLowerCase();
			const hits = s.markers
				.filter((m) => !want || m.name.trim().toLowerCase() === want)
				.map((m) => m.flicks)
				.sort((a, b) => a - b);
			if (hits.length === 0)
				throw new SyncError(
					'E_SYNC_NO_POINT',
					`${s.name} has no clip marker${spec.marker ? ` named “${spec.marker}”` : ''}`,
				);
			return hits[0]!;
		}
		case 'audio':
			return 0;
	}
}

/**
 * Offsets of every source relative to `sources[ref]` (flicks; the reference's is 0): `t_i = t_ref + offset_i`.
 * Audio offsets come from `spec.audioOffsets` (missing ones fail with E_INVALID_PARAM).
 */
export function syncOffsets(sources: readonly SyncSource[], ref: number, spec: SyncSpec): number[] {
	if (!sources[ref]) throw new SyncError('E_INVALID_PARAM', 'No reference clip');
	if (spec.method === 'audio') {
		return sources.map((s, i) => {
			if (i === ref) return 0;
			const v = spec.audioOffsets?.[s.key];
			if (v === undefined || !Number.isFinite(v))
				throw new SyncError(
					'E_INVALID_PARAM',
					`No audio offset for ${s.name} (${s.key}): analyse the audio first (POST /api/sync/audio, MCP synchronize/merge/create tools do it for you)`,
				);
			return Math.round(v);
		});
	}
	const anchors = sources.map((s) => anchorOf(s, spec));
	return anchors.map((a) => a - anchors[ref]!);
}

export type CommonPlacement = {
	/** Start frame on the common timeline (0 = the earliest source). */
	start: number;
	/** Source In (flicks): the range start plus the sub-frame remainder that keeps the sync exact. */
	sourceIn: number;
	/** Whole frames that fit in the range from `sourceIn`. */
	frames: number;
};

/**
 * Where each source's content range `[r0, r1)` lands on a common timeline starting at frame 0, given offsets
 * (coincident content times satisfy `t_i = t_ref + offset_i`, so common time = t − offset). A source whose exact
 * start falls between frames starts at the next frame boundary with its source In moved by the difference
 * (sample-accurate sync with whole-frame clips). `extra[i]` (flicks) delays source i further (Sequence offset).
 */
export function commonPlacements(
	ranges: readonly { start: number; end: number }[],
	offsets: readonly number[],
	rate: Rational,
	extra: readonly number[] = [],
): CommonPlacement[] {
	const F = flicksPerFrame(rate);
	const commonStart = ranges.map((r, i) => r.start - offsets[i]! + (extra[i] ?? 0));
	const min = Math.min(...commonStart);
	return ranges.map((r, i) => {
		const exact = commonStart[i]! - min;
		const start = Math.ceil(exact / F - 1e-9) || 0;
		const sourceIn = Math.round(r.start + (start * F - exact)) || 0;
		const frames = Math.max(1, Math.floor((r.end - sourceIn) / F + FRAME_EPS));
		return { start, sourceIn, frames };
	});
}
