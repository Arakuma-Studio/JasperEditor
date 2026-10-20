// view_sound_timeline (spec 12 §2.10, §4 P6-E7; wp-notes "Phase 5 → WP5.1", "Phase 6 → WP-E3"): ONE PNG of a range
// (≤ 120 s) for an agent that cannot hear — the engine's visual data (`POST /api/sound-design/visual`) drawn as the
// annotated sound sheet: a picture lane of frames rendered through the export path at the cut, cue and event frames
// (≤ 12), the loudness curves of the mix and its stems, the mix's log-frequency spectrogram, the waveform, the sections
// of the listening transcript, the sound effect clips with their aligned points, the cue ticks marked by whether a
// sound answers them, every cut / transition / cue / measured motion by its answer, motion, a check's findings, plus the
// geometry as JSON (`cells`). `buildSoundSheet` is shared with listen_to_sequence {images: true}.
import {
	type EngineJob,
	type SoundListenResult,
	SoundListenResultSchema,
	type SoundVisualResponse,
	SoundVisualResponseSchema,
} from '@jasper/api';
import { type Rational, type Sequence, sequenceTimecode, TimeInputSchema } from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, TIME_FORMATS } from '../arguments.ts';
import {
	cancelIfAborted,
	captureStill,
	defineTool,
	type Extra,
	frameOf,
	type LoadedDoc,
	loadDoc,
	READ_ONLY,
	type ToolContext,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { decodePng, encodePng } from '../png.ts';
import type { RgbaImage } from '../sound-sheet.ts';
import {
	drawSoundTimeline,
	MAX_TIMELINE_THUMBS,
	type TimelineCells,
	type TimelineListen,
	type TimelineThumb,
} from '../sound-timeline.ts';

export const VISUAL_MAX_SEC = 120;
/** Width of each rendered frame of the picture lane (px). */
const THUMB_WIDTH = 160;

const HINTS: Record<string, string> = {
	RANGE_EMPTY: 'The range is outside the sequence: check get_timeline for its length.',
	RANGE_TOO_LONG: 'Ask for a shorter range (view_sound_timeline: ≤ 120 s; listen_to_sequence: ≤ 10 min).',
	JOB_NOT_FOUND: 'checkJobId must be a sound_check job of this project (its jobId).',
	RENDER_FAILED:
		'The mix could not be rendered: check that the media is online (list_offline_media), then try again.',
};

export function toolError(e: unknown): never {
	const err = e as { code?: string; message?: string };
	if (err?.code && HINTS[err.code]) throw new ToolError(err.code, err.message ?? err.code, HINTS[err.code]!);
	throw e;
}

/** Whether the sequence shows any picture in `[start, end)` (a clip on a video track). */
function hasPicture(seq: Sequence, range: { start: number; end: number }): boolean {
	const video = new Set((seq.videoTracks ?? []).map((t) => t.id));
	return Object.values(seq.clips).some(
		(c) => video.has(c.trackId) && c.start < range.end && c.start + c.duration > range.start,
	);
}

/**
 * The frames of the picture lane: the cuts and transitions first, then the cues, then the accents, at most
 * `max`, never two closer than 1/(2·max) of the range, in time order.
 */
export function sheetThumbFrames(
	range: { start: number; end: number },
	listen: TimelineListen | null,
	cues: readonly { frame: number }[],
	max = MAX_TIMELINE_THUMBS,
	accents: readonly { frame: number }[] = [],
): { frame: number; label: string }[] {
	const span = Math.max(1, range.end - range.start);
	const minGap = span / (2 * Math.max(1, max));
	const picks: { frame: number; label: string }[] = [];
	const add = (frame: number, label: string) => {
		if (!Number.isFinite(frame) || frame < range.start || frame >= range.end) return;
		if (picks.length >= max || picks.some((p) => Math.abs(p.frame - frame) < minGap)) return;
		picks.push({ frame: Math.round(frame), label });
	};
	const pics = listen?.pictureEvents ?? [];
	for (const p of pics) if (p.kind === 'cut' || p.kind === 'transition') add(p.frame, p.kind);
	for (const c of cues) add(c.frame, 'cue');
	for (const p of pics) if (p.kind === 'motion') add(p.frame, 'motion');
	for (const a of accents) add(a.frame, 'accent');
	return picks.sort((a, b) => a.frame - b.frame);
}

/** One annotated strip of `range` (≤ 120 s): the visual data, the listening transcript and rendered frames. */
export async function buildSoundSheet(
	ctx: ToolContext,
	extra: Extra,
	loaded: LoadedDoc,
	seq: Sequence,
	a: {
		projectId: string;
		range: { start: number; end: number };
		checkJobId?: string | undefined;
		listen: SoundListenResult | null;
		thumbnails: boolean;
		spectrogram: boolean;
		width?: number | undefined;
		title?: string | undefined;
	},
): Promise<{ image: RgbaImage; cells: TimelineCells; visual: SoundVisualResponse; pictureLane: string }> {
	const visual: SoundVisualResponse = SoundVisualResponseSchema.parse(
		await ctx
			.engine((c) =>
				c.soundVisual(
					{
						projectId: a.projectId,
						sequenceId: seq.id,
						range: a.range,
						...(a.checkJobId ? { checkJobId: a.checkJobId } : {}),
						...(a.spectrogram ? { spectrogram: true } : {}),
					},
					extra.signal,
				),
			)
			.catch(toolError),
	);
	const listen: TimelineListen | null = a.listen
		? { sections: a.listen.sections, pictureEvents: a.listen.pictureEvents }
		: null;
	const thumbs: TimelineThumb[] = [];
	let pictureLane = 'not asked (thumbnails: false)';
	if (a.thumbnails) {
		if (!hasPicture(seq, visual.range)) pictureLane = 'no picture in the range';
		else {
			const accents = (a.listen?.events ?? []).filter((e) => e.accent);
			const picks = sheetThumbFrames(visual.range, listen, visual.cues, MAX_TIMELINE_THUMBS, accents);
			for (const p of picks) {
				const still = await captureStill(
					ctx,
					{ projectId: a.projectId, frame: p.frame, width: THUMB_WIDTH, sequenceId: seq.id },
					extra,
					loaded,
				);
				thumbs.push({
					frame: p.frame,
					image: decodePng(still.bytes),
					label: `${p.label} ${sequenceTimecode(seq, p.frame)}`,
				});
			}
			pictureLane = `${thumbs.length} frame(s) rendered through the export path`;
		}
	}
	const { image, cells } = drawSoundTimeline(visual, {
		...(a.width ? { width: a.width } : {}),
		...(a.title ? { title: a.title } : {}),
		listen,
		thumbs,
	});
	return { image, cells, visual, pictureLane };
}

/** A finished listen job's result (null: not a listen job of this project and sequence, or not finished). */
export async function listenJobResult(
	ctx: ToolContext,
	jobId: string,
	projectId: string,
	sequenceId: string,
): Promise<SoundListenResult> {
	const job = (await ctx.engine((c) => c.getJob(jobId)).catch(() => null)) as EngineJob | null;
	if (job?.kind !== 'sound-listen' || job.projectId !== projectId)
		throw new ToolError(
			'JOB_NOT_FOUND',
			`No listen_to_sequence job ${jobId} of this project`,
			'listenJobId must be the jobId listen_to_sequence returned for this project (or leave it out: the range is listened to).',
		);
	if (job.state !== 'succeeded')
		throw new ToolError(
			'JOB_NOT_FINISHED',
			`The listen job ${jobId} is ${job.state}`,
			`wait_for_job {jobId: "${jobId}"} first, or leave listenJobId out.`,
		);
	const r = SoundListenResultSchema.parse(job.result);
	if (r.sequenceId !== sequenceId)
		throw new ToolError(
			'JOB_NOT_FOUND',
			`The listen job ${jobId} is of another sequence`,
			'Pass its sequenceId.',
		);
	return r;
}

/** Runs a listen of `range` and waits (null when it did not finish in time). */
export async function listenTo(
	ctx: ToolContext,
	extra: Extra,
	req: {
		projectId: string;
		sequenceId: string;
		range?: { start: number; end: number };
		detail?: 'low' | 'normal' | 'high';
		tags?: boolean;
	},
	timeoutMs: number,
): Promise<{ job: EngineJob; result: SoundListenResult | null; timedOut: boolean }> {
	const job = await ctx.engine((c) => c.soundListen(req, extra.signal)).catch(toolError);
	await cancelIfAborted(ctx, extra, job.id);
	const { job: done, timedOut } = await waitJob(ctx, job.id, timeoutMs, extra);
	if (timedOut) return { job: done, result: null, timedOut: true };
	if (done.state !== 'succeeded')
		throw new ToolError(
			done.error?.code ?? 'JOB_FAILED',
			done.error?.message ?? `The listen ${done.state}`,
			HINTS[done.error?.code ?? ''] ??
				'Check that the media is online (list_offline_media) and the arguments, then try again.',
		);
	return { job: done, result: SoundListenResultSchema.parse(done.result), timedOut: false };
}

export function registerSoundTimelineTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'view_sound_timeline',
		{
			title: 'View sound timeline (PNG)',
			description: `ONE PNG of a sequence range (at most ${VISUAL_MAX_SEC} s) for an agent that cannot hear — the annotated sound sheet, top to bottom: a picture lane (up to ${MAX_TIMELINE_THUMBS} frames rendered through the export path at the cuts, transitions, cues and accents, each with a line to its frame; thumbnails: false leaves it out), the momentary loudness of the mix (white) and its stems — bed (blue), sound effects (orange), music (purple), dialogue (green), ambience (teal) — on a LUFS scale (0 at the top, −60 at the bottom; grid at −6, −14, −23, −40), speech shaded green, the mix's log-frequency spectrogram (30 Hz bottom to 16 kHz top, 10 ms columns; spectrogram: false leaves it out), the mix waveform, the sections of the listening transcript (dialogue / music / ambience / effects / silence), the sound effect clips with the point each is aligned on, the cue ticks (hero tall red, support short amber, dashed = unfilled) each with its ANSWER MARK, a sync lane with every cut (C), transition (T), cue (Q) and measured motion (M) by whether a sound answers it — OK filled green circle (within a frame), near hollow amber diamond (≤ 100 ms), swell hollow blue triangle (a build-up peaking ≤ 300 ms), no sound red cross — the picture's motion (keyframed yellow, MEASURED pink where analysed by analyze_picture_motion; cells.pixelMotion says which), and — with checkJobId (a sound_check jobId) — its findings as flags, over a timecode axis. The sections and marks come from a listen of the range (listen_to_sequence's analysis, run here unless listen: false or listenJobId names one already run). Curves are as delivered when the Mix normalises and its loudness analysis is current. Plus cells JSON: every lane's position, each thumbnail's box and frame, each cue's, mark's and finding's x pixel, the sections' spans, each stem's loudest value. Use it to see where sounds stand out of the bed, which cuts have no sound, whether a hit lines up with what moves, and how far the music sits under the voice.`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				range: z
					.object({ start: TimeInputSchema, end: TimeInputSchema })
					.describe(`Sequence range [start, end). ${TIME_FORMATS}`),
				checkJobId: z
					.string()
					.min(1)
					.max(128)
					.optional()
					.describe('A sound_check jobId whose findings to flag'),
				listenJobId: z
					.string()
					.min(1)
					.max(128)
					.optional()
					.describe(
						'A listen_to_sequence jobId whose sections and answer marks to draw (default: listen to the range)',
					),
				listen: z
					.boolean()
					.optional()
					.describe(
						'Listen to the range for the sections and answer marks (default true; a job of a few seconds)',
					),
				thumbnails: z
					.boolean()
					.optional()
					.describe('Draw the picture lane (default true; each frame is a render)'),
				spectrogram: z.boolean().optional().describe('Draw the spectrogram lane (default true)'),
				width: z.number().int().min(480).max(2400).optional().describe('Picture width in px (default 1200)'),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(1800)
					.optional()
					.describe('Wait for the listen (default 120)'),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			const loaded = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(loaded.doc, a.sequenceId);
			const range = { start: frameOf(seq, a.range.start), end: frameOf(seq, a.range.end) };
			if (range.end <= range.start)
				throw new ToolError(
					'E_INVALID_PARAM',
					`range.end (${range.end}) must be after range.start (${range.start})`,
					TIME_FORMATS,
				);
			const rate = seq.settings.frameRate as Rational;
			if ((range.end - range.start) / (rate.num / rate.den) > VISUAL_MAX_SEC + 1e-9)
				throw new ToolError(
					'RANGE_TOO_LONG',
					`At most ${VISUAL_MAX_SEC} s per picture`,
					'Ask for a shorter range, or several.',
				);
			let listen: SoundListenResult | null = null;
			let listenState = 'not asked (listen: false)';
			let listenJobId: string | null = null;
			if (a.listenJobId) {
				listen = await listenJobResult(ctx, a.listenJobId, a.projectId, seq.id);
				listenJobId = a.listenJobId;
				listenState = 'from the given listen job';
			} else if (a.listen !== false) {
				const r = await listenTo(
					ctx,
					extra,
					{ projectId: a.projectId, sequenceId: seq.id, range, detail: 'low' },
					(a.timeoutSeconds ?? 120) * 1000,
				);
				listenJobId = r.job.id;
				listen = r.result;
				listenState = r.timedOut
					? `still listening (job ${r.job.id}): drawn without sections and answer marks; call again with listenJobId once wait_for_job says it finished`
					: 'listened to the range';
			}
			const sheet = await buildSoundSheet(ctx, extra, loaded, seq, {
				projectId: a.projectId,
				range,
				checkJobId: a.checkJobId,
				listen,
				thumbnails: a.thumbnails !== false,
				spectrogram: a.spectrogram !== false,
				width: a.width,
			});
			return jsonResult(
				{
					range: sheet.visual.range,
					rangeTimecode: sheet.visual.rangeTimecode,
					normalization: sheet.visual.normalization,
					listen: listenState,
					...(listenJobId ? { listenJobId } : {}),
					pictureLane: sheet.pictureLane,
					...(listen
						? {
								unanswered: listen.unanswered
									.filter((u) => u.frame >= range.start && u.frame < range.end)
									.map((u) => `${u.timecode} ${u.label}`),
							}
						: {}),
					cells: sheet.cells,
					speech: sheet.visual.speech,
				},
				[{ type: 'image', data: encodePng(sheet.image).toString('base64'), mimeType: 'image/png' }],
			);
		},
	);
}

/** The frames of `range` around a frame, clamped to the sequence (for the sheets of a long listen). */
export function stripAround(
	frame: number,
	padFrames: number,
	duration: number,
): { start: number; end: number } {
	const start = Math.max(0, Math.min(duration - 1, frame - padFrames));
	return { start, end: Math.max(start + 1, Math.min(duration, frame + padFrames)) };
}

/** A strip's title. */
export function stripTitle(seq: Sequence, range: { start: number; end: number }, why?: string): string {
	return `Sound sheet ${sequenceTimecode(seq, range.start)} - ${sequenceTimecode(seq, range.end)}${why ? ` (${why})` : ''}`;
}
