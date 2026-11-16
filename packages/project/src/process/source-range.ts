// Source ranges of media versions (S07:PRC-015…019): where a file's frames sit in its source, and the content-time
// remap that keeps a clip on exactly the same source frames when it switches to another rendering of the same
// source covering a different range (a processed range with handles, a graded render made for another cut).
//
// Model. Every media has its own content time (flicks from its first frame). A source link
// (`sourceLinkOf`: `MediaAsset.sourceRange` naming a project media, or the identity link of an M2 processed
// version) says that file frame i is frame `firstFrame + i` of the parent. Frames correspond by index, so the
// file, the parent and the counting rate must share the frame rate, and the link is a pure shift of content
// time: t_parent = t_file + firstFrame·F (F = flicks per frame of that rate). Shifts compose along the chain up
// to the root original, so two versions of one original relate by `shift(from) − shift(to)`.
//
// A clip switching files keeps start, duration and speed; everything it stores in content time moves by the
// same shift: `sourceIn`, every keyframe (Motion, opacity, effect parameters), clip markers and tracker samples
// (S01:KF-002 — content time sticks to the picture). Handles (TRN-003) follow from the new `sourceIn` and the
// new file's duration, so transitions and trim limits see what the new file really holds.
import { retargetRotos } from '../roto/index.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset, MediaProbe, SourceRange } from '../schema/media.ts';
import type { TimeRemap } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational, rationalEquals, roundSym } from '../time.ts';
import { activeRemap, clipMediaRange, clipMediaTimeFn } from '../time-remap/model.ts';
import { parseTimecode } from '../timecode.ts';
import { mediaFrameRate } from '../tracking/request.ts';
import { sourceLinkOf } from './versions.ts';

type MediaTable = Pick<ProjectDocument, 'media'>;
type AssetLike = Pick<MediaAsset, 'probe'>;

const EPS = 1e-6;

/** Frames in an asset: the probed duration in frames, rounded (probe durations are microsecond-rounded). */
export function mediaFrameCount(asset: AssetLike | undefined | null): number | null {
	const r = mediaFrameRate(asset);
	const d = asset?.probe.durationFlicks;
	if (!r || d === null || d === undefined) return null;
	return Math.max(0, Math.round(d / flicksPerFrame(r)));
}

/** Flicks of `frames` frames at `rate`, as an integer (exact for every common rate). */
export function frameShiftFlicks(frames: number, rate: Rational): number {
	return roundSym(frames * flicksPerFrame(rate));
}

export type RootPlacement = {
	ok: true;
	/** The original the media is a version of (itself for originals). */
	rootId: string;
	/** Content time in the root = content time in the media + shift (flicks). */
	shift: number;
	/** The same shift in frames of the root's rate (null when the root has no video rate). */
	shiftFrames: number | null;
	/** Media ids from the media up to the root. */
	chain: string[];
};
export type PlacementError = { ok: false; reason: string };

function nameOf(m: Pick<MediaAsset, 'originalName' | 'id'> | undefined, id: string): string {
	return m?.originalName ?? id;
}

/** A rate for a refusal: decimal to 6 places plus the exact rational, so two close rates never print alike. */
const rateDetail = (r: Rational) =>
	r.den === 1 ? `${r.num} fps` : `${(r.num / r.den).toFixed(6)} fps (${r.num}/${r.den})`;

/**
 * True when two probed rates count the same frames one to one over `seconds` (the longer file): they drift apart by
 * less than half a frame. ffprobe's average rate of variable-rate footage (phone video) is frames ÷ duration, so a
 * re-encode with the very same timestamps can report a slightly different rational (S07:PRC-018). Without a
 * duration only exactly equal rates match.
 */
function ratesCorrespond(a: Rational, b: Rational, seconds: number | null): boolean {
	if (rationalEquals(a, b)) return true;
	if (seconds === null || !(seconds > 0) || !Number.isFinite(seconds)) return false;
	const drift = Math.abs(a.num / a.den - b.num / b.den) * seconds;
	return Number.isFinite(drift) && drift < 0.5;
}

const durationSeconds = (...probes: (MediaProbe | undefined)[]): number | null => {
	const ds = probes.map((p) => p?.durationFlicks).filter((d): d is number => typeof d === 'number' && d > 0);
	return ds.length ? Math.max(...ds) / FLICKS_PER_SECOND : null;
};

/**
 * Where a media's content time sits in its root original's content time (S07:PRC-016). Fails when a link
 * cannot be a pure shift (frame rates differ between a file and the source it declares).
 */
export function rootPlacement(doc: MediaTable, mediaId: string): RootPlacement | PlacementError | null {
	const first = doc.media[mediaId] as MediaAsset | undefined;
	if (!first) return null;
	let id = mediaId;
	let shift = 0;
	const chain = [mediaId];
	const seen = new Set([mediaId]);
	for (;;) {
		const m = doc.media[id] as MediaAsset;
		const link = sourceLinkOf(doc, m);
		if (!link || seen.has(link.parentId)) break;
		const parent = doc.media[link.parentId] as MediaAsset;
		if (link.frameRate) {
			const own = mediaFrameRate(m);
			const pr = mediaFrameRate(parent);
			const secs = durationSeconds(m.probe, parent?.probe);
			if (own && !ratesCorrespond(own, link.frameRate, secs))
				return {
					ok: false,
					reason: `${nameOf(m, id)} runs at ${rateDetail(own)} but its source range counts ${nameOf(parent, link.parentId)} frames at ${rateDetail(link.frameRate)} (frames must correspond one to one)`,
				};
			if (pr && !ratesCorrespond(pr, link.frameRate, secs))
				return {
					ok: false,
					reason: `${nameOf(parent, link.parentId)} runs at ${rateDetail(pr)} but ${nameOf(m, id)} counts its frames at ${rateDetail(link.frameRate)}`,
				};
			shift += frameShiftFlicks(link.firstFrame, link.frameRate);
		}
		id = link.parentId;
		seen.add(id);
		chain.push(id);
	}
	const rootRate = mediaFrameRate(doc.media[id] as MediaAsset);
	return {
		ok: true,
		rootId: id,
		shift,
		shiftFrames: rootRate ? Math.round(shift / flicksPerFrame(rootRate)) : null,
		chain,
	};
}

export type VersionShift =
	| { ok: true; rootId: string; shift: number; from: RootPlacement; to: RootPlacement }
	| { ok: false; reason: string; unrelated?: boolean };

/**
 * Content-time shift for a clip switching from `fromId` to `toId` (two versions of one original):
 * t_to = t_from + shift (S07:PRC-016).
 */
export function versionShift(doc: MediaTable, fromId: string, toId: string): VersionShift {
	const a = rootPlacement(doc, fromId);
	const b = rootPlacement(doc, toId);
	if (!a) return { ok: false, reason: `Media not found: ${fromId}`, unrelated: true };
	if (!b) return { ok: false, reason: `Media not found: ${toId}`, unrelated: true };
	if (!a.ok) return a;
	if (!b.ok) return b;
	if (a.rootId !== b.rootId)
		return {
			ok: false,
			unrelated: true,
			reason: `Media ${toId} is not a version of ${a.rootId} (the original of ${fromId})`,
		};
	return { ok: true, rootId: a.rootId, shift: a.shift - b.shift, from: a, to: b };
}

/**
 * The frames of its root original a media holds: `[start, end)` in root frames, or null when unknown (no video
 * rate or duration). For originals this is the whole file.
 */
export function rootFrameSpan(
	doc: MediaTable,
	mediaId: string,
): { rootId: string; start: number; end: number; rate: Rational } | null {
	const p = rootPlacement(doc, mediaId);
	const m = doc.media[mediaId] as MediaAsset | undefined;
	if (!p?.ok || !m) return null;
	const rate = mediaFrameRate(doc.media[p.rootId] as MediaAsset) ?? mediaFrameRate(m);
	const frames = m.sourceRange?.frames ?? mediaFrameCount(m);
	if (!rate || frames === null) return null;
	const start = Math.round(p.shift / flicksPerFrame(rate));
	return { rootId: p.rootId, start, end: start + frames, rate };
}

export type ClipContentTiming = {
	sourceIn: number;
	duration: number;
	speed: { rate: number; reverse: boolean };
	kind?: string;
	timeRemap?: TimeRemap | null;
	start?: number;
};

/** A clip's content timing as if its content moved by `shift` flicks (a switch to another file of the media). */
export function shiftedTiming(clip: ClipContentTiming, shift: number): ClipContentTiming {
	const r = clip.timeRemap;
	return {
		sourceIn: clip.sourceIn + shift,
		duration: clip.duration,
		speed: clip.speed,
		...(clip.kind !== undefined ? { kind: clip.kind } : {}),
		...(r
			? {
					timeRemap: {
						...r,
						keyframes: r.keyframes.map((k) => ({ ...k, time: k.time + shift, source: k.source + shift })),
					},
				}
			: {}),
	};
}

/**
 * Tolerance (flicks) on the end of a file: probe durations are microsecond-rounded (a 130-frame 30 fps file
 * reads 4.333333 s, 235 flicks short), so 1/16 of a file frame — never more than the one-sequence-frame
 * tolerance of INV-005.
 */
export function coverageTolerance(seqRate: Rational, speedRate: number, mediaRate: Rational | null): number {
	const inv = flicksPerFrame(seqRate) * speedRate + 1;
	return mediaRate ? Math.min(inv, flicksPerFrame(mediaRate) / 16) : inv;
}

/**
 * Timeline frames `[from, to)` of a clip (relative to its start) whose content lies inside `[0, duration]` of
 * a file, for content time `sourceIn` (CLP-004, speed and reverse aware). `to - from === clip.duration` when the
 * whole clip is covered; null when no frame is.
 */
export function coveredClipFrames(
	clip: ClipContentTiming,
	seqRate: Rational,
	mediaDuration: number | null,
	tol: number,
): { from: number; to: number } | null {
	if (activeRemap(clip)) {
		// Time-remapped: the frames whose remapped media time lies in the file (the longest run from the start).
		const at = clipMediaTimeFn({ start: 0, ...clip }, seqRate);
		const inside = (f: number) => {
			const m = at(f);
			return m >= -1 && (mediaDuration === null || m < mediaDuration + tol);
		};
		let from = 0;
		while (from < clip.duration && !inside(from)) from++;
		let to = from;
		while (to < clip.duration && inside(to)) to++;
		return to > from ? { from, to } : null;
	}
	const step = flicksPerFrame(seqRate) * clip.speed.rate;
	const d = clip.duration;
	// j = content step index (0 = the frame showing `sourceIn`); its content is [sourceIn + j·step, … + step).
	const jLo = clip.sourceIn >= 0 ? 0 : Math.ceil(-clip.sourceIn / step - EPS);
	const jHi = mediaDuration === null ? d : Math.floor((mediaDuration + tol - clip.sourceIn) / step + EPS); // exclusive
	const lo = Math.max(0, jLo);
	const hi = Math.min(d, jHi);
	if (hi <= lo) return null;
	return clip.speed.reverse ? { from: d - hi, to: d - lo } : { from: lo, to: hi };
}

/** Frames of a file `[first, end)` a clip uses (content time → file frames), for messages and range picks. */
export function clipFileFrames(
	clip: ClipContentTiming,
	seqRate: Rational,
	fileRate: Rational,
): { first: number; end: number } {
	const F = flicksPerFrame(fileRate);
	if (activeRemap(clip)) {
		const r = clipMediaRange({ start: 0, ...clip }, seqRate);
		return { first: Math.floor(r.min / F + EPS), end: Math.floor(r.max / F + EPS) + 1 };
	}
	const span = flicksPerFrame(seqRate) * clip.speed.rate * clip.duration;
	return {
		first: Math.floor(clip.sourceIn / F + EPS),
		end: Math.ceil((clip.sourceIn + span) / F - EPS),
	};
}

type AnimLike = { value: unknown; keyframes: { time: number }[] };
const isAnimLike = (v: unknown): v is AnimLike =>
	!!v && typeof v === 'object' && 'value' in v && Array.isArray((v as { keyframes?: unknown }).keyframes);

function shiftAnimatables(node: unknown, shift: number): void {
	if (!node || typeof node !== 'object') return;
	if (isAnimLike(node)) {
		for (const k of node.keyframes) k.time += shift;
		return;
	}
	if (Array.isArray(node)) {
		for (const x of node) shiftAnimatables(x, shift);
		return;
	}
	for (const [k, v] of Object.entries(node)) {
		if (k === 'trackers' || k === 'markers' || k === 'rotos') continue;
		shiftAnimatables(v, shift);
	}
}

export type ContentShiftReport = {
	/** Clip markers that fell before the new file's first frame (content time < 0) and were removed. */
	droppedMarkers: number;
	/** Tracker samples that fell before the new file's first frame and were removed. */
	droppedTrackerSamples: number;
};

type ShiftableClip = {
	sourceIn: number;
	timeRemap?: { keyframes: { time: number; source: number }[] };
	markers?: { flicks: number }[];
	trackers?: {
		reference: { time: number };
		samples: { start: number; step: number; stride: number; data: number[]; confidence: number[] } | null;
	}[];
};

/**
 * Moves everything a clip stores in content time by `shift` flicks, in place (plain objects or Immer drafts):
 * `sourceIn`, every keyframe of every animatable (Motion, opacity, effect parameters…), clip markers and tracker
 * samples/reference times. Content time cannot be negative for markers and tracker samples: those that fall
 * before the new file's start are removed (counted in the report); keyframes may be negative (KF-006).
 */
export function shiftClipContentTime(clip: ShiftableClip, shift: number): ContentShiftReport {
	const report: ContentShiftReport = { droppedMarkers: 0, droppedTrackerSamples: 0 };
	if (shift === 0) return report;
	clip.sourceIn += shift;
	shiftAnimatables(clip, shift);
	// Speed keyframes anchor content time and media time; both move with the file.
	for (const k of clip.timeRemap?.keyframes ?? []) {
		k.time += shift;
		k.source += shift;
	}
	if (clip.markers) {
		const kept = clip.markers.filter((m) => m.flicks + shift >= 0);
		report.droppedMarkers = clip.markers.length - kept.length;
		for (const m of kept) m.flicks += shift;
		if (report.droppedMarkers) clip.markers.splice(0, clip.markers.length, ...kept);
	}
	// parity (roto): roto frames move with the content time; their computed mattes are dropped.
	retargetRotos((clip as { rotos?: never }).rotos, { shiftFlicks: shift });
	for (const tr of clip.trackers ?? []) {
		tr.reference.time = Math.max(0, tr.reference.time + shift);
		const s = tr.samples;
		if (!s) continue;
		s.start += shift;
		if (s.start < 0) {
			const n = s.confidence.length;
			const k = Math.min(n, Math.ceil(-s.start / s.step));
			report.droppedTrackerSamples += k;
			if (k >= n) {
				tr.samples = null;
				continue;
			}
			s.data.splice(0, k * s.stride);
			s.confidence.splice(0, k);
			s.start += k * s.step;
		}
	}
	return report;
}

export type SourceTimingBasis =
	/** Both files declare a source range of the same source. */
	| 'source-range'
	/** The new file declares a range of a source; the current file is taken to be that source. */
	| 'range-of-current'
	/** The current file declares a range; the new file is taken to be its source (going back to the raw). */
	| 'current-is-range'
	/** Both files carry a start timecode. */
	| 'timecode'
	/**
	 * Neither range nor both timecodes, but the files are equally long (within a frame) at corresponding rates: the
	 * new file holds the same frames from its first one (a re-encode), so content time stays (shift 0).
	 */
	| 'same-length';

export type SourceTimingShift =
	| {
			ok: true;
			/** Content shift in frames: new content time = old + shiftFrames·F. */
			shiftFrames: number;
			frameRate: Rational;
			basis: SourceTimingBasis;
			/** Human explanation, e.g. "T02.json: starts at source frame 174". */
			detail: string;
			/** Something the user should check (a source name that does not match). */
			warning?: string;
	  }
	| { ok: false; reason: string };

type TimingFile = {
	id?: string;
	originalName: string;
	probe: MediaProbe;
	sourceRange?: SourceRange | null;
};

const base = (n: string) => (n.split(/[\\/]/).pop() ?? n).toLowerCase();

function sameSource(a: SourceRange, b: SourceRange): boolean {
	if (a.mediaId || b.mediaId) return a.mediaId === b.mediaId;
	if (a.sourceName && b.sourceName) return base(a.sourceName) === base(b.sourceName);
	return true; // neither names its source: the same unnamed source
}

function timecodeFrames(probe: MediaProbe, rate: Rational): number | null {
	const tc = probe.startTimecode;
	if (!tc) return null;
	return parseTimecode(tc, rate, { dropFrame: tc.includes(';') });
}

/**
 * How far the new file's content time is from the current one's when both show the same source (Replace
 * Footage with "keep source timing", S07:PRC-018). Precedence: declared source ranges (sidecars, processing),
 * then start timecodes. A file without a range next to one with a range is taken to be the source itself
 * (frame 0 = source frame 0), which is how a raw camera file relates to a render of part of it.
 */
export function sourceTimingShift(current: TimingFile, next: TimingFile): SourceTimingShift {
	const rc = mediaFrameRate(current);
	const rn = mediaFrameRate(next);
	const a = current.sourceRange ?? null;
	const b = next.sourceRange ?? null;
	const rate = b?.frameRate ?? a?.frameRate ?? rn ?? rc;
	if (!rate) return { ok: false, reason: 'Neither file has a video frame rate to count source frames with' };
	if (rc && rn && !ratesCorrespond(rc, rn, durationSeconds(current.probe, next.probe)))
		return {
			ok: false,
			reason: `Frame rate differs: ${current.originalName} runs at ${rateDetail(rc)}, ${next.originalName} at ${rateDetail(rn)} (source frames cannot be kept one to one)`,
		};
	if (a && b) {
		if (!rationalEquals(a.frameRate, b.frameRate))
			return {
				ok: false,
				reason: `Source range frame rate differs: ${current.originalName} counts ${rateDetail(a.frameRate)}, ${next.originalName} ${rateDetail(b.frameRate)}`,
			};
		if (!sameSource(a, b))
			return {
				ok: false,
				reason: `The files declare different sources (${a.sourceName ?? a.mediaId} and ${b.sourceName ?? b.mediaId})`,
			};
		return {
			ok: true,
			shiftFrames: a.firstFrame - b.firstFrame,
			frameRate: rate,
			basis: 'source-range',
			detail: `${next.originalName} starts at source frame ${b.firstFrame}; ${current.originalName} at ${a.firstFrame}`,
		};
	}
	if (b) {
		const named = b.sourceName && base(b.sourceName) !== base(current.originalName);
		return {
			ok: true,
			shiftFrames: -b.firstFrame,
			frameRate: rate,
			basis: 'range-of-current',
			detail: `${next.originalName} starts at frame ${b.firstFrame} of ${b.sourceName ?? 'its source'}`,
			...(named
				? {
						warning: `${next.originalName} was rendered from ${b.sourceName}, not ${current.originalName}; ${current.originalName} is taken to be that source`,
					}
				: {}),
		};
	}
	if (a) {
		return {
			ok: true,
			shiftFrames: a.firstFrame,
			frameRate: rate,
			basis: 'current-is-range',
			detail: `${current.originalName} starts at frame ${a.firstFrame} of ${a.sourceName ?? 'its source'}; ${next.originalName} is taken to be that source`,
		};
	}
	const tcA = timecodeFrames(current.probe, rate);
	const tcB = timecodeFrames(next.probe, rate);
	if (tcA !== null && tcB !== null)
		return {
			ok: true,
			shiftFrames: tcA - tcB,
			frameRate: rate,
			basis: 'timecode',
			detail: `Timecode ${next.probe.startTimecode} (new) vs ${current.probe.startTimecode} (current)`,
		};
	// No range and no pair of timecodes: content time counts from each file's first frame (decoders seek relative to
	// the stream start), so equally long files at corresponding rates hold the same frames at the same content time.
	const dc = current.probe.durationFlicks;
	const dn = next.probe.durationFlicks;
	const F = flicksPerFrame(rate);
	if (dc !== null && dn !== null && Math.abs(dc - dn) <= F)
		return {
			ok: true,
			shiftFrames: 0,
			frameRate: rate,
			basis: 'same-length',
			detail: `${next.originalName} and ${current.originalName} are equally long (${secondsText(dn)} and ${secondsText(dc)}): the same frames from the first one`,
		};
	const tcNote = `start timecode ${current.probe.startTimecode ?? 'none'} (current) and ${next.probe.startTimecode ?? 'none'} (new)`;
	return {
		ok: false,
		reason:
			dc !== null && dn !== null
				? `Duration differs: ${current.originalName} lasts ${secondsText(dc)}, ${next.originalName} ${secondsText(dn)} (${Math.round(Math.abs(dc - dn) / F)} frames), and neither file declares its source range (no sidecar) nor do both carry a start timecode (${tcNote}) to place one inside the other`
				: `No source range (sidecar), no pair of start timecodes (${tcNote}) and no known duration of ${dc === null ? current.originalName : next.originalName} to match the files by`,
	};
}

const secondsText = (flicks: number) => `${(flicks / FLICKS_PER_SECOND).toFixed(6)} s`;

/**
 * The frames of media `mediaId` to process for clips (S07:PRC-015 "clip range + handles"): the union of the
 * frames each clip shows — mapped into `mediaId` when a clip is on another version of the same original — plus
 * `handles` frames on both sides, clamped to the file. Null when no clip relates to the media or its length is
 * unknown. `[startFrame, endFrame)` at the media's rate.
 */
export function processRangeForClips(
	doc: MediaTable,
	uses: readonly { clip: ClipContentTiming & { mediaId: string }; seqRate: Rational }[],
	mediaId: string,
	handles: number,
): { startFrame: number; endFrame: number } | null {
	const m = doc.media[mediaId] as MediaAsset | undefined;
	const rate = mediaFrameRate(m);
	const total = mediaFrameCount(m);
	if (!m || !rate || total === null || total < 1) return null;
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const u of uses) {
		const vs =
			u.clip.mediaId === mediaId
				? { ok: true as const, shift: 0 }
				: versionShift(doc, u.clip.mediaId, mediaId);
		if (!vs.ok) continue;
		const f = clipFileFrames({ ...u.clip, sourceIn: u.clip.sourceIn + vs.shift }, u.seqRate, rate);
		lo = Math.min(lo, f.first);
		hi = Math.max(hi, f.end);
	}
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
	const h = Math.max(0, Math.floor(handles));
	const startFrame = Math.max(0, lo - h);
	const endFrame = Math.min(total, hi + h);
	return endFrame > startFrame ? { startFrame, endFrame } : null;
}
