// listen_to_sequence (spec 12 §4 P6-E6, P6-E7; wp-note "Phase 6 → WP-E3"): an agent's ears for the whole mix. The
// engine's `sound-listen` job renders the mix and every clip of a range (≤ 10 min) and returns the listening
// transcript: a chronological account of what is audible — each sound named by the clip that plays it and the cue it
// fills, sections by class, silences — and how the sound answers the picture (every cut, transition, cue and measured
// motion), each share next to the CHANCE level random times would score. The tool returns the transcript text first
// (the same lines the editor's Sound Check ▸ Log tab shows), then compact JSON, and with images: true the annotated
// sound sheet (view_sound_timeline's lanes: frames, spectrogram, sections, answer marks).
import { SOUND_LISTEN_DETAILS, SOUND_LISTEN_LIMITS, type SoundListenResult } from '@jasper/api';
import { type Rational, sequenceDuration, sequenceTimecode, TimeInputSchema } from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, TIME_FORMATS } from '../arguments.ts';
import { defineTool, frameOf, loadDoc, READ_ONLY, type ToolContext } from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { composeGrid, encodePng } from '../png.ts';
import { buildSoundSheet, listenTo, stripAround, stripTitle, VISUAL_MAX_SEC } from './sound-timeline.ts';

/** Strips of a sheet of a listen longer than one picture: seconds each, and how many. */
const STRIP_SEC = 20;
const MAX_STRIPS = 3;
/** Most events listed in the compact JSON (the transcript lines name the rest). */
const MAX_JSON_EVENTS = 400;

const pct = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 10);

/** The compact JSON next to the transcript. */
export function compactListen(r: SoundListenResult, jobId: string) {
	const stats = (s: SoundListenResult['sync']['all']) =>
		s
			? {
					n: s.n,
					okPct: pct(s.okShare),
					okChancePct: pct(s.okChance),
					within100Pct: pct(s.within100Share),
					within100ChancePct: pct(s.within100Chance),
					accentOkPct: pct(s.accentOkShare),
					accentOkChancePct: pct(s.accentOkChance),
					onBeatPct: pct(s.onBeatShare),
					onBeatChancePct: pct(s.onBeatChance),
					medianAbsOffsetMs: s.medianAbsOffsetMs,
					frameMs: s.frameMs,
				}
			: null;
	return {
		jobId,
		sequenceId: r.sequenceId,
		range: { ...r.range, timecodes: r.rangeTimecode, wholeSequence: r.wholeSequence },
		detail: r.detail,
		counts: r.counts,
		loudness: r.loudness,
		sync: {
			cuts: stats(r.sync.cuts),
			transitions: stats(r.sync.transitions),
			cues: stats(r.sync.cues),
			motion: stats(r.sync.motion),
			all: stats(r.sync.all),
			beatsKnown: r.sync.beatsKnown,
			motionAnalysed: r.sync.motionAnalysed,
		},
		sections: r.sections.map((s) => ({
			start: s.startTimecode,
			end: s.endTimecode,
			label: s.label,
			lufs: s.lufs,
			...(s.music ? { music: s.music } : {}),
		})),
		unanswered: r.unanswered.map((u) => ({
			timecode: u.timecode,
			frame: u.frame,
			kind: u.kind,
			label: u.label,
			nearestStrongMs: u.nearestStrongMs,
		})),
		placed: r.placed.map((p) => ({
			clipId: p.clipId,
			title: p.title,
			track: p.track,
			heard: p.heard,
			ownOffsetMs: p.ownOffsetMs,
			prominenceDb: p.prominenceDb,
			...(p.cueId ? { cueId: p.cueId } : {}),
		})),
		/** [timecode, ms, shape, band, prominence dB, stem, clipId, cueId, accent, answers] */
		events: r.events
			.slice(0, MAX_JSON_EVENTS)
			.map((e) => [
				e.timecode,
				e.ms,
				e.shape,
				e.band,
				e.prominenceDb,
				e.stem,
				e.clipId,
				e.cueId,
				e.accent,
				e.answers.map((x) => `${x.key} ${x.status} ${x.offsetMs}`),
			]),
		...(r.events.length > MAX_JSON_EVENTS ? { eventsListed: MAX_JSON_EVENTS } : {}),
		...(r.warnings.length ? { warnings: r.warnings } : {}),
		timings: r.timings,
	};
}

/** What to do next with a transcript. */
function nextOf(r: SoundListenResult): string {
	const parts: string[] = [
		'Quote timecodes and numbers from the transcript; never say how it sounds — say what was measured and ask the user to listen.',
	];
	if (r.unanswered.length)
		parts.push(
			`${r.unanswered.length} picture event(s) have no sound (the NO SOUND lines): decide with the user which want one (find_sound_cues, place_sound) — most cuts under music need none.`,
		);
	parts.push(
		'Read every share next to its chance level: a share near its chance means the sounds are not placed for the picture.',
	);
	if (!r.sync.motionAnalysed)
		parts.push('Footage motion is not analysed: analyze_picture_motion first to match sounds to what moves.');
	parts.push(
		'Existing hits (production audio included) are listed with their clips: do not stack a new sound on one that is already there.',
	);
	return parts.join(' ');
}

export function registerSoundListenTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'listen_to_sequence',
		{
			title: 'Listen to a sequence (transcript)',
			description: `Your ears for the whole mix: a written log of what is audible, in time order, with the clip behind every sound — you cannot hear, so read this before adding sounds. The engine renders the mix and every clip of a range (default the whole sequence; at most ${SOUND_LISTEN_LIMITS.maxSeconds / 60} min) and finds the events of the mix: onsets refined to the attack (the first millisecond within 20 dB of the peak over its bed), with the band they stand out in (low < 200 Hz, high > 2 kHz, full), how far they rise over the K-weighted bed just before (dB) and their length; swells (build-ups of ≥ 8 dB over 0.25–2 s, timed at their peak); silences and drops (fast loudness 20 LU under the integrated); accents (the top 20 % by prominence that are ≥ 6 dB over the bed). Each event is attributed to the clip whose own sound explains it — a placed sound effect with its role and cue, or production audio named by its clip ("dialogue, A2 "Interview"") — and sections are labelled by what is audible (dialogue, music with its ducking and how far it sits under the voice, ambience, effects, silence). Every cut, transition, cue and measured picture motion (when analyze_picture_motion has run) is matched to the sound that answers it: OK within a frame, near ≤ 100 ms, swell ≤ 300 ms, else NO SOUND; each sync share comes with its CHANCE level — what random times would score with the same sounds — so "60 % of cuts have a sound" means something only when chance is well under it; on-beat shares when the music's beats are cached. Returns the transcript text FIRST (the lines the editor's Sound Check ▸ Log tab shows, verbatim), then compact JSON (counts, loudness, sync with chance, sections, the picture events with no sound, every placed sound with heard / its own offset, events as rows), and with images: true the annotated sound sheet (one PNG: frames at the cuts, cues and accents, loudness, the spectrogram, sections, every picture event by its answer mark; a range over ${VISUAL_MAX_SEC} s gets up to ${MAX_STRIPS} strips of ${STRIP_SEC} s around the picture events with no sound). detail: low (sections, silences, sync, accents, no-sound lines), normal (default: also every placed sound and every event that answers the picture), high (every event). It writes nothing. Waits for the job (timeoutSeconds, default 300).`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				range: z
					.object({ start: TimeInputSchema, end: TimeInputSchema })
					.optional()
					.describe(`Sequence range [start, end) (default the whole sequence; ≤ 10 min). ${TIME_FORMATS}`),
				detail: z.enum(SOUND_LISTEN_DETAILS).optional().describe('How much the transcript lists (default normal)'),
				images: z.boolean().optional().describe('Add the annotated sound sheet PNG (default false)'),
				thumbnails: z
					.boolean()
					.optional()
					.describe('With images: frames of the picture in the sheet (default true; each is a render)'),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(1800)
					.optional()
					.describe('Wait for the listen (default 300)'),
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
			const { job, result: r, timedOut } = await listenTo(
				ctx,
				extra,
				{
					projectId: a.projectId,
					sequenceId: seq.id,
					...(range ? { range } : {}),
					...(a.detail ? { detail: a.detail } : {}),
				},
				(a.timeoutSeconds ?? 300) * 1000,
			);
			if (timedOut || !r)
				return jsonResult({
					jobId: job.id,
					state: job.state,
					progress: job.progress,
					...(job.stage ? { stage: job.stage } : {}),
					next: `Still listening: wait_for_job {jobId: "${job.id}"}, then call listen_to_sequence again with the same range (or read the job's result: its "text").`,
				});
			const compact = compactListen(r, job.id);
			if (!a.images)
				return {
					content: [
						{ type: 'text', text: r.text },
						{ type: 'text', text: JSON.stringify({ ...compact, next: nextOf(r) }) },
					],
				};
			// the annotated sheet: the whole range when it fits one picture, else strips around what has no sound
			const rate = seq.settings.frameRate as Rational;
			const fps = rate.num / rate.den;
			const duration = Math.max(1, Math.ceil(sequenceDuration(seq)));
			const strips: { range: { start: number; end: number }; why: string }[] = [];
			if ((r.range.end - r.range.start) / fps <= VISUAL_MAX_SEC + 1e-9)
				strips.push({ range: r.range, why: 'the whole range' });
			else {
				const pad = Math.round((STRIP_SEC / 2) * fps);
				const centres = [
					...r.unanswered.map((u) => ({ f: u.frame, why: `no sound at ${u.timecode}` })),
					...r.events.filter((e) => e.accent).map((e) => ({ f: e.frame, why: `accent at ${e.timecode}` })),
				];
				for (const c of centres) {
					if (strips.length >= MAX_STRIPS) break;
					if (strips.some((x) => c.f >= x.range.start && c.f < x.range.end)) continue;
					const sr = stripAround(c.f, pad, duration);
					strips.push({
						range: { start: Math.max(r.range.start, sr.start), end: Math.min(r.range.end, sr.end) },
						why: c.why,
					});
				}
				if (!strips.length)
					strips.push({
						range: {
							start: r.range.start,
							end: Math.min(r.range.end, r.range.start + Math.round(STRIP_SEC * fps)),
						},
						why: 'the start of the range',
					});
			}
			const images = [];
			const lanes: string[] = [];
			for (const st of strips) {
				const sh = await buildSoundSheet(ctx, extra, loaded, seq, {
					projectId: a.projectId,
					range: st.range,
					listen: r,
					thumbnails: a.thumbnails !== false,
					spectrogram: true,
					width: 1200,
					title: stripTitle(seq, st.range, st.why),
				});
				images.push(sh.image);
				lanes.push(sh.pictureLane);
			}
			const png = images.length === 1 ? images[0]! : composeGrid(images, 1, 4);
			const sheet = {
				what: 'One strip per range, top to bottom: frames, loudness curves, spectrogram, waveform, sections, sfx clips, cue ticks with answer marks, the sync lane (C cut, T transition, Q cue, M motion: OK green circle, near amber diamond, swell blue triangle, no sound red cross), motion, findings. view_sound_timeline {range, listenJobId} draws any other range with its cells.',
				strips: strips.map((st) => ({
					...st.range,
					timecodes: { start: sequenceTimecode(seq, st.range.start), end: sequenceTimecode(seq, st.range.end) },
					why: st.why,
				})),
				pictureLane: lanes,
			};
			return {
				content: [
					{ type: 'text', text: r.text },
					{ type: 'text', text: JSON.stringify({ ...compact, sheet, next: nextOf(r) }) },
					{ type: 'image', data: encodePng(png).toString('base64'), mimeType: 'image/png' },
				],
			};
		},
	);
}
