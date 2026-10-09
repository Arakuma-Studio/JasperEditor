// Render previews and performance stats for agents (workstream `previews`, docs/wp-notes/previews.md):
// get_render_bar_state, render_previews, delete_render_files, perf_stats.
import type { EngineJob, PreviewSettings } from '@jasper/api';
import {
	audioPreviewSegments,
	makeEnvelope,
	previewSegments,
	previewSettingsOf,
	type Sequence,
} from '@jasper/project';
import { z } from 'zod';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT_IDEMPOTENT,
	frameOf,
	isTerminal,
	jobBody,
	loadDoc,
	READ_ONLY,
	type ToolContext,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { ProjectIdArg } from './projects.ts';
import { failedJobError } from './templates.ts';

/** Appended to the server instructions. */
export const PREVIEWS_GUIDE = `Render previews (Premiere's Sequence ▸ Render…): the timeline is cut into segments at every clip, transition and edit boundary; each segment has a content hash of everything that changes its pixels (relative to its start, so ripples keep previews valid and undo turns them green again). get_render_bar_state shows each segment: green = a preview file exists (the Program monitor plays it), yellow = plays live in real time (≈ cost per frame), red = probably drops frames live, none = plays natively; with the reasons. render_previews mode "effects" (Render Effects In to Out: red and yellow segments), "all" (Render In to Out), "selection" (segments showing clipIds) or "audio" (Render Audio); range defaults to In/Out, else the whole sequence. Renders go through the export paths (the picture the export writes) and appear in the Jobs panel. delete_render_files removes preview files (all, or the segments of a range). Preview file format/size/quality: apply_commands sequence.setPreviewSettings {format: h264-iframe|h264|vp9, size: full|half, quality: standard|high}. start_export can reuse previews (settings.usePreviews in the HTTP API). perf_stats reports engine counters (CPU, memory, event-loop delay, host load, jobs, render throughput, preview files, invariant checks: incremental vs full and why) and, with an open editor, playback (frames shown/dropped, fps, stalls, buffering).`;

const SequenceIdArg = z
	.string()
	.optional()
	.describe('Sequence id ("seq_…"); default: the project\'s first sequence');
const RangeArg = z
	.object({
		from: z.unknown().describe('Frame, {"seconds": x} or "HH:MM:SS:FF"'),
		to: z.unknown().describe('Exclusive end: frame, {"seconds": x} or "HH:MM:SS:FF"'),
	})
	.optional()
	.describe('Range [from, to); default: In/Out, else the whole sequence');

function pick(doc: Parameters<typeof pickSequence>[0], sequenceId?: string): Sequence {
	try {
		return pickSequence(doc, sequenceId);
	} catch (e) {
		throw new ToolError('E_NOT_FOUND', (e as Error).message, 'Call get_project for sequence ids.');
	}
}

function rangeOf(
	seq: Sequence,
	range: { from: unknown; to: unknown } | undefined,
): { start: number; end: number } {
	if (range) {
		const start = frameOf(seq, range.from);
		const end = frameOf(seq, range.to);
		if (end <= start) throw new ToolError('E_INVALID_PARAM', '`to` must be after `from`');
		return { start, end };
	}
	const end = Object.values(seq.clips).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
	return { start: seq.inPoint ?? 0, end: Math.max((seq.inPoint ?? 0) + 1, seq.outPoint ?? end) };
}

const overlapsRange = (s: { startFrame: number; frames: number }, r: { start: number; end: number }) =>
	s.startFrame < r.end && s.startFrame + s.frames > r.start;

export function registerPreviewTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'get_render_bar_state',
		{
			title: 'Get render bar state',
			description:
				'The render-bar segments of a sequence: frames, state (green = rendered preview file, yellow = plays live in real time, red = probably drops frames live, none = plays natively), the estimated live cost per frame against the frame budget with its main reasons, and the content hash; plus the audio segments that have audio previews. Optionally only what overlaps [from, to).',
			input: { projectId: ProjectIdArg, sequenceId: SequenceIdArg, range: RangeArg },
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, range }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pick(doc, sequenceId);
			const settings = previewSettingsOf(seq) as PreviewSettings;
			const segs = previewSegments(doc, seq.id);
			const audio = audioPreviewSegments(doc, seq.id);
			const r = range ? rangeOf(seq, range) : null;
			const shown = r ? segs.filter((s) => overlapsRange(s, r)) : segs;
			const shownAudio = r ? audio.filter((s) => overlapsRange(s, r)) : audio;
			const st = await ctx.engine((c) =>
				c.previewStatus({ settings, video: shown.map((s) => s.hash), audio: shownAudio.map((s) => s.hash) }),
			);
			const green = new Set(st.video);
			const greenAudio = new Set(st.audio);
			const rows = shown.map((s) => ({
				startFrame: s.startFrame,
				endFrame: s.startFrame + s.frames,
				frames: s.frames,
				state: green.has(s.hash)
					? 'green'
					: s.need === 'none'
						? 'none'
						: s.need === 'render'
							? 'red'
							: 'yellow',
				costMs: s.costMs,
				budgetMs: s.budgetMs,
				...(s.reasons.length ? { reasons: s.reasons } : {}),
				...(s.absolute ? { absolute: true } : {}),
				hash: s.hash,
				clipIds: s.clipIds,
			}));
			const count = (k: string) => rows.filter((x) => x.state === k).length;
			return jsonResult({
				sequenceId: seq.id,
				previewSettings: settings,
				formatKey: st.formatKey,
				summary: {
					segments: rows.length,
					green: count('green'),
					yellow: count('yellow'),
					red: count('red'),
					none: count('none'),
					audioSegments: shownAudio.length,
					audioRendered: shownAudio.filter((s) => greenAudio.has(s.hash)).length,
				},
				segments: rows,
				audio: shownAudio.map((s) => ({
					startFrame: s.startFrame,
					endFrame: s.startFrame + s.frames,
					rendered: greenAudio.has(s.hash),
					hash: s.hash,
				})),
			});
		},
	);

	defineTool(
		ctx,
		'render_previews',
		{
			title: 'Render previews',
			description:
				'Sequence ▸ Render…: renders preview files of segments through the export paths (the picture an export writes) so they play smoothly in the Program monitor and turn green. mode "effects" = red and yellow segments in the range (Render Effects In to Out), "all" = every segment in the range (Render In to Out), "selection" = segments showing clipIds (Render Selection), "audio" = the mix of the audio segments in the range (Render Audio). Segments that already have a file are skipped; segments with offline media or missing fonts are skipped with the reason. wait (default true) waits for the job.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				mode: z.enum(['effects', 'all', 'selection', 'audio']).describe('What to render'),
				range: RangeArg,
				clipIds: z.array(z.string()).optional().describe('mode "selection": the clips'),
				wait: z.boolean().optional().describe('Wait until the job is done (default true)'),
				timeoutSeconds: z.number().int().min(1).max(7200).optional().describe('Waiting limit (default 1800)'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, sequenceId, mode, range, clipIds, wait, timeoutSeconds }, extra) => {
			if (mode === 'selection' && !clipIds?.length)
				throw new ToolError(
					'E_INVALID_PARAM',
					'mode "selection" needs clipIds',
					'Pass the clip ids to render.',
				);
			const { doc, revision } = await loadDoc(ctx, projectId);
			const seq = pick(doc, sequenceId);
			const envelope = makeEnvelope(doc, {
				revision: revision ?? 0,
				savedAt: new Date().toISOString(),
				platform: 'mcp',
			}) as never;
			const r = await ctx.engine((c) =>
				c.renderPreviews({
					envelope,
					sequenceId: seq.id,
					mode,
					...(mode === 'selection' ? { clipIds } : { range: rangeOf(seq, range) }),
				}),
			);
			if ('job' in r && r.job === null)
				return jsonResult({
					job: null,
					existing: r.existing,
					message: 'Nothing to render: previews are up to date',
				});
			const job = r as EngineJob;
			const base = ctx.link.target?.url ?? '';
			if (wait === false)
				return jsonResult({ ...jobBody(job, base), next: 'Call wait_for_job with this jobId.' });
			const { job: done, timedOut } = await waitJob(ctx, job.id, (timeoutSeconds ?? 1800) * 1000, extra);
			const body = jobBody(done, base);
			if (isTerminal(done) && done.state !== 'succeeded')
				throw await failedJobError(
					ctx,
					done,
					'Check the job error; get_render_bar_state shows what is rendered.',
					body,
				);
			return jsonResult({
				...body,
				...(timedOut ? { timedOut: true, next: 'Call wait_for_job with this jobId.' } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'delete_render_files',
		{
			title: 'Delete render files',
			description:
				'Delete Render Files: removes render preview files — scope "all" (every preview file of every project), or "range" (the video and audio segments of this sequence overlapping the range, default In/Out). Their segments turn yellow/red again; nothing in the project changes.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				scope: z.enum(['all', 'range']).describe('"all" or "range"'),
				range: RangeArg,
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ projectId, sequenceId, scope, range }) => {
			if (scope === 'all') return jsonResult(await ctx.engine((c) => c.deletePreviews({ all: true })));
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pick(doc, sequenceId);
			const r = rangeOf(seq, range);
			const hashes = [
				...previewSegments(doc, seq.id).filter((s) => overlapsRange(s, r)),
				...audioPreviewSegments(doc, seq.id).filter((s) => overlapsRange(s, r)),
			].map((s) => s.hash);
			return jsonResult(await ctx.engine((c) => c.deletePreviews({ hashes })));
		},
	);

	defineTool(
		ctx,
		'perf_stats',
		{
			title: 'Get performance stats',
			description:
				'Performance counters: the engine (process CPU %, memory, event-loop delay, host load and cores, running/queued jobs, frames per second of recent exports and preview renders, preview files) and, when an editor window has the project open, its playback (frames shown and dropped since playback started, measured fps, stalls recovered, buffering time, UI frame rate) and its render bar (segments by state).',
			input: { projectId: ProjectIdArg.optional() },
			annotations: READ_ONLY,
		},
		async ({ projectId }, extra) => {
			const engine = await ctx.engine((c) => c.call('perfStats'));
			let editor: unknown = null;
			try {
				const r = await ctx.engine((c) =>
					c.agentUi({ action: 'perf', ...(projectId ? { projectId } : {}), args: {} }, extra?.signal),
				);
				editor = (r as { result?: unknown }).result ?? r;
			} catch (e) {
				editor = { unavailable: e instanceof Error ? e.message : String(e) };
			}
			return jsonResult({ engine, editor });
		},
	);
}
