// The music's beat grid where it plays, and the stop-before that ends on its bar line (spec 12 §4 P6-E11 "stop on the
// bar"; wp-note sound-design "final carry-over cleanup", item 5). One rule for every path that sets a stop-before: the
// plan job (its stops), the editor's cue menu (Stop Before Next) and MCP `set_sound_cues {stopBefore}`. The beats come
// from the engine's beat analysis (`POST /api/audio/beats`, cached per file and range); `musicBeatRequest` builds the
// request the plan and the cue route analyse, so a cached analysis is found again by the cue menu and agents.
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset } from '../schema/media.ts';
import type { Sequence } from '../schema/sequence.ts';
import { soundDesignSettingsOf } from '../schema/sound.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import { frameAtContent } from '../time-remap/model.ts';
import { type EngineSourceClip, musicClips } from './cues/engine-sources.ts';
import { resolveSoundStyle } from './grammar.ts';
import { STOP_BEFORE_DEFAULT, STOP_ON_BAR_WINDOW_SEC, stopOnBar } from './mix.ts';

/** A music clip's beats and downbeats where they play (sequence flicks), inside the clip's frames `[start, end)`. */
export type MusicGrid = { clipId: string; start: number; end: number; beats: number[]; downbeats: number[] };

/** The beat analysis request of a music clip's media range (±1 s, on a half-second grid: shared cache entries). */
export function musicBeatRequest(
	mediaKey: string,
	c: Pick<EngineSourceClip, 'mediaStartSec' | 'mediaEndSec'>,
	timeSignature?: number | 'auto',
): { mediaKey: string; startSeconds: number; durationSeconds: number; timeSignature?: number } {
	const lo = Math.max(0, Math.floor((c.mediaStartSec - 1) * 2) / 2);
	const hi = Math.ceil((c.mediaEndSec + 1) * 2) / 2;
	return {
		mediaKey,
		startSeconds: lo,
		durationSeconds: Math.min(30 * 60, Math.max(0.5, hi - lo)),
		...(timeSignature !== undefined && timeSignature !== 'auto' ? { timeSignature } : {}),
	};
}

/** The engine-store key of a media (what the engine's analyses are keyed by), or null. */
export function engineMediaKey(asset: Pick<MediaAsset, 'locators'> | undefined): string | null {
	const l = asset?.locators?.find((x) => x.type === 'engine-store');
	return l && l.type === 'engine-store' ? l.key : null;
}

/**
 * The music's grid from beat analyses by clip id (media seconds), mapped through each clip's content time (speed,
 * reverse, time remap): only the attacks the clip plays. Pure.
 */
export function musicGridOf(
	doc: ProjectDocument,
	seq: Sequence,
	results: ReadonlyMap<string, { beats: readonly number[]; downbeats: readonly number[] | null }>,
): MusicGrid[] {
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const out: MusicGrid[] = [];
	for (const mc of musicClips(doc, seq)) {
		const r = results.get(mc.clipId);
		const c = seq.clips[mc.clipId];
		if (!r || !c) continue;
		const where = (sec: number): number | null => {
			if (!Number.isFinite(sec)) return null;
			const f = frameAtContent(c, sec * FLICKS_PER_SECOND, rate);
			return f >= c.start && f < c.start + c.duration ? f * F : null;
		};
		const map = (xs: readonly number[] | null | undefined) =>
			(xs ?? []).map(where).filter((x): x is number => x !== null);
		out.push({
			clipId: mc.clipId,
			start: c.start,
			end: c.start + c.duration,
			downbeats: map(r.downbeats),
			beats: map(r.beats),
		});
	}
	return out;
}

/**
 * The grid of the music clips already analysed (`cached` answers null for one that is not: it is not analysed here).
 * Every Essential Sound music clip of the sequence is asked for with `musicBeatRequest`. Never throws on a lookup.
 */
export async function cachedMusicGrid(
	doc: ProjectDocument,
	seq: Sequence,
	cached: (
		req: ReturnType<typeof musicBeatRequest>,
	) => Promise<{ beats: readonly number[]; downbeats: readonly number[] | null } | null>,
	opts: { timeSignature?: number | 'auto'; maxClips?: number } = {},
): Promise<MusicGrid[]> {
	const results = new Map<string, { beats: readonly number[]; downbeats: readonly number[] | null }>();
	for (const c of musicClips(doc, seq).slice(0, opts.maxClips ?? 32)) {
		const key = engineMediaKey(doc.media[c.mediaId]);
		if (!key) continue;
		try {
			const r = await cached(musicBeatRequest(key, c, opts.timeSignature));
			if (r) results.set(c.clipId, r);
		} catch {
			// an unreachable or unanalysed clip: no bar lines from it
		}
	}
	return musicGridOf(doc, seq, results);
}

/** Whether the sequence's sound design style puts stop-befores on the bar line (`stopOnBar`, default on). */
export function sequenceStopsOnBar(seq: Sequence): boolean {
	return resolveSoundStyle(soundDesignSettingsOf(seq).style).stopOnBar;
}

/**
 * Where the stop-before of a hit at `frame` ends its ramp on the music under it (P6-E11): the last downbeat (else beat)
 * 0.1 s … `window` s before the hit among the music clips playing there, or null (the plain stop). `window` is the
 * cue's own `stopBefore.seconds` when it has one, else the plan's 0.5 s stop-down window. Pure.
 */
export function stopBeforeOnBar(
	seq: Sequence,
	frame: number,
	window: number,
	music: readonly MusicGrid[],
): { seconds: number; on: 'downbeat' | 'beat'; at: number } | null {
	if (!music.length) return null;
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const lo = frame * F - window * FLICKS_PER_SECOND;
	const under = music.filter((m) => m.start * F < frame * F && m.end * F > lo);
	return stopOnBar(
		frame,
		window,
		{ downbeats: under.flatMap((m) => m.downbeats), beats: under.flatMap((m) => m.beats) },
		rate,
	);
}

/**
 * The stop-before a cue gets when one is asked for: `spec` (default Stop Before Next: 0.25 s at −24 dB), its seconds
 * moved so the ramp ends on the bar line when the style's `stopOnBar` is on and the music under it has analysed beats.
 * `explicit`: the seconds were given (an agent's `{seconds}`): they are the window, as the plan treats a cue's own
 * stop; otherwise the plan's 0.5 s stop-down window. Pure.
 */
export function stopBeforeFor(
	seq: Sequence,
	frame: number,
	music: readonly MusicGrid[],
	spec: { seconds: number; depthDb: number } = STOP_BEFORE_DEFAULT,
	opts: { explicit?: boolean } = {},
): { stopBefore: { seconds: number; depthDb: number }; on: 'downbeat' | 'beat' | null } {
	const plain = { stopBefore: { seconds: spec.seconds, depthDb: spec.depthDb }, on: null };
	if (!sequenceStopsOnBar(seq)) return plain;
	const bar = stopBeforeOnBar(seq, frame, opts.explicit ? spec.seconds : STOP_ON_BAR_WINDOW_SEC, music);
	return bar ? { stopBefore: { seconds: bar.seconds, depthDb: spec.depthDb }, on: bar.on } : plain;
}
