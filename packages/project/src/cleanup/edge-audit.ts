// Audit of a sequence's cut edges (docs/wp-notes/transcript-cleanup.md "Cut edges outside speech"): every edge of an
// audio clip that is a cut — not the recording's own start or end, not a through edit with the clip beside it — and
// cuts sound on its cut-away side (speech, or a decay / onset over quiet + 6 dB) or lands inside a word (`edgeInsideWord`: a closure), with the
// word it cuts and the frame its repair moves it to (`repairCut`: the cut word's whole decay or onset, or back off
// another word's onset). Whoever made the cut (Clean Up, a text cut, a manual trim), the audit sees it; Clean Up offers
// the repairs as `edge` findings (sequence.ts). Pure: the caller supplies the voice analyses.
import { transcriptForMedia } from '../captions/sequence-transcript.ts';
import type { Sequence } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import { isRemapped } from '../time-remap/model.ts';
import type { CleanupVoice } from './detector.ts';
import { type EdgeRepair, repairCut } from './edge-repair.ts';
import {
	awayLevel,
	EDGE_DECAY_S,
	type EdgeSide,
	edgeCutsSpeech,
	edgeInsideWord,
	edgeLevelsOf,
	edgeScore,
	edgeThresholds,
} from './edge-snap.ts';

export type CutEdgeAudit = {
	clipId: string;
	trackId: string;
	/** `out`: the clip's end cuts the sound after it away; `in`: its start cuts the sound before it. */
	side: EdgeSide;
	/** Sequence frame of the edge. */
	frame: number;
	mediaId: string;
	/** Media seconds of the edge. */
	mediaSeconds: number;
	/**
	 * `speech`: the 50 ms cut away hold speech; `sound`: they hold a word's decay or onset (over quiet + 6 dB: ≈ −35
	 * dBFS on the reporter's source) that a clean cut would keep or leave out whole; `inside-word`: the edge lies in a
	 * closure inside a word.
	 */
	reason: 'speech' | 'sound' | 'inside-word';
	/** Loudest level of the 50 ms cut away (dBFS). */
	awayDb: number;
	/** The transcript word the cut-away sound belongs to (or the one the edge is inside), if any. */
	word: string | null;
	/**
	 * The sequence frame the edge's repair moves it to (`repairCut`; null: none). Safe repairs land on a clean boundary
	 * and add or remove only the cut word's own sound.
	 */
	fixFrame: number | null;
	/** The repair (absent without one, and in analyses of older builds). */
	repair?: Pick<EdgeRepair, 'kind' | 'safe' | 'review'>;
};

type VoiceLookup = (mediaId: string, stream: number) => CleanupVoice | null | undefined;

/** The cut edges of `seq`'s audio clips that cut speech (see the module comment), in sequence order. */
export function auditCutEdges(
	doc: { transcripts: Parameters<typeof transcriptForMedia>[0]['transcripts'] },
	seq: Sequence,
	voice: VoiceLookup,
	range?: { from: number; to: number } | null,
): CutEdgeAudit[] {
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const audioTracks = new Set(seq.audioTracks.map((t) => t.id));
	const clips = Object.values(seq.clips).filter(
		(c): c is typeof c & { kind: 'audio'; mediaId: string; channels: { streamIndex: number } } =>
			c.kind === 'audio' &&
			c.enabled &&
			audioTracks.has(c.trackId) &&
			!c.speed.reverse &&
			c.speed.rate === 1 &&
			!isRemapped(c),
	);
	const through = (c: (typeof clips)[number], side: EdgeSide) =>
		clips.some(
			(d) =>
				d.id !== c.id &&
				d.trackId === c.trackId &&
				d.mediaId === c.mediaId &&
				(side === 'out'
					? d.start === c.start + c.duration && Math.abs(d.sourceIn - (c.sourceIn + c.duration * F)) < F / 2
					: d.start + d.duration === c.start && Math.abs(d.sourceIn + d.duration * F - c.sourceIn) < F / 2),
		);
	const out: CutEdgeAudit[] = [];
	for (const c of clips) {
		const v = voice(c.mediaId, c.channels.streamIndex);
		if (!v?.frameCount) continue;
		const L = edgeLevelsOf(v);
		const words = (transcriptForMedia(doc, c.mediaId)?.words ?? []).map((w) => ({
			s: w.start / FLICKS_PER_SECOND,
			e: w.end / FLICKS_PER_SECOND,
			text: w.text,
		}));
		const mediaS = (f: number) => (c.sourceIn + (f - c.start) * F) / FLICKS_PER_SECOND;
		for (const side of ['in', 'out'] as const) {
			const frame = side === 'in' ? c.start : c.start + c.duration;
			if (range && (frame < range.from || frame > range.to)) continue;
			const t = mediaS(frame);
			if (side === 'in' && c.sourceIn <= 0) continue;
			if (side === 'out' && t >= v.frameCount * 0.01 - 0.01) continue;
			if (through(c, side)) continue;
			const speech = edgeCutsSpeech(L, t, side);
			const inside = edgeInsideWord(L, words, t);
			const sound = edgeScore(L, t, side) > 0 && awayLevel(L, t, side) > edgeThresholds(L).quiet + 6;
			if (!speech && !inside && !sound) continue;
			const near = words.filter((w) => w.e > t - 3 && w.s < t + 3);
			const word = inside
				? (near.find((w) => w.s < t && w.e > t)?.text ?? null)
				: side === 'out'
					? (near.find((w) => w.e > t)?.text ?? null)
					: ([...near].reverse().find((w) => w.s < t)?.text ?? null);
			// the repair, over the clip's frame boundaries inside the media (never across the clip's other edge)
			const reach = Math.ceil((EDGE_DECAY_S * FLICKS_PER_SECOND) / F) + 1;
			const candidates: number[] = [];
			const mediaEnd = v.frameCount * 0.01;
			for (let f = frame - reach; f <= frame + reach; f++) {
				const m = mediaS(f);
				if (m < 0 || m > mediaEnd + 1e-9) continue;
				if (side === 'in' ? f < c.start + c.duration : f > c.start) candidates.push(m);
			}
			const r = repairCut(L, { t, side, candidates, words: near });
			const fix = r ? Math.round(c.start + (r.t * FLICKS_PER_SECOND - c.sourceIn) / F) : null;
			out.push({
				clipId: c.id,
				trackId: c.trackId,
				side,
				frame,
				mediaId: c.mediaId,
				mediaSeconds: Math.round(t * 1000) / 1000,
				reason: inside ? 'inside-word' : speech ? 'speech' : 'sound',
				awayDb: Math.round(awayLevel(L, t, side) * 10) / 10,
				word: word?.trim() ?? null,
				fixFrame: fix !== null && fix !== frame ? fix : null,
				...(r && fix !== frame
					? { repair: { kind: r.kind, safe: r.safe, ...(r.review ? { review: r.review } : {}) } }
					: {}),
			});
		}
	}
	return out.sort((a, b) => a.frame - b.frame || a.trackId.localeCompare(b.trackId));
}
