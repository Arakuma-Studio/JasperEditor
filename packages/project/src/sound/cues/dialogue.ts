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
// Only what the mix lets through counts (wp-note "WP6.5b solver"): a stretch where the gain from the clip to the Mix
// is at or under DIALOGUE_AUDIBLE_DB (−40 dB) is not dialogue — clip gain, clip Volume keyframes, the track's mute
// (static or automated) and Volume automation, solo, the submixes and sends it goes through and the Mix fader, with the
// renderers' own topology (`buildAudioMix`; inserts and clip effects are not evaluated). Padding outside a clip's span
// follows the clip's first / last frame.
//
// Every stretch is padded by DIALOGUE_PAD_SEC and pauses shorter than DIALOGUE_BRIDGE_SEC are bridged, so a cut a
// breath after a sentence still counts as "under dialogue". Never throws ([] on damaged data).
import { buildAudioMix, type RenderAudioMix, type RenderStrip } from '../../audio/plan.ts';
import { sequenceWords } from '../../captions/sequence-transcript.ts';
import { clipEnd, contentTimeAt } from '../../derive/index.ts';
import { evaluate } from '../../keyframes.ts';
import type { Animatable } from '../../schema/common.ts';
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
/**
 * Dialogue the mix plays at or under this gain (dB, from the clip to the Mix) is not heard: not dialogue. −40 dB puts
 * speech mixed at −20 LUFS under −60 LUFS, below any programme's noise floor (decision; EBU R 128 measures with a
 * −70 LUFS absolute gate).
 */
export const DIALOGUE_AUDIBLE_DB = -40;
/** Fader values at or under this are −∞ (the mixer's `dbToGain`). */
const SILENT_FADER_DB = -96;

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

const isAnimated = (a: Animatable<number> | undefined): boolean =>
	!!a && Array.isArray(a.keyframes) && a.keyframes.length > 0;

function valueAt(a: Animatable<number> | undefined, t: number): number {
	if (!a) return 0;
	try {
		const v = isAnimated(a) ? evaluate(a, t) : a.value;
		return fin(v) ? v : 0;
	} catch {
		return fin(a.value) ? a.value : 0;
	}
}

/** dB → energy, with fader-style −∞. */
const energyOf = (db: number): number => (db === Number.NEGATIVE_INFINITY ? 0 : 10 ** (db / 10));

/**
 * Gain (dB) from a strip's input to the Mix output at sequence time `t` (flicks): its fader and mute, then its output
 * and its sends (pre-fader sends skip the fader and mute), summed as energies; −∞ when nothing gets through.
 */
function stripPathDb(
	mix: RenderAudioMix,
	byId: Map<string, RenderStrip>,
	id: string,
	t: number,
	depth = 0,
): number {
	const s = byId.get(id);
	if (!s || s.silent || depth > 64) return Number.NEGATIVE_INFINITY;
	const fader = valueAt(s.volumeDb, t);
	const faderDb = fader <= SILENT_FADER_DB ? Number.NEGATIVE_INFINITY : fader;
	if (s.kind === 'master' || s.output === null) return faderDb;
	const muted = valueAt(s.mute, t) >= 0.5;
	const post = muted ? Number.NEGATIVE_INFINITY : faderDb;
	let e =
		post === Number.NEGATIVE_INFINITY ? 0 : energyOf(post + stripPathDb(mix, byId, s.output, t, depth + 1));
	for (const x of s.sends) {
		const lvl = valueAt(x.levelDb, t);
		if (lvl <= SILENT_FADER_DB) continue;
		const base = x.preFader ? 0 : post;
		if (base === Number.NEGATIVE_INFINITY) continue;
		e += energyOf(base + lvl + stripPathDb(mix, byId, x.target, t, depth + 1));
	}
	return e > 0 ? 10 * Math.log10(e) : Number.NEGATIVE_INFINITY;
}

/** Whether a strip's path to the Mix has automation (else one evaluation holds for every frame). */
function pathAnimated(byId: Map<string, RenderStrip>, id: string, depth = 0): boolean {
	const s = byId.get(id);
	if (!s || depth > 64) return false;
	if (isAnimated(s.volumeDb) || isAnimated(s.mute) || s.sends.some((x) => isAnimated(x.levelDb))) return true;
	return (
		(s.output !== null && pathAnimated(byId, s.output, depth + 1)) ||
		s.sends.some((x) => pathAnimated(byId, x.target, depth + 1))
	);
}

/**
 * Frames `[start, end)` of `c` the mix plays over DIALOGUE_AUDIBLE_DB, as sorted runs; a run touching the clip's first
 * (last) frame extends to −∞ (+∞) so padding outside the clip follows its edge. Null: audible throughout.
 */
function audibleRuns(
	c: Clip,
	rate: Rational,
	mix: RenderAudioMix | null,
	byId: Map<string, RenderStrip>,
): [number, number][] | null {
	const a = c as Clip & {
		gainDb?: unknown;
		volumeDb?: Animatable<number>;
		channels?: { map?: unknown; mute?: unknown };
	};
	const ch = a.channels;
	if (
		ch &&
		Array.isArray(ch.map) &&
		Array.isArray(ch.mute) &&
		ch.map.length > 0 &&
		ch.map.every((_, k) => (ch.mute as unknown[]).includes(k))
	)
		return []; // every channel plays silence
	const gain = fin(a.gainDb) ? a.gainDb : 0;
	const F = flicksPerFrame(rate);
	const volAnim = isAnimated(a.volumeDb);
	const pathAnim = mix ? pathAnimated(byId, c.trackId) : false;
	const clipDb = (f: number): number => {
		const local = Math.min(c.start + c.duration - 1, Math.max(c.start, f));
		return gain + (volAnim ? valueAt(a.volumeDb, contentTimeAt(c, local, rate)) : valueAt(a.volumeDb, 0));
	};
	const routeDb = (f: number): number => (mix ? stripPathDb(mix, byId, c.trackId, f * F) : 0);
	const audible = (f: number): boolean => clipDb(f) + routeDb(f) > DIALOGUE_AUDIBLE_DB;
	if (!volAnim && !pathAnim) return audible(c.start) ? null : [];
	const out: [number, number][] = [];
	const n = Math.min(c.duration, MAX_VOICE_SCAN_FRAMES);
	let run = -1;
	for (let k = 0; k <= n; k++) {
		const f = c.start + k;
		const on = k < n && audible(f);
		if (on && run < 0) run = f;
		else if (!on && run >= 0) {
			out.push([run, f]);
			run = -1;
		}
	}
	if (out.length === 1 && out[0]![0] === c.start && out[0]![1] === c.start + n) return null;
	for (const r of out) {
		if (r[0] === c.start) r[0] = Number.NEGATIVE_INFINITY;
		if (r[1] === c.start + n) r[1] = Number.POSITIVE_INFINITY;
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
		// only what the mix lets through (clip gain and Volume, track mute and Volume automation, solo, routing)
		let mix: RenderAudioMix | null = null;
		try {
			mix = buildAudioMix(seq);
		} catch {
			mix = null;
		}
		const byId = new Map((mix?.strips ?? []).map((s) => [s.id, s] as const));
		const runsOf = new Map<string, [number, number][] | null>();
		const heard: Piece[] = [];
		for (const p of pieces) {
			const c = seq.clips[p.clipId];
			if (!c || !validClip(c)) {
				heard.push(p);
				continue;
			}
			let runs = runsOf.get(c.id);
			if (runs === undefined) {
				runs = audibleRuns(c, rate, mix, byId);
				runsOf.set(c.id, runs);
			}
			if (runs === null) {
				heard.push(p);
				continue;
			}
			for (const [a, b] of runs) {
				const s0 = Math.max(p.start, a);
				const s1 = Math.min(p.end, b);
				if (s1 > s0) heard.push({ ...p, start: s0, end: s1 });
			}
		}
		heard.sort((a, b) => a.start - b.start || a.end - b.end);
		const out: DialogueSpan[] = [];
		for (const p of heard) {
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
