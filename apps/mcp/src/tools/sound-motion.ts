// analyze_picture_motion (spec 12 §2.10, P6-R2; wp-note "Phase 6 → WP6.2"): the engine's `motion-analysis` job — the
// sequence's picture rendered small through the export planner and measured frame by frame — returned as the detected
// events (moves with their span and direction, landings, cuts), a compact curve and ONE PNG strip: frames at the events
// over the speed / moving-area / unexplained-change curves with every event marked. Agents cannot watch footage; this
// is how they see where it moves.
import { MOTION_ANALYSIS_LIMITS, MotionAnalysisResultSchema } from '@jasper/api';
import { sequenceDuration, sequenceTimecode } from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, TIME_FORMATS, TimeArgSchema } from '../arguments.ts';
import {
	cancelIfAborted,
	captureStill,
	defineTool,
	frameOf,
	loadDoc,
	READ_ONLY,
	type ToolContext,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { drawMotionStrip } from '../motion-strip.ts';
import { decodePng, encodePng } from '../png.ts';

const HINTS: Record<string, string> = {
	RANGE_EMPTY: 'The range is outside the sequence: check get_timeline for its length.',
	RANGE_TOO_LONG: `Analyse at most ${MOTION_ANALYSIS_LIMITS.maxSeconds / 60} minutes at a time: give a range.`,
	EXPORT_BLOCKED:
		'The picture cannot be rendered on this engine (see the blockers); fix them or analyse another range.',
};
/** Most thumbnails in the strip (each is a rendered frame). */
const MAX_THUMBS = 6;
/** Most curve points returned (max-pooled). */
const MAX_POINTS = 400;

function toolError(e: unknown): never {
	const err = e as { code?: string; message?: string };
	if (err?.code && HINTS[err.code]) throw new ToolError(err.code, err.message ?? err.code, HINTS[err.code]!);
	throw e;
}

/** Max-pools a series to ≤ `n` points (peaks survive). */
function pool(xs: readonly number[], n: number): number[] {
	if (xs.length <= n) return xs.map((x) => Math.round(x * 1000) / 1000);
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		const a = Math.floor((i * xs.length) / n);
		const b = Math.max(a + 1, Math.floor(((i + 1) * xs.length) / n));
		let m = 0;
		for (let k = a; k < b; k++) m = Math.max(m, xs[k] ?? 0);
		out.push(Math.round(m * 1000) / 1000);
	}
	return out;
}

export function registerSoundMotionTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'analyze_picture_motion',
		{
			title: 'Analyze picture motion',
			description:
				'Measure how the picture moves, footage included: moves, lands and cuts with timecodes, and one PNG.',
			details: `Measures how the picture moves, frame by frame — footage included, which keyframes cannot describe (a car passing, a whip pan, a door slamming). The engine renders the sequence's picture small (128 px, through the export planner: what the Program monitor shows) and measures each frame against the one before (block matching with sub-pixel refinement): the speed of what moves (screen diagonals per second, the same unit and thresholds as keyframed motion), its direction and on-screen position, the share of the frame that moves (≥ half = a camera move) and the change motion does not explain (cuts, flashes). Returns the events — move {start, end (exclusive), frame of its fastest stretch, peakSpeed, direction, global, pan / panSweep}, land {frame, how: abrupt stop | overshoot | bounce}, cut {frame} — with timecodes, a pooled curve (≤ ${MAX_POINTS} points) and ONE PNG: frames at the events above the curves with each event marked (images: false leaves it out; thumbnails: false draws only the curves). At most ${MOTION_ANALYSIS_LIMITS.maxSeconds / 60} minutes per call (range); cached by the picture's fingerprint (the same picture is not measured twice; any picture edit measures again). find_sound_cues {sources: ["pixel"]} turns the same analysis into cues anchored to the footage; Sound Check uses it for NO_PICTURE_EVENT. It writes nothing to the project.`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				range: z
					.object({ start: TimeArgSchema, end: TimeArgSchema })
					.optional()
					.describe(`Sequence range [start, end) (default the whole sequence; ≤ 10 min). ${TIME_FORMATS}`),
				images: z.boolean().optional().describe('Add the PNG strip (default true)'),
				thumbnails: z
					.boolean()
					.optional()
					.describe(`Frames at up to ${MAX_THUMBS} events in the strip (default true; each is a render)`),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(1800)
					.optional()
					.describe('Wait for the analysis (default 300)'),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			const loaded = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(loaded.doc, a.sequenceId);
			let range: { start: number; end: number } | undefined;
			if (a.range) {
				range = { start: frameOf(seq, a.range.start), end: frameOf(seq, a.range.end) };
				if (range.end <= range.start || range.start < 0)
					throw new ToolError(
						'E_INVALID_PARAM',
						`range.end (${range.end}) must be after range.start (${range.start})`,
						TIME_FORMATS,
					);
			}
			const job = await ctx
				.engine((c) =>
					c.analyzeMotion(
						{ projectId: a.projectId, sequenceId: seq.id, ...(range ? { range } : {}) },
						extra.signal,
					),
				)
				.catch(toolError);
			await cancelIfAborted(ctx, extra, job.id);
			const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 300) * 1000, extra);
			if (timedOut)
				return jsonResult({
					jobId: done.id,
					state: done.state,
					progress: done.progress,
					...(done.stage ? { stage: done.stage } : {}),
					next: `Still measuring: wait_for_job {jobId: "${done.id}"}, then call analyze_picture_motion again (it is cached then).`,
				});
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'JOB_FAILED',
					done.error?.message ?? `The analysis ${done.state}`,
					HINTS[done.error?.code ?? ''] ??
						'Check that the media is online (list_offline_media) and that the range renders (render_frame), then try again.',
				);
			const r = MotionAnalysisResultSchema.parse(done.result);
			const tc = (f: number) => sequenceTimecode(seq, f);
			const describe = (e: (typeof r.events)[number]): string => {
				if (e.kind === 'move')
					return `${tc(e.start ?? e.frame)}–${tc(e.end ?? e.frame)} ${e.global ? 'camera move' : 'something moves'} ${e.direction ?? ''}, fastest at ${tc(e.frame)} (${(e.peakSpeed ?? 0).toFixed(2)} screens/s, ${Math.round((e.area ?? 0) * 100)} % of the frame)`;
				if (e.kind === 'land') return `${tc(e.frame)} lands (${e.how})`;
				return `${tc(e.frame)} cut or flash (${Math.round((e.residual ?? 0) * 100)} % unexplained)`;
			};
			const events = r.events.map((e) => ({ ...e, text: describe(e) }));
			const content: { type: 'image'; data: string; mimeType: string }[] = [];
			let cells: ReturnType<typeof drawMotionStrip>['cells'] | null = null;
			if (a.images !== false) {
				const thumbs: { frame: number; image: ReturnType<typeof decodePng>; label: string }[] = [];
				if (a.thumbnails !== false) {
					const picks = r.events.slice(0, MAX_THUMBS);
					const duration = Math.max(1, Math.ceil(sequenceDuration(seq)));
					for (const e of picks) {
						const f = Math.min(duration - 1, Math.max(0, e.frame));
						const still = await captureStill(
							ctx,
							{ projectId: a.projectId, frame: f, width: 240, sequenceId: seq.id },
							extra,
							loaded,
						);
						thumbs.push({ frame: f, image: decodePng(still.bytes), label: `${e.kind} ${tc(f)}` });
					}
				}
				const strip = drawMotionStrip(r, { width: 1200, timecode: tc, thumbs });
				cells = strip.cells;
				content.push({
					type: 'image',
					data: encodePng(strip.image).toString('base64'),
					mimeType: 'image/png',
				});
			}
			return jsonResult(
				{
					sequenceId: r.sequenceId,
					range: { ...r.range, startTimecode: tc(r.range.start), endTimecode: tc(r.range.end) },
					frames: r.frames,
					cached: r.cached,
					renderPath: r.renderPath,
					fingerprint: r.fingerprint,
					events,
					lines: events.map((e) => e.text),
					curve: {
						points: Math.min(MAX_POINTS, r.curve.speed.length),
						framesPerPoint: Math.max(1, r.curve.speed.length / MAX_POINTS),
						speed: pool(r.curve.speed, MAX_POINTS),
						area: pool(r.curve.area, MAX_POINTS),
						residual: pool(r.curve.residual, MAX_POINTS),
					},
					edits: r.edits.map((f) => ({ frame: f, timecode: tc(f) })),
					timings: r.timings,
					warnings: r.warnings,
					...(cells ? { cells } : {}),
					next: events.length
						? 'find_sound_cues {sources: ["pixel"]} gives these as cue suggestions (anchored to the footage); check a few with render_frames around their frames.'
						: 'No motion events: the picture is still (or moves slower than 0.12 screens per second) in this range.',
				},
				content,
			);
		},
	);
}
