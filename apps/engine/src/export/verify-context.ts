// Export verification context (spec 18 AF-VER-001; docs/wp-notes/agent-footage-verify.md "What an export records").
// A finished export writes `verify.json` next to its output: what it was asked to write (container, streams, frame
// rate, loudness normalisation) and the picture cuts of the sequence range it rendered, with what the timeline
// intends on each side of every cut (black: a gap, a dark solid, a fade or a dip transition; an effect: a transition or
// a graphic / adjustment layer over the cut). `verify_export` judges the file against it later, whatever the document
// has become since. Pure except for the file helpers at the end.
import { join } from 'node:path';
import {
	analyzePictureCuts,
	type Clip,
	type ProjectDocument,
	type SyntheticSource,
	syntheticPicture,
} from '@jasper/project';
import { z } from 'zod';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';

export const VERIFY_CONTEXT_FILE = 'verify.json';
/** Most cuts recorded per export (a longer cut list is truncated and the cut rows say so). */
export const MAX_VERIFY_CUTS = 5000;
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
});
export type VerifyCut = z.infer<typeof VerifyCutSchema>;

export const ExportVerifyContextSchema = z.object({
	version: z.literal(1),
	projectId: z.string().max(200).optional(),
	sequenceId: z.string().max(200),
	/** Sequence frames `[start, end)` the export rendered. */
	range: z
		.object({ start: z.number().int().min(0), end: z.number().int().min(1) })
		.refine((r) => r.end > r.start, 'empty range'),
	fps: RationalSchema,
	dropFrame: z.boolean(),
	startTimecodeFrames: z.number().int().min(0),
	expected: z.object({
		container: z.enum(['mp4', 'webm', 'mov']),
		video: z
			.object({
				/** ffprobe codec name (`h264`, `hevc`, `vp9`, `av1`, `prores`). */
				codec: z.string().max(40),
				width: z.number().int().positive(),
				height: z.number().int().positive(),
				frameRate: RationalSchema,
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
			})
			.nullable(),
	}),
	/** The export's loudness normalisation (null = off). */
	normalize: z.object({ targetLufs: z.number(), truePeakDb: z.number() }).nullable(),
	cuts: z.array(VerifyCutSchema).max(MAX_VERIFY_CUTS),
	/** Why the cut list is incomplete or missing (cut rows are then `unverified` / say so). */
	cutsNote: z.string().max(500).optional(),
});
export type ExportVerifyContext = z.infer<typeof ExportVerifyContextSchema>;

/** ffprobe's name of an export audio encoder. */
export function probeAudioCodecName(encoder: string): string {
	return encoder === 'libopus' ? 'opus' : encoder;
}

type Seq = ProjectDocument['sequences'][string];

function shownVideoTrackIds(seq: Seq): Set<string> {
	return new Set(seq.videoTracks.filter((t) => t.output !== false).map((t) => t.id));
}

function solidLuma(doc: ProjectDocument, clip: Clip | undefined): number | null {
	if (!clip || clip.kind !== 'solid') return null;
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
	/** The encoder's input pixel format (`pixFmtFor`), null when not known. */
	pixFmt: string | null;
	/** The ffmpeg audio encoder written (`aac`, `libopus`, `pcm_s24le`…), null without audio. */
	audioEncoder: string | null;
};

/** The verification context of a finished export (see the file comment). */
export function buildVerifyContext(s: VerifyContextSource): ExportVerifyContext {
	const seq = s.document.sequences?.[s.sequenceId];
	const { cuts, note } = verifyCutsOf(s.document, s.sequenceId, s.range);
	const o = s.output;
	return {
		version: 1,
		...(typeof s.document.projectId === 'string' ? { projectId: s.document.projectId } : {}),
		sequenceId: s.sequenceId,
		range: { start: s.range.start, end: s.range.end },
		fps: { num: o.fps.num, den: o.fps.den },
		dropFrame: seq?.settings.dropFrame === true,
		startTimecodeFrames: Math.max(0, Math.trunc(seq?.settings.startTimecodeFrames ?? 0)),
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
		cuts,
		...(note ? { cutsNote: note } : {}),
	};
}
