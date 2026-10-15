// Shared helpers of the cue sources: the derivation context, clip and track lookups, pan, names and seconds.
import { clipEnd, clipsOnTrack, trackLabel } from '../../derive/index.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import type { Clip, Sequence, Track } from '../../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../../time.ts';
import type { CueCandidate, CueDeriveSource, DeriveCuesWarning } from './types.ts';

/** Kinds that draw a picture of their own (adjustment layers, cameras, lights and captions do not move "things"). */
const CONTENT_KINDS: ReadonlySet<string> = new Set([
	'video',
	'still',
	'animated-image',
	'text',
	'solid',
	'motion-graphic',
	'composition',
	'nest-video',
	'shape',
	'model',
]);

export function isContentClip(c: Clip): boolean {
	return CONTENT_KINDS.has(c.kind);
}

export type CueContext = {
	doc: ProjectDocument;
	seq: Sequence;
	/** Frames per second (finite, > 0; 30 when the sequence's rate is unusable). */
	fps: number;
	rate: Rational;
	/** Flicks per frame. */
	F: number;
	width: number;
	height: number;
	/** Frame diagonal in pixels (> 0). */
	diag: number;
	/** Sequence duration (frames). */
	duration: number;
	/** Analysed span `[start, end)`. */
	range: { start: number; end: number };
	/** Video tracks that are shown (output on), bottom (V1) first, with their index in `seq.videoTracks`. */
	videoTracks: { track: Track; index: number }[];
	warn(w: DeriveCuesWarning): void;
	/**
	 * Frames the motion sources (keyframes, camera3d) may still sample in this derivation: a document of many long
	 * animated clips (hostile, or just huge) is cut off with a warning instead of blocking the engine / the editor for
	 * minutes and returning gigabytes of speed curves.
	 */
	sampleBudget: { left: number; warned: boolean };
};

/** Most frames sampled by the motion sources in one derivation (≈ 20 clips × 20 000 frames; ≈ 2 s on a busy host). */
export const MAX_SAMPLES_PER_DERIVATION = 400_000;

export function finitePositive(v: unknown, fallback: number): number {
	return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

export function makeContext(
	doc: ProjectDocument,
	seq: Sequence,
	duration: number,
	range: { start: number; end: number },
	warn: (w: DeriveCuesWarning) => void,
): CueContext {
	const fr = seq.settings?.frameRate as Rational | undefined;
	const num = finitePositive(fr?.num, 30);
	const den = finitePositive(fr?.den, 1);
	const fps = finitePositive(num / den, 30);
	const rate: Rational = { num, den } as Rational;
	const width = finitePositive(seq.settings?.width, 1920);
	const height = finitePositive(seq.settings?.height, 1080);
	const videoTracks = (Array.isArray(seq.videoTracks) ? seq.videoTracks : [])
		.map((track, index) => ({ track, index }))
		.filter(({ track }) => track && track.output !== false);
	return {
		doc,
		seq,
		fps,
		rate,
		F: finitePositive(flicksPerFrame(rate), 705_600_000 / 30),
		width,
		height,
		diag: Math.hypot(width, height),
		duration,
		range,
		videoTracks,
		warn,
		sampleBudget: { left: MAX_SAMPLES_PER_DERIVATION, warned: false },
	};
}

/** Enabled content clips of a shown video track, start order. */
export function contentClipsOnTrack(ctx: CueContext, trackId: string): Clip[] {
	return clipsOnTrack(ctx.seq, trackId).filter((c) => c.enabled !== false && isContentClip(c));
}

/** Whether a clip intersects the analysed range. */
export function inRange(ctx: CueContext, c: { start: number; duration: number }): boolean {
	return c.start < ctx.range.end && clipEnd(c) > ctx.range.start;
}

export function label(ctx: CueContext, trackId: string): string {
	return trackLabel(ctx.seq, trackId) ?? 'a track';
}

/** `'Name'` of a clip (quotes, trimmed to 40 characters). */
export function clipName(c: { name?: unknown; kind?: unknown }): string {
	const n = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : String(c.kind ?? 'clip');
	return `'${n.length > 40 ? `${n.slice(0, 39)}…` : n}'`;
}

/** Seconds of a frame count, for reasons ("0.5 s"). */
export function secs(ctx: CueContext, frames: number): string {
	const s = frames / ctx.fps;
	return `${s >= 10 ? s.toFixed(1) : s.toFixed(2).replace(/0$/, '')} s`;
}

/** `pan:'auto'`: on-screen x (sequence pixels) mapped to ±60 (spec 12 §2.2). */
export function panOfX(ctx: CueContext, x: number): number {
	if (!Number.isFinite(x)) return 0;
	const p = ((x / ctx.width) * 2 - 1) * 60;
	return Math.round(Math.min(60, Math.max(-60, p)));
}

export const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Candidate builder with the defaults every source shares. */
export function candidate(
	from: CueDeriveSource,
	c: Omit<CueCandidate, 'from' | 'source' | 'frame'> & { frame: number; source?: CueCandidate['source'] },
): CueCandidate {
	return { source: 'derived', from, ...c, frame: Math.round(c.frame), confidence: clamp01(c.confidence) };
}

/** Grapheme / word / line counts of a text (layout-free: lines are the explicit line breaks). */
export function textUnitCounts(text: string): {
	chars: number;
	charsNoSpace: number;
	words: number;
	lines: number;
} {
	const t = typeof text === 'string' ? text.slice(0, 20_000) : '';
	const graphemes = splitGraphemes(t.replace(/\r?\n/g, ''));
	const charsNoSpace = graphemes.filter((g) => !/^\s+$/u.test(g)).length;
	return {
		chars: graphemes.length,
		charsNoSpace,
		words: t.split(/\s+/u).filter(Boolean).length,
		lines: t.split(/\r?\n/).length,
	};
}

function splitGraphemes(t: string): string[] {
	const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
	if (typeof Seg === 'function')
		return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(t), (s) => s.segment);
	return Array.from(t);
}

/** The sequence's clips in a deterministic order: start, then track, then id. Malformed entries are skipped. */
export function sortedClips(ctx: CueContext): Clip[] {
	const list = Object.values(ctx.seq.clips ?? {}).filter(
		(c): c is Clip =>
			!!c &&
			typeof c === 'object' &&
			typeof c.id === 'string' &&
			Number.isInteger(c.start) &&
			Number.isInteger(c.duration) &&
			c.duration > 0,
	);
	return list.sort(
		(a, b) =>
			a.start - b.start ||
			(a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0) ||
			(a.id < b.id ? -1 : 1),
	);
}
