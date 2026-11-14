// Edge repairs as Clean Up findings (docs/wp-notes/transcript-cleanup.md "Edge repair"): every cut edge of a speech
// clip that the cut-edge audit repairs (`auditCutEdges`, `repairCut`) and the plan leaves where it is becomes an `edge`
// finding — an extension of the clip into its media's handle, or a trim — accepted by default only when it is safe on
// the timeline too:
// - the repair itself is safe (`EdgeRepair.safe`: a clean boundary, only the cut word's own sound);
// - the media has the handle (an extension never runs past the media — else there is no finding);
// - every linked partner of the clip on a video track plays the same media in sync and has the handle: it is extended
//   with the sound at its own edge (`cleanup.apply` `extend`), so no picture is left uncovered or out of sync;
// - no other clip on a track that ripples (sync-locked, unlocked) touches the edge — a video clip would be split around
//   the inserted frames (a hole without picture), an audio clip (music, a second microphone) around a hole of silence;
//   generated overlays (titles, cards) are lengthened and captions held over the frames instead, so they do not count;
// - the sound it adds is played by no other clip of the media (no word heard twice).
// Everything else is offered for review. Pure.
import { isRippleOverlay } from '../commands/overlay-ripple.ts';
import { contentDurationFlicks } from '../registry/kinds.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import { isRemapped } from '../time-remap/model.ts';
import type { CutEdgeAudit } from './edge-audit.ts';

/** Why an edge repair waits for review (absent: safe). */
export type EdgeReview =
	/** The best boundary within reach still cuts speech. */
	| 'speech-left'
	/** The span holds most of another word's time. */
	| 'word'
	/** The added span holds a sound of its own before the word's attack. */
	| 'sound'
	/** The word had faded on the kept side: the repair keeps a soft tail (adds time at the join). */
	| 'faded'
	/** A linked picture cannot follow (out of sync, other media, no handle), or another video clip touches the edge. */
	| 'picture'
	/** Another audio clip on a rippling track touches the edge. */
	| 'other-sound'
	/** Another clip of the media already plays the sound it adds. */
	| 'doubled';

export type EdgeRepairPlan = {
	row: CutEdgeAudit;
	clipId: string;
	side: 'in' | 'out';
	/** Frames the clip's edge moves: > 0 the clip grows (extension), < 0 it shrinks (trim). */
	frames: number;
	/** Media seconds of the added (extension) or removed (trim) span. */
	media: [number, number];
	safe: boolean;
	review?: EdgeReview;
	/** Linked video clips extended with it. */
	partners: string[];
};

const end = (c: { start: number; duration: number }) => c.start + c.duration;

/** Whether a text clip is a caption (held over inserted frames by `cleanup.apply`, never split around them). */
export const isCaption = (c: Pick<Clip, 'kind'>) =>
	c.kind === 'text' && (c as { caption?: unknown }).caption !== undefined;

/**
 * The repairs of the audit rows of speech clips whose edge the plan keeps (`kept`: each clip's kept pieces and extent,
 * sequence frames), with what keeps each from being safe.
 */
export function planEdgeRepairs(input: {
	doc: Pick<ProjectDocument, 'media'>;
	seq: Sequence;
	rows: readonly CutEdgeAudit[];
	clips: ReadonlyArray<{
		clip: Clip;
		extent: readonly [number, number];
		kept: ReadonlyArray<readonly [number, number]>;
	}>;
}): EdgeRepairPlan[] {
	const { doc, seq, rows } = input;
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const videoTracks = new Set(seq.videoTracks.map((t) => t.id));
	const tracks = new Map([...seq.videoTracks, ...seq.audioTracks].map((t) => [t.id, t]));
	const byClip = new Map(input.clips.map((x) => [x.clip.id, x]));
	const all = Object.values(seq.clips);
	const out: EdgeRepairPlan[] = [];
	for (const row of rows) {
		if (row.fixFrame === null || !row.repair) continue;
		const cp = byClip.get(row.clipId);
		if (!cp?.kept.length) continue;
		const c = cp.clip as Clip & { mediaId: string };
		const P = row.side === 'out' ? end(c) : c.start;
		// the plan keeps the edge where it is (its kept pieces reach it, inside the scope)
		if (
			row.side === 'out'
				? cp.extent[1] !== P || cp.kept[cp.kept.length - 1]![1] !== P
				: cp.extent[0] !== P || cp.kept[0]![0] !== P
		)
			continue;
		const move = row.fixFrame - row.frame;
		const frames = row.side === 'out' ? move : -move;
		if (frames === 0) continue;
		const edgeS = (row.side === 'out' ? c.sourceIn + c.duration * F : c.sourceIn) / FLICKS_PER_SECOND;
		const toS = edgeS + (row.side === 'out' ? frames : -frames) * (F / FLICKS_PER_SECOND);
		const media: [number, number] = [Math.min(edgeS, toS), Math.max(edgeS, toS)];
		if (frames < 0) {
			// a trim keeps at least one frame of the piece
			const piece = row.side === 'out' ? cp.kept[cp.kept.length - 1]! : cp.kept[0]!;
			if (piece[1] - piece[0] + frames < 1) continue;
			out.push({
				row,
				clipId: c.id,
				side: row.side,
				frames,
				media,
				safe: row.repair.safe,
				...(row.repair.review ? { review: row.repair.review } : {}),
				partners: [],
			});
			continue;
		}
		// the handle: the media goes on for the extension
		const dur = contentDurationFlicks(doc, c);
		if (
			row.side === 'in'
				? c.sourceIn - frames * F < -0.5
				: dur !== null && c.sourceIn + (c.duration + frames) * F > dur + 0.5
		)
			continue;
		let review: EdgeReview | undefined = row.repair.review;
		// linked pictures follow at their own edge: same media, in sync, with the handle
		const offset = c.sourceIn - c.start * F;
		const partners: string[] = [];
		const members = new Set([c.id]);
		for (const id of c.linkId ? (seq.links[c.linkId]?.members ?? []) : []) {
			const p = seq.clips[id];
			if (!p || p.id === c.id || !videoTracks.has(p.trackId) || tracks.get(p.trackId)?.locked) continue;
			const pm = p as Clip & { mediaId?: string };
			const synced =
				pm.mediaId === c.mediaId &&
				p.speed.rate === 1 &&
				!p.speed.reverse &&
				!isRemapped(p) &&
				Math.abs(p.sourceIn - p.start * F - offset) < F / 2;
			const pd = contentDurationFlicks(doc, p);
			const room =
				row.side === 'in'
					? p.sourceIn - frames * F >= -0.5
					: pd === null || p.sourceIn + (p.duration + frames) * F <= pd + 0.5;
			if (!synced || !room) {
				review ??= 'picture';
				continue;
			}
			partners.push(p.id);
			members.add(p.id);
		}
		const memberTracks = new Set([...members].map((id) => seq.clips[id]!.trackId));
		// other clips on a track that ripples get the frames inserted at the edge: one across it is split around them, and
		// two butted at it are parted by them — a hole without picture on a video track, of silence on an audio track
		for (const x of all) {
			if (members.has(x.id) || !x.enabled || memberTracks.has(x.trackId)) continue;
			const t = tracks.get(x.trackId);
			if (!t || t.locked || !t.syncLock || isRippleOverlay(x) || isCaption(x)) continue;
			const across = x.start < P && end(x) > P;
			const butted =
				end(x) === P &&
				all.some((y) => y.id !== x.id && y.trackId === x.trackId && y.enabled && y.start === P);
			if (across || butted) review ??= videoTracks.has(x.trackId) ? 'picture' : 'other-sound';
		}
		// no other clip of the media plays the added sound
		const [a, b] = media;
		for (const x of all) {
			if (
				x.id === c.id ||
				x.kind !== 'audio' ||
				!x.enabled ||
				(x as { mediaId?: string }).mediaId !== c.mediaId
			)
				continue;
			const xa = x.sourceIn / FLICKS_PER_SECOND;
			const xb = xa + (x.duration * F * x.speed.rate) / FLICKS_PER_SECOND;
			if (xa < b - 1e-6 && xb > a + 1e-6) {
				review ??= 'doubled';
				break;
			}
		}
		out.push({
			row,
			clipId: c.id,
			side: row.side,
			frames,
			media,
			safe: row.repair.safe && review === undefined,
			...(review ? { review } : {}),
			partners,
		});
	}
	// two extensions adding the same sound (the out edge before a short cut and the in edge after it): both for review
	const ext = out.filter((r) => r.frames > 0);
	for (const r of ext)
		for (const q of ext)
			if (
				q !== r &&
				q.row.mediaId === r.row.mediaId &&
				q.media[0] < r.media[1] - 1e-6 &&
				q.media[1] > r.media[0] + 1e-6
			) {
				r.safe = false;
				r.review ??= 'doubled';
			}
	return out;
}
