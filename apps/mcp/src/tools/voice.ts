// Voice analysis for agents (spec 14 TC-001; docs/wp-notes/transcript-cleanup.md "Voice analysis"): `get_voice_analysis`
// reads a media stream's 10 ms voice frames — the engine's `voice-analysis` job, run on demand and cached — as totals,
// levels per 60 s window and, with summary: false, one page of downsampled frames and class runs.
import type { EngineJob } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import {
	summarizeVoiceAnalysis,
	type VoiceAnalysis,
	voiceAnalysisPage,
	voiceFrameAt,
	voiceFrameSeconds,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg } from '../arguments.ts';
import { defineTool, isTerminal, loadDoc, READ_ONLY, type ToolContext, waitJob } from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';

/** Longest page (seconds) and its most points. */
const MAX_PAGE_SECONDS = 600;
const MAX_POINTS = 6000;

export const VOICE_GUIDE = `Voice analysis (what the speech in a recording does, measured — not the words): get_voice_analysis {projectId, mediaId, stream?} returns the 10 ms frame analysis of one audio stream of a media: its noise floor (10th percentile of the levels), speech level (95th percentile), the speech threshold (30 % of the way from floor to speech level, ≥ 6 dB over the floor), the same per 60 s window (rooms drift), and seconds / runs / longest run of each frame class — speech (above the threshold and voiced, or 10 dB above it), breath (unvoiced noise-like sound 5 dB over the floor, 120–900 ms long) and silence. The engine computes it once per file and stream (a job with progress; cancel the request to cancel it) and keeps it in the media cache. summary: false adds one page of frames — fromSeconds (default 0), seconds (default 60, ≤ ${MAX_PAGE_SECONDS}), stepMs (default 100) — with the loudest level, mean voicing / flatness and majority class per point, plus every class run in the page (start/end seconds): read long recordings page by page. Times are media seconds from the start of the stream (the transcript's timeline). Use it to check pauses, breaths and voice without words before cutting.`;

export function registerVoiceTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'get_voice_analysis',
		{
			title: 'Get voice analysis',
			description: `Voice analysis of a media's audio stream (10 ms frames): noise floor, speech level and speech threshold (dBFS) of the file and of each 60 s window, and the seconds, runs and longest run of speech / breath / silence frames. Computed by the engine on first use (a job: progress notifications; cancelling the request cancels it) and cached by the file's content. summary: false (default true) adds one page of frames (fromSeconds, seconds ≤ ${MAX_PAGE_SECONDS}, stepMs): times, loudest levelDb, voicing, flatness and class per point, and the class runs (start/end seconds). analyze: false only reads a cached analysis (E_NOT_FOUND otherwise). Changes nothing in the project.`,
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().min(1).describe('Media id ("med_…") from list_media or import_media'),
				stream: z
					.number()
					.int()
					.min(0)
					.max(65_535)
					.optional()
					.describe('Container stream index of an audio stream (get_media_info); default the first audio stream'),
				summary: z.boolean().optional().describe('true (default): totals and windows only; false: add a page of frames'),
				fromSeconds: z.number().min(0).optional().describe('Page start, media seconds (summary: false)'),
				seconds: z.number().positive().max(MAX_PAGE_SECONDS).optional().describe('Page length (default 60)'),
				stepMs: z.number().int().min(10).max(60_000).optional().describe('Milliseconds per point (default 100)'),
				analyze: z.boolean().optional().describe('Run the analysis when none is cached (default true)'),
			},
			annotations: READ_ONLY,
		},
		async (args, extra) => {
			const { doc } = await loadDoc(ctx, args.projectId);
			const asset = doc.media[args.mediaId];
			if (!asset)
				throw new ToolError('E_NOT_FOUND', `No media ${args.mediaId} in this project`, 'Call list_media for valid ids.');
			const loc = asset.locators.find((l) => l.type === 'engine-store');
			if (loc?.type !== 'engine-store')
				throw new ToolError(
					'E_NOT_FOUND',
					`Media ${args.mediaId} is not in the engine's media store`,
					'Import the file with import_media.',
				);
			const audio = asset.probe.streams.filter((s) => s.type === 'audio');
			if (audio.length === 0)
				throw new ToolError('E_INVALID_PARAM', `Media ${args.mediaId} has no audio stream`);
			const stream = args.stream ?? audio[0]!.index;
			if (!audio.some((s) => s.index === stream))
				throw new ToolError(
					'E_INVALID_PARAM',
					`Stream ${stream} of ${args.mediaId} is not an audio stream`,
					`Audio streams: ${audio.map((s) => s.index).join(', ')} (get_media_info).`,
				);
			const read = () => ctx.engine((c) => c.getVoiceAnalysis(loc.key, stream, extra.signal));
			let analysis: VoiceAnalysis;
			let jobId: string | null = null;
			try {
				analysis = await read();
			} catch (e) {
				if (!(e instanceof EngineError) || e.code !== 'VOICE_ANALYSIS_NOT_FOUND') throw e;
				if (args.analyze === false)
					throw new ToolError(
						'E_NOT_FOUND',
						`Media ${args.mediaId} stream ${stream} has no voice analysis yet`,
						'Call again without analyze: false to compute it.',
					);
				let job: EngineJob = await ctx.engine((c) =>
					c.analyzeVoice(loc.key, { projectId: args.projectId, streamIndex: stream }),
				);
				jobId = job.id;
				if (!isTerminal(job)) {
					const r = await waitJob(ctx, job.id, 900_000, extra);
					job = r.job;
					if (r.timedOut)
						return jsonResult({
							jobId: job.id,
							note: 'The voice analysis is still running: wait_for_job, then call get_voice_analysis again.',
						});
				}
				if (job.state !== 'succeeded')
					throw new ToolError(
						job.error?.code ?? 'VOICE_ANALYSIS_FAILED',
						`Voice analysis ${job.state}: ${job.error?.message ?? ''}`.trim(),
						job.error?.retryable ? 'Retry; the failure may be temporary.' : undefined,
					);
				analysis = await read();
			}
			const body: Record<string, unknown> = {
				mediaId: args.mediaId,
				...(jobId ? { jobId } : {}),
				frameStepMs: 10,
				...summarizeVoiceAnalysis(analysis),
			};
			if (args.summary === false) {
				const from = voiceFrameAt(analysis, args.fromSeconds ?? 0);
				const frames = Math.round((args.seconds ?? 60) * 100);
				const step = Math.max(Math.ceil(frames / MAX_POINTS), Math.round((args.stepMs ?? 100) / 10));
				const page = voiceAnalysisPage(analysis, { fromFrame: from, frames, step });
				body.page = {
					fromSeconds: voiceFrameSeconds(page.fromFrame),
					toSeconds: voiceFrameSeconds(page.toFrame),
					stepMs: page.step * 10,
					times: page.times,
					levelDb: page.levelDb,
					voicing: page.voicing,
					flatness: page.flatness,
					classes: page.classes,
					runs: page.runs,
					...(page.toFrame < analysis.frameCount
						? { nextFromSeconds: voiceFrameSeconds(page.toFrame) }
						: {}),
				};
			}
			return jsonResult(body);
		},
	);
}
