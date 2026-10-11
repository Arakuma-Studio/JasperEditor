import type {
	AudioAnalyzeRequest,
	AudioAnalyzeResult,
	EngineJob,
	LoudnessNormalizeResult,
} from '@jasper/api';
import {
	AUTOMATION_MODES,
	DUCK_DEFAULTS,
	laneValueAt,
	listStrips,
	mixFingerprint,
	pans51,
	type Sequence,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg } from '../arguments.ts';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	type Extra,
	frameOf,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
	waitJob,
} from '../context.ts';
import { toolEnvelope } from '../envelope.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { LOCAL_ENGINE_ID } from '../media.ts';

export const AUDIO_GUIDE = `Audio buses (Audio Track Mixer, loudness): every audio track, submix ("S1"…) and the Mix ("Mix") is a mixer strip — fader (volumeDb, −96 = −∞ … +15), pan (−100 … 100: −3 dB constant-power pan for mono tracks, balance for stereo), 5.1 panner (lanes pan51.x/y/center/lfe when the strip feeds a 5.1 bus), mute, solo (routing-aware), record-arm, automation mode (off | read | latch | touch | write), up to 5 effect slots (track effects via apply_commands effect.add; mixer.setInsertPosition puts one after the fader) and up to 5 sends (pre/post-fader) to later submixes; output = the Mix or a later submix. get_mixer shows every strip with its current values; set_mixer_strip changes settings; add_submix / add_send build buses; write_automation writes a lane over a time range (sample-accurate keyframes, one undo step). Track / Mix channel formats are mono, stereo or 5.1 (set_mixer_strip channelFormat; the Mix: strip "Mix"), sequence audio is 44.1 / 48 / 96 kHz (apply_commands sequence.updateSettings {audioSampleRate}); exports fold a 5.1 Mix to stereo (ITU-R BS.775) or write discrete 5.1 (start_export audioChannels: 6).
Loudness: measure_loudness gives ITU-R BS.1770-4 / EBU R128 integrated loudness (LUFS), loudness range (LU), true peak (dBTP), sample peak and max momentary / short-term for the sequence, an In/Out or frame range, soloed tracks, or single clips (levels "source" = without clip gain). set_loudness_normalization normalises the Mix to a target (−14 streaming, −16 podcast, −23 EBU R128, −24 ATSC) with a true-peak limit — heard in the preview and applied two-pass on export; analyze: true stores the measurement used by the preview. normalize_media_loudness makes a normalised WAV version of a media and can switch audio clips to it. set_audio_gain is Premiere's Audio Gain (set, adjust, normalizeMax, normalizeAll; the normalise modes measure peaks for you). auto_duck lowers music clips under dialogue (trigger tracks or clips) with Premiere's Sensitivity / Reduce By / Fades. Voice-over recording needs a microphone in the editor window (Sequence ▸ Record Voice-over); agents cannot record.`;

const StripArg = z.string().min(1).describe('Strip: "A1"…, "S1"…, "Mix", a track id or a track name');

function resultOf<T>(job: EngineJob): T {
	if (job.state !== 'succeeded')
		throw new ToolError(
			job.error?.code ?? 'E_ANALYSIS_FAILED',
			job.error?.message ?? `The job ${job.state}`,
			'Check that the media is online (get_media_info).',
		);
	return job.result as T;
}

export async function analyze(
	ctx: ToolContext,
	projectId: string,
	req: Pick<AudioAnalyzeRequest, 'sequenceId' | 'scope' | 'levels' | 'activity'>,
): Promise<AudioAnalyzeResult> {
	const { doc, revision } = await loadDoc(ctx, projectId);
	const job = await ctx.engine((c) =>
		c.analyzeAudio({ ...req, projectId, envelope: toolEnvelope(doc, revision) }, true),
	);
	return resultOf<AudioAnalyzeResult>(job);
}

export async function apply(
	ctx: ToolContext,
	projectId: string,
	label: string,
	commands: unknown[],
	extra: Extra,
	sequenceId?: string,
) {
	const res = await transact(
		ctx,
		projectId,
		{ label, commands, ...(sequenceId ? { sequenceId } : {}) },
		extra,
	);
	return txBody(res, requireOk(res));
}

function stripJson(seq: Sequence, t: number) {
	return listStrips(seq).map((s) => ({
		strip: s.label,
		id: s.id,
		name: s.name,
		kind: s.kind,
		channelFormat: s.format,
		automation: s.automation,
		volumeDb: Math.round(laneValueAt(s, 'volume', t) * 100) / 100,
		...(s.kind !== 'master'
			? pans51(seq, s.id)
				? {
						pan51: {
							x: laneValueAt(s, 'pan51.x', t),
							y: laneValueAt(s, 'pan51.y', t),
							center: laneValueAt(s, 'pan51.center', t),
							lfeDb: laneValueAt(s, 'pan51.lfe', t),
						},
					}
				: { pan: laneValueAt(s, 'pan', t) }
			: {}),
		...(s.kind !== 'master'
			? { mute: laneValueAt(s, 'mute', t) >= 0.5, solo: s.solo, soloSafe: s.soloSafe }
			: {}),
		...(s.kind === 'track' ? { recordArm: s.recordArm, inputMap: s.inputMap } : {}),
		...(s.output
			? {
					output:
						s.output === 'master'
							? 'Mix'
							: (listStrips(seq).find((x) => x.id === s.output)?.label ?? s.output),
				}
			: {}),
		sends: s.sends.map((x) => ({
			id: x.id,
			target: listStrips(seq).find((y) => y.id === x.target)?.label ?? x.target,
			levelDb: laneValueAt(s, `send.${x.id}.level`, t),
			pan: x.pan ?? 0,
			preFader: !!x.preFader,
			mute: !!x.mute,
		})),
		effects: s.effects.map((e) => ({
			id: e.id,
			effectId: e.effectId,
			enabled: e.enabled,
			postFader: !!e.postFader,
		})),
		automatedLanes: [
			...(s.volumeDb.keyframes.length ? ['volume'] : []),
			...(s.kind !== 'master' && s.pan.keyframes.length ? ['pan'] : []),
			...Object.entries(s.lanes)
				.filter(([, a]) => a.keyframes.length)
				.map(([k]) => k),
		],
	}));
}

export function registerAudioTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'measure_loudness',
		{
			title: 'Measure loudness',
			description:
				'ITU-R BS.1770-4 / EBU R128 measurement rendered by the export mixer: integrated loudness (LUFS), loudness range (LU), true peak (dBTP), sample peak, max momentary and short-term loudness. Scope: the whole sequence (default), a frame range or In/Out, soloed tracks, or clips (each clip separately plus all together; levels "source" measures the media without clip gain/volume/fades/pan).',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				scope: z.enum(['sequence', 'range', 'inOut', 'tracks', 'clips']).optional(),
				start: z.unknown().optional().describe('Range start (frames, {"seconds": x} or timecode)'),
				end: z.unknown().optional().describe('Range end (exclusive)'),
				tracks: z.array(z.string()).optional().describe('Audio tracks for scope "tracks" ("A1"… or ids)'),
				clipIds: z.array(z.string()).optional().describe('Clips for scope "clips"'),
				levels: z.enum(['mix', 'source']).optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, scope, start, end, tracks, clipIds, levels }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const kind =
				scope ??
				(clipIds?.length ? 'clips' : tracks?.length ? 'tracks' : start !== undefined ? 'range' : 'sequence');
			let s: AudioAnalyzeRequest['scope'];
			if (kind === 'clips') {
				if (!clipIds?.length)
					throw new ToolError(
						'E_INVALID_PARAM',
						'scope "clips" needs clipIds',
						'get_timeline lists clip ids.',
					);
				s = { type: 'clips', clipIds };
			} else if (kind === 'tracks') {
				if (!tracks?.length)
					throw new ToolError('E_INVALID_PARAM', 'scope "tracks" needs tracks', 'Pass e.g. ["A1"].');
				s = { type: 'tracks', trackIds: tracks };
			} else if (kind === 'inOut') s = { type: 'range', inOut: true };
			else if (kind === 'range')
				s = {
					type: 'range',
					...(start !== undefined ? { startFrame: frameOf(seq, start) } : {}),
					...(end !== undefined ? { endFrame: frameOf(seq, end) } : {}),
				};
			else s = { type: 'sequence' };
			const r = await analyze(ctx, projectId, {
				sequenceId: seq.id,
				scope: s,
				...(levels ? { levels } : {}),
			});
			return jsonResult({ ...r, stale: false });
		},
	);

	defineTool(
		ctx,
		'get_mixer',
		{
			title: 'Get Audio Track Mixer',
			description:
				'Every mixer strip (audio tracks A1…, submixes S1…, the Mix) with its values at a time (default 0): fader dB, pan or 5.1 panner, mute, solo, record-arm, automation mode, channel format, input map, output, sends, effect slots and automated lanes; plus the Mix loudness normalisation and whether its analysis is current.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				at: z.unknown().optional().describe('Time to read automated values at'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, at }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const F = (705_600_000 * seq.settings.frameRate.den) / seq.settings.frameRate.num;
			const t = at !== undefined ? frameOf(seq, at) * F : 0;
			const l = seq.master.loudness;
			return jsonResult({
				sequenceId: seq.id,
				sampleRate: seq.settings.audioSampleRate,
				masterLayout: seq.settings.masterLayout,
				strips: stripJson(seq, t),
				loudness: l
					? { ...l, analysisCurrent: !!l.analysis && l.analysis.mixHash === mixFingerprint(doc, seq.id) }
					: null,
			});
		},
	);

	defineTool(
		ctx,
		'set_mixer_strip',
		{
			title: 'Set mixer strip',
			description:
				'Changes a strip of the Audio Track Mixer: volumeDb, pan, mute, solo, soloSafe, recordArm, automation mode, channelFormat (mono | stereo | 5.1; for "Mix" the sequence master format), inputMap (stereo | left | right | swap | mono), output (a later submix or "Mix"), name; and 5.1 panner values (pan51: {x, y, center, lfeDb}). Static values; use write_automation for keyframes.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				strip: StripArg,
				volumeDb: z.number().min(-96).max(15).optional(),
				pan: z.number().min(-100).max(100).optional(),
				mute: z.boolean().optional(),
				solo: z.boolean().optional(),
				soloSafe: z.boolean().optional(),
				recordArm: z.boolean().optional(),
				automation: z.enum(AUTOMATION_MODES).optional(),
				channelFormat: z.enum(['mono', 'stereo', '5.1']).optional(),
				inputMap: z.enum(['stereo', 'left', 'right', 'swap', 'mono']).optional(),
				output: z.string().optional().describe('"Mix" or a later submix ("S2")'),
				name: z.string().optional(),
				pan51: z
					.object({
						x: z.number().min(-100).max(100).optional(),
						y: z.number().min(-100).max(100).optional(),
						center: z.number().min(0).max(100).optional(),
						lfeDb: z.number().min(-96).max(15).optional(),
					})
					.optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const patch: Record<string, unknown> = {};
			for (const k of [
				'volumeDb',
				'pan',
				'mute',
				'solo',
				'soloSafe',
				'recordArm',
				'automation',
				'channelFormat',
				'inputMap',
				'name',
			] as const)
				if (a[k] !== undefined) patch[k] = a[k];
			if (a.output !== undefined) patch.output = /^(mix|master)$/i.test(a.output) ? null : a.output;
			const commands: unknown[] = [];
			if (Object.keys(patch).length)
				commands.push({ type: 'mixer.updateStrip', sequenceId: seq.id, stripId: a.strip, patch });
			const p51 = a.pan51 ?? {};
			for (const [k, lane] of [
				['x', 'pan51.x'],
				['y', 'pan51.y'],
				['center', 'pan51.center'],
				['lfeDb', 'pan51.lfe'],
			] as const)
				if (p51[k] !== undefined)
					commands.push({ type: 'mixer.setLane', sequenceId: seq.id, stripId: a.strip, lane, value: p51[k] });
			if (!commands.length)
				throw new ToolError('E_INVALID_PARAM', 'Nothing to change', 'Pass at least one setting.');
			return jsonResult(await apply(ctx, a.projectId, 'Audio Track Mixer', commands, extra, seq.id));
		},
	);

	defineTool(
		ctx,
		'add_submix',
		{
			title: 'Add submix',
			description:
				'Adds a submix track (a bus without clips) to the Audio Track Mixer; route tracks to it with set_mixer_strip output or add_send.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				name: z.string().optional(),
				channelFormat: z.enum(['mono', 'stereo', '5.1']).optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, name, channelFormat }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			return jsonResult(
				await apply(
					ctx,
					projectId,
					'Add Submix Track',
					[
						{
							type: 'mixer.addSubmix',
							sequenceId: seq.id,
							...(name ? { name } : {}),
							...(channelFormat ? { channelFormat } : {}),
						},
					],
					extra,
					seq.id,
				),
			);
		},
	);

	defineTool(
		ctx,
		'add_send',
		{
			title: 'Add send',
			description:
				'Adds a send from a strip to a later submix (post-fader unless preFader: true; a pre-fader send of a muted track keeps sending).',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				strip: StripArg,
				target: z.string().min(1).describe('Submix ("S1"…)'),
				levelDb: z.number().min(-96).max(15).optional(),
				pan: z.number().min(-100).max(100).optional(),
				preFader: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, strip, target, levelDb, pan, preFader }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			return jsonResult(
				await apply(
					ctx,
					projectId,
					'Add Send',
					[
						{
							type: 'mixer.addSend',
							sequenceId: seq.id,
							stripId: strip,
							target,
							...(levelDb !== undefined ? { levelDb } : {}),
							...(pan !== undefined ? { pan } : {}),
							...(preFader ? { preFader } : {}),
						},
					],
					extra,
					seq.id,
				),
			);
		},
	);

	defineTool(
		ctx,
		'write_automation',
		{
			title: 'Write mixer automation',
			description:
				'Writes a strip lane (volume, pan, mute, pan51.x|y|center|lfe, send.<sendId>.level) as keyframes from points [[time, value], …] (times: frames, {"seconds": x} or timecode), replacing the lane\'s keyframes between the first and last point and keeping the automation outside (like one Write pass). Thinning tolerance default 0.05 dB (0.25 for pan); tolerance 0 keeps every point.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				strip: StripArg,
				lane: z.string().min(1),
				points: z.array(z.tuple([z.unknown(), z.number()])).min(1),
				tolerance: z.number().min(0).optional(),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ projectId, sequenceId, strip, lane, points, tolerance }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const F = (705_600_000 * seq.settings.frameRate.den) / seq.settings.frameRate.num;
			const pts = points.map(([t, v]) => {
				const s =
					t && typeof t === 'object' && 'seconds' in (t as object)
						? Number((t as { seconds: number }).seconds)
						: null;
				return [s !== null ? Math.round(s * 705_600_000) : frameOf(seq, t) * F, v] as [number, number];
			});
			return jsonResult(
				await apply(
					ctx,
					projectId,
					'Write Automation',
					[
						{
							type: 'mixer.writeAutomation',
							sequenceId: seq.id,
							stripId: strip,
							lane,
							points: pts,
							...(tolerance !== undefined ? { thinning: { tolerance } } : {}),
						},
					],
					extra,
					seq.id,
				),
			);
		},
	);

	defineTool(
		ctx,
		'set_audio_gain',
		{
			title: 'Audio Gain',
			description:
				"Premiere's Audio Gain on audio clips: set (gain to db), adjust (by db), normalizeMax (the loudest peak of the clips reaches db, every clip moves by the same amount) or normalizeAll (each clip's peak reaches db). The normalise modes measure the clips' source peaks first.",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipIds: z.array(z.string().min(1)).min(1),
				mode: z.enum(['set', 'adjust', 'normalizeMax', 'normalizeAll']),
				db: z.number().min(-96).max(96),
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, clipIds, mode, db }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			let peaks: Record<string, number | null> | undefined;
			if (mode === 'normalizeMax' || mode === 'normalizeAll') {
				const r = await analyze(ctx, projectId, {
					sequenceId: seq.id,
					scope: { type: 'clips', clipIds },
					levels: 'source',
				});
				peaks = Object.fromEntries(clipIds.map((id) => [id, r.clips?.[id]?.samplePeakDb ?? null]));
			}
			const body = await apply(
				ctx,
				projectId,
				'Audio Gain',
				[{ type: 'audio.setGain', clipIds, mode, db, ...(peaks ? { peaks } : {}) }],
				extra,
				seq.id,
			);
			return jsonResult({ ...body, ...(peaks ? { measuredPeaksDb: peaks } : {}) });
		},
	);

	defineTool(
		ctx,
		'auto_duck',
		{
			title: 'Auto duck',
			description:
				'Ducks target clips (music, ambience) under trigger audio (dialogue): the triggers (tracks or clips) are mixed and analysed (RMS envelope, activity above −20 − 4·sensitivity dBFS, gaps bridged, blips dropped), then volume keyframes duck each target by amountDb with fadeMs ramps (one undo step). Defaults: sensitivity 6, amountDb 18, fadeMs 800 (Premiere Essential Sound).',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				targetClipIds: z.array(z.string().min(1)).min(1),
				triggerTracks: z.array(z.string()).optional().describe('Trigger tracks ("A1"… or ids)'),
				triggerClipIds: z.array(z.string()).optional().describe('Trigger clips (instead of tracks)'),
				sensitivity: z.number().min(0).max(10).optional(),
				amountDb: z.number().min(0).max(96).optional(),
				fadeMs: z.number().min(0).max(10_000).optional(),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const targets = a.targetClipIds.map((id) => seq.clips[id]);
			if (targets.some((c) => !c))
				throw new ToolError(
					'E_NOT_FOUND',
					'A target clip is not in this sequence',
					'get_timeline lists clip ids.',
				);
			if (!a.triggerTracks?.length && !a.triggerClipIds?.length)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give triggerTracks or triggerClipIds',
					'Usually the dialogue track, e.g. ["A1"].',
				);
			const start = Math.min(...targets.map((c) => c!.start));
			const end = Math.max(...targets.map((c) => c!.start + c!.duration));
			const r = await analyze(ctx, a.projectId, {
				sequenceId: seq.id,
				scope: a.triggerClipIds?.length
					? { type: 'clips', clipIds: a.triggerClipIds }
					: { type: 'tracks', trackIds: a.triggerTracks! },
				activity: {
					sensitivity: a.sensitivity ?? DUCK_DEFAULTS.sensitivity,
					startFrame: start,
					endFrame: end,
				},
			});
			const regions = r.activity?.regions ?? [];
			const body = await apply(
				ctx,
				a.projectId,
				'Auto Duck',
				[
					{
						type: 'audio.autoDuck',
						targetClipIds: a.targetClipIds,
						regions,
						amountDb: a.amountDb ?? DUCK_DEFAULTS.amountDb,
						fadeMs: a.fadeMs ?? DUCK_DEFAULTS.fadeMs,
					},
				],
				extra,
				seq.id,
			);
			return jsonResult({ ...body, triggerRegions: regions.length, thresholdDb: r.activity?.thresholdDb });
		},
	);

	defineTool(
		ctx,
		'set_loudness_normalization',
		{
			title: 'Set loudness normalization',
			description:
				'Normalises the Mix of a sequence to a target loudness with a true-peak limit: heard in the preview (gain target − measured + a look-ahead true-peak limiter) and applied two-pass on every export. analyze: true (default) measures the current mix now and stores it for the preview.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				enabled: z.boolean().optional(),
				targetLufs: z.number().min(-60).max(0).optional(),
				truePeakDb: z.number().min(-20).max(0).optional(),
				analyze: z.boolean().optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, sequenceId, enabled, targetLufs, truePeakDb, analyze: doAnalyze }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			let analysis: Record<string, unknown> | undefined;
			if (doAnalyze !== false) {
				const r = await analyze(ctx, projectId, { sequenceId: seq.id, scope: { type: 'sequence' } });
				analysis = {
					integratedLufs: r.loudness.integratedLufs,
					truePeakDbtp: r.loudness.truePeakDbtp,
					lra: r.loudness.lra,
					maxMomentaryLufs: r.loudness.maxMomentaryLufs,
					maxShortTermLufs: r.loudness.maxShortTermLufs,
					mixHash: r.mixHash,
					analyzedAt: new Date().toISOString(),
				};
			}
			const body = await apply(
				ctx,
				projectId,
				'Loudness Normalization',
				[
					{
						type: 'mixer.setLoudness',
						sequenceId: seq.id,
						enabled: enabled ?? true,
						...(targetLufs !== undefined ? { targetLufs } : {}),
						...(truePeakDb !== undefined ? { truePeakDb } : {}),
						...(analysis ? { analysis } : {}),
					},
				],
				extra,
				seq.id,
			);
			return jsonResult({ ...body, ...(analysis ? { analysis } : {}) });
		},
	);

	defineTool(
		ctx,
		'normalize_media_loudness',
		{
			title: 'Normalize media loudness',
			description:
				'Makes a loudness-normalised version of a media\'s audio (two-pass: measure, gain to targetLufs, look-ahead true-peak limiter at truePeakDb; 24-bit WAV), adds it to the project (bin "Processed") and, with replaceInClips, switches those audio clips to it — one undo step. Waits for the job (timeoutSeconds, default 600).',
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().min(1),
				targetLufs: z.number().min(-60).max(0),
				truePeakDb: z.number().min(-20).max(0).optional(),
				replaceInClips: z.array(z.string()).optional(),
				timeoutSeconds: z.number().int().min(1).max(900).optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, mediaId, targetLufs, truePeakDb, replaceInClips, timeoutSeconds }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const asset = doc.media[mediaId];
			if (!asset) throw new ToolError('E_NOT_FOUND', `No media ${mediaId}`, 'Call list_media for valid ids.');
			const loc = asset.locators.find((l) => l.type === 'engine-store') as { key: string } | undefined;
			if (!loc)
				throw new ToolError(
					'E_INVALID_PARAM',
					`Media ${mediaId} is not known to the engine`,
					'Re-import it.',
				);
			const job0 = await ctx.engine((c) =>
				c.normalizeMediaLoudness(loc.key, { targetLufs, truePeakDb: truePeakDb ?? -1, projectId }),
			);
			const { job, timedOut } = await waitJob(ctx, job0.id, (timeoutSeconds ?? 600) * 1000, extra);
			if (timedOut)
				throw new ToolError(
					'E_TIMEOUT',
					'The normalisation is still running',
					`Call wait_for_job ${job.id}, then this tool again.`,
				);
			const r = resultOf<LoudnessNormalizeResult>(job);
			const reg = r.registered;
			const body = await apply(
				ctx,
				projectId,
				'Normalize Loudness',
				[
					{
						type: 'media.derive',
						fromMediaId: mediaId,
						recipe: { op: 'loudness-normalize', targetLufs, truePeakDb: truePeakDb ?? -1 },
						asset: {
							fingerprint: reg.fingerprint,
							originalName: reg.originalName,
							sizeBytes: reg.sizeBytes,
							container: reg.container,
							probe: reg.probe,
							locators: [{ type: 'engine-store', engineId: LOCAL_ENGINE_ID, key: reg.mediaKey }],
							recipeVersion: r.recipeVersion,
							recipeHash: r.recipeHash,
						},
						...(replaceInClips?.length ? { replaceInClips } : {}),
					},
				],
				extra,
			);
			return jsonResult({ ...body, before: r.before, after: r.after, gainDb: r.gainDb });
		},
	);
}
