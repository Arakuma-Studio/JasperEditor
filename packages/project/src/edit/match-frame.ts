// edit-ux: Match Frame (F) and Reverse Match Frame (Shift+R) as pure queries over the document.
//
// Premiere Pro ("Match Frame", helpx.adobe.com): Match Frame opens the source of the clip under the playhead on the
// topmost targeted track in the Source monitor, at the matching frame (a selected clip at the playhead wins; with
// no targeted tracks every track counts, video before audio, topmost first). Reverse Match Frame moves the
// sequence playhead to the frame that uses the frame shown in the Source monitor. Nested sequences match to the
// nested sequence (opened as a source); subclips match to the subclip item.
import { contentTimeAt } from '../derive/index.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';

export type MatchFrameResult = {
	clipId: string;
	/** The project item to open in the Source monitor (media, subclip, synthetic or sequence item), when any. */
	itemId: string | null;
	mediaId: string | null;
	/** Nested sequence (nest clips). */
	sequenceId: string | null;
	/** Content time (flicks) shown at the frame. */
	sourceTime: number;
	/** Source In / Out of the clip (flicks, Out exclusive) — for "Match Frame sets In and Out". */
	sourceIn: number;
	sourceOut: number;
};

function itemFor(doc: ProjectDocument, c: Clip): string | null {
	const r = c as { mediaId?: string; syntheticId?: string; sequenceId?: string; subclipId?: string };
	if (r.subclipId && doc.items[r.subclipId]?.kind === 'subclip') return r.subclipId;
	for (const it of Object.values(doc.items)) {
		if (r.mediaId && it.kind === 'media' && it.mediaId === r.mediaId) return it.id;
		if (r.syntheticId && it.kind === 'synthetic' && it.syntheticId === r.syntheticId) return it.id;
		if (r.sequenceId && it.kind === 'sequence' && it.sequenceId === r.sequenceId) return it.id;
	}
	return null;
}

function clipAtFrame(seq: Sequence, trackId: string, frame: number): Clip | undefined {
	for (const c of Object.values(seq.clips))
		if (c.trackId === trackId && c.start <= frame && frame < c.start + c.duration) return c;
	return undefined;
}

/**
 * The clip Match Frame uses at `frame`: `clipId` (a selected clip under the playhead) when given, else the topmost
 * clip on `trackIds` (all tracks when empty): video tracks top-down, then audio tracks A1 down.
 */
export function matchFrame(
	doc: ProjectDocument,
	sequenceId: string,
	frame: number,
	opts: { trackIds?: readonly string[]; clipId?: string } = {},
): MatchFrameResult | null {
	const seq = doc.sequences[sequenceId];
	if (!seq) return null;
	const rate = seq.settings.frameRate as Rational;
	let clip: Clip | undefined;
	if (opts.clipId) {
		const c = seq.clips[opts.clipId];
		if (c && c.start <= frame && frame < c.start + c.duration) clip = c;
	}
	if (!clip) {
		const allowed = opts.trackIds?.length ? new Set(opts.trackIds) : null;
		const order = [...[...seq.videoTracks].reverse(), ...seq.audioTracks].filter(
			(t) => !allowed || allowed.has(t.id),
		);
		for (const t of order) {
			clip = clipAtFrame(seq, t.id, frame);
			if (clip) break;
		}
	}
	if (!clip) return null;
	const r = clip as { mediaId?: string; sequenceId?: string };
	const span = clip.duration * flicksPerFrame(rate) * clip.speed.rate;
	return {
		clipId: clip.id,
		itemId: itemFor(doc, clip),
		mediaId: r.mediaId ?? null,
		sequenceId: clip.kind === 'nest-video' || clip.kind === 'nest-audio' ? (r.sequenceId ?? null) : null,
		sourceTime: Math.round(contentTimeAt(clip, frame, rate)),
		sourceIn: clip.sourceIn,
		sourceOut: Math.round(clip.sourceIn + span),
	};
}

/** The sequence frame of clip `c` that shows content time `t`, or null when it does not show it. */
export function frameShowing(c: Clip, t: number, rate: Rational): number | null {
	const step = flicksPerFrame(rate) * c.speed.rate;
	const i = Math.floor((t - c.sourceIn) / step + 1e-6);
	if (i < 0 || i >= c.duration) return null;
	return c.speed.reverse ? c.start + c.duration - 1 - i : c.start + i;
}

export type ReverseMatchSource = { itemId?: string; mediaId?: string; sequenceId?: string; time: number };

/**
 * Reverse Match Frame: the sequence frame (and clip) that uses source content time `source.time`. Prefers clips on
 * `trackIds`, then the one nearest `near` (the current playhead), so repeated use cycles through nothing surprising.
 */
export function reverseMatchFrame(
	doc: ProjectDocument,
	sequenceId: string,
	source: ReverseMatchSource,
	opts: { trackIds?: readonly string[]; near?: number } = {},
): { clipId: string; frame: number } | null {
	const seq = doc.sequences[sequenceId];
	if (!seq) return null;
	const rate = seq.settings.frameRate as Rational;
	let mediaId = source.mediaId ?? null;
	let nested = source.sequenceId ?? null;
	let subclip: string | null = null;
	if (source.itemId) {
		const it = doc.items[source.itemId];
		if (it?.kind === 'media') mediaId = it.mediaId;
		else if (it?.kind === 'subclip') {
			mediaId = it.mediaId;
			subclip = it.id;
		} else if (it?.kind === 'sequence') nested = it.sequenceId;
	}
	const hits: { clip: Clip; frame: number; preferred: boolean }[] = [];
	const allowed = opts.trackIds?.length ? new Set(opts.trackIds) : null;
	for (const c of Object.values(seq.clips)) {
		const r = c as { mediaId?: string; sequenceId?: string };
		const match = nested
			? (c.kind === 'nest-video' || c.kind === 'nest-audio') && r.sequenceId === nested
			: !!mediaId && r.mediaId === mediaId;
		if (!match) continue;
		const f = frameShowing(c, source.time, rate);
		if (f === null) continue;
		hits.push({
			clip: c,
			frame: f,
			preferred: (!allowed || allowed.has(c.trackId)) && (!subclip || c.subclipId === subclip),
		});
	}
	if (hits.length === 0) return null;
	const near = opts.near ?? 0;
	hits.sort(
		(a, b) =>
			Number(b.preferred) - Number(a.preferred) ||
			Math.abs(a.frame - near) - Math.abs(b.frame - near) ||
			a.frame - b.frame,
	);
	return { clipId: hits[0]!.clip.id, frame: hits[0]!.frame };
}
