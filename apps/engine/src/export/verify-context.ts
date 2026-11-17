// Export verification context (spec 18 AF-VER-001; docs/wp-notes/agent-footage-verify.md "What an export records").
// A finished export writes `verify.json` next to its output: what it was asked to write (container, streams, frame
// rate, loudness normalisation) and the picture cuts of the sequence range it rendered, with what the timeline
// intends on each side of every cut (black: a gap, a dark solid, a fade or a dip transition; an effect: a transition or
// a graphic / adjustment layer over the cut; whether the sound has an edit on the cut's frame or plays straight
// through it). `verify_export` judges the file against it later, whatever the document
// has become since. Pure except for the file helpers at the end.
import { join } from 'node:path';
import { EXPORT_CONTAINERS, MAX_EXPORT_RANGES } from '@jasper/api';
import {
	analyzePictureCuts,
	type Clip,
	type ProjectDocument,
	type SyntheticSource,
	syntheticPicture,
	trackLabel,
	type UncoveredRange,
	uncoveredPicture,
} from '@jasper/project';
import { z } from 'zod';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';

export const VERIFY_CONTEXT_FILE = 'verify.json';
/** Most cuts recorded per export (a longer cut list is truncated and the cut rows say so). */
export const MAX_VERIFY_CUTS = 5000;
/** Most uncovered (no-picture) ranges recorded per export. */
export const MAX_VERIFY_UNCOVERED = 500;
/** Most hidden track labels recorded per uncovered range. */
export const MAX_VERIFY_HIDDEN = 32;
/** Most offline-media spans recorded per export. */
export const MAX_VERIFY_OFFLINE = 200;
/** Least frame coverage of a picture layer the verification cut list follows (the cut map's minimum). */
export const VERIFY_CUT_COVERAGE = 0.01;
/** Frames on each side of a cut searched for an effect (transition, graphic or adjustment layer) over it. */
const EFFECT_WINDOW_FRAMES = 3;
/** A solid at most this bright (Rec. 709 luma of its colour × its alpha) is intended black. */
const DARK_SOLID_LUMA = 16 / 255;
/** Transition effects that pass through black (a dip): black on both sides of their cut is intended. */
const DARK_TRANSITION_RE = /black|dip|fade/i;

const RationalSchema = z.object({ num: z.number().int().positive(), den: z.number().int().positive() });

export const VerifyCutSchema = z.object({
	/** Sequence frame of the first frame of the new picture. */
	frame: z.number().int().min(0),
	kind: z.enum(['cut', 'jump', 'overlay']),
	/** The timeline intends black (or near black) before / from the cut. */
	blackBefore: z.boolean(),
	blackAfter: z.boolean(),
	/** A transition or a graphic / adjustment layer is over the cut: a flash there may be designed. */
	effect: z.boolean(),
	/** Frames from the file's start (sequence rate) where it is; absent = `frame − range.start` (`fileOffsetOf`). */
	at: z.number().int().min(0).optional(),
	/**
	 * The sound plays straight through the cut: no audible audio clip starts or ends on its frame, so the samples there
	 * are the source's own and `cut-click` does not judge them (a plosive under a picture-only cut is not an edit).
	 * Absent: the sound has an edit there (a join of several ranges always has), or the build did not record it.
	 */
	soundThrough: z.literal(true).optional(),
});
export type VerifyCut = z.infer<typeof VerifyCutSchema>;

const FrameSpanSchema = z
	.object({ start: z.number().int().min(0), end: z.number().int().min(1) })
	.refine((r) => r.end > r.start, 'empty range');

export const ExportVerifyContextSchema = z.object({
	/** 2 = a multi-range export (`pieces`, `at`): a build that reads only 1 then verifies nothing instead of misreading. */
	version: z.union([z.literal(1), z.literal(2)]),
	projectId: z.string().max(200).optional(),
	sequenceId: z.string().max(200),
	/** What the export wrote (AF-EXP): a video file, a GIF (picture only) or an audio-only file. Absent = video. */
	deliverable: z.enum(['video', 'gif', 'audio']).optional(),
	/** Sequence frames `[start, end)` the export rendered (several ranges: their span). */
	range: FrameSpanSchema,
	/**
	 * export/ranges.ts: the sequence ranges joined into the file, in file order (absent = `range` alone). Cuts and
	 * uncovered frames then carry `at`, and every join is a cut.
	 */
	pieces: z.array(FrameSpanSchema).min(2).max(MAX_EXPORT_RANGES).optional(),
	/** The sequence rate (range, cut frames and timecodes); the file's own rate is `expected.video.frameRate`. */
	fps: RationalSchema,
	dropFrame: z.boolean(),
	startTimecodeFrames: z.number().int().min(0),
	expected: z.object({
		container: z.enum(EXPORT_CONTAINERS),
		video: z
			.object({
				/** ffprobe codec name (`h264`, `hevc`, `vp9`, `av1`, `prores`, `gif`). */
				codec: z.string().max(40),
				width: z.number().int().positive(),
				height: z.number().int().positive(),
				frameRate: RationalSchema,
				/** Frames written (a GIF's frame count is exact: `gifFrames`). */
				frames: z.number().int().min(1).optional(),
				/** The pixel format the encoder was given (null = not known). */
				pixFmt: z.string().max(40).nullable(),
				alpha: z.boolean(),
			})
			.nullable(),
		audio: z
			.object({
				/** ffprobe codec name (`aac`, `opus`, `pcm_s16le`, `pcm_s24le`). */
				codec: z.string().max(40),
				sampleRate: z.number().int().positive(),
				channels: z.number().int().min(1).max(64),
				/** Bits per sample of a WAV / FLAC (16 or 24). */
				bitDepth: z.number().int().min(8).max(32).optional(),
			})
			.nullable(),
	}),
	/** The export's loudness normalisation (null = off). */
	normalize: z.object({ targetLufs: z.number(), truePeakDb: z.number() }).nullable(),
	/**
	 * The mix the encoder was given, of an export delivered as mixed (normalisation off): its true peak, where its worst
	 * over is (seconds from the file's start) and its integrated loudness. Row `pre-encode-peak`; absent = not
	 * recorded (normalised, no audio, or an older build).
	 */
	preEncodePeak: z
		.object({
			truePeakDbtp: z.number(),
			atSec: z.number().min(0).nullable(),
			integratedLufs: z.number().nullable(),
		})
		.optional(),
	cuts: z.array(VerifyCutSchema).max(MAX_VERIFY_CUTS),
	/** Why the cut list is incomplete or missing (cut rows are then `unverified` / say so). */
	cutsNote: z.string().max(500).optional(),
	/**
	 * Sequence frames `[start, end)` of the range with no picture on any shown video track (they render black, with
	 * at most graphics over it); `audible`: audio plays under them. Absent = not recorded (an older build).
	 */
	uncovered: z
		.array(
			z.object({
				start: z.number().int().min(0),
				end: z.number().int().min(1),
				audible: z.boolean(),
				/** As a cut's `at`. */
				at: z.number().int().min(0).optional(),
				/**
				 * Labels ("V1") of the video tracks whose output (eye) was off with picture over part of the range
				 * (`uncoveredPicture`'s `hidden`), at most MAX_VERIFY_HIDDEN; absent = none, or an older build.
				 */
				hidden: z.array(z.string().max(40)).min(1).max(MAX_VERIFY_HIDDEN).optional(),
				/** Hidden tracks past the ones listed. */
				hiddenMore: z.number().int().min(1).optional(),
			}),
		)
		.max(MAX_VERIFY_UNCOVERED)
		.optional(),
	/** More uncovered ranges than recorded. */
	uncoveredMore: z.number().int().min(1).optional(),
	/**
	 * S03:RND-032: sequence frames `[start, end)` where the render drew a clip whose media was offline (the "Media
	 * Offline" card; `sound`: an audio clip, silent). The plan refuses offline media, so an export of this build
	 * records `[]`; absent = not recorded (an older build).
	 */
	offline: z
		.array(
			z.object({
				start: z.number().int().min(0),
				end: z.number().int().min(1),
				clipId: z.string().max(200),
				name: z.string().max(200),
				mediaId: z.string().max(200),
				sound: z.boolean(),
				/** As a cut's `at`. */
				at: z.number().int().min(0).optional(),
			}),
		)
		.max(MAX_VERIFY_OFFLINE)
		.optional(),
	/** More offline spans than recorded. */
	offlineMore: z.number().int().min(1).optional(),
});
export type ExportVerifyContext = z.infer<typeof ExportVerifyContextSchema>;

/** Frames from the file's start (sequence rate) of a cut or uncovered run the context records. */
export function fileOffsetOf(
	ctx: Pick<ExportVerifyContext, 'range'>,
	x: { start?: number; frame?: number; at?: number | undefined },
): number {
	return x.at ?? (x.frame ?? x.start ?? ctx.range.start) - ctx.range.start;
}

/** Frames (sequence rate) the export rendered: the range, or the joined ranges added up. */
export function renderedFrames(ctx: Pick<ExportVerifyContext, 'range' | 'pieces'>): number {
	return ctx.pieces ? ctx.pieces.reduce((n, p) => n + p.end - p.start, 0) : ctx.range.end - ctx.range.start;
}

/** The sequence frame the file shows `offset` frames (sequence rate) from its start. */
export function sequenceFrameAt(ctx: Pick<ExportVerifyContext, 'range' | 'pieces'>, offset: number): number {
	if (!ctx.pieces) return ctx.range.start + offset;
	let left = offset;
	for (const p of ctx.pieces) {
		if (left < p.end - p.start) return p.start + left;
		left -= p.end - p.start;
	}
	const last = ctx.pieces[ctx.pieces.length - 1]!;
	return last.end - 1;
}

/** ffprobe's name of an export audio encoder. */
export function probeAudioCodecName(encoder: string): string {
	return encoder === 'libopus' ? 'opus' : encoder;
}

type Seq = ProjectDocument['sequences'][string];

function shownVideoTrackIds(seq: Seq): Set<string> {
	return new Set(seq.videoTracks.filter((t) => t.output !== false).map((t) => t.id));
}

function solidLuma(doc: ProjectDocument, clip: Clip | undefined): number | null {
	if (clip?.kind !== 'solid') return null;
	const syn = doc.synthetics?.[(clip as { syntheticId?: string }).syntheticId ?? ''] as
		| SyntheticSource
		| undefined;
	const pic = syntheticPicture(syn);
	if (!('color' in pic)) return null;
	const [r, g, b, a] = pic.color;
	const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return Number.isFinite(luma) && Number.isFinite(a) ? luma * a : null;
}

/** One-sided transitions (fades) on a clip, and dip-to-black transitions at its edges. */
function fadesOn(seq: Seq, clipId: string | undefined): boolean {
	if (!clipId) return false;
	for (const t of Object.values(seq.transitions ?? {})) {
		const touches = t.outgoingClipId === clipId || t.incomingClipId === clipId;
		if (!touches) continue;
		if (t.outgoingClipId === null || t.incomingClipId === null) return true;
		if (DARK_TRANSITION_RE.test(t.effectId)) return true;
	}
	return false;
}

/** A graphic, adjustment or other non-picture visual layer over `[from, to)` on a shown video track. */
function effectLayerOver(
	doc: ProjectDocument,
	seq: Seq,
	from: number,
	to: number,
	skip: Set<string>,
): boolean {
	const shown = shownVideoTrackIds(seq);
	for (const c of Object.values(seq.clips)) {
		if (skip.has(c.id) || c.enabled === false || !shown.has(c.trackId)) continue;
		if (c.start >= to || c.start + c.duration <= from) continue;
		if (c.kind === 'video' || c.kind === 'still' || c.kind === 'animated-image' || c.kind === 'nest-video')
			continue;
		if (c.kind === 'solid') {
			const syn = doc.synthetics?.[(c as { syntheticId?: string }).syntheticId ?? ''];
			if (syn?.kind !== 'adjustment') continue;
		}
		return true;
	}
	return false;
}

/**
 * The picture cuts of `[range.start, range.end)` with what the timeline intends around each one (see the file
 * comment). Cuts on the range's first frame are not inside the file and are left out. Never throws: a cut map that
 * cannot be computed returns no cuts and a note.
 */
export function verifyCutsOf(
	doc: ProjectDocument,
	sequenceId: string,
	range: { start: number; end: number },
): { cuts: VerifyCut[]; note?: string } {
	const seq = doc.sequences?.[sequenceId];
	if (!seq) return { cuts: [], note: `Sequence ${sequenceId} is not in the exported document` };
	let analysed: ReturnType<typeof analyzePictureCuts>;
	try {
		// every picture layer counts, however small (a 640 × 360 clip in a 1080p frame covers 11 %): the cut map's
		// default 50 % overlay coverage would hide the cuts of footage that does not fill the frame
		analysed = analyzePictureCuts(doc, sequenceId, {
			range: { start: range.start, end: range.end },
			overlayCoverage: VERIFY_CUT_COVERAGE,
		});
	} catch (e) {
		return { cuts: [], note: `The cut map could not be computed: ${(e as Error).message}`.slice(0, 500) };
	}
	const cuts: VerifyCut[] = [];
	let truncated = false;
	for (const c of analysed.cuts) {
		if (c.frame <= range.start || c.frame >= range.end) continue;
		if (cuts.length >= MAX_VERIFY_CUTS) {
			truncated = true;
			break;
		}
		const out = c.outgoingClipId ? seq.clips[c.outgoingClipId] : undefined;
		const inc = c.incomingClipId ? seq.clips[c.incomingClipId] : undefined;
		const outLuma = solidLuma(doc, out);
		const incLuma = solidLuma(doc, inc);
		const transition = c.transitionId ? seq.transitions?.[c.transitionId] : undefined;
		const dip = !!transition && DARK_TRANSITION_RE.test(transition.effectId);
		const fade = fadesOn(seq, c.outgoingClipId) || fadesOn(seq, c.incomingClipId) || dip;
		const skip = new Set([c.outgoingClipId, c.incomingClipId].filter((x): x is string => !!x));
		cuts.push({
			frame: c.frame,
			kind: c.kind,
			blackBefore: !c.outgoingClipId || (outLuma !== null && outLuma < DARK_SOLID_LUMA) || fade,
			blackAfter: !c.incomingClipId || (incLuma !== null && incLuma < DARK_SOLID_LUMA) || fade,
			effect:
				!!c.transitionId ||
				effectLayerOver(doc, seq, c.frame - EFFECT_WINDOW_FRAMES, c.frame + EFFECT_WINDOW_FRAMES, skip),
		});
	}
	const warn = analysed.warnings.find((w) => w.code === 'sampled' || w.code === 'nest-work-limit');
	const note = truncated
		? `Only the first ${MAX_VERIFY_CUTS} cuts are checked`
		: warn
			? `The cut map is approximate: ${warn.message}`.slice(0, 500)
			: undefined;
	return note ? { cuts, note } : { cuts };
}

export async function writeVerifyContext(dir: string, ctx: ExportVerifyContext): Promise<void> {
	await atomicWriteJson(join(dir, VERIFY_CONTEXT_FILE), ctx);
}

/** The context an export recorded, or null (an export of an older build, or an unreadable file). */
export async function readVerifyContext(dir: string): Promise<ExportVerifyContext | null> {
	let raw: unknown;
	try {
		raw = await readJsonOrNull(join(dir, VERIFY_CONTEXT_FILE));
	} catch {
		return null;
	}
	const parsed = ExportVerifyContextSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/** What `finishExport` knows about a finished export (a slice of `PlannedExport`). */
export type VerifyContextSource = {
	document: ProjectDocument;
	sequenceId: string;
	range: { start: number; end: number };
	output: {
		width: number;
		height: number;
		fps: { num: number; den: number };
		audioChannels: number;
		audioSampleRate: number;
		normalize: { targetLufs: number; truePeakDb: number } | null;
		videoOnly?: boolean | undefined;
		alpha?: boolean | undefined;
		encoder: { container: 'mp4' | 'webm' | 'mov'; codec: string } | null;
	};
	/**
	 * AF-EXP: a GIF (its rate, size and frames as written) or an audio-only file (container, ffmpeg encoder, bit depth);
	 * absent = the video file `output` describes.
	 */
	deliverable?:
		| { kind: 'gif'; fps: number; width: number; height: number; frames: number }
		| { kind: 'audio'; container: 'wav' | 'flac' | 'm4a'; codec: string; bitDepth?: number | undefined };
	/** The encoder's input pixel format (`pixFmtFor`), null when not known. */
	pixFmt: string | null;
	/** The ffmpeg audio encoder written (`aac`, `libopus`, `pcm_s24le`…), null without audio. */
	audioEncoder: string | null;
	/** export/ranges.ts: the ranges a multi-range export joined, in file order (`range` is their span). */
	pieces?: readonly { start: number; end: number }[];
	/** The clips the render drew with offline media (`media-guard.ts` `offlineUsesOf`); absent = not known. */
	offline?: readonly OfflineSpan[];
	/** The un-normalised mix's true peak, its place and loudness (`preEncodePeak`); absent = not known / normalised. */
	preEncodePeak?: NonNullable<ExportVerifyContext['preEncodePeak']>;
	/**
	 * Sequence frames where an audible audio clip of the render starts or ends (`soundEditsOf`); a cut on any other frame
	 * is `soundThrough`. Absent = not known (no cut is marked).
	 */
	soundEdits?: ReadonlySet<number>;
};

/** The frames where the render's sound has an edit: every audible audio clip's first and one-past-last frame. */
export function soundEditsOf(
	snapshots: readonly { audioClips: readonly { start: number; duration: number }[] }[],
): Set<number> {
	const out = new Set<number>();
	for (const s of snapshots)
		for (const c of s.audioClips) {
			out.add(c.start);
			out.add(c.start + c.duration);
		}
	return out;
}

/** `cuts` with `soundThrough` on those whose frame is not a sound edit (unchanged when the edits are not known). */
function markSoundThrough(cuts: VerifyCut[], edits: ReadonlySet<number> | undefined): VerifyCut[] {
	if (!edits) return cuts;
	return cuts.map((c) => (edits.has(c.frame) ? c : { ...c, soundThrough: true as const }));
}

export type OfflineSpan = NonNullable<ExportVerifyContext['offline']>[number];

/** The offline spans of the parts the file holds (no picture in an audio file, no sound in a picture-only one), capped. */
function offlineOf(s: VerifyContextSource): Pick<ExportVerifyContext, 'offline' | 'offlineMore'> {
	if (!s.offline) return {};
	const picture = s.deliverable?.kind !== 'audio';
	const sound = s.deliverable?.kind !== 'gif' && !s.output.videoOnly && !s.output.alpha;
	const kept = s.offline
		.filter((u) => (u.sound ? sound : picture))
		.map((u) => ({
			...u,
			clipId: u.clipId.slice(0, 200),
			name: u.name.slice(0, 200),
			mediaId: u.mediaId.slice(0, 200),
		}));
	return {
		offline: kept.slice(0, MAX_VERIFY_OFFLINE),
		...(kept.length > MAX_VERIFY_OFFLINE ? { offlineMore: kept.length - MAX_VERIFY_OFFLINE } : {}),
	};
}

/**
 * The cuts and uncovered frames of a multi-range export: each range's own, placed where the range starts in the file
 * (`at`), and a cut at every join — black is intended on a side of it where the timeline has no picture.
 */
function joinedCutsOf(
	doc: ProjectDocument,
	sequenceId: string,
	seq: Seq | undefined,
	pieces: readonly { start: number; end: number }[],
	withUncovered: boolean,
	soundEdits: ReadonlySet<number> | undefined,
): Pick<ExportVerifyContext, 'cuts' | 'cutsNote' | 'uncovered' | 'uncoveredMore'> {
	const cuts: VerifyCut[] = [];
	const notes = new Set<string>();
	const uncovered: NonNullable<ExportVerifyContext['uncovered']> = [];
	let more = 0;
	const noPicture = (f: number) => !!seq && uncoveredPicture(doc, seq, { start: f, end: f + 1 }).length > 0;
	let at = 0;
	pieces.forEach((p, i) => {
		if (i > 0)
			cuts.push({
				frame: p.start,
				kind: 'cut',
				blackBefore: noPicture(pieces[i - 1]!.end - 1),
				blackAfter: noPicture(p.start),
				effect: false,
				at,
			});
		const own = verifyCutsOf(doc, sequenceId, p);
		if (own.note) notes.add(own.note);
		for (const c of markSoundThrough(own.cuts, soundEdits)) cuts.push({ ...c, at: at + c.frame - p.start });
		if (seq && withUncovered)
			for (const r of uncoveredPicture(doc, seq, p)) {
				if (uncovered.length < MAX_VERIFY_UNCOVERED)
					uncovered.push({ ...recordedUncovered(seq, r), at: at + r.start - p.start });
				else more++;
			}
		at += p.end - p.start;
	});
	if (cuts.length > MAX_VERIFY_CUTS) notes.add(`Only the first ${MAX_VERIFY_CUTS} cuts are checked`);
	const note = [...notes].join('; ').slice(0, 500);
	return {
		cuts: cuts.slice(0, MAX_VERIFY_CUTS),
		...(note ? { cutsNote: note } : {}),
		...(withUncovered && seq ? { uncovered, ...(more ? { uncoveredMore: more } : {}) } : {}),
	};
}

/** An uncovered range as verify.json records it: hidden tracks by label (the document may change later), capped. */
function recordedUncovered(
	seq: Seq,
	r: UncoveredRange,
): NonNullable<ExportVerifyContext['uncovered']>[number] {
	const { hidden, ...rest } = r;
	if (!hidden?.length) return rest;
	const labels = hidden.map((id) => (trackLabel(seq, id) ?? id).slice(0, 40));
	return {
		...rest,
		hidden: labels.slice(0, MAX_VERIFY_HIDDEN),
		...(labels.length > MAX_VERIFY_HIDDEN ? { hiddenMore: labels.length - MAX_VERIFY_HIDDEN } : {}),
	};
}

/** The range's frames with no picture (structure/uncovered.ts), capped. */
export function uncoveredOf(
	doc: ProjectDocument,
	seq: Seq,
	range: { start: number; end: number },
): Pick<ExportVerifyContext, 'uncovered' | 'uncoveredMore'> {
	const all = uncoveredPicture(doc, seq, range);
	return {
		uncovered: all.slice(0, MAX_VERIFY_UNCOVERED).map((r) => recordedUncovered(seq, r)),
		...(all.length > MAX_VERIFY_UNCOVERED ? { uncoveredMore: all.length - MAX_VERIFY_UNCOVERED } : {}),
	};
}

/** The verification context of a finished export (see the file comment). */
export function buildVerifyContext(s: VerifyContextSource): ExportVerifyContext {
	const seq = s.document.sequences?.[s.sequenceId];
	const o = s.output;
	const seqFps = seq?.settings.frameRate;
	const fps = seqFps && seqFps.num > 0 && seqFps.den > 0 ? seqFps : o.fps;
	// a transparent master's empty frames are meant (alpha); an audio file has no picture
	const withUncovered = s.deliverable?.kind !== 'audio' && !s.output.alpha;
	const joined = s.pieces && s.pieces.length > 1 ? s.pieces : null;
	const marks = joined
		? joinedCutsOf(s.document, s.sequenceId, seq, joined, withUncovered, s.soundEdits)
		: (() => {
				const { cuts, note } = verifyCutsOf(s.document, s.sequenceId, s.range);
				return {
					cuts: markSoundThrough(cuts, s.soundEdits),
					...(note ? { cutsNote: note } : {}),
					...(seq && withUncovered ? uncoveredOf(s.document, seq, s.range) : {}),
				};
			})();
	const common = {
		version: joined ? (2 as const) : (1 as const),
		...(typeof s.document.projectId === 'string' ? { projectId: s.document.projectId } : {}),
		sequenceId: s.sequenceId,
		range: { start: s.range.start, end: s.range.end },
		...(joined ? { pieces: joined.map((p) => ({ start: p.start, end: p.end })) } : {}),
		fps: { num: fps.num, den: fps.den },
		dropFrame: seq?.settings.dropFrame === true,
		startTimecodeFrames: Math.max(0, Math.trunc(seq?.settings.startTimecodeFrames ?? 0)),
		...marks,
		...offlineOf(s),
	};
	const d = s.deliverable;
	if (d?.kind === 'gif')
		return {
			...common,
			deliverable: 'gif',
			expected: {
				container: 'gif',
				video: {
					codec: 'gif',
					width: d.width,
					height: d.height,
					frameRate: rationalOf(d.fps),
					frames: d.frames,
					pixFmt: null,
					alpha: false,
				},
				audio: null,
			},
			normalize: null,
		};
	if (d?.kind === 'audio')
		return {
			...common,
			deliverable: 'audio',
			expected: {
				container: d.container,
				video: null,
				audio: {
					codec: probeAudioCodecName(d.codec),
					sampleRate: o.audioSampleRate,
					channels: o.audioChannels,
					...(d.bitDepth ? { bitDepth: d.bitDepth } : {}),
				},
			},
			normalize: o.normalize,
			...preEncodeOf(s),
		};
	return {
		...common,
		deliverable: 'video',
		expected: {
			container: o.encoder?.container ?? 'mp4',
			video: o.encoder
				? {
						codec: o.encoder.codec,
						width: o.width,
						height: o.height,
						frameRate: { num: o.fps.num, den: o.fps.den },
						pixFmt: s.pixFmt,
						alpha: o.alpha === true,
					}
				: null,
			audio:
				s.audioEncoder && !o.videoOnly && !o.alpha
					? {
							codec: probeAudioCodecName(s.audioEncoder),
							sampleRate: o.audioSampleRate,
							channels: o.audioChannels,
						}
					: null,
		},
		normalize: o.videoOnly || o.alpha ? null : o.normalize,
		...(o.videoOnly || o.alpha ? {} : preEncodeOf(s)),
	};
}

/** The recorded pre-encode peak of an un-normalised mix (finite numbers only). */
function preEncodeOf(s: VerifyContextSource): Pick<ExportVerifyContext, 'preEncodePeak'> {
	const p = s.preEncodePeak;
	if (!p || s.output.normalize || !Number.isFinite(p.truePeakDbtp)) return {};
	const finite = (x: number | null) => (x !== null && Number.isFinite(x) ? x : null);
	return {
		preEncodePeak: {
			truePeakDbtp: p.truePeakDbtp,
			atSec: p.atSec !== null && Number.isFinite(p.atSec) && p.atSec >= 0 ? p.atSec : null,
			integratedLufs: finite(p.integratedLufs),
		},
	};
}

/** A frame rate as an exact rational (12.5 → 25/2, 15 → 15/1; millesimal precision). */
export function rationalOf(fps: number): { num: number; den: number } {
	let num = Math.round(fps * 1000);
	let den = 1000;
	const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
	const g = gcd(num, den) || 1;
	num /= g;
	den /= g;
	return num > 0 ? { num, den } : { num: 30, den: 1 };
}
