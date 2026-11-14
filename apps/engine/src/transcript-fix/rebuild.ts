// Rebuild from script for the kept speech (`transcript-fix` job, mode `rebuild`; docs/wp-notes/script-correction.md
// "Rebuild from script"): when the subtitles of a cut must read like the script and the transcript under them is wrong
// in places a fix candidate cannot reach (phrases missing, hidden restarts written once, words of a removed take), the
// speech the sequence keeps is transcribed again from the raw audio and written from the script:
//   1. the kept spans (`keptSpans`: the media ranges the sequence's audio clips play, merged per media);
//   2. per media, ONE speech worker run over the spans padded by 0.2 s, VAD-chunked, best accuracy
//      (`speech/kept-spans.ts` `transcribeKeptSpans`, reusable);
//   3. the spans aligned to the script in one pass (`rebuildSpans`: exact → script spelling, replaced → script text
//      with the heard timing, missing → inserted, off-script → dropped or kept, emoticons carried);
//   4. ONE proposal of feature `transcript-correction` with an item per changed span (`transcript.replaceWords`, its
//      subtitles and caption tracks patched): accepting is one transaction, one undo step.
import type { TranscriptFixReport, TranscriptFixResult } from '@jasper/api';
import {
	FLICKS_PER_SECOND,
	PROPOSAL_LIMITS,
	type ProjectDocument,
	type ProposalItemInput,
	planReplaceWords,
	TRANSCRIPT_CORRECTION_FEATURE,
} from '@jasper/project';
import {
	type HeardWord,
	type KeptSpan,
	keptSpans,
	type ParsedScript,
	parseScript,
	type RebuildEdit,
	rebuildEdits,
	rebuildSpans,
	type SpanRebuildCounts,
	scriptFixLanguage,
} from '@jasper/project/script-fix';
import { type JobContext, JobError } from '../jobs/types.ts';
import { engineMediaKey } from '../sound-design/voice.ts';
import { type SpanTranscriber, transcribeKeptSpans } from '../speech/kept-spans.ts';
import type { Prepared, TranscriptFixDeps, TranscriptFixJobInput } from './run.ts';

/** What the stored proposal keeps (a rebuild is not refreshed: it is run again). */
export type RebuildProposalReport = {
	format: 'jasper-transcript-rebuild';
	version: 1;
	offScript: 'drop' | 'keep';
	mediaIds: string[];
	counts: Record<string, number>;
};

export function isRebuildReport(r: unknown): r is RebuildProposalReport {
	return (r as Partial<RebuildProposalReport> | undefined)?.format === 'jasper-transcript-rebuild';
}

/** Media problems that leave that media out (its words stay); anything else fails the job. */
const PER_MEDIA_CODES = new Set(['ASSET_NOT_FOUND', 'MEDIA_OFFLINE', 'NO_AUDIO', 'SPEECH_LANGUAGE_UNKNOWN']);

const LANG_RE = /^[a-z]{2,3}$/;
const clock = (flicks: number) => {
	const s = Math.max(0, flicks / FLICKS_PER_SECOND);
	const m = Math.floor(s / 60);
	const r = s - m * 60;
	return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type SpanPlan = {
	span: KeptSpan;
	edits: RebuildEdit[] | null;
	counts: SpanRebuildCounts;
	aligned: boolean;
	heard: number;
	written: number;
	before: string;
	after: string;
};

/** The `rebuild` run of a prepared `transcript-fix` job: transcribe the kept speech, align it, store the proposal. */
export async function runRebuild(
	deps: TranscriptFixDeps,
	p: Prepared,
	input: TranscriptFixJobInput,
	ctx: JobContext,
	t: { t0: number; readMs: number },
): Promise<TranscriptFixResult> {
	const offScript = input.request.offScript ?? 'drop';
	const speech = deps.speech() as
		| (ReturnType<TranscriptFixDeps['speech']> & Partial<SpanTranscriber>)
		| undefined;
	if (!speech?.transcribeSpans)
		throw new JobError('NOT_AVAILABLE', 'The speech service cannot transcribe kept spans here', true);
	const transcriber = speech as unknown as SpanTranscriber;
	const doc: ProjectDocument = p.doc;
	const inScope = new Set(p.media.map((m) => m.mediaId));
	const spans = keptSpans(doc, p.seq).filter((s) => inScope.has(s.mediaId));
	const warnings: Array<{ code: string; message: string }> = [];
	const scripts = new Map<string, ParsedScript>();
	const scriptFor = (lang: string) => {
		const key = scriptFixLanguage(lang) ?? '';
		let s = scripts.get(key);
		if (!s) scripts.set(key, (s = parseScript(p.scriptText ?? '', { language: lang })));
		return s;
	};
	const byMedia = new Map<string, KeptSpan[]>();
	for (const s of spans) byMedia.set(s.mediaId, [...(byMedia.get(s.mediaId) ?? []), s]);
	const totalSec = spans.reduce((n, s) => n + (s.end - s.start) / FLICKS_PER_SECOND, 0);
	let doneSec = 0;
	const plans: SpanPlan[] = [];
	let model: string | null = null;
	let device: unknown = null;
	let speechMs = 0;
	let alignMs = 0;
	for (const [mediaId, list] of byMedia) {
		if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		const m = p.media.find((x) => x.mediaId === mediaId)!;
		const key = engineMediaKey(doc.media[mediaId]);
		const mediaSec = list.reduce((n, s) => n + (s.end - s.start) / FLICKS_PER_SECOND, 0);
		if (!key) {
			warnings.push({
				code: 'W_NOT_REBUILT',
				message: `${m.name}: the media is not in the engine's store, its transcript is left as it is`,
			});
			doneSec += mediaSec;
			continue;
		}
		const lang = String(m.transcript.language ?? '').toLowerCase();
		let heard: HeardWord[][];
		const ts = Date.now();
		try {
			const r = await transcribeKeptSpans(
				transcriber,
				{
					mediaKey: key,
					spans: list,
					...(LANG_RE.test(lang) ? { language: lang } : {}),
					...(p.models.get(mediaId) ? { model: p.models.get(mediaId)! } : {}),
					accuracy: 'best',
					...(p.device ? { device: p.device } : {}),
				},
				ctx.signal,
				{
					onProgress: (f, stage) =>
						ctx.progress(0.05 + (0.85 * (doneSec + f * mediaSec)) / Math.max(1e-9, totalSec), {
							stage: `${m.name}: ${stage}`,
						}),
					log: (l) => ctx.log(l),
					trackChild: (c) => ctx.trackChild(c),
					scratchDir: await ctx.scratchDir(),
					threads: ctx.slots,
				},
			);
			heard = r.spans.map((s) => s.words);
			model ??= r.model;
			device ??= r.device;
		} catch (e) {
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			if (e instanceof JobError && PER_MEDIA_CODES.has(e.code)) {
				warnings.push({ code: 'W_NOT_REBUILT', message: `${m.name}: ${e.message}`.slice(0, 300) });
				doneSec += mediaSec;
				continue;
			}
			throw e;
		}
		speechMs += Date.now() - ts;
		doneSec += mediaSec;
		const ta = Date.now();
		const old = m.transcript.words;
		const previous = list.map((s) => old.filter((w) => w.start < s.end && w.end > s.start));
		const rebuilt = rebuildSpans({
			spans: heard,
			previous,
			script: scriptFor(lang),
			language: lang,
			keepOffScript: offScript === 'keep',
		});
		list.forEach((span, i) => {
			const r = rebuilt[i]!;
			const h = heard[i]!;
			// nothing heard: the span's words stay (a silent stretch, or speech the recogniser missed)
			const edits = h.length ? rebuildEdits(old, span, r.words) : [];
			plans.push({
				span,
				edits,
				counts: r.counts,
				aligned: r.aligned,
				heard: h.length,
				written: r.words.length,
				before: previous[i]!.map((w) => w.text).join(' '),
				after: r.words.map((w) => w.text).join(' '),
			});
		});
		alignMs += Date.now() - ta;
	}
	if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
	ctx.progress(0.92, { stage: 'Checking the subtitles' });
	const items: ProposalItemInput[] = [];
	const counts: Record<string, number> = {};
	let unwritable = 0;
	for (const [k, x] of plans.entries()) {
		for (const [c, n] of Object.entries(x.counts)) counts[c] = (counts[c] ?? 0) + n;
		if (x.edits === null) {
			unwritable++;
			continue;
		}
		if (!x.edits.length || items.length >= PROPOSAL_LIMITS.maxItems) continue;
		items.push({
			id: `rebuild.${k + 1}`,
			label: clip(
				`${clock(x.span.start)}–${clock(x.span.end)}: ${x.after || '(no words)'}`,
				PROPOSAL_LIMITS.maxLabel,
			),
			group: 'fix',
			commands: [{ type: 'transcript.replaceWords', transcriptId: x.span.transcriptId, edits: x.edits }],
			meta: {
				rule: 'rebuild',
				mediaId: x.span.mediaId,
				start: x.span.start,
				end: x.span.end,
				before: clip(x.before, 4000),
				after: clip(x.after, 4000),
				counts: x.counts,
				aligned: x.aligned,
			},
		});
	}
	if (plans.length - unwritable > PROPOSAL_LIMITS.maxItems)
		warnings.push({
			code: 'W_ITEMS_CAPPED',
			message: `Only the first ${PROPOSAL_LIMITS.maxItems} changed spans are proposed; run the rebuild again after accepting`,
		});
	if (unwritable)
		warnings.push({
			code: 'W_SPAN_UNWRITABLE',
			message: `${unwritable} span(s) hold a word stretched over more than 64 new words and are left as they are`,
		});
	const patch = patchOf(doc, items);
	const report: TranscriptFixReport = {
		settings: p.settings,
		sourcesUsed: ['script'],
		perMedia: p.media.map((m) => ({
			mediaId: m.mediaId,
			transcriptId: m.transcript.id,
			name: m.name,
			language: String(m.transcript.language ?? ''),
			words: m.transcript.words.length,
			wordsInScope: plans
				.filter((x) => x.span.mediaId === m.mediaId)
				.reduce((n, x) => n + x.before.split(' ').filter(Boolean).length, 0),
			alignment: null,
			candidates: 0,
			windows: 0,
			readings: 0,
		})),
		candidates: { total: 0, byGroup: {}, byCategory: {}, byKind: {} },
		decisions: [],
		decisionsTruncated: false,
		skipped: {},
		unusedLines: [],
		patch,
		speech: { model, ...(p.modelProblem ? { problem: p.modelProblem } : {}) },
		device,
		timings: {
			readMs: t.readMs,
			alignMs,
			scoreMs: speechMs,
			decideMs: 0,
			totalMs: Date.now() - t.t0,
			speechSeconds: Math.round(totalSec * 1000) / 1000,
		},
		rebuild: {
			offScript,
			spans: plans.length,
			changedSpans: items.length,
			seconds: Math.round(totalSec * 1000) / 1000,
			heardWords: plans.reduce((n, x) => n + x.heard, 0),
			writtenWords: plans.reduce((n, x) => n + x.written, 0),
			counts,
			offScriptSpans: plans.filter((x) => x.heard && !x.aligned).length,
			silentSpans: plans.filter((x) => !x.heard).length,
			unwritableSpans: unwritable,
			model,
		},
		warnings: [...p.warnings, ...warnings].slice(0, 100),
	};
	const base = { mode: 'rebuild' as const, projectId: input.projectId, sequenceId: p.seq.id };
	if (!items.length) {
		ctx.progress(1, { stage: 'The transcript already reads like the script' });
		return { ...base, proposalId: null, itemCount: 0, revision: p.revision ?? null, report };
	}
	const proposals = deps.proposals();
	if (!proposals) throw new JobError('NOT_AVAILABLE', 'The proposal service is not running', true);
	ctx.progress(0.95, { stage: `Storing ${items.length} spans` });
	const draft = {
		feature: TRANSCRIPT_CORRECTION_FEATURE,
		title: 'Rebuild transcript from script',
		sequenceId: p.seq.id,
		summary: clip(
			`${items.length} of ${plans.length} kept spans rewritten from the script after transcribing the kept speech again: ${counts.exact ?? 0} words as heard in script spelling, ${counts.replaced ?? 0} replaced by the script, ${counts.inserted ?? 0} inserted from the script, ${counts.dropped ?? 0} heard words not in the script ${offScript === 'keep' ? 'kept' : 'dropped'}${counts.emoticons ? `, ${counts.emoticons} emoticons carried` : ''}. Each span replaces its transcript words and patches the subtitles and caption tracks showing them; accepting is one undo step.`,
			PROPOSAL_LIMITS.maxSummary,
		),
		items,
		report: {
			format: 'jasper-transcript-rebuild',
			version: 1,
			offScript,
			mediaIds: [...byMedia.keys()],
			counts,
		} satisfies RebuildProposalReport,
	};
	const created = await proposals.create(input.projectId, draft as never, input.who);
	if (ctx.signal.aborted) {
		await proposals.delete(input.projectId, created.proposal.id).catch(() => undefined);
		throw new JobError('JOB_CANCELLED', 'Cancelled');
	}
	ctx.progress(1, { stage: 'Proposal ready for review' });
	return {
		...base,
		proposalId: created.proposal.id,
		itemCount: created.proposal.items.length,
		revision: created.revision,
		report: { ...report, timings: { ...report.timings, totalMs: Date.now() - t.t0 } },
	};
}

/** The patch report of every item (one `planReplaceWords` per transcript over all its edits). */
function patchOf(doc: ProjectDocument, items: readonly ProposalItemInput[]): TranscriptFixReport['patch'] {
	const byTranscript = new Map<string, RebuildEdit[]>();
	for (const it of items)
		for (const c of it.commands as Array<{ transcriptId: string; edits: RebuildEdit[] }>)
			byTranscript.set(c.transcriptId, [...(byTranscript.get(c.transcriptId) ?? []), ...c.edits]);
	let edits = 0;
	let stale = 0;
	const patched = new Set<string>();
	const skipped: TranscriptFixReport['patch']['skipped'] = [];
	for (const [transcriptId, list] of byTranscript) {
		const plan = planReplaceWords(doc, {
			transcriptId,
			edits: [...list].sort((a, b) => a.start - b.start),
		});
		edits += list.length;
		stale += plan.stale.length;
		for (const x of plan.patched) patched.add(x.clipId);
		for (const x of plan.skipped)
			if (skipped.length < 200)
				skipped.push({ clipId: x.clipId, sequenceId: x.sequenceId, kind: x.kind, reason: x.reason });
	}
	return { edits, patched: patched.size, skipped, stale };
}
