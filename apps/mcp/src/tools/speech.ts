// wp speech MCP tools: local speech-to-text (Whisper on the engine) — models, transcribe (media, clips or a sequence:
// its clip media or its mix) and get_transcript (a media's transcript, or a sequence's as heard through its clips).
import type { EngineJob, SpeechModel, TranscriptionResult } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import {
	FLICKS_PER_SECOND,
	formatTimecode,
	type MediaAsset,
	makeEnvelope,
	mixFingerprint,
	type ProjectDocument,
	sequenceWords,
	speakerName,
	type Transcript,
	transcriptAttachPlan,
	transcriptForMedia,
} from '@jasper/project';
import { z } from 'zod';
import {
	DESTRUCTIVE,
	defineTool,
	EDIT,
	jobBody,
	loadDoc,
	READ_ONLY,
	requireOk,
	requireSequence,
	type ToolContext,
	transact,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions. */
export const SPEECH_GUIDE = `Speech to text (local Whisper on the engine; nothing is uploaded): list_speech_models shows the models (tiny / base / small, multilingual or English-only ".en"; size, licence, installed); install_speech_model downloads one (pinned revision, SHA-256 verified; the licence is MIT — say so to the user). transcribe makes transcripts: mediaId / clipId (that media), or sequenceId with mode "media" (default: every clip media heard in the sequence without a transcript, or all with replace: true) or "mix" (the sequence's mixed audio, optionally inOutOnly; the words go back to the clips' media in media time, covering only what the sequence plays). Options: model (default whisper-base), language (ISO 639-1, default auto-detect), translate (English text of other languages), speakerLabels (+ speakerCount when known). Word times come from cross-attention alignment refined against the audio (pauses stay pauses), with a confidence per word. With wait (default true) it commits ONE undo step "Generate Transcript"; with wait: false it returns the jobs — follow them with wait_for_job, then call transcribe {projectId, jobIds} to commit. get_transcript reads a media's transcript (media time) or a sequence's (sequence time, as heard through its audio clips). Then use the transcript_* / captions tools for text-based editing and captions.`;

const OptionsShape = {
	model: z
		.string()
		.optional()
		.describe('Speech model id from list_speech_models (default: the catalogue default, whisper-base)'),
	language: z.string().optional().describe('ISO 639-1 language code, or "auto" (default) to detect it'),
	translate: z
		.boolean()
		.optional()
		.describe('Translate speech in other languages to English text (multilingual models)'),
	speakerLabels: z.boolean().optional().describe('Label speakers (S1, S2…)'),
	speakerCount: z.number().int().min(1).max(32).optional().describe('Exact number of speakers when known'),
	beamSize: z
		.number()
		.int()
		.min(1)
		.max(10)
		.optional()
		.describe('Beam search width (default 5; 1 = faster greedy)'),
};

type Opts = {
	model?: string;
	language?: string;
	translate?: boolean;
	speakerLabels?: boolean;
	speakerCount?: number;
	beamSize?: number;
};

function requestOf(o: Opts) {
	return {
		...(o.model ? { model: o.model } : {}),
		...(o.language && o.language !== 'auto' ? { language: o.language } : {}),
		...(o.translate ? { task: 'translate' as const } : {}),
		...(o.speakerLabels || o.speakerCount ? { speakerLabels: true } : {}),
		...(o.speakerCount ? { speakerCount: o.speakerCount } : {}),
		...(o.beamSize ? { beamSize: o.beamSize } : {}),
	};
}

function mediaKeyOf(doc: ProjectDocument, mediaId: string): string {
	const asset = doc.media[mediaId] as MediaAsset | undefined;
	if (!asset)
		throw new ToolError(
			'E_NOT_FOUND',
			`No media ${mediaId} in this project`,
			'Call list_media for media ids.',
		);
	const loc = asset.locators.find((l) => l.type === 'engine-store') as { key: string } | undefined;
	if (!loc)
		throw new ToolError(
			'E_INVALID_PARAM',
			`Media ${mediaId} is not stored by the engine`,
			'Re-import it with import_media.',
		);
	return loc.key;
}

function clipMediaId(doc: ProjectDocument, clipId: string): string {
	for (const seq of Object.values(doc.sequences)) {
		const c = seq.clips[clipId] as { kind?: string; mediaId?: string } | undefined;
		if (!c) continue;
		if ((c.kind !== 'audio' && c.kind !== 'video') || !c.mediaId)
			throw new ToolError(
				'E_INVALID_PARAM',
				`Clip ${clipId} has no media with sound`,
				'Pass an audio or video clip.',
			);
		return c.mediaId;
	}
	throw new ToolError('E_NOT_FOUND', `No clip ${clipId}`, 'Call get_timeline for clip ids.');
}

async function speechCall<T>(
	ctx: ToolContext,
	fn: (c: Parameters<Parameters<ToolContext['engine']>[0]>[0]) => Promise<T>,
): Promise<T> {
	try {
		return await ctx.engine(fn);
	} catch (e) {
		if (e instanceof EngineError) {
			const code = (e.detail as { code?: string } | undefined)?.code ?? e.code;
			if (code === 'SPEECH_MODEL_NOT_INSTALLED')
				throw new ToolError(
					code,
					e.message,
					'Install it with install_speech_model (tell the user its size and licence), then retry.',
				);
			throw new ToolError(code, e.message);
		}
		throw e;
	}
}

type Pending = { jobId: string; mediaId?: string };

/** Commits finished transcription jobs (one transaction). */
async function commit(
	ctx: ToolContext,
	projectId: string,
	jobs: Array<{ job: EngineJob; mediaId?: string }>,
	replace: boolean,
	extra: Parameters<typeof transact>[3],
) {
	const { doc } = await loadDoc(ctx, projectId);
	const commands: unknown[] = [];
	const report: Array<Record<string, unknown>> = [];
	for (const { job, mediaId } of jobs) {
		if (job.state !== 'succeeded') {
			report.push({ jobId: job.id, state: job.state, error: job.error ?? null });
			continue;
		}
		const res = job.result as TranscriptionResult;
		let target = mediaId;
		if (res.target.type === 'media' && !target) {
			const key = res.target.mediaKey;
			target = (Object.values(doc.media) as MediaAsset[]).find((m) =>
				m.locators.some((l) => l.type === 'engine-store' && (l as { key: string }).key === key),
			)?.id;
		}
		const plan = transcriptAttachPlan(doc, res, {
			...(target ? { mediaId: target } : {}),
			replace,
			...(res.target.type === 'sequence' && doc.sequences[res.target.sequenceId]
				? { currentMixHash: mixFingerprint(doc, res.target.sequenceId) }
				: {}),
		});
		if ('error' in plan) {
			report.push({ jobId: job.id, state: job.state, error: plan.error });
			continue;
		}
		commands.push(...plan.commands);
		report.push({
			jobId: job.id,
			language: res.language,
			languageProbability: res.languageProbability,
			model: res.model,
			task: res.task,
			speakers: Object.keys(res.speakers).length,
			media: plan.media,
			...(plan.unassigned ? { droppedWords: plan.unassigned } : {}),
			seconds: Math.round(res.duration / FLICKS_PER_SECOND),
			transcribeSeconds: Math.round(res.timings.transcribeMs / 100) / 10,
		});
	}
	if (!commands.length)
		throw new ToolError('E_NOTHING_TO_COMMIT', 'No transcript to add', 'See the job states.', {
			jobs: report,
		});
	const tx = await transact(ctx, projectId, { label: 'Generate Transcript', commands }, extra);
	const ok = requireOk(tx);
	return jsonResult({
		ok: true,
		revision: ok.revision,
		transcripts: ok.results.map((r) => r as { transcriptId: string; words: number }),
		jobs: report,
		next: 'get_transcript or transcript_inspect to read it; captions_from_transcript for captions.',
	});
}

export function registerSpeechTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_speech_models',
		{
			title: 'List speech models',
			description:
				'The speech-to-text models (OpenAI Whisper on ONNX Runtime): id, name, parameters, languages (multilingual or English-only), size, licence and attribution, pinned revision, and whether each is installed.',
			input: {},
			annotations: READ_ONLY,
		},
		async () => jsonResult(await speechCall(ctx, (c) => c.call('speechModels'))),
	);

	defineTool(
		ctx,
		'install_speech_model',
		{
			title: 'Install speech model',
			description:
				'Downloads a speech model (each file pinned to a Hugging Face revision and checked against its SHA-256) through a model-download job. Tell the user the size and licence (MIT) first. Returns the job; follow it with wait_for_job.',
			input: { modelId: z.string().min(1).describe('Model id from list_speech_models') },
			annotations: EDIT,
		},
		async ({ modelId }) => {
			const models = ((await speechCall(ctx, (c) => c.call('speechModels'))) as { models: SpeechModel[] })
				.models;
			const m = models.find((x) => x.id === modelId);
			if (!m)
				throw new ToolError('E_NOT_FOUND', `Unknown speech model ${modelId}`, 'Call list_speech_models.');
			const job = await speechCall(ctx, (c) => c.call('speechModelInstall', { params: { modelId } }));
			return jsonResult({
				...jobBody(job as EngineJob, ctx.link.target?.url ?? ''),
				model: { id: m.id, sizeBytes: m.sizeBytes, license: m.license, attribution: m.attribution },
				next: 'Call wait_for_job with this jobId.',
			});
		},
	);

	defineTool(
		ctx,
		'remove_speech_model',
		{
			title: 'Remove speech model',
			description:
				"Deletes a downloaded speech model from the engine (transcripts already made are kept). Needs the user's approval in an open JasperEditor window.",
			input: { modelId: z.string().min(1) },
			annotations: DESTRUCTIVE,
		},
		async ({ modelId }) =>
			jsonResult(await speechCall(ctx, (c) => c.call('speechModelDelete', { params: { modelId } }))),
	);

	defineTool(
		ctx,
		'transcribe',
		{
			title: 'Transcribe',
			description:
				'Speech to text on the engine (local Whisper) with word timestamps, optional language detection, translation to English and speaker labels. Target: mediaId, clipId (its media), or sequenceId (mode "media": each clip media heard in it — one transcript per media, reused by all its clips; mode "mix": the mixed audio, words mapped back to the clips\' media). With wait (default true) it waits (timeoutSeconds, default 600) and commits one undo step; with wait: false it returns the job ids — then call transcribe {projectId, jobIds} to commit.',
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().optional().describe('Media id ("med_…")'),
				clipId: z.string().optional().describe('Audio or video clip id ("clp_…"): its media is transcribed'),
				sequenceId: z.string().optional().describe('Sequence id ("seq_…")'),
				mode: z.enum(['media', 'mix']).optional().describe('For a sequence: "media" (default) or "mix"'),
				inOutOnly: z.boolean().optional().describe('Mix mode: only the sequence In/Out range'),
				replace: z
					.boolean()
					.optional()
					.describe(
						'Replace existing transcripts (default true for media/clips; for a sequence in media mode, false = skip media that have one)',
					),
				...OptionsShape,
				wait: z.boolean().optional().describe('Wait for the jobs and commit (default true)'),
				timeoutSeconds: z.number().int().min(1).max(3600).optional(),
				jobIds: z
					.array(z.string())
					.optional()
					.describe('Commit these finished transcription jobs (from wait: false)'),
			},
			annotations: EDIT,
		},
		async (args, extra) => {
			const { projectId } = args;
			const base = ctx.link.target?.url ?? '';
			if (args.jobIds?.length) {
				const jobs = await Promise.all(
					args.jobIds.map(async (id) => ({ job: (await ctx.engine((c) => c.getJob(id))) as EngineJob })),
				);
				const running = jobs.filter(
					(j) => !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.job.state),
				);
				if (running.length)
					throw new ToolError(
						'E_NOT_READY',
						`${running.length} job(s) still running`,
						'Call wait_for_job first.',
					);
				return commit(ctx, projectId, jobs, args.replace ?? true, extra);
			}
			const targets = [args.mediaId, args.clipId, args.sequenceId].filter(Boolean).length;
			if (targets !== 1)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give exactly one of mediaId, clipId or sequenceId',
					'list_media / get_timeline list ids.',
				);
			const { doc } = await loadDoc(ctx, projectId);
			const opts = requestOf(args);
			const pending: Pending[] = [];
			const submitMedia = async (mediaId: string) => {
				const key = mediaKeyOf(doc, mediaId);
				const job = (await speechCall(ctx, (c) =>
					c.call('mediaTranscribe', { params: { key }, body: { ...opts, projectId } }),
				)) as EngineJob;
				pending.push({ jobId: job.id, mediaId });
			};
			let replace = args.replace ?? true;
			if (args.mediaId) await submitMedia(args.mediaId);
			else if (args.clipId) await submitMedia(clipMediaId(doc, args.clipId));
			else {
				const seq = requireSequence(doc, args.sequenceId);
				if (args.mode === 'mix') {
					const envelope = makeEnvelope(doc, {
						revision: 0,
						savedAt: new Date().toISOString(),
						platform: 'mcp',
					});
					const job = (await speechCall(ctx, (c) =>
						c.call('speechTranscribeSequence', {
							body: {
								...opts,
								envelope,
								sequenceId: seq.id,
								projectId,
								range: args.inOutOnly ? 'in-out' : 'entire',
							},
						}),
					)) as EngineJob;
					pending.push({ jobId: job.id });
				} else {
					replace = args.replace ?? false;
					const media = [
						...new Set(
							Object.values(seq.clips)
								.filter((c) => c.kind === 'audio' && c.enabled)
								.sort((a, b) => a.start - b.start)
								.map((c) => (c as { mediaId: string }).mediaId),
						),
					].filter((id) => replace || !transcriptForMedia(doc, id));
					if (!media.length)
						throw new ToolError(
							'E_NOTHING_TO_DO',
							'Every audio clip media of the sequence already has a transcript (or there is none)',
							'Pass replace: true to transcribe again, or mode: "mix".',
						);
					for (const id of media) await submitMedia(id);
				}
			}
			if (args.wait === false)
				return jsonResult({
					jobs: pending,
					next: `Call wait_for_job for each job, then transcribe {projectId, jobIds: [${pending.map((p) => `"${p.jobId}"`).join(', ')}]} to commit.`,
				});
			const deadline = (args.timeoutSeconds ?? 600) * 1000;
			const done: Array<{ job: EngineJob; mediaId?: string }> = [];
			for (const p of pending) {
				const { job, timedOut } = await waitJob(ctx, p.jobId, deadline, extra);
				if (timedOut)
					return jsonResult({
						...jobBody(job, base),
						timedOut: true,
						jobs: pending,
						next: `Call wait_for_job, then transcribe {projectId, jobIds: [${pending.map((x) => `"${x.jobId}"`).join(', ')}]}.`,
					});
				done.push({ job, ...(p.mediaId ? { mediaId: p.mediaId } : {}) });
			}
			const failed = done.filter((d) => d.job.state !== 'succeeded');
			if (failed.length === done.length) {
				const j = failed[0]!.job;
				throw new ToolError(
					j.error?.code ?? `JOB_${j.state.toUpperCase()}`,
					j.error?.message ?? `The job ${j.state}`,
					undefined,
					jobBody(j, base),
				);
			}
			return commit(ctx, projectId, done, replace, extra);
		},
	);

	defineTool(
		ctx,
		'get_transcript',
		{
			title: 'Get transcript',
			description:
				'Reads a transcript: of a media (mediaId or clipId: words in media time, with confidence and speaker; language, model, coverage) or of a sequence (sequenceId: the words heard through its audio clips in sequence time, with frames and timecode, clip and media). Pages with fromWord / maxWords.',
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().optional(),
				clipId: z.string().optional(),
				sequenceId: z.string().optional(),
				fromWord: z.number().int().min(0).optional(),
				maxWords: z.number().int().min(1).max(5000).optional().describe('Default 500'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, mediaId, clipId, sequenceId, fromWord, maxWords }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const from = fromWord ?? 0;
			const n = maxWords ?? 500;
			const sec = (f: number) => Math.round((f / FLICKS_PER_SECOND) * 1000) / 1000;
			if (mediaId || clipId) {
				const id = mediaId ?? clipMediaId(doc, clipId as string);
				if (!doc.media[id]) throw new ToolError('E_NOT_FOUND', `No media ${id}`, 'Call list_media.');
				const t = transcriptForMedia(doc, id) as Transcript | null;
				if (!t)
					return jsonResult({
						mediaId: id,
						transcript: null,
						next: 'transcribe {mediaId} makes one (or import_transcript).',
					});
				return jsonResult({
					mediaId: id,
					transcriptId: t.id,
					language: t.language,
					origin: t.origin,
					model: t.model ?? null,
					task: t.task ?? 'transcribe',
					...(t.sourceLanguage ? { sourceLanguage: t.sourceLanguage } : {}),
					createdAt: t.createdAt ?? null,
					coverageSeconds: t.coverage?.map(([a, b]) => [sec(a), sec(b)]) ?? 'whole media',
					speakers: Object.fromEntries(Object.keys(t.speakers).map((k) => [k, speakerName(t, k)])),
					totalWords: t.words.length,
					fromWord: from,
					words: t.words.slice(from, from + n).map((w, i) => ({
						index: from + i,
						text: w.text,
						start: sec(w.start),
						end: sec(w.end),
						confidence: w.confidence,
						speaker: w.speaker,
					})),
					text: t.words
						.slice(from, from + n)
						.map((w) => w.text)
						.join(' '),
				});
			}
			const seq = requireSequence(doc, sequenceId);
			const words = sequenceWords(doc, seq);
			const F = FLICKS_PER_SECOND * (seq.settings.frameRate.den / seq.settings.frameRate.num);
			return jsonResult({
				sequenceId: seq.id,
				totalWords: words.length,
				fromWord: from,
				words: words.slice(from, from + n).map((w, i) => {
					const frame = Math.floor(w.start / F);
					return {
						index: from + i,
						text: w.text,
						start: sec(w.start),
						end: sec(w.end),
						frame,
						timecode: formatTimecode(frame, seq.settings.frameRate, { dropFrame: seq.settings.dropFrame }),
						speaker: w.speaker,
						confidence: w.confidence,
						clipId: w.clipId,
						mediaId: w.mediaId,
					};
				}),
				text: words
					.slice(from, from + n)
					.map((w) => w.text)
					.join(' '),
				...(words.length ? {} : { next: 'transcribe {sequenceId} makes transcripts for its clip media.' }),
			});
		},
	);
}
