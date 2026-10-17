// Where dialogue is heard in a sequence (spec 12 §1 "Less is more", §2.2 edit points, §2.4 dialogue guard, §2.6
// MUSIC_OVER_VOICE, P6-R3; wp-note "Phase 6 → WP6.3"). ONE definition for every consumer — cue derivation (no cut
// sound and no hero under speech), the plan job, placement warnings, the masking solver's dialogue guard and Sound
// Check's music-over-voice segments:
//
// 1. Transcript words of the sequence (`sequenceWords`) first.
// 2. Else Essential Sound `dialogue` clips (set by hand or by Auto Tag) on unmuted tracks, enabled, whose clip has no
//    transcript words: their **voice activity** when the engine measured it (`VoiceActivity`: voiced media seconds per
//    clip, the speech module's energy VAD over the clip's media — `apps/engine/src/sound-design/voice.ts`), mapped
//    through the clip's speed / reverse / time remap to the frames that play it;
// 3. pure fallback (no measurement): the whole clip span.
//
// Every stretch is padded by DIALOGUE_PAD_SEC and pauses shorter than DIALOGUE_BRIDGE_SEC are bridged, so a cut a
// breath after a sentence still counts as "under dialogue". Never throws ([] on damaged data).
import { sequenceWords } from '../../captions/sequence-transcript.ts';
import { clipEnd } from '../../derive/index.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import type { Clip, Sequence } from '../../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../../time.ts';
import { clipMediaTimeFn, type TimedClip } from '../../time-remap/model.ts';

/** Seconds of speech padding around words and voiced runs, and the pause that still counts as one dialogue stretch. */
export const DIALOGUE_PAD_SEC = 0.25;
export const DIALOGUE_BRIDGE_SEC = 0.75;
/** Clips ending later than this frame (≈ 24 h at 120 fps) are ignored; frames scanned per clip for voice activity. */
const MAX_SEQUENCE_FRAMES = 10_368_000;
export const MAX_VOICE_SCAN_FRAMES = 1_000_000;
/** Most voiced regions read per clip. */
export const MAX_VOICE_REGIONS = 20_000;

/** Voiced media seconds `[start, end)` of each measured dialogue clip (clip id → sorted regions). */
export type VoiceActivity = Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>;

export type DialogueSource = 'words' | 'vad' | 'clip';

/** A stretch of dialogue: sequence frames `[start, end)`, the clips and audio tracks speaking, what found it. */
export type DialogueSpan = {
	start: number;
	end: number;
	clipIds: string[];
	trackIds: string[];
	sources: DialogueSource[];
};

/** A dialogue clip the engine should measure (no transcript words): its media span and stream. */
export type DialogueVadClip = {
	clipId: string;
	mediaId: string;
	trackId: string;
	streamIndex: number | null;
	/** Media seconds the clip plays, smallest … largest. */
	mediaStartSec: number;
	mediaEndSec: number;
};

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function rateOf(seq: Sequence): Rational | null {
	const r = seq?.settings?.frameRate as Rational | undefined;
	return r && Number.isSafeInteger(r.num) && Number.isSafeInteger(r.den) && r.num > 0 && r.den > 0 ? r : null;
}

function validClip(c: unknown): c is Clip {
	const x = c as Clip;
	return (
		!!x &&
		typeof x === 'object' &&
		typeof x.id === 'string' &&
		Number.isSafeInteger(x.start) &&
		Number.isSafeInteger(x.duration) &&
		x.start >= 0 &&
		x.duration > 0 &&
		x.start + x.duration <= MAX_SEQUENCE_FRAMES &&
		!!x.speed &&
		fin(x.speed.rate) &&
		x.speed.rate > 0 &&
		fin(x.sourceIn)
	);
}

function safeWords(doc: ProjectDocument, seq: Sequence) {
	try {
		return sequenceWords(doc, seq).filter((w) => fin(w.start) && fin(w.end));
	} catch {
		return [];
	}
}

/** Essential Sound dialogue clips on unmuted tracks, enabled (whatever their transcript). */
function dialogueClips(seq: Sequence): Clip[] {
	const live = new Set(
		(Array.isArray(seq?.audioTracks) ? seq.audioTracks : []).filter((t) => t && !t.mute).map((t) => t.id),
	);
	const out: Clip[] = [];
	for (const c of Object.values(seq?.clips ?? {})) {
		if (!validClip(c) || c.kind !== 'audio' || c.enabled === false || !live.has(c.trackId)) continue;
		const ess = (c as { essential?: { type?: unknown } }).essential;
		if (!ess || typeof ess !== 'object' || ess.type !== 'dialogue') continue;
		out.push(c);
	}
	return out.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
}

/**
 * The dialogue clips without transcript words (what the engine's voice activity measures), with the media span each
 * plays. Never throws.
 */
export function dialogueVadClips(doc: ProjectDocument, seq: Sequence): DialogueVadClip[] {
	try {
		const rate = rateOf(seq);
		if (!rate) return [];
		const transcribed = new Set(safeWords(doc, seq).map((w) => w.clipId));
		const out: DialogueVadClip[] = [];
		for (const c of dialogueClips(seq)) {
			if (transcribed.has(c.id)) continue;
			const mediaId = (c as { mediaId?: unknown }).mediaId;
			if (typeof mediaId !== 'string' || !doc?.media || !Object.hasOwn(doc.media, mediaId)) continue;
			const at = clipMediaTimeFn(c as unknown as TimedClip, rate);
			const n = Math.min(c.duration, MAX_VOICE_SCAN_FRAMES);
			const stride = Math.max(1, Math.ceil(n / 20_000));
			let lo = Number.POSITIVE_INFINITY;
			let hi = Number.NEGATIVE_INFINITY;
			for (let k = 0; k <= n; k += stride) {
				const m = at(c.start + Math.min(k, c.duration));
				if (m < lo) lo = m;
				if (m > hi) hi = m;
			}
			if (!fin(lo) || !fin(hi)) continue;
			const stream = (c as { channels?: { streamIndex?: unknown } }).channels?.streamIndex;
			out.push({
				clipId: c.id,
				mediaId,
				trackId: c.trackId,
				streamIndex: Number.isSafeInteger(stream) && (stream as number) >= 0 ? (stream as number) : null,
				mediaStartSec: Math.max(0, lo / FLICKS_PER_SECOND),
				mediaEndSec: Math.max(0, hi / FLICKS_PER_SECOND),
			});
		}
		return out;
	} catch {
		return [];
	}
}

/** Frames `[start, end)` of `clip` whose media time is inside the voiced regions. */
function voicedFrames(
	c: Clip,
	rate: Rational,
	regions: ReadonlyArray<readonly [number, number]>,
): [number, number][] {
	const rs = regions
		.slice(0, MAX_VOICE_REGIONS)
		.filter((r) => Array.isArray(r) && fin(r[0]) && fin(r[1]) && r[1] > r[0])
		.map((r) => [r[0], r[1]] as [number, number])
		.sort((a, b) => a[0] - b[0]);
	if (!rs.length) return [];
	const inside = (s: number) => {
		let lo = 0;
		let hi = rs.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const r = rs[mid]!;
			if (s < r[0]) hi = mid - 1;
			else if (s >= r[1]) lo = mid + 1;
			else return true;
		}
		return false;
	};
	const at = clipMediaTimeFn(c as unknown as TimedClip, rate);
	const out: [number, number][] = [];
	const n = Math.min(c.duration, MAX_VOICE_SCAN_FRAMES);
	let run = -1;
	for (let k = 0; k <= n; k++) {
		const f = c.start + k;
		// a frame is voiced when the media time it shows (the renderers' frame mapping) is voiced
		const on = k < n && inside(at(f) / FLICKS_PER_SECOND);
		if (on && run < 0) run = f;
		else if (!on && run >= 0) {
			out.push([run, f]);
			run = -1;
		}
	}
	return out;
}

/**
 * The dialogue stretches of a sequence (sorted, disjoint, padded and bridged), with who speaks and what found them.
 * `voice`: the engine's voice activity of dialogue clips (`dialogueVadClips`); a clip it does not cover falls back to
 * its whole span. Never throws.
 */
export function dialogueSpans(
	doc: ProjectDocument,
	seq: Sequence,
	opts: { voice?: VoiceActivity | null } = {},
): DialogueSpan[] {
	try {
		const rate = rateOf(seq);
		if (!rate) return [];
		const fps = rate.num / rate.den;
		const F = flicksPerFrame(rate);
		const pad = Math.round(DIALOGUE_PAD_SEC * fps);
		const bridge = Math.round(DIALOGUE_BRIDGE_SEC * fps);
		type Piece = { start: number; end: number; clipId: string; trackId: string; source: DialogueSource };
		const pieces: Piece[] = [];
		const words = safeWords(doc, seq);
		const transcribed = new Set(words.map((w) => w.clipId));
		for (const w of words) {
			const c = seq.clips[w.clipId];
			pieces.push({
				start: Math.floor(w.start / F) - pad,
				end: Math.ceil(w.end / F) + pad,
				clipId: w.clipId,
				trackId: c?.trackId ?? '',
				source: 'words',
			});
		}
		const voice = opts.voice && typeof opts.voice === 'object' ? opts.voice : null;
		for (const c of dialogueClips(seq)) {
			if (transcribed.has(c.id)) continue;
			const regions = voice && Object.hasOwn(voice, c.id) ? voice[c.id] : undefined;
			if (Array.isArray(regions)) {
				for (const [a, b] of voicedFrames(c, rate, regions))
					pieces.push({
						start: Math.max(c.start, a - pad),
						end: Math.min(clipEnd(c), b + pad),
						clipId: c.id,
						trackId: c.trackId,
						source: 'vad',
					});
			} else
				pieces.push({ start: c.start, end: clipEnd(c), clipId: c.id, trackId: c.trackId, source: 'clip' });
		}
		pieces.sort((a, b) => a.start - b.start || a.end - b.end);
		const out: DialogueSpan[] = [];
		for (const p of pieces) {
			const last = out[out.length - 1];
			if (last && p.start <= last.end + bridge) {
				last.end = Math.max(last.end, p.end);
				if (!last.clipIds.includes(p.clipId)) last.clipIds.push(p.clipId);
				if (p.trackId && !last.trackIds.includes(p.trackId)) last.trackIds.push(p.trackId);
				if (!last.sources.includes(p.source)) last.sources.push(p.source);
			} else
				out.push({
					start: p.start,
					end: p.end,
					clipIds: [p.clipId],
					trackIds: p.trackId ? [p.trackId] : [],
					sources: [p.source],
				});
		}
		return out;
	} catch {
		return [];
	}
}

/** The frame ranges of `dialogueSpans` (`[start, end)` pairs). */
export function dialogueFrameRanges(
	doc: ProjectDocument,
	seq: Sequence,
	opts: { voice?: VoiceActivity | null } = {},
): Array<[number, number]> {
	return dialogueSpans(doc, seq, opts).map((s) => [s.start, s.end]);
}
