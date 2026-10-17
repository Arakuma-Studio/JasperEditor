// Sound Check tools (spec 12 §2.6, §2.10, P5-R2; wp-note "Phase 5 → WP5.1"):
//   sound_check          runs the engine's `sound-check` job (the delivered mix and its stems measured) → the verdict,
//                        the findings with their machine-actionable fixes, the five listen-here timecodes, the per-event
//                        table and, optionally, a PNG strip of the worst moments; `store: true` also writes the summary
//                        into the sequence (one undo step "Sound Check Result").
//   get_sound_check      the sequence's last full report as the engine keeps it (across restarts), current or stale.
//   view_sound_timeline  a PNG of a range (≤ 120 s): the loudness curves of the mix and its stems, the waveform, cue ticks,
//                        the sound effect clips, speech, motion and a check's findings, plus the geometry as JSON.
import {
	type SoundCheckIssue,
	SoundCheckLastResponseSchema,
	type SoundCheckReport,
	SoundCheckResultSchema,
	type SoundVisualResponse,
	SoundVisualResponseSchema,
} from '@jasper/api';
import {
	type ProjectDocument,
	type Rational,
	type Sequence,
	SOUND_CHECK_TARGET_LIMITS,
	SOUND_DELIVERIES,
	sequenceDuration,
	sequenceTimecode,
	soundCheckFixCandidates,
	soundCheckFixOrder,
	soundCheckHumanVerdicts,
	TimeInputSchema,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, TIME_FORMATS } from '../arguments.ts';
import {
	cancelIfAborted,
	defineTool,
	EDIT_IDEMPOTENT,
	frameOf,
	loadDoc,
	READ_ONLY,
	type ToolContext,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { composeGrid, encodePng } from '../png.ts';
import { drawSoundTimeline } from '../sound-timeline.ts';

/** Seconds either side of a worst moment in sound_check's pictures. */
const STRIP_PAD_SEC = 2;
const MAX_STRIPS = 3;
const VISUAL_MAX_SEC = 120;

const RangeArg = z
	.object({ start: TimeInputSchema, end: TimeInputSchema })
	.describe(`Sequence range [start, end). ${TIME_FORMATS}`);

const SOUND_CHECK_HINTS: Record<string, string> = {
	RANGE_EMPTY: 'The range is outside the sequence: check get_timeline for its length.',
	RANGE_TOO_LONG: 'Ask for a shorter range (sound_check: ≤ 4 h; view_sound_timeline: ≤ 120 s).',
	JOB_NOT_FOUND: 'checkJobId must be a sound_check job of this project (its jobId).',
	SOUND_CHECK_NOT_FOUND: 'No report is kept for this sequence: run sound_check.',
	RENDER_FAILED:
		'The mix could not be rendered: check that the media is online (list_offline_media), then try again.',
};

function toolError(e: unknown): never {
	const err = e as { code?: string; message?: string };
	if (err?.code && SOUND_CHECK_HINTS[err.code])
		throw new ToolError(err.code, err.message ?? err.code, SOUND_CHECK_HINTS[err.code]!);
	throw e;
}

/** One line per finding for the agent: severity, code, where, what, and the fix (why it is not safe). */
function issueLine(i: SoundCheckIssue): string {
	const f = i.fix;
	const why =
		f && !f.safe && f.why
			? ` — ${f.why}${f.conflictsWith?.length ? ` (with the fixes of ${f.conflictsWith.join(', ')})` : ''}`
			: '';
	const fix = f ? ` → fix (${f.safe ? 'safe' : 'needs the user'}): ${f.label.text} [${f.tool}]${why}` : '';
	return `${i.severity.toUpperCase()} ${i.code}${i.timecode ? ` @ ${i.timecode}` : ''}: ${i.message.text}${fix}`;
}

/**
 * The safe fixes in the order to apply them (document commands, then sound swaps, then engine jobs; a fix two findings
 * share once): the engine judged each one safe on its own AND after the ones before it in this order.
 */
function safeFixesOf(r: SoundCheckReport) {
	const byId = new Map(r.issues.map((i) => [i.id, i]));
	return soundCheckFixOrder(soundCheckFixCandidates(r.issues, { safeOnly: true })).map((c) => {
		const fix = byId.get(c.issueIds[0]!)!.fix!;
		return { issueIds: c.issueIds, tool: fix.tool, args: fix.args };
	});
}

/**
 * The user's listen-here verdicts (spec 12 §2.7: "Sounds right" / "Flag" + note, stored by the editor's Sound Check
 * panel as `comment` markers): each with its timecode, the listen slot and clip / cue it judged (verdicts written
 * before the Phase 5 verification carry only a frame: their slot comes from this report's moment at that frame), and
 * whether it is still current — `stale` (null: cannot be told for such an older verdict) with `staleReasons`: `moment`
 * (what plays in the listened ±2 s changed since), `moved` / `gone` (its clip or cue).
 */
function humanVerdictsOf(doc: ProjectDocument, seq: Sequence, r: Pick<SoundCheckReport, 'listen'>) {
	return soundCheckHumanVerdicts(seq, { doc }).map((v) => {
		const at = r.listen.find((l) => l.frame === v.frame);
		const slot = v.slot ?? at?.slot;
		return {
			timecode: sequenceTimecode(seq, v.frame),
			frame: v.frame,
			verdict: v.verdict === 'ok' ? 'sounds right' : 'flagged',
			note: v.note,
			markerId: v.markerId,
			...(slot ? { slot } : {}),
			...(v.clipId ? { clipId: v.clipId } : {}),
			...(v.cueId ? { cueId: v.cueId } : {}),
			stale: v.stale ?? null,
			...(v.staleReasons?.length ? { staleReasons: v.staleReasons } : {}),
			...(v.mixChanged !== undefined && v.mixChanged !== null ? { mixChangedSince: v.mixChanged } : {}),
		};
	});
}

/** The per-event table as text (one row per sound effect). */
function eventTable(r: SoundCheckReport): string {
	return [
		'clip | timecode | sound | track | role | cue | offset ms (tol frames) | lift dB (min) | over bed LU | status | codes',
		...r.events.map(
			(e) =>
				`${e.clipId} | ${e.timecode} | ${e.title} | ${e.track} | ${e.role ?? e.weight} | ${e.cueKind ?? '—'} | ${e.offsetMs === null ? e.located : `${e.offsetMs > 0 ? '+' : ''}${e.offsetMs}`}${e.toleranceFrames !== null ? ` (±${e.toleranceFrames})` : ''} | ${e.liftDb === null ? '—' : e.liftDb}${e.minLiftDb !== null ? ` (${e.minLiftDb})` : ''} | ${e.peakOverBedLu ?? '—'} | ${e.status} | ${e.codes.join(', ') || '—'}`,
		),
	].join('\n');
}

/** What to do next with a report (the same advice for a fresh and a kept one). */
function nextOf(r: SoundCheckReport, listen: string[]): string {
	const safe = r.issues.filter((i) => i.fix?.safe);
	const fixes = safeFixesOf(r).length;
	return r.verdict === 'pass'
		? `No warnings or errors. Give the user these moments to listen to, verbatim: ${listen.join(' | ') || '(none)'}. Do not say it sounds good: say what was measured.`
		: `${safe.length} finding(s) have a safe fix (${fixes} fix(es) in safeFixes): apply exactly those, in the order of safeFixes (each tool + args once — they were judged together in that order), then run sound_check again. Leave the others to the user and tell them what each says (a fix that is not safe says why). Give the user the listen-here moments verbatim: ${listen.join(' | ') || '(none)'}.`;
}

/** The frames of up to `n` worst moments (errors first, then warnings, then the listen-here worst). */
function worstFrames(r: SoundCheckReport, n: number): number[] {
	const rank = { error: 0, warning: 1, info: 2 } as const;
	const frames: number[] = [];
	for (const i of [...r.issues].sort((a, b) => rank[a.severity] - rank[b.severity])) {
		if (i.severity === 'info') break;
		const f = i.frame ?? i.range?.start;
		if (f === undefined) continue;
		if (frames.some((x) => Math.abs(x - f) < 3 * STRIP_PAD_SEC * (r.fps.num / r.fps.den))) continue;
		frames.push(f);
		if (frames.length >= n) break;
	}
	if (frames.length === 0)
		for (const l of r.listen) {
			if (frames.some((x) => Math.abs(x - l.frame) < 2 * STRIP_PAD_SEC * (r.fps.num / r.fps.den))) continue;
			frames.push(l.frame);
			if (frames.length >= Math.min(n, 2)) break;
		}
	return frames;
}

export function registerSoundCheckTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'sound_check',
		{
			title: 'Sound Check (measured QA of the mix)',
			description: `Measures a sequence's sound the way it will be delivered and returns what to fix and where to listen. You cannot hear: this is how you check your sound design. The engine renders the mix (with the Mix's loudness normalisation and true-peak limiter, exactly as an export) and its stems — sound effects, dialogue, music, ambience, bed — in one pass, finds speech (transcript + voice activity) and checks: LOUDNESS (integrated vs the delivery preset ±1 LU; under 400 ms of audible audio it is "not measurable", never a pass), TRUE_PEAK (over the preset's ceiling), OUT_OF_SYNC (each placed sound located in the sound-effects mix by cross-correlation within ±3 frames of its cue: cut ±1, land ±2, move ±3, appear ±1 frame; offset in ms; or "cut": its clip ends at its peak; an end-aligned riser or reverse may end 250 ms before to 30 ms after its cue), TRUNCATED (a placed sound's clip ends before the sound has faded to −60 dB: older copies without trailing silence; the safe fix is swap_sound to the same sound, which re-registers it, or soundDesign.swap on its own media), MASKED (dominant-band lift over the bed under 1.5 dB support / 3 dB hero, the masking solver's own definition), OVERLOAD (a sound over the bed cap, the export limiter pulling > 3 dB, clipping without normalisation), MUSIC_OVER_VOICE (music not 8 LU under the voice during speech), SILENCE (< −60 dBFS in every channel for ≥ 0.5 s outside silence cues), DIP (short-term drop > 10 LU with no stop-before, cut, silence cue, Volume keyframes lowering the level there; only the bed under the voice and effects dropping counts), STALE_CUE (the cue's anchor moved), NO_PICTURE_EVENT (a derived cue with nothing on screen), DENSITY (heroes too close, too many cues per second), REPEAT (the same file back to back), LICENSE (non-commercial, no-derivatives, unknown or undeclared licences: error / warning; a CC BY-SA sound: a ShareAlike warning — the video must then be shared under CC BY-SA), CREDITS (CC-BY sounds without a credits file), and the edit / tone / director lenses: CLICK (a click within 2 ms of a clip edge, remix joint or transition edge: error, a 1-frame fade fixes it; inside a clip: info), EDGE (a clip whose head starts mid-sound, a decay chopped at its Out point, music chopped at a joint: warning, a fade or a 100 ms crossfade fixes it), HARSH (a placed sound more than 6 dB over the music's — else the dialogue's — loudest 2–6 kHz 5 ms level: warning, lowered by the excess when it stays unmasked; a bright sound, centroid > 6.5 kHz: info), LAYER_INAUDIBLE (a layer of a multi-layer cue adding < 1 dB in every 1/3-octave band: info), COVERAGE (some cues of a class of action — same kind and anchor, by clip or track — filled and others not: warning, fill them or mute them, the user's call), ENDING (the mix ends mid-sound: last 50 ms over −45 dBFS RMS or last 10 ms over −60 dBFS peak; a Mix fade-out, the user's call), HEAD (the first 5 ms over −40 dBFS: info) and ARC (the loudest 3 s hold no hero, or sit in the last 15 % without one: info). Each finding has a severity, a timecode, a message and, where one exists, a fix: {kind: commands → apply_commands args | job → rebalance_sfx / apply_delivery args | swap → swap_sound args, safe}. Apply ONLY the fixes marked safe, in the order of safeFixes (each one undo step, each once), then run sound_check again; leave the others to the user. The safe fixes are judged together: each is safe on its own and after the safe fixes before it in safeFixes — a fix that would undo or overload what another one does (a hero's gain and its demotion), or with loudness normalisation off push the mix's true peak over the ceiling, is not safe and says why (fix.why; fix.conflictsWith names the findings it conflicts with: run sound_check again after the others). A mono Mix is checked in mono (loudness.layout). listen: up to five "listen here" moments (worst finding, biggest hero, loudest moment, busiest moment, a cue that passes) — give them to the user VERBATIM and never say the result "sounds good". verdict: pass | warn | fail. images (default true) adds ONE PNG of up to three of the worst moments (±2 s each: loudness curves, waveform, cue ticks, findings). store: true writes the summary into the sequence (one undo step "Sound Check Result"; the editor shows whether it is still current). target: {integratedLufs, truePeakDb} checks a custom delivery target instead of the preset's numbers. humanVerdicts: what the user said after listening in the editor's Sound Check panel — "sounds right" or "flagged" with their note, at a timecode, with the listen slot and the clip / cue it judged; stale: true (staleReasons moment / moved / gone) when what plays there changed since they listened, so the verdict no longer covers it (null for older verdicts that cannot tell); they are the user's comment markers: read them, fix what is flagged, ask the user to listen again to stale ones, and never add or change them yourself. get_sound_check returns the last report without running the check. Waits for the job (timeoutSeconds, default 300).`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				preset: z
					.enum(SOUND_DELIVERIES)
					.optional()
					.describe('Delivery preset to check against (default the sequence’s: web −14 LUFS / −1 dBTP…)'),
				target: z
					.object({
						integratedLufs: z
							.number()
							.min(SOUND_CHECK_TARGET_LIMITS.integratedLufs.min)
							.max(SOUND_CHECK_TARGET_LIMITS.integratedLufs.max),
						truePeakDb: z
							.number()
							.min(SOUND_CHECK_TARGET_LIMITS.truePeakDb.min)
							.max(SOUND_CHECK_TARGET_LIMITS.truePeakDb.max),
					})
					.optional()
					.describe(
						'A custom delivery target (integrated LUFS, true-peak ceiling dBTP) checked instead of the preset’s numbers; the preset still sets the default sound-effect levels',
					),
				range: RangeArg.optional(),
				store: z.boolean().optional().describe('Store the summary in the sequence (default false)'),
				images: z.boolean().optional().describe('Add a PNG of the worst moments (default true)'),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(1800)
					.optional()
					.describe('Wait for the job (default 300)'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			let range: { start: number; end: number } | undefined;
			if (a.range) {
				range = { start: frameOf(seq, a.range.start), end: frameOf(seq, a.range.end) };
				if (range.end <= range.start)
					throw new ToolError(
						'E_INVALID_PARAM',
						`range.end (${range.end}) must be after range.start (${range.start})`,
						TIME_FORMATS,
					);
			}
			const job = await ctx
				.engine((c) =>
					c.soundCheck(
						{
							projectId: a.projectId,
							sequenceId: seq.id,
							...(a.preset ? { preset: a.preset } : {}),
							...(a.target ? { target: a.target } : {}),
							...(range ? { range } : {}),
							...(a.store ? { store: true } : {}),
						},
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
					next: `The check is still running: wait_for_job {jobId: "${done.id}"}, then call sound_check again (or read the job's result).`,
				});
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'JOB_FAILED',
					done.error?.message ?? `The sound check ${done.state}`,
					SOUND_CHECK_HINTS[done.error?.code ?? ''] ??
						'Check that the media is online (list_offline_media) and the arguments, then try again.',
				);
			const result = SoundCheckResultSchema.parse(done.result);
			const r = result.report;
			const listen = r.listen.map((l) => `${l.timecode} — ${l.why.text}`);
			const table = eventTable(r);
			const content: { type: 'image'; data: string; mimeType: string }[] = [];
			const pictures: { frame: number; range: { start: number; end: number } }[] = [];
			if (a.images !== false) {
				const fps = r.fps.num / r.fps.den;
				const pad = Math.round(STRIP_PAD_SEC * fps);
				const duration = Math.max(1, Math.ceil(sequenceDuration(seq)));
				const strips = [];
				for (const f of worstFrames(r, MAX_STRIPS)) {
					const pr = { start: Math.max(0, f - pad), end: Math.min(duration, f + pad + 1) };
					if (pr.end <= pr.start) continue;
					const v = SoundVisualResponseSchema.parse(
						await ctx
							.engine((c) =>
								c.soundVisual(
									{ projectId: a.projectId, sequenceId: seq.id, range: pr, checkJobId: done.id },
									extra.signal,
								),
							)
							.catch(toolError),
					);
					strips.push(
						drawSoundTimeline(v, { width: 960, title: `Around ${sequenceTimecode(seq, f)}` }).image,
					);
					pictures.push({ frame: f, range: pr });
				}
				if (strips.length) {
					const sheet = composeGrid(strips, 1, 4);
					content.push({ type: 'image', data: encodePng(sheet).toString('base64'), mimeType: 'image/png' });
				}
			}
			return jsonResult(
				{
					jobId: done.id,
					verdict: r.verdict,
					preset: r.preset,
					range: { ...r.range, timecodes: r.rangeTimecode, wholeSequence: r.wholeSequence },
					counts: r.counts,
					loudness: r.loudness,
					listen,
					humanVerdicts: humanVerdictsOf(doc, seq, r),
					findings: r.issues.map(issueLine),
					issues: r.issues,
					safeFixes: safeFixesOf(r),
					table,
					speech: r.speech,
					stems: r.stems,
					...(r.warnings.length ? { warnings: r.warnings } : {}),
					stored: result.stored,
					...(result.stored ? { revision: result.revision } : {}),
					...(pictures.length
						? {
								pictures: {
									what: 'One strip per worst moment, top to bottom: momentary loudness of the mix (white), bed (blue), sound effects (orange), music (purple), dialogue (green); waveform; sound effect clips with their aligned point; cue ticks; motion; findings as flags.',
									strips: pictures,
								},
							}
						: {}),
					next: nextOf(r, listen),
				},
				content,
			);
		},
	);

	defineTool(
		ctx,
		'get_sound_check',
		{
			title: 'Get the last Sound Check report',
			description:
				"The last full Sound Check report of a sequence without running the check again: the engine keeps each sequence's last report (findings with their fixes, listen-here moments, the per-event table) across restarts. state: current | stale with reasons — mix (the mix changed since: `mixFingerprint`) or inputs (cues, loudness settings, credits or the target changed); a stale report's fixes may no longer apply: run sound_check again before applying any. Also returns humanVerdicts (the user's listen-here verdicts, each with stale / staleReasons). Error SOUND_CHECK_NOT_FOUND when the sequence was never checked (or its report was not kept).",
			input: { projectId: ProjectIdArg, sequenceId: SequenceIdArg },
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const kept = SoundCheckLastResponseSchema.parse(
				await ctx
					.engine((c) => c.lastSoundCheck({ projectId: a.projectId, sequenceId: seq.id }, extra.signal))
					.catch(toolError),
			);
			const r = kept.result.report;
			const listen = r.listen.map((l) => `${l.timecode} — ${l.why.text}`);
			return jsonResult({
				jobId: kept.jobId,
				savedAt: kept.savedAt,
				state: kept.state,
				...(kept.reasons.length ? { reasons: kept.reasons } : {}),
				verdict: r.verdict,
				preset: r.preset,
				range: { ...r.range, timecodes: r.rangeTimecode, wholeSequence: r.wholeSequence },
				counts: r.counts,
				loudness: r.loudness,
				listen,
				humanVerdicts: humanVerdictsOf(doc, seq, r),
				findings: r.issues.map(issueLine),
				issues: r.issues,
				safeFixes: kept.state === 'stale' ? [] : safeFixesOf(r),
				table: eventTable(r),
				next:
					kept.state === 'stale'
						? `This report is stale (${kept.reasons.join(', ')} changed since it was made): run sound_check again before applying any fix.`
						: nextOf(r, listen),
			});
		},
	);

	defineTool(
		ctx,
		'view_sound_timeline',
		{
			title: 'View sound timeline (PNG)',
			description: `ONE PNG of a sequence range (at most ${VISUAL_MAX_SEC} s) for an agent that cannot hear: the momentary loudness of the mix (white) and its stems — bed (blue), sound effects (orange), music (purple), dialogue (green), ambience (teal) — on a LUFS scale (0 at the top, −60 at the bottom; grid at −6, −14, −23, −40), speech shaded green, the mix waveform, the sound effect clips with the point each is aligned on, the cue ticks (hero tall red, support short amber, dashed = unfilled), the picture's motion (the fastest keyframed layer in yellow; the MEASURED picture in pink where the range was already analysed by analyze_picture_motion or find_sound_cues sources ["pixel"] — cells.pixelMotion says measured / partly analysed / not analysed), and — with checkJobId (a sound_check jobId) — its findings as flags, over a timecode axis. Curves are as delivered when the Mix normalises and its loudness analysis is current. Plus cells JSON: lane positions, each cue's and finding's x pixel, each stem's loudest value. Use it to see where sounds stand out of the bed, whether a hit lines up with motion, and how far the music sits under the voice.`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				range: RangeArg,
				checkJobId: z
					.string()
					.min(1)
					.max(128)
					.optional()
					.describe('A sound_check jobId whose findings to flag'),
				width: z.number().int().min(480).max(2400).optional().describe('Picture width in px (default 1200)'),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
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
			const v: SoundVisualResponse = SoundVisualResponseSchema.parse(
				await ctx
					.engine((c) =>
						c.soundVisual(
							{
								projectId: a.projectId,
								sequenceId: seq.id,
								range,
								...(a.checkJobId ? { checkJobId: a.checkJobId } : {}),
							},
							extra.signal,
						),
					)
					.catch(toolError),
			);
			const { image, cells } = drawSoundTimeline(v, { ...(a.width ? { width: a.width } : {}) });
			return jsonResult(
				{
					range: v.range,
					rangeTimecode: v.rangeTimecode,
					normalization: v.normalization,
					cells,
					speech: v.speech,
				},
				[{ type: 'image', data: encodePng(image).toString('base64'), mimeType: 'image/png' }],
			);
		},
	);
}
