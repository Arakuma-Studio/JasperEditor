// Ambience and room-tone beds (spec 12 §4 P6-E12; wp-note "Phase 6 → WP-E8"). Pure; never throws for a document it is
// given (hostile values give empty results). The engine measures the recordings (`@jasper/audio-fx` loop-window.ts);
// this module decides where the beds go and how the pieces are laid:
//
//   bedScenes          the picture's scene structure a bed follows: one scene per stretch of the sequence between scene
//                      changes — a V1 cut to OTHER footage (a cut between two clips of the same media is a shot run of
//                      one place), a chapter / segmentation marker or a marker named "Scene…", a shot change measured
//                      inside footage (the engine's cached Scene Edit Detection); a scene under 2 s joins the one before
//                      (or the next one, when that starts only at a measured shot change).
//   planBedLayout      the pieces of each scene's bed: the loop [a, b) of the bed's media (whole frames) repeated with
//                      crossfades of X frames centred on each joint (the outgoing piece plays the loop's tail [b − X, b],
//                      the incoming one its head [a, a + X]: the very stretches the loop points were matched on), the
//                      first piece of a scene ending at the loop's end and the last starting at its start, so every
//                      joint inside a scene is the matched one; a short crossfade of S frames at each scene change, fades
//                      in and out where a bed starts and stops. The crossfade is shortened (never under 2 frames) only
//                      when a loop is too short for it (W ≥ max(2X, X + S_in + S_out)).
//   dialogueRegions    dialogue spans (`dialogueSpans`) closer than 10 s joined: where a silence is a hole in a scene.
//   dialogueGaps       the holes between dialogue clips inside a region: where room tone goes.
//   roomToneSpans      a gap padded under its neighbours so the fill is at full level over the whole gap.
import { sequenceWords } from '../captions/sequence-transcript.ts';
import { clipEnd, sequenceDuration } from '../derive/index.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import { dialogueClipsOf, dialogueSpans, type VoiceActivity } from './cues/dialogue.ts';

/** Defaults of `soundDesign.layBed` for ambience (spec 12 P6-E12; earshot `mix.py`: 1.5 s loop crossfade, 1 s fades). */
export const AMBIENCE_BED_DEFAULTS = {
	fadeSec: 1,
	crossfadeSec: 1.5,
	/** "a short crossfade at scene changes" (decision: half a second). */
	sceneCrossfadeSec: 0.5,
	/** Scenes shorter than this join the one before (s). */
	minSceneSec: 2,
	trackName: 'Ambience',
	/** Ducking under dialogue: Essential Sound's ambience "Reduce by" (−10 dB) and Premiere's 800 ms fade. */
	duckDialogueDb: -10,
	duckDialogueFadeMs: 800,
	/** Ducking under heroes (decision): −6 dB with 150 ms ramps around each hero sound's clip. */
	duckHeroesDb: -6,
	duckHeroesFadeMs: 150,
} as const;

/** Room tone (spec 12 P6-E12 "a gap of < 10 s between dialogue"). */
export const ROOM_TONE_DEFAULTS = {
	/** Dialogue closer than this is one scene: a silence between is a hole to fill (s). */
	maxGapSec: 10,
	/** The shortest hole worth filling (s). */
	minGapSec: 0.1,
	/** Fades of a fill, and how far it reaches under the dialogue on both sides (s): full level over the whole gap. */
	fadeSec: 0.25,
	padSec: 0.25,
	trackName: 'Room Tone',
	/** A fill never plays quieter than this (dBFS RMS): it is never itself a silence (Sound Check SILENCE is −60). */
	minLevelDbfs: -56,
} as const;

/** Most shots one `soundDesign.layBed` lays. */
export const BED_MAX_SHOTS = 500;
/** Most pieces one bed command lays (a 4 h sequence over a 3 s loop at 60 fps fits). */
export const BED_MAX_PIECES = 20_000;

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function rateOf(seq: Sequence): Rational | null {
	const r = seq?.settings?.frameRate as Rational | undefined;
	return r && Number.isSafeInteger(r.num) && Number.isSafeInteger(r.den) && r.num > 0 && r.den > 0 ? r : null;
}

const validClip = (c: unknown): c is Clip =>
	!!c &&
	typeof c === 'object' &&
	Number.isSafeInteger((c as Clip).start) &&
	Number.isSafeInteger((c as Clip).duration) &&
	(c as Clip).duration > 0 &&
	(c as Clip).start >= 0 &&
	typeof (c as Clip).trackId === 'string';

// ── scenes ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type BedSceneReason = 'start' | 'edit' | 'marker' | 'shot';
export type BedScene = {
	start: number;
	end: number;
	/** What starts it: the range start, a cut to other footage, a marker, a measured shot change. */
	reason: BedSceneReason;
	/** The V1 clip's name at its start, or the marker's name. */
	label: string;
	/** The media V1 shows at its start (null: none, or a graphic). */
	mediaId: string | null;
};
export type BedSceneSources = { edits?: boolean; markers?: boolean };

/** A marker that starts a scene: a chapter or segmentation marker, or one whose name starts with "Scene". */
export function isSceneMarker(m: { type?: unknown; name?: unknown }): boolean {
	return (
		m?.type === 'chapter' ||
		m?.type === 'segmentation' ||
		(typeof m?.name === 'string' && /^\s*(scene|escena)\b/i.test(m.name))
	);
}

/** The clips of the lowest video track, by start. */
function v1Clips(seq: Sequence): Clip[] {
	const v1 = Array.isArray(seq?.videoTracks) ? seq.videoTracks[0] : undefined;
	if (!v1) return [];
	return Object.values(seq.clips ?? {})
		.filter((c) => validClip(c) && c.trackId === v1.id)
		.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
}

const sourceKey = (c: Clip): string => {
	const m = (c as { mediaId?: unknown }).mediaId;
	return typeof m === 'string' ? `m:${m}` : `c:${c.id}`;
};

/**
 * The scenes of a sequence (or of `range`) a bed follows: see the module docs. `sources` default edits and markers;
 * `shotCuts` are measured shot-change frames (the engine's). Sorted, contiguous, covering the range. Never throws.
 */
export function bedScenes(
	doc: ProjectDocument,
	seq: Sequence,
	opts: {
		range?: { start: number; end: number };
		sources?: BedSceneSources;
		shotCuts?: readonly number[];
		minSceneSec?: number;
	} = {},
): BedScene[] {
	try {
		const rate = rateOf(seq);
		if (!rate) return [];
		const fps = rate.num / rate.den;
		const total = sequenceDuration(seq);
		const r0 = opts.range && fin(opts.range.start) ? Math.max(0, Math.round(opts.range.start)) : 0;
		const r1 = opts.range && fin(opts.range.end) ? Math.min(total, Math.round(opts.range.end)) : total;
		if (!(r1 > r0)) return [];
		const edits = opts.sources?.edits ?? true;
		const markers = opts.sources?.markers ?? true;
		const clips = v1Clips(seq);
		const at = (f: number) => clips.find((c) => c.start <= f && f < clipEnd(c)) ?? null;
		const cuts = new Map<number, { reason: BedSceneReason; label: string }>();
		const put = (f: number, reason: BedSceneReason, label: string) => {
			if (!fin(f) || f <= r0 || f >= r1 || cuts.has(f)) return;
			cuts.set(Math.round(f), { reason, label });
		};
		if (markers)
			for (const m of Array.isArray(seq.markers) ? seq.markers : [])
				if (isSceneMarker(m) && Number.isSafeInteger(m.frame)) put(m.frame, 'marker', String(m.name ?? ''));
		if (edits) {
			let prev: Clip | null = null;
			for (const c of clips) {
				if (prev && sourceKey(prev) !== sourceKey(c)) put(c.start, 'edit', String(c.name ?? ''));
				prev = c;
			}
		}
		for (const f of Array.isArray(opts.shotCuts) ? opts.shotCuts : [])
			if (fin(f)) put(Math.round(f), 'shot', String(at(Math.round(f))?.name ?? ''));
		const frames = [...cuts.keys()].sort((a, b) => a - b);
		const first = at(r0);
		const out: BedScene[] = [];
		let start = r0;
		let info: { reason: BedSceneReason; label: string } = { reason: 'start', label: String(first?.name ?? '') };
		for (const f of [...frames, r1]) {
			const c = at(start);
			const mediaId = (c as { mediaId?: unknown } | null)?.mediaId;
			out.push({
				start,
				end: f,
				reason: info.reason,
				label: info.label || String(c?.name ?? ''),
				mediaId: typeof mediaId === 'string' ? mediaId : null,
			});
			start = f;
			info = cuts.get(f) ?? { reason: 'edit', label: '' };
		}
		// a short scene joins a neighbour: the next one when that one only starts at a measured shot change (the cut or
		// marker before is the stronger boundary), else the one before (the first joins the next)
		const minFrames = Math.max(
			1,
			Math.round(
				(fin(opts.minSceneSec) && opts.minSceneSec >= 0 ? opts.minSceneSec : AMBIENCE_BED_DEFAULTS.minSceneSec) * fps,
			),
		);
		const merged: BedScene[] = out.map((s) => ({ ...s }));
		let i = 0;
		while (i < merged.length && merged.length > 1) {
			const s = merged[i]!;
			if (s.end - s.start >= minFrames) {
				i++;
				continue;
			}
			const prev = i > 0 ? merged[i - 1] : undefined;
			const next = merged[i + 1];
			const intoNext = !!next && (!prev || next.reason === 'shot');
			if (intoNext) {
				next.start = s.start;
				next.reason = s.reason;
				next.label = s.label;
				next.mediaId = s.mediaId;
			} else if (prev) prev.end = s.end;
			merged.splice(i, 1);
			// the scene it joined is checked again (it may still be short)
			if (!intoNext) i = Math.max(0, i - 1);
		}
		return merged;
	} catch {
		return [];
	}
}

// ── layout ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** One shot of a bed: its frames, its media and the loop of the media it repeats (content flicks). */
export type BedShotInput = {
	start: number;
	end: number;
	mediaId: string;
	/** The media's length (flicks): the loop is kept inside it. */
	mediaFlicks: number;
	loop: { inFlicks: number; outFlicks: number };
};

export type BedLayoutPiece = {
	/** Index of its shot in the input, and of the piece in its shot. */
	shot: number;
	piece: number;
	start: number;
	frames: number;
	sourceInFlicks: number;
	mediaId: string;
};

export type BedLayoutJoin = {
	/** The cut (sequence frame) the crossfade is centred on. */
	at: number;
	frames: number;
	kind: 'loop' | 'scene';
	shot: number;
};

export type BedLayoutRun = {
	/** Indices of its shots (contiguous ones form one run). */
	shots: number[];
	pieces: BedLayoutPiece[];
	joins: BedLayoutJoin[];
	/** Fade-in at the run's first frame and fade-out at its last (frames, 0 = none). */
	fadeIn: number;
	fadeOut: number;
};

export type BedLayout = {
	runs: BedLayoutRun[];
	/** The loop crossfade each shot got (frames) — shorter than asked when its loop is short (`shortened`). */
	crossfades: number[];
	shortened: number[];
	pieces: number;
};

export type BedLayoutOptions = {
	fps: Rational;
	crossfadeFrames: number;
	sceneCrossfadeFrames: number;
	fadeFrames: number;
};

export type BedLayoutResult =
	| { ok: true; layout: BedLayout }
	| { ok: false; code: 'E_INVALID_PARAM' | 'E_LIMIT'; message: string; shot?: number };

/**
 * Lays the pieces of the beds of `shots` (sorted, not overlapping): see the module docs. Every piece plays inside
 * its shot's loop, including the handles its crossfades read; every crossfade fits inside both of its clips.
 */
export function planBedLayout(shots: readonly BedShotInput[], o: BedLayoutOptions): BedLayoutResult {
	const F = flicksPerFrame(o.fps);
	if (!(F > 0)) return { ok: false, code: 'E_INVALID_PARAM', message: 'The sequence has no frame rate' };
	const X0 = Math.max(2, Math.round(o.crossfadeFrames));
	const S0 = Math.max(0, Math.round(o.sceneCrossfadeFrames));
	const fade = Math.max(0, Math.round(o.fadeFrames));
	const n = shots.length;
	const W: number[] = [];
	for (let i = 0; i < n; i++) {
		const s = shots[i]!;
		if (!(Number.isSafeInteger(s.start) && Number.isSafeInteger(s.end) && s.start >= 0 && s.end - s.start >= 2))
			return { ok: false, code: 'E_INVALID_PARAM', message: `Shot ${i + 1} needs at least 2 frames`, shot: i };
		if (i > 0 && s.start < shots[i - 1]!.end)
			return {
				ok: false,
				code: 'E_INVALID_PARAM',
				message: `Shot ${i + 1} overlaps shot ${i} (shots must be in order, without overlaps)`,
				shot: i,
			};
		const a = Math.max(0, Math.round(s.loop.inFlicks));
		const b = Math.min(Math.round(s.mediaFlicks), Math.round(s.loop.outFlicks));
		const w = Math.floor((b - a) / F + 1e-9);
		if (!(w >= 4))
			return {
				ok: false,
				code: 'E_INVALID_PARAM',
				message: `Shot ${i + 1}: the loop of its media is shorter than 4 frames`,
				shot: i,
			};
		W.push(w);
	}
	// scene crossfades at contiguous boundaries: at most half the shorter shot and a quarter of either loop
	const sceneIn: number[] = new Array(n).fill(0);
	const sceneOut: number[] = new Array(n).fill(0);
	for (let i = 1; i < n; i++) {
		if (shots[i]!.start !== shots[i - 1]!.end) continue;
		const la = shots[i - 1]!.end - shots[i - 1]!.start;
		const lb = shots[i]!.end - shots[i]!.start;
		const s = Math.min(S0, Math.floor(Math.min(la, lb) / 2), Math.floor(W[i - 1]! / 4), Math.floor(W[i]! / 4));
		if (s >= 1) {
			sceneOut[i - 1] = s;
			sceneIn[i] = s;
		}
	}
	const crossfades: number[] = [];
	const shortened: number[] = [];
	const runs: BedLayoutRun[] = [];
	let total = 0;
	for (let i = 0; i < n; i++) {
		const s = shots[i]!;
		const w = W[i]!;
		const a = Math.max(0, Math.round(s.loop.inFlicks));
		const Sin = sceneIn[i]!;
		const Sout = sceneOut[i]!;
		const s1 = Sin >> 1; // handle before the In point the incoming half of the scene crossfade reads
		const s2 = Sout - (Sout >> 1); // handle after the Out point the outgoing half reads
		const X = Math.max(2, Math.min(X0, Math.floor(w / 2), w - Sin - Sout));
		if (X < X0) shortened.push(i);
		crossfades.push(X);
		const h1 = X >> 1;
		const h2 = X - h1;
		const nFull = w - X;
		const L = s.end - s.start;
		const minF = h1 + (Sin - s1);
		const minL = h2 + (Sout >> 1);
		const fmax = w - h2 - s1;
		const lmax = w - h1 - s2;
		const lengths: { frames: number; sourceIn: number }[] = [];
		if (L <= w - s1 - s2) lengths.push({ frames: L, sourceIn: a + s1 * F });
		else {
			// the fewest pieces: m − 2 full middle pieces, a first piece ending at the loop's end and a last one starting
			// at its start, both between their minimum (their crossfades fit) and maximum (their handles stay in the loop)
			const m = L > fmax + lmax ? 2 + Math.ceil((L - fmax - lmax) / nFull) : 2;
			if (total + m > BED_MAX_PIECES)
				return {
					ok: false,
					code: 'E_LIMIT',
					message: `The beds would need more than ${BED_MAX_PIECES} pieces: lay them over a shorter range or use a longer loop`,
					shot: i,
				};
			const R = L - (m - 2) * nFull;
			const lower = Math.max(minF, R - lmax);
			const upper = Math.min(fmax, R - minL);
			if (lower > upper)
				return {
					ok: false,
					code: 'E_INVALID_PARAM',
					message: `Shot ${i + 1} cannot be looped with a ${X}-frame crossfade (its loop is ${w} frames)`,
					shot: i,
				};
			const f = Math.min(upper, Math.max(lower, Math.ceil(R / 2)));
			lengths.push({ frames: f, sourceIn: a + (w - h2 - f) * F });
			for (let k = 0; k < m - 2; k++) lengths.push({ frames: nFull, sourceIn: a + h1 * F });
			lengths.push({ frames: R - f, sourceIn: a + h1 * F });
		}
		total += lengths.length;
		if (total > BED_MAX_PIECES)
			return {
				ok: false,
				code: 'E_LIMIT',
				message: `The beds would need more than ${BED_MAX_PIECES} pieces: lay them over a shorter range or use a longer loop`,
				shot: i,
			};
		const contiguous = i > 0 && s.start === shots[i - 1]!.end;
		let run = runs[runs.length - 1];
		if (!run || !contiguous) {
			run = { shots: [], pieces: [], joins: [], fadeIn: 0, fadeOut: 0 };
			runs.push(run);
		}
		run.shots.push(i);
		if (contiguous && Sin > 0) run.joins.push({ at: s.start, frames: Sin, kind: 'scene', shot: i });
		let t = s.start;
		lengths.forEach((p, k) => {
			if (k > 0) run!.joins.push({ at: t, frames: X, kind: 'loop', shot: i });
			run!.pieces.push({
				shot: i,
				piece: k,
				start: t,
				frames: p.frames,
				sourceInFlicks: Math.round(p.sourceIn),
				mediaId: s.mediaId,
			});
			t += p.frames;
		});
	}
	// fades where a run starts and stops, inside the first / last piece and clear of its other crossfade
	for (const run of runs) {
		const first = run.pieces[0]!;
		const last = run.pieces[run.pieces.length - 1]!;
		const tailUse = (p: BedLayoutPiece) => {
			const j = run.joins.find((x) => x.at === p.start + p.frames);
			return j ? j.frames >> 1 : 0;
		};
		const headUse = (p: BedLayoutPiece) => {
			const j = run.joins.find((x) => x.at === p.start);
			return j ? j.frames - (j.frames >> 1) : 0;
		};
		if (first === last) {
			const room = first.frames - headUse(first) - tailUse(first);
			run.fadeIn = Math.max(0, Math.min(fade, Math.floor(room / 2)));
			run.fadeOut = Math.max(0, Math.min(fade, room - run.fadeIn));
		} else {
			run.fadeIn = Math.max(0, Math.min(fade, first.frames - tailUse(first)));
			run.fadeOut = Math.max(0, Math.min(fade, last.frames - headUse(last)));
		}
	}
	return { ok: true, layout: { runs, crossfades, shortened, pieces: total } };
}

// ── dialogue regions and gaps ───────────────────────────────────────────────────────────────────────────────────

export type DialogueRegion = { start: number; end: number; clipIds: string[] };

/**
 * Dialogue spans closer than `maxGapSec` (default 10 s) joined: the scenes where dialogue goes on, so a silence inside
 * one is a hole (spec 12 P6-E12 "a gap of < 10 s between dialogue"). `voice`: the engine's voice activity. Never throws.
 */
export function dialogueRegions(
	doc: ProjectDocument,
	seq: Sequence,
	opts: { voice?: VoiceActivity | null; maxGapSec?: number } = {},
): DialogueRegion[] {
	try {
		const rate = rateOf(seq);
		if (!rate) return [];
		const gap = Math.round(
			(fin(opts.maxGapSec) && opts.maxGapSec >= 0 ? opts.maxGapSec : ROOM_TONE_DEFAULTS.maxGapSec) *
				(rate.num / rate.den),
		);
		const out: DialogueRegion[] = [];
		for (const s of dialogueSpans(doc, seq, opts.voice ? { voice: opts.voice } : {})) {
			const last = out[out.length - 1];
			if (last && s.start - last.end < gap) {
				last.end = Math.max(last.end, s.end);
				for (const id of s.clipIds) if (!last.clipIds.includes(id)) last.clipIds.push(id);
			} else out.push({ start: s.start, end: s.end, clipIds: [...s.clipIds] });
		}
		return out;
	} catch {
		return [];
	}
}

/** Whether `[start, end)` lies inside a dialogue region (strictly between its first and last dialogue). */
export function insideDialogueRegion(regions: readonly DialogueRegion[], start: number, end: number): DialogueRegion | null {
	return regions.find((r) => start >= r.start && end <= r.end) ?? null;
}

export type DialogueGap = {
	start: number;
	end: number;
	/** The dialogue clips before and after it. */
	beforeClipId: string;
	afterClipId: string;
};

/**
 * The holes between dialogue clips (Essential Sound dialogue, or clips with transcript words) inside dialogue
 * regions: frames no dialogue clip plays, at least `minGapSec` (0.1 s) and under `maxGapSec` (10 s) long, within
 * `range`. Never throws.
 */
export function dialogueGaps(
	doc: ProjectDocument,
	seq: Sequence,
	opts: { range?: { start: number; end: number }; maxGapSec?: number; minGapSec?: number } = {},
): DialogueGap[] {
	try {
		const rate = rateOf(seq);
		if (!rate) return [];
		const fps = rate.num / rate.den;
		const ids = new Set(dialogueClipsOf(seq).map((c) => c.id));
		try {
			for (const w of sequenceWords(doc, seq)) if (seq.clips[w.clipId]) ids.add(w.clipId);
		} catch {
			// no transcript: the typed clips
		}
		const clips = [...ids]
			.map((id) => seq.clips[id])
			.filter(validClip)
			.sort((a, b) => a.start - b.start || clipEnd(a) - clipEnd(b));
		const maxGap = Math.round(
			(fin(opts.maxGapSec) && opts.maxGapSec > 0 ? opts.maxGapSec : ROOM_TONE_DEFAULTS.maxGapSec) * fps,
		);
		const minGap = Math.max(
			1,
			Math.round((fin(opts.minGapSec) && opts.minGapSec >= 0 ? opts.minGapSec : ROOM_TONE_DEFAULTS.minGapSec) * fps),
		);
		const r0 = opts.range && fin(opts.range.start) ? opts.range.start : 0;
		const r1 = opts.range && fin(opts.range.end) ? opts.range.end : Number.POSITIVE_INFINITY;
		const out: DialogueGap[] = [];
		let reach = -1;
		let lastClip: Clip | null = null;
		for (const c of clips) {
			if (lastClip && c.start > reach) {
				const g = c.start - reach;
				if (g >= minGap && g < maxGap && reach >= r0 && c.start <= r1)
					out.push({ start: reach, end: c.start, beforeClipId: lastClip.id, afterClipId: c.id });
			}
			if (clipEnd(c) > reach) {
				reach = clipEnd(c);
				lastClip = c;
			}
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * The span a room-tone fill of `gap` covers: padded by `padSec` under the dialogue on both sides (within the
 * sequence's frame 0), so its fades happen under the voice and the gap itself is at full level.
 */
export function roomToneSpan(
	gap: { start: number; end: number },
	fps: Rational,
	padSec: number = ROOM_TONE_DEFAULTS.padSec,
): { start: number; end: number } {
	const pad = Math.max(0, Math.round((fin(padSec) ? padSec : 0) * (fps.num / fps.den)));
	return { start: Math.max(0, gap.start - pad), end: gap.end + pad };
}

/** Joins spans that touch or overlap (sorted): one fill per stretch. */
export function mergeSpans(spans: readonly { start: number; end: number }[]): { start: number; end: number }[] {
	const sorted = [...spans].filter((s) => fin(s.start) && fin(s.end) && s.end > s.start).sort((a, b) => a.start - b.start);
	const out: { start: number; end: number }[] = [];
	for (const s of sorted) {
		const last = out[out.length - 1];
		if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
		else out.push({ start: s.start, end: s.end });
	}
	return out;
}

/**
 * The gain that puts a room tone (window level `toneDbfs`, RMS) at the dialogue's noise floor (`floorDbfs` plus the
 * dialogue clip's gain), never under `ROOM_TONE_DEFAULTS.minLevelDbfs`, within −40…+40 dB (0.1 dB steps).
 */
export function roomToneGainDb(toneDbfs: number, floorDbfs: number, clipGainDb = 0): number {
	if (!fin(toneDbfs)) return 0;
	const target = Math.max(
		ROOM_TONE_DEFAULTS.minLevelDbfs,
		(fin(floorDbfs) ? floorDbfs : ROOM_TONE_DEFAULTS.minLevelDbfs) + (fin(clipGainDb) ? clipGainDb : 0),
	);
	const g = Math.max(-40, Math.min(40, target - toneDbfs));
	const r = Math.round(g * 10) / 10;
	return Object.is(r, -0) ? 0 : r;
}
