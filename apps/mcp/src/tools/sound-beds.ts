// Ambience beds and room tone (spec 12 §4 P6-E12; wp-note "Phase 6 → WP-E8"): `lay_ambience_bed` and `fill_room_tone`.
// The engine measures (the clean window and loop points of each bed recording; the dialogue's noise floor and the room
// tones closest to it) and writes ONE transaction of `soundDesign.layBed` — proposed by default, applied on request.
import {
	BED_SCENE_SOURCES,
	type SoundBedsPlan,
	SoundBedsPlanSchema,
	SoundBedsResultSchema,
	type SoundRoomTonePlan,
	SoundRoomTonePlanSchema,
	SoundRoomToneResultSchema,
} from '@jasper/api';
import { type Sequence, TimeInputSchema } from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, TIME_FORMATS } from '../arguments.ts';
import { cancelIfAborted, defineTool, EDIT, frameOf, loadDoc, type ToolContext, waitJob } from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { SoundIdArg } from './sound.ts';

const MODE = z
	.enum(['propose', 'apply'])
	.optional()
	.describe('"propose" (default): a proposal for the user to review; "apply": one undoable edit (only when the user asked)');
const PREVIEW = z
	.boolean()
	.optional()
	.describe('true: only measure and return the plan and its transaction (nothing is proposed or changed)');
const TIMEOUT = z.number().int().min(1).max(900).optional().describe('Wait for the job (default 300 s)');
const SPAN = z.object({ start: TimeInputSchema, end: TimeInputSchema });

const fmtDb = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x * 10) / 10)}`;

function spanOf(seq: Sequence, s: { start: unknown; end: unknown }, what: string): { start: number; end: number } {
	const r = { start: frameOf(seq, s.start as never), end: frameOf(seq, s.end as never) };
	if (!(r.end > r.start))
		throw new ToolError('E_INVALID_PARAM', `${what}: end (${r.end}) must be after start (${r.start})`, TIME_FORMATS);
	return r;
}

/** The scenes table of a bed plan. */
export function bedTable(p: SoundBedsPlan): string {
	return [
		'scene | timecode | why | bed | clean window | loop (s) | crossfade | gain',
		...p.scenes.map(
			(s, i) =>
				`${i + 1} | ${s.timecode}–${s.endTimecode} | ${s.reason}${s.label ? ` "${s.label}"` : ''} | ${s.sound.title} | ${s.sound.window.startSec}–${s.sound.window.endSec} s (±${s.sound.window.levelStdDb} dB, ${s.sound.window.onsetsPerMin} onsets/min${s.sound.window.clean ? '' : `, ${s.sound.window.spikes} spikes`}) | ${s.sound.loop.inSec}–${Math.round(s.sound.loop.outSec * 1000) / 1000} | ${s.sound.loop.crossfadeSec} s ${s.sound.loop.fade} (ΔL ${s.sound.loop.levelDiffDb} dB, shape ${s.sound.loop.spectralDistanceDb} dB, ρ ${s.sound.loop.correlation}) | ${fmtDb(s.gainDb)} dB`,
		),
	].join('\n');
}

/** The candidates table of a room-tone plan. */
export function roomToneTable(p: SoundRoomTonePlan): string {
	return [
		'candidate | source | shape distance to the floor | level',
		...p.candidates.map(
			(c) =>
				`${c.title}${p.chosen && c.title === p.chosen.sound.title ? ' (chosen)' : ''} | ${c.source} | ${c.distanceDb === null ? '—' : `${c.distanceDb} dB`} | ${c.levelDb} dBFS`,
		),
	].join('\n');
}

export function registerSoundBedTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'lay_ambience_bed',
		{
			title: 'Lay an ambience bed per scene (looped, crossfaded)',
			description: `Lays ONE ambience bed per scene of a sequence (spec 12 P6-E12): the scenes follow the picture — a V1 cut to other footage (cuts between two clips of the same media are one place), chapter / segmentation markers or markers named "Scene…", and with sources ["shots"] the shot changes measured inside footage (cached Scene Edit Detection); scenes under 2 s join a neighbour — or pass scenes [{start, end, soundId?}] (each may have its own bed). The engine measures each bed recording: its CLEAN WINDOW (the stretch with the fewest onsets and the steadiest level, with no spike ≥ 10 dB over its 1 s neighbourhood: no voice, dog or door in the loop) and its LOOP POINTS (a and b, a whole number of frames apart, where the head [a, a + 1.5 s] and the tail [b − 1.5 s, b] match in level, octave-band shape and correlation; equal-power crossfades, equal-gain when the material repeats in phase, e.g. a hum). It lays ordinary clips on an "Ambience" track: the loop repeated with 1.5 s crossfades centred on each joint, a 0.5 s crossfade at each scene change, 1 s fades where the bed starts and stops, Essential Sound type Ambience, at the delivery's ambience level (web −30 LUFS) unless gainDb, optionally ducked under the dialogue (duckUnder "dialogue": −10 dB, 800 ms) or heroes. Earlier ambience beds over the scenes are replaced (replace false keeps them). The bed: soundId (a library ambience: search_sounds {types: ["ambience"]}; it is registered for the project), mediaId (project audio), else the palette's first ambience. Returns the scene table (window, loop, crossfade, gain) and the proposalId (mode "propose", default: ask the user to review it in the Review panel; run sound_check {proposalId} first) or the applied revision (mode "apply": one undo step "Lay Ambience Bed"). preview: true measures only. You cannot hear: quote the measured numbers, never that the bed "sounds seamless"; sound_check then reports CLICK / EDGE / DIP at its joints if any.`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				mode: MODE,
				preview: PREVIEW,
				soundId: SoundIdArg.optional().describe('The bed: a library ambience (default the palette’s first)'),
				mediaId: z.string().min(1).max(128).optional().describe('The bed: a project media with sound'),
				scenes: z
					.union([
						z.literal('auto'),
						z
							.array(
								SPAN.extend({
									soundId: SoundIdArg.optional(),
									mediaId: z.string().min(1).max(128).optional(),
								}),
							)
							.min(1)
							.max(500),
					])
					.optional()
					.describe(`"auto" (default) or the scenes [{start, end, soundId?, mediaId?}]. ${TIME_FORMATS}`),
				sources: z
					.array(z.enum(BED_SCENE_SOURCES))
					.max(3)
					.optional()
					.describe('Scene changes for "auto": edits (V1 cuts to other footage), markers, shots (measured); default edits + markers'),
				range: SPAN.optional().describe(`Only scenes in [start, end). ${TIME_FORMATS}`),
				gainDb: z.number().min(-60).max(40).optional().describe('Clip gain of the bed (default the ambience level)'),
				fadeSec: z.number().min(0).max(30).optional().describe('Fades where a bed starts and stops (default 1 s)'),
				crossfadeSec: z.number().min(0.05).max(30).optional().describe('Loop crossfade (default 1.5 s)'),
				sceneCrossfadeSec: z.number().min(0).max(10).optional().describe('Crossfade at scene changes (default 0.5 s)'),
				duckUnder: z.enum(['dialogue', 'heroes']).nullable().optional().describe('Duck the bed (Volume keyframes)'),
				track: z.string().min(1).max(64).optional().describe('An audio track free over the scenes, or "auto"'),
				replace: z.boolean().optional().describe('Replace earlier ambience beds over the scenes (default true)'),
				label: z.string().min(1).max(200).optional().describe('Proposal title / History label'),
				timeoutSeconds: TIMEOUT,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const body = {
				projectId: a.projectId,
				sequenceId: seq.id,
				...(a.soundId ? { soundId: a.soundId } : {}),
				...(a.mediaId ? { mediaId: a.mediaId } : {}),
				...(Array.isArray(a.scenes)
					? {
							scenes: a.scenes.map((s, i) => ({
								...spanOf(seq, s, `scenes[${i}]`),
								...(s.soundId ? { soundId: s.soundId } : {}),
								...(s.mediaId ? { mediaId: s.mediaId } : {}),
							})),
						}
					: a.scenes
						? { scenes: 'auto' as const }
						: {}),
				...(a.sources ? { sources: a.sources } : {}),
				...(a.range ? { range: spanOf(seq, a.range, 'range') } : {}),
				...(a.gainDb !== undefined ? { gainDb: a.gainDb } : {}),
				...(a.fadeSec !== undefined ? { fadeSec: a.fadeSec } : {}),
				...(a.crossfadeSec !== undefined ? { crossfadeSec: a.crossfadeSec } : {}),
				...(a.sceneCrossfadeSec !== undefined ? { sceneCrossfadeSec: a.sceneCrossfadeSec } : {}),
				...(a.duckUnder !== undefined ? { duckUnder: a.duckUnder } : {}),
				...(a.track ? { track: a.track } : {}),
				...(a.replace !== undefined ? { replace: a.replace } : {}),
				...(a.label ? { label: a.label } : {}),
			};
			if (a.preview) {
				const plan = SoundBedsPlanSchema.parse(await ctx.engine((c) => c.planAmbienceBeds(body, extra.signal)));
				return jsonResult({
					preview: true,
					scenes: plan.scenes.length,
					table: bedTable(plan),
					...(plan.warnings.length ? { warnings: plan.warnings } : {}),
					transaction: plan.commands,
					next: 'Nothing was changed. Call again without preview (mode "propose") to put it up for review.',
				});
			}
			const job = await ctx.engine((c) => c.layAmbienceBeds({ ...body, mode: a.mode ?? 'propose' }, extra.signal));
			await cancelIfAborted(ctx, extra, job.id);
			const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 300) * 1000, extra);
			if (timedOut)
				return jsonResult({
					jobId: done.id,
					state: done.state,
					progress: done.progress,
					next: `The beds are still being measured: wait_for_job {jobId: "${done.id}"}.`,
				});
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'JOB_FAILED',
					done.error?.message ?? `Laying the beds ${done.state}`,
					done.error?.code === 'BED_SOUND_REQUIRED'
						? 'Name the bed: search_sounds {types: ["ambience"]} → soundId, or import an ambience and pass its mediaId.'
						: 'Check the sound / media ids (search_sounds, list_media), that the media is online and the scenes, then try again.',
				);
			const r = SoundBedsResultSchema.parse(done.result);
			return jsonResult({
				mode: r.mode,
				applied: r.applied,
				proposalId: r.proposalId,
				revision: r.revision,
				scenes: r.plan.scenes.length,
				table: bedTable(r.plan),
				...(r.plan.warnings.length ? { warnings: r.plan.warnings } : {}),
				next: r.proposalId
					? `Nothing was changed yet. Run sound_check {proposalId: "${r.proposalId}"}, then ask the user to review proposal ${r.proposalId} in the editor (Review panel) and wait_for_proposal.`
					: r.applied
						? 'Applied as one undo step "Lay Ambience Bed". You cannot hear: run sound_check (CLICK / EDGE / DIP at the joints) and give the user the scene timecodes to listen to.'
						: 'Nothing to lay.',
			});
		},
	);

	defineTool(
		ctx,
		'fill_room_tone',
		{
			title: 'Fill the gaps in dialogue with room tone',
			description: `Fills the holes between dialogue clips with room tone (spec 12 P6-E12), so a cut in the dialogue never drops to digital silence. Gaps: every hole between dialogue clips (Essential Sound dialogue or transcribed) shorter than 10 s inside a dialogue region, in range — or the gaps you pass; cover "regions" lays the tone under the whole of each dialogue region instead (under J- and L-cuts). The engine measures the dialogue's NOISE FLOOR (the quietest 20 % of its 100 ms frames outside its voice activity: level and octave bands) and ranks the room tones of the palette and the library (type roomtone) by the SHAPE distance of their clean window's octave bands to that floor; the closest within 6 dB is used, else the quietest 0.5–3 s without speech of the dialogue's own media, looped (source "library" / "dialogue" forces one; soundId / mediaId names it). It lays ordinary clips on a "Room Tone" track: each gap padded 0.25 s under the dialogue on both sides, 0.25 s fades there, looped with crossfades like lay_ambience_bed, at the floor's level (never under −56 dBFS, so the fill is never itself a SILENCE). Returns the gaps, the floor, the candidates with their distances, the choice and why, and the proposalId (mode "propose", default) or the applied revision (mode "apply": one undo step "Fill Room Tone"). sound_check offers the same fill as the fix of a SILENCE inside dialogue (not safe: the user's call). preview: true measures only.`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				mode: MODE,
				preview: PREVIEW,
				gaps: z.array(SPAN).min(1).max(500).optional().describe(`Frames to fill (default every gap between dialogue clips). ${TIME_FORMATS}`),
				range: SPAN.optional().describe(`Only gaps in [start, end). ${TIME_FORMATS}`),
				cover: z.enum(['gaps', 'regions']).optional().describe('"gaps" (default) or the whole dialogue regions'),
				source: z.enum(['auto', 'library', 'dialogue']).optional().describe('Where the tone comes from (default auto)'),
				soundId: SoundIdArg.optional().describe('A room tone of the library to use'),
				mediaId: z.string().min(1).max(128).optional().describe('A project media to use as the tone'),
				gainDb: z.number().min(-60).max(40).optional().describe('Clip gain (default: at the floor)'),
				label: z.string().min(1).max(200).optional().describe('Proposal title / History label'),
				timeoutSeconds: TIMEOUT,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const body = {
				projectId: a.projectId,
				sequenceId: seq.id,
				...(a.gaps ? { gaps: a.gaps.map((g, i) => spanOf(seq, g, `gaps[${i}]`)) } : {}),
				...(a.range ? { range: spanOf(seq, a.range, 'range') } : {}),
				...(a.cover ? { cover: a.cover } : {}),
				...(a.source ? { source: a.source } : {}),
				...(a.soundId ? { soundId: a.soundId } : {}),
				...(a.mediaId ? { mediaId: a.mediaId } : {}),
				...(a.gainDb !== undefined ? { gainDb: a.gainDb } : {}),
				...(a.label ? { label: a.label } : {}),
			};
			const summary = (p: SoundRoomTonePlan) => ({
				gaps: p.gaps.map((g) => ({ start: g.start, end: g.end, timecode: g.timecode, fill: g.fill })),
				floor: p.floor ? { levelDb: p.floor.levelDb, bandsDb: p.floor.bandsDb, clipIds: p.floor.clipIds } : null,
				candidates: roomToneTable(p),
				chosen: p.chosen
					? { source: p.chosen.source, title: p.chosen.sound.title, soundId: p.chosen.sound.soundId, distanceDb: p.chosen.distanceDb, gainDb: p.chosen.gainDb, loop: p.chosen.sound.loop, why: p.chosen.why }
					: null,
				...(p.warnings.length ? { warnings: p.warnings } : {}),
			});
			if (a.preview) {
				const plan = SoundRoomTonePlanSchema.parse(await ctx.engine((c) => c.planRoomTone(body, extra.signal)));
				return jsonResult({
					preview: true,
					...summary(plan),
					transaction: plan.commands,
					next: 'Nothing was changed. Call again without preview (mode "propose") to put it up for review.',
				});
			}
			const job = await ctx.engine((c) => c.fillRoomTone({ ...body, mode: a.mode ?? 'propose' }, extra.signal));
			await cancelIfAborted(ctx, extra, job.id);
			const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 300) * 1000, extra);
			if (timedOut)
				return jsonResult({
					jobId: done.id,
					state: done.state,
					progress: done.progress,
					next: `The dialogue is still being measured: wait_for_job {jobId: "${done.id}"}.`,
				});
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'JOB_FAILED',
					done.error?.message ?? `Filling room tone ${done.state}`,
					'Check that the dialogue clips are typed dialogue (auto_tag_audio / set_essential_sound) and their media online, then try again.',
				);
			const r = SoundRoomToneResultSchema.parse(done.result);
			return jsonResult({
				mode: r.mode,
				applied: r.applied,
				proposalId: r.proposalId,
				revision: r.revision,
				...summary(r.plan),
				next: r.proposalId
					? `Nothing was changed yet. Run sound_check {proposalId: "${r.proposalId}"}, then ask the user to review proposal ${r.proposalId} in the Review panel and wait_for_proposal.`
					: r.applied
						? 'Applied as one undo step "Fill Room Tone". Run sound_check: the SILENCE findings in those gaps should be gone; ask the user to listen at the gaps.'
						: 'Nothing to fill (see warnings).',
			});
		},
	);
}
