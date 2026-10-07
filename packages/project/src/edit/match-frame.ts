// Match Frame (F) and Reverse Match Frame (Shift+R) as pure queries over the document — one implementation for
// the UI (apps/web commands/structure.ts) and agents (MCP `match_frame`).
//
// Premiere Pro ("Match Frame", helpx.adobe.com): Match Frame opens the source of the clip under the playhead on the
// topmost targeted track in the Source monitor at the matching frame; a selected clip under the playhead wins.
// Through nests (edit-structure) it matches the clip inside the nested sequence; an enabled multi-camera clip
// matches its active angle only (wp-multicam). Frame holds match the held frame. Reverse Match Frame moves the
// sequence playhead to the first frame that shows the Source monitor's frame (through nests); a subclip source
// prefers clips placed from that subclip (edit-ux).
import { multicamView } from '../multicam/model.ts';
import { clipPictureTime } from '../render/scene.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { isNestClip } from '../structure/nest.ts';
import { flicksPerFrame, type Rational } from '../time.ts';

const MAX_DEPTH = 16;

export type MatchFrameHit = {
	/** The clip that shows the source (inside a nest when matched through one). */
	clip: Clip;
	/** The sequence holding `clip`. */
	seq: Sequence;
	/** Content time (flicks) shown at the frame. */
	contentFlicks: number;
};

/**
 * The media/synthetic clip shown at `frame` of `seq` on `trackIds` (all when absent): video tracks top-down, then
 * audio; through nests (multi-camera clips through their active angle).
 */
export function resolveMatchFrame(
	doc: ProjectDocument,
	seq: Sequence,
	frame: number,
	trackIds?: readonly string[],
	depth = 0,
	preferClipId?: string,
): MatchFrameHit | null {
	if (depth > MAX_DEPTH) return null;
	const rate = seq.settings.frameRate as Rational;
	const order = [
		...[...seq.videoTracks].reverse().map((t) => t.id),
		...seq.audioTracks.map((t) => t.id),
	].filter((id) => !trackIds || trackIds.includes(id));
	const at = (trackId: string) =>
		Object.values(seq.clips).find(
			(c) => c.trackId === trackId && c.start <= frame && frame < c.start + c.duration,
		);
	const candidates: Clip[] = [];
	const preferred = preferClipId ? seq.clips[preferClipId] : undefined;
	if (preferred && preferred.start <= frame && frame < preferred.start + preferred.duration)
		candidates.push(preferred);
	for (const t of order) {
		const c = at(t);
		if (c && c !== preferred) candidates.push(c);
	}
	for (const c of candidates) {
		const time = clipPictureTime(c as never, frame, rate);
		if (isNestClip(c)) {
			const whole = doc.sequences[(c as { sequenceId: string }).sequenceId];
			if (!whole) continue;
			const nested = multicamView(whole as Sequence, c);
			const only =
				nested === whole
					? undefined
					: [
							...nested.videoTracks.filter((t) => t.output !== false).map((t) => t.id),
							...nested.audioTracks.filter((t) => !t.mute).map((t) => t.id),
						];
			const nf = Math.floor(time / flicksPerFrame(nested.settings.frameRate as Rational) + 1e-6);
			const hit = resolveMatchFrame(doc, nested as Sequence, nf, only, depth + 1);
			if (hit) return hit;
			continue;
		}
		if ((c as { mediaId?: string }).mediaId || (c as { syntheticId?: string }).syntheticId)
			return { clip: c, seq, contentFlicks: time };
	}
	return null;
}

/** The project item a clip came from: its subclip, else the media / synthetic item. */
export function projectItemOfClip(doc: ProjectDocument, c: Clip): string | null {
	if (c.subclipId && doc.items[c.subclipId]?.kind === 'subclip') return c.subclipId;
	const m = (c as { mediaId?: string }).mediaId;
	const s = (c as { syntheticId?: string }).syntheticId;
	for (const it of Object.values(doc.items)) {
		if (m && it.kind === 'media' && it.mediaId === m) return it.id;
		if (s && it.kind === 'synthetic' && it.syntheticId === s) return it.id;
	}
	return null;
}

export type MatchFrameResult = {
	clipId: string;
	/** Sequence holding the matched clip (a nested sequence when matched through a nest). */
	sequenceId: string;
	/** The project item to open in the Source monitor (subclip, media or synthetic item), when any. */
	itemId: string | null;
	mediaId: string | null;
	/** Content time (flicks) shown at the frame. */
	sourceTime: number;
	/** The matched clip's source In / Out (flicks, Out exclusive) — Premiere "Match Frame sets In and Out". */
	sourceIn: number;
	sourceOut: number;
};

/** Match Frame of `sequenceId` at `frame` (see resolveMatchFrame); with targeted tracks first, then any track. */
export function matchFrame(
	doc: ProjectDocument,
	sequenceId: string,
	frame: number,
	opts: { trackIds?: readonly string[]; clipId?: string } = {},
): MatchFrameResult | null {
	const seq = doc.sequences[sequenceId];
	if (!seq) return null;
	const hit =
		resolveMatchFrame(doc, seq, frame, opts.trackIds?.length ? opts.trackIds : undefined, 0, opts.clipId) ??
		(opts.trackIds?.length ? resolveMatchFrame(doc, seq, frame, undefined, 0, opts.clipId) : null);
	if (!hit) return null;
	const c = hit.clip;
	const rate = hit.seq.settings.frameRate as Rational;
	const span = c.duration * flicksPerFrame(rate) * c.speed.rate;
	return {
		clipId: c.id,
		sequenceId: hit.seq.id,
		itemId: projectItemOfClip(doc, c),
		mediaId: (c as { mediaId?: string }).mediaId ?? null,
		sourceTime: Math.round(hit.contentFlicks),
		sourceIn: c.sourceIn,
		sourceOut: Math.round(c.sourceIn + span),
	};
}

/** The sequence frame of clip `c` that shows content time `t`, or null when it does not show it. */
export function frameShowing(c: Clip, t: number, rate: Rational): number | null {
	const F = flicksPerFrame(rate);
	if (c.frameHold) return Math.abs(c.frameHold.flicks - t) < F / 2 ? c.start : null;
	const step = F * c.speed.rate;
	const i = Math.floor((t - c.sourceIn) / step + 1e-6);
	const local = c.speed.reverse ? c.duration - 1 - i : i;
	return local >= 0 && local < c.duration ? c.start + local : null;
}

/** All frames of `seq` (through nests) showing content `flicks` of clips matching `pred`, with the clip ids. */
function contentFrames(
	doc: ProjectDocument,
	seq: Sequence,
	pred: (c: Clip) => boolean,
	flicks: number,
	depth: number,
	out: { frame: number; clipId: string; trackId: string }[],
	top: { clip: Clip | null },
): void {
	if (depth > MAX_DEPTH) return;
	const rate = seq.settings.frameRate as Rational;
	for (const c of Object.values(seq.clips)) {
		const owner = top.clip ?? c;
		if (pred(c)) {
			const f = frameShowing(c, flicks, rate);
			if (f !== null) out.push({ frame: f, clipId: owner.id, trackId: owner.trackId });
		} else if (isNestClip(c)) {
			const nested = doc.sequences[(c as { sequenceId: string }).sequenceId] as Sequence | undefined;
			if (!nested) continue;
			const inner: typeof out = [];
			contentFrames(doc, nested, pred, flicks, depth + 1, inner, { clip: null });
			const nfF = flicksPerFrame(nested.settings.frameRate as Rational);
			for (const x of inner) {
				const f = frameShowing(c, x.frame * nfF, rate);
				if (f !== null) out.push({ frame: f, clipId: owner.id, trackId: owner.trackId });
			}
		}
	}
}

export type ReverseMatchSource = { itemId?: string; mediaId?: string; syntheticId?: string; time: number };

/**
 * Reverse Match Frame: the frame of `sequenceId` that shows source content time `source.time` (through nests).
 * Clips on `trackIds` and (for a subclip source) clips placed from that subclip are preferred, then the earliest
 * frame (Premiere moves to the first use).
 */
export function reverseMatchFrame(
	doc: ProjectDocument,
	sequenceId: string,
	source: ReverseMatchSource,
	opts: { trackIds?: readonly string[] } = {},
): { clipId: string; frame: number } | null {
	const seq = doc.sequences[sequenceId];
	if (!seq) return null;
	let mediaId = source.mediaId ?? null;
	let syntheticId = source.syntheticId ?? null;
	let subclip: string | null = null;
	if (source.itemId) {
		const it = doc.items[source.itemId];
		if (it?.kind === 'media') mediaId = it.mediaId;
		else if (it?.kind === 'subclip') {
			mediaId = it.mediaId;
			subclip = it.id;
		} else if (it?.kind === 'synthetic') syntheticId = it.syntheticId;
	}
	if (!mediaId && !syntheticId) return null;
	const pred = (c: Clip) =>
		mediaId
			? (c as { mediaId?: string }).mediaId === mediaId
			: (c as { syntheticId?: string }).syntheticId === syntheticId;
	const hits: { frame: number; clipId: string; trackId: string }[] = [];
	contentFrames(doc, seq, pred, source.time, 0, hits, { clip: null });
	if (hits.length === 0) return null;
	const allowed = opts.trackIds?.length ? new Set(opts.trackIds) : null;
	const score = (x: (typeof hits)[number]) =>
		(allowed && !allowed.has(x.trackId) ? 2 : 0) +
		(subclip && seq.clips[x.clipId]?.subclipId !== subclip ? 1 : 0);
	hits.sort((a, b) => score(a) - score(b) || a.frame - b.frame);
	return { clipId: hits[0]!.clipId, frame: hits[0]!.frame };
}
