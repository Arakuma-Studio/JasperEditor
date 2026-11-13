// Transcript cleanup for agents (spec 14 TC-050 / TC-051; docs/wp-notes/transcript-cleanup.md "MCP"): analyze_voice
// (findings, retake groups, the kept / removed plan and statistics, paged), plan_cleanup (the same dry run with
// decisions: accept / reject by finding id, fingerprint or kind, retake choices), apply_cleanup (the plan as ONE undo
// step "Agent: Clean Up Voice: N cuts", the rejections remembered), set_cleanup_settings (preset, overrides, word
// lists, remembered rejections) and attach_script. The analysis is the engine's `cleanup-analysis` job (the same code
// the editor's Clean Up mode runs): voice analyses cached or computed (progress notifications; cancelling the request
// cancels the job), detector, planner. Nothing here changes the document except apply_cleanup, set_cleanup_settings
// and attach_script.
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
	type CleanupAnalysisFile,
	CleanupAnalysisJobResultSchema,
	type CleanupAnalyzeRequest,
	type EngineJob,
} from '@jasper/api';
import {
	agentProposalsAllowed,
	applyTransaction,
	CLEANUP_SCRIPT_MAX_BYTES,
	type CleanupAnalysis,
	type CleanupDecisions,
	type CleanupFinding,
	CleanupListsSchema,
	CleanupOverridesSchema,
	cleanupApplyCommands,
	cleanupFindingFrames,
	cleanupFindingMedia,
	createSeededIdSource,
	defaultRegistries,
	FINDING_KINDS,
	FLICKS_PER_SECOND,
	isAccepted,
	makeEnvelope,
	type ProjectDocument,
	readSequenceCleanup,
	type Sequence,
	sequenceTimecode,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, timeArg } from '../arguments.ts';
import {
	DESTRUCTIVE,
	defineTool,
	EDIT_IDEMPOTENT,
	type Extra,
	findClip,
	frameOf,
	isTerminal,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';

/** Longest wait for an analysis (a long recording's first voice analysis included). */
const WAIT_MS = 15 * 60_000;
const MAX_PAGE = 1000;

export const CLEANUP_GUIDE = `Cleaning up speech (spec 14 — remove retakes, restarts, false starts, fillers, off-script talk, pauses and breaths from a talking-head or voice-over recording, with edit points placed from the audio level so no dead air is left):
1. The speech needs a transcript (transcribe or import_transcript). Optionally attach the video script: attach_script {projectId, sequenceId?, text | path} — it names retake groups by line, finds off-script talk and head / tail chatter, and lets an earlier take that covers more of a line win.
2. analyze_voice {projectId, sequenceId | clipId | mediaId, preset? ("fast": the creator's measured jump-cut style — no pause over 0.12 s, edits inside the word decay, last take kept; "natural": calmer, pauses and breaths kept, retakes for review; or a user preset id), settings? (overrides of any value: rules / thresholds / edges / gaps / guards / joins), script?, language?, range? | inOut?} → findings {id, kind, suggested remove|review, accepted, confidence, text, reason, start/end (sequence frames + timecode, media seconds), fingerprint, group?}, retake groups (takes side by side, the kept one), removed ranges with reasons, and stats {inputDuration, outputDuration, cutsPerMinute, deadAirPerMinute, largestSilenceLeft, removedByKind}. Long results are paged (offset / limit, include, kinds). Read-only; the first run computes the voice analysis (a job with progress; cached afterwards).
3. Recommended policy: accept the "remove" findings (that is the default); review the retake groups — keep the last complete take unless it is cut off, has a much lower mean probability, or is further from the script than another (pass retakes: {groupId: takeIndex}); never cut "untranscribed" findings (voice without words: a dropped filler, a laugh, a cough, or a word the recogniser missed) without listening to them first (get_voice_analysis / listen_to_sequence) — they are kept unless accepted; decide "review" findings (discourse markers, ASR suspects, Natural's retakes) one by one. Then plan_cleanup with your decisions {accept, reject, acceptKinds, rejectKinds, retakes} (ids of the same analysis, or fingerprints, which survive re-runs) and check the stats: largestSilenceLeft should be ≤ ~0.25 s and cutsPerMinute in the expected range (Fast ≈ 17–23 per minute of output); a much shorter output than expected means too much was removed.
4. apply_cleanup {same arguments + decisions, analysisId?} cuts the removed ranges in ONE undo step ("Agent: Clean Up Voice: N cuts"): the speech clips, their linked picture and clip groups, ripple per sync lock (locked tracks never change), equal-power micro-fades at every join (preview = export), and remembers the findings you rejected (Sequence.cleanup.rejected) so later analyses keep them. mode: extract (default) | lift | mute | markers. With an analysisId whose document changed since, it refuses with E_STALE (decisions by id would point at other findings): analyze again, or decide by fingerprint.
5. set_cleanup_settings {projectId, sequenceId?, preset?, settings?, merge?, reset?, lists? {es|en: {fillers, markers, allow} | null}, clearRejected?, unreject?} stores the sequence's preset, overrides and word lists (what the editor's Clean Up mode and later analyses use).`;

const PresetArg = z
	.string()
	.min(1)
	.max(200)
	.describe('"fast", "natural", "builtin.fast", "builtin.natural" or a user preset id ("cup_…")');

const presetId = (p: string | undefined) =>
	p === undefined ? undefined : p === 'fast' ? 'builtin.fast' : p === 'natural' ? 'builtin.natural' : p;

const KindArg = z.enum(FINDING_KINDS);

const DecisionsArg = z
	.object({
		accept: z
			.array(z.string().min(1).max(300))
			.max(100_000)
			.optional()
			.describe('Finding ids ("f12", of the same analysis) or fingerprints to cut'),
		reject: z
			.array(z.string().min(1).max(300))
			.max(100_000)
			.optional()
			.describe('Finding ids or fingerprints to keep (wins over accept)'),
		acceptKinds: z.array(KindArg).optional().describe('Kinds to cut as a whole (item decisions win)'),
		rejectKinds: z.array(KindArg).optional().describe('Kinds to keep as a whole'),
		retakes: z
			.record(z.string().min(1).max(50), z.number().int().min(0))
			.optional()
			.describe('Retake group id ("g3") → index of the take to keep (0-based); the other takes are cut'),
	})
	.describe('Review decisions');

const TargetShape = {
	projectId: ProjectIdArg,
	sequenceId: SequenceIdArg,
	clipId: z
		.string()
		.min(1)
		.optional()
		.describe('Only this speech clip (with its linked picture and clip group); its sequence is used'),
	mediaId: z
		.string()
		.min(1)
		.optional()
		.describe(
			'A whole media file, analysed on its own (times = media time); analyze_voice / plan_cleanup only',
		),
	preset: PresetArg.optional().describe("Default: the sequence's preset (Fast when none)"),
	settings: CleanupOverridesSchema.optional().describe(
		'Overrides over the preset: {rules?, thresholds?, edges?, gaps?, guards?, joins?} — see set_cleanup_settings',
	),
	script: z
		.string()
		.max(CLEANUP_SCRIPT_MAX_BYTES)
		.nullable()
		.optional()
		.describe('Script text for this run; null = analyse without a script; default the attached script'),
	language: z
		.string()
		.min(1)
		.max(35)
		.optional()
		.describe('Override the transcripts\' language ("es", "en"…)'),
	from: timeArg('Only from this sequence time').optional(),
	to: timeArg('Only up to this sequence time').optional(),
	inOut: z.boolean().optional().describe("Only between the sequence's In and Out marks"),
};

const PageShape = {
	offset: z.number().int().min(0).optional().describe('First item of the pages (default 0)'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(MAX_PAGE)
		.optional()
		.describe(`Items per list (default 200, at most ${MAX_PAGE})`),
	include: z
		.array(z.enum(['findings', 'groups', 'ranges', 'script']))
		.optional()
		.describe('Lists to return (default all)'),
	kinds: z.array(KindArg).optional().describe('Only findings of these kinds'),
};

type Target = {
	doc: ProjectDocument;
	revision: number | undefined;
	seq: Sequence;
	/** A scratch sequence holding the media (mediaId target): sent with the request. */
	scratch: boolean;
	clipIds?: string[];
	range?: { from: number; to: number };
};

async function resolveTarget(
	ctx: ToolContext,
	a: {
		projectId: string;
		sequenceId?: string;
		clipId?: string;
		mediaId?: string;
		from?: unknown;
		to?: unknown;
		inOut?: boolean;
	},
): Promise<Target> {
	const given = [a.sequenceId, a.clipId, a.mediaId].filter((x) => x !== undefined).length;
	if (given > 1)
		throw new ToolError(
			'E_INVALID_PARAM',
			'Give at most one of sequenceId, clipId and mediaId',
			'sequenceId analyses a sequence, clipId one clip of it, mediaId a whole media file.',
		);
	const { doc, revision } = await loadDoc(ctx, a.projectId);
	if (a.mediaId) {
		if (!doc.media[a.mediaId])
			throw new ToolError('E_NOT_FOUND', `No media ${a.mediaId} in this project`, 'Call list_media for ids.');
		const r = applyTransaction(
			doc,
			{
				protocol: 'jasper.tx/1',
				label: 'Clean Up scratch',
				origin: 'user',
				commands: [{ type: 'sequence.create', name: 'Clean Up', fromMediaId: a.mediaId, ref: '$s' }],
			},
			{
				ids: createSeededIdSource(`cleanup-scratch:${a.mediaId}`),
				now: () => new Date().toISOString(),
				revision: revision ?? 0,
				registries: defaultRegistries(),
				invariants: 'incremental',
			},
		);
		if (!r.result.ok)
			throw new ToolError(
				r.result.errors[0]?.code ?? 'E_INVALID_PARAM',
				r.result.errors[0]?.message ?? 'Bad media',
			);
		const seq = r.document.sequences[r.result.refs.$s!]!;
		return { doc: r.document, revision, seq, scratch: true };
	}
	let seq: Sequence;
	let clipIds: string[] | undefined;
	if (a.clipId) {
		const f = findClip(doc, a.clipId);
		seq = f.seq;
		clipIds = [a.clipId];
	} else seq = pickSequence(doc, a.sequenceId);
	let range: { from: number; to: number } | undefined;
	if (a.inOut) {
		if (seq.inPoint === null || seq.outPoint === null || seq.outPoint <= seq.inPoint)
			throw new ToolError(
				'E_INVALID_PARAM',
				'The sequence has no In and Out marks',
				'Set them, or pass from / to.',
			);
		range = { from: seq.inPoint, to: seq.outPoint };
	} else if (a.from !== undefined || a.to !== undefined) {
		const from = a.from === undefined ? 0 : frameOf(seq, a.from);
		const to = a.to === undefined ? Number.MAX_SAFE_INTEGER : frameOf(seq, a.to);
		if (to <= from) throw new ToolError('E_INVALID_PARAM', '"to" must be after "from"');
		range = { from, to: Math.min(to, 2 ** 31) };
	}
	return { doc, revision, seq, scratch: false, ...(clipIds ? { clipIds } : {}), ...(range ? { range } : {}) };
}

/** Runs the engine's analysis and reads its file. */
async function runAnalysis(
	ctx: ToolContext,
	projectId: string,
	t: Target,
	opts: {
		preset?: string;
		settings?: z.infer<typeof CleanupOverridesSchema>;
		script?: string | null;
		language?: string;
		decisions?: CleanupDecisions;
	},
	extra: Extra,
): Promise<{ file: CleanupAnalysisFile; job: EngineJob }> {
	const req: CleanupAnalyzeRequest = {
		projectId,
		sequenceId: t.seq.id,
		...(t.scratch
			? { document: makeEnvelope(t.doc, { revision: 0, savedAt: new Date().toISOString(), platform: 'mcp' }) }
			: {}),
		...(t.clipIds ? { clipIds: t.clipIds } : {}),
		...(t.range ? { range: t.range } : {}),
		...(opts.preset ? { presetId: presetId(opts.preset)! } : {}),
		...(opts.settings ? { overrides: opts.settings } : {}),
		...(opts.script !== undefined ? { script: opts.script } : {}),
		...(opts.language ? { language: opts.language } : {}),
		...(opts.decisions ? { decisions: opts.decisions as never } : {}),
	};
	let job = await ctx.engine((c) => c.analyzeCleanup(req));
	if (!isTerminal(job)) {
		const r = await waitJob(ctx, job.id, WAIT_MS, extra);
		job = r.job;
		if (r.timedOut)
			throw new ToolError(
				'E_TIMEOUT',
				`The analysis is still running (job ${job.id})`,
				'wait_for_job, then call again: the voice analyses are cached by then.',
			);
	}
	if (job.state !== 'succeeded')
		throw new ToolError(
			job.error?.code ?? 'CLEANUP_ANALYSIS_FAILED',
			`Clean Up analysis ${job.state}: ${job.error?.message ?? ''}`.trim(),
			job.error?.code === 'E_UNSUPPORTED'
				? 'Clean Up works on clips at 100 % speed, not reversed or time-remapped.'
				: job.error?.code === 'E_INVALID_PARAM'
					? 'Transcribe the speech first (transcribe / import_transcript).'
					: job.error?.retryable
						? 'Retry; the failure may be temporary.'
						: undefined,
		);
	const res = CleanupAnalysisJobResultSchema.safeParse(job.result);
	if (!res.success) throw new ToolError('INVALID_RESPONSE', 'The engine sent an unreadable analysis result');
	const file = await ctx.engine((c) => c.getCleanupAnalysis(res.data.analysisId));
	return { file, job };
}

/** English explanation of a finding (its reason key + params). */
export function findingReasonText(f: CleanupFinding): string {
	const p = f.reason.params;
	const text = String(p.text ?? '');
	const s = typeof p.seconds === 'number' ? p.seconds.toFixed(2) : String(p.seconds ?? '');
	switch (f.kind) {
		case 'pause':
			return `Pause of ${s} s`;
		case 'breath':
			return `Breath of ${s} s`;
		case 'untranscribed':
			return text
				? `Speech inside the stretched word "${text}" (${s} s): maybe a take the transcript wrote once — listen before cutting`
				: `Voice without words (${s} s): a dropped filler, a laugh, a cough or a missed word — listen before cutting`;
		case 'filler-vocalic':
			return `Filler "${text}"`;
		case 'filler-phrase':
			return `Filler phrase "${text}" between pauses`;
		case 'filler-lexical':
			return `Discourse marker "${text}" at the start of a clause`;
		case 'restart':
			return `Restart: "${text}" is said again right after`;
		case 'false-start':
			return `False start "${text}"`;
		case 'retake':
			return `${p.later !== undefined ? 'Later' : 'Earlier'} take "${text}"${p.takes !== undefined ? ` (${p.takes} takes; keeping "${p.kept ?? ''}"${p.line !== undefined ? `, script line ${p.line}` : ''})` : ''}`;
		case 'hidden-retake':
			return `Hidden retake "${text}"${p.kept !== undefined ? `, said again as "${p.kept}"` : ''}`;
		case 'stutter':
			return `Repeat "${text}"`;
		case 'off-script':
			return `Not in the script: "${text}"`;
		case 'head-tail':
			return `Before the first or after the last scripted line: "${text}"`;
		case 'asr-suspect':
			return `The transcription may be wrong here: "${text}"`;
		case 'hallucination':
			return `Likely invented by speech to text: "${text}"`;
		case 'fragment':
			return `${p.frames} frames kept alone between ${p.between === 'words' ? 'removed words' : 'cuts'}${text ? `: "${text}"` : ''} — a flash of another moment; cut it or keep it`;
	}
}

const sec = (flicks: number) => Math.round((flicks / FLICKS_PER_SECOND) * 1000) / 1000;

function page<T>(items: readonly T[], offset: number, limit: number) {
	const slice = items.slice(offset, offset + limit);
	return {
		total: items.length,
		offset,
		items: slice,
		...(offset + limit < items.length ? { nextOffset: offset + limit } : {}),
	};
}

/** The tool body of an analysis: summary, statistics and the requested pages. */
function analysisBody(
	file: CleanupAnalysisFile,
	t: Target,
	decisions: CleanupDecisions,
	opts: { offset?: number; limit?: number; include?: string[]; kinds?: string[] },
) {
	const a = file.analysis as CleanupAnalysis;
	const seq = t.seq;
	const remembered = new Set(readSequenceCleanup(seq).rejected ?? []);
	const offset = opts.offset ?? 0;
	const limit = opts.limit ?? 200;
	const want = new Set(opts.include ?? ['findings', 'groups', 'ranges', 'script']);
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const at = (frame: number) => ({
		frame,
		timecode: sequenceTimecode(seq, frame),
		seconds: Math.round((frame / fps) * 1000) / 1000,
	});
	const byKind: Record<string, { found: number; suggestedRemove: number; accepted: number }> = {};
	const accepted = (f: CleanupFinding) => isAccepted(f, decisions, remembered);
	for (const f of a.findings) {
		const k = (byKind[f.kind] ??= { found: 0, suggestedRemove: 0, accepted: 0 });
		k.found++;
		if (f.suggested === 'remove') k.suggestedRemove++;
		if (accepted(f)) k.accepted++;
	}
	const findings = a.findings
		.filter((f) => !opts.kinds?.length || opts.kinds.includes(f.kind))
		.map((f) => {
			const fr = t.scratch ? null : cleanupFindingFrames(seq, a, f);
			return {
				id: f.id,
				kind: f.kind,
				suggested: f.suggested,
				accepted: accepted(f),
				confidence: Math.round(f.confidence * 1000) / 1000,
				...(typeof f.reason.params.text === 'string' ? { text: f.reason.params.text } : {}),
				reason: findingReasonText(f),
				media: {
					mediaId: cleanupFindingMedia(a, f)?.mediaId ?? null,
					start: sec(f.range.start),
					end: sec(f.range.end),
				},
				...(fr ? { start: at(fr.start), end: at(fr.end), clipId: fr.clipId } : {}),
				...(f.words ? { words: f.words } : {}),
				...(f.group ? { group: f.group } : {}),
				...(a.plan.skipped.some((s) => s.findingId === f.id) ? { skipped: 'harsh-cut' } : {}),
				fingerprint: f.fingerprint,
			};
		});
	const groups = a.groups.map((g) => ({
		id: g.id,
		chosen: g.chosen,
		takes: g.takes.map((k, i) => ({
			index: i,
			kept: i === g.chosen,
			text: k.text,
			start: sec(k.range.start),
			end: sec(k.range.end),
			words: k.words,
			complete: k.complete,
			meanProb: k.meanProb === null ? null : Math.round(k.meanProb * 1000) / 1000,
			...(k.scriptLine !== undefined ? { scriptLine: k.scriptLine + 1 } : {}),
			...(k.coverage !== undefined ? { coverage: Math.round(k.coverage * 1000) / 1000 } : {}),
		})),
	}));
	const ranges = a.plan.ranges.map((r) => ({ start: at(r.start), end: at(r.end), reasons: r.reasons }));
	return {
		analysisId: file.analysisId,
		...(t.scratch
			? { mediaOnly: true, note: 'Media time: the media was analysed on its own (apply needs a sequence)' }
			: { sequenceId: seq.id }),
		revision: file.revision,
		settings: {
			edges: a.settings.edges,
			gaps: a.settings.gaps,
			guards: a.settings.guards,
			joins: a.settings.joins,
			rules: a.settings.rules,
		},
		media: a.media.map((m) => ({
			mediaId: m.mediaId,
			stream: m.stream,
			language: m.language,
			voice: m.voice,
			edgeMode: m.edgeMode,
			clipIds: m.clipIds,
		})),
		stats: a.plan.stats,
		cuts: a.plan.ranges.length,
		byKind,
		skipped: a.plan.skipped.length,
		...(want.has('findings') ? { findings: page(findings, offset, limit) } : {}),
		...(want.has('groups') ? { groups: page(groups, offset, limit) } : {}),
		...(want.has('ranges') ? { ranges: page(ranges, offset, limit) } : {}),
		...(want.has('script') && a.script
			? {
					script: {
						said: a.script.filter((l) => l.said).length,
						lines: page(
							a.script.map((l) => ({ line: l.index + 1, text: l.text, said: l.said, takes: l.takes })),
							offset,
							limit,
						),
					},
				}
			: {}),
	};
}

export function registerCleanupTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'analyze_voice',
		{
			title: 'Analyze voice for clean up',
			description:
				'Find what to cut in transcribed speech: retakes, false starts, fillers, pauses. Then `plan_cleanup`.',
			details:
				'Finds what to cut in transcribed speech (retakes with take groups, restarts, false starts, fillers in the transcript\'s language, discourse markers, off-script talk and head / tail chatter with a script, pauses, breaths, voice without words, transcription suspects and hallucinations) and plans the cut with edit points from the audio level: findings, retake groups, removed ranges with reasons and statistics (output length, cuts per minute, dead air per minute, longest silence left). Target: a sequence (default the first), one clip, or a whole media. Paged (offset / limit / include / kinds). Changes nothing; see the "Cleaning up speech" guide for the recommended policy.',
			input: { ...TargetShape, ...PageShape },
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			const t = await resolveTarget(ctx, a);
			const { file } = await runAnalysis(ctx, a.projectId, t, a, extra);
			return jsonResult(analysisBody(file, t, {}, a));
		},
	);

	defineTool(
		ctx,
		'plan_cleanup',
		{
			title: 'Plan clean up (dry run)',
			description:
				'The analyze_voice dry run with your decisions: accept / reject findings by id (of an analysis of the same document) or fingerprint, whole kinds, and which take of each retake group to keep. Returns the resulting removed ranges and statistics (and the findings, marked accepted or not). Changes nothing; apply the same arguments with apply_cleanup.',
			input: { ...TargetShape, decisions: DecisionsArg.optional(), ...PageShape },
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			const t = await resolveTarget(ctx, a);
			const decisions = (a.decisions ?? {}) as CleanupDecisions;
			const { file } = await runAnalysis(ctx, a.projectId, t, { ...a, decisions }, extra);
			return jsonResult(analysisBody(file, t, decisions, a));
		},
	);

	defineTool(
		ctx,
		'apply_cleanup',
		{
			title: 'Apply clean up',
			description:
				'Plan like `plan_cleanup` and cut the removed ranges in one undo step. `mode`: extract (default, ripple), lift, mute or markers.',
			details:
				'Plans like plan_cleanup on the current document and cuts the removed ranges in ONE undo step ("Agent: Clean Up Voice: N cuts"): the speech clips, their linked picture and clip groups, rippled per sync lock (locked tracks never change), equal-power micro-fades at every join; the findings you rejected are remembered for later analyses (rememberRejections: false skips that). mode: extract (default, ripple) | lift (gaps) | mute (volume to −∞ over the ranges) | markers (range markers only). analysisId: the analysis your decision ids refer to — refused with E_STALE when the document changed since.',
			input: {
				...TargetShape,
				decisions: DecisionsArg.optional(),
				analysisId: z
					.string()
					.min(1)
					.max(64)
					.optional()
					.describe('The analyze_voice / plan_cleanup analysis the decisions refer to'),
				mode: z.enum(['extract', 'lift', 'mute', 'markers']).optional(),
				rememberRejections: z.boolean().optional().describe('Remember rejected findings (default true)'),
			},
			annotations: DESTRUCTIVE,
		},
		async (a, extra) => {
			if (a.mediaId)
				throw new ToolError(
					'E_INVALID_PARAM',
					'apply_cleanup cuts a sequence: pass sequenceId or clipId',
					'Place the media in a sequence first (add_clip), then analyse and apply there.',
				);
			const t = await resolveTarget(ctx, a);
			// spec 15 EA-001: the user's "Allow agents to apply transcript-cleanup proposals" (default on) covers this too
			if (agentProposalsAllowed(t.doc, 'transcript-cleanup') === false)
				throw new ToolError(
					'E_APPROVAL_DENIED',
					'The user does not let agents apply Clean Up here (Project Settings ▸ Agent Proposals ▸ transcript cleanup)',
					'Use plan_cleanup and tell the user what to apply in Text ▸ Transcript ▸ Clean Up, or ask them to allow it.',
				);
			const decisions = (a.decisions ?? {}) as CleanupDecisions;
			if (a.analysisId) {
				let before: CleanupAnalysisFile;
				try {
					before = await ctx.engine((c) => c.getCleanupAnalysis(a.analysisId!));
				} catch {
					throw new ToolError(
						'E_NOT_FOUND',
						`Analysis ${a.analysisId} is no longer kept by the engine`,
						'Call plan_cleanup again (decide by fingerprint to carry decisions over).',
					);
				}
				if (before.sequenceId !== t.seq.id || (t.revision !== undefined && before.revision !== t.revision))
					throw new ToolError(
						'E_STALE',
						'The document changed since that analysis: its finding ids may point at other findings',
						'Call analyze_voice / plan_cleanup again, or pass decisions by fingerprint without analysisId.',
						{ analysisRevision: before.revision, revision: t.revision ?? null },
					);
			}
			const { file } = await runAnalysis(ctx, a.projectId, t, { ...a, decisions }, extra);
			const analysis = file.analysis as CleanupAnalysis;
			const remembered = new Set(readSequenceCleanup(t.seq).rejected ?? []);
			const commands = cleanupApplyCommands(t.seq.id, analysis, decisions, remembered, {
				...(a.mode ? { mode: a.mode } : {}),
				...(a.rememberRejections === false ? { rememberRejections: false } : {}),
			});
			const cuts = analysis.plan.ranges.length;
			if (!commands.length)
				return jsonResult({
					ok: true,
					cuts: 0,
					note: 'Nothing to cut or remember',
					stats: analysis.plan.stats,
				});
			const label = `Clean Up Voice: ${cuts} ${cuts === 1 ? 'cut' : 'cuts'}`;
			const res = await transact(
				ctx,
				a.projectId,
				{
					label,
					commands,
					sequenceId: t.seq.id,
					...(file.revision >= 0 ? { expectedRevision: file.revision } : {}),
				},
				extra,
			);
			const r = requireOk(res);
			return jsonResult({
				...txBody(res, r),
				label,
				cuts,
				analysisId: file.analysisId,
				stats: analysis.plan.stats,
				removedSeconds:
					Math.round((analysis.plan.stats.inputDuration - analysis.plan.stats.outputDuration) * 1000) / 1000,
				note: 'One undo step: undo reverts the whole clean up.',
			});
		},
	);

	defineTool(
		ctx,
		'set_cleanup_settings',
		{
			title: 'Set clean up settings',
			description:
				"Store a sequence's Clean Up settings: preset and what `analyze_voice` removes by default.",
			details:
				"Stores a sequence's Clean Up settings (Sequence.cleanup; what analyze_voice and the editor's Clean Up mode use by default), one undoable edit: preset (fast / natural / a user preset id), settings overrides {rules: {retake, restart, falseStart, stutter, fillerVocalic, fillerPhrase, fillerLexical, offScript, headTail, pause, breath, untranscribed, asrSuspect, hallucination: remove|review|off}, thresholds {…}, edges {mode level|speech|word, reference floor|speech, outDb, inDb, padBeforeS, padAfterS, snapWindowS}, gaps {maxGapS, keepGapS, keepGapSentenceS, breath remove|keep, breathKeepMaxS}, guards {minPieceS, minCutFrames, minSliverFrames, avoidHarshCuts, harshWindowS}, joins {fadeMs 0–30, jlFrames}} merged into the stored ones (merge: false replaces them; reset: true drops them), word lists per language {es|en: {fillers, markers, allow} | null}, clearRejected / unreject (remembered rejections).",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				preset: PresetArg.optional(),
				settings: CleanupOverridesSchema.optional(),
				merge: z.boolean().optional().describe('Merge settings into the stored overrides (default true)'),
				reset: z.boolean().optional().describe('Drop every override (keeps the preset)'),
				lists: z
					.partialRecord(z.enum(['es', 'en']), CleanupListsSchema.nullable())
					.optional()
					.describe('Word lists replacing the built-in ones; null = back to the built-in lists'),
				clearRejected: z.boolean().optional().describe('Forget every remembered rejection'),
				unreject: z
					.array(z.string().min(1).max(200))
					.max(20_000)
					.optional()
					.describe('Fingerprints to forget'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const stored = readSequenceCleanup(seq);
			const cmd: Record<string, unknown> = { type: 'cleanup.configure', sequenceId: seq.id };
			if (a.reset)
				cmd.settings = { presetId: presetId(a.preset) ?? stored.settings?.presetId ?? 'builtin.fast' };
			else if (a.preset !== undefined || a.settings !== undefined) {
				cmd.settings = {
					...(a.preset !== undefined ? { presetId: presetId(a.preset) } : {}),
					...(a.settings ? { overrides: a.settings } : {}),
				};
				if (a.merge !== false) cmd.mergeOverrides = true;
				if (a.preset !== undefined && a.settings === undefined) delete cmd.mergeOverrides;
			}
			if (a.lists) cmd.lists = a.lists;
			if (a.clearRejected) cmd.clearRejected = true;
			if (a.unreject?.length) cmd.unreject = a.unreject;
			if (Object.keys(cmd).length === 2)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Nothing to set',
					'Pass preset, settings, reset, lists, clearRejected or unreject.',
				);
			const res = await transact(
				ctx,
				a.projectId,
				{ label: 'Clean Up Settings', commands: [cmd], sequenceId: seq.id },
				extra,
			);
			const r = requireOk(res);
			return jsonResult(txBody(res, r));
		},
	);

	defineTool(
		ctx,
		'attach_script',
		{
			title: 'Attach a script',
			description: "Attach the video's script to a sequence, for cleanup and `fix_transcript`.",
			details:
				'Attaches the video script (plain text, ≤ 256 KB; one sentence or line per take) to a sequence: the script serves cleanup and transcript fixing. fix_transcript fixes the recognition errors of the transcript from it (names, loanwords, split words; each checked against the audio). For Clean Up: retake groups are named by line, off-script talk and head / tail chatter are found, an earlier take that covers more of a line wins, and lines never said are reported. text or path (an absolute .txt / .md file); detach: true removes it. One undoable edit.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				name: z.string().max(500).optional().describe('Script name (default: the file name, else "Script")'),
				text: z.string().max(CLEANUP_SCRIPT_MAX_BYTES).optional(),
				path: z.string().min(1).optional().describe('Absolute path of a UTF-8 text file'),
				detach: z.boolean().optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const n = [a.text !== undefined, a.path !== undefined, a.detach === true].filter(Boolean).length;
			if (n !== 1) throw new ToolError('E_INVALID_PARAM', 'Give exactly one of text, path and detach: true');
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			let script: { name: string; text: string } | null = null;
			if (!a.detach) {
				let text = a.text ?? '';
				let name = a.name;
				if (a.path !== undefined) {
					if (!isAbsolute(a.path)) throw new ToolError('E_INVALID_PARAM', 'Paths must be absolute');
					const st = await stat(a.path).catch(() => null);
					if (!st?.isFile()) throw new ToolError('E_NOT_FOUND', `No file at ${a.path}`);
					if (st.size > 4 * CLEANUP_SCRIPT_MAX_BYTES)
						throw new ToolError('E_LIMIT', 'The script file is larger than 256 KB of text');
					text = await readFile(a.path, 'utf8');
					name ??= a.path
						.split(/[\\/]/)
						.pop()!
						.replace(/\.[^.]+$/, '');
				}
				if (Buffer.byteLength(text, 'utf8') > CLEANUP_SCRIPT_MAX_BYTES)
					throw new ToolError(
						'E_LIMIT',
						'The script is longer than 256 KB',
						'Attach the part this sequence covers.',
					);
				if (!text.trim()) throw new ToolError('E_INVALID_PARAM', 'The script is empty');
				script = { name: (name ?? 'Script').slice(0, 500), text };
			}
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: script ? 'Attach Clean Up Script' : 'Detach Clean Up Script',
					commands: [{ type: 'cleanup.configure', sequenceId: seq.id, script }],
					sequenceId: seq.id,
				},
				extra,
			);
			const r = requireOk(res);
			return jsonResult({
				...txBody(res, r),
				...(script
					? {
							name: script.name,
							bytes: Buffer.byteLength(script.text, 'utf8'),
							lines: script.text.split(/[.!?…\n]+/).filter((x) => x.trim()).length,
						}
					: { detached: true }),
			});
		},
	);
}
