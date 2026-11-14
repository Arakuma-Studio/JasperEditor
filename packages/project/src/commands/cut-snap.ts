// Cut edges off speech for the cut commands (docs/wp-notes/transcript-cleanup.md "Cut edges outside speech"): the
// sequence side of `cleanup/edge-snap.ts`. A command that cuts at a sequence frame (range.extract / range.lift,
// transcript.extract / transcript.lift, clip.trim, clip.split) and is asked to `snapToSilence` moves that frame to
// the nearest quiet frame boundary of the speech it cuts, judged on the first audio clip under the frame whose media
// the command's `levels` cover, bounded by that media's transcript words. The picture moves with it (one frame for
// every track): linked sound and picture stay together. `cutLevelWindows` builds the `levels` a caller sends. Pure.
import { transcriptForMedia } from '../captions/sequence-transcript.ts';
import type { CleanupVoice } from '../cleanup/detector.ts';
import {
	EDGE_DECAY_S,
	type EdgeLevels,
	type EdgeSide,
	edgeBounds,
	edgeInsideWord,
	edgeScore,
	snapCut,
} from '../cleanup/edge-snap.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import { isRemapped } from '../time-remap/model.ts';
import { base64Bytes, bytesBase64 } from './base64.ts';
import type { HandlerContext } from './context.ts';
import type { CutLevels } from './schemas/cut-levels.ts';

const FR = 0.01;
/** Seconds of levels a window holds on each side of an edge (the snapper's reach plus its 50 ms judgement). */
const WINDOW_S = EDGE_DECAY_S + 0.25;

/** The decoded windows of one media (+ stream): the levels the snapper reads; frames outside every window are loud. */
type MediaLevels = EdgeLevels & { mediaId: string; stream: number | undefined };

/** Decodes `levels`; a malformed window is an error message. */
export function decodeCutLevels(levels: CutLevels): MediaLevels[] | string {
	const by = new Map<string, { w: CutLevels[number]; level: Uint8Array; classes: Uint8Array | null }[]>();
	for (const w of levels) {
		const level = base64Bytes(w.level);
		const classes = w.classes ? base64Bytes(w.classes) : null;
		if (!level) return `levels of ${w.mediaId}: not base64`;
		if (w.classes && (!classes || classes.length !== level.length))
			return `levels of ${w.mediaId}: classes do not match the level bytes`;
		const key = `${w.mediaId}\u0000${w.stream ?? ''}`;
		const list = by.get(key) ?? [];
		list.push({ w, level, classes });
		by.set(key, list);
	}
	const out: MediaLevels[] = [];
	for (const list of by.values()) {
		const at = (k: number) => list.find((x) => k >= x.w.from && k < x.w.from + x.level.length);
		const first = list[0]!.w;
		out.push({
			mediaId: first.mediaId,
			stream: first.stream,
			frameCount: Math.max(...list.map((x) => x.w.from + x.level.length)),
			// beyond the windows nothing is known: loud, so no edge moves there
			db: (k) => {
				const x = at(k);
				return x ? -120 + x.level[k - x.w.from]! / 2 : 0;
			},
			breath: (k) => {
				const x = at(k);
				return !!x?.classes && x.classes[k - x.w.from] === 1;
			},
			floorDb: first.floorDb,
			speechDb: first.speechDb,
		});
	}
	return out;
}

type AudioClip = Clip & { kind: 'audio'; mediaId: string; channels: { streamIndex: number } };

/** Enabled forward 100 % audio clips on audio tracks (A1 first) whose media `levels` cover. */
function speechClips(seq: Sequence, levels: readonly MediaLevels[], tracks?: ReadonlySet<string>) {
	const order = new Map(seq.audioTracks.map((t, i) => [t.id, i]));
	const out: Array<{ clip: AudioClip; levels: MediaLevels }> = [];
	for (const c of Object.values(seq.clips)) {
		if (c.kind !== 'audio' || !c.enabled || !order.has(c.trackId) || (tracks && !tracks.has(c.trackId)))
			continue;
		if (c.speed.reverse || c.speed.rate !== 1 || isRemapped(c)) continue;
		const a = c as AudioClip;
		const l = levels.find(
			(x) => x.mediaId === a.mediaId && (x.stream === undefined || x.stream === a.channels.streamIndex),
		);
		if (l) out.push({ clip: a, levels: l });
	}
	return out.sort(
		(x, y) => order.get(x.clip.trackId)! - order.get(y.clip.trackId)! || x.clip.start - y.clip.start,
	);
}

export type SnappedFrame = { frame: number; clean: boolean };

/**
 * A cut edge at sequence frame `frame` moved off speech (`side`: `out` = the kept sound ends there, `in` = it starts
 * there), judged on the first speech clip that plays across it; null when no clip with levels is there. The frame
 * stays inside `[lo, hi]`.
 */
export function snapCutFrame(
	doc: Pick<ProjectDocument, 'transcripts'>,
	seq: Sequence,
	frame: number,
	side: EdgeSide,
	levels: readonly MediaLevels[],
	o: { lo?: number; hi?: number; tracks?: ReadonlySet<string> } = {},
): SnappedFrame | null {
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const hit = speechClips(seq, levels, o.tracks).find(({ clip: c }) =>
		side === 'out'
			? c.start < frame && frame <= c.start + c.duration
			: c.start <= frame && frame < c.start + c.duration,
	);
	if (!hit) return null;
	const { clip: c, levels: L } = hit;
	const mediaS = (f: number) => (c.sourceIn + (f - c.start) * F) / FLICKS_PER_SECOND;
	const lo = Math.max(o.lo ?? Number.NEGATIVE_INFINITY, side === 'out' ? c.start + 1 : c.start);
	const hi = Math.min(
		o.hi ?? Number.POSITIVE_INFINITY,
		side === 'out' ? c.start + c.duration : c.start + c.duration - 1,
	);
	const reach = Math.ceil((EDGE_DECAY_S * FLICKS_PER_SECOND) / F) + 1;
	const candidates: number[] = [];
	for (let f = Math.max(lo, frame - reach); f <= Math.min(hi, frame + reach); f++) candidates.push(mediaS(f));
	const t = mediaS(frame);
	const words = wordsNear(doc, c.mediaId, t);
	const b = edgeBounds(words, t, side);
	const s = snapCut(L, { t, side, ...b, candidates, words });
	return { frame: Math.round(c.start + (s.t * FLICKS_PER_SECOND - c.sourceIn) / F), clean: s.clean };
}

/**
 * A split at sequence frame `frame` moved to the nearest boundary where neither side cuts speech (clean as an out and
 * as an in edge, not inside a word) within 0.15 s, on the first speech clip across it; null when none is there.
 */
export function snapSplitFrame(
	doc: Pick<ProjectDocument, 'transcripts'>,
	seq: Sequence,
	frame: number,
	levels: readonly MediaLevels[],
	tracks?: ReadonlySet<string>,
): SnappedFrame | null {
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const hit = speechClips(seq, levels, tracks).find(
		({ clip: c }) => c.start < frame && frame < c.start + c.duration,
	);
	if (!hit) return null;
	const { clip: c, levels: L } = hit;
	const mediaS = (f: number) => (c.sourceIn + (f - c.start) * F) / FLICKS_PER_SECOND;
	const words = wordsNear(doc, c.mediaId, mediaS(frame));
	const ok = (f: number) =>
		edgeScore(L, mediaS(f), 'out') <= 0 &&
		edgeScore(L, mediaS(f), 'in') <= 0 &&
		!edgeInsideWord(L, words, mediaS(f));
	if (ok(frame)) return { frame, clean: true };
	const reach = Math.ceil((0.15 * FLICKS_PER_SECOND) / F);
	for (let d = 1; d <= reach; d++)
		for (const f of [frame - d, frame + d])
			if (f > c.start && f < c.start + c.duration && ok(f)) return { frame: f, clean: true };
	return { frame, clean: false };
}

/** The words of a media's transcript within 3 s of `t` (media seconds). */
function wordsNear(doc: Pick<ProjectDocument, 'transcripts'>, mediaId: string, t: number) {
	const tr = transcriptForMedia(doc, mediaId);
	if (!tr) return [];
	const out: Array<{ s: number; e: number }> = [];
	for (const w of tr.words) {
		const s = w.start / FLICKS_PER_SECOND;
		const e = w.end / FLICKS_PER_SECOND;
		if (e > t - 3 && s < t + 3) out.push({ s, e });
	}
	return out;
}

/**
 * The `levels` a cut command needs to snap its edges at sequence `frames`: for every audio clip that plays within
 * `WINDOW_S` of one of them and whose media has a voice analysis (`voice`), the analysis' level and class bytes around
 * it, merged per media into windows of at most 60 s.
 */
export function cutLevelWindows(
	seq: Sequence,
	frames: readonly number[],
	voice: (mediaId: string, stream: number) => CleanupVoice | null | undefined,
): CutLevels {
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const fps = rate.num / rate.den;
	const spans = new Map<
		string,
		{ mediaId: string; stream: number; v: CleanupVoice; parts: Array<[number, number]> }
	>();
	for (const c of Object.values(seq.clips)) {
		if (c.kind !== 'audio' || !c.enabled) continue;
		const a = c as AudioClip;
		for (const f of frames) {
			const near = Math.ceil(WINDOW_S * fps) + 1;
			if (f < a.start - near || f > a.start + a.duration + near) continue;
			const v = voice(a.mediaId, a.channels.streamIndex);
			if (!v?.frameCount) continue;
			const t = (a.sourceIn + (f - a.start) * F) / FLICKS_PER_SECOND;
			const k0 = Math.max(0, Math.floor((t - WINDOW_S) / FR));
			const k1 = Math.min(v.frameCount, Math.ceil((t + WINDOW_S) / FR));
			if (k1 <= k0) continue;
			const key = `${a.mediaId}\u0000${a.channels.streamIndex}`;
			const e = spans.get(key) ?? { mediaId: a.mediaId, stream: a.channels.streamIndex, v, parts: [] };
			e.parts.push([k0, k1]);
			spans.set(key, e);
		}
	}
	const out: CutLevels = [];
	for (const e of spans.values()) {
		const parts = e.parts.sort((x, y) => x[0] - y[0]);
		const merged: Array<[number, number]> = [];
		for (const p of parts) {
			const l = merged[merged.length - 1];
			if (l && p[0] <= l[1] && p[1] - l[0] <= 6000) l[1] = Math.max(l[1], p[1]);
			else merged.push([p[0], p[1]]);
		}
		for (const [k0, k1] of merged)
			out.push({
				mediaId: e.mediaId,
				stream: e.stream,
				from: k0,
				level: bytesBase64(e.v.level.subarray(k0, k1)),
				classes: bytesBase64(e.v.classes.subarray(k0, k1)),
				floorDb: e.v.levels.floorDb,
				speechDb: e.v.levels.speechDb,
			});
	}
	return out;
}

/**
 * The decoded `levels` of a cut command that snaps (`on`), else null. Snapping without levels warns
 * (`W_NO_LEVELS`) and cuts exactly; malformed levels refuse (`E_INVALID_PARAM`).
 */
export function cutSnapLevels(
	cmd: { levels?: CutLevels | undefined },
	on: boolean,
	h: HandlerContext,
): MediaLevels[] | null {
	if (!on) return null;
	if (!cmd.levels?.length) {
		h.warn(
			'W_NO_LEVELS',
			'snapToSilence needs levels (the voice analysis around the cut): cut at the exact frames',
		);
		return null;
	}
	const r = decodeCutLevels(cmd.levels);
	if (typeof r === 'string') return h.fail('E_INVALID_PARAM', r);
	return r;
}

/** A range cut `[from, to)` with both edges moved off speech (`from` an out edge, `to` an in edge). */
export function snapCutRange(
	doc: Pick<ProjectDocument, 'transcripts'>,
	seq: Sequence,
	from: number,
	to: number,
	levels: readonly MediaLevels[],
	tracks?: ReadonlySet<string>,
): { from: number; to: number; clean: boolean } {
	const a = snapCutFrame(doc, seq, from, 'out', levels, { hi: to - 1, ...(tracks ? { tracks } : {}) });
	const f = a?.frame ?? from;
	const b = snapCutFrame(doc, seq, to, 'in', levels, { lo: f + 1, ...(tracks ? { tracks } : {}) });
	return { from: f, to: b?.frame ?? to, clean: (a?.clean ?? true) && (b?.clean ?? true) };
}
