// Fix Transcript (spec 17 SC-091): fix_transcript runs the engine's `transcript-fix` job — the sequence's script and
// the personal glossary against each recording's transcript, every candidate checked against the audio — into ONE
// proposal of feature "transcript-correction" (mode "dryRun" only reports). Guide: TRANSCRIPT_FIX_GUIDE (resource
// jasper://guide/transcript-fix).
import {
	type EngineJob,
	TRANSCRIPT_FIX_OFF_SCRIPT,
	TRANSCRIPT_FIX_SCOPES,
	TRANSCRIPT_FIX_SOURCES,
	TRANSCRIPT_FIX_STRICTNESS,
	type TranscriptFixResult,
	TranscriptFixResultSchema,
} from '@jasper/api';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg } from '../arguments.ts';
import {
	cancelIfAborted,
	defineTool,
	EDIT,
	type Extra,
	loadDoc,
	type ToolContext,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';

export const TRANSCRIPT_FIX_GUIDE = `Fixing transcripts from a script (spec 17): when the user reads a written script on camera, the recogniser's mistakes (names, brands, loanwords, numbers written as words, split or glued words) can be fixed from the script instead of word by word, without rewriting what the user really said (ad-libs, paraphrases, off-script talk are kept: every fix is checked against the audio).
1. attach_script {sequenceId, text | path}: the script serves Clean Up and transcript fixing (Sequence.cleanup.script). The personal glossary (list_glossary / save_glossary_entry) is the second source and also works without a script.
2. fix_transcript {sequenceId, mode: "dryRun"}: fast, nothing stored, no audio check — per recording how much of the transcript follows the script (alignedShare, offScriptShare, retake jumps), the candidates by group / category / kind, the spelling fixes that need no audio, which subtitles the fixes would patch (patch), unused script lines, and ≈ how long the audio check takes here (estimate with its basis). Refusals: E_NO_SOURCE (no script attached and an empty glossary: attach the script), E_NO_TRANSCRIPT (transcribe first), E_NO_SPEECH_MODEL (install_speech_model; only "propose" needs it), E_INVALID_PARAM (scope "inOut" without In / Out marks).
3. fix_transcript {sequenceId, mode: "propose"}: the audio check (Whisper scores the script reading against the transcript reading of the same audio) decides each candidate with the strictness (careful | standard | generous) and stores ONE proposal for the Review panel: group fix (checked against the audio), spelling (script spelling of names and joins, no audio needed), maybe (offered UNSELECTED: an "all" accept never takes them). sources (script, glossary), scope (recordings = whole recordings, default; used = only the words the sequence uses; inOut), showRejected (offer fixes the user rejected before, unselected). Progress is reported per scored window; cancelling the request cancels the job.
4. Review: tell the user the proposal is waiting in the Review panel (wait_for_proposal); get_proposal shows each item (before → after, Δ per token, rule). accept_proposal only when the user asked you to apply it and Project Settings ▸ Agent Proposals allows transcript fixes; "all" takes the selected fix and spelling items only (name maybe item ids to apply them, only when the user asked). Accepting is ONE undo step "Fix transcript: N fixes": the transcript words are replaced and the subtitles and caption tracks showing them are patched in place (styling, line breaks and timing of untouched words kept) — there is no need to regenerate the subtitles. Clips edited by hand are left unchanged and reported. Rejected fixes are remembered for the sequence and not offered again. refresh_proposal re-runs the check for the stale items' recordings after the transcript changed.
5. Then Clean Up: plan_cleanup / apply_cleanup work on the fixed transcript (its findings are recomputed).
Rebuild: when the subtitles of a finished cut must read like the script and the transcript under them is wrong beyond single words (phrases missing, a restart's words on the removed take, "99% %"), fix_transcript {sequenceId, mode: "rebuild"} transcribes the speech the sequence keeps again from the raw audio and writes it from the script — one proposal, an item per kept span, one undo step. offScript "keep" keeps heard words the script does not have (ad-libs); default "drop".`;

const ModeArg = z
	.enum(['propose', 'dryRun', 'rebuild'])
	.describe(
		'"dryRun": report, nothing stored; "propose": audio-checked fixes; "rebuild": the kept speech from the script',
	);

type Args = {
	projectId: string;
	sequenceId?: string;
	sources?: Array<(typeof TRANSCRIPT_FIX_SOURCES)[number]>;
	scope?: (typeof TRANSCRIPT_FIX_SCOPES)[number];
	strictness?: (typeof TRANSCRIPT_FIX_STRICTNESS)[number];
	showRejected?: boolean;
	mode: 'propose' | 'dryRun' | 'rebuild';
	offScript?: (typeof TRANSCRIPT_FIX_OFF_SCRIPT)[number];
	device?: 'auto' | 'cpu' | 'gpu';
	timeoutSeconds?: number;
};

/** Decisions shown in the tool result (the report keeps up to 2,000; get_proposal lists every item). */
const SHOWN_DECISIONS = 100;

function compact(r: TranscriptFixResult) {
	const rep = r.report;
	return {
		mode: r.mode,
		sequenceId: r.sequenceId,
		proposalId: r.proposalId,
		itemCount: r.itemCount,
		revision: r.revision,
		settings: rep.settings,
		sourcesUsed: rep.sourcesUsed,
		perMedia: rep.perMedia.map((m) => ({
			mediaId: m.mediaId,
			name: m.name,
			language: m.language,
			words: m.words,
			wordsInScope: m.wordsInScope,
			...(m.alignment
				? {
						alignedShare: m.alignment.alignedShare,
						offScriptShare: m.alignment.offScriptShare,
						retakeJumps: m.alignment.retakeJumps,
					}
				: {}),
			candidates: m.candidates,
			windows: m.windows,
			...(m.unscored ? { unscored: m.unscored } : {}),
		})),
		candidates: rep.candidates,
		decisions: rep.decisions.slice(0, SHOWN_DECISIONS),
		...(rep.decisions.length > SHOWN_DECISIONS || rep.decisionsTruncated
			? {
					decisionsShown: Math.min(SHOWN_DECISIONS, rep.decisions.length),
					decisionsTotal: rep.candidates.total,
				}
			: {}),
		skipped: rep.skipped,
		unusedScriptLines: rep.unusedLines.slice(0, 100),
		patch: rep.patch,
		speech: rep.speech,
		...(rep.device ? { device: rep.device } : {}),
		...(rep.fallback ? { fallback: rep.fallback } : {}),
		...(rep.estimate ? { estimate: rep.estimate } : {}),
		timings: rep.timings,
		...(rep.guard ? { guard: rep.guard } : {}),
		...(rep.rebuild ? { rebuild: rep.rebuild } : {}),
		warnings: rep.warnings,
	};
}

async function fixTranscript(ctx: ToolContext, a: Args, extra: Extra) {
	const { doc } = await loadDoc(ctx, a.projectId);
	const seq = pickSequence(doc, a.sequenceId);
	const body = {
		mode: a.mode,
		...(a.sources ? { sources: a.sources } : {}),
		...(a.scope ? { scope: a.scope } : {}),
		...(a.strictness ? { strictness: a.strictness } : {}),
		...(a.showRejected !== undefined ? { showRejected: a.showRejected } : {}),
		...(a.offScript ? { offScript: a.offScript } : {}),
		...(a.device ? { device: a.device } : {}),
	};
	const job = (await ctx.engine((c) =>
		c.transcriptFix(a.projectId, seq.id, body, { signal: extra.signal }),
	)) as EngineJob;
	await cancelIfAborted(ctx, extra, job.id);
	const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 900) * 1000, extra);
	if (timedOut)
		return jsonResult({
			jobId: done.id,
			state: done.state,
			progress: done.progress,
			next: `Fix Transcript is still running: wait_for_job {jobId: "${done.id}"}; its result names the proposal.`,
		});
	if (done.state !== 'succeeded') {
		const err = done.error as { code?: string; message?: string; detail?: unknown } | undefined;
		const inner = (err?.detail as { code?: unknown } | undefined)?.code;
		const code = typeof inner === 'string' ? inner : (err?.code ?? 'JOB_FAILED');
		throw new ToolError(
			code,
			err?.message ?? `Fix Transcript ${done.state}`,
			code === 'E_LIMIT'
				? 'A transcript or the script is over the aligner bounds (200,000 words / 60,000 script words): attach the part of the script this sequence covers, or fix a narrower scope ("used" / "inOut").'
				: 'Check the transcript (get_transcript), the script (attach_script) and the speech models (list_speech_models), then run fix_transcript again.',
			err?.detail,
		);
	}
	const r = TranscriptFixResultSchema.parse(done.result);
	const out = compact(r);
	if (r.mode === 'dryRun')
		return jsonResult({
			...out,
			next: 'Nothing changed. Read the alignment and the candidates; if the alignedShare is low the script may not match this recording. Then call fix_transcript with mode "propose".',
		});
	if (r.mode === 'rebuild')
		return jsonResult({
			...out,
			next: r.proposalId
				? `Proposal ${r.proposalId} rewrites ${r.itemCount} kept spans from the script: ask the user to review it in the Review panel and call wait_for_proposal; accept_proposal only if the user asked you to apply it. Subtitles are patched in place on accept.`
				: 'Nothing to rewrite: the kept speech already reads like the script.',
		});
	return jsonResult({
		...out,
		next: r.proposalId
			? `Proposal ${r.proposalId} is ready: ask the user to review it in the editor's Review panel and call wait_for_proposal; accept_proposal only if the user asked you to apply it (maybe items are unselected). The subtitles are patched in place on accept: do not regenerate them. Then plan_cleanup.`
			: 'Nothing to fix: the audio check kept the transcript everywhere (see candidates.byGroup and the decisions).',
	});
}

export function registerTranscriptFixTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'fix_transcript',
		{
			title: 'Fix the transcript from the script (propose)',
			description:
				'Find transcript errors by aligning it with the attached script and the glossary. `dryRun`, then propose; `rebuild` re-transcribes the kept speech and rewrites it from the script.',
			details:
				'Spec 17 Fix Transcript: aligns each recording\'s transcript with the sequence\'s script (attach_script) and finds the disagreements between exact anchors, plus the personal glossary\'s known misspellings; each candidate is checked against the audio (the script reading vs the transcript reading of the same words) and decided with the strictness, so real ad-libs are kept. mode "propose" stores ONE proposal of feature transcript-correction (groups fix, spelling, maybe — maybe items unselected); each item is one transcript.replaceWords that also patches the subtitles and caption tracks in place. mode "dryRun" is the fast pre-run (alignment report, candidates, spelling fixes, patch report, estimated audio-check time; nothing stored). mode "rebuild": the spans the sequence keeps are transcribed again from the raw audio (VAD chunks, best accuracy) and aligned to the script: same words take the script spelling, differing ones the script text at the heard times, missing script words are inserted, heard words the script lacks are dropped (offScript "keep" keeps them); one proposal, an item per changed span. Nothing changes until the proposal is accepted (one undo step). Progress per scored window; cancelling cancels the job.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				mode: ModeArg,
				sources: z
					.array(z.enum(TRANSCRIPT_FIX_SOURCES))
					.min(1)
					.max(2)
					.optional()
					.describe(
						'What the fixes come from: "script", "glossary" (default: the sequence\'s settings, else both)',
					),
				scope: z
					.enum(TRANSCRIPT_FIX_SCOPES)
					.optional()
					.describe(
						'"recordings" (whole recordings, default) | "used" (only words the sequence uses) | "inOut"',
					),
				strictness: z
					.enum(TRANSCRIPT_FIX_STRICTNESS)
					.optional()
					.describe('"careful" | "standard" (default) | "generous": how much audio evidence a fix needs'),
				showRejected: z
					.boolean()
					.optional()
					.describe('Offer fixes the user rejected before (unselected); default false'),
				offScript: z
					.enum(TRANSCRIPT_FIX_OFF_SCRIPT)
					.optional()
					.describe('"rebuild": heard words the script lacks are "drop"ped (default) or "keep"t'),
				device: z
					.enum(['auto', 'cpu', 'gpu'])
					.optional()
					.describe('Processor for the audio check (default: the Transcription preference)'),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(3600)
					.optional()
					.describe('Wait for the job (default 900 s; then wait_for_job)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => fixTranscript(ctx, a as Args, extra),
	);
}
